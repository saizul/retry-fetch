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
