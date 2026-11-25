const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

const gender = require('../gender');
const {
  removeSdhEntries,
  buildCharacterGenderMap,
  buildTranslationUserText,
  parseTranslationJson,
  reconcileTranslatedSrt,
  systemPrompt,
  createPartialTracker,
  mergeChunkIntoPartial,
  alignGenderHelper,
  reviewTranslationGender
} = require('../index');

function tc(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

function srt(cues) {
  return cues.map((c, i) => `${i + 1}\n${tc(c.start)} --> ${tc(c.end)}\n${c.text}`).join('\n\n') + '\n';
}

// ---------- 1. Hrvaške, italijanske in slovenske oblike ----------

test('Croatian and Italian forms give the speaker and the addressee gender', () => {
  assert.deepEqual(gender.detectSourceGender('Rekla sam ti.'), { speaker: 'Ženska', addressee: null });
  assert.deepEqual(gender.detectSourceGender('Gdje si bio?'), { speaker: null, addressee: 'Moški' });
  assert.deepEqual(gender.detectSourceGender('Jesi li ti luda?'), { speaker: null, addressee: 'Ženska' });
  assert.deepEqual(gender.detectSourceGender('Nisam ga vidio.'), { speaker: 'Moški', addressee: null });
  assert.deepEqual(gender.detectSourceGender('Sei pronta?'), { speaker: null, addressee: 'Ženska' });
});

test('look-alike words and the reflexive "si" are not read as gender', () => {
  assert.deepEqual(gender.detectSourceGender('Ja sam kao on.'), { speaker: null, addressee: null });
  assert.deepEqual(gender.detectSourceGender('Uzela si je kaput.'), { speaker: null, addressee: null });
  assert.deepEqual(gender.detectSourceGender('Where were you?'), { speaker: null, addressee: null });
});

test('Slovenian forms in the translation are detected, "sem" as "here" is not', () => {
  assert.equal(gender.detectSlovenianGender('Bila sem doma.').speaker, 'Ženska');
  assert.equal(gender.detectSlovenianGender('Utrujena sem.').speaker, 'Ženska');
  assert.equal(gender.detectSlovenianGender('Nisem ga videl.').speaker, 'Moški');
  assert.equal(gender.detectSlovenianGender('Kje si bil?').addressee, 'Moški');
  assert.equal(gender.detectSlovenianGender('Ali si ga videla?').addressee, 'Ženska');
  assert.deepEqual(gender.detectSlovenianGender('Prišel je sem.'), { speaker: null, addressee: null });
  assert.deepEqual(gender.detectSlovenianGender('Vzela si je čas.'), { speaker: null, addressee: null });
  assert.equal(gender.detectSlovenianGender('Rekla sem, da je bil tam.').speaker, 'Ženska');
});

test('source cues get an addressee tag from Croatian endings', () => {
  const [entry] = removeSdhEntries('1\n00:00:01,000 --> 00:00:03,000\nGdje si bila?\n', new Map());
  assert.equal(entry.genderTag, '[Nagovorjeni: Ženska]');
  assert.equal(entry.genderHint.addressee, 'Ženska');
});

// ---------- 1. Hrvaški pomočnik ----------

test('a Croatian helper adds speaker and addressee tags to English cues by time', () => {
  const english = removeSdhEntries(srt([
    { start: 10000, end: 12000, text: 'I was there.' },
    { start: 13000, end: 15000, text: 'Where were you?' },
    { start: 16000, end: 18000, text: '- I told you.\n- No, you did not.' },
    { start: 19000, end: 21000, text: 'SARAH: I was tired.' }
  ]), buildCharacterGenderMap({ credits: [{ character: 'Sarah', gender: 1 }] }, []));
  const helperCues = gender.buildHelperCues([
    { id: '1', timecode: '00:00:10,100 --> 00:00:12,000', text: 'Bila sam tamo.' },
    { id: '2', timecode: '00:00:13,050 --> 00:00:15,000', text: 'Gdje si bio?' },
    { id: '3', timecode: '00:00:16,000 --> 00:00:18,000', text: '- Rekao sam ti.\n- Nisi, nisi rekao.' },
    { id: '4', timecode: '00:00:19,000 --> 00:00:21,000', text: 'Bio sam umoran.' }
  ]);
  const added = gender.applyHelperHints(english, helperCues);
  assert.equal(english[0].genderTag, '[Govorec: Ženska]');
  assert.equal(english[1].genderTag, '[Nagovorjeni: Moški]');
  assert.equal(english[2].genderTag, '[Govorec 1: Moški; Govorec 2: neznan]');
  // SDH oznaka (Sarah = ženska po TMDB) ima prednost pred hrvaškim pomočnikom.
  assert.equal(english[3].genderTag, '[Govorec: Ženska]');
  assert.equal(added, 3);
});

test('the helper is aligned to the source timeline before its hints are used', () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const cues = [];
  let t = 60000;
  for (let i = 0; i < 300; i++) {
    t += 300 + Math.floor(random() * 6000);
    const duration = 900 + Math.floor(random() * 3000);
    cues.push({ start: t, end: t + duration, text: i === 150 ? 'Where were you?' : `Line ${i}` });
    t += duration;
  }
  const shifted = cues.map(c => ({ start: c.start + 4200, end: c.end + 4200, text: c.text === 'Where were you?' ? 'Gdje si bila?' : 'Redak' }));
  const aligned = alignGenderHelper(srt(cues), srt(shifted));
  assert.ok(aligned.cues, aligned.sync && aligned.sync.reason);
  const entries = removeSdhEntries(srt(cues), new Map());
  gender.applyHelperHints(entries, aligned.cues);
  assert.equal(entries[150].genderTag, '[Nagovorjeni: Ženska]');
  assert.equal(entries.filter(e => e.genderTag).length, 1);
});

test('the addressee tag is passed to the model and removed from the output', () => {
  const text = buildTranslationUserText([{ id: '1', timecode: '00:00:01,000 --> 00:00:03,000', text: 'Where were you?', genderTag: '[Nagovorjeni: Ženska]' }]);
  assert.match(text, /\[Nagovorjeni: Ženska\] Where were you\?/);
  const cleaned = reconcileTranslatedSrt('1\n00:00:01,000 --> 00:00:03,000\nWhere were you?\n', '1\n00:00:01,000 --> 00:00:03,000\n[Nagovorjeni: Ženska] Kje si bila?\n');
  assert.match(cleaned, /\nKje si bila\?\n/);
  assert.ok(systemPrompt('Title: Demo').includes('[Nagovorjeni: Ženska]'));
});

// ---------- 3. Imena govorcev ----------

test('speaker and addressee names are parsed next to the translation', () => {
  const full = parseTranslationJson('{"translations":[{"id":"1","s":"Ana","to":"Marko","g":"F","a":"M","text":"Kje si bil?"}]}');
  assert.equal(full.get('1'), 'Kje si bil?');
  assert.deepEqual(full.meta.get('1'), { s: 'Ana', to: 'Marko', g: 'F', a: 'M' });
  const truncated = parseTranslationJson('{"translations":[{"id":"1","s":"Ana Novak","to":"?","g":"F","a":"?","text":"Bila sem doma."},{"id":"2","s":"Mar');
  assert.equal(truncated.get('1'), 'Bila sem doma.');
  assert.equal(truncated.meta.get('1').s, 'Ana Novak');
});

test('the prompt asks for speaker and addressee names', () => {
  const prompt = systemPrompt('Title: Demo');
  assert.ok(prompt.includes('"s"'));
  assert.ok(prompt.includes('"to"'));
});

// ---------- 2. Kontrolni krog ----------

test('a translation that contradicts the character ledger is flagged', () => {
  const map = buildCharacterGenderMap({ credits: [{ character: 'Ana', gender: 1 }, { character: 'Marko', gender: 2 }] }, []);
  const lookup = name => require('../index').lookupCharacterGender(map, name);
  const issues = gender.findGenderIssues([
    { id: '1', sourceText: 'I was home.', text: 'Bil sem doma.', meta: { s: 'Ana', to: 'Marko', g: 'M', a: 'M' } },
    { id: '2', sourceText: 'Where were you?', text: 'Kje si bila?', meta: { s: 'Ana', to: 'Marko', g: 'F', a: 'F' } },
    { id: '3', sourceText: 'I was home.', text: 'Bila sem doma.', meta: { s: 'Ana', to: '?', g: 'F', a: '?' } },
    { id: '4', sourceText: 'Hello.', text: 'Živjo.', meta: { s: 'Marko', g: 'F' } }
  ], { lookup });
  assert.deepEqual(issues.map(i => i.id), ['1', '2']);
  assert.match(issues[0].reasons[0], /Ana je po analizi likov ženska/);
});

test('a strong hint (Croatian helper) beats the model and names nobody knows use the film-wide consensus', () => {
  const items = [
    { id: '1', sourceText: 'I was tired.', text: 'Utrujen sem bil.', hint: { speaker: 'Ženska', speakerFromHelper: true }, meta: { s: '?', g: 'M' } },
    ...['2', '3', '4', '6'].map(id => ({ id, sourceText: 'x', text: 'Šla sem.', meta: { s: 'Kim', g: 'F' } })),
    { id: '5', sourceText: 'I went.', text: 'Šel sem.', meta: { s: 'Kim', g: 'M' } }
  ];
  const issues = gender.findGenderIssues(items, { lookup: () => null });
  assert.deepEqual(issues.map(i => i.id), ['1', '5']);
  assert.match(issues[0].reasons[0], /hrvaški podnapis/);
  assert.match(issues[1].reasons[0], /Kim je drugod v filmu ženska/);
});

test('two-speaker cues are checked line by line', () => {
  const issues = gender.findGenderIssues([
    { id: '1', sourceText: '- I told you.\n- I know.', text: '- Rekla sem ti.\n- Vem.', hint: { lineSpeakers: ['Moški', null] }, meta: { g: 'FM' } }
  ]);
  assert.equal(issues.length, 1);
  assert.match(issues[0].reasons[0], /vrstica 1/);
});

test('the review pass sends flagged cues to the stronger model and applies its fixes', async () => {
  const sourceEntries = removeSdhEntries(srt([
    { start: 1000, end: 3000, text: 'ANA: I was home.' },
    { start: 4000, end: 6000, text: 'Good.' }
  ]), buildCharacterGenderMap({ credits: [{ character: 'Ana', gender: 1 }] }, []));
  const characterMap = buildCharacterGenderMap({ credits: [{ character: 'Ana', gender: 1 }] }, []);
  const partial = createPartialTracker(sourceEntries, 1);
  mergeChunkIntoPartial(partial, [
    { id: '1', timecode: sourceEntries[0].timecode, text: 'Bil sem doma.', meta: { s: 'Ana', g: 'M' } },
    { id: '2', timecode: sourceEntries[1].timecode, text: 'Dobro.' }
  ], 0);
  const calls = [];
  const result = await reviewTranslationGender(partial, sourceEntries, characterMap, 'Title: Demo', {
    translate: async (systemText, userText, options) => {
      calls.push({ systemText, userText, options });
      return '{"fixes":[{"id":"1","text":"Bila sem doma."}]}';
    }
  });
  assert.deepEqual(result, { issues: 1, fixed: 1 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].userText, /\[id=1\]/);
  assert.doesNotMatch(calls[0].userText, /\[id=2\]/);
  assert.equal(partial.entryMap.get('1').text, 'Bila sem doma.');
  assert.equal(partial.entryMap.get('2').text, 'Dobro.');
});

test('a failing review keeps the translation as it is', async () => {
  const items = [{ id: '1', sourceText: 'x', text: 'Bil sem doma.', hint: { speaker: 'Ženska' } }];
  const issues = gender.findGenderIssues(items);
  const fixes = await gender.reviewGenderIssues(items, issues, { translate: async () => { throw new Error('boom'); } });
  assert.equal(fixes.size, 0);
});
