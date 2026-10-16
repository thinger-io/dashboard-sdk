import type { ThingerClient } from './client.js';
import { enc } from './http.js';
import type {
    Device,
    DeviceQuery,
    DeviceStateEvent,
    LocationsQuery,
    Property,
    PropertyQuery,
    PropertyUpdateEvent,
    StreamFrame,
    Unsubscribe,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- device payloads are whatever the firmware sends */

type StreamCallback = (payload: any, err: Error | null, frame: StreamFrame) => void;

interface StreamListener {
    intervalSec: number;
    cb: StreamCallback;
}

interface ResourceStream {
    listeners: Set<StreamListener>;
    intervalSec: number | null;
    shadowSent: boolean;
}

interface DeviceSocket {
    ws: WebSocket | null;
    subs: Map<string, ResourceStream>;
    reconnectAttempts: number;
    reconnectTimer: ReturnType<typeof setTimeout> | undefined;
}

const OPEN = 1;
const CONNECTING = 0;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Devices: documents, properties, resources (read, call, poll, stream) and their events. */
export class Devices {
    // device id → its resources socket
    private readonly streams = new Map<string, DeviceSocket>();

    /** @internal */
    constructor(private readonly sdk: ThingerClient) {}

    private base(deviceId: string, version = 'v1'): string {
        return '/' + version + '/users/' + enc(this.sdk.userId()) + '/devices/' + enc(deviceId);
    }

    /**
     * Devices, all pages (the API returns 50 per page). `query` filters: product, asset_type,
     * asset_group, type, name, sort, order, labels (`{ key: value }`, or `[key]` for "has label"),
     * limit.
     */
    async list(query?: DeviceQuery): Promise<Device[]> {
        return this.sdk.resources.list<Device>('device', query);
    }

    /** One device, with its `connection` status. */
    async get(deviceId: string): Promise<Device> {
        return this.sdk.request<Device>(this.base(deviceId));
    }

    /**
     * Device locations for maps. Without options: every asset with a location. `{ group }` /
     * `{ type }` narrow it to an asset group / type; `{ connected: true }` returns only connected
     * devices.
     */
    async locations(opts?: LocationsQuery): Promise<any[]> {
        const o = opts || {};
        const u = '/v1/users/' + enc(this.sdk.userId());
        let path: string;
        if (o.connected) path = u + '/info/devices/locations';
        else if (o.group) path = u + '/groups/' + enc(o.group) + '/locations';
        else if (o.type) path = u + '/types/' + enc(o.type) + '/locations';
        else path = u + '/assets/locations';
        return this.sdk.request<any[]>(path);
    }

    /** Traffic usage of one device over the last 30 days. */
    async stats(deviceId: string): Promise<any> {
        return this.sdk.request(this.base(deviceId, 'v3') + '/stats');
    }

    // ----- Properties ---------------------------------------------------------------------

    /**
     * Properties of a device, inherited ones included: those carry `source` (`type`, `group` or
     * `product`). `query.id` accepts a pattern ('temp*').
     */
    async listProperties(deviceId: string, query?: PropertyQuery): Promise<Property[]> {
        return this.sdk.properties.list('device', deviceId, query);
    }

    /** One property: `{ property, value, source, created, modified, … }`. */
    async getProperty<T = any>(deviceId: string, propertyId: string): Promise<Property<T>> {
        return this.sdk.properties.get<T>('device', deviceId, propertyId);
    }

    /** Create or update a property. */
    async setProperty(deviceId: string, propertyId: string, value: unknown): Promise<any> {
        return this.sdk.properties.set('device', deviceId, propertyId, value);
    }

    /** Remove a property (true also when it did not exist). */
    async deleteProperty(deviceId: string, propertyId: string): Promise<boolean> {
        return this.sdk.properties.delete('device', deviceId, propertyId);
    }

    // ----- Resources ----------------------------------------------------------------------

    /**
     * Read a device resource. `shadow: true` returns the last value saved when the device
     * disconnected.
     */
    async getResource<T = any>(
        deviceId: string,
        resource: string,
        opts?: { shadow?: boolean },
    ): Promise<T> {
        return this.sdk.request<T>(
            this.base(deviceId, 'v3') +
                '/resources/' +
                enc(resource) +
                (opts && opts.shadow ? '?shadow=true' : ''),
        );
    }

    /**
     * Call a device resource (actuation / RPC) with `input` as its JSON body: any serializable
     * value. Returns the device's response, or null when it sends none.
     */
    async callResource<T = any>(deviceId: string, resource: string, input?: unknown): Promise<T> {
        return this.sdk.request<T>(this.base(deviceId, 'v3') + '/resources/' + enc(resource), {
            method: 'POST',
            body: input === undefined ? null : input,
        });
    }

    /** Read a resource every `intervalMs`. `cb(data, err)` per read. */
    pollResource<T = any>(
        deviceId: string,
        resource: string,
        intervalMs: number,
        cb: (data: T | null, err: Error | null) => void,
    ): Unsubscribe {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = async () => {
            if (stopped) return;
            try {
                const data = await this.getResource<T>(deviceId, resource);
                if (!stopped) cb(data, null);
            } catch (e) {
                if (!stopped) cb(null, e as Error);
            }
            if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
        };
        void tick();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }

    /** Property update events of one property. */
    subscribeProperty(
        deviceId: string,
        propertyId: string,
        cb: (event: PropertyUpdateEvent) => void,
    ): Unsubscribe {
        return this.sdk.events.subscribe<PropertyUpdateEvent>(
            { event: 'device_property_update', device: deviceId, property: propertyId },
            cb,
        );
    }

    /** Connection events; `event.state` is connected, disconnected, resumed, awake or asleep. */
    subscribeState(deviceId: string, cb: (event: DeviceStateEvent) => void): Unsubscribe {
        return this.sdk.events.subscribe<DeviceStateEvent>(
            { event: 'device_state_change', device: deviceId },
            cb,
        );
    }

    /**
     * The device pushes the resource every `intervalMs` (0 or omitted: when it changes), over
     * the device's resources WebSocket. Intervals go to the device in whole seconds.
     * Subscribers of one resource share its stream, at the GCD of their intervals. When the
     * device is offline, `cb` gets the error and then the last known value
     * (`frame.signal === 'shadow'`). Reconnects with backoff.
     */
    streamResource<T = any>(
        deviceId: string,
        resource: string,
        cb: (payload: T | null, err: Error | null, frame: StreamFrame) => void,
    ): Unsubscribe;
    streamResource<T = any>(
        deviceId: string,
        resource: string,
        intervalMs: number,
        cb: (payload: T | null, err: Error | null, frame: StreamFrame) => void,
    ): Unsubscribe;
    streamResource(
        deviceId: string,
        resource: string,
        intervalOrCb: number | StreamCallback,
        maybeCb?: StreamCallback,
    ): Unsubscribe {
        const cb = (typeof intervalOrCb === 'function' ? intervalOrCb : maybeCb)!;
        const intervalMs = typeof intervalOrCb === 'number' ? intervalOrCb : 0;
        const listener: StreamListener = {
            intervalSec: Math.max(0, Math.round((intervalMs || 0) / 1000)),
            cb,
        };
        let entry = this.streams.get(deviceId);
        if (!entry) {
            entry = { ws: null, subs: new Map(), reconnectAttempts: 0, reconnectTimer: undefined };
            this.streams.set(deviceId, entry);
        }
        let sub = entry.subs.get(resource);
        if (!sub) {
            sub = { listeners: new Set(), intervalSec: null, shadowSent: false };
            entry.subs.set(resource, sub);
        }
        sub.listeners.add(listener);
        if (entry.ws && entry.ws.readyState === OPEN) this.syncStream(entry, resource, sub);
        else this.connect(deviceId);
        return () => this.unsubStream(deviceId, resource, listener);
    }

    // The stream interval is the GCD of its listeners' (0 = on change when nobody asked for an
    // interval), as in the widget dashboards. Re-registers only when it changes.
    private syncStream(entry: DeviceSocket, resource: string, sub: ResourceStream, force = false) {
        const intervals: number[] = [];
        sub.listeners.forEach((l) => {
            if (l.intervalSec > 0) intervals.push(l.intervalSec);
        });
        const intervalSec = intervals.length ? intervals.reduce(gcd) : 0;
        if (!force && intervalSec === sub.intervalSec) return;
        sub.intervalSec = intervalSec;
        if (entry.ws && entry.ws.readyState === OPEN) {
            entry.ws.send(JSON.stringify({ resource, interval: intervalSec, enabled: true }));
        }
    }

    private emit(sub: ResourceStream, payload: unknown, err: Error | null, frame: StreamFrame) {
        sub.listeners.forEach((l) => {
            try {
                l.cb(payload, err, frame);
            } catch (e) {
                console.error('stream subscriber threw', e);
            }
        });
    }

    // Device offline: deliver the last known value (shadow) once, as the widget dashboards do.
    private async emitShadow(deviceId: string, resource: string, sub: ResourceStream) {
        if (sub.shadowSent) return;
        sub.shadowSent = true;
        try {
            const value = await this.getResource(deviceId, resource, { shadow: true });
            if (value != null) this.emit(sub, value, null, { signal: 'shadow', resource });
        } catch {
            // no shadow available
        }
    }

    private unsubStream(deviceId: string, resource: string, listener: StreamListener) {
        const entry = this.streams.get(deviceId);
        if (!entry) return;
        const sub = entry.subs.get(resource);
        if (!sub || !sub.listeners.delete(listener)) return;
        if (sub.listeners.size > 0) {
            this.syncStream(entry, resource, sub);
            return;
        }
        entry.subs.delete(resource);
        if (entry.ws && entry.ws.readyState === OPEN) {
            try {
                entry.ws.send(JSON.stringify({ resource, enabled: false }));
            } catch {
                // closing anyway
            }
        }
        if (entry.subs.size === 0) {
            const ws = entry.ws;
            entry.ws = null;
            clearTimeout(entry.reconnectTimer);
            this.streams.delete(deviceId);
            if (ws) {
                try {
                    ws.close();
                } catch {
                    // already closed
                }
            }
        }
    }

    private connect(deviceId: string): void {
        const entry = this.streams.get(deviceId);
        if (!entry) return;
        if (entry.ws && (entry.ws.readyState === CONNECTING || entry.ws.readyState === OPEN))
            return;
        const user = this.sdk.user && this.sdk.user.id;
        const token = this.sdk.token;
        const WS = this.sdk.env.WebSocket;
        if (!user || !token || !WS) return;

        let url =
            this.sdk.wsBase() +
            this.base(deviceId, 'v3') +
            '/resources?authorization=' +
            enc(token);
        const project = this.sdk.project && this.sdk.project.id;
        if (project) url += '&project=' + enc(project);

        const ws = new WS(url);
        entry.ws = ws;

        ws.addEventListener('open', () => {
            entry.reconnectAttempts = 0;
            entry.subs.forEach((sub, resource) => {
                sub.shadowSent = false;
                this.syncStream(entry, resource, sub, true);
            });
        });

        ws.addEventListener('message', (ev: MessageEvent) => {
            let frame: StreamFrame;
            try {
                frame = JSON.parse(String(ev.data)) as StreamFrame;
            } catch {
                return;
            }
            if (!frame || !frame.signal) return;
            if (frame.signal === 'data' && frame.resource) {
                const sub = entry.subs.get(frame.resource);
                if (sub) this.emit(sub, frame.payload, null, frame);
            } else if (frame.signal === 'error') {
                const err = new Error(frame.error || 'stream error');
                const targets: Array<[string, ResourceStream | undefined]> = frame.resource
                    ? [[frame.resource, entry.subs.get(frame.resource)]]
                    : Array.from(entry.subs.entries());
                for (const [resource, sub] of targets) {
                    if (!sub) continue;
                    this.emit(sub, null, err, frame);
                    void this.emitShadow(deviceId, resource, sub);
                }
            }
        });

        ws.addEventListener('close', () => {
            // a socket closed after its entry was dropped, or after a newer socket replaced it
            if (this.streams.get(deviceId) !== entry || entry.ws !== ws) return;
            entry.ws = null;
            if (entry.subs.size === 0) {
                this.streams.delete(deviceId);
                return;
            }
            const delay = Math.min(30000, 1000 * Math.pow(2, entry.reconnectAttempts++));
            clearTimeout(entry.reconnectTimer);
            entry.reconnectTimer = setTimeout(() => {
                void this.sdk.freshToken().then(() => this.connect(deviceId));
            }, delay);
        });
    }
}
