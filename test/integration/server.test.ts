/**
 * Integration tests against a real server, the SDK running standalone as an app on a dev server
 * would (thinger_api + thinger_token). Opt-in:
 *
 *     THINGER_SERVER=https://host THINGER_TOKEN=<access token> npm run test:integration
 *
 * Without both variables every test is skipped. The writes create resources named sdk_it_<random>
 * (an HTTP device and an API bucket) and delete them at the end. Self-signed certificates:
 * NODE_TLS_REJECT_UNAUTHORIZED=0.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ThingerClient } from '../../src/client.js';
import { compareVersions, parseServerVersion } from '../../src/compat.js';
import { standaloneFragment } from '../../src/protocol.js';
import { FakeWindow } from '../unit/harness.js';

const SERVER = process.env['THINGER_SERVER']?.replace(/\/+$/, '');
const TOKEN = process.env['THINGER_TOKEN'];
const enabled = !!(SERVER && TOKEN);

/**
 * True when the server meets `version`. Tests of a function declared with
 * @requiresServer('<name>', version) run only then: `it.runIf(() => atLeast(sdk, '7.6'))` does not
 * work (conditions are read before beforeAll), so check inside the test and return early.
 */
export function atLeast(sdk: ThingerClient, version: string): boolean {
    const server = parseServerVersion(sdk.serverVersion);
    return !!server && compareVersions(server, parseServerVersion(version)!) >= 0;
}

function client(): ThingerClient {
    const href =
        'http://localhost:5173/#' + standaloneFragment({ token: TOKEN!, api: SERVER! }, '/');
    return new ThingerClient({
        window: new FakeWindow(href) as unknown as Window,
        fetch: globalThis.fetch.bind(globalThis),
        WebSocket: globalThis.WebSocket,
    });
}

describe.skipIf(!enabled)('against ' + (SERVER ?? 'a real server'), () => {
    const id = 'sdk_it_' + Math.random().toString(36).slice(2, 10);
    let sdk: ThingerClient;
    let user: string;

    beforeAll(async () => {
        sdk = client();
        await sdk.ready();
        user = sdk.user!.id;
    });

    afterAll(async () => {
        if (!sdk) return;
        for (const path of [
            '/v1/users/' + user + '/devices/' + id,
            '/v1/users/' + user + '/buckets/' + id,
        ]) {
            await sdk.request(path, { method: 'DELETE' }).catch(() => undefined);
        }
    });

    it('reads the server version and the session from the token', () => {
        expect(user).toMatch(/^[\w-]+$/);
        expect(parseServerVersion(sdk.serverVersion)).not.toBeNull();
        expect(sdk.supports('devices.list')).toBe(true);
    });

    it('lists resources across pages', async () => {
        const devices = await sdk.devices.list({ limit: 150 });
        expect(Array.isArray(devices)).toBe(true);
        expect(devices.length).toBeLessThanOrEqual(150);
        expect(Array.isArray(await sdk.resources.list('bucket', { limit: 5 }))).toBe(true);
        expect(Array.isArray(await sdk.projects.list())).toBe(true);
    });

    it('fails with the server reason and status', async () => {
        const err = await sdk.devices.get(id + '_missing').catch((e: unknown) => e);
        expect(err).toMatchObject({ name: 'ThingerError', code: 'http', status: 404 });
    });

    it('creates, reads and deletes device properties', async () => {
        await sdk.request('/v1/users/' + user + '/devices', {
            method: 'POST',
            body: { device: id, type: 'HTTP', name: 'SDK integration test', enabled: true },
        });
        await sdk.devices.setProperty(id, 'settings', { threshold: 3 });
        await sdk.devices.setProperty(id, 'settings', { threshold: 4 });
        const prop = await sdk.devices.getProperty<{ threshold: number }>(id, 'settings');
        expect(prop.value).toEqual({ threshold: 4 });
        const list = await sdk.devices.listProperties(id);
        expect(list.map((p) => p.property)).toContain('settings');
        await expect(sdk.devices.deleteProperty(id, 'settings')).resolves.toBe(true);
    });

    it('writes a bucket, reads it back and receives the write live', async () => {
        await sdk.request('/v1/users/' + user + '/buckets', {
            method: 'POST',
            body: {
                bucket: id,
                name: 'SDK integration test',
                enabled: true,
                config: { source: 'api' },
            },
        });
        await sdk.buckets.write(id, { value: 1 });

        const updates: number[][] = [];
        const live = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no live update in 15 s')), 15000);
            const off = sdk.buckets.subscribe<{ ts: number; value: number }>(
                id,
                { items: 10, debounceMs: 100 },
                (data, err) => {
                    if (err) return reject(err);
                    updates.push(data!.map((r) => r.value));
                    if (updates.length === 1) {
                        // the socket registers right after the first read: give it a moment
                        setTimeout(() => void sdk.buckets.write(id, { value: 2 }), 1000);
                    } else if (data!.some((r) => r.value === 2)) {
                        clearTimeout(timer);
                        off();
                        resolve();
                    }
                },
            );
        });
        await live;
        expect(updates[0]).toEqual([1]);
        expect(updates.at(-1)).toEqual([2, 1]);
        const read = await sdk.buckets.read<{ value: number }>(id, { sort: 'asc' });
        expect(read.map((r) => r.value)).toEqual([1, 2]);
    });
});

describe.skipIf(enabled)('integration', () => {
    it('is skipped: set THINGER_SERVER and THINGER_TOKEN to run it', () => {});
});
