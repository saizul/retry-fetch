// Run after `npm run build`: node examples/basic.mjs
// Starts a flaky local server (fails twice, then succeeds) and fetches from it.
import { createServer } from 'node:http';
import { retryFetch } from '../dist/esm/index.js';

let hits = 0;
const server = createServer((_req, res) => {
  hits++;
  if (hits <= 2) {
    res.writeHead(503, { 'Retry-After': '0' });
    res.end('try again');
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, hits }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/status`;

const res = await retryFetch(url, {
  retry: {
    retries: 3,
    timeout: 2000,
    deadline: 10_000,
    onRetry: ({ attempt, response, delay }) =>
      console.log(`attempt ${attempt} got ${response?.status}, retrying in ${delay} ms`),
  },
});
console.log(res.status, await res.json());
server.close();
