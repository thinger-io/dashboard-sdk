import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThingerClient } from '../../src/client.js';
import { MAX_ERROR_LENGTH, MAX_ERROR_MESSAGES } from '../../src/protocol.js';
import { SDK_VERSION } from '../../src/version.js';
import { FakeParent, FakeWindow, flush, framed, json, token } from './harness.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('console handshake', () => {
    it('posts thinger:ready with the SDK version as soon as it starts', () => {
        const { parent } = framed();
        expect(parent.messages[0]).toEqual({ type: 'thinger:ready', sdk: SDK_VERSION });
        expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('takes credentials and context from thinger:init and resolves ready()', async () => {
        const { sdk, init } = framed();
        const ready = await init({
            apiBase: 'https://api.example',
            apiHost: 'https://api.example',
            project: { id: 'p1', owner: 'bob', name: 'Plant' },
            context: { device: 'd1', project: 'p1' },
        });
        expect(ready).toBe(sdk);
        expect(sdk.apiBase).toBe('https://api.example');
        expect(sdk.apiHost).toBe('https://api.example');
        expect(sdk.user).toEqual({ id: 'alice' });
        expect(sdk.token).toBe(token('alice'));
        expect(sdk.project).toEqual({ id: 'p1', owner: 'bob', name: 'Plant' });
        expect(sdk.context).toEqual({ device: 'd1', project: 'p1' });
        expect(sdk.dashboard).toEqual({ id: 'dash' });
    });

    it('treats missing init fields as empty (the console may send fewer)', async () => {
        const { sdk, win } = framed();
        win.receive({ type: 'thinger:init', user: { id: 'alice' }, futureField: 1 });
        await sdk.ready();
        expect(sdk.apiBase).toBe('');
        expect(sdk.token).toBeNull();
        expect(sdk.project).toBeNull();
        expect(sdk.context).toEqual({});
    });

    it('ignores messages that do not come from the parent window', async () => {
        const { sdk, win } = framed();
        const intruder = new FakeParent();
        win.receive({ type: 'thinger:init', token: 'evil', user: { id: 'mallory' } }, intruder);
        await flush();
        expect(sdk.user).toBeNull();
        win.receive({ type: 'thinger:init', token: token('alice'), user: { id: 'alice' } });
        await sdk.ready();
        win.receive({ type: 'thinger:token', token: 'evil' }, intruder);
        expect(sdk.token).toBe(token('alice'));
    });

    it('ignores unknown messages and fields', async () => {
        const { sdk, win, init } = framed();
        win.receive({ type: 'thinger:something-new', x: 1 });
        win.receive('not an object');
        win.receive(null);
        await init();
        expect(sdk.user).toEqual({ id: 'alice' });
    });

    it('calls onInit listeners on init, and at once when already initialized', async () => {
        const { sdk, init } = framed();
        const before = vi.fn();
        sdk.onInit(before);
        await init();
        expect(before).toHaveBeenCalledWith(sdk);
        const after = vi.fn();
        sdk.onInit(after);
        expect(after).toHaveBeenCalledTimes(1);
    });

    it('rejects ready() when opened on its own without a token', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const win = new FakeWindow('https://server.example/app/');
        const sdk = new ThingerClient({ window: win as unknown as Window, fetch: vi.fn() });
        await expect(sdk.ready()).rejects.toMatchObject({ code: 'no-session' });
    });

    it('stays idle without a window (server-side rendering)', () => {
        const sdk = new ThingerClient({ window: null, fetch: vi.fn() });
        expect(sdk.user).toBeNull();
        expect(() => sdk.navigate('/x')).not.toThrow();
    });
});

describe('location and route', () => {
    it('reports the hash route, initially and on pushState / hashchange', async () => {
        const { win, parent } = framed('https://console.example/app/#/devices');
        await flush();
        expect(parent.of('thinger:location')).toEqual([
            { type: 'thinger:location', path: '/devices' },
        ]);
        win.history.pushState(null, '', '#/devices/d1');
        win.location.hash = '#/alarms';
        win.location.hash = '#/alarms'; // unchanged: not reported again
        expect(parent.of('thinger:location').map((m) => m.path)).toEqual([
            '/devices',
            '/devices/d1',
            '/alarms',
        ]);
    });

    it('moves to the route the console sends', async () => {
        const { win, init } = framed();
        await init();
        win.receive({ type: 'thinger:route', path: '/devices/d2' });
        expect(win.location.hash).toBe('#/devices/d2');
    });
});

describe('navigate and files', () => {
    it('asks the console to navigate', async () => {
        const { sdk, parent, init } = framed();
        await init();
        sdk.navigate({ device: 'd1' });
        sdk.navigate('/console/dashboards');
        expect(parent.of('thinger:navigate')).toEqual([
            { type: 'thinger:navigate', target: { device: 'd1' } },
            { type: 'thinger:navigate', target: '/console/dashboards' },
        ]);
    });

    it('opens storage files through the console', async () => {
        const { sdk, parent, init } = framed();
        await init();
        await sdk.storages.open('docs', 'manuals/a.pdf');
        expect(parent.of('thinger:open-file')).toEqual([
            { type: 'thinger:open-file', storage: 'docs', path: 'manuals/a.pdf' },
        ]);
    });
});

describe('error forwarding', () => {
    it('copies console.error, uncaught errors and rejections to the console', () => {
        const { win, parent } = framed();
        win.console.error('boom', { a: 1 });
        win.dispatch('error', { error: new Error('uncaught'), message: 'uncaught' });
        win.dispatch('unhandledrejection', { reason: 'nope' });
        const messages = parent.of('thinger:error').map((m) => m.message);
        expect(messages[0]).toBe('boom {"a":1}');
        expect(messages[1]).toContain('uncaught');
        expect(messages[2]).toBe('Unhandled rejection: nope');
    });

    it('caps the number and length of forwarded errors', () => {
        const { win, parent } = framed();
        for (let i = 0; i < MAX_ERROR_MESSAGES + 20; i++) win.console.error('x'.repeat(5000));
        const sent = parent.of('thinger:error');
        expect(sent).toHaveLength(MAX_ERROR_MESSAGES);
        expect(sent[0].message).toHaveLength(MAX_ERROR_LENGTH);
    });
});

describe('ready() and the server version', () => {
    it('waits for the server version before resolving', async () => {
        const { sdk, server, init } = framed();
        server.version = '7.6.1';
        await init({ apiBase: 'https://api.example' });
        expect(sdk.serverVersion).toBe('7.6.1');
        const versionCall = server.calls.find((c) => c.url.endsWith('/v1/server/version'))!;
        expect(versionCall.url).toBe('https://api.example/v1/server/version');
        // public endpoint: no token, no project
        expect(versionCall.headers?.['Authorization']).toBeUndefined();
    });

    it('does not wait forever for a server that does not answer', async () => {
        const { sdk, server, win } = framed(undefined, { versionTimeoutMs: 50 });
        server.fetch.mockImplementation(() => new Promise<Response>(() => {}));
        win.receive({ type: 'thinger:init', token: token('alice'), user: { id: 'alice' } });
        await sdk.ready();
        expect(sdk.serverVersion).toBeNull();
    });

    it('reads the version once', async () => {
        const { server, init, win } = framed();
        await init();
        win.receive({ type: 'thinger:init', token: token('alice'), user: { id: 'alice' } });
        await flush();
        expect(server.calls.filter((c) => c.url.endsWith('/v1/server/version'))).toHaveLength(1);
    });

    it('warns once when the server is older than the base version', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { server, init } = framed();
        server.version = '7.3.4-144-g9b2ac16f-develop';
        await init();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain('7.3.4-144-g9b2ac16f-develop');
    });

    it('serves the version from apiBase in a request the app can also make', async () => {
        const { sdk, server, init } = framed();
        server.on('GET', '/v1/users/alice/devices/d1', json({ device: 'd1' }));
        await init();
        await expect(sdk.devices.get('d1')).resolves.toEqual({ device: 'd1' });
    });
});
