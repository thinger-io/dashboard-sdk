import type { ThingerClient } from './client.js';
import { buildQuery, enc } from './http.js';
import type {
    AlarmInstance,
    AlarmQuery,
    AlarmSubscribeQuery,
    AlarmUpdateOptions,
    ServerEvent,
    Unsubscribe,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- rule documents and stats are open */

/** Numeric state values of the backend ALARM_STATE enum. */
export const ALARM_STATE = Object.freeze({
    NONE: 0,
    ACTIVATED: 1,
    ACKNOWLEDGED: 2,
    LATCHED: 3,
    SHELVED: 4,
    CLEARED: 5,
} as const);

/** Numeric severity values of the backend ALARM_SEVERITY enum. */
export const ALARM_SEVERITY = Object.freeze({
    NONE: 0,
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
    CRITICAL: 4,
} as const);

/** Server events that change the alarm instance list. */
export const ALARM_INSTANCE_EVENTS = Object.freeze([
    'alarm_instance_activate',
    'alarm_instance_normalize',
    'alarm_instance_create',
    'alarm_instance_update',
    'alarm_instance_delete',
] as const);

/** Alarm rules and their executions. */
export class AlarmRules {
    /** @internal */
    constructor(private readonly sdk: ThingerClient) {}

    list(query?: Record<string, unknown>): Promise<any[]> {
        return this.sdk.request<any[]>(
            '/v1/users/' + enc(this.sdk.userId()) + '/alarms/rules' + buildQuery(query),
        );
    }

    get(ruleId: string): Promise<any> {
        return this.sdk.request(
            '/v1/users/' + enc(this.sdk.userId()) + '/alarms/rules/' + enc(ruleId),
        );
    }

    /** alarm_rule_execute events (needs the account owner). */
    subscribe(cb: (event: ServerEvent) => void): Unsubscribe {
        return this.sdk.events.subscribe({ event: 'alarm_rule_execute' }, cb);
    }

    /** Same as `subscribe(cb)`. */
    onExecute(cb: (event: ServerEvent) => void): Unsubscribe {
        return this.subscribe(cb);
    }
}

/** Alarm instances: list, live list, state changes. */
export class Alarms {
    /** NONE 0, ACTIVATED 1, ACKNOWLEDGED 2, LATCHED 3, SHELVED 4, CLEARED 5. */
    static readonly STATE = ALARM_STATE;
    /** NONE 0, LOW 1, MEDIUM 2, HIGH 3, CRITICAL 4. */
    static readonly SEVERITY = ALARM_SEVERITY;
    /** Server events that change the alarm instance list. */
    static readonly INSTANCE_EVENTS = ALARM_INSTANCE_EVENTS;

    /** Same as `Alarms.STATE`, reachable as `Thinger.alarms.STATE`. */
    readonly STATE = ALARM_STATE;
    /** Same as `Alarms.SEVERITY`, reachable as `Thinger.alarms.SEVERITY`. */
    readonly SEVERITY = ALARM_SEVERITY;
    readonly rules: AlarmRules;

    /** @internal */
    constructor(private readonly sdk: ThingerClient) {
        this.rules = new AlarmRules(sdk);
    }

    private base(): string {
        return '/v1/users/' + enc(this.sdk.userId()) + '/alarms/instances';
    }

    /**
     * Alarm instances. `query` is sent as query params: exact values, nested fields with dots, an
     * array matching any of its values (`{ state: 1 }`, `{ 'alarm.rule': 'r1', 'origin.id': ['d1', 'd2'] }`).
     */
    list(query?: AlarmQuery): Promise<AlarmInstance[]> {
        return this.sdk.request<AlarmInstance[]>(this.base() + buildQuery(query));
    }

    get(instanceId: string): Promise<AlarmInstance> {
        return this.sdk.request<AlarmInstance>(this.base() + '/' + enc(instanceId));
    }

    /** Counts per state / severity. */
    stats(): Promise<any> {
        return this.sdk.request(this.base() + '/stats');
    }

    /**
     * `list(query)` now, and again (debounced by `query.debounceMs`, 500 ms by default) whenever an
     * instance is activated, normalized, updated (acknowledge, shelve, latch, clear, annotation;
     * from this app or anywhere else), created or deleted. `cb(instances, err)`.
     */
    subscribe(cb: (instances: AlarmInstance[] | null, err: Error | null) => void): Unsubscribe;
    subscribe(
        query: AlarmSubscribeQuery,
        cb: (instances: AlarmInstance[] | null, err: Error | null) => void,
    ): Unsubscribe;
    subscribe(
        queryOrCb:
            AlarmSubscribeQuery | ((instances: AlarmInstance[] | null, err: Error | null) => void),
        maybeCb?: (instances: AlarmInstance[] | null, err: Error | null) => void,
    ): Unsubscribe {
        const cb = (typeof queryOrCb === 'function' ? queryOrCb : maybeCb)!;
        const query = typeof queryOrCb === 'function' ? {} : queryOrCb || {};
        const { debounceMs: debounce, ...apiQuery } = query;
        const debounceMs = typeof debounce === 'number' ? debounce : 500;

        let timer: ReturnType<typeof setTimeout> | undefined;
        // after unsubscribe, a read still in flight must not call back (the view may be gone)
        let closed = false;
        const refetch = async () => {
            let data: AlarmInstance[] | null = null;
            let err: Error | null = null;
            try {
                data = await this.list(apiQuery);
            } catch (e) {
                err = e as Error;
            }
            if (!closed) cb(data, err);
        };
        void refetch();

        // event filters only take `instance`: narrow by re-listing with `query` instead
        const onEvent = () => {
            if (closed) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
                timer = undefined;
                void refetch();
            }, debounceMs);
        };
        const unsubs = ALARM_INSTANCE_EVENTS.map((event) =>
            this.sdk.events.subscribe({ event }, onEvent),
        );
        return () => {
            closed = true;
            clearTimeout(timer);
            unsubs.forEach((unsub) => unsub());
        };
    }

    /** Raw alarm_instance_activate events. */
    onActivate(cb: (event: ServerEvent) => void): Unsubscribe {
        return this.sdk.events.subscribe({ event: 'alarm_instance_activate' }, cb);
    }

    /** Raw alarm_instance_normalize events. */
    onNormalize(cb: (event: ServerEvent) => void): Unsubscribe {
        return this.sdk.events.subscribe({ event: 'alarm_instance_normalize' }, cb);
    }

    /** Raw alarm_instance_update events (state, annotation… changed). */
    onUpdate(cb: (event: ServerEvent) => void): Unsubscribe {
        return this.sdk.events.subscribe({ event: 'alarm_instance_update' }, cb);
    }

    /**
     * Update an instance: usually its `state` (see `STATE`), with `annotation` / `reactivation`.
     * The server validates transitions (a CLEARED alarm cannot be reactivated). The helpers
     * below only differ in the state they set.
     */
    update(instanceId: string, body: Record<string, unknown>): Promise<any> {
        return this.sdk.request(this.base() + '/' + enc(instanceId), {
            method: 'PUT',
            body: body || {},
        });
    }

    acknowledge(instanceId: string, opts?: AlarmUpdateOptions): Promise<any> {
        return this.update(instanceId, { ...opts, state: ALARM_STATE.ACKNOWLEDGED });
    }

    /** Shelve (usually with a reactivation timespan). */
    shelve(instanceId: string, opts?: AlarmUpdateOptions): Promise<any> {
        return this.update(instanceId, { ...opts, state: ALARM_STATE.SHELVED });
    }

    /** Latch (fires again after the configured timeout). */
    latch(instanceId: string, opts?: AlarmUpdateOptions): Promise<any> {
        return this.update(instanceId, { ...opts, state: ALARM_STATE.LATCHED });
    }

    /** Clear (resolve). A cleared instance cannot be reactivated. */
    clear(instanceId: string, opts?: AlarmUpdateOptions): Promise<any> {
        return this.update(instanceId, { ...opts, state: ALARM_STATE.CLEARED });
    }
}
