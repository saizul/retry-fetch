import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import * as esm from '../src/index.js';

const require = createRequire(import.meta.url);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('package', () => {
  it('the CommonJS build exposes the same API', () => {
    const cjs = require('../cjs/index.js') as typeof esm;
    assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
    assert.equal(cjs.computeDelay(2, { jitter: 'none' }), 500);
  });

  it('the CommonJS folder is marked as commonjs', () => {
    assert.equal(JSON.parse(read('../cjs/package.json')).type, 'commonjs');
  });

  it('has no runtime dependencies and versions agree', () => {
    const pkg = JSON.parse(read('../../package.json'));
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.version, esm.VERSION);
    assert.equal(pkg.name, '@saizul/retry-fetch');
  });

  it('the library source does not import Node built-ins', () => {
    for (const file of ['index', 'retry-fetch', 'backoff', 'retry-after', 'circuit-breaker', 'errors']) {
      assert.doesNotMatch(read(`../esm/${file}.js`), /from ['"]node:/, file);
    }
  });

  it('the README documents every error code', () => {
    const readme = read('../../README.md');
    for (const code of ['TIMEOUT', 'DEADLINE_EXCEEDED', 'RETRIES_EXHAUSTED', 'CIRCUIT_OPEN', 'HTTP_ERROR']) {
      assert.ok(readme.includes(`\`${code}\``), code);
    }
  });
});
