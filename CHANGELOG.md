# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `RateLimit-Reset` and `X-RateLimit-Reset` are used as the wait when a
  retryable response has no usable `Retry-After` (delta-seconds, or a Unix
  timestamp for values of 1 000 000 000 and up), capped by `maxRetryAfter`.
  Turn it off with `respectRateLimitReset: false`.
- `parseRateLimitReset(headers, now?)` helper.
- `RetryInfo.delaySource` tells `onRetry` whether the wait came from backoff,
  `Retry-After` or a rate-limit reset header.

## [0.1.0] - 2026-11-19

### Added

- `retryFetch()` and `createRetryFetch()`: fetch-compatible functions with
  retries, configured through `init.retry` or defaults.
- Exponential backoff with `full`, `equal` or no jitter (`computeDelay()`).
- Retries on network errors, attempt timeouts and statuses 408, 425, 429 and
  5xx except 501 and 505, or a custom `statusCodes` list.
- Idempotency rules: only idempotent methods are retried unless the request
  has an `Idempotency-Key` header, `methods` or `retryNonIdempotent` is set;
  `ReadableStream` bodies are never retried; `Request` inputs are cloned per
  attempt.
- `Retry-After` support (seconds and HTTP dates, `parseRetryAfter()`) with
  `maxRetryAfter`.
- Per-attempt `timeout` and overall `deadline` through `AbortSignal`; the
  caller's `signal` cancels attempts and waits.
- `onRetry` and `shouldRetry` hooks.
- `CircuitBreaker` with closed, open and half-open states.
- Typed errors with stable codes: `AttemptTimeoutError`,
  `DeadlineExceededError`, `RetriesExhaustedError`, `CircuitOpenError` and
  `HttpError`, all extending `RetryFetchError`.
- ESM and CommonJS builds with type declarations; no runtime dependencies.

[Unreleased]: https://github.com/saizul/retry-fetch/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saizul/retry-fetch/releases/tag/v0.1.0
