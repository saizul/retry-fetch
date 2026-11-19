# Contributing

Thanks for helping improve retry-fetch. Bug reports with a reproducible
failure, new retry strategies, documentation fixes and tests for odd
runtimes are all welcome. If you are new to open source, start with one of
the [beginner issues](#good-first-issues) below; each is small and comes
with pointers to the files involved.

## Reporting a bug

Open an issue with:

- the call you made (URL can be fake) and the `retry` options
- what the server returned on each attempt (status, `Retry-After`), or the
  error, and what you expected to happen
- your retry-fetch version, runtime and version (`node --version`, browser,
  Deno, Bun, Workers)

## Development setup

You need Node 20 or newer.

```console
$ git clone https://github.com/saizul/retry-fetch.git
$ cd retry-fetch
$ npm ci
$ npm test              # builds ESM + CJS, compiles the tests and runs node:test
$ npm run lint          # biome lint + tsc --noEmit
$ npm run format        # biome format --write
$ npm run format:check  # what CI runs
```

Run the examples against the build:

```console
$ node examples/basic.mjs
$ node examples/circuit-breaker.mjs
```

## Guidelines

- **Zero runtime dependencies**, and **no Node APIs in `src/`**: the
  library must run in browsers and edge runtimes. Use only `fetch`,
  `AbortController`, `setTimeout` and other web-standard globals. A test
  checks that the build imports no `node:` modules.
- **No network in tests.** Use the `mockFetch()` and `hangingFetch()`
  helpers in `test/helpers.ts`, or the local `node:http` server in
  `test/http.test.ts`.
- **No real waits.** Pass `sleep` from `instantSleep()` to record delays
  instead of waiting; keep real timeouts in tests under 50 ms.
- **Error codes are public API.** Do not rename them outside a major
  release.
- Every change comes with a test and a line in the `Unreleased` section of
  `CHANGELOG.md`.

## Project layout

```text
src/
  retry-fetch.ts      retryFetch(), createRetryFetch(), the retry loop
  backoff.ts          computeDelay()
  retry-after.ts      parseRetryAfter()
  circuit-breaker.ts  CircuitBreaker
  errors.ts           error classes and codes
test/                 node:test suites and helpers
examples/             runnable ESM and CommonJS examples (local server, no network)
```

## Good first issues

These are deliberately small. Each one lists where to start.

1. **Decorrelated jitter**: add `jitter: 'decorrelated'`
   (`min(maxDelay, random(minDelay, previous * 3))`) to `src/backoff.ts`.
   It needs the previous delay, so pass it from the loop in
   `src/retry-fetch.ts`. Test it in `test/backoff.test.ts`.
2. **`RateLimit-Reset` fallback**: when there is no `Retry-After`, read
   `RateLimit-Reset` (delta seconds) on 429 responses. Change the
   Retry-After block in `src/retry-fetch.ts` and add tests next to the
   existing Retry-After tests.
3. **`onAttempt` hook**: call `onAttempt({ attempt, duration, status, error })`
   after every attempt, for metrics. Add the option type in
   `src/retry-fetch.ts` and document it in the README options table.
4. **`maxAttempts` alias**: some users think in attempts, not retries.
   Accept `maxAttempts` (`retries + 1`) and throw a `RangeError` if both are
   given. Change `checkOptions()` in `src/retry-fetch.ts`.
5. **Example with `undici` dispatcher**: add `examples/undici-agent.mjs`
   showing how to pass a `fetch` bound to a custom keep-alive agent (as a
   comment-only snippet if you do not want a dependency).
6. **Deno and Bun smoke test**: add a CI job that runs
   `examples/basic.mjs` with `deno run` and `bun` to prove the runtimes
   work. Edit `.github/workflows/ci.yml`.
7. **Error `toJSON()`**: add `toJSON()` to `RetryFetchError` in
   `src/errors.ts` returning `name`, `code`, `message` and the class's own
   fields, so errors log nicely.
8. **README recipe for React Query / SWR**: a short section showing
   `createRetryFetch` with `retries: 0` in the library and retries in the
   wrapper, and why you should not retry in both.

## Pull requests

Keep them focused: one fix or feature per pull request. Describe what
changed and how you tested it; the template has a short checklist. CI runs
lint, format check and the tests on Node 20 and 22 on Linux, and Node 22
on Windows and macOS.
