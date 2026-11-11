const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCharacterGenderMap,
  lookupCharacterGender,
  removeSdhEntries,
  buildTranslationUserText,
  parseTranslationJson,
  parseCharacterLedger,
  buildGeminiRequest,
  systemPrompt
} = require('../index');

const meta = {
  genres: ['Drama'],
  credits: [
    { name: 'Sarah Connor (Linda Hamilton)', character: 'Sarah Connor', actor: 'Linda Hamilton', gender: 1 },
    { name: 'John Connor (Edward Furlong)', character: 'John Connor', actor: 'Edward Furlong', gender: 2 },
    { name: 'Tony Stark / Iron Man (Robert Downey Jr.)', character: 'Tony Stark / Iron Man', actor: 'Robert Downey Jr.', gender: 2 }
  ]
};

test('TMDB character names are indexed by full name, first name and alias', () => {
  const map = buildCharacterGenderMap(meta, []);
  assert.equal(lookupCharacterGender(map, 'SARAH'), 'Ženska');
  assert.equal(lookupCharacterGender(map, 'John'), 'Moški');
  assert.equal(lookupCharacterGender(map, 'Sarah Connor'), 'Ženska');
  assert.equal(lookupCharacterGender(map, 'IRON MAN'), 'Moški');
  assert.equal(lookupCharacterGender(map, 'TONY'), 'Moški');
});

test('a surname shared by characters of different genders is not used', () => {
  const map = buildCharacterGenderMap(meta, []);
  assert.equal(lookupCharacterGender(map, 'CONNOR'), null);
});

test('ledger adds characters and aliases missing from TMDB but does not override TMDB', () => {
  const map = buildCharacterGenderMap(meta, [
    { name: 'Nurse Ratched', aliases: ['Mildred'], gender: 'female', confidence: 'medium' },
    { name: 'Sarah Connor', gender: 'male', confidence: 'low' }
  ]);
  assert.equal(lookupCharacterGender(map, 'MILDRED'), 'Ženska');
  assert.equal(lookupCharacterGender(map, 'Sarah Connor'), 'Ženska');
});

test('for animation a confident dialogue ledger beats the voice actor gender', () => {
  const map = buildCharacterGenderMap(
    { genres: ['Animation'], credits: [{ character: 'Bart Simpson', actor: 'Nancy Cartwright', gender: 1 }] },
    [{ name: 'Bart Simpson', gender: 'male', confidence: 'high' }]
  );
  assert.equal(lookupCharacterGender(map, 'BART'), 'Moški');
});

test('SDH speaker labels are resolved to gender tags through the character map', () => {
  const map = buildCharacterGenderMap(meta, []);
  const srt = '1\n00:00:01,000 --> 00:00:03,000\nSARAH: I was there.\n\n2\n00:00:04,000 --> 00:00:06,000\n- JOHN: Where were you?\n- SARAH: At home.\n\n3\n00:00:07,000 --> 00:00:09,000\nNobody knows.\n';
  const entries = removeSdhEntries(srt, map);
  assert.equal(entries[0].genderTag, '[Govorec: Ženska]');
  assert.equal(entries[0].text, 'I was there.');
  assert.equal(entries[1].genderTag, '[Govorec 1: Moški; Govorec 2: Ženska]');
  assert.equal(entries[2].genderTag, '');
});

test('source-language verb endings still tag the speaker without a label', () => {
  const entries = removeSdhEntries('1\n00:00:01,000 --> 00:00:03,000\nRekla sam ti.\n', new Map());
  assert.equal(entries[0].genderTag, '[Govorec: Ženska]');
});

test('previous cues are passed as context without translatable ids', () => {
  const text = buildTranslationUserText(
    [{ id: '9', timecode: '00:00:10,000 --> 00:00:12,000', text: 'Where were you?' }],
    [{ id: '8', timecode: '00:00:07,000 --> 00:00:09,000', text: 'Ana, wait!', genderTag: '[Govorec: Moški]' }]
  );
  assert.match(text, /PREJŠNJI CUE-JI/);
  assert.match(text, /\(prej\) \[Govorec: Moški\] Ana, wait!/);
  assert.equal([...text.matchAll(/\[id=/g)].length, 1);
});

test('translations with gender fields parse, including truncated JSON', () => {
  const full = parseTranslationJson('{"translations":[{"id":"1","g":"F","a":"M","text":"Kje si bil?"}]}');
  assert.equal(full.get('1'), 'Kje si bil?');
  const truncated = parseTranslationJson('{"translations":[{"id":"1","g":"F","a":"?","text":"Bila sem doma."},{"id":"2","g":"M","a":"F","te');
  assert.equal(truncated.get('1'), 'Bila sem doma.');
});

test('ledger aliases survive parsing', () => {
  const [c] = parseCharacterLedger('{"characters":[{"name":"Ana","aliases":["Anči"],"gender":"Female","confidence":"high"}]}');
  assert.deepEqual(c.aliases, ['Anči']);
  assert.equal(c.gender, 'female');
});

test('prompt covers speaker, addressee and mentioned-person gender', () => {
  const prompt = systemPrompt('Title: Demo');
  for (const phrase of ['NAGOVORJENI', 'OMENJENI', 'Kje si bila?', 'dvojina', '"g"', '"a"']) {
    assert.ok(prompt.includes(phrase), phrase);
  }
});

test('Gemini 2.0 requests cap output tokens at the model limit and send no thinking config', () => {
  const config = buildGeminiRequest('S', 'U', 'gemini-2.0-flash', { maxOutputTokens: 12000 }).body.generationConfig;
  assert.equal(config.maxOutputTokens, 8192);
  assert.equal('thinkingConfig' in config, false);
  assert.equal(config.temperature, 0.2);
});

test('translation defaults to the low-cost Flash-Lite and character analysis to the stronger Flash', () => {
  const { GEMINI_MODEL, ANALYSIS_MODEL } = require('../index');
  if (!process.env.GEMINI_MODEL) assert.equal(GEMINI_MODEL, 'gemini-3.1-flash-lite');
  if (!process.env.ANALYSIS_MODEL) assert.equal(ANALYSIS_MODEL, 'gemini-3.6-flash');
});

test('fallback order keeps a lite model on cheap models first and a full model on full models first', () => {
  const { geminiModelsToTry } = require('../index');
  assert.deepEqual(geminiModelsToTry('gemini-3.1-flash-lite').slice(0, 3), ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.6-flash']);
  assert.deepEqual(geminiModelsToTry('gemini-3.6-flash').slice(0, 3), ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite']);
});

test('gemini-3.6-flash requests use low thinking, JSON output and no temperature', () => {
  const config = buildGeminiRequest('S', 'U', 'gemini-3.6-flash', { maxOutputTokens: 12000 }).body.generationConfig;
  assert.equal(config.responseMimeType, 'application/json');
  assert.deepEqual(config.thinkingConfig, { thinkingLevel: 'low' });
  assert.equal(config.maxOutputTokens, 12000);
  // Gemini 3.6+ ignores custom temperature, so it is not sent.
  assert.equal('temperature' in config, false);
});

test('the cheaper Flash-Lite model still gets a valid request when chosen through GEMINI_MODEL', () => {
  const config = buildGeminiRequest('S', 'U', 'gemini-3.1-flash-lite', { maxOutputTokens: 12000 }).body.generationConfig;
  assert.deepEqual(config.thinkingConfig, { thinkingLevel: 'low' });
  assert.equal(config.temperature, 0.2);
});
