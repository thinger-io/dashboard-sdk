import type { ThingerClient } from './client.js';
import { enc } from './http.js';
import type { EventFilter, ServerEvent, Unsubscribe } from './types.js';

interface Subscription {
    event: string | null;
    filters: Record<string, unknown>;
    cb: (event: ServerEvent) => void;
    onReconnect: (() => void) | undefined;
    registered: boolean;
    refused: boolean;
}

/** Split a flat filter `{ event, ...rest }` into `{ event, filters: rest }` for the wire. */
function splitFilter(input: EventFilter): {
    event: string | null;
    filters: Record<string, unknown>;
} {
    const filters: Record<string, unknown> = {};
    let event: string | null = null;
    for (const [k, v] of Object.entries(input)) {
        if (k === 'event') event = typeof v === 'string' ? v : null;
        else filters[k] = v;
    }
    return { event, filters };
}

/** Is a server reply about this subscription's registration (same event and filters)? */
function sameRequest(request: { event?: unknown; filters?: unknown }, sub: Subscription): boolean {
    if ((request.event || null) !== (sub.event || null)) return false;
    const a = (request.filters || {}) as Record<string, unknown>;
    const b = sub.filters;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => a[k] === b[k]);
}

/** Does an incoming event match a subscription? */
function matchEvent(frame: ServerEvent, sub: Subscription): boolean {
    if (sub.event && frame.event !== sub.event) return false;
    return Object.keys(sub.filters).every((k) => frame[k] === sub.filters[k]);
}

const OPEN = 1;
const CONNECTING = 0;

/**
 * Server events (bucket writes, property updates, alarms…) over one WebSocket shared by every
 * subscription, `/v2/users/{user}/events`. It reconnects with backoff, refreshing the token
 * first when it has expired.
 */
export class Events {
    private ws: WebSocket | null = null;
    private readonly subs = new Map<number, Subscription>();
    private nextId = 1;
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    /** @internal */
    constructor(private readonly sdk: ThingerClient) {}

    /**
     * Subscribe to server events. `filter` is `{ event, ...filters }`, e.g.
     * `{ event: 'bucket_write', bucket: 'b' }`. Events sent while the socket is down are lost:
     * `onReconnect()` runs each time it comes back after a drop.
     */
    subscribe<E extends ServerEvent = ServerEvent>(
        filter: EventFilter,
        cb: (event: E) => void,
        onReconnect?: () => void,
    ): Unsubscribe {
        const id = this.nextId++;
        const { event, filters } = splitFilter(filter);
        const sub: Subscription = {
            event,
            filters,
            cb: cb as (event: ServerEvent) => void,
            onReconnect,
            registered: false,
            refused: false,
        };
        this.subs.set(id, sub);
        if (this.ws && this.ws.readyState === OPEN) {
            this.ws.send(JSON.stringify({ action: 'register', event, filters }));
            sub.registered = true;
        } else {
            // not open yet: the open handler registers everything in `subs`
            this.connect();
        }
        return () => this.unsubscribe(id);
    }

    private unsubscribe(id: number): void {
        const sub = this.subs.get(id);
        if (!sub) return;
        this.subs.delete(id);
        // a socket that is down has no record of it, and reconnecting will not register it
        if (this.ws && this.ws.readyState === OPEN) {
            try {
                this.ws.send(
                    JSON.stringify({
                        action: 'unregister',
                        event: sub.event,
                        filters: sub.filters,
                    }),
                );
            } catch {
                // closing anyway
            }
        }
        if (this.subs.size === 0) {
            clearTimeout(this.reconnectTimer);
            if (this.ws) {
                const ws = this.ws;
                this.ws = null;
                try {
                    ws.close();
                } catch {
                    // already closed
                }
            }
        }
    }

    private url(): string | null {
        const user = this.sdk.user && this.sdk.user.id;
        const token = this.sdk.token;
        if (!user || !token) return null;
        let url =
            this.sdk.wsBase() + '/v2/users/' + enc(user) + '/events?authorization=' + enc(token);
        const project = this.sdk.project && this.sdk.project.id;
        if (project) url += '&project=' + enc(project);
        return url;
    }

    private connect(): void {
        if (this.ws && (this.ws.readyState === CONNECTING || this.ws.readyState === OPEN)) return;
        const url = this.url();
        const WS = this.sdk.env.WebSocket;
        if (!url || !WS) return;
        const ws = new WS(url);
        this.ws = ws;

        ws.addEventListener('open', () => {
            this.reconnectAttempts = 0;
            // (re-)register every subscription: those added while it was opening are in `subs` too
            this.subs.forEach((sub) => {
                ws.send(
                    JSON.stringify({ action: 'register', event: sub.event, filters: sub.filters }),
                );
                // registered on an earlier socket: the events sent while it was down are lost
                if (sub.registered && sub.onReconnect) {
                    try {
                        sub.onReconnect();
                    } catch (e) {
                        console.error('onReconnect threw', e);
                    }
                }
                sub.registered = true;
            });
        });

        ws.addEventListener('message', (ev: MessageEvent) => {
            let data: unknown;
            try {
                data = JSON.parse(String(ev.data));
            } catch {
                return;
            }
            if (!data || typeof data !== 'object') return;
            const frame = data as ServerEvent & {
                success?: unknown;
                message?: unknown;
                request?: { action?: unknown; event?: unknown; filters?: unknown };
            };
            // the server refused a registration (the token lacks User:SubscribeUserEvents, or the
            // event is not in its project): say it once, instead of a feed that never updates
            if (frame.success === false && frame.request && frame.request.action === 'register') {
                const request = frame.request;
                this.subs.forEach((sub) => {
                    if (sub.refused || !sameRequest(request, sub)) return;
                    sub.refused = true;
                    console.warn(
                        '[Thinger] realtime subscription to "' +
                            String(sub.event) +
                            '" refused by the server: ' +
                            (typeof frame.message === 'string' ? frame.message : 'not authorized') +
                            '. Data will not update live.',
                    );
                });
                return;
            }
            this.subs.forEach((sub) => {
                if (!matchEvent(frame, sub)) return;
                try {
                    sub.cb(frame);
                } catch (e) {
                    console.error('subscriber threw', e);
                }
            });
        });

        ws.addEventListener('close', () => {
            // a socket closed after a newer one replaced it: ignore it
            if (this.ws !== ws) return;
            this.ws = null;
            if (this.subs.size === 0) return;
            const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts++));
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
                void this.sdk.freshToken().then(() => this.connect());
            }, delay);
        });
    }
}
