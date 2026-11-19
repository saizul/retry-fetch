import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CircuitBreaker, CircuitOpenError, type CircuitState } from '../src/index.js';

function breaker(extra = {}) {
  let t = 0;
  const changes: string[] = [];
  const b = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeout: 1000,
    now: () => t,
    onStateChange: (next: CircuitState, prev: CircuitState) => changes.push(`${prev}->${next}`),
    ...extra,
  });
  return {
    b,
    changes,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('CircuitBreaker', () => {
  it('opens after the threshold of consecutive failures', () => {
    const { b, changes } = breaker();
    b.recordFailure();
    b.recordFailure();
    assert.equal(b.state, 'closed');
    b.recordFailure();
    assert.equal(b.state, 'open');
    assert.deepEqual(changes, ['closed->open']);
  });

  it('a success resets the failure count', () => {
    const { b } = breaker();
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    assert.equal(b.state, 'closed');
    assert.equal(b.failures, 2);
  });

  it('fails fast while open, with the remaining wait', () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) b.recordFailure();
    advance(400);
    assert.throws(
      () => b.acquire(),
      (err: unknown) =>
        err instanceof CircuitOpenError && err.retryAfter === 600 && err.code === 'CIRCUIT_OPEN',
    );
  });

  it('lets one trial through when half-open; success closes', () => {
    const { b, advance, changes } = breaker();
    for (let i = 0; i < 3; i++) b.recordFailure();
    advance(1000);
    assert.equal(b.state, 'half-open');
    b.acquire();
    assert.throws(() => b.acquire(), CircuitOpenError);
    b.recordSuccess();
    assert.equal(b.state, 'closed');
    b.acquire();
    assert.deepEqual(changes, ['closed->open', 'open->half-open', 'half-open->closed']);
  });

  it('a failed trial opens the circuit again', () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) b.recordFailure();
    advance(1000);
    b.acquire();
    b.recordFailure();
    assert.equal(b.state, 'open');
    advance(999);
    assert.equal(b.state, 'open');
    advance(1);
    assert.equal(b.state, 'half-open');
  });

  it('release() gives a trial slot back', () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) b.recordFailure();
    advance(1000);
    b.acquire();
    b.release();
    b.acquire();
  });

  it('allows several trials with halfOpenRequests', () => {
    const { b, advance } = breaker({ halfOpenRequests: 2 });
    for (let i = 0; i < 3; i++) b.recordFailure();
    advance(1000);
    b.acquire();
    b.acquire();
    assert.throws(() => b.acquire(), CircuitOpenError);
  });

  it('reset() closes the circuit', () => {
    const { b } = breaker();
    for (let i = 0; i < 3; i++) b.recordFailure();
    b.reset();
    assert.equal(b.state, 'closed');
    assert.equal(b.failures, 0);
  });

  it('validates its options', () => {
    assert.throws(() => new CircuitBreaker({ failureThreshold: 0 }), RangeError);
    assert.throws(() => new CircuitBreaker({ resetTimeout: -1 }), RangeError);
    assert.throws(() => new CircuitBreaker({ halfOpenRequests: 1.5 }), RangeError);
  });
});
