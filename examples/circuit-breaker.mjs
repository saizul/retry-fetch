// Run after `npm run build`: node examples/circuit-breaker.mjs
// A server that is down: after 3 failures the breaker opens and calls fail fast.
import { createServer } from 'node:http';
import { CircuitBreaker, CircuitOpenError, createRetryFetch } from '../dist/esm/index.js';

let hits = 0;
const server = createServer((_req, res) => {
  hits++;
  res.statusCode = 500;
  res.end('down');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const breaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeout: 30_000,
  onStateChange: (state, previous) => console.log(`breaker: ${previous} -> ${state}`),
});
const api = createRetryFetch({ retries: 1, minDelay: 10, circuitBreaker: breaker });

for (let i = 1; i <= 4; i++) {
  try {
    const res = await api(url);
    console.log(`call ${i}: status ${res.status}`);
  } catch (err) {
    if (err instanceof CircuitOpenError)
      console.log(`call ${i}: failed fast, retry in ~${err.retryAfter} ms`);
    else throw err;
  }
}
console.log(`the server saw ${hits} requests`);
server.close();
