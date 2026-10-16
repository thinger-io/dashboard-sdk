import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_REFRESH_TIMEOUT_MS } from '../../src/protocol.js';
import { FakeSocket, flush, framed, json, token } from './harness.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('token refresh inside the console', () => {
    it('asks for a token on 401 and retries once with it', async () => {
        const { sdk, server, parent, win, init } = framed();
        let n = 0;
        server.on('GET', '/v1/users/alice/devices/d1', (call) =>
            call.headers['Authorization'] === 'Bearer ' + token('alice', { n: 2 })
                ? json({ device: 'd1', n: ++n })
                : { status: 401 },
        );
        await init();
        const pending = sdk.devices.get('d1');
        await flush();
        expect(parent.of('thinger:refresh-token')).toHaveLength(1);
        win.receive({ type: 'thinger:token', token: token('alice', { n: 2 }) });
        await expect(pending).resolves.toEqual({ device: 'd1', n: 1 });
        expect(sdk.token).toBe(token('alice', { n: 2 }));
    });

    it('shares one refresh among concurrent 401s', async () => {
        const { sdk, server, parent, win, init } = framed();
        const fresh = token('alice', { n: 2 });
        server.on('GET', /^\/v1\/users\/alice\/devices\/d\d/, (call) =>
            call.headers['Authorization'] === 'Bearer ' + fresh ? json({}) : { status: 401 },
        );
        await init();
        const all = Promise.all([
            sdk.devices.get('d1'),
            sdk.devices.get('d2'),
            sdk.devices.get('d3'),
        ]);
        await flush();
        expect(parent.of('thinger:refresh-token')).toHaveLength(1);
        win.receive({ type: 'thinger:token', token: fresh });
        await expect(all).resolves.toHaveLength(3);
    });

    it('fails with the 401 when the console refuses', async () => {
        const { sdk, server, win, init } = framed();
        server.on('GET', '/v1/users/alice/devices/d1', { status: 401 });
        await init();
        const pending = sdk.devices.get('d1');
        await flush();
        win.receive({ type: 'thinger:token', token: null });
        await expect(pending).rejects.toMatchObject({ code: 'http', status: 401 });
    });

    it('gives up when the console does not answer', async () => {
        const { sdk, server, init } = framed();
        server.on('GET', '/v1/users/alice/devices/d1', { status: 401 });
        await init();
        vi.useFakeTimers();
        const pending = sdk.devices.get('d1');
        const check = expect(pending).rejects.toMatchObject({ status: 401 });
        await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_TIMEOUT_MS + 10);
        await check;
    });

    it('refreshes an expiring token before reconnecting a socket', async () => {
        const { sdk, parent, win, init } = framed();
        await init({ token: token('alice', { exp: Math.floor(Date.now() / 1000) + 5 }) });
        vi.useFakeTimers();
        sdk.events.subscribe({ event: 'bucket_write', bucket: 'b' }, () => {});
        const first = FakeSocket.last();
        first.open();
        first.close();
        await vi.advanceTimersByTimeAsync(1000);
        expect(parent.of('thinger:refresh-token')).toHaveLength(1);
        const fresh = token('alice', { exp: Math.floor(Date.now() / 1000) + 3600 });
        win.receive({ type: 'thinger:token', token: fresh });
        await vi.advanceTimersByTimeAsync(0);
        expect(FakeSocket.instances).toHaveLength(2);
        expect(FakeSocket.last().url).toContain('authorization=' + encodeURIComponent(fresh));
    });
});

describe('project scoping', () => {
    it('adds ?project= to API calls and websockets in a project', async () => {
        const { sdk, server, init } = framed();
        server.on('GET', '/v1/users/alice/devices/d1', json({}));
        server.on('GET', '/v2/users/alice/buckets/b/data', json([]));
        await init({ project: { id: 'p1' } });
        await sdk.devices.get('d1');
        await sdk.buckets.read('b', { items: 10 });
        const [get, read] = server.apiCalls;
        expect(get!.url).toBe('/v1/users/alice/devices/d1?project=p1');
        expect(read!.url).toMatch(
            /^\/v2\/users\/alice\/buckets\/b\/data\?items=10&tz=.*&project=p1$/,
        );
        sdk.events.subscribe({ event: 'bucket_write' }, () => {});
        sdk.devices.streamResource('d1', 'temp', () => {});
        expect(FakeSocket.instances.map((s) => s.url)).toEqual([
            'wss://console.example/v2/users/alice/events?authorization=' +
                encodeURIComponent(token('alice')) +
                '&project=p1',
            'wss://console.example/v3/users/alice/devices/d1/resources?authorization=' +
                encodeURIComponent(token('alice')) +
                '&project=p1',
        ]);
    });

    it('does not scope project lists, nor calls that opt out or already carry a project', async () => {
        const { sdk, server, init } = framed();
        server.on('GET', '/v1/users/alice/projects', json([]));
        server.on('GET', '/v1/users/alice/things', json([]));
        await init({ project: { id: 'p1' } });
        await sdk.projects.list();
        await sdk.request('/v1/users/alice/things', { project: false });
        await sdk.request('/v1/users/alice/things?project=p2');
        expect(server.apiCalls.map((c) => c.url)).toEqual([
            '/v1/users/alice/projects',
            '/v1/users/alice/things',
            '/v1/users/alice/things?project=p2',
        ]);
    });

    it('uses an absolute apiBase for websockets', async () => {
        const { sdk, init } = framed();
        await init({ apiBase: 'http://api.example:8080' });
        sdk.events.subscribe({ event: 'x' }, () => {});
        expect(
            FakeSocket.last().url.startsWith('ws://api.example:8080/v2/users/alice/events'),
        ).toBe(true);
    });
});

describe('request()', () => {
    it('sends JSON bodies and parses JSON, text and empty answers', async () => {
        const { sdk, server, init } = framed();
        server.on('POST', '/a', (call) => json({ got: call.body }));
        server.on(
            'GET',
            '/text',
            new Response('hello', { headers: { 'content-type': 'text/plain' } }),
        );
        server.on('POST', '/empty', new Response('', { status: 200 }));
        server.on('DELETE', '/none', { status: 204 });
        await init();
        await expect(sdk.request('/a', { method: 'POST', body: { x: 1 } })).resolves.toEqual({
            got: { x: 1 },
        });
        await expect(sdk.request('/text')).resolves.toBe('hello');
        await expect(sdk.request('/empty', { method: 'POST', body: 'raw' })).resolves.toBeNull();
        await expect(sdk.request('/none', { method: 'DELETE' })).resolves.toBeNull();
        expect(server.apiCalls[0]!.headers['Content-Type']).toBe('application/json');
        expect(server.apiCalls[2]!.body).toBe('raw');
    });

    it('throws ThingerError with the server reason and status', async () => {
        const { sdk, server, init } = framed();
        server.on('GET', '/x', { status: 403, body: { error: { message: 'forbidden here' } } });
        server.on('GET', '/y', new Response('plain reason', { status: 500 }));
        await init();
        await expect(sdk.request('/x')).rejects.toMatchObject({
            name: 'ThingerError',
            code: 'http',
            status: 403,
            message: 'HTTP 403 forbidden here',
        });
        await expect(sdk.request('/y')).rejects.toMatchObject({ message: 'HTTP 500 plain reason' });
    });

    it('fails with no-session before init', async () => {
        const { sdk } = framed();
        await expect(sdk.devices.get('d1')).rejects.toMatchObject({ code: 'no-session' });
    });
});

describe('API paths', () => {
    it('reads the context device for device: true, and refuses it without one', async () => {
        const { sdk, server, init } = framed();
        server.on('GET', '/v3/users/alice/devices/d1/buckets/b/data', json([{ ts: 1 }]));
        await init({ context: { device: 'd1' } });
        await expect(sdk.buckets.read('b', { device: true })).resolves.toEqual([{ ts: 1 }]);
        const other = framed();
        await other.init();
        await expect(other.sdk.buckets.read('b', { device: true })).rejects.toMatchObject({
            code: 'invalid-argument',
        });
        const cb = vi.fn();
        other.sdk.buckets.subscribe('b', { device: true }, cb);
        await flush();
        expect(cb.mock.calls[0]![1]).toMatchObject({ code: 'invalid-argument' });
    });

    it('builds bucket queries', async () => {
        const { sdk, server, init } = framed();
        server.on('GET', '/v2/users/alice/buckets/b/data', json([]));
        await init();
        await sdk.buckets.read('b', {
            from: 1000,
            to: 2000,
            aggregation: '1h',
            aggregator: 'mean',
            fields: ['t', 'h'],
            groupBy: 'device',
            tags: { site: ['a', 'b'] },
            timeZone: 'Europe/Madrid',
            sort: 'asc',
        });
        const q = new URL('https://x' + server.apiCalls[0]!.url).searchParams;
        expect(Object.fromEntries(q)).toMatchObject({
            min_ts: '1000',
            max_ts: '2000',
            agg: '1h',
            agg_type: 'mean',
            fields: 't,h',
            group_by: 'device',
            tz: 'Europe/Madrid',
            sort: 'asc',
        });
        expect(q.getAll('tag_site')).toEqual(['a', 'b']);
    });

    it('pages resource lists and applies label filters', async () => {
        const { sdk, server, init } = framed();
        const all = Array.from({ length: 130 }, (_, i) => ({ device: 'd' + i }));
        server.on('GET', '/v1/users/alice/devices', (call) => {
            const q = new URL('https://x' + call.url).searchParams;
            const index = Number(q.get('index'));
            return json(all.slice(index, index + Number(q.get('count'))));
        });
        await init();
        await expect(sdk.devices.list({ labels: { zone: 'n' } })).resolves.toHaveLength(130);
        await expect(sdk.devices.list({ limit: 5, labels: ['zone'] })).resolves.toHaveLength(5);
        expect(server.apiCalls[0]!.url).toContain('labels.zone=n');
        expect(server.apiCalls.at(-1)!.url).toContain('labels=zone');
    });

    it('sets properties with PUT, creating them with POST when missing', async () => {
        const { sdk, server, init } = framed();
        server.on('PUT', '/v3/users/alice/devices/d1/properties/new', { status: 404 });
        server.on('POST', '/v3/users/alice/devices/d1/properties', (call) => json(call.body));
        server.on('DELETE', '/v3/users/alice/devices/d1/properties/gone', { status: 404 });
        await init();
        await expect(sdk.devices.setProperty('d1', 'new', 5)).resolves.toEqual({
            property: 'new',
            value: 5,
        });
        await expect(sdk.devices.deleteProperty('d1', 'gone')).resolves.toBe(true);
    });

    it('acknowledges alarms with the right state whatever the options say', async () => {
        const { sdk, server, init } = framed();
        server.on('PUT', '/v1/users/alice/alarms/instances/i1', (call) => json(call.body));
        await init();
        const body = await sdk.alarms.acknowledge('i1', { annotation: 'seen', state: 5 } as never);
        expect(body).toEqual({ annotation: 'seen', state: sdk.alarms.STATE.ACKNOWLEDGED });
    });
});
