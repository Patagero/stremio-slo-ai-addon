const test = require('node:test');
const assert = require('node:assert/strict');
const { CHUNK_SIZE, TRANSLATION_CONCURRENCY, SUBTITLE_FILE_TIMEOUT_MS } = require('../index');

test('speed settings use large chunks, bounded parallelism, and a long file timeout', () => {
  assert.ok(CHUNK_SIZE >= 80 && CHUNK_SIZE <= 100);
  assert.ok(TRANSLATION_CONCURRENCY >= 3 && TRANSLATION_CONCURRENCY <= 4);
  assert.ok(SUBTITLE_FILE_TIMEOUT_MS >= 300000);
});

test('fast translation uses the configured Gemini provider', () => {
  const { providerConfig } = require('../index');
  assert.equal(providerConfig.name, 'gemini');
  assert.equal(providerConfig.model, 'gemini-3.6-flash');
});
