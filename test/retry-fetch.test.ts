import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AttemptTimeoutError,
  CircuitBreaker,
  CircuitOpenError,
  createRetryFetch,
  DeadlineExceededError,
  HttpError,
  isRetryableStatus,
  RetriesExhaustedError,
  type RetryInfo,
  type RetryOptions,
  retryFetch,
} from '../src/index.js';
import { hangingFetch, instantSleep, mockFetch, status } from './helpers.js';

const URL_ = 'https://api.example.test/items';

function setup(steps: Parameters<typeof mockFetch>[0], extra: RetryOptions = {}) {
  const mock = mockFetch(steps);
  const timing = instantSleep();
  const retries: RetryInfo[] = [];
  const options: RetryOptions = {
    fetch: mock.fetch,
    sleep: timing.sleep,
    random: () => 0.5,
    onRetry: (info) => {
      retries.push(info);
    },
    ...extra,
  };
  return { ...mock, ...timing, retries, options };
}

const networkError = () => new TypeError('fetch failed');

describe('retryFetch: responses', () => {
  it('returns the first ok response without retrying', async () => {
    const t = setup([status(200)]);
    const res = await retryFetch(URL_, { retry: t.options });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'status 200');
    assert.equal(t.calls.length, 1);
  });

  it('retries a 503 and returns the later success', async () => {
    const t = setup([status(503), status(502), status(200)]);
    const res = await retryFetch(URL_, { retry: t.options });
    assert.equal(res.status, 200);
    assert.equal(t.calls.length, 3);
    assert.deepEqual(t.delays, [125, 250]);
    assert.deepEqual(
      t.retries.map((r) => [r.attempt, r.response?.status, r.delay, r.retriesLeft, r.method, r.url]),
      [
        [1, 503, 125, 1, 'GET', URL_],
        [2, 502, 250, 0, 'GET', URL_],
      ],
    );
  });

  it('returns the last response when retries run out', async () => {
    const t = setup([status(500)], { retries: 3 });
    const res = await retryFetch(URL_, { retry: t.options });
    assert.equal(res.status, 500);
    assert.equal(t.calls.length, 4);
  });

  it('throws HttpError for a final non-ok response with throwHttpErrors', async () => {
    const t = setup([status(503)], { throwHttpErrors: true, retries: 1 });
    await assert.rejects(
      retryFetch(URL_, { retry: t.options }),
      (err: unknown) =>
        err instanceof HttpError && err.status === 503 && err.attempts === 2 && err.code === 'HTTP_ERROR',
    );
  });

  it('does not retry statuses outside the list', async () => {
    for (const code of [400, 401, 404, 409, 422, 501, 505]) {
      const t = setup([status(code), status(200)]);
      const res = await retryFetch(URL_, { retry: t.options });
      assert.equal(res.status, code);
      assert.equal(t.calls.length, 1, String(code));
    }
  });

  it('accepts a custom status list', async () => {
    const t = setup([status(409), status(200)], { statusCodes: [409] });
    assert.equal((await retryFetch(URL_, { retry: t.options })).status, 200);
    const u = setup([status(503), status(200)], { statusCodes: [409] });
    assert.equal((await retryFetch(URL_, { retry: u.options })).status, 503);
  });

  it('the default status check matches the documentation', () => {
    const yes = [408, 425, 429, 500, 502, 503, 504, 507, 520, 599];
    const no = [200, 301, 400, 404, 418, 501, 505, 600];
    for (const s of yes) assert.equal(isRetryableStatus(s), true, String(s));
    for (const s of no) assert.equal(isRetryableStatus(s), false, String(s));
  });

  it('cancels the body of responses it will not return', async () => {
    let cancelled = 0;
    const body = () =>
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      });
    const t = setup([
      async () => new Response(body(), { status: 503 }),
      async () => new Response(body(), { status: 503 }),
      async () => new Response('ok'),
    ]);
    await retryFetch(URL_, { retry: t.options });
    assert.equal(cancelled, 2);
  });
});

describe('retryFetch: network errors', () => {
  it('retries network errors', async () => {
    const t = setup([networkError(), status(200)]);
    const res = await retryFetch(URL_, { retry: t.options });
    assert.equal(res.status, 200);
    assert.ok(t.retries[0]!.error instanceof TypeError);
  });

  it('throws RetriesExhaustedError with every error when they all fail', async () => {
    const t = setup([networkError()], { retries: 2 });
    await assert.rejects(retryFetch(URL_, { retry: t.options }), (err: unknown) => {
      assert.ok(err instanceof RetriesExhaustedError);
      assert.equal(err.attempts, 3);
      assert.equal(err.errors.length, 3);
      assert.ok(err.cause instanceof TypeError);
      assert.equal(err.code, 'RETRIES_EXHAUSTED');
      assert.match(err.message, /after 3 attempt\(s\): fetch failed/);
      return true;
    });
  });

  it('does not retry errors that are not network errors', async () => {
    const boom = new Error('bug in a custom fetch');
    const t = setup([boom, status(200)]);
    await assert.rejects(retryFetch(URL_, { retry: t.options }), (err) => err === boom);
    assert.equal(t.calls.length, 1);
  });
});

describe('retryFetch: idempotency', () => {
  it('does not retry POST by default', async () => {
    const t = setup([status(503), status(200)]);
    const res = await retryFetch(URL_, { method: 'POST', body: '{}', retry: t.options });
    assert.equal(res.status, 503);
    assert.equal(t.calls.length, 1);
  });

  it('passes a POST network error through unchanged', async () => {
    const err = networkError();
    const t = setup([err, status(200)]);
    await assert.rejects(retryFetch(URL_, { method: 'post', retry: t.options }), (e) => e === err);
  });

  it('retries PUT, DELETE, HEAD and OPTIONS', async () => {
    for (const method of ['PUT', 'DELETE', 'HEAD', 'OPTIONS', 'get']) {
      const t = setup([status(503), status(204)]);
      assert.equal((await retryFetch(URL_, { method, retry: t.options })).status, 204, method);
    }
  });

  it('retries any method that carries an Idempotency-Key header', async () => {
    const t = setup([status(503), status(201)]);
    const res = await retryFetch(URL_, {
      method: 'POST',
      headers: { 'idempotency-key': 'order-42' },
      body: '{}',
      retry: t.options,
    });
    assert.equal(res.status, 201);
    assert.equal(t.calls.length, 2);
    assert.equal(t.calls[1]!.init.body, '{}');
  });

  it('idempotencyHeader can be renamed or turned off', async () => {
    const t = setup([status(503), status(201)], { idempotencyHeader: 'X-Request-Id' });
    const init = { method: 'POST', headers: { 'X-Request-Id': '1' } };
    assert.equal((await retryFetch(URL_, { ...init, retry: t.options })).status, 201);
    const u = setup([status(503), status(201)], { idempotencyHeader: false });
    const res = await retryFetch(URL_, {
      method: 'POST',
      headers: { 'Idempotency-Key': '1' },
      retry: u.options,
    });
    assert.equal(res.status, 503);
  });

  it('retryNonIdempotent and methods opt other methods in', async () => {
    const t = setup([status(503), status(200)], { retryNonIdempotent: true });
    assert.equal((await retryFetch(URL_, { method: 'PATCH', retry: t.options })).status, 200);
    const u = setup([status(503), status(200)], { methods: ['POST'] });
    assert.equal((await retryFetch(URL_, { method: 'POST', retry: u.options })).status, 200);
    const v = setup([status(503), status(200)], { methods: ['POST'] });
    assert.equal((await retryFetch(URL_, { method: 'GET', retry: v.options })).status, 503);
  });

  it('never retries a ReadableStream body, which cannot be sent twice', async () => {
    const t = setup([status(503), status(200)], { retryNonIdempotent: true });
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('x'));
        c.close();
      },
    });
    const res = await retryFetch(URL_, { method: 'POST', body, retry: t.options });
    assert.equal(res.status, 503);
    assert.equal(t.calls.length, 1);
  });

  it('reads method, headers and signal from a Request and sends a fresh clone each time', async () => {
    const bodies: string[] = [];
    const t = setup([
      async (input) => {
        bodies.push(await (input as Request).text());
        return status(503);
      },
      async (input) => {
        bodies.push(await (input as Request).text());
        return status(200);
      },
    ]);
    const request = new Request(URL_, {
      method: 'POST',
      body: 'payload',
      headers: { 'Idempotency-Key': 'abc' },
    });
    const res = await retryFetch(request, { retry: t.options });
    assert.equal(res.status, 200);
    assert.deepEqual(bodies, ['payload', 'payload']);
    assert.equal(request.bodyUsed, false);
    assert.equal(t.retries[0]!.method, 'POST');
  });
});

describe('retryFetch: Retry-After', () => {
  it('waits as long as Retry-After asks', async () => {
    const t = setup([status(429, { 'Retry-After': '3' }), status(200)]);
    await retryFetch(URL_, { retry: t.options });
    assert.deepEqual(t.delays, [3000]);
    assert.equal(t.retries[0]!.fromRetryAfter, true);
  });

  it('accepts an HTTP date', async () => {
    const at = new Date(Date.now() + 60_000).toUTCString();
    const t = setup([status(503, { 'Retry-After': at }), status(200)]);
    await retryFetch(URL_, { retry: t.options });
    assert.ok(t.delays[0]! > 55_000 && t.delays[0]! <= 60_000, String(t.delays[0]));
  });

  it('gives up and returns the response when the wait is longer than maxRetryAfter', async () => {
    const t = setup([status(429, { 'Retry-After': '120' }), status(200)]);
    const res = await retryFetch(URL_, { retry: t.options });
    assert.equal(res.status, 429);
    assert.equal(t.calls.length, 1);
    const u = setup([status(429, { 'Retry-After': '120' }), status(200)], { maxRetryAfter: 200_000 });
    assert.equal((await retryFetch(URL_, { retry: u.options })).status, 200);
  });

  it('can be ignored', async () => {
    const t = setup([status(429, { 'Retry-After': '120' }), status(200)], { respectRetryAfter: false });
    assert.equal((await retryFetch(URL_, { retry: t.options })).status, 200);
    assert.deepEqual(t.delays, [125]);
  });

  it('falls back to backoff for a malformed header', async () => {
    const t = setup([status(503, { 'Retry-After': 'later' }), status(200)]);
    await retryFetch(URL_, { retry: t.options });
    assert.deepEqual(t.delays, [125]);
    assert.equal(t.retries[0]!.delaySource, 'backoff');
  });
});

describe('retryFetch: rate-limit reset headers', () => {
  it('waits for RateLimit-Reset (delta seconds) when there is no Retry-After', async () => {
    const t = setup([status(429, { 'RateLimit-Reset': '4' }), status(200)]);
    assert.equal((await retryFetch(URL_, { retry: t.options })).status, 200);
    assert.deepEqual(t.delays, [4000]);
    assert.equal(t.retries[0]!.delaySource, 'rate-limit-reset');
    assert.equal(t.retries[0]!.fromRetryAfter, false);
  });

  it('reads X-RateLimit-Reset as a Unix timestamp', async () => {
    const reset = Math.ceil(Date.now() / 1000) + 20;
    const t = setup([status(429, { 'X-RateLimit-Reset': String(reset) }), status(200)]);
    await retryFetch(URL_, { retry: t.options });
    assert.ok(t.delays[0]! > 15_000 && t.delays[0]! <= 21_000, String(t.delays[0]));
  });

  it('prefers Retry-After over the reset headers', async () => {
    const t = setup([status(429, { 'Retry-After': '2', 'RateLimit-Reset': '9' }), status(200)]);
    await retryFetch(URL_, { retry: t.options });
    assert.deepEqual(t.delays, [2000]);
    assert.equal(t.retries[0]!.delaySource, 'retry-after');
  });

  it('gives up when the reset is further away than maxRetryAfter', async () => {
    const t = setup([status(429, { 'RateLimit-Reset': '600' }), status(200)]);
    assert.equal((await retryFetch(URL_, { retry: t.options })).status, 429);
    assert.equal(t.calls.length, 1);
  });

  it('can be turned off with respectRateLimitReset or respectRetryAfter', async () => {
    const t = setup([status(429, { 'RateLimit-Reset': '4' }), status(200)], { respectRateLimitReset: false });
    await retryFetch(URL_, { retry: t.options });
    assert.deepEqual(t.delays, [125]);
    const u = setup([status(429, { 'RateLimit-Reset': '4' }), status(200)], { respectRetryAfter: false });
    await retryFetch(URL_, { retry: u.options });
    assert.deepEqual(u.delays, [125]);
  });
});

describe('retryFetch: hooks', () => {
  it('shouldRetry can force or veto a retry', async () => {
    const t = setup([status(404), status(200)], {
      shouldRetry: ({ response }) => (response?.status === 404 ? true : undefined),
    });
    assert.equal((await retryFetch(URL_, { retry: t.options })).status, 200);
    const u = setup([status(503), status(200)], { shouldRetry: () => false });
    assert.equal((await retryFetch(URL_, { retry: u.options })).status, 503);
  });

  it('a vetoed network error is thrown unchanged', async () => {
    const err = networkError();
    const t = setup([err], { shouldRetry: async () => false });
    await assert.rejects(retryFetch(URL_, { retry: t.options }), (e) => e === err);
  });

  it('an error thrown by onRetry stops retrying', async () => {
    const stop = new Error('stop');
    const t = setup([status(503), status(200)], {
      onRetry: () => {
        throw stop;
      },
    });
    await assert.rejects(retryFetch(URL_, { retry: t.options }), (e) => e === stop);
    assert.equal(t.calls.length, 1);
  });

  it('removes the retry field before calling fetch', async () => {
    const t = setup([status(200)]);
    await retryFetch(URL_, { headers: { a: '1' }, retry: t.options });
    assert.equal('retry' in t.calls[0]!.init, false);
    assert.ok(t.calls[0]!.init.signal instanceof AbortSignal);
    assert.deepEqual(t.calls[0]!.init.headers, { a: '1' });
  });
});

describe('retryFetch: cancellation and time limits', () => {
  it('rejects with the abort reason when the caller aborts before starting', async () => {
    const t = setup([status(200)]);
    const reason = new Error('user left');
    await assert.rejects(
      retryFetch(URL_, { signal: AbortSignal.abort(reason), retry: t.options }),
      (e) => e === reason,
    );
    assert.equal(t.calls.length, 0);
  });

  it('stops waiting when the caller aborts between attempts', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const t = setup([status(503), status(200)], {
      onRetry: () => controller.abort(reason),
    });
    await assert.rejects(
      retryFetch(URL_, { signal: controller.signal, retry: t.options }),
      (e) => e === reason,
    );
    assert.equal(t.calls.length, 1);
  });

  it('aborts the running attempt when the caller aborts', async () => {
    const hanging = hangingFetch();
    const controller = new AbortController();
    const reason = new Error('cancelled');
    setTimeout(() => controller.abort(reason), 10);
    await assert.rejects(
      retryFetch(URL_, { signal: controller.signal, retry: { fetch: hanging.fetch } }),
      (e) => e === reason,
    );
    assert.equal(hanging.calls, 1);
  });

  it('times out each attempt and retries it', async () => {
    const hanging = hangingFetch();
    const timing = instantSleep();
    await assert.rejects(
      retryFetch(URL_, { retry: { fetch: hanging.fetch, timeout: 15, retries: 2, sleep: timing.sleep } }),
      (err: unknown) => {
        assert.ok(err instanceof RetriesExhaustedError);
        assert.ok(err.cause instanceof AttemptTimeoutError);
        assert.equal((err.cause as AttemptTimeoutError).timeout, 15);
        return true;
      },
    );
    assert.equal(hanging.calls, 3);
  });

  it('a timed-out attempt can succeed on retry', async () => {
    const hanging = hangingFetch();
    let n = 0;
    const fetchImpl = ((input: unknown, init: RequestInit) =>
      ++n === 1 ? hanging.fetch(input as string, init) : Promise.resolve(status(200))) as typeof fetch;
    const res = await retryFetch(URL_, { retry: { fetch: fetchImpl, timeout: 10, minDelay: 1 } });
    assert.equal(res.status, 200);
  });

  it('a POST that times out is not retried and throws AttemptTimeoutError', async () => {
    const hanging = hangingFetch();
    await assert.rejects(
      retryFetch(URL_, { method: 'POST', retry: { fetch: hanging.fetch, timeout: 10 } }),
      AttemptTimeoutError,
    );
    assert.equal(hanging.calls, 1);
  });

  it('throws DeadlineExceededError when the deadline passes during an attempt', async () => {
    const hanging = hangingFetch();
    await assert.rejects(
      retryFetch(URL_, { retry: { fetch: hanging.fetch, deadline: 20, timeout: 1000 } }),
      (err: unknown) => err instanceof DeadlineExceededError && err.deadline === 20 && err.attempts === 1,
    );
  });

  it('throws DeadlineExceededError when the deadline passes during a wait', async () => {
    const t = mockFetch([networkError()]);
    await assert.rejects(
      retryFetch(URL_, { retry: { fetch: t.fetch, deadline: 30, minDelay: 20, jitter: 'none', retries: 5 } }),
      DeadlineExceededError,
    );
  });

  it('returns the response instead of waiting past the deadline', async () => {
    const t = setup([status(429, { 'Retry-After': '10' }), status(200)], { deadline: 5000 });
    const res = await retryFetch(URL_, { retry: t.options });
    assert.equal(res.status, 429);
    assert.equal(t.calls.length, 1);
  });

  it('a network error that cannot wait for the next attempt reports the deadline', async () => {
    const t = setup([networkError()], { deadline: 100, minDelay: 1000, jitter: 'none' });
    await assert.rejects(retryFetch(URL_, { retry: t.options }), (err: unknown) => {
      return err instanceof DeadlineExceededError && err.cause instanceof TypeError;
    });
  });

  it('validates options', async () => {
    await assert.rejects(retryFetch(URL_, { retry: { retries: -1 } }), RangeError);
    await assert.rejects(retryFetch(URL_, { retry: { timeout: Number.NaN } }), RangeError);
  });
});

describe('retryFetch: circuit breaker', () => {
  it('fails fast without calling fetch once the circuit opens', async () => {
    let t = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 1000, now: () => t });
    const m = setup([status(503)], { circuitBreaker: breaker, retries: 1 });
    assert.equal((await retryFetch(URL_, { retry: m.options })).status, 503);
    assert.equal(breaker.failures, 2);
    await assert.rejects(retryFetch(URL_, { retry: m.options }), CircuitOpenError);
    assert.equal(m.calls.length, 3);
    assert.equal(breaker.state, 'open');
    await assert.rejects(retryFetch(URL_, { retry: m.options }), CircuitOpenError);
    assert.equal(m.calls.length, 3);
    t = 1000;
    const ok = setup([status(200)], { circuitBreaker: breaker });
    assert.equal((await retryFetch(URL_, { retry: ok.options })).status, 200);
    assert.equal(breaker.state, 'closed');
  });

  it('4xx responses count as successes', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const m = setup([status(429)], { circuitBreaker: breaker, retries: 0 });
    await retryFetch(URL_, { retry: m.options });
    assert.equal(breaker.state, 'closed');
  });

  it('a caller abort does not use up the half-open trial', async () => {
    let t = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 10, now: () => t });
    breaker.recordFailure();
    t = 10;
    const hanging = hangingFetch();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(
      retryFetch(URL_, {
        signal: controller.signal,
        retry: { fetch: hanging.fetch, circuitBreaker: breaker },
      }),
    );
    const ok = setup([status(200)], { circuitBreaker: breaker });
    assert.equal((await retryFetch(URL_, { retry: ok.options })).status, 200);
  });
});

describe('createRetryFetch', () => {
  it('applies defaults and lets a call override them', async () => {
    const m = mockFetch([status(503)]);
    const timing = instantSleep();
    const api = createRetryFetch({ fetch: m.fetch, sleep: timing.sleep, retries: 1 });
    await api(URL_);
    assert.equal(m.calls.length, 2);
    await api(URL_, { retry: { retries: 3 } });
    assert.equal(m.calls.length, 6);
  });

  it('uses globalThis.fetch when none is given', async () => {
    const original = globalThis.fetch;
    const m = mockFetch([status(200)]);
    globalThis.fetch = m.fetch;
    try {
      const api = createRetryFetch();
      assert.equal((await api(new URL(URL_))).status, 200);
      assert.equal(m.calls.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
