/* eslint-disable @typescript-eslint/no-explicit-any -- open server documents, see below */
/**
 * Data types of the SDK calls. Server documents carry more fields than listed: the index
 * signatures keep them reachable, as `any` so app code reads them without casts. Type your own
 * records with the generic parameters, e.g. `buckets.read<Reading>(…)`.
 */
import type { Time } from './time.js';

export type { Time };
export type { User, Project, DashboardRef, Context, NavigateTarget } from './protocol.js';

/** Returned by every subscribe / poll / stream call: stop it. */
export type Unsubscribe = () => void;

/** Options of `request()`. */
export interface RequestOptions extends Omit<RequestInit, 'body'> {
    /** Any JSON value (serialized automatically), or a string / Blob / FormData / ArrayBuffer sent as is. */
    body?: unknown;
    /** Force the response type. Default: parsed JSON for JSON responses, text otherwise, null when empty. */
    as?: 'json' | 'text' | 'blob' | 'arrayBuffer';
    /** false: do not add the console's current `?project=` to this call. */
    project?: false;
}

/** Options of `fetch()`. */
export interface FetchOptions extends RequestInit {
    /** false: do not add the console's current `?project=` to this call. */
    project?: false;
}

// ---------------------------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------------------------

export interface BucketQuery {
    /** Device id, or `true` for the device of the dashboard context. */
    device?: string | true | null;
    from?: Time;
    to?: Time;
    /** Max 1000 per call; the server returns 50 when not set. */
    items?: number;
    /** 'desc' (default) or 'asc'. */
    sort?: 'asc' | 'desc';
    /** Aggregation period: '5m', '1h', '1d', '1w', '1mo', '1y'… */
    aggregation?: string;
    /** Aggregation function: 'mean', 'max', 'min', 'sum', 'count', 'first', 'last', 'mode'… */
    aggregator?: string;
    transform?: string;
    /** Fields to return, e.g. ['temperature']. */
    fields?: string | string[];
    /** Group results, e.g. 'device'. */
    groupBy?: string | string[];
    /** IANA zone where aggregation windows start (default: the viewer's browser zone). */
    timeZone?: string;
    /** Tag filters: one value, or any of several. */
    tags?: Record<string, string | number | Array<string | number>>;
}

export interface BucketSubscribeOptions extends BucketQuery {
    /** Wait for writes to settle before updating (default 500 ms). */
    debounceMs?: number;
    /** Re-run the whole read on each write instead of reading only what changed. */
    refetch?: boolean;
}

/** A bucket record: `ts` (ms) plus the stored fields. */
export interface BucketRecord {
    ts: number;
    [field: string]: any;
}

/** Third argument of the `buckets.subscribe` callback. */
export interface BucketChange<T = BucketRecord> {
    /** Records new or updated in this call (aggregation windows replace the old one), in `data` order. */
    added: T[];
    /** `data` comes from a full read: the first call, refetch, or after an error. */
    reset: boolean;
}

export type BucketCallback<T = BucketRecord> = (
    data: T[] | null,
    err: Error | null,
    change?: BucketChange<T>,
) => void;

// ---------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------

export interface DeviceConnection {
    active?: boolean;
    ts?: number;
    location?: { lat?: number; lon?: number; [key: string]: unknown };
    [key: string]: any;
}

export interface Device {
    device: string;
    name?: string;
    description?: string;
    type?: string;
    product?: string;
    asset_type?: string;
    asset_group?: string;
    labels?: Record<string, string>;
    enabled?: boolean;
    connection?: DeviceConnection;
    [key: string]: any;
}

export interface ListQuery {
    name?: string;
    sort?: string;
    order?: 'asc' | 'desc';
    /** Maximum number of items; all pages are fetched otherwise. */
    limit?: number;
    [filter: string]: unknown;
}

export interface DeviceQuery extends ListQuery {
    product?: string;
    asset_type?: string;
    asset_group?: string;
    type?: string;
    /** `{ key: value }` for exact matches, or `[key]` for devices that have the label. */
    labels?: Record<string, string> | string[];
}

export interface LocationsQuery {
    group?: string;
    type?: string;
    connected?: boolean;
}

/** Level a device property's value comes from: the first that defines it. */
export type PropertySource = 'device' | 'type' | 'group' | 'product';

export interface Property<T = unknown> {
    property: string;
    name?: string;
    description?: string;
    value: T;
    /**
     * Device properties only: the level the value comes from, the first that defines it
     * (device → asset type → asset group → product). `listProperties` leaves it out for the
     * device's own properties.
     */
    source?: PropertySource;
    created?: string;
    modified?: string;
    [key: string]: any;
}

export interface PropertyQuery {
    /** Property id, or a pattern matching several ('temp*'). */
    id?: string;
}

/** Envelope of a value delivered by `streamResource`. */
export interface StreamFrame {
    /** 'shadow': the last value saved when the device disconnected, sent once while it is offline. */
    signal: 'data' | 'error' | 'shadow';
    resource?: string;
    ts?: number;
    error?: string;
    payload?: any;
    [key: string]: any;
}

export type DeviceState = 'connected' | 'disconnected' | 'resumed' | 'awake' | 'asleep';

export interface DeviceStateEvent {
    event: 'device_state_change';
    device: string;
    product?: string;
    state: DeviceState;
    ts?: number;
    [key: string]: any;
}

export interface PropertyUpdateEvent {
    event: 'device_property_update';
    device: string;
    property: string;
    value?: unknown;
    ts?: number;
    [key: string]: any;
}

// ---------------------------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------------------------

export type AlarmState = 0 | 1 | 2 | 3 | 4 | 5;
export type AlarmSeverity = 0 | 1 | 2 | 3 | 4;

export interface AlarmUpdateOptions {
    annotation?: string;
    reactivation?: {
        type: 'timespan';
        timespan: {
            value: number;
            magnitude: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
        };
    };
}

export interface AlarmInstance {
    instance: string;
    name?: string;
    severity: AlarmSeverity;
    state: AlarmState;
    /** alarm.rule is the rule id. */
    alarm: { rule: string; [key: string]: unknown };
    /** origin.id is the device. */
    origin: { source: 'device'; id: string; name?: string };
    asset_type?: string;
    asset_group?: string;
    project?: string[];
    /** Timestamps in ms. */
    activation?: { detections?: number; initiated?: number; completed?: number };
    normalization?: { detections?: number; initiated?: number; completed?: number };
    /** Values that triggered it: { "<source>.<field>": value }. */
    evaluation?: { last_values?: Record<string, unknown>; [key: string]: unknown };
    annotation?: string;
    [key: string]: any;
}

/** Query of alarm instances: exact values, nested fields with dots, an array matching any. */
export type AlarmQuery = Record<string, unknown>;

export interface AlarmSubscribeQuery extends AlarmQuery {
    /** Wait for changes to settle before listing again (default 500 ms). */
    debounceMs?: number;
}

/** A server event (bucket_write, alarm_instance_update…): `event` plus its fields. */
export interface ServerEvent {
    event?: string;
    [key: string]: any;
}

/** `{ event, ...filters }`, e.g. `{ event: 'bucket_write', bucket: 'b' }`. */
export interface EventFilter {
    event?: string;
    [key: string]: any;
}

// ---------------------------------------------------------------------------------------------
// Other resources
// ---------------------------------------------------------------------------------------------

export type ResourceKind =
    | 'device'
    | 'product'
    | 'bucket'
    | 'group'
    | 'type'
    | 'project'
    | 'dashboard'
    | 'endpoint'
    | 'storage'
    | 'alarm_rule';

export type PropertyKind = 'device' | 'product' | 'project' | 'group' | 'type';

export interface Product {
    product: string;
    name?: string;
    description?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
    profile?: Record<string, unknown>;
    [key: string]: any;
}

export interface StorageFile {
    name: string;
    path: string;
    size: number;
    type: 'file' | 'directory';
    [key: string]: any;
}

export interface ProjectRef {
    project: string;
    name?: string;
    description?: string;
    /** Set on projects shared with the viewer: the account that owns them. */
    owner?: string;
    [key: string]: any;
}
