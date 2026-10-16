import { ThingerError } from './errors.js';

/**
 * Compatibility between the SDK and the server, kept in the SDK alone.
 *
 * Everything works on the base server version. A function that needs something newer declares
 * its minimum with `@requiresServer('<namespace>.<function>', '<version>')`. That declaration is
 * the only source: the build adds "Requires Thinger ≥ X" to the function's TSDoc, writes the
 * manifest `dist/compat.json`, and at run time the function fails before calling the server with
 * `err.code === 'unsupported'` when the server is older. SDK-only logic declares nothing.
 */

/** Oldest server the SDK supports: everything without a declaration works there. */
export const BASE_SERVER_VERSION = '7.5';

type Version = [number, number, number];

/**
 * Numeric part of a server version: "7.5.2" → [7, 5, 2]. Develop builds report things like
 * "7.3.4-144-g9b2ac16f-develop", of which only "7.3.4" counts. Null when there is none.
 */
export function parseServerVersion(value: unknown): Version | null {
    if (typeof value !== 'string') return null;
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim());
    if (!m) return null;
    return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), m[3] ? parseInt(m[3], 10) : 0];
}

/** <0, 0 or >0 as `a` is older, the same or newer than `b`. */
export function compareVersions(a: Version, b: Version): number {
    for (let i = 0; i < 3; i++) {
        if (a[i]! !== b[i]!) return a[i]! - b[i]!;
    }
    return 0;
}

/** Declared minimum server version of each function, by name ('devices.list'). */
const requirements = new Map<string, string>();

/** The declared requirements: function name → minimum server version, sorted by name. */
export function serverRequirements(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of [...requirements.keys()].sort()) out[name] = requirements.get(name)!;
    return out;
}

/** What `@requiresServer` needs from the object a method runs on. */
interface CompatHost {
    readonly compat?: Compat;
    readonly sdk?: { readonly compat: Compat };
}

function compatOf(host: CompatHost): Compat | undefined {
    return host.compat ?? host.sdk?.compat;
}

function isAsync(fn: unknown): boolean {
    return Object.prototype.toString.call(fn) === '[object AsyncFunction]';
}

/**
 * Declare that a function needs server `version` or later. `name` is its public path from the
 * SDK root ('devices.list', 'alarms.rules.get', or 'navigate' for the root). Use it on `async`
 * methods (the check rejects) or on methods that return synchronously (the check throws).
 */
export function requiresServer(name: string, version: string) {
    if (!parseServerVersion(version)) throw new Error('requiresServer: invalid version ' + version);
    if (requirements.has(name)) throw new Error('requiresServer: ' + name + ' declared twice');
    requirements.set(name, version);
    return function <This, Args extends unknown[], Return>(
        method: (this: This, ...args: Args) => Return,
        _context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
    ): (this: This, ...args: Args) => Return {
        const asyncMethod = isAsync(method);
        return function (this: This, ...args: Args): Return {
            const compat = compatOf(this as CompatHost);
            const refused = compat ? compat.check(name) : null;
            if (refused) {
                if (asyncMethod) return Promise.reject(refused) as Return;
                throw refused;
            }
            const result = method.apply(this, args);
            // version unknown: a 404 from this function means the server does not have it
            if (compat && compat.serverVersion === null && result instanceof Promise) {
                return result.catch((err: unknown) => {
                    if ((err as { status?: unknown } | null)?.status === 404) {
                        throw unsupportedError(name, version, null, err);
                    }
                    throw err;
                }) as Return;
            }
            return result;
        };
    };
}

function unsupportedError(
    name: string,
    version: string,
    server: string | null,
    cause?: unknown,
): ThingerError {
    return new ThingerError(
        name +
            ' requires Thinger ≥ ' +
            version +
            (server ? ' (this server is ' + server + ')' : ''),
        { code: 'unsupported', requires: version, cause },
    );
}

/** The server version as one client sees it, read once from `GET /v1/server/version`. */
export class Compat {
    private raw: string | null = null;
    private parsed: Version | null = null;
    private loading: Promise<void> | null = null;

    /** Server version as reported, or null while unknown or unreadable. */
    get serverVersion(): string | null {
        return this.parsed ? this.raw : null;
    }

    /**
     * Read the server version once (later calls return the same promise). Never rejects:
     * an unreadable version leaves `serverVersion` null. Warns once below the base version.
     */
    load(read: () => Promise<unknown>, warn: (message: string) => void): Promise<void> {
        if (!this.loading) {
            this.loading = read().then(
                (value) => this.set(value, warn),
                () => undefined,
            );
        }
        return this.loading;
    }

    /** Set the version directly (tests, or a host that already knows it). */
    set(value: unknown, warn?: (message: string) => void): void {
        const parsed = parseServerVersion(value);
        this.raw = parsed ? String(value) : null;
        this.parsed = parsed;
        const base = parseServerVersion(BASE_SERVER_VERSION)!;
        if (parsed && warn && compareVersions(parsed, base) < 0) {
            warn(
                '[Thinger] this server is ' +
                    String(value) +
                    ', older than Thinger ' +
                    BASE_SERVER_VERSION +
                    ', the oldest this SDK supports: some calls may fail',
            );
        }
    }

    /** Is a declared function available? Undeclared names are base functions: true. */
    available(name: string): boolean {
        return this.check(name) === null;
    }

    /** The error a declared function fails with on this server, or null when it can run. */
    check(name: string): ThingerError | null {
        const version = requirements.get(name);
        if (!version || !this.parsed) return null;
        if (compareVersions(this.parsed, parseServerVersion(version)!) >= 0) return null;
        return unsupportedError(name, version, this.raw);
    }
}
