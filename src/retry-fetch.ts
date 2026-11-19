import { type BackoffOptions, computeDelay } from './backoff.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { AttemptTimeoutError, DeadlineExceededError, HttpError, RetriesExhaustedError } from './errors.js';
import { parseRetryAfter } from './retry-after.js';

/** Whatever `fetch` accepts as its first argument: a URL string, a `URL` or a `Request`. */
export type FetchInput = Parameters<typeof fetch>[0];

/** Methods that RFC 9110 defines as idempotent, and so are retried by default. */
export const IDEMPOTENT_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE'];

/**
 * The default status check: 408, 425, 429 and every 5xx except 501 (Not
 * Implemented) and 505 (HTTP Version Not Supported), which never succeed on
 * a retry.
 */
export function isRetryableStatus(status: number) {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status <= 599 && status !== 501 && status !== 505;
}

/** What the retry decision is based on. Exactly one of `error` and `response` is set. */
export interface RetryContext {
  /** The attempt that just finished, starting at 1. */
  attempt: number;
  /** Upper-case request method. */
  method: string;
  url: string;
  error?: unknown;
  response?: Response;
}

/** Passed to `onRetry` just before the wait. */
export interface RetryInfo extends RetryContext {
  /** Milliseconds until the next attempt. */
  delay: number;
  /** Retries still allowed after this one. */
  retriesLeft: number;
  /** True when `delay` came from the response's `Retry-After` header. */
  fromRetryAfter: boolean;
}

export interface RetryOptions extends BackoffOptions {
  /** Retries after the first attempt. Default 2, so up to 3 requests. */
  retries?: number;
  /** Statuses that are retried. Default: 408, 425, 429 and 5xx except 501 and 505. */
  statusCodes?: readonly number[];
  /** Methods that are retried. Default: the idempotent methods GET, HEAD, OPTIONS, TRACE, PUT and DELETE. */
  methods?: readonly string[];
  /** Retry every method, including POST and PATCH. Default false. */
  retryNonIdempotent?: boolean;
  /**
   * A request carrying this header is treated as idempotent whatever its
   * method, because the server can de-duplicate it. Default
   * `'Idempotency-Key'`; `false` turns this off.
   */
  idempotencyHeader?: string | false;
  /** Wait as long as the `Retry-After` header asks on retryable responses. Default true. */
  respectRetryAfter?: boolean;
  /** If `Retry-After` asks for longer than this, give up and return the response. Default 60 000 ms. */
  maxRetryAfter?: number;
  /** Time limit for each attempt until the response headers arrive. Default: none. */
  timeout?: number;
  /** Time limit for the whole operation, waits included, until the final response headers arrive. Default: none. */
  deadline?: number;
  /**
   * Override the retry decision. Return `true` or `false` to decide, or
   * `undefined` to keep the default. Requests with a stream body are never
   * retried, and `retries` is always the upper bound.
   */
  shouldRetry?: (context: RetryContext) => boolean | undefined | Promise<boolean | undefined>;
  /** Called before each wait. A thrown error stops retrying and is passed on to the caller. */
  onRetry?: (info: RetryInfo) => void | Promise<void>;
  /** Fail fast while the upstream service is down. Share one instance per upstream. */
  circuitBreaker?: CircuitBreaker;
  /** Throw `HttpError` instead of returning a final response that is not ok. Default false, like fetch. */
  throwHttpErrors?: boolean;
  /** The fetch implementation to wrap. Default `globalThis.fetch`, looked up at call time. */
  fetch?: typeof fetch;
  /** Random source in [0, 1) for jitter. Default `Math.random`. */
  random?: () => number;
  /** How to wait between attempts. Must reject with `signal.reason` when the signal aborts. For tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** `RequestInit` plus a per-call `retry` field that overrides the defaults. */
export interface RetryRequestInit extends RequestInit {
  retry?: RetryOptions;
}

/** A fetch-compatible function with retries. */
export type RetryFetch = (input: FetchInput, init?: RetryRequestInit) => Promise<Response>;

/**
 * `fetch` with retries. Takes the same arguments as `fetch` and resolves to
 * the same `Response`; retry settings go in `init.retry`.
 *
 * ```ts
 * const res = await retryFetch('https://api.example.com/items', { retry: { retries: 3, timeout: 5000 } });
 * ```
 */
export function retryFetch(input: FetchInput, init?: RetryRequestInit): Promise<Response> {
  return run(input, init, init?.retry ?? {});
}

/**
 * Creates a fetch-compatible function with default retry options. Options in
 * `init.retry` on a single call are merged over the defaults.
 *
 * ```ts
 * const api = createRetryFetch({ retries: 4, deadline: 20_000, circuitBreaker: new CircuitBreaker() });
 * const res = await api('https://api.example.com/items');
 * ```
 */
export function createRetryFetch(defaults: RetryOptions = {}): RetryFetch {
  return (input, init) => run(input, init, init?.retry ? { ...defaults, ...init.retry } : defaults);
}

function defaultSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Forwards an abort from `source` to `target`. */
function link(source: AbortSignal, target: AbortController) {
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const onAbort = () => target.abort(source.reason);
  source.addEventListener('abort', onAbort, { once: true });
  return () => source.removeEventListener('abort', onAbort);
}

function checkOptions(o: RetryOptions) {
  const retries = o.retries ?? 2;
  if (!Number.isInteger(retries) || retries < 0)
    throw new RangeError('retries must be a non-negative integer');
  for (const name of ['timeout', 'deadline', 'maxRetryAfter', 'minDelay', 'maxDelay'] as const) {
    const value = o[name];
    if (value !== undefined && (typeof value !== 'number' || Number.isNaN(value) || value < 0)) {
      throw new RangeError(`${name} must be a non-negative number`);
    }
  }
  return retries;
}

async function run(input: FetchInput, init: RetryRequestInit | undefined, options: RetryOptions) {
  const retries = checkOptions(options);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function')
    throw new TypeError('No fetch implementation found; pass options.fetch');
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const breaker = options.circuitBreaker;

  const { retry: _ignored, ...requestInit } = init ?? {};
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const request = isRequest ? (input as Request) : undefined;
  const userSignal = requestInit.signal ?? request?.signal ?? undefined;
  const method = (requestInit.method ?? request?.method ?? 'GET').toUpperCase();
  const url = request ? request.url : String(input);
  const headers = new Headers(requestInit.headers ?? request?.headers);

  const idempotencyHeader = options.idempotencyHeader ?? 'Idempotency-Key';
  const methodAllowed =
    options.retryNonIdempotent === true ||
    (options.methods ?? IDEMPOTENT_METHODS).some((m) => m.toUpperCase() === method) ||
    (idempotencyHeader !== false && headers.has(idempotencyHeader));
  const streamBody = typeof ReadableStream !== 'undefined' && requestInit.body instanceof ReadableStream;
  const maxAttempts = streamBody ? 1 : retries + 1;
  const statusCodes = options.statusCodes;
  const retryableStatus = (status: number) =>
    statusCodes ? statusCodes.includes(status) : isRetryableStatus(status);

  // One controller for the whole operation (caller's signal + deadline)...
  const operation = new AbortController();
  if (userSignal) link(userSignal, operation);
  let attempt = 0;
  const errors: unknown[] = [];
  let deadlineHit = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = options.deadline;
  if (deadline !== undefined) {
    deadlineTimer = setTimeout(() => {
      deadlineHit = true;
      operation.abort(new DeadlineExceededError(deadline, attempt, errors[errors.length - 1]));
    }, deadline);
  }
  const startedAt = Date.now();
  const deadlineAt = deadline === undefined ? Number.POSITIVE_INFINITY : startedAt + deadline;

  /** The error to throw once the operation signal has aborted. */
  const abortError = () => {
    if (userSignal?.aborted) return userSignal.reason;
    return new DeadlineExceededError(deadline ?? 0, attempt, errors[errors.length - 1]);
  };

  try {
    while (true) {
      if (operation.signal.aborted) throw abortError();
      breaker?.acquire();
      attempt++;

      // ...and one per attempt (operation + attempt timeout).
      const controller = new AbortController();
      const unlink = link(operation.signal, controller);
      let timedOut = false;
      let attemptTimer: ReturnType<typeof setTimeout> | undefined;
      if (options.timeout !== undefined) {
        const timeout = options.timeout;
        attemptTimer = setTimeout(() => {
          timedOut = true;
          controller.abort(new AttemptTimeoutError(timeout));
        }, timeout);
      }

      let response: Response | undefined;
      let error: unknown;
      let failed = false;
      // Cloned outside the try: a Request whose body was already used is the caller's error.
      const attemptInput = request ? request.clone() : input;
      try {
        response = await fetchImpl(attemptInput, { ...requestInit, signal: controller.signal });
      } catch (err) {
        failed = true;
        error = err;
      } finally {
        clearTimeout(attemptTimer);
      }

      let defaultRetry: boolean;
      if (failed) {
        if (userSignal?.aborted || deadlineHit) {
          breaker?.release();
          throw abortError();
        }
        if (timedOut) error = new AttemptTimeoutError(options.timeout ?? 0);
        breaker?.recordFailure();
        errors.push(error);
        defaultRetry = methodAllowed && (timedOut || error instanceof TypeError);
      } else {
        const status = response!.status;
        if (status >= 500) breaker?.recordFailure();
        else breaker?.recordSuccess();
        defaultRetry = methodAllowed && retryableStatus(status);
      }

      const context: RetryContext = failed
        ? { attempt, method, url, error }
        : { attempt, method, url, response: response! };
      let wantsRetry = defaultRetry;
      if (options.shouldRetry) {
        const decision = await options.shouldRetry(context);
        if (decision !== undefined) wantsRetry = decision;
      }

      const giveUp = () => {
        if (!failed) return finish(response!);
        if (wantsRetry) throw new RetriesExhaustedError(attempt, errors);
        throw error;
      };
      if (!wantsRetry || attempt >= maxAttempts) return giveUp();

      let delay = computeDelay(attempt, options, random);
      let fromRetryAfter = false;
      if (!failed && options.respectRetryAfter !== false) {
        const header = response!.headers.get('retry-after');
        const asked = parseRetryAfter(header);
        if (asked !== undefined) {
          if (asked > (options.maxRetryAfter ?? 60_000)) return giveUp();
          delay = asked;
          fromRetryAfter = true;
        }
      }
      if (Date.now() + delay >= deadlineAt) {
        if (!failed) return giveUp();
        throw new DeadlineExceededError(deadline ?? 0, attempt, error);
      }

      await options.onRetry?.({
        ...context,
        delay,
        retriesLeft: maxAttempts - attempt - 1,
        fromRetryAfter,
      });
      unlink();
      if (response) discard(response);
      try {
        await sleep(delay, operation.signal);
      } catch (err) {
        if (operation.signal.aborted) throw abortError();
        throw err;
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
  }

  function finish(response: Response) {
    if (options.throwHttpErrors && !response.ok) throw new HttpError(response, attempt);
    return response;
  }
}

/**
 * Frees the connection of a response that will not be read. Not awaited: the
 * cancel promise of a cloned (teed) body only settles once every branch is
 * cancelled, which may never happen.
 */
function discard(response: Response) {
  try {
    response.body?.cancel().catch(() => {});
  } catch {
    // The body is locked or already used; nothing to free.
  }
}
