const test = require('node:test');
const assert = require('node:assert/strict');
const { statusNoticeSrt, friendlyErrorMessage, buildErrorSrt, buildPlaceholderSrt } = require('../index');

test('statusNoticeSrt uses a reserved id (0) so it never collides with real cue numbering', () => {
  const notice = statusNoticeSrt('Test sporočilo.');
  assert.match(notice, /^0\n00:00:00,000 --> 00:00:04,000\n\[Slo AI prevod\] Test sporočilo\./);
});

test('friendlyErrorMessage recognizes an out-of-quota error and explains it in Slovenian', () => {
  const msg = friendlyErrorMessage('Gemini HTTP 400: {"error":{"status":"RESOURCE_EXHAUSTED","message":"quota exceeded"}}');
  assert.match(msg, /kvote|kreditov/i);
});

test('friendlyErrorMessage recognizes a rate-limit error', () => {
  const msg = friendlyErrorMessage('Gemini HTTP 429: rate_limit_error');
  assert.match(msg, /preveč hkratnih zahtev/i);
});

test('friendlyErrorMessage falls back to the raw message for unrecognized errors', () => {
  assert.equal(friendlyErrorMessage('Something unexpected happened'), 'Something unexpected happened');
});

test('buildErrorSrt wraps the friendly message as a visible status cue', () => {
  const srt = buildErrorSrt('Gemini HTTP 400: quota exceeded');
  assert.match(srt, /^0\n00:00:00,000 --> 00:00:04,000\n\[Slo AI prevod\] Napaka: /);
  assert.match(srt, /kvote|kreditov/i);
});

test('buildPlaceholderSrt announces that translation has started', () => {
  assert.match(buildPlaceholderSrt(), /Prevajanje se je začelo/i);
});
