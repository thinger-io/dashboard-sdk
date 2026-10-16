import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BASE_SERVER_VERSION,
    Compat,
    compareVersions,
    parseServerVersion,
    requiresServer,
    serverRequirements,
} from '../../src/compat.js';
import type { ThingerClient } from '../../src/client.js';
// @ts-expect-error -- plain JS build helper
import { annotateDeclaration } from '../../scripts/compat-docs.mjs';
import { framed, json } from './harness.js';

afterEach(() => vi.restoreAllMocks());

describe('server versions', () => {
    it('parses releases and develop builds by their numeric part', () => {
        expect(parseServerVersion('7.5.0')).toEqual([7, 5, 0]);
        expect(parseServerVersion('7.5')).toEqual([7, 5, 0]);
        expect(parseServerVersion('v7.6.2')).toEqual([7, 6, 2]);
        expect(parseServerVersion('7.3.4-144-g9b2ac16f-develop')).toEqual([7, 3, 4]);
        expect(parseServerVersion('Development')).toBeNull();
        expect(parseServerVersion('')).toBeNull();
        expect(parseServerVersion(undefined)).toBeNull();
    });

    it('compares numerically', () => {
        expect(compareVersions([7, 10, 0], [7, 9, 9])).toBeGreaterThan(0);
        expect(compareVersions([7, 5, 0], [7, 5, 0])).toBe(0);
        expect(compareVersions([7, 4, 99], [7, 5, 0])).toBeLessThan(0);
    });

    it('declares 7.5 as the base', () => {
        expect(BASE_SERVER_VERSION).toBe('7.5');
    });

    it('warns below the base version only', () => {
        for (const [version, warns] of [
            ['7.4.9', true],
            ['7.3.4-144-g9b2ac16f-develop', true],
            ['7.5.0', false],
            ['8.0.0', false],
            ['Development', false],
        ] as const) {
            const warn = vi.fn();
            new Compat().set(version, warn);
            expect(warn).toHaveBeenCalledTimes(warns ? 1 : 0);
        }
    });

    it('loads once and never rejects', async () => {
        const compat = new Compat();
        const read = vi.fn().mockRejectedValue(new Error('offline'));
        await compat.load(read, () => {});
        await compat.load(read, () => {});
        expect(read).toHaveBeenCalledTimes(1);
        expect(compat.serverVersion).toBeNull();
    });
});

// A class with declared functions, as an API class of the SDK would have them.
class Gadgets {
    constructor(private readonly sdk: ThingerClient) {}

    @requiresServer('gadgets.list', '7.6')
    async list(): Promise<unknown> {
        return this.sdk.request('/v1/users/alice/gadgets');
    }

    @requiresServer('gadgets.watch', '7.6.2', 'value')
    watch(cb: () => void): () => void {
        cb();
        return () => {};
    }

    // as a bundler that compiles async away (Angular with zone.js) leaves an async method
    @requiresServer('gadgets.compiled', '7.6')
    compiled(): Promise<unknown> {
        return this.sdk.request('/v1/users/alice/gadgets');
    }

    async base(): Promise<unknown> {
        return this.sdk.request('/v1/users/alice/gadgets/base');
    }
}

describe('declared functions', () => {
    it('are listed with their minimum version', () => {
        expect(serverRequirements()).toMatchObject({
            'gadgets.list': '7.6',
            'gadgets.watch': '7.6.2',
        });
    });

    it('refuse a second declaration of the same name or a bad version', () => {
        expect(() => requiresServer('gadgets.list', '7.7')).toThrow(/twice/);
        expect(() => requiresServer('gadgets.other', 'next')).toThrow(/invalid version/);
    });

    it('fail before calling the server when it is older', async () => {
        const { sdk, server, init } = framed();
        server.version = '7.5.3';
        server.on('GET', '/v1/users/alice/gadgets', json([]));
        await init();
        const gadgets = new Gadgets(sdk);
        const err = await gadgets.list().catch((e: unknown) => e);
        expect(err).toMatchObject({
            name: 'ThingerError',
            code: 'unsupported',
            requires: '7.6',
            message: 'gadgets.list requires Thinger ≥ 7.6 (this server is 7.5.3)',
        });
        expect(() => gadgets.watch(() => {})).toThrow(/requires Thinger ≥ 7.6.2/);
        // a promise-returning method rejects, never throws, however it was compiled
        let thrown = false;
        let rejected: unknown;
        try {
            await gadgets.compiled().catch((e: unknown) => (rejected = e));
        } catch {
            thrown = true;
        }
        expect(thrown).toBe(false);
        expect(rejected).toMatchObject({ code: 'unsupported' });
        expect(server.apiCalls).toEqual([]);
    });

    it('run when the server is new enough', async () => {
        const { sdk, server, init } = framed();
        server.version = '7.6.2-3-gabc-develop';
        server.on('GET', '/v1/users/alice/gadgets', json(['g']));
        await init();
        const gadgets = new Gadgets(sdk);
        await expect(gadgets.list()).resolves.toEqual(['g']);
        const cb = vi.fn();
        gadgets.watch(cb);
        expect(cb).toHaveBeenCalled();
    });

    it('turn a 404 into unsupported when the version could not be read', async () => {
        const { sdk, server, init } = framed();
        server.version = null;
        await init();
        expect(sdk.serverVersion).toBeNull();
        const gadgets = new Gadgets(sdk);
        await expect(gadgets.list()).rejects.toMatchObject({
            code: 'unsupported',
            message: 'gadgets.list requires Thinger ≥ 7.6',
        });
        // undeclared functions keep their 404
        await expect(gadgets.base()).rejects.toMatchObject({ code: 'http', status: 404 });
    });

    it('keep a 404 as such while the version is still loading', async () => {
        const { sdk, server, win } = framed(undefined, { versionTimeoutMs: 10 });
        let answer!: (r: Response) => void;
        server.fetch.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
        win.receive({ type: 'thinger:init', token: 't', user: { id: 'alice' } });
        await sdk.ready();
        await expect(new Gadgets(sdk).list()).rejects.toMatchObject({ code: 'http', status: 404 });
        answer(json({ version: '7.6.0' }));
    });

    it('keep a 404 as such when the version is known', async () => {
        const { sdk, server, init } = framed();
        server.version = '7.7.0';
        await init();
        await expect(new Gadgets(sdk).list()).rejects.toMatchObject({ code: 'http', status: 404 });
    });
});

describe('Thinger.supports()', () => {
    it('answers for SDK functions and false for unknown names', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { sdk, init } = framed();
        await init();
        expect(sdk.supports('devices.list')).toBe(true);
        expect(sdk.supports('alarms.rules.get')).toBe(true);
        expect(sdk.supports('navigate')).toBe(true);
        expect(sdk.supports('devices.lst')).toBe(false);
        expect(sdk.supports('token')).toBe(false);
        expect(sdk.supports('devices.lst')).toBe(false);
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('answers false for a declared function the server lacks', async () => {
        const { sdk, server, init } = framed();
        server.version = '7.5.0';
        await init();
        // mount the test class where supports() looks for it
        (sdk as unknown as Record<string, unknown>)['gadgets'] = new Gadgets(sdk);
        expect(sdk.supports('gadgets.list')).toBe(false);
        expect(sdk.supports('gadgets.base')).toBe(true);
    });
});

describe('TSDoc from the declarations', () => {
    const dts = [
        'export declare class Gadgets {',
        '    private readonly sdk;',
        '    /** All gadgets. */',
        '    list(): Promise<unknown>;',
        '    /**',
        '     * Watch them.',
        '     */',
        '    watch(cb: () => void): () => void;',
        '    watch(opts: {}, cb: () => void): () => void;',
        '}',
        '',
    ].join('\n');

    it('adds "Requires Thinger ≥ X" to every signature', () => {
        const list = annotateDeclaration(dts, 'Gadgets', 'list', '7.6');
        expect(list).toContain(
            [
                '    /**',
                '     * All gadgets.',
                '     *',
                '     * Requires Thinger ≥ 7.6.',
                '     * @since Thinger 7.6',
                '     */',
                '    list(): Promise<unknown>;',
            ].join('\n'),
        );
        const watch = annotateDeclaration(dts, 'Gadgets', 'watch', '7.6.2');
        expect(watch.match(/Requires Thinger ≥ 7\.6\.2\./g)).toHaveLength(2);
        expect(watch).toContain(
            ['     * Watch them.', '     *', '     * Requires Thinger ≥ 7.6.2.'].join('\n'),
        );
        expect(watch).toContain(
            [
                '    /**',
                '     * Requires Thinger ≥ 7.6.2.',
                '     * @since Thinger 7.6.2',
                '     */',
                '    watch(opts',
            ].join('\n'),
        );
    });

    it('is idempotent, and null for other files', () => {
        const once = annotateDeclaration(dts, 'Gadgets', 'list', '7.6');
        expect(annotateDeclaration(once, 'Gadgets', 'list', '7.6')).toBe(once);
        expect(annotateDeclaration(dts, 'Other', 'list', '7.6')).toBeNull();
        expect(() => annotateDeclaration(dts, 'Gadgets', 'nope', '7.6')).toThrow();
    });
});
