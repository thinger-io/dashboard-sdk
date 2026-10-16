import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeSocket, flush, framed, json } from './harness.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('events', () => {
    it('registers every subscription on one socket and dispatches matching events', async () => {
        const { sdk, init } = framed();
        await init();
        const a = vi.fn();
        const b = vi.fn();
        sdk.events.subscribe({ event: 'bucket_write', bucket: 'b1' }, a);
        sdk.events.subscribe({ event: 'device_state_change', device: 'd1' }, b);
        expect(FakeSocket.instances).toHaveLength(1);
        const ws = FakeSocket.last();
        ws.open();
        expect(ws.sent).toEqual([
            { action: 'register', event: 'bucket_write', filters: { bucket: 'b1' } },
            { action: 'register', event: 'device_state_change', filters: { device: 'd1' } },
        ]);
        ws.receive({ event: 'bucket_write', bucket: 'b2' });
        ws.receive({ event: 'bucket_write', bucket: 'b1', data: { v: 1 } });
        ws.receive({ event: 'device_state_change', device: 'd1', state: 'connected' });
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledWith(expect.objectContaining({ state: 'connected' }));
    });

    it('unregisters, and closes the socket with the last subscription', async () => {
        const { sdk, init } = framed();
        await init();
        const off1 = sdk.events.subscribe({ event: 'e1' }, () => {});
        const off2 = sdk.events.subscribe({ event: 'e2' }, () => {});
        const ws = FakeSocket.last();
        ws.open();
        off1();
        expect(ws.sent.at(-1)).toEqual({ action: 'unregister', event: 'e1', filters: {} });
        off2();
        expect(ws.readyState).toBe(3);
    });

    it('warns once when the server refuses a registration', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { sdk, init } = framed();
        await init();
        sdk.events.subscribe({ event: 'device_state_change', device: 'd1' }, () => {});
        const ws = FakeSocket.last();
        ws.open();
        const refusal = {
            success: false,
            message: 'forbidden',
            request: {
                action: 'register',
                event: 'device_state_change',
                filters: { device: 'd1' },
            },
        };
        ws.receive(refusal);
        ws.receive(refusal);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain('forbidden');
    });

    it('reconnects with backoff, registers again and tells who asked', async () => {
        const { sdk, init } = framed();
        await init();
        vi.useFakeTimers();
        const onReconnect = vi.fn();
        sdk.events.subscribe({ event: 'e' }, () => {}, onReconnect);
        FakeSocket.last().open();
        FakeSocket.last().close();
        await vi.advanceTimersByTimeAsync(999);
        expect(FakeSocket.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(FakeSocket.instances).toHaveLength(2);
        FakeSocket.last().open();
        expect(FakeSocket.last().sent).toEqual([{ action: 'register', event: 'e', filters: {} }]);
        expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it('does not reconnect after the last unsubscribe', async () => {
        const { sdk, init } = framed();
        await init();
        vi.useFakeTimers();
        const off = sdk.events.subscribe({ event: 'e' }, () => {});
        FakeSocket.last().open();
        FakeSocket.last().close();
        off();
        await vi.advanceTimersByTimeAsync(60000);
        expect(FakeSocket.instances).toHaveLength(1);
    });
});

describe('buckets.subscribe', () => {
    it('reads, then inserts the records that bucket_write events carry', async () => {
        const { sdk, server, init } = framed();
        server.on(
            'GET',
            '/v2/users/alice/buckets/b/data',
            json([
                { ts: 2000, t: 2 },
                { ts: 1000, t: 1 },
            ]),
        );
        await init();
        const cb = vi.fn();
        sdk.buckets.subscribe('b', { from: 0, debounceMs: 0 }, cb);
        await flush();
        expect(cb).toHaveBeenLastCalledWith(
            [
                { ts: 2000, t: 2 },
                { ts: 1000, t: 1 },
            ],
            null,
            {
                added: [
                    { ts: 2000, t: 2 },
                    { ts: 1000, t: 1 },
                ],
                reset: true,
            },
        );
        const ws = FakeSocket.last();
        ws.open();
        expect(ws.sent).toEqual([
            { action: 'register', event: 'bucket_write', filters: { bucket: 'b' } },
        ]);
        ws.receive({ event: 'bucket_write', bucket: 'b', data: { ts: { $date: 3000 }, t: 3 } });
        await flush();
        expect(cb).toHaveBeenLastCalledWith(
            [
                { ts: 3000, t: 3 },
                { ts: 2000, t: 2 },
                { ts: 1000, t: 1 },
            ],
            null,
            { added: [{ ts: 3000, t: 3 }], reset: false },
        );
        // only the initial read went to the server
        expect(server.apiCalls).toHaveLength(1);
    });

    it('reads what is new when the event does not carry the record', async () => {
        const { sdk, server, init } = framed();
        let rows = [{ ts: 1000, t: 1 }];
        server.on('GET', '/v2/users/alice/buckets/b/data', () => json([...rows].reverse()));
        await init();
        const cb = vi.fn();
        sdk.buckets.subscribe('b', { debounceMs: 0 }, cb);
        await flush();
        FakeSocket.last().open();
        rows = [...rows, { ts: 2000, t: 2 }];
        FakeSocket.last().receive({ event: 'bucket_write', bucket: 'b', ts: 2000, data: { t: 2 } });
        await flush();
        expect(cb).toHaveBeenCalledTimes(2);
        expect(cb.mock.calls[1]![0]).toEqual([
            { ts: 2000, t: 2 },
            { ts: 1000, t: 1 },
        ]);
        const since = new URL('https://x' + server.apiCalls[1]!.url).searchParams.get('min_ts');
        expect(since).toBe('1000');
    });

    it('re-reads everything with refetch, and stops after unsubscribe', async () => {
        const { sdk, server, init } = framed();
        server.on('GET', '/v2/users/alice/buckets/b/data', json([{ ts: 1 }]));
        await init();
        const cb = vi.fn();
        const off = sdk.buckets.subscribe('b', { refetch: true, debounceMs: 0 }, cb);
        await flush();
        FakeSocket.last().open();
        FakeSocket.last().receive({
            event: 'bucket_write',
            bucket: 'b',
            data: { ts: { $date: 5 } },
        });
        await flush();
        expect(cb.mock.calls.map((c) => c[2].reset)).toEqual([true, true]);
        off();
        FakeSocket.instances.forEach((s) => s.receive({ event: 'bucket_write', bucket: 'b' }));
        await flush();
        expect(cb).toHaveBeenCalledTimes(2);
    });

    it('subscribes per device on device reads', async () => {
        const { sdk, server, init } = framed();
        server.on('GET', '/v3/users/alice/devices/d1/buckets/b/data', json([]));
        await init({ context: { device: 'd1' } });
        sdk.buckets.subscribe('b', { device: true }, () => {});
        await flush();
        FakeSocket.last().open();
        expect(FakeSocket.last().sent[0]).toEqual({
            action: 'register',
            event: 'bucket_write',
            filters: { device: 'd1', bucket: 'b' },
        });
    });
});

describe('alarms.subscribe', () => {
    it('lists now and again, debounced, on instance events', async () => {
        const { sdk, server, init } = framed();
        let n = 0;
        server.on('GET', '/v1/users/alice/alarms/instances', () => json([{ instance: 'i' + ++n }]));
        await init();
        const cb = vi.fn();
        sdk.alarms.subscribe({ state: 1, debounceMs: 0 }, cb);
        await flush();
        expect(cb).toHaveBeenLastCalledWith([{ instance: 'i1' }], null);
        const ws = FakeSocket.last();
        ws.open();
        expect(ws.sent.map((m) => m.event)).toEqual([
            'alarm_instance_activate',
            'alarm_instance_normalize',
            'alarm_instance_create',
            'alarm_instance_update',
            'alarm_instance_delete',
        ]);
        ws.receive({ event: 'alarm_instance_update', instance: 'i1' });
        ws.receive({ event: 'alarm_instance_activate', instance: 'i2' });
        await flush();
        expect(cb).toHaveBeenCalledTimes(2);
        expect(server.apiCalls[0]!.url).toBe('/v1/users/alice/alarms/instances?state=1');
    });
});

describe('devices.streamResource', () => {
    it('shares one stream per resource at the GCD of the intervals', async () => {
        const { sdk, init } = framed();
        await init();
        const a = vi.fn();
        const offA = sdk.devices.streamResource('d1', 'temp', 4000, a);
        const offB = sdk.devices.streamResource('d1', 'temp', 6000, () => {});
        const ws = FakeSocket.last();
        ws.open();
        expect(ws.sent).toEqual([{ resource: 'temp', interval: 2, enabled: true }]);
        ws.receive({ signal: 'data', resource: 'temp', payload: 21.5 });
        expect(a).toHaveBeenCalledWith(21.5, null, expect.objectContaining({ signal: 'data' }));
        offB();
        expect(ws.sent.at(-1)).toEqual({ resource: 'temp', interval: 4, enabled: true });
        offA();
        expect(ws.sent.at(-1)).toEqual({ resource: 'temp', enabled: false });
        expect(ws.readyState).toBe(3);
    });

    it('delivers the error and then the shadow value when the device is offline', async () => {
        const { sdk, server, init } = framed();
        server.on('GET', '/v3/users/alice/devices/d1/resources/temp?shadow=true', json(19));
        await init();
        const cb = vi.fn();
        sdk.devices.streamResource('d1', 'temp', cb);
        const ws = FakeSocket.last();
        ws.open();
        ws.receive({ signal: 'error', error: 'device not connected' });
        await flush();
        expect(cb.mock.calls[0]![1]).toBeInstanceOf(Error);
        expect(cb.mock.calls[1]).toEqual([19, null, { signal: 'shadow', resource: 'temp' }]);
    });
});
