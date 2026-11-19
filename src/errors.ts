/** Machine-readable codes for every error this package throws. */
export type RetryFetchErrorCode =
  | 'TIMEOUT'
  | 'DEADLINE_EXCEEDED'
  | 'RETRIES_EXHAUSTED'
  | 'CIRCUIT_OPEN'
  | 'HTTP_ERROR';

/** Base class for every error thrown by retry-fetch. */
export class RetryFetchError extends Error {
  readonly code: RetryFetchErrorCode;

  constructor(code: RetryFetchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RetryFetchError';
    this.code = code;
  }
}

/** One attempt took longer than the `timeout` option. Retried like a network error. */
export class AttemptTimeoutError extends RetryFetchError {
  readonly timeout: number;

  constructor(timeout: number) {
    super('TIMEOUT', `The request attempt timed out after ${timeout} ms`);
    this.name = 'AttemptTimeoutError';
    this.timeout = timeout;
  }
}

/** The whole operation, including waits between attempts, ran past the `deadline` option. Never retried. */
export class DeadlineExceededError extends RetryFetchError {
  readonly deadline: number;
  readonly attempts: number;

  constructor(deadline: number, attempts: number, cause?: unknown) {
    super('DEADLINE_EXCEEDED', `The request did not complete within the ${deadline} ms deadline`, {
      cause,
    });
    this.name = 'DeadlineExceededError';
    this.deadline = deadline;
    this.attempts = attempts;
  }
}

/** Every attempt failed with a retryable error. `cause` is the last error. */
export class RetriesExhaustedError extends RetryFetchError {
  readonly attempts: number;
  readonly errors: unknown[];

  constructor(attempts: number, errors: unknown[]) {
    const last = errors[errors.length - 1];
    const detail = last instanceof Error ? `: ${last.message}` : '';
    super('RETRIES_EXHAUSTED', `The request failed after ${attempts} attempt(s)${detail}`, { cause: last });
    this.name = 'RetriesExhaustedError';
    this.attempts = attempts;
    this.errors = errors;
  }
}

/** The circuit breaker is open, so no request was sent. */
export class CircuitOpenError extends RetryFetchError {
  /** Milliseconds until the breaker lets a trial request through. */
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super('CIRCUIT_OPEN', `The circuit breaker is open; retry in ${retryAfter} ms`);
    this.name = 'CircuitOpenError';
    this.retryAfter = retryAfter;
  }
}

/** Thrown only with `throwHttpErrors: true` when the final response is not ok (status outside 200-299). */
export class HttpError extends RetryFetchError {
  readonly response: Response;
  readonly status: number;
  readonly attempts: number;

  constructor(response: Response, attempts: number) {
    super('HTTP_ERROR', `Request failed with status ${response.status} after ${attempts} attempt(s)`);
    this.name = 'HttpError';
    this.response = response;
    this.status = response.status;
    this.attempts = attempts;
  }
}
