import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { AttemptTimeoutError, RetriesExhaustedError, retryFetch } from '../src/index.js';

// A real HTTP server on 127.0.0.1, so the tests exercise Node's own fetch.
type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let handler: Handler = (_req, res) => res.end('ok');
let base = '';
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => handler(req, res, body));
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe('against a local HTTP server', () => {
  it('retries 503 with Retry-After: 0 and returns the success', async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      if (hits < 3) {
        res.writeHead(503, { 'Retry-After': '0' });
        res.end('busy');
      } else {
        res.end('done');
      }
    };
    const res = await retryFetch(`${base}/x`);
    assert.equal(await res.text(), 'done');
    assert.equal(hits, 3);
  });

  it('sends the same POST body on every attempt when an Idempotency-Key is set', async () => {
    const seen: string[] = [];
    handler = (req, res, body) => {
      seen.push(`${req.method} ${req.headers['idempotency-key']} ${body}`);
      res.statusCode = seen.length === 1 ? 500 : 201;
      res.end();
    };
    const res = await retryFetch(`${base}/orders`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'A' }),
      retry: { minDelay: 1 },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(seen, ['POST k1 {"sku":"A"}', 'POST k1 {"sku":"A"}']);
  });

  it('times out slow responses', async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      setTimeout(() => {
        if (!res.destroyed) res.end('late');
      }, 500);
    };
    await assert.rejects(
      retryFetch(`${base}/slow`, { retry: { timeout: 40, retries: 1, minDelay: 1 } }),
      (err: unknown) => err instanceof RetriesExhaustedError && err.cause instanceof AttemptTimeoutError,
    );
    assert.equal(hits, 2);
  });

  it('retries a refused connection and reports it', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await assert.rejects(
      retryFetch(`http://127.0.0.1:${port}/`, { retry: { retries: 1, minDelay: 1 } }),
      (err: unknown) => err instanceof RetriesExhaustedError && err.errors.length === 2,
    );
  });
});
