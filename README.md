# retry-fetch

[![CI](https://github.com/saizul/retry-fetch/actions/workflows/ci.yml/badge.svg)](https://github.com/saizul/retry-fetch/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/saizul/retry-fetch)](https://github.com/saizul/retry-fetch/releases)
[![npm (GitHub Packages)](https://img.shields.io/badge/npm-%40saizul%2Fretry--fetch-blue)](https://github.com/saizul/retry-fetch/pkgs/npm/retry-fetch)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![TypeScript](https://img.shields.io/badge/types-included-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

`fetch`, but it survives flaky networks, 503s and rate limits, without retrying the requests that must not be retried.

- **Drop-in**: same arguments, same `Response`. Works with the global `fetch` in Node 20+, browsers, Deno, Bun, Cloudflare Workers and other edge runtimes.
- **Exponential backoff with full jitter** (the AWS recommendation), with caps.
- **Honours `Retry-After`** (seconds or HTTP date) on 429 and 503, and gives up if the server asks for an unreasonable wait.
- **Idempotency-aware**: only GET, HEAD, OPTIONS, TRACE, PUT and DELETE are retried, unless the request carries an `Idempotency-Key` header or you opt in. Stream bodies are never re-sent.
- **Per-attempt timeout and an overall deadline**, both through `AbortSignal`, and your own `signal` still cancels everything.
- **`onRetry` hook**, a `shouldRetry` override, a small **circuit breaker** and **typed errors** with stable codes.
- Zero runtime dependencies. ESM, CommonJS and type declarations.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [What is retried](#what-is-retried)
- [Options](#options)
- [Errors](#errors)
- [Circuit breaker](#circuit-breaker)
- [Helpers](#helpers)
- [Examples](#examples)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)

## Install

The package is published to GitHub Packages. Tell npm where `@saizul` packages live, once per project:

```console
$ echo "@saizul:registry=https://npm.pkg.github.com" >> .npmrc
$ npm install @saizul/retry-fetch
```

## Quick start

```ts
import { retryFetch } from '@saizul/retry-fetch';

// Same as fetch(), plus up to 2 retries with jittered backoff.
const res = await retryFetch('https://api.example.com/items');

// With options: 4 retries, 5 s per attempt, 20 s overall.
const items = await retryFetch('https://api.example.com/items', {
  headers: { Accept: 'application/json' },
  retry: { retries: 4, timeout: 5_000, deadline: 20_000 },
}).then((r) => r.json());
```

Make a configured client once and use it everywhere:

```ts
import { CircuitBreaker, createRetryFetch } from '@saizul/retry-fetch';

export const api = createRetryFetch({
  retries: 3,
  timeout: 5_000,
  deadline: 30_000,
  circuitBreaker: new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30_000 }),
  onRetry: ({ attempt, delay, error, response }) =>
    console.warn(`retry #${attempt} in ${delay} ms`, response?.status ?? error),
});

const res = await api('https://api.example.com/orders', {
  method: 'POST',
  headers: { 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': 'application/json' },
  body: JSON.stringify({ sku: 'A-1' }),
  retry: { retries: 5 }, // per-call options override the defaults
});
```

CommonJS works too: `const { retryFetch } = require('@saizul/retry-fetch')`.

## What is retried

An attempt is retried when **all** of these hold:

1. **The outcome is retryable**: a network error (fetch rejected with a `TypeError`), an attempt timeout, or a response status in `statusCodes`. The default status list is **408, 425, 429 and every 5xx except 501 and 505**.
2. **The method is safe to repeat**: GET, HEAD, OPTIONS, TRACE, PUT or DELETE; or the request has an `Idempotency-Key` header; or you set `retryNonIdempotent: true` or `methods`.
3. **The body can be sent again**: a `ReadableStream` body is never retried. Strings, `URLSearchParams`, `FormData`, `Blob` and `ArrayBuffer` bodies are fine, and a `Request` input is cloned for each attempt.
4. **There is time**: retries are left, and the next wait ends before the `deadline`.

`shouldRetry` can override 1 and 2. Your own `signal` aborting is never retried: the promise rejects with the signal's reason, exactly like `fetch`.

The wait before retry *n* is `random() * min(maxDelay, minDelay * factor^(n-1))` (full jitter), so with the defaults about 0-250 ms, 0-500 ms, 0-1 s... If a retryable response has a `Retry-After` header, that wait is used instead; if it is longer than `maxRetryAfter` (60 s), the response is returned straight away.

When retries run out on a response, **the last response is returned** (like `fetch`, a 503 is not an exception) unless `throwHttpErrors` is set. Bodies of responses that are retried are cancelled so connections are freed.

## Options

All options go in `init.retry` for `retryFetch`, or in the defaults of `createRetryFetch`.

| Option | Default | Description |
| --- | --- | --- |
| `retries` | `2` | Retries after the first attempt. |
| `minDelay` | `250` | Base wait in ms before jitter. |
| `maxDelay` | `10000` | Upper bound for a computed wait. |
| `factor` | `2` | Growth per retry. |
| `jitter` | `'full'` | `'full'`, `'equal'` (half fixed, half random) or `'none'`. |
| `statusCodes` | see above | Statuses to retry, replacing the default list. |
| `methods` | idempotent methods | Methods to retry. |
| `retryNonIdempotent` | `false` | Retry every method. |
| `idempotencyHeader` | `'Idempotency-Key'` | Requests with this header are retried whatever the method. `false` turns it off. |
| `respectRetryAfter` | `true` | Use the `Retry-After` header as the wait. |
| `maxRetryAfter` | `60000` | Longest `Retry-After` wait accepted; longer means give up. |
| `timeout` | none | Limit in ms for each attempt, until the response headers arrive. |
| `deadline` | none | Limit in ms for the whole operation, waits included. |
| `shouldRetry` | none | `(ctx) => boolean \| undefined`, may be async. `undefined` keeps the default decision. |
| `onRetry` | none | `(info) => void`, may be async. Called before each wait with `attempt`, `delay`, `retriesLeft`, `fromRetryAfter`, `method`, `url` and `error` or `response`. Throwing stops retrying. |
| `circuitBreaker` | none | A `CircuitBreaker` instance. |
| `throwHttpErrors` | `false` | Throw `HttpError` when the final response is not ok. |
| `fetch` | `globalThis.fetch` | The fetch to wrap, e.g. a mock or a fetch with a custom dispatcher. |
| `random` | `Math.random` | Random source for jitter. |
| `sleep` | `setTimeout` based | `(ms, signal) => Promise<void>`, for tests. |

The timeouts cover the time until the response *headers* arrive; reading the body is up to you (pass your own `signal` to limit it, it stays connected).

## Errors

Every error from this package extends `RetryFetchError` and has a stable `code`.

| Class | `code` | When | Retried? |
| --- | --- | --- | --- |
| `AttemptTimeoutError` | `TIMEOUT` | One attempt passed `timeout` (`err.timeout`). | Yes, for retryable methods |
| `DeadlineExceededError` | `DEADLINE_EXCEEDED` | The `deadline` passed, or the next wait would end after it. `err.cause` is the last error. | No |
| `RetriesExhaustedError` | `RETRIES_EXHAUSTED` | Every attempt failed with a retryable error. `err.errors` holds them all, `err.cause` the last. | - |
| `CircuitOpenError` | `CIRCUIT_OPEN` | The circuit breaker is open; nothing was sent. `err.retryAfter` in ms. | No |
| `HttpError` | `HTTP_ERROR` | Only with `throwHttpErrors`: the final response is not ok. `err.response`, `err.status`. | - |

Errors that are not retryable (a POST that hit a network error, a bug in a custom `fetch`, your own abort) are passed through unchanged, so existing `catch` blocks keep working.

```ts
import { RetryFetchError } from '@saizul/retry-fetch';

try {
  await api(url);
} catch (err) {
  if (err instanceof RetryFetchError && err.code === 'CIRCUIT_OPEN') return cachedValue();
  throw err;
}
```

## Circuit breaker

```ts
const breaker = new CircuitBreaker({
  failureThreshold: 5, // consecutive failures that open the circuit
  resetTimeout: 30_000, // how long it stays open
  halfOpenRequests: 1, // trial requests allowed when half-open
  onStateChange: (state, previous) => log(`upstream circuit ${previous} -> ${state}`),
});
```

Every attempt counts: a network error, a timeout or a 5xx response is a failure; any other response is a success and resets the count. While open, calls throw `CircuitOpenError` without touching the network. After `resetTimeout` one trial request goes through: success closes the circuit, failure opens it again. Use one breaker per upstream service and share it between calls. `breaker.state`, `breaker.failures` and `breaker.reset()` are public, and `acquire()`, `recordSuccess()`, `recordFailure()` and `release()` let you use it around any other async call.

## Helpers

- `computeDelay(retry, options?, random?)`: the backoff formula above.
- `parseRetryAfter(value, now?)`: `Retry-After` header to milliseconds, or `undefined`.
- `isRetryableStatus(status)`: the default status rule.
- `IDEMPOTENT_METHODS`: the default method list.

## Examples

Runnable scripts in [`examples/`](examples) start their own local server, so they need no network:

- [`basic.mjs`](examples/basic.mjs): retries two 503s and logs each retry.
- [`circuit-breaker.mjs`](examples/circuit-breaker.mjs): a dead upstream opens the breaker.
- [`commonjs.cjs`](examples/commonjs.cjs): the CommonJS build.

Testing your own code: pass `fetch` to inject a mock and `sleep: async () => {}` to skip the waits.

## FAQ

**Why not retry POST by default?** A POST that timed out may have been processed. Retrying it can charge a card twice. Send an `Idempotency-Key` (and have the server honour it), or opt in with `methods` or `retryNonIdempotent` if you know the endpoint is safe.

**Does it retry on 4xx?** Only 408, 425 and 429, which mean "try again later". Use `statusCodes` or `shouldRetry` for anything else.

**Why full jitter?** When many clients fail at once, fixed backoff makes them retry at the same instants. Spreading the waits uniformly gives the server room to recover.

**Does it work with `undici`, `node-fetch` or a mocked fetch?** Yes: pass it as `fetch`. It only needs the standard `fetch(input, init)` signature.

**Why is the response not an error after the last retry?** That is what `fetch` does, so existing code that checks `res.ok` keeps working. Set `throwHttpErrors: true` if you prefer exceptions.

**Is the response body covered by `timeout`?** No, only the wait for the headers. Large downloads should not be cut off by a request timeout; use your own `signal` for that.

## Roadmap

Ideas for the next versions. Those marked *good first issue* are small and described in [CONTRIBUTING.md](CONTRIBUTING.md#good-first-issues).

- Read `RateLimit-Reset` / `X-RateLimit-Reset` as a fallback for `Retry-After` (*good first issue*)
- A `retryBudget` to cap the ratio of retries to requests across calls
- `onAttempt` hook with timing for metrics (*good first issue*)
- A `jitter: 'decorrelated'` strategy (*good first issue*)
- Optional body timeout helper

## Contributing

Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the checks CI runs and a list of beginner-friendly issues. Please follow the [code of conduct](CODE_OF_CONDUCT.md) and report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Saizul Amin
