import { ThingerError } from './errors.js';

/** Milliseconds timestamp, Date, 'now', or a duration before now ('30m', '6h', '7d', '1M'…). */
export type Time = number | Date | string;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TIME_UNITS: Record<string, number> = {
    s: SECOND,
    m: MINUTE,
    h: HOUR,
    d: DAY,
    w: 7 * DAY,
    M: 30 * DAY,
    y: 365 * DAY,
};

/** A time value as a milliseconds timestamp; durations count back from now. */
export function parseTime(value: Time | null | undefined): number | undefined {
    if (value == null) return undefined;
    if (typeof value === 'number') return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') {
        if (value === 'now') return Date.now();
        const m = /^(\d+)([smhdwMy])$/.exec(value);
        if (m) return Date.now() - parseInt(m[1]!, 10) * TIME_UNITS[m[2]!]!;
    }
    throw new ThingerError('Invalid time value: ' + String(value), { code: 'invalid-argument' });
}

// Aggregation periods as the server parses them ('5m', '1h', '1d', '1w', '1mo', '1y'):
// [nominal length, longest real length] (a DST day lasts 25 h, a month up to 31 days…).
const AGG_UNITS: Record<string, [number, number]> = {
    s: [SECOND, SECOND],
    m: [MINUTE, MINUTE],
    h: [HOUR, HOUR],
    d: [DAY, 25 * HOUR],
    w: [7 * DAY, (7 * 24 + 1) * HOUR],
    mo: [30 * DAY, (31 * 24 + 1) * HOUR],
    y: [365 * DAY, (366 * 24 + 1) * HOUR],
};

export interface AggregationPeriod {
    nominal: number;
    max: number;
}

/** Length of an aggregation period ('15m', '1d'…), or null when the SDK cannot place it in time. */
export function aggregationPeriod(aggregation: string): AggregationPeriod | null {
    const m = /^(\d+)(mo|[smhdwy])$/.exec(aggregation);
    if (!m) return null;
    const n = parseInt(m[1]!, 10);
    if (!n) return null;
    const unit = AGG_UNITS[m[2]!]!;
    return { nominal: n * unit[0], max: n * unit[1] };
}
