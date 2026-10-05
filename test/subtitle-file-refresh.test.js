const test = require('node:test');
const assert = require('node:assert/strict');
const { createSubtitleFileWaiter } = require('../index');

test('subtitle file waiter returns the completed translation instead of stale placeholder', async () => {
  const cache = new Map();
  const jobs = new Map([['movie:slv', { key: 'movie:slv', status: 'processing' }]]);
  const waiter = createSubtitleFileWaiter({ cache, jobs, pollMs: 1, timeoutMs: 100 });
  setTimeout(() => {
    cache.set('movie:slv', { srt: '1\n00:00:00,000 --> 00:00:01,000\nKončni prevod', expiresAt: Date.now() + 1000 });
    jobs.get('movie:slv').status = 'completed';
  }, 5);
  assert.equal(await waiter('movie:slv'), '1\n00:00:00,000 --> 00:00:01,000\nKončni prevod');
});
