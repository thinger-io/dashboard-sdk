/**
 * A fake browser for the unit tests: a window (location, history, sessionStorage, events, a
 * parent that records postMessage), a scripted fetch, and WebSockets the test drives.
 */
import { vi } from 'vitest';
import { ThingerClient, type ClientOptions } from '../../src/client.js';

type Listener = (ev: any) => void;

export class FakeEventTarget {
    private listeners = new Map<string, Set<Listener>>();
    addEventListener(type: string, fn: Listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(fn);
    }
    removeEventListener(type: string, fn: Listener) {
        this.listeners.get(type)?.delete(fn);
    }
    dispatch(type: string, ev: any = {}) {
        for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
    }
}

/** A parent window: records what the app posts to it. */
export class FakeParent {
    readonly messages: any[] = [];
    postMessage(message: any) {
        this.messages.push(structuredClone(message));
    }
    of(type: string) {
        return this.messages.filter((m) => m.type === type);
    }
}

export class FakeWindow extends FakeEventTarget {
    parent: any;
    readonly sessionStorage: Storage;
    readonly console = {
        error: vi.fn(),
        warn: vi.fn(),
        log: vi.fn(),
    } as unknown as Console;
    readonly opened: string[] = [];
    private url: URL;
    private historyState: unknown = null;
    readonly history: History;
    readonly location: any;

    constructor(href: string, opts: { parent?: FakeParent; storage?: Map<string, string> } = {}) {
        super();
        this.url = new URL(href);
        this.parent = opts.parent ?? this;
        const store = opts.storage ?? new Map<string, string>();
        this.sessionStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
            key: () => null,
            length: 0,
        } as Storage;
        const self = this;
        this.location = {
            get href() {
                return self.url.href;
            },
            get origin() {
                return self.url.origin;
            },
            get pathname() {
                return self.url.pathname;
            },
            get search() {
                return self.url.search;
            },
            get hash() {
                return self.url.hash;
            },
            set hash(value: string) {
                const before = self.url.hash;
                self.url.hash = value;
                if (self.url.hash !== before) self.dispatch('hashchange', {});
            },
            assign: vi.fn(),
        };
        this.history = {
            get state() {
                return self.historyState;
            },
            pushState(state: unknown, _title: string, url?: string | URL | null) {
                self.historyState = state;
                if (url != null) self.url = new URL(String(url), self.url);
            },
            replaceState(state: unknown, _title: string, url?: string | URL | null) {
                self.historyState = state;
                if (url != null) self.url = new URL(String(url), self.url);
            },
        } as unknown as History;
    }

    atob(data: string) {
        return Buffer.from(data, 'base64').toString('binary');
    }

    open(url: string) {
        this.opened.push(url);
        return null;
    }

    /** A message from `source` (the parent by default). */
    receive(data: any, source: any = this.parent) {
        this.dispatch('message', { data, source });
    }
}

/** A JWT-shaped token (unsigned) for `user`. */
export function token(user = 'alice', claims: Record<string, unknown> = {}): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ usr: user, ...claims }) + '.sig';
}

export interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

type Reply = Response | { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (call: Call) => Reply | Promise<Reply>;

/** A scripted server: `on(method, pathPattern, handler)`; unmatched calls answer 404. */
export class FakeServer {
    readonly calls: Call[] = [];
    private routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
    version: string | null = '7.5.0';

    on(method: string, pattern: string | RegExp, handler: Handler | Reply) {
        const re =
            typeof pattern === 'string' ? new RegExp('^' + escape(pattern) + '(\\?|$)') : pattern;
        this.routes.unshift({
            method,
            pattern: re,
            handler: typeof handler === 'function' ? handler : () => handler,
        });
        return this;
    }

    /** Calls other than the server version. */
    get apiCalls() {
        return this.calls.filter((c) => !c.url.includes('/v1/server/version'));
    }

    readonly fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
        let body: unknown = init.body;
        if (typeof body === 'string' && /json/.test(headers['Content-Type'] ?? ''))
            body = JSON.parse(body);
        const call: Call = { url, method: init.method ?? 'GET', headers, body };
        this.calls.push(call);
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        if (call.method === 'GET' && path.startsWith('/v1/server/version')) {
            if (this.version === null) return new Response('', { status: 404 });
            return json({ version: this.version });
        }
        for (const r of this.routes) {
            if (r.method === call.method && r.pattern.test(path))
                return toResponse(await r.handler(call));
        }
        return new Response(JSON.stringify({ error: { message: 'not found' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
        });
    });
}

function escape(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function toResponse(reply: Reply): Response {
    if (reply instanceof Response) return reply.clone();
    if (reply.status === 204) return new Response(null, { status: 204 });
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json', ...reply.headers },
    });
}

/** WebSockets the test opens, feeds and closes. */
export class FakeSocket extends FakeEventTarget {
    static instances: FakeSocket[] = [];
    readyState = 0;
    readonly sent: any[] = [];
    constructor(readonly url: string) {
        super();
        FakeSocket.instances.push(this);
    }
    send(data: string) {
        if (this.readyState !== 1) throw new Error('not open');
        this.sent.push(JSON.parse(data));
    }
    close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatch('close', {});
    }
    open() {
        this.readyState = 1;
        this.dispatch('open', {});
    }
    receive(data: unknown) {
        this.dispatch('message', { data: JSON.stringify(data) });
    }
    static reset() {
        FakeSocket.instances = [];
    }
    static last() {
        return FakeSocket.instances[FakeSocket.instances.length - 1]!;
    }
}

export interface Setup {
    win: FakeWindow;
    parent: FakeParent;
    server: FakeServer;
    sdk: ThingerClient;
}

/** An app inside the console's frame. Call `init()` to answer its `thinger:ready`. */
export function framed(
    href = 'https://console.example/v1/users/alice/storages/app/files/',
    opts: Partial<ClientOptions> = {},
) {
    const parent = new FakeParent();
    const win = new FakeWindow(href, { parent });
    const server = new FakeServer();
    FakeSocket.reset();
    const sdk = new ThingerClient({
        window: win as unknown as Window,
        fetch: server.fetch as unknown as typeof fetch,
        WebSocket: FakeSocket as unknown as typeof WebSocket,
        ...opts,
    });
    const init = async (fields: Record<string, unknown> = {}) => {
        win.receive({
            type: 'thinger:init',
            apiBase: '',
            token: token('alice'),
            user: { id: 'alice' },
            project: null,
            context: {},
            dashboard: { id: 'dash' },
            ...fields,
        });
        return sdk.ready();
    };
    return { win, parent, server, sdk, init };
}

/** A page opened directly (top level, or inside `parent` when given) with `href`. */
export function standalone(
    href: string,
    opts: { parent?: FakeParent; storage?: Map<string, string>; server?: FakeServer } = {},
) {
    const win = new FakeWindow(href, opts);
    const server = opts.server ?? new FakeServer();
    FakeSocket.reset();
    const sdk = new ThingerClient({
        window: win as unknown as Window,
        fetch: server.fetch as unknown as typeof fetch,
        WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    return { win, server, sdk };
}

/** Let pending promises and zero-delay timers run. */
export async function flush(times = 5) {
    for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}
