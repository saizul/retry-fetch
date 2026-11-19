export type Step = Response | Error | ((input: unknown, init: RequestInit) => Promise<Response>);

export interface Call {
  input: unknown;
  init: RequestInit;
}

/** A fetch stand-in that plays `steps` in order, then repeats the last one. */
export function mockFetch(steps: Step[]) {
  const calls: Call[] = [];
  const fn = async (input: unknown, init: RequestInit = {}) => {
    calls.push({ input, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (typeof step === 'function') return step(input, init);
    if (step instanceof Error) throw step;
    // A Response body can only be read once, so hand out a copy.
    return step.clone();
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

/** A fetch stand-in that only settles when its signal aborts. */
export function hangingFetch() {
  let calls = 0;
  const fn = (_input: unknown, init: RequestInit = {}) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  return {
    fetch: fn as unknown as typeof fetch,
    get calls() {
      return calls;
    },
  };
}

/** A sleep stand-in that records the waits and returns at once (or rejects if aborted). */
export function instantSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number, signal: AbortSignal) => {
    delays.push(ms);
    if (signal.aborted) throw signal.reason;
  };
  return { sleep, delays };
}

export const status = (code: number, headers?: Record<string, string>) =>
  new Response(code === 204 ? null : `status ${code}`, { status: code, headers });
