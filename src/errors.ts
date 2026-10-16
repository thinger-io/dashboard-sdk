/**
 * Why a call failed:
 * - `http`: the server answered with an error status (`status` set).
 * - `unsupported`: the server is older than the function needs (`requires` set).
 * - `no-session`: no user or token yet (before `ready()`, or opened without a session).
 * - `invalid-argument`: the call itself is wrong (e.g. `device: true` without a context device).
 * - `unexpected-response`: the server answered something the SDK cannot use.
 */
export type ThingerErrorCode =
    'http' | 'unsupported' | 'no-session' | 'invalid-argument' | 'unexpected-response';

export interface ThingerErrorOptions {
    code: ThingerErrorCode;
    status?: number;
    requires?: string;
    cause?: unknown;
}

/** Error of every SDK call. API errors read `HTTP <status> <reason>`, with `status` set. */
export class ThingerError extends Error {
    readonly code: ThingerErrorCode;
    /** HTTP status, for `code: 'http'`. */
    readonly status?: number;
    /** Minimum server version, for `code: 'unsupported'` (e.g. "7.6"). */
    readonly requires?: string;

    constructor(message: string, options: ThingerErrorOptions) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'ThingerError';
        this.code = options.code;
        if (options.status !== undefined) this.status = options.status;
        if (options.requires !== undefined) this.requires = options.requires;
    }
}

/** Error for a failed API call: `HTTP <status> <detail>`. */
export function httpError(status: number, detail = ''): ThingerError {
    return new ThingerError('HTTP ' + status + (detail ? ' ' + detail : ''), {
        code: 'http',
        status,
    });
}
