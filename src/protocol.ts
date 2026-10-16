/**
 * The contract between a dashboard app (this SDK) and the Thinger console that frames it, plus
 * the standalone link parameters. PROTOCOL.md is its written specification.
 *
 * This module has no side effects, so the console can import it without starting the SDK:
 *
 *     import { IFRAME_SANDBOX, type AppMessage } from '@thinger-io/dashboard-sdk/protocol';
 *
 * Rules: the contract only grows. A new message or field is always optional, an existing one never
 * goes away nor changes meaning, and each side ignores the messages and fields it does not know.
 * There is no protocol number: `thinger:ready` carries the SDK version for diagnostics only.
 */

/** The viewer. */
export interface User {
    id: string;
}

/** Project the dashboard runs in. */
export interface Project {
    id: string;
    owner?: string;
    name?: string;
}

/** The dashboard being shown. */
export interface DashboardRef {
    id: string;
    name?: string;
}

/** The resource whose `dashboard` property is being shown (null or missing when not set). */
export interface Context {
    device?: string | null;
    product?: string | null;
    type?: string | null;
    group?: string | null;
    project?: string | null;
}

/** Where `navigate()` asks the console to go: a path or URL, or one resource. */
export type NavigateTarget =
    | string
    | { device: string }
    | { product: string }
    | { project: string }
    | { dashboard: string }
    | { url: string };

/** Message types, by name. */
export const MESSAGE = {
    READY: 'thinger:ready',
    INIT: 'thinger:init',
    REFRESH_TOKEN: 'thinger:refresh-token',
    TOKEN: 'thinger:token',
    LOCATION: 'thinger:location',
    ROUTE: 'thinger:route',
    NAVIGATE: 'thinger:navigate',
    OPEN_FILE: 'thinger:open-file',
    ERROR: 'thinger:error',
    DASHBOARD_READY: 'thinger:dashboard-ready',
} as const;

export type MessageType = (typeof MESSAGE)[keyof typeof MESSAGE];

// ---------------------------------------------------------------------------------------------
// App → console
// ---------------------------------------------------------------------------------------------

/** The app is loaded and asks for `thinger:init`. Sent once, when the SDK starts. */
export interface ReadyMessage {
    type: 'thinger:ready';
    /** SDK version (semver, e.g. "0.2.0"). Since SDK 0.2; older SDKs send no fields. */
    sdk?: string;
    /**
     * The key of the frame load, from `thinger_frame` in the frame URL (since SDK 0.3). The
     * console only answers messages that carry it with the token, file openings and navigation.
     */
    frame?: string;
}

/** A call got 401: the app asks for a new access token, answered by `thinger:token`. */
export interface RefreshTokenMessage {
    type: 'thinger:refresh-token';
    /**
     * The key of the frame load, from `thinger_frame` in the frame URL (since SDK 0.3). The
     * console only answers messages that carry it with the token, file openings and navigation.
     */
    frame?: string;
}

/** The app's hash route changed (the part after '#'), so the console can keep it in its URL. */
export interface LocationMessage {
    type: 'thinger:location';
    path: string;
}

/** Navigate the console (the sandboxed frame cannot change the top-level location). */
export interface NavigateMessage {
    type: 'thinger:navigate';
    target: NavigateTarget;
    /**
     * The key of the frame load, from `thinger_frame` in the frame URL (since SDK 0.3). The
     * console only answers messages that carry it with the token, file openings and navigation.
     */
    frame?: string;
}

/** Open a storage file in a new tab through the console (PDF viewer, images). */
export interface OpenFileMessage {
    type: 'thinger:open-file';
    storage: string;
    path: string;
    /**
     * The key of the frame load, from `thinger_frame` in the frame URL (since SDK 0.3). The
     * console only answers messages that carry it with the token, file openings and navigation.
     */
    frame?: string;
}

/** An error of the app page, copied to the console's browser console. */
export interface ErrorMessage {
    type: 'thinger:error';
    message: string;
}

/** Messages the app posts to the console (`window.parent`). */
export type AppMessage =
    | ReadyMessage
    | RefreshTokenMessage
    | LocationMessage
    | NavigateMessage
    | OpenFileMessage
    | ErrorMessage;

// ---------------------------------------------------------------------------------------------
// Console → app
// ---------------------------------------------------------------------------------------------

/** Credentials and context, the answer to `thinger:ready`. */
export interface InitMessage {
    type: 'thinger:init';
    /** Base URL for API calls; '' = the page's own origin. */
    apiBase?: string;
    /** Informational: the absolute API host. */
    apiHost?: string;
    /** Viewer's access token; null when the page is not served from the console's origin. */
    token?: string | null;
    user?: User | null;
    project?: Project | null;
    context?: Context;
    dashboard?: DashboardRef | null;
}

/** Answer to `thinger:refresh-token`: the new token, or null when the refresh failed. */
export interface TokenMessage {
    type: 'thinger:token';
    token?: string | null;
}

/** The console URL changed (typed, back / forward): move the app to this hash route. */
export interface RouteMessage {
    type: 'thinger:route';
    path: string;
}

/** Messages the console posts to the app's frame. */
export type ConsoleMessage = InitMessage | TokenMessage | RouteMessage;

// ---------------------------------------------------------------------------------------------
// Standalone app → embedding page
// ---------------------------------------------------------------------------------------------

/** Standalone only: the first API call succeeded. No data. */
export interface DashboardReadyMessage {
    type: 'thinger:dashboard-ready';
}

/** Messages a standalone app posts to a website that embeds it. */
export type EmbedMessage = DashboardReadyMessage;

/** Every message of the contract. */
export type ProtocolMessage = AppMessage | ConsoleMessage | EmbedMessage;

// ---------------------------------------------------------------------------------------------
// Frame and limits
// ---------------------------------------------------------------------------------------------

/** `sandbox` attribute of the console's iframe. Apps depend on what it allows and forbids. */
export const IFRAME_SANDBOX = 'allow-scripts allow-forms allow-downloads';

/** `thinger:error` messages sent per page load, at most. */
export const MAX_ERROR_MESSAGES = 100;

/** Length of a `thinger:error` message, at most (characters). */
export const MAX_ERROR_LENGTH = 2000;

/** Length of a `thinger:location` path the console accepts, at most. */
export const MAX_LOCATION_LENGTH = 1024;

/** How long a framed app waits for `thinger:init` before `ready()` rejects (ms). */
export const HANDSHAKE_TIMEOUT_MS = 10000;

/** How long the app waits for `thinger:token` after `thinger:refresh-token` (ms). */
export const TOKEN_REFRESH_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------------------------
// Standalone links
// ---------------------------------------------------------------------------------------------

/** Prefix of the standalone parameters in the URL fragment. */
export const STANDALONE_PREFIX = 'thinger_';

/**
 * Fragment parameter with the key of a frame load: the console adds `&thinger_frame=<key>` to the
 * app URL each time it loads it (`#<route>&thinger_frame=<key>`, or `#&thinger_frame=<key>`). The
 * SDK removes it before the app reads its route, keeps it in memory only, and sends it back as
 * `frame` in the messages the console guards with it.
 */
export const FRAME_PARAM = 'thinger_frame';

/** Messages that carry the frame key. */
export const FRAME_KEYED_MESSAGES: readonly MessageType[] = [
    'thinger:ready',
    'thinger:refresh-token',
    'thinger:open-file',
    'thinger:navigate',
];

/** `url` with the frame key added to its fragment, after the route (for the console). */
export function withFrameKey(url: string, key: string): string {
    const hash = url.indexOf('#');
    const base = hash >= 0 ? url.slice(0, hash) : url;
    const fragment = hash >= 0 ? url.slice(hash + 1) : '';
    return base + '#' + fragment + '&' + FRAME_PARAM + '=' + encodeURIComponent(key);
}

/**
 * Standalone parameters, without the prefix: `#<route>&thinger_token=…&thinger_api=…`.
 * `token` is required; the others are optional.
 */
export const STANDALONE_PARAMS = [
    'token',
    'api',
    'project',
    'device',
    'product',
    'type',
    'group',
] as const;

export type StandaloneParam = (typeof STANDALONE_PARAMS)[number];

/** Values of a standalone link. */
export type StandaloneParams = Partial<Record<StandaloneParam, string>>;

/**
 * Build the fragment that opens an app standalone: `<route>&thinger_token=…`, values encoded.
 * Append it to the app URL after '#'.
 */
export function standaloneFragment(
    params: StandaloneParams & { token: string },
    route = '',
): string {
    const parts: string[] = [];
    for (const key of STANDALONE_PARAMS) {
        const value = params[key];
        if (value != null && value !== '') {
            parts.push(STANDALONE_PREFIX + key + '=' + encodeURIComponent(value));
        }
    }
    return [route, ...parts].filter((p) => p !== '').join('&');
}

/** Is `data` a message of this contract (an object whose `type` starts with "thinger:")? */
export function isProtocolMessage(data: unknown): data is { type: MessageType } {
    return (
        typeof data === 'object' &&
        data !== null &&
        typeof (data as { type?: unknown }).type === 'string' &&
        (data as { type: string }).type.startsWith('thinger:')
    );
}
