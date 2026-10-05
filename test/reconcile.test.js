const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileTranslatedSrt, parseAndValidateSrt } = require('../index');

test('reconciles missing or changed AI cues using source structure', () => {
  const source = '1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:02,000 --> 00:00:03,000\nReady?';
  const result = reconcileTranslatedSrt(source, '1\n00:00:09,000 --> 00:00:10,000\nŽivjo');
  assert.doesNotThrow(() => parseAndValidateSrt(source, result));
  assert.match(result, /00:00:02,000 --> 00:00:03,000/);
  assert.match(result, /Ready\?/);
});
