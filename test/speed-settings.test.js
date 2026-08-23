const test = require('node:test');
const assert = require('node:assert/strict');
const { CHUNK_SIZE, TRANSLATION_CONCURRENCY, SUBTITLE_FILE_TIMEOUT_MS } = require('../index');

test('speed settings use large chunks, bounded parallelism, and a long file timeout', () => {
  assert.ok(CHUNK_SIZE >= 40 && CHUNK_SIZE <= 50);
  assert.ok(TRANSLATION_CONCURRENCY >= 1 && TRANSLATION_CONCURRENCY <= 2);
  assert.ok(SUBTITLE_FILE_TIMEOUT_MS >= 300000);
});

test('translation uses the configured Anthropic provider', () => {
  const { providerConfig, ANTHROPIC_MODEL } = require('../index');
  assert.equal(providerConfig.name, 'anthropic');
  assert.equal(providerConfig.model, ANTHROPIC_MODEL);
});
