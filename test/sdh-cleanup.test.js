const test = require('node:test');
const assert = require('node:assert/strict');
const { removeSdh, stripSdhFromLine } = require('../index');

test('strips bracketed sound descriptions from a line', () => {
  assert.equal(stripSdhFromLine('[door creaks] Hello there.'), 'Hello there.');
  assert.equal(stripSdhFromLine('Wait, listen. [wind howling]'), 'Wait, listen.');
});

test('strips ALL-CAPS speaker labels but keeps the dialogue', () => {
  assert.equal(stripSdhFromLine('JOHN: Where are you going?'), 'Where are you going?');
  assert.equal(stripSdhFromLine('- RADIO: Repeat, over.'), 'Repeat, over.');
});

test('does not strip normal mixed-case names followed by a colon', () => {
  assert.equal(stripSdhFromLine('Marko: Pridi sem.'), 'Marko: Pridi sem.');
});

test('strips music-note delimited lyric lines', () => {
  assert.equal(stripSdhFromLine('\u266a some lyrics playing \u266a'), '');
});

test('removeSdh drops a cue entirely if nothing but SDH markup remains, and renumbers ids', () => {
  const srt = [
    '1',
    '00:00:00,000 --> 00:00:01,000',
    '[music playing]',
    '',
    '2',
    '00:00:01,500 --> 00:00:03,000',
    'JOHN: Hello there.',
    '',
    '3',
    '00:00:03,500 --> 00:00:05,000',
    'Real dialogue continues.',
    ''
  ].join('\n');

  const cleaned = removeSdh(srt);
  assert.doesNotMatch(cleaned, /music playing/i);
  assert.doesNotMatch(cleaned, /JOHN:/);
  assert.match(cleaned, /Hello there\./);
  assert.match(cleaned, /Real dialogue continues\./);
  // Cue 1 was pure SDH and should be gone entirely, so only 2 cues remain, renumbered 1 and 2.
  assert.match(cleaned, /^1\n/);
  assert.match(cleaned, /\n2\n/);
  assert.doesNotMatch(cleaned, /\n3\n/);
});
