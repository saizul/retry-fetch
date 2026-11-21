/**
 * Parses a `Retry-After` header value into milliseconds from `now`.
 *
 * Accepts delay-seconds (`"120"`) and HTTP dates
 * (`"Wed, 21 Oct 2015 07:28:00 GMT"`). Dates in the past give 0. Returns
 * `undefined` for a missing or malformed value.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()) {
  if (value == null) return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // Only accept things that look like dates, so "1.5" or "-3" are not parsed as years.
  if (!/[a-z]/i.test(text)) return undefined;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** Values at or above this are read as a Unix time in seconds, not as a delay. */
const EPOCH_THRESHOLD = 1_000_000_000;

/**
 * Reads the rate-limit reset time from `RateLimit-Reset` (IETF draft, seconds
 * until the window resets) or `X-RateLimit-Reset` (GitHub, Twitter and many
 * others, usually a Unix time in seconds) and returns milliseconds from `now`.
 *
 * A value of at least 1 000 000 000 is treated as a Unix timestamp, anything
 * smaller as delta-seconds. Timestamps in the past give 0. Returns `undefined`
 * when neither header is present or the value is not a non-negative number.
 */
export function parseRateLimitReset(headers: Headers, now: number = Date.now()) {
  for (const name of ['ratelimit-reset', 'x-ratelimit-reset']) {
    const raw = headers.get(name);
    if (raw == null) continue;
    const text = raw.trim();
    if (!/^\d+(\.\d+)?$/.test(text)) continue;
    const value = Number(text);
    if (value >= EPOCH_THRESHOLD) return Math.max(0, Math.ceil(value * 1000 - now));
    return Math.ceil(value * 1000);
  }
  return undefined;
}
