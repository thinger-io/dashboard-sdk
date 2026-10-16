import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as sdk from '../../src/index.js';
import * as protocol from '../../src/protocol.js';
import { serverRequirements } from '../../src/compat.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('package', () => {
    it('exports the Thinger instance, idle outside a browser', () => {
        expect(sdk.Thinger).toBeInstanceOf(sdk.ThingerClient);
        expect(sdk.Thinger.user).toBeNull();
        expect(sdk.Thinger.version).toBe(pkg.version);
        expect(sdk.SDK_VERSION).toBe(pkg.version);
    });

    it('declares only functions that exist', () => {
        const client = new sdk.ThingerClient({ window: null });
        for (const name of Object.keys(serverRequirements())) {
            const parts = name.split('.');
            const method = parts.pop()!;
            const owner = parts.reduce<any>((o, p) => o?.[p], client);
            expect(typeof owner?.[method], name).toBe('function');
        }
    });

    it('keeps the protocol module free of the client', () => {
        const source = readFileSync(new URL('../../src/protocol.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/^import /m);
        expect(protocol.IFRAME_SANDBOX).toBe('allow-scripts allow-forms allow-downloads');
        expect(Object.values(protocol.MESSAGE)).toHaveLength(10);
    });

    it('starts versions at 0.x until the contract freezes', () => {
        expect(pkg.version).toMatch(/^0\./);
    });
});
