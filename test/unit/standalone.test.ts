import { afterEach, describe, expect, it, vi } from 'vitest';
import { standaloneFragment } from '../../src/protocol.js';
import { FakeParent, FakeServer, flush, json, standalone, token } from './harness.js';

afterEach(() => vi.restoreAllMocks());

const APP = 'https://server.example/v1/users/alice/storages/app/files/';

describe('standalone links', () => {
    it('reads the thinger_* params, clears them from the address bar and keeps the route', async () => {
        const t = token('alice');
        const href =
            APP +
            '#/devices/d1&thinger_token=' +
            t +
            '&thinger_project=p1&thinger_device=d1&thinger_product=pr&thinger_type=ty&thinger_group=gr';
        const { win, sdk, parent } = { ...standalone(href), parent: undefined };
        await sdk.ready();
        expect(parent).toBeUndefined();
        expect(sdk.token).toBe(t);
        expect(sdk.user).toEqual({ id: 'alice' });
        expect(sdk.project).toEqual({ id: 'p1' });
        expect(sdk.context).toEqual({
            device: 'd1',
            product: 'pr',
            type: 'ty',
            group: 'gr',
            project: 'p1',
        });
        expect(sdk.apiBase).toBe('');
        expect(win.location.hash).toBe('#/devices/d1');
    });

    it('accepts the fragment standaloneFragment() builds', async () => {
        const t = token('alice');
        const href =
            APP +
            '#' +
            standaloneFragment(
                { token: t, api: 'https://api.example:8443/', project: 'p 1' },
                '/x',
            );
        const { sdk, win } = standalone(href);
        await sdk.ready();
        expect(sdk.apiBase).toBe('https://api.example:8443');
        expect(sdk.project).toEqual({ id: 'p 1' });
        expect(win.location.hash).toBe('#/x');
    });

    it('sends API calls and the version request to thinger_api', async () => {
        const server = new FakeServer();
        server.on('GET', '/v1/users/alice/devices/d1', json({ device: 'd1' }));
        const { sdk } = standalone(
            APP.replace('server.example', 'localhost:4200') +
                '#thinger_token=' +
                token('alice') +
                '&thinger_api=' +
                encodeURIComponent('https://api.example'),
            { server },
        );
        await sdk.ready();
        await sdk.devices.get('d1');
        expect(server.calls.map((c) => c.url)).toEqual([
            'https://api.example/v1/server/version',
            'https://api.example/v1/users/alice/devices/d1',
        ]);
        expect(server.calls[1]!.headers['Authorization']).toBe('Bearer ' + token('alice'));
    });

    it('ignores a thinger_api that is not a server address', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { sdk } = standalone(
            APP + '#thinger_token=' + token() + '&thinger_api=javascript%3Aalert(1)',
        );
        await sdk.ready();
        expect(sdk.apiBase).toBe('');
        expect(error).toHaveBeenCalledWith(expect.stringContaining('thinger_api'));
    });

    it('keeps the session in sessionStorage across reloads of the tab', async () => {
        const storage = new Map<string, string>();
        const first = standalone(
            APP + '#/a&thinger_token=' + token('alice') + '&thinger_project=p1',
            { storage },
        );
        await first.sdk.ready();
        const reload = standalone(APP + '#/a', { storage });
        await reload.sdk.ready();
        expect(reload.sdk.user).toEqual({ id: 'alice' });
        expect(reload.sdk.project).toEqual({ id: 'p1' });
    });

    it('does not run standalone with a token that is not a JWT', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { sdk } = standalone(APP + '#thinger_token=garbage');
        await expect(sdk.ready()).rejects.toMatchObject({ code: 'no-session' });
    });

    it('says once that an expired link will fail', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { sdk } = standalone(APP + '#thinger_token=' + token('alice', { exp: 1000 }));
        await sdk.ready();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('expired'));
    });

    it('does not talk to the console: no ready, no refresh on 401', async () => {
        const parent = new FakeParent();
        const server = new FakeServer();
        server.on('GET', '/v1/users/alice/devices/d1', {
            status: 401,
            body: { error: { message: 'expired' } },
        });
        const { sdk } = standalone(APP + '#thinger_token=' + token('alice'), { parent, server });
        await sdk.ready();
        await expect(sdk.devices.get('d1')).rejects.toMatchObject({
            status: 401,
            message: 'HTTP 401 expired',
        });
        expect(parent.messages).toEqual([]);
    });

    it('tells a website that embeds it when the first call succeeded, once', async () => {
        const parent = new FakeParent();
        const server = new FakeServer();
        server.on('GET', '/v1/users/alice/devices', json([]));
        const { sdk } = standalone(APP + '#thinger_token=' + token('alice'), { parent, server });
        await sdk.ready();
        await sdk.request('/v1/users/alice/devices');
        await sdk.request('/v1/users/alice/devices');
        expect(parent.messages).toEqual([{ type: 'thinger:dashboard-ready' }]);
    });

    it('navigates by itself', async () => {
        const { sdk, win } = standalone(APP + '#thinger_token=' + token());
        await sdk.ready();
        sdk.navigate({ url: 'https://example.com/' });
        sdk.navigate({ device: 'd1' });
        expect(win.location.assign).toHaveBeenCalledTimes(1);
        expect(win.location.assign).toHaveBeenCalledWith('https://example.com/');
    });
});

describe('protocol helpers', () => {
    it('builds fragments with encoded values and no empty parts', () => {
        expect(standaloneFragment({ token: 'a.b.c', project: '' })).toBe('thinger_token=a.b.c');
        expect(standaloneFragment({ token: 't', api: 'https://h:1' }, '/r')).toBe(
            '/r&thinger_token=t&thinger_api=https%3A%2F%2Fh%3A1',
        );
    });

    it('flushes cleanly', async () => {
        await flush();
    });
});
