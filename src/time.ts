// Time arithmetic. Every function takes `now` explicitly so the rollup and
// retention tests can put the clock anywhere.

export const MINUTE_MS = 60_000;
export const BUCKET_MS = 10 * MINUTE_MS;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** Raw heartbeats whose bucket started more than this long ago are purged. TEL-004. */
export const RETENTION_DAYS = 90;
/** One heartbeat per install per this many ms; the client sends every 5 min. */
export const RATE_LIMIT_MS = 60_000;

export const CONCURRENT_WINDOW_MS = 10 * MINUTE_MS;
export const UNIQUE_WINDOW_MS = 30 * DAY_MS;
export const VERSION_WINDOW_MS = 7 * DAY_MS;

/** ISO-8601 UTC with whole seconds: `2026-10-01T18:40:00Z`. */
export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Start of the 10-minute UTC bucket containing `ms`, aligned to :00, :10, ... */
export function bucketStartMs(ms: number): number {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS;
}

export function bucketStart(ms: number): string {
  return iso(bucketStartMs(ms));
}

/** Midnight UTC of the day containing `ms`. */
export function dayStartMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** `YYYY-MM-DD` of the UTC day containing `ms`. */
export function dayKey(ms: number): string {
  return iso(ms).slice(0, 10);
}
