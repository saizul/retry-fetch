/** How random the wait between attempts is. */
export type Jitter = 'full' | 'equal' | 'none';

export interface BackoffOptions {
  /** Wait before the first retry, before jitter. Default 250 ms. */
  minDelay?: number;
  /** Upper bound for any computed wait. Default 10 000 ms. */
  maxDelay?: number;
  /** Growth factor per retry. Default 2. */
  factor?: number;
  /** Default `'full'`: a uniformly random wait between 0 and the exponential value. */
  jitter?: Jitter;
}

/**
 * The wait in milliseconds before retry number `retry` (1 for the first retry).
 *
 * `full` jitter picks a value in `[0, cap)`, `equal` in `[cap / 2, cap)` and
 * `none` returns `cap`, where `cap = min(maxDelay, minDelay * factor ** (retry - 1))`.
 */
export function computeDelay(
  retry: number,
  options: BackoffOptions = {},
  random: () => number = Math.random,
) {
  const minDelay = options.minDelay ?? 250;
  const maxDelay = options.maxDelay ?? 10_000;
  const factor = options.factor ?? 2;
  const cap = Math.min(maxDelay, minDelay * factor ** Math.max(0, retry - 1));
  switch (options.jitter ?? 'full') {
    case 'none':
      return Math.round(cap);
    case 'equal':
      return Math.round(cap / 2 + random() * (cap / 2));
    default:
      return Math.round(random() * cap);
  }
}
