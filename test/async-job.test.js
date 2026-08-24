const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlaceholderSrt } = require('../index');

test('placeholder is valid SRT and explains that Slovenian translation is processing', () => {
  const srt = buildPlaceholderSrt();
  assert.match(srt, /^0\n00:00:00,000 --> 00:00:04,000\n/);
  assert.match(srt, /Prevajanje se je začelo/i);
});

module.exports = {};
/* test-first contract: subtitle requests must return a resource immediately,
   while the expensive Claude job continues in the background. */
// eslint-disable-next-line no-unused-expressions
void 0;