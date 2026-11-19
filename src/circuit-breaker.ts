import { CircuitOpenError } from './errors.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. Default 5. */
  failureThreshold?: number;
  /** How long the circuit stays open before a trial request is allowed. Default 30 000 ms. */
  resetTimeout?: number;
  /** Trial requests allowed at the same time while half-open. Default 1. */
  halfOpenRequests?: number;
  /** Called whenever the state changes. */
  onStateChange?: (state: CircuitState, previous: CircuitState) => void;
  /** Clock in milliseconds, for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * A small consecutive-failure circuit breaker.
 *
 * Closed: requests flow; `failureThreshold` failures in a row open it.
 * Open: requests fail fast with `CircuitOpenError` for `resetTimeout` ms.
 * Half-open: up to `halfOpenRequests` trial requests run; a success closes
 * the circuit, a failure opens it again.
 *
 * Share one instance between calls to the same upstream service.
 */
export class CircuitBreaker {
  readonly failureThreshold: number;
  readonly resetTimeout: number;
  readonly halfOpenRequests: number;
  #state: CircuitState = 'closed';
  #failures = 0;
  #openedAt = 0;
  #trials = 0;
  readonly #now: () => number;
  readonly #onStateChange: CircuitBreakerOptions['onStateChange'];

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = positive('failureThreshold', options.failureThreshold ?? 5);
    this.resetTimeout = nonNegative('resetTimeout', options.resetTimeout ?? 30_000);
    this.halfOpenRequests = positive('halfOpenRequests', options.halfOpenRequests ?? 1);
    this.#now = options.now ?? Date.now;
    this.#onStateChange = options.onStateChange;
  }

  /** The current state. Reading it moves an open circuit to half-open once `resetTimeout` has passed. */
  get state(): CircuitState {
    if (this.#state === 'open' && this.#now() - this.#openedAt >= this.resetTimeout) {
      this.#transition('half-open');
    }
    return this.#state;
  }

  /** Consecutive failures counted so far. */
  get failures() {
    return this.#failures;
  }

  /**
   * Reserves a slot for one request, or throws `CircuitOpenError`.
   * Every successful call must be followed by `recordSuccess()` or `recordFailure()`.
   */
  acquire() {
    const state = this.state;
    if (state === 'closed') return;
    if (state === 'half-open' && this.#trials < this.halfOpenRequests) {
      this.#trials++;
      return;
    }
    const wait = state === 'open' ? this.resetTimeout - (this.#now() - this.#openedAt) : 0;
    throw new CircuitOpenError(Math.max(0, wait));
  }

  recordSuccess() {
    this.#failures = 0;
    if (this.#state !== 'closed') this.#transition('closed');
  }

  recordFailure() {
    this.#failures++;
    if (
      this.#state === 'half-open' ||
      (this.#state === 'closed' && this.#failures >= this.failureThreshold)
    ) {
      this.#openedAt = this.#now();
      this.#transition('open');
    }
  }

  /**
   * Gives back a slot taken by `acquire()` without recording a result, for
   * example when the caller aborted the request.
   */
  release() {
    if (this.#state === 'half-open' && this.#trials > 0) this.#trials--;
  }

  /** Closes the circuit and forgets all failures. */
  reset() {
    this.#failures = 0;
    if (this.#state !== 'closed') this.#transition('closed');
  }

  #transition(next: CircuitState) {
    const previous = this.#state;
    this.#state = next;
    this.#trials = 0;
    this.#onStateChange?.(next, previous);
  }
}

function positive(name: string, value: number) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegative(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number`);
  return value;
}
