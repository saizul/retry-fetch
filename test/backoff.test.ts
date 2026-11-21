import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeDelay, parseRateLimitReset, parseRetryAfter } from '../src/index.js';

describe('computeDelay', () => {
  it('grows exponentially without jitter and stops at maxDelay', () => {
    const o = { jitter: 'none' as const, minDelay: 100, maxDelay: 1000 };
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((n) => computeDelay(n, o)),
      [100, 200, 400, 800, 1000, 1000],
    );
  });

  it('uses the factor option', () => {
    assert.equal(computeDelay(3, { jitter: 'none', minDelay: 10, factor: 3 }), 90);
  });

  it('full jitter scales the cap by the random value', () => {
    assert.equal(
      computeDelay(3, { minDelay: 100 }, () => 0.5),
      200,
    );
    assert.equal(
      computeDelay(3, { minDelay: 100 }, () => 0),
      0,
    );
  });

  it('equal jitter keeps at least half the cap', () => {
    assert.equal(
      computeDelay(2, { minDelay: 100, jitter: 'equal' }, () => 0),
      100,
    );
    assert.equal(
      computeDelay(2, { minDelay: 100, jitter: 'equal' }, () => 0.5),
      150,
    );
  });

  it('uses 250 ms and full jitter by default', () => {
    assert.equal(
      computeDelay(1, {}, () => 0.999999),
      250,
    );
    for (let i = 0; i < 100; i++) {
      const d = computeDelay(4);
      assert.ok(d >= 0 && d <= 2000, String(d));
    }
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-19T10:00:00Z');

  it('reads delay-seconds', () => {
    assert.equal(parseRetryAfter('120', now), 120_000);
    assert.equal(parseRetryAfter(' 0 ', now), 0);
  });

  it('reads HTTP dates', () => {
    assert.equal(parseRetryAfter('Thu, 19 Nov 2026 10:00:30 GMT', now), 30_000);
  });

  it('turns dates in the past into 0', () => {
    assert.equal(parseRetryAfter('Thu, 19 Nov 2026 09:00:00 GMT', now), 0);
  });

  it('ignores missing and malformed values', () => {
    for (const value of [null, undefined, '', '1.5', '-3', 'soon', 'Thu, 99 Foo 2026']) {
      assert.equal(parseRetryAfter(value, now), undefined, String(value));
    }
  });
});

describe('parseRateLimitReset', () => {
  const now = Date.parse('2026-11-19T10:00:00Z');
  const h = (init: Record<string, string>) => new Headers(init);

  it('reads RateLimit-Reset as delta-seconds', () => {
    assert.equal(parseRateLimitReset(h({ 'RateLimit-Reset': '30' }), now), 30_000);
    assert.equal(parseRateLimitReset(h({ 'RateLimit-Reset': '1.5' }), now), 1500);
  });

  it('reads X-RateLimit-Reset as a Unix timestamp', () => {
    assert.equal(parseRateLimitReset(h({ 'X-RateLimit-Reset': String(now / 1000 + 45) }), now), 45_000);
    assert.equal(parseRateLimitReset(h({ 'X-RateLimit-Reset': String(now / 1000 - 10) }), now), 0);
  });

  it('prefers RateLimit-Reset over X-RateLimit-Reset', () => {
    assert.equal(parseRateLimitReset(h({ 'RateLimit-Reset': '5', 'X-RateLimit-Reset': '9' }), now), 5000);
  });

  it('skips malformed values and missing headers', () => {
    assert.equal(parseRateLimitReset(h({}), now), undefined);
    assert.equal(parseRateLimitReset(h({ 'RateLimit-Reset': 'soon' }), now), undefined);
    assert.equal(parseRateLimitReset(h({ 'RateLimit-Reset': '-3', 'X-RateLimit-Reset': '7' }), now), 7000);
  });
});
