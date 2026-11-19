// Run after `npm run build`: node examples/commonjs.cjs
const { computeDelay, parseRetryAfter, isRetryableStatus } = require('../dist/cjs/index.js');

console.log(
  'delays without jitter:',
  [1, 2, 3, 4].map((n) => computeDelay(n, { jitter: 'none' })),
);
console.log('Retry-After "30" =', parseRetryAfter('30'), 'ms');
console.log('retry a 503?', isRetryableStatus(503), '- a 404?', isRetryableStatus(404));
