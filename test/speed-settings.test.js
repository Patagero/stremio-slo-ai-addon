const test = require('node:test');
const assert = require('node:assert/strict');
const { CHUNK_SIZE, TRANSLATION_CONCURRENCY, SUBTITLE_FILE_TIMEOUT_MS, selectAnthropicModel } = require('../index');

test('speed settings use large chunks, bounded parallelism, and a long file timeout', () => {
  assert.ok(CHUNK_SIZE >= 80 && CHUNK_SIZE <= 100);
  assert.ok(TRANSLATION_CONCURRENCY >= 3 && TRANSLATION_CONCURRENCY <= 4);
  assert.ok(SUBTITLE_FILE_TIMEOUT_MS >= 300000);
});

test('fast model preference is available for on-the-fly translation', () => {
  const { selectAnthropicModel } = require('../index');
  assert.equal(selectAnthropicModel([
    { id: 'claude-sonnet-4-6' },
    { id: 'claude-haiku-4-5-20251001' }
  ]), 'claude-haiku-4-5-20251001');
});
