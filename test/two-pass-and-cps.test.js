const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCharacterLedger,
  ledgerToText,
  characterAnalysisPrompt,
  analyzeCharacters,
  resolveSourceLanguages,
  cueDurationSeconds,
  maxCharsForDuration,
  findTooFastCues,
  TARGET_CPS
} = require('../index');

test('character analysis prompt asks for a structured gender ledger', () => {
  const prompt = characterAnalysisPrompt('Title: Demo');
  assert.match(prompt, /character-gender reference sheet/i);
  assert.match(prompt, /"gender":"male\|female\|unknown"/);
  assert.match(prompt, /Croatian and Italian mark gender directly on past-tense verbs/i);
});

test('parses a valid character ledger JSON response', () => {
  const raw = '```json\n{"characters":[{"name":"Ana","gender":"female","confidence":"high","note":"addressed as she"}]}\n```';
  const characters = parseCharacterLedger(raw);
  assert.equal(characters.length, 1);
  assert.equal(characters[0].name, 'Ana');
  assert.equal(characters[0].gender, 'female');
});

test('falls back to empty ledger on malformed JSON', () => {
  assert.deepEqual(parseCharacterLedger('not json'), []);
});

test('ledger text falls back to TMDB guidance when no characters were identified', () => {
  assert.match(ledgerToText([]), /rely on TMDB cast metadata/i);
});

test('ledger text lists each character with gender and confidence', () => {
  const text = ledgerToText([{ name: 'Ana', gender: 'female', confidence: 'high', note: 'sister' }]);
  assert.match(text, /Ana: female \(sister\) \[confidence: high\]/);
});

test('analyzeCharacters falls back gracefully when Claude is not configured', async () => {
  const characters = await analyzeCharacters('1\n00:00:00,000 --> 00:00:01,000\nHello', { title: 'Demo', credits: [] });
  assert.deepEqual(characters, []);
});

test('source language priority is fixed EN -> HR -> IT, with an explicit request taking priority', () => {
  assert.deepEqual(resolveSourceLanguages({ originalLanguage: 'it' }, 'hr'), ['hr', 'en', 'it']);
  assert.deepEqual(resolveSourceLanguages({ originalLanguage: 'it' }, null), ['en', 'hr', 'it']);
  assert.deepEqual(resolveSourceLanguages({ originalLanguage: null }, null), ['en', 'hr', 'it']);
});

test('strict mode returns only the explicitly requested language, with no fallback', () => {
  assert.deepEqual(resolveSourceLanguages({ originalLanguage: 'it' }, 'hr', true), ['hr']);
  assert.deepEqual(resolveSourceLanguages({}, 'it', true), ['it']);
});

test('strict mode with no valid requested language still falls back to the full default order', () => {
  assert.deepEqual(resolveSourceLanguages({}, null, true), ['en', 'hr', 'it']);
  assert.deepEqual(resolveSourceLanguages({}, 'xx', true), ['en', 'hr', 'it']);
});

test('cue duration is computed from the SRT timecode', () => {
  const entry = { timecode: '00:00:01,000 --> 00:00:03,500' };
  assert.equal(cueDurationSeconds(entry), 2.5);
});

test('character budget scales with duration and the configured target CPS, capped by line limits', () => {
  assert.equal(maxCharsForDuration(1), Math.round(1 * TARGET_CPS));
  assert.equal(maxCharsForDuration(100), 84); // capped at 2 lines * 42 chars
});

test('findTooFastCues flags only cues that clearly exceed their reading-speed budget', () => {
  const entries = [
    { id: '1', timecode: '00:00:00,000 --> 00:00:01,000', text: 'Kratko.' },
    { id: '2', timecode: '00:00:00,000 --> 00:00:01,000', text: 'To je precej predolgo besedilo za samo eno sekundo prikaza na zaslonu.' }
  ];
  const overLimit = findTooFastCues(entries);
  assert.equal(overLimit.length, 1);
  assert.equal(overLimit[0].id, '2');
});
