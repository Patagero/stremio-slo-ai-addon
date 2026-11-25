'use strict';

// ---------- Spol govorca in nagovorjenega: slovnični namigi in kontrolni krog ----------
//
// 1. Hrvaški pomočnik: hrvaščina (in italijanščina) spol zapiše v glagolu ali pridevniku
//    ("rekla sam", "gdje si bio?", "sono andata"). Iz poravnanega hrvaškega podnapisa
//    za vsak cue preberemo spol govorca in nagovorjenega ter ga dodamo angleškemu viru.
// 2. Kontrolni krog: v slovenskem prevodu poiščemo spolne oblike ("sem bil", "si bila"),
//    jih primerjamo s pričakovanim spolom (oznake, analiza likov, imena govorcev, ki jih
//    vrne model) in sporne cue-je pošljemo močnejšemu modelu v popravek.

const FEMALE = 'Ženska';
const MALE = 'Moški';

function genderFromLetter(value) {
  const v = String(value || '').trim().toUpperCase();
  if (v === 'F') return FEMALE;
  if (v === 'M') return MALE;
  return null;
}

function letterFromGender(gender) {
  if (gender === FEMALE) return 'F';
  if (gender === MALE) return 'M';
  return null;
}

function genderLabel(gender) {
  if (gender === FEMALE) return 'ženska';
  if (gender === MALE) return 'moški';
  return 'neznan';
}

// ---------- Časi ----------

function timecodeToMs(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, '0'));
}

function entrySpan(entry) {
  const [a, b] = String(entry?.timecode || '').split(/\s*-->\s*/);
  const start = timecodeToMs(a);
  const end = timecodeToMs(b);
  if (start == null || end == null) return null;
  return { start, end: Math.max(end, start + 1) };
}

// ---------- Hrvaške, italijanske in slovenske spolne oblike ----------
//
// Vsako pravilo poišče pomožni glagol prve ali druge osebe ("sam", "si", "sono", "sem")
// in blizu njega spolno obliko (deležnik ali pridevnik). Besede, ki so po obliki
// podobne deležniku, a to niso ("kao", "dio"), so izločene.

function wordAlternation(words) {
  return `(?:${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
}

const THIRD_PERSON = '(?:je|su|so|sta|ste|bo|bodo|bi|è|sono)';

// aux ... oblika (do dve vmesni besedi) ali oblika (+ ena beseda, ki ni 3. oseba) ... aux.
function nearRegexes(aux, form) {
  return [
    new RegExp(`(?:^|[^\\p{L}])${aux}(?:\\s+[\\p{L}']+){0,2}?\\s+(${form})(?![\\p{L}])`, 'giu'),
    new RegExp(`(?:^|[^\\p{L}])(${form})\\s+(?:(?!${THIRD_PERSON}\\s)[\\p{L}']+\\s+)?${aux}(?![\\p{L}])`, 'giu')
  ];
}

function buildRules(aux, femForms, mascForms) {
  return {
    female: femForms.flatMap(form => nearRegexes(aux, form)),
    male: mascForms.flatMap(form => nearRegexes(aux, form))
  };
}

function hasForm(text, regexes, excluded) {
  for (const re of regexes) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!excluded.has(String(m[1] || '').toLowerCase())) return true;
      re.lastIndex = m.index + 1;
    }
  }
  return false;
}

function matchGender(text, rules, excluded, allowMixed = false) {
  const female = hasForm(text, rules.female, excluded);
  const male = hasForm(text, rules.male, excluded);
  if (female && male) return allowMixed ? 'mixed' : null;
  if (female) return FEMALE;
  if (male) return MALE;
  return null;
}

// --- hrvaščina / srbščina / bosanščina ---
const HR_SPEAKER_AUX = '(?:sam|nisam|jesam|bih)';
const HR_ADDRESSEE_AUX = '(?:si|nisi|jesi)';
// Glagolski pridevnik: moški -ao/-io/-eo/-uo (rekao, bio, htio, čuo), ženski -la (rekla, bila).
const HR_MASC_PARTICIPLE = '[a-zčćšžđ]{1,14}(?:ao|io|eo|uo)';
const HR_FEM_PARTICIPLE = '[a-zčćšžđ]{1,14}la';
const HR_ADJECTIVES = [
  ['sretan', 'sretna'], ['srećan', 'srećna'], ['spreman', 'spremna'], ['siguran', 'sigurna'], ['umoran', 'umorna'],
  ['lud', 'luda'], ['gladan', 'gladna'], ['ljut', 'ljuta'], ['zaljubljen', 'zaljubljena'], ['mrtav', 'mrtva'],
  ['kriv', 'kriva'], ['ponosan', 'ponosna'], ['svjestan', 'svjesna'], ['zadovoljan', 'zadovoljna'], ['slobodan', 'slobodna'],
  ['gotov', 'gotova'], ['budan', 'budna'], ['živ', 'živa'], ['oženjen', 'udana'], ['zabrinut', 'zabrinuta'],
  ['uplašen', 'uplašena'], ['iznenađen', 'iznenađena'], ['razočaran', 'razočarana'], ['zahvalan', 'zahvalna'],
  ['ozlijeđen', 'ozlijeđena'], ['pijan', 'pijana'], ['bolestan', 'bolesna'], ['zbunjen', 'zbunjena'],
  ['ozbiljan', 'ozbiljna'], ['dobar', 'dobra'], ['lijep', 'lijepa'], ['zgodan', 'zgodna']
];
const HR_FEM_ADJ = [...HR_ADJECTIVES.map(p => p[1]), 'sama', 'trudna'];
const HR_MASC_ADJ = HR_ADJECTIVES.map(p => p[0]);
const HR_NOT_FORM = new Set(['kao', 'dio', 'žao', 'zao', 'nego', 'škola', 'stola', 'dola', 'sela', 'tijela', 'djela', 'mala', 'cijela', 'bijela', 'pola', 'onda']);
const HR_RULES = {
  speaker: buildRules(HR_SPEAKER_AUX, [HR_FEM_PARTICIPLE, wordAlternation(HR_FEM_ADJ)], [HR_MASC_PARTICIPLE, wordAlternation(HR_MASC_ADJ)]),
  addressee: buildRules(HR_ADDRESSEE_AUX, [HR_FEM_PARTICIPLE, wordAlternation(HR_FEM_ADJ)], [HR_MASC_PARTICIPLE, wordAlternation(HR_MASC_ADJ)])
};
// "si" je lahko tudi povratni zaimek ("Uzela si je kaput").
const HR_REFLEXIVE_SI_RE = /(?:^|[^\p{L}])(?:si\s+(?:je|su)|(?:je|su|bi|će)\s+si)(?![\p{L}])/iu;

// --- italijanščina ---
const IT_SPEAKER_AUX = '(?:sono|ero|sarò|sarei)';
const IT_ADDRESSEE_AUX = '(?:sei|eri|sarai|saresti)';
const IT_PAIRS = [
  ['stato', 'stata'], ['andato', 'andata'], ['arrivato', 'arrivata'], ['venuto', 'venuta'], ['rimasto', 'rimasta'],
  ['tornato', 'tornata'], ['partito', 'partita'], ['uscito', 'uscita'], ['entrato', 'entrata'], ['nato', 'nata'],
  ['morto', 'morta'], ['caduto', 'caduta'], ['contento', 'contenta'], ['sicuro', 'sicura'], ['solo', 'sola'],
  ['pronto', 'pronta'], ['stanco', 'stanca'], ['pazzo', 'pazza'], ['innamorato', 'innamorata'], ['sposato', 'sposata'],
  ['ubriaco', 'ubriaca'], ['preoccupato', 'preoccupata'], ['arrabbiato', 'arrabbiata'], ['sorpreso', 'sorpresa'],
  ['ferito', 'ferita'], ['bravo', 'brava'], ['vivo', 'viva'], ['convinto', 'convinta'], ['spaventato', 'spaventata']
];
const IT_RULES = {
  speaker: buildRules(IT_SPEAKER_AUX, [wordAlternation([...IT_PAIRS.map(p => p[1]), 'incinta'])], [wordAlternation(IT_PAIRS.map(p => p[0]))]),
  addressee: buildRules(IT_ADDRESSEE_AUX, [wordAlternation([...IT_PAIRS.map(p => p[1]), 'incinta'])], [wordAlternation(IT_PAIRS.map(p => p[0]))])
};
const NO_EXCLUSIONS = new Set();

// Vrne { speaker, addressee } ('Ženska' | 'Moški' | null) za eno vrstico hrvaškega/italijanskega besedila.
function detectSourceGender(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  if (!t.trim()) return { speaker: null, addressee: null };
  const speaker = matchGender(t, HR_RULES.speaker, HR_NOT_FORM) || matchGender(t, IT_RULES.speaker, NO_EXCLUSIONS);
  const hrAddressee = HR_REFLEXIVE_SI_RE.test(t) ? null : matchGender(t, HR_RULES.addressee, HR_NOT_FORM);
  const addressee = hrAddressee || matchGender(t, IT_RULES.addressee, NO_EXCLUSIONS);
  return { speaker, addressee };
}

// --- slovenščina (prevod) ---
const SL_SPEAKER_AUX = '(?:sem|nisem|bom)';
const SL_ADDRESSEE_AUX = '(?:si|nisi|boš)';
// Opisni deležnik: moški -l (bil, videl, rekel, šel), ženski -la (bila, videla, šla).
const SL_MASC_PARTICIPLE = '[a-zčšž]{0,14}[aeiou]l';
const SL_FEM_PARTICIPLE = '[a-zčšž]{0,14}la';
const SL_NOT_FORM = new Set(['pol', 'del', 'sol', 'val', 'gol', 'dol', 'kol', 'cel', 'mal', 'stol', 'model', 'angel', 'žal', 'dela', 'sila', 'vila', 'mila', 'šola', 'tla', 'zla', 'pola', 'cela', 'kila', 'žila', 'čela', 'bela', 'mala', 'tla', 'gala']);
const SL_ADJECTIVES = [
  ['pripravljen', 'pripravljena'], ['vesel', 'vesela'], ['utrujen', 'utrujena'], ['prepričan', 'prepričana'],
  ['srečen', 'srečna'], ['žalosten', 'žalostna'], ['jezen', 'jezna'], ['lačen', 'lačna'], ['mrtev', 'mrtva'], ['kriv', 'kriva'],
  ['nor', 'nora'], ['ponosen', 'ponosna'], ['zaljubljen', 'zaljubljena'], ['poročen', 'poročena'], ['presenečen', 'presenečena'],
  ['zaskrbljen', 'zaskrbljena'], ['prestrašen', 'prestrašena'], ['živ', 'živa'], ['buden', 'budna'], ['zmeden', 'zmedena'],
  ['razočaran', 'razočarana'], ['hvaležen', 'hvaležna'], ['ranjen', 'ranjena'], ['pijan', 'pijana'], ['bolan', 'bolna'],
  ['siguren', 'sigurna'], ['resen', 'resna'], ['dober', 'dobra'], ['lep', 'lepa'], ['zadovoljen', 'zadovoljna'],
  ['svoboden', 'svobodna'], ['gotov', 'gotova'], ['oženjen', 'oženjena'], ['ločen', 'ločena'], ['zaposlen', 'zaposlena'],
  ['pameten', 'pametna'], ['priden', 'pridna'], ['bister', 'bistra'], ['sam', 'sama']
];
const SL_FEM_ADJ = [...SL_ADJECTIVES.map(p => p[1]), 'noseča'];
const SL_MASC_ADJ = SL_ADJECTIVES.map(p => p[0]);
const SL_RULES = {
  speaker: buildRules(SL_SPEAKER_AUX, [SL_FEM_PARTICIPLE, wordAlternation(SL_FEM_ADJ)], [SL_MASC_PARTICIPLE, wordAlternation(SL_MASC_ADJ)]),
  addressee: buildRules(SL_ADDRESSEE_AUX, [SL_FEM_PARTICIPLE, wordAlternation(SL_FEM_ADJ)], [SL_MASC_PARTICIPLE, wordAlternation(SL_MASC_ADJ)])
};
// "si" je tudi povratni zaimek ("Vzela si je čas", "Vzel si bom dopust").
const SL_REFLEXIVE_SI_RE = /(?:^|[^\p{L}])(?:si\s+(?:je|so|sta|bo|bom|bova|bomo|bodo|sem|sva|smo)|(?:je|so|sta|bo|bodo|bi|sem)\s+si)(?![\p{L}])/iu;

// Vrne { speaker, addressee }: 'Ženska' | 'Moški' | 'mixed' | null za slovensko besedilo.
function detectSlovenianGender(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  if (!t.trim()) return { speaker: null, addressee: null };
  const speaker = matchGender(t, SL_RULES.speaker, SL_NOT_FORM, true);
  const addressee = SL_REFLEXIVE_SI_RE.test(t) ? null : matchGender(t, SL_RULES.addressee, SL_NOT_FORM, true);
  return { speaker, addressee };
}

// ---------- Hrvaški pomočnik: namigi po času ----------

const HELPER_SPEAKER_LINE_RE = /^\s*[-–—]/;
const HELPER_STRIP_RE = /\[[^\]\n]*\]|\([^)\n]*\)|<[^>]+>|\{[^}]*\}|[♪♫]/g;

function cleanHelperLine(line) {
  return String(line || '').replace(HELPER_STRIP_RE, ' ').replace(/^[-–—\s]+/, '').replace(/^[A-ZČĆŠŽĐ0-9 .'-]{2,25}:\s*/, '').replace(/\s{2,}/g, ' ').trim();
}

// Iz vnosov hrvaškega podnapisa ({ timecode, text }) naredi seznam cue-jev s spolnimi namigi.
function buildHelperCues(entries) {
  const cues = [];
  for (const entry of entries || []) {
    if (String(entry.id).trim() === '0') continue;
    const span = entrySpan(entry);
    if (!span) continue;
    const rawLines = String(entry.text || '').split('\n').filter(l => l.trim());
    const lines = rawLines.map(line => ({ ...detectSourceGender(cleanHelperLine(line)), turn: HELPER_SPEAKER_LINE_RE.test(line) }));
    if (!lines.length) continue;
    const twoSpeakers = lines.length === 2 && lines.every(l => l.turn);
    cues.push({ ...span, twoSpeakers, lines });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function overlapping(cues, span, minRatio = 0.5) {
  const found = [];
  for (const cue of cues) {
    if (cue.start >= span.end) break;
    if (cue.end <= span.start) continue;
    const overlap = Math.min(cue.end, span.end) - Math.max(cue.start, span.start);
    const shorter = Math.min(cue.end - cue.start, span.end - span.start);
    if (shorter > 0 && overlap / shorter >= minRatio) found.push(cue);
  }
  return found;
}

function single(values) {
  const set = new Set(values.filter(Boolean));
  return set.size === 1 ? [...set][0] : null;
}

// Doda spolne namige iz poravnanega hrvaškega podnapisa. Obstoječi namigi (SDH oznaka,
// končnice izvirnika) imajo prednost. Vrne število cue-jev, ki so dobili nov namig.
function applyHelperHints(sourceEntries, helperCues) {
  if (!helperCues || !helperCues.length) return 0;
  let added = 0;
  for (const entry of sourceEntries) {
    const span = entrySpan(entry);
    if (!span) continue;
    const hits = overlapping(helperCues, span);
    if (!hits.length) continue;
    const hint = entry.genderHint || (entry.genderHint = { speaker: null, lineSpeakers: null, addressee: null });
    let changed = false;
    if (hint.lineSpeakers) {
      // Cue z dvema govorcema: namig vzamemo le iz enako razdeljenega hrvaškega cue-ja.
      const pair = hits.length === 1 && hits[0].twoSpeakers ? hits[0].lines : null;
      if (pair) {
        hint.lineSpeakers = hint.lineSpeakers.map((g, i) => {
          if (g || !pair[i].speaker) return g;
          changed = true;
          return pair[i].speaker;
        });
      }
    } else {
      const lines = hits.flatMap(cue => (cue.twoSpeakers ? [] : cue.lines));
      const speaker = single(lines.map(l => l.speaker));
      const addressee = single(lines.map(l => l.addressee));
      const conflictingSpeaker = new Set(lines.map(l => l.speaker).filter(Boolean)).size > 1;
      if (!hint.speaker && speaker && !conflictingSpeaker) { hint.speaker = speaker; hint.speakerFromHelper = true; changed = true; }
      if (!hint.addressee && addressee) { hint.addressee = addressee; hint.addresseeFromHelper = true; changed = true; }
    }
    if (changed) {
      entry.genderTag = formatGenderTag(hint);
      added += 1;
    }
  }
  return added;
}

function formatGenderTag(hint) {
  if (!hint) return '';
  const parts = [];
  if (hint.lineSpeakers) {
    if (hint.lineSpeakers.some(Boolean)) {
      parts.push(`[Govorec 1: ${hint.lineSpeakers[0] || 'neznan'}; Govorec 2: ${hint.lineSpeakers[1] || 'neznan'}]`);
    }
  } else if (hint.speaker) {
    parts.push(`[Govorec: ${hint.speaker}]`);
  }
  if (hint.addressee && !hint.lineSpeakers) parts.push(`[Nagovorjeni: ${hint.addressee}]`);
  return parts.join(' ');
}

// ---------- Kontrolni krog ----------

function normalizeSpeakerName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/["'’`.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUnknownName(name) {
  return !name || name === '?' || /^(unknown|neznan|nihče|nobody|none|-)$/i.test(name);
}

function splitNames(value) {
  return String(value || '').split(/\s*(?:\/|;|,|&|\+|\bin\b|\band\b)\s*/i).map(s => s.trim()).filter(Boolean);
}

// Kaj je model sam zapisal o spolu posamezne osebe skozi film: ime -> spol (če je dosleden).
function buildNameConsensus(items, minVotes = 3, minShare = 0.8) {
  const votes = new Map();
  const vote = (name, gender) => {
    const key = normalizeSpeakerName(name);
    if (isUnknownName(key) || !gender) return;
    const v = votes.get(key) || { [FEMALE]: 0, [MALE]: 0 };
    v[gender] += 1;
    votes.set(key, v);
  };
  for (const item of items) {
    const meta = item.meta || {};
    const speakers = splitNames(meta.s);
    if (speakers.length === 1) vote(speakers[0], genderFromLetter(meta.g));
    const addressees = splitNames(meta.to);
    if (addressees.length === 1) vote(addressees[0], genderFromLetter(meta.a));
  }
  const consensus = new Map();
  for (const [name, v] of votes) {
    const total = v[FEMALE] + v[MALE];
    if (total < minVotes) continue;
    if (v[FEMALE] / total >= minShare) consensus.set(name, FEMALE);
    else if (v[MALE] / total >= minShare) consensus.set(name, MALE);
  }
  return consensus;
}

function resolveName(name, lookup, consensus) {
  if (isUnknownName(normalizeSpeakerName(name))) return null;
  const fromLedger = lookup ? lookup(name) : null;
  if (fromLedger) return { gender: fromLedger, why: `${name} je po analizi likov ${genderLabel(fromLedger)}` };
  const fromConsensus = consensus.get(normalizeSpeakerName(name));
  if (fromConsensus) return { gender: fromConsensus, why: `${name} je drugod v filmu ${genderLabel(fromConsensus)}` };
  return null;
}

// Pričakovani spol govorca in nagovorjenega za en cue: { speaker, addressee }, vsak { gender, why } ali null.
function expectedGenders(item, lookup, consensus) {
  const hint = item.hint || {};
  const meta = item.meta || {};
  const names = splitNames(meta.s);
  const addressees = splitNames(meta.to);
  let speaker = null;
  if (!hint.lineSpeakers) {
    if (hint.speaker) speaker = { gender: hint.speaker, why: hint.speakerFromHelper ? `hrvaški podnapis kaže, da govori ${genderLabel(hint.speaker)}` : `oznaka/izvirnik kaže, da govori ${genderLabel(hint.speaker)}` };
    else if (names.length === 1) speaker = resolveName(names[0], lookup, consensus);
  }
  let addressee = null;
  if (!hint.lineSpeakers) {
    if (hint.addressee) addressee = { gender: hint.addressee, why: `${hint.addresseeFromHelper ? 'hrvaški podnapis' : 'izvirnik'} kaže, da je nagovorjena oseba ${genderLabel(hint.addressee)}` };
    else if (addressees.length === 1 && genderFromLetter(meta.a) !== null) addressee = resolveName(addressees[0], lookup, consensus);
  }
  const lineSpeakers = hint.lineSpeakers
    ? hint.lineSpeakers.map((g, i) => (g ? { gender: g, why: `govorec ${i + 1}: ${genderLabel(g)}` } : (names.length === 2 ? resolveName(names[i], lookup, consensus) : null)))
    : null;
  return { speaker, addressee, lineSpeakers };
}

function contradicts(expected, detected) {
  return Boolean(expected && detected && detected !== 'mixed' && detected !== expected.gender);
}

// Vrne seznam spornih cue-jev: [{ id, reasons: [...] }].
// `items`: [{ id, text (slovenski prevod), sourceText, hint, meta: { g, a, s, to } }]
function findGenderIssues(items, { lookup = null } = {}) {
  const consensus = buildNameConsensus(items);
  const issues = [];
  for (const item of items) {
    const text = String(item.text || '');
    if (!text.trim()) continue;
    const expected = expectedGenders(item, lookup, consensus);
    const meta = item.meta || {};
    const reasons = [];
    if (expected.lineSpeakers) {
      const lines = text.split('\n');
      if (lines.length === 2) {
        lines.forEach((line, i) => {
          const exp = expected.lineSpeakers[i];
          const detected = detectSlovenianGender(line).speaker;
          if (contradicts(exp, detected)) reasons.push(`vrstica ${i + 1}: ${exp.why}, prevod pa uporablja ${genderLabel(detected)} obliko za govorca`);
        });
      }
    } else {
      const detected = detectSlovenianGender(text);
      if (contradicts(expected.speaker, detected.speaker)) {
        reasons.push(`${expected.speaker.why}, prevod pa uporablja ${genderLabel(detected.speaker)} obliko za govorca`);
      } else if (expected.speaker && genderFromLetter(meta.g) && genderFromLetter(meta.g) !== expected.speaker.gender && detected.speaker) {
        reasons.push(`${expected.speaker.why}, prevajalec pa je govorca označil kot ${genderLabel(genderFromLetter(meta.g))}`);
      }
      if (contradicts(expected.addressee, detected.addressee)) {
        reasons.push(`${expected.addressee.why}, prevod pa jo nagovarja v ${detected.addressee === FEMALE ? 'ženski' : 'moški'} obliki`);
      } else if (expected.addressee && genderFromLetter(meta.a) && genderFromLetter(meta.a) !== expected.addressee.gender && detected.addressee) {
        reasons.push(`${expected.addressee.why}, prevajalec pa je nagovorjenega označil kot ${genderLabel(genderFromLetter(meta.a))}`);
      }
      if (detected.speaker === 'mixed' && !expected.speaker) reasons.push('isti govorec ima v prevodu hkrati moške in ženske oblike');
    }
    if (reasons.length) issues.push({ id: String(item.id), reasons });
  }
  return issues;
}

function reviewPrompt(context) {
  return `You are the senior Slovenian subtitle editor doing a final GENDER-AGREEMENT check of a finished translation.

CONTEXT:
${context}

TASK:
- You get a list of flagged cues. Each has the source text, the current Slovenian translation, a few neighbouring cues for context and the reason it was flagged.
- Decide who speaks and who is addressed, using the reason, the neighbouring cues and the character list. The reason is strong evidence (it comes from the cast list, a speaker label or a Croatian subtitle that marks gender), but if the neighbouring cues clearly show it is wrong, keep the current translation.
- Fix ONLY gender agreement: past-tense participles ("bil/bila", "šel/šla"), adjectives ("vesel/vesela"), pronouns, dual/plural forms. Do not restyle, do not shorten, do not change meaning. Keep line breaks (max 2 lines, max 42 characters per line).
- If the current translation is already correct, return it unchanged.
- Never add speaker labels or tags like [Govorec: ...].
- Return ONLY JSON: {"fixes":[{"id":"12","text":"Popravljeno besedilo"}]} with every flagged id exactly once.`;
}

function buildReviewUserText(batch, byId, order) {
  const indexOf = new Map(order.map((id, i) => [String(id), i]));
  const blocks = batch.map(issue => {
    const i = indexOf.get(issue.id);
    const around = [];
    for (let k = Math.max(0, i - 3); k <= Math.min(order.length - 1, i + 1); k++) {
      if (k === i) continue;
      const other = byId.get(String(order[k]));
      if (other) around.push(`  ${k < i ? 'prej' : 'potem'}: ${oneLine(other.sourceText)} => ${oneLine(other.text)}`);
    }
    const item = byId.get(issue.id);
    return [
      `[id=${issue.id}]`,
      `  vir: ${oneLine(item.sourceText)}`,
      `  prevod: ${oneLine(item.text)}`,
      `  razlog: ${issue.reasons.join('; ')}`,
      ...around
    ].join('\n');
  });
  return `FLAGGED CUES (line breaks are shown as " / "):\n\n${blocks.join('\n\n')}\n\nReturn JSON only.`;
}

function oneLine(text) {
  return String(text || '').replace(/\n/g, ' / ');
}

function parseReviewJson(raw) {
  const map = new Map();
  try {
    let cleaned = String(raw || '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
    const data = JSON.parse(cleaned);
    const list = Array.isArray(data?.fixes) ? data.fixes : Array.isArray(data?.translations) ? data.translations : [];
    for (const item of list) {
      if (item?.id == null || typeof item.text !== 'string') continue;
      const text = item.text.replace(/\s*\/\s*/g, '\n').replace(/\[(?:Govorec|Govorita|Nagovorjeni|Speaker)[^\]]*\]/gi, '').trim();
      if (text) map.set(String(item.id), text);
    }
  } catch (_) {
    // neveljaven JSON: popravkov ni
  }
  return map;
}

// Pošlje sporne cue-je v popravek. `translate(systemText, userText, options)` vrne surov odgovor modela.
// Vrne Map id -> popravljeno besedilo (samo cue-ji, ki so se res spremenili).
async function reviewGenderIssues(items, issues, { context = '', translate, model, batchSize = 40, maxCues = 400, concurrency = 2, log = () => {} } = {}) {
  const fixes = new Map();
  if (!issues.length || typeof translate !== 'function') return fixes;
  const byId = new Map(items.map(item => [String(item.id), item]));
  const order = items.map(item => String(item.id));
  const selected = issues.slice(0, maxCues);
  if (issues.length > selected.length) log(`omejeno na ${selected.length}/${issues.length} spornih cue-jev`);
  const systemText = reviewPrompt(context);
  const batches = [];
  for (let i = 0; i < selected.length; i += batchSize) batches.push(selected.slice(i, i + batchSize));
  // Dva paketa hkrati, da kontrolni krog ne podaljša čakanja na prevod.
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const index = next++;
      const batch = batches[index];
      try {
        const raw = await translate(systemText, buildReviewUserText(batch, byId, order), {
          model,
          maxOutputTokens: Math.max(4096, batch.length * 160)
        });
        const parsed = parseReviewJson(raw);
        for (const issue of batch) {
          const fixed = parsed.get(issue.id);
          const current = byId.get(issue.id)?.text;
          if (fixed && fixed !== current) fixes.set(issue.id, fixed);
        }
      } catch (error) {
        log(`paket ${index + 1} ni uspel: ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return fixes;
}

module.exports = {
  FEMALE,
  MALE,
  genderFromLetter,
  letterFromGender,
  detectSourceGender,
  detectSlovenianGender,
  buildHelperCues,
  applyHelperHints,
  formatGenderTag,
  buildNameConsensus,
  expectedGenders,
  findGenderIssues,
  reviewPrompt,
  buildReviewUserText,
  parseReviewJson,
  reviewGenderIssues,
  normalizeSpeakerName,
  splitNames
};
