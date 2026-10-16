import { Alarms } from './alarms.js';
import { Buckets } from './buckets.js';
import { Compat } from './compat.js';
import { Devices } from './devices.js';
import { ThingerError } from './errors.js';
import { Events } from './events.js';
import { bodyOf, enc, jwtPayload, responseError, safeJson } from './http.js';
import { Endpoints, Products, Projects, Stats } from './misc.js';
import {
    MAX_ERROR_LENGTH,
    MAX_ERROR_MESSAGES,
    MESSAGE,
    STANDALONE_PREFIX,
    TOKEN_REFRESH_TIMEOUT_MS,
    type AppMessage,
    type Context,
    type DashboardRef,
    type InitMessage,
    type NavigateTarget,
    type Project,
    type StandaloneParams,
    type User,
} from './protocol.js';
import { Properties, Resources } from './resources.js';
import { Storages } from './storages.js';
import type { FetchOptions, RequestOptions } from './types.js';
import { SDK_VERSION } from './version.js';

/** What the SDK takes from its environment. Defaults: the page's own globals. */
export interface ClientOptions {
    /** The page window; none (server-side rendering) leaves the SDK idle. */
    window?: Window | null;
    fetch?: typeof fetch;
    WebSocket?: typeof WebSocket;
    /** Wait at most this long for the server version before `ready()` resolves (ms, default 3000). */
    versionTimeoutMs?: number;
}

/** @internal Resolved environment. */
export interface ClientEnv {
    window: Window | null;
    fetch: typeof fetch;
    WebSocket: typeof WebSocket | undefined;
    URL: typeof URL;
    atob: (data: string) => string;
}

function defaultWindow(): Window | null {
    return typeof window !== 'undefined' ? window : null;
}

/**
 * A Thinger dashboard SDK client. Apps use the `Thinger` instance the package exports, which
 * starts when imported: inside the console it runs the handshake, and with a `thinger_token` in
 * the URL fragment it runs standalone.
 */
export class ThingerClient {
    /** SDK version (semver). */
    readonly version: string = SDK_VERSION;

    readonly events: Events;
    readonly buckets: Buckets;
    readonly devices: Devices;
    readonly alarms: Alarms;
    readonly resources: Resources;
    readonly properties: Properties;
    readonly products: Products;
    readonly endpoints: Endpoints;
    readonly storages: Storages;
    readonly projects: Projects;
    readonly stats: Stats;

    /** @internal */
    readonly env: ClientEnv;
    /** @internal */
    readonly compat = new Compat();

    private state = {
        apiBase: '',
        apiHost: '',
        token: null as string | null,
        user: null as User | null,
        project: null as Project | null,
        context: {} as Context,
        dashboard: null as DashboardRef | null,
    };
    private readonly standalone: boolean;
    private readonly versionTimeoutMs: number;
    private readonly readyPromise: Promise<ThingerClient>;
    private resolveReady!: (sdk: ThingerClient) => void;
    private rejectReady!: (err: Error) => void;
    private initialized = false;
    private readonly listeners: Array<(sdk: ThingerClient) => void> = [];
    private refresh: { promise: Promise<boolean>; resolve: (ok: boolean) => void } | null = null;
    private embedReadySent = false;
    private readonly warned = new Set<string>();

    constructor(options: ClientOptions = {}) {
        const win = options.window !== undefined ? options.window : defaultWindow();
        const g = globalThis as typeof globalThis & { WebSocket?: typeof WebSocket };
        this.env = {
            window: win,
            fetch: options.fetch ?? ((input, init) => g.fetch(input, init)),
            WebSocket:
                options.WebSocket ??
                (win as (Window & typeof globalThis) | null)?.WebSocket ??
                g.WebSocket,
            URL: (win as (Window & typeof globalThis) | null)?.URL ?? g.URL,
            atob: (data) => ((win as (Window & typeof globalThis) | null)?.atob ?? g.atob)(data),
        };
        this.versionTimeoutMs = options.versionTimeoutMs ?? 3000;

        this.events = new Events(this);
        this.buckets = new Buckets(this);
        this.devices = new Devices(this);
        this.alarms = new Alarms(this);
        this.resources = new Resources(this);
        this.properties = new Properties(this);
        this.products = new Products(this);
        this.endpoints = new Endpoints(this);
        this.storages = new Storages(this);
        this.projects = new Projects(this);
        this.stats = new Stats(this);

        this.readyPromise = new Promise<ThingerClient>((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        // a rejected ready() nobody waits for must not show up as an unhandled rejection
        this.readyPromise.catch(() => undefined);

        if (!win) {
            this.standalone = false;
            return;
        }

        // A token in the URL fragment runs the app on its own (a preview link, a dev server, a
        // page embedded in a website), without the console: no handshake with any parent.
        this.standalone = this.initFromFragment(win);
        if (this.standalone) return;

        win.addEventListener('message', (ev) => this.onMessage(ev));
        if (win.parent !== win) {
            this.post({ type: MESSAGE.READY, sdk: SDK_VERSION });
            this.reportLocation(win);
            this.forwardErrors(win);
        } else {
            // opened on its own without a token: no console will ever answer, so fail now
            const err = new ThingerError(
                'No Thinger session: open this page from the console, or with a link that carries thinger_token',
                { code: 'no-session' },
            );
            console.error(err.message);
            this.rejectReady(err);
        }
    }

    // ----- Session ----------------------------------------------------------------------------

    /** Base URL of API calls ('' = the page's origin). */
    get apiBase(): string {
        return this.state.apiBase;
    }
    /** Informational: the absolute API host the console reported. */
    get apiHost(): string {
        return this.state.apiHost;
    }
    /** Viewer's access token. */
    get token(): string | null {
        return this.state.token;
    }
    /** `{ id }` of the viewer. */
    get user(): User | null {
        return this.state.user;
    }
    /** Project the dashboard runs in; API calls are scoped to it (`?project=`). */
    get project(): Project | null {
        return this.state.project;
    }
    /** The resource whose `dashboard` property is shown: `{ device, product, type, group, project }`. */
    get context(): Context {
        return this.state.context;
    }
    /** `{ id, name }` of the dashboard (inside the console). */
    get dashboard(): DashboardRef | null {
        return this.state.dashboard;
    }
    /** Server version (e.g. "7.5.0"), known after `ready()`; null when it could not be read. */
    get serverVersion(): string | null {
        return this.compat.serverVersion;
    }

    /**
     * Resolves once the session is there: the console handshake, or the standalone link. It also
     * waits (up to 3 s) for the server version, so `supports()` is accurate afterwards. Rejects
     * when the page has no session at all.
     */
    ready(): Promise<ThingerClient> {
        return this.readyPromise;
    }

    /** Call `fn(Thinger)` on every init (and now, when already initialized). */
    onInit(fn: (sdk: ThingerClient) => void): void {
        this.listeners.push(fn);
        if (this.initialized) {
            try {
                fn(this);
            } catch (e) {
                console.error(e);
            }
        }
    }

    /**
     * Is a function available on this server? `name` is its path from `Thinger`
     * ('devices.list', 'alarms.rules.get'). Functions that need a newer server than this one
     * answer false; the rest true. Accurate after `ready()`; before it, or when the server
     * version cannot be read, only unknown names answer false.
     */
    supports(name: string): boolean {
        if (typeof this.resolvePath(name) !== 'function') {
            this.warnOnce(
                'supports:' + name,
                '[Thinger] supports(): no SDK function named "' + name + '"',
            );
            return false;
        }
        return this.compat.available(name);
    }

    private resolvePath(name: string): unknown {
        return String(name)
            .split('.')
            .reduce<unknown>(
                (target, part) =>
                    target != null && typeof target === 'object'
                        ? (target as Record<string, unknown>)[part]
                        : undefined,
                this,
            );
    }

    // ----- API calls --------------------------------------------------------------------------

    /**
     * API call: `fetch()` plus error handling and body parsing. `opts.body`: any JSON value, or a
     * string, Blob, FormData or ArrayBuffer sent as is. `opts.as` forces the response type
     * ('json', 'text', 'blob', 'arrayBuffer'); by default parsed JSON for JSON responses, text
     * otherwise, null when empty. `opts.project: false` skips the project scoping. Throws a
     * `ThingerError` `HTTP <status> <reason>` with `status`.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers name what they expect
    async request<T = any>(path: string, opts?: RequestOptions): Promise<T> {
        const { as, body, ...init } = opts || {};
        const fetchOpts: FetchOptions = { ...init };
        const raw =
            body === undefined ||
            typeof body === 'string' ||
            (typeof Blob !== 'undefined' && body instanceof Blob) ||
            (typeof FormData !== 'undefined' && body instanceof FormData) ||
            body instanceof ArrayBuffer ||
            ArrayBuffer.isView(body);
        if (raw) {
            if (body !== undefined) fetchOpts.body = body as BodyInit;
        } else {
            fetchOpts.headers = {
                'Content-Type': 'application/json',
                ...headersObject(init.headers),
            };
            fetchOpts.body = JSON.stringify(body);
        }
        const r = await this.fetch(path, fetchOpts);
        if (!r.ok) throw await responseError(r);
        if (r.status === 204) return null as T;
        if (as === 'blob') return (await r.blob()) as T;
        if (as === 'arrayBuffer') return (await r.arrayBuffer()) as T;
        if (as === 'text') return (await r.text()) as T;
        if (as === 'json') return (await r.json()) as T;
        return (await bodyOf(r)) as T;
    }

    /**
     * Authenticated `fetch()`: adds `Authorization: Bearer <token>` and, in a project, `?project=`
     * (the server maps the URL's user to the project owner, so callers never need to know it).
     * Inside the console, a 401 asks it for a new token and retries once.
     */
    async fetch(path: string, options?: FetchOptions): Promise<Response> {
        const { project: scope, ...init } = options || {};
        let url = /^https?:\/\//.test(path) ? path : this.state.apiBase + path;
        const project = this.state.project && this.state.project.id;
        if (scope !== false && project && !/[?&]project=/.test(url)) {
            url += (url.indexOf('?') >= 0 ? '&' : '?') + 'project=' + enc(project);
        }
        const send = () => {
            const headers = headersObject(init.headers);
            if (this.state.token) headers['Authorization'] = 'Bearer ' + this.state.token;
            return this.env.fetch(url, { ...init, headers });
        };
        let response = await send();
        if (response.status === 401 && this.framed()) {
            if (await this.requestTokenRefresh()) response = await send();
        }
        if (response.ok) this.notifyEmbedReady();
        return response;
    }

    /**
     * Navigate the console: a path or URL, or one of `{ device }`, `{ product }`, `{ project }`,
     * `{ dashboard }`, `{ url }`. Standalone pages go to the URL themselves.
     */
    navigate(target: NavigateTarget): void {
        if (!this.framed()) {
            const url =
                typeof target === 'string'
                    ? target
                    : 'url' in target && typeof target.url === 'string'
                      ? target.url
                      : null;
            if (url) this.env.window?.location.assign(url);
            return;
        }
        this.post({ type: MESSAGE.NAVIGATE, target });
    }

    // ----- Internals shared with the API classes ---------------------------------------------

    /** @internal The viewer's id, or a `no-session` error. */
    userId(): string {
        const id = this.state.user && this.state.user.id;
        if (!id) throw new ThingerError('No user in context', { code: 'no-session' });
        return id;
    }

    /** @internal True inside the console's frame: false when standalone or opened on its own. */
    framed(): boolean {
        const win = this.env.window;
        return !this.standalone && !!win && win.parent !== win;
    }

    /** @internal Post a message to the console. */
    post(message: AppMessage): void {
        const win = this.env.window;
        if (!win || win.parent === win) return;
        try {
            win.parent.postMessage(message, '*');
        } catch {
            // parent gone
        }
    }

    /**
     * @internal Origin for WebSockets: `apiBase` when it is absolute (another server), else the
     * page's own origin (same server, or a dev server proxying it).
     */
    wsBase(): string {
        let base = this.state.apiBase;
        if (!base || !/^https?:\/\//.test(base)) base = this.env.window?.location.origin ?? '';
        return base.replace(/^http/, 'ws');
    }

    /**
     * @internal WebSockets authenticate once, in the URL, so a socket that drops after the token
     * expired would reconnect with a dead one. Refresh it first when it is about to expire (JWT
     * `exp`, 30 s margin).
     */
    async freshToken(): Promise<void> {
        const token = this.state.token;
        if (!token || !this.framed()) return;
        const exp = Number(jwtPayload(token, this.env.atob)?.['exp'] || 0);
        if (exp && exp * 1000 - Date.now() < 30000) await this.requestTokenRefresh();
    }

    // ----- Console handshake ------------------------------------------------------------------

    private onMessage(ev: MessageEvent): void {
        const win = this.env.window;
        // only the console (the parent window) speaks for the session: not frames inside the app
        if (!win || ev.source !== win.parent) return;
        const data: unknown = ev.data;
        if (!data || typeof data !== 'object') return;
        const msg = data as { type?: unknown };
        if (msg.type === MESSAGE.INIT) {
            this.init(data as InitMessage);
        } else if (msg.type === MESSAGE.ROUTE) {
            // the console URL changed (typed, back / forward): move the app there; hash routers
            // follow the resulting hashchange / popstate
            const path = (data as { path?: unknown }).path;
            const route = typeof path === 'string' ? path : '';
            if (route !== win.location.hash.replace(/^#/, '')) win.location.hash = route;
        } else if (msg.type === MESSAGE.TOKEN) {
            // a new token (the answer to a refresh request, or pushed by the console), or
            // null / missing when the refresh failed
            const token = (data as { token?: unknown }).token;
            const ok = typeof token === 'string' && token !== '';
            if (ok) this.state.token = token;
            if (this.refresh) this.refresh.resolve(ok);
        }
    }

    private init(msg: InitMessage): void {
        this.state = {
            apiBase: typeof msg.apiBase === 'string' ? msg.apiBase : '',
            apiHost: typeof msg.apiHost === 'string' ? msg.apiHost : '',
            token: typeof msg.token === 'string' && msg.token ? msg.token : null,
            user: msg.user || null,
            project: msg.project || null,
            context: msg.context || {},
            dashboard: msg.dashboard || null,
        };
        void this.loadServerVersion().then(() => this.initDone());
    }

    private initDone(): void {
        this.initialized = true;
        this.resolveReady(this);
        for (const fn of this.listeners) {
            try {
                fn(this);
            } catch (e) {
                console.error(e);
            }
        }
    }

    /** Read the server version once; give up waiting after `versionTimeoutMs`. */
    private loadServerVersion(): Promise<void> {
        const load = this.compat.load(
            async () => {
                const r = await this.env.fetch(this.state.apiBase + '/v1/server/version');
                if (!r.ok) return null;
                const body = (await bodyOf(r)) as { version?: unknown } | null;
                return body && typeof body === 'object' ? body.version : null;
            },
            (message) => console.warn(message),
        );
        return new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, this.versionTimeoutMs);
            void load.then(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    /**
     * Ask the console for a new access token. Concurrent callers share one request. Resolves
     * true when a token arrived, false on refusal or timeout.
     */
    private requestTokenRefresh(): Promise<boolean> {
        if (this.refresh) return this.refresh.promise;
        let resolve!: (ok: boolean) => void;
        const promise = new Promise<boolean>((r) => {
            resolve = r;
        });
        const timeout = setTimeout(() => done(false), TOKEN_REFRESH_TIMEOUT_MS);
        const done = (ok: boolean) => {
            clearTimeout(timeout);
            if (this.refresh && this.refresh.promise === promise) this.refresh = null;
            resolve(ok);
        };
        this.refresh = { promise, resolve: done };
        this.post({ type: MESSAGE.REFRESH_TOKEN });
        return promise;
    }

    /**
     * Tell the console the app's route (the part after '#'), so it can keep it in its own URL:
     * reloading or sharing the console link reopens the same screen. Hash routers change the
     * route with history.pushState / replaceState (no event), so those are wrapped as well.
     */
    private reportLocation(win: Window): void {
        let last: string | null = null;
        const report = () => {
            const path = win.location.hash.replace(/^#/, '');
            if (path === last) return;
            last = path;
            this.post({ type: MESSAGE.LOCATION, path });
        };
        const history = win.history;
        for (const name of ['pushState', 'replaceState'] as const) {
            const original = history[name];
            history[name] = function (this: History, ...args: Parameters<History['pushState']>) {
                const result = original.apply(this, args);
                report();
                return result;
            };
        }
        win.addEventListener('hashchange', report);
        win.addEventListener('popstate', report);
        // the initial route, once the page has had a chance to set it
        setTimeout(report, 0);
    }

    /**
     * Copy the page's errors (uncaught errors, unhandled rejections and console.error) to the
     * console's own browser console: tools that read the tab's console do not see a sandboxed
     * frame's. Capped per page load.
     */
    private forwardErrors(win: Window): void {
        let sent = 0;
        const send = (message: string) => {
            if (sent >= MAX_ERROR_MESSAGES) return;
            sent++;
            this.post({ type: MESSAGE.ERROR, message: String(message).slice(0, MAX_ERROR_LENGTH) });
        };
        const describe = (v: unknown): string => {
            const e = v as { stack?: unknown; message?: unknown } | null;
            if (e && typeof e.stack === 'string' && e.stack) return e.stack;
            if (e && typeof e.message === 'string' && e.message) return e.message;
            return typeof v === 'object' ? safeJson(v) : String(v);
        };
        win.addEventListener('error', (ev: ErrorEvent) =>
            send(
                ev.error
                    ? describe(ev.error)
                    : ev.message + ' (' + ev.filename + ':' + ev.lineno + ')',
            ),
        );
        win.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) =>
            send('Unhandled rejection: ' + describe(ev.reason)),
        );
        const console_ = (win as Window & typeof globalThis).console ?? console;
        const original = console_.error;
        console_.error = function (this: Console, ...args: unknown[]) {
            send(args.map(describe).join(' '));
            return original.apply(this, args);
        };
    }

    // ----- Standalone -------------------------------------------------------------------------

    /**
     * Standalone mode: `#<route>&thinger_token=<access token>&thinger_project=<id>…` in the page
     * URL. The fragment never reaches the server; the SDK reads the `thinger_*` params and removes
     * them from the address bar (and so from the history) right away, leaving the app's route.
     * They are kept in the tab's sessionStorage, so a reload keeps the session. There is no token
     * refresh: when the token expires, calls fail with 401.
     */
    private initFromFragment(win: Window): boolean {
        // top-level only: a sandboxed frame has no storage
        const top = win.parent === win;
        const key = 'thinger:standalone:' + win.location.pathname;
        let params: StandaloneParams = {};
        const hash = win.location.hash.replace(/^#/, '');
        if (hash.indexOf(STANDALONE_PREFIX + 'token=') >= 0) {
            const pattern = new RegExp('^' + STANDALONE_PREFIX + '([a-z]+)=(.*)$');
            const rest = hash
                .split('&')
                .filter((part) => {
                    const m = pattern.exec(part);
                    if (!m) return true;
                    const name = m[1] as keyof StandaloneParams;
                    try {
                        params[name] = decodeURIComponent(m[2]!);
                    } catch {
                        params[name] = m[2]!;
                    }
                    return false;
                })
                .join('&');
            try {
                win.history.replaceState(
                    win.history.state,
                    '',
                    win.location.pathname + win.location.search + (rest ? '#' + rest : ''),
                );
            } catch {
                // keep going: the token still works
            }
            if (params.token && top) {
                try {
                    win.sessionStorage.setItem(key, JSON.stringify(params));
                } catch {
                    // no storage
                }
            }
        } else if (top) {
            try {
                params =
                    (JSON.parse(win.sessionStorage.getItem(key) || '{}') as StandaloneParams) || {};
            } catch {
                params = {};
            }
        }
        if (!params.token) return false;

        const payload = jwtPayload(params.token, this.env.atob);
        if (!payload) {
            console.error('thinger_token is not a valid access token');
            return false;
        }
        let apiBase = '';
        if (params.api) {
            const base = serverBase(params.api);
            if (base) apiBase = base;
            else
                console.error(
                    "thinger_api is not a server address (http(s)://host[:port]): using this page's origin",
                );
        }
        const usr = typeof payload['usr'] === 'string' ? payload['usr'] : null;
        const context: Context = {};
        if (params.device) context.device = params.device;
        if (params.product) context.product = params.product;
        if (params.type) context.type = params.type;
        if (params.group) context.group = params.group;
        if (params.project) context.project = params.project;
        this.state = {
            apiBase,
            apiHost: '',
            token: params.token,
            user: usr ? { id: usr } : null,
            project: params.project ? { id: params.project } : null,
            context,
            dashboard: null,
        };
        // an expired link fails every call with 401: say so once, up front
        const exp = Number(payload['exp'] || 0);
        if (exp && exp * 1000 < Date.now())
            console.error('thinger_token has expired: ask for a new link');
        void this.loadServerVersion().then(() => this.initDone());
        return true;
    }

    /**
     * A standalone page embedded in another site's frame tells its parent, once, that it is up:
     * its first API call succeeded. The site can then swap its placeholder for the frame (a frame
     * blocked by X-Frame-Options / frame-ancestors still fires `load`). No data is sent.
     */
    private notifyEmbedReady(): void {
        const win = this.env.window;
        if (this.embedReadySent || !this.standalone || !win || win.parent === win) return;
        this.embedReadySent = true;
        try {
            win.parent.postMessage({ type: MESSAGE.DASHBOARD_READY }, '*');
        } catch {
            // ignore
        }
    }

    private warnOnce(key: string, message: string): void {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        console.warn(message);
    }
}

/** A server address for `apiBase` (`http(s)://host[:port][/path]`, no trailing slash), or null. */
function serverBase(value: string): string | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
        return null;
    }
    return (url.origin + url.pathname).replace(/\/+$/, '');
}

/** Headers as a plain object, whatever form they were given in. */
function headersObject(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers) return {};
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        const out: Record<string, string> = {};
        headers.forEach((value, key) => {
            out[key] = value;
        });
        return out;
    }
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    return { ...(headers as Record<string, string>) };
}
