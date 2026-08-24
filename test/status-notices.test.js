const test = require('node:test');
const assert = require('node:assert/strict');
const { statusNoticeSrt, friendlyErrorMessage, buildErrorSrt, buildPlaceholderSrt } = require('../index');

test('statusNoticeSrt uses a reserved id (0) so it never collides with real cue numbering', () => {
  const notice = statusNoticeSrt('Test sporočilo.');
  assert.match(notice, /^0\n00:00:00,000 --> 00:00:04,000\n\[Slo AI prevod\] Test sporočilo\./);
});

test('friendlyErrorMessage recognizes an out-of-credits error and explains it in Slovenian', () => {
  const msg = friendlyErrorMessage('Claude HTTP 400: {"error":{"message":"Your credit balance is too low"}}');
  assert.match(msg, /kreditov/i);
  assert.match(msg, /console\.anthropic\.com/);
});

test('friendlyErrorMessage recognizes a rate-limit error', () => {
  const msg = friendlyErrorMessage('Claude HTTP 429: rate_limit_error');
  assert.match(msg, /preveč hkratnih zahtev/i);
});

test('friendlyErrorMessage falls back to the raw message for unrecognized errors', () => {
  assert.equal(friendlyErrorMessage('Something unexpected happened'), 'Something unexpected happened');
});

test('buildErrorSrt wraps the friendly message as a visible status cue', () => {
  const srt = buildErrorSrt('Claude HTTP 400: credit balance too low');
  assert.match(srt, /^0\n00:00:00,000 --> 00:00:04,000\n\[Slo AI prevod\] Napaka: /);
  assert.match(srt, /kreditov/i);
});

test('buildPlaceholderSrt announces that translation has started', () => {
  assert.match(buildPlaceholderSrt(), /Prevajanje se je začelo/i);
});
