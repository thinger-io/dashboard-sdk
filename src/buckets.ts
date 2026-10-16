import type { ThingerClient } from './client.js';
import { ThingerError } from './errors.js';
import { enc, stableJson } from './http.js';
import { aggregationPeriod, parseTime, type AggregationPeriod } from './time.js';
import type {
    BucketCallback,
    BucketChange,
    BucketQuery,
    BucketRecord,
    BucketSubscribeOptions,
    ServerEvent,
    Unsubscribe,
} from './types.js';

type Row = BucketRecord;

interface Changes {
    added: Row[];
    removed: number;
}

/**
 * Records of a bucket_write event as read() returns them, or null when the event does not carry
 * them that way. MongoDB buckets send the record as stored, tags included, with `ts: { $date }`;
 * other backends drop `ts` or use their own format, so they are read back.
 */
function eventRows(frame: ServerEvent): Row[] | null {
    const rows: Row[] = [];
    for (const rec of ([] as unknown[]).concat(frame['data'])) {
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
        const ts = (rec as { ts?: unknown }).ts;
        if (
            !ts ||
            typeof ts !== 'object' ||
            typeof (ts as { $date?: unknown }).$date !== 'number'
        ) {
            return null;
        }
        rows.push({ ...(rec as Record<string, unknown>), ts: (ts as { $date: number }).$date });
    }
    return rows.length ? rows : null;
}

/**
 * Time span written by an event: the timestamps of its records when it carries them, the event
 * time otherwise (the server's clock at the write, not a `ts` given in the payload).
 */
function eventSpan(frame: ServerEvent): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (const rec of ([] as unknown[]).concat(frame['data'])) {
        let ts = rec && typeof rec === 'object' ? (rec as { ts?: unknown }).ts : undefined;
        if (ts && typeof ts === 'object') ts = (ts as { $date?: unknown }).$date;
        if (typeof ts === 'number') {
            min = Math.min(min, ts);
            max = Math.max(max, ts);
        }
    }
    if (min === Infinity) {
        const ts = frame['ts'];
        min = max = typeof ts === 'number' ? ts : Date.now();
    }
    return { min, max };
}

/**
 * One buckets.subscribe(): a copy of the read kept on the client and updated from the
 * bucket_write events. Raw reads insert the records the events carry, or read only what is new;
 * aggregated reads re-read the windows the writes fall in. Whatever goes wrong on the way, the
 * update falls back to a full read.
 */
class BucketFeed {
    private readonly debounceMs: number;
    private readonly desc: boolean;
    private readonly groupBy: string[] | null;
    private readonly period: AggregationPeriod | null;
    private readonly cap: number;
    private readonly sliding: boolean;
    private readonly incremental: boolean;
    private readonly to: number | undefined;
    private rows: Row[] | null = null; // ascending by ts; null until a full read succeeds
    private partial = false; // the last full read holds the oldest `items` (sort: 'asc')
    private pending: ServerEvent[] = []; // events since the last update
    private reconnected = false;
    private busy = false;
    private closed = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly buckets: Buckets,
        private readonly sdk: ThingerClient,
        private readonly bucketId: string,
        private readonly opts: BucketSubscribeOptions,
        private readonly device: string | null,
        private readonly cb: BucketCallback,
    ) {
        this.debounceMs = opts.debounceMs != null ? opts.debounceMs : 500;
        this.desc = opts.sort !== 'asc';
        this.groupBy = opts.groupBy ? ([] as string[]).concat(opts.groupBy) : null;
        this.period = opts.aggregation ? aggregationPeriod(opts.aggregation) : null;
        // the server returns 50 records unless told otherwise, and does not limit grouped reads
        this.cap = this.groupBy ? Infinity : opts.items != null ? Number(opts.items) : 50;
        this.sliding = typeof opts.from === 'string';
        this.incremental = this.isIncremental();
        this.to =
            this.incremental && opts.to != null && opts.to !== 'now'
                ? parseTime(opts.to)
                : undefined;
    }

    // Re-read everything on each write when asked to (refetch), with transforms (each value
    // depends on the previous ones), aggregations the SDK cannot place in time, ranges with a
    // moving or past end, and the first record of each group in ascending order.
    private isIncremental(): boolean {
        const o = this.opts;
        if (o.refetch || o.transform) return false;
        if (o.aggregation && (!this.period || !o.aggregator)) return false;
        if (this.groupBy && !o.aggregation && !this.desc) return false;
        if (o.to != null && o.to !== 'now') {
            if (typeof o.to === 'string') return false;
            try {
                if (parseTime(o.to)! <= Date.now()) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    start(): Unsubscribe {
        void this.run();
        const filter = this.device
            ? { event: 'bucket_write', device: this.device, bucket: this.bucketId }
            : { event: 'bucket_write', bucket: this.bucketId };
        const unsub = this.sdk.events.subscribe(
            filter,
            (frame) => {
                this.pending.push(frame);
                this.schedule();
            },
            this.incremental
                ? () => {
                      // writes made while the socket was down sent no event: read what is new
                      this.reconnected = true;
                      this.schedule();
                  }
                : undefined,
        );
        return () => {
            this.closed = true;
            if (this.timer) clearTimeout(this.timer);
            unsub();
        };
    }

    private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.run();
        }, this.debounceMs);
    }

    // One update at a time: events that arrive meanwhile wait for the next one.
    private async run(): Promise<void> {
        if (this.busy || this.closed) return;
        this.busy = true;
        const frames = this.pending;
        const reconnected = this.reconnected;
        this.pending = [];
        this.reconnected = false;
        try {
            if (!this.incremental || this.partial || !this.rows || !this.rows.length) {
                await this.reload();
            } else {
                let changes: Changes | null = null;
                try {
                    changes = await this.update(frames, reconnected);
                } catch {
                    await this.reload();
                }
                if (changes) this.emit(changes);
            }
        } finally {
            this.busy = false;
            if (!this.closed && !this.timer && (this.pending.length || this.reconnected)) {
                this.schedule();
            }
        }
    }

    private async reload(): Promise<void> {
        let data: Row[];
        try {
            data = await this.buckets.read(this.bucketId, this.opts);
        } catch (e) {
            this.rows = null;
            if (!this.closed) this.call(null, e as Error);
            return;
        }
        if (this.closed) return;
        // own copies: the app may change the records it gets
        const rows = Array.isArray(data) ? data.map((r) => ({ ...r })) : [];
        if (this.desc) rows.reverse();
        rows.sort((a, b) => a.ts - b.ts);
        this.rows = rows;
        this.partial = !this.desc && rows.length >= this.cap;
        this.call(data, null, { added: Array.isArray(data) ? data : [], reset: true });
    }

    private async update(frames: ServerEvent[], reconnected: boolean): Promise<Changes> {
        const changes: Changes = { added: [], removed: 0 };
        if (this.opts.aggregation || this.groupBy)
            await this.updateWindows(frames, reconnected, changes);
        else await this.updateRaw(frames, reconnected, changes);
        this.trim(changes);
        return changes;
    }

    // Raw reads: insert the records carried by the events, or read from the last record on.
    // Writes older than the last record (imports, devices catching up) re-read their range.
    private async updateRaw(frames: ServerEvent[], reconnected: boolean, changes: Changes) {
        const rows = this.rows!;
        const last = rows[rows.length - 1]!.ts;
        // project sessions may only see the project's devices: read those writes back
        const direct =
            !this.opts.fields && !(this.sdk.project && this.sdk.project.id && !this.device);
        let since = reconnected;
        let oldFrom = Infinity;
        let oldTo = -Infinity;
        for (const frame of frames) {
            const carried = direct ? eventRows(frame) : null;
            if (carried) {
                for (const row of carried) if (this.accepts(row)) this.insert(row, changes);
                continue;
            }
            const span = eventSpan(frame);
            if (span.max >= last) since = true;
            if (span.min < last) {
                oldFrom = Math.min(oldFrom, span.min);
                oldTo = Math.max(oldTo, Math.min(span.max, last));
            }
        }
        if (oldFrom <= oldTo) await this.replaceRange(oldFrom, oldTo, changes);
        if (since) await this.replaceRange(last, undefined, changes);
    }

    // Aggregated reads: re-read from the start of the window of the earliest write, and replace
    // the windows that come back, by ts (and group with groupBy). Grouped reads without
    // aggregation keep the latest record of each group.
    private async updateWindows(frames: ServerEvent[], reconnected: boolean, changes: Changes) {
        const rows = this.rows!;
        const last = rows[rows.length - 1]!.ts; // start of the newest window
        let from = reconnected ? last : Infinity;
        let cut = false; // `from` may fall inside a window: drop that partial window
        for (const frame of frames) {
            const span = eventSpan(frame);
            if (span.min >= last) {
                from = Math.min(from, last);
                continue;
            }
            const start = this.period ? span.min - this.period.max : span.min;
            if (start < from) {
                from = start;
                cut = !!this.period;
            }
        }
        if (from === Infinity) return;
        // no earlier than read() itself: its first window is partial too
        const begin = this.rangeStart();
        if (from <= begin) {
            from = begin;
            cut = false;
        }

        const data = await this.read(from, undefined);
        const groupBy = this.groupBy;
        const key = (r: Row) =>
            (groupBy ? groupBy.map((g) => String(r[g])).join('\u0000') : '') +
            (this.period ? '\u0001' + r.ts : '');
        const index = new Map<string, number>();
        rows.forEach((r, i) => index.set(key(r), i));
        let resort = false;
        for (const d of data) {
            if (cut && d.ts < from) continue;
            const k = key(d);
            const i = index.get(k);
            const row = { ...d };
            if (i === undefined) {
                index.set(k, rows.push(row) - 1);
                resort = true;
            } else {
                const cur = rows[i]!;
                if (!this.period && d.ts < cur.ts) continue;
                if (stableJson(cur) === stableJson(d)) continue;
                rows[i] = row;
                if (row.ts !== cur.ts) resort = true;
            }
            changes.added.push(row);
        }
        if (resort) rows.sort((a, b) => a.ts - b.ts);
    }

    /** Start of the range: `from` now (it moves with durations), or no limit. */
    private rangeStart(): number {
        return this.opts.from == null ? -Infinity : parseTime(this.opts.from)!;
    }

    /** Does a record carried by an event belong to this read? */
    private accepts(row: Row): boolean {
        if (row.ts < this.rangeStart()) return false;
        if (this.to !== undefined && row.ts > this.to) return false;
        if (this.device && row['device'] != null && row['device'] !== this.device) return false;
        const tags = this.opts.tags || {};
        return Object.keys(tags).every(
            (k) =>
                row[k] != null &&
                ([] as unknown[]).concat(tags[k]).map(String).indexOf(String(row[k])) >= 0,
        );
    }

    private insert(row: Row, changes: Changes): void {
        const rows = this.rows!;
        let i = rows.length;
        while (i > 0 && rows[i - 1]!.ts > row.ts) i--;
        const json = stableJson(row);
        for (let j = i - 1; j >= 0 && rows[j]!.ts === row.ts; j--) {
            if (stableJson(rows[j]) === json) return; // a read already brought it
        }
        rows.splice(i, 0, row);
        changes.added.push(row);
    }

    // Read [from, to] (to: open) and put the result in place of the records of that range.
    private async replaceRange(from: number, to: number | undefined, changes: Changes) {
        from = Math.max(from, this.rangeStart());
        if (to !== undefined && to < from) return;
        const data = await this.read(from, to);
        const rows: Row[] = [];
        const old = new Map<string, Row[]>(); // records of the range, by content
        for (const r of this.rows!) {
            if (r.ts < from || (to !== undefined && r.ts > to)) {
                rows.push(r);
                continue;
            }
            const json = stableJson(r);
            const list = old.get(json);
            if (list) list.push(r);
            else old.set(json, [r]);
        }
        for (const d of data) {
            const same = old.get(stableJson(d));
            if (same && same.length) {
                rows.push(same.shift()!);
                continue;
            }
            const row = { ...d };
            rows.push(row);
            changes.added.push(row);
        }
        old.forEach((list) => {
            changes.removed += list.length;
        });
        rows.sort((a, b) => a.ts - b.ts);
        this.rows = rows;
    }

    // Same query as the subscription over another range, newest first so `items` keeps them.
    private async read(from: number, to: number | undefined): Promise<Row[]> {
        const q: BucketQuery = {
            ...this.opts,
            from,
            to: to !== undefined ? to : this.to,
            sort: 'desc',
        };
        if (this.cap !== Infinity) q.items = this.cap;
        const data = await this.buckets.read(this.bucketId, q);
        if (!Array.isArray(data)) {
            throw new ThingerError('Unexpected bucket data', { code: 'unexpected-response' });
        }
        return data;
    }

    // Drop what left a duration window, and keep the newest `items`.
    private trim(changes: Changes): void {
        const rows = this.rows!;
        let n = 0;
        if (this.sliding) {
            const start = this.rangeStart();
            // aggregation windows stay while part of them is in range, as read() returns them
            const span = this.period ? this.period.nominal : 0;
            while (n < rows.length && (span ? rows[n]!.ts + span <= start : rows[n]!.ts < start))
                n++;
        }
        if (rows.length - n > this.cap) {
            // ascending reads return the oldest `items`: only a full read gives the same
            if (!this.desc) throw new Error('More records than items');
            n = rows.length - this.cap;
        }
        if (n) {
            rows.splice(0, n);
            changes.removed += n;
        }
    }

    private emit(changes: Changes): void {
        if (this.closed) return;
        const kept = new Set(this.rows);
        const added = changes.added.filter((r) => kept.has(r));
        if (!added.length && !changes.removed) return;
        // copies, so the app can change them without touching the feed
        const copies = new Map<Row, Row>();
        const data = this.rows!.map((r) => {
            const c = { ...r };
            copies.set(r, c);
            return c;
        });
        const out = added.sort((a, b) => a.ts - b.ts).map((r) => copies.get(r)!);
        if (this.desc) {
            data.reverse();
            out.reverse();
        }
        this.call(data, null, { added: out, reset: false });
    }

    private call(data: Row[] | null, err: Error | null, change?: BucketChange): void {
        try {
            this.cb(data, err, change);
        } catch (e) {
            console.error('subscriber threw', e);
        }
    }
}

/** Bucket data: read, write, live reads and tags. */
export class Buckets {
    /** @internal */
    constructor(private readonly sdk: ThingerClient) {}

    /**
     * `device: true` means the device of the dashboard context, which only device and product
     * dashboards have.
     */
    private device(opts?: { device?: string | true | null }): string | null {
        const d = opts && opts.device;
        if (d !== true) return d || null;
        const ctx = this.sdk.context && this.sdk.context.device;
        if (!ctx) {
            throw new ThingerError(
                'device: true needs a device dashboard, and this one has no device in context: ' +
                    "pass the device id instead (device: '<id>')",
                { code: 'invalid-argument' },
            );
        }
        return ctx;
    }

    private path(bucketId: string, opts?: BucketQuery): string {
        const user = this.sdk.userId();
        const device = this.device(opts);
        if (device) {
            return (
                '/v3/users/' +
                enc(user) +
                '/devices/' +
                enc(device) +
                '/buckets/' +
                enc(bucketId) +
                '/data'
            );
        }
        return '/v2/users/' + enc(user) + '/buckets/' + enc(bucketId) + '/data';
    }

    private query(opts?: BucketQuery): string {
        const o = opts || {};
        const p = new URLSearchParams();
        const from = parseTime(o.from);
        const to = parseTime(o.to);
        if (from !== undefined) p.set('min_ts', String(from));
        if (to !== undefined) p.set('max_ts', String(to));
        if (o.aggregation) p.set('agg', o.aggregation);
        if (o.aggregator) p.set('agg_type', o.aggregator);
        if (o.transform) p.set('transform', o.transform);
        if (o.items != null) p.set('items', String(o.items));
        if (o.sort) p.set('sort', o.sort);
        if (o.fields) p.set('fields', ([] as string[]).concat(o.fields).join(','));
        if (o.groupBy) p.set('group_by', ([] as string[]).concat(o.groupBy).join(','));
        if (o.tags) {
            // one parameter per value: tag_site=a&tag_site=b
            for (const [k, v] of Object.entries(o.tags)) {
                for (const value of ([] as unknown[]).concat(v))
                    p.append('tag_' + k, String(value));
            }
        }
        try {
            // aggregation windows (days, hours) start in this zone: the site's, or the viewer's
            p.set('tz', o.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone);
        } catch {
            // no Intl time zones
        }
        return p.toString();
    }

    /**
     * Records `{ ts, ...fields }`. `opts.device` reads the device-scoped view of a product
     * bucket (a device id, or `true` for the context device): it only needs access to the device.
     */
    async read<T = BucketRecord>(bucketId: string, opts?: BucketQuery): Promise<T[]> {
        const qs = this.query(opts);
        return this.sdk.request<T[]>(this.path(bucketId, opts) + (qs ? '?' + qs : ''));
    }

    /** Write a record to a bucket (one whose data source is the API). */
    async write(bucketId: string, value: unknown): Promise<unknown> {
        return this.sdk.request(
            '/v1/users/' + enc(this.sdk.userId()) + '/buckets/' + enc(bucketId) + '/data',
            {
                method: 'POST',
                body: value === undefined ? null : value,
            },
        );
    }

    /** Tags of a bucket, or the values seen for one tag (to build filters). */
    async tags(bucketId: string, opts?: { device?: string | true | null }): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    async tags(
        bucketId: string,
        tag: string,
        opts?: { device?: string | true | null },
    ): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    async tags(
        bucketId: string,
        tagOrOpts?: string | { device?: string | true | null },
        maybeOpts?: { device?: string | true | null },
    ): Promise<unknown> {
        const tag = typeof tagOrOpts === 'string' ? tagOrOpts : null;
        const opts = typeof tagOrOpts === 'object' && tagOrOpts ? tagOrOpts : maybeOpts;
        const user = this.sdk.userId();
        const device = this.device(opts);
        let path = device
            ? '/v3/users/' +
              enc(user) +
              '/devices/' +
              enc(device) +
              '/buckets/' +
              enc(bucketId) +
              '/tags'
            : '/v1/users/' + enc(user) + '/buckets/' + enc(bucketId) + '/tags';
        if (tag) path += '/' + enc(tag);
        return this.sdk.request(path);
    }

    /**
     * `read(bucketId, opts)`, then the same read kept current as the bucket is written (debounced
     * by `opts.debounceMs`, 500 ms by default). Only what a write changes is read again;
     * `opts.refetch: true` re-runs the whole read instead. `cb(data, err, { added, reset })`.
     */
    subscribe<T = BucketRecord>(bucketId: string, cb: BucketCallback<T>): Unsubscribe;
    subscribe<T = BucketRecord>(
        bucketId: string,
        opts: BucketSubscribeOptions,
        cb: BucketCallback<T>,
    ): Unsubscribe;
    subscribe(
        bucketId: string,
        optsOrCb: BucketSubscribeOptions | BucketCallback,
        maybeCb?: BucketCallback,
    ): Unsubscribe {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb)!;
        const opts = (typeof optsOrCb === 'function' ? {} : optsOrCb) || {};
        let device: string | null;
        try {
            device = this.device(opts);
        } catch (e) {
            // report it like any other read error, not as a synchronous throw
            void Promise.resolve().then(() => cb(null, e as Error));
            return () => {};
        }
        return new BucketFeed(this, this.sdk, bucketId, opts, device, cb).start();
    }
}
