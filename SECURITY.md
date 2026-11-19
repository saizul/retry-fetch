# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's
private vulnerability reporting ("Report a vulnerability" under the
repository's **Security** tab). You will get an answer within a week.

## Scope

retry-fetch sits between your code and the network. Reports in these areas
are especially welcome:

- **Unsafe retries.** Any way a request with a non-idempotent method (POST,
  PATCH) and no `Idempotency-Key` header is sent more than once with the
  default options, or a stream body is re-sent.
- **Unbounded waits or loops.** A `Retry-After` value, status or option
  combination that makes retries exceed `retries`, `maxRetryAfter` or the
  `deadline`, or that keeps timers or sockets alive after the promise settles.
- **Cancellation gaps.** A case where aborting the caller's `signal` does
  not stop the current attempt and every future one.

## What retry-fetch is not

It does not add authentication, TLS settings or request signing; those
belong to the `fetch` you wrap. Retrying replays the request as it was,
including its headers, so short-lived signatures may expire between
attempts.
