import { httpError, type ThingerError } from './errors.js';

/** Encode a path segment. */
export function enc(value: unknown): string {
    return encodeURIComponent(String(value));
}

/** Add a query param; an array is sent as a repeated param (the server matches any of them). */
export function appendParam(params: URLSearchParams, key: string, value: unknown): void {
    if (value == null) return;
    for (const v of ([] as unknown[]).concat(value)) {
        if (v != null) params.append(key, String(v));
    }
}

/** `?key=value&…` from an object, or '' when there is nothing to send. */
export function buildQuery(params?: object | null): string {
    if (!params) return '';
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) appendParam(sp, k, v);
    const s = sp.toString();
    return s ? '?' + s : '';
}

/**
 * Response body: parsed JSON, the text when it is not JSON, or null when empty. Many writes answer
 * 200 with no body (bucket writes, a device resource without data), where r.json() would throw.
 */
export async function bodyOf(r: Response): Promise<unknown> {
    if (r.status === 204) return null;
    const text = await r.text();
    if (!text) return null;
    const type = r.headers.get('content-type') || '';
    if (type && !type.includes('json')) return text;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/** Error for a failed response, with the server's reason (its error message, or the body). */
export async function responseError(r: Response): Promise<ThingerError> {
    let detail = '';
    try {
        const text = await r.text();
        detail = text;
        try {
            const parsed = JSON.parse(text) as { error?: { message?: unknown } } | null;
            const message = parsed && parsed.error && parsed.error.message;
            if (typeof message === 'string' && message) detail = message;
        } catch {
            // not JSON: the text is the reason
        }
    } catch {
        // no body
    }
    return httpError(r.status, detail);
}

/** JSON for a log line, or String() when it cannot be serialized (cycles). */
export function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/** JSON with sorted keys, to compare records whatever the order of their fields. */
export function stableJson(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        return (
            '{' +
            Object.keys(obj)
                .sort()
                .map((k) => JSON.stringify(k) + ':' + stableJson(obj[k]))
                .join(',') +
            '}'
        );
    }
    return JSON.stringify(value) ?? 'undefined';
}

/** Payload of a JWT access token, or null when it is not one. */
export function jwtPayload(
    token: string,
    atob: (data: string) => string,
): Record<string, unknown> | null {
    try {
        const part = token.split('.')[1];
        if (!part) return null;
        const payload: unknown = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
        return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}
