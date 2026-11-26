const express = require('express');
const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');
const subsync = require('./subsync');
const gender = require('./gender');

// Samodejno nalaganje .env datoteke, če obstaja (za razvoj)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim().replace(/^["'](.*)["']$/, '$1');
        if (!process.env[k] && v) process.env[k] = v;
      }
    }
  }
} catch (_) {}

const PORT = Number(process.env.PORT || 7002);
// Velikost chunka je zdaj manjša, da model ne porabi celotnega izhodnega proračuna
// za razmišljanje in da se izogne praznim/okrnjenim odgovorom. Če pride do napake,
// se chunk samodejno razdeli na manjše dele.
const CHUNK_SIZE = Math.max(60, Math.min(250, Number(process.env.CHUNK_SIZE || 120)));
const MIN_SPLIT_CHUNK_SIZE = Math.max(10, Math.min(100, Number(process.env.MIN_SPLIT_CHUNK_SIZE || 30)));
const MAX_SPLIT_DEPTH = Math.max(0, Math.min(5, Number(process.env.MAX_SPLIT_DEPTH || 3)));
const TRANSLATION_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.TRANSLATION_CONCURRENCY || 2)));
const SUBTITLE_FILE_TIMEOUT_MS = Math.max(300000, Number(process.env.SUBTITLE_FILE_TIMEOUT_MS || 300000));
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '.cache');

// Google Gemini Flash konfiguracija (optimiziran model, 15x ceneje, bliskovito hitro)
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
// Dva modela, da je cena nizka in spol vseeno zanesljiv:
// - GEMINI_MODEL prevaja vse podnapise (veliko klicev) -> najcenejši primeren model
//   gemini-3.1-flash-lite (0,25 $ vhod / 1,50 $ izhod na milijon žetonov).
// - ANALYSIS_MODEL enkrat na film določi like in njihov spol (en klic) -> močnejši
//   gemini-3.6-flash, ker se na ta seznam opira ves prevod.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || 'gemini-3.6-flash';
const providerConfig = { name: 'gemini', model: GEMINI_MODEL };

// Če izbrani model pri Googlu ni (več) na voljo (HTTP 404) ali vrne prazen
// odgovor, se uporabi naslednji s seznama: cenejši model najprej poskusi cenejše
// zamenjave, močnejši najprej močnejše. Nedosegljiv model si zapomnimo, da ne
// zapravljamo zahtevka pri vsakem chunku.
const GEMINI_LITE_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
const GEMINI_FULL_MODELS = ['gemini-3.6-flash', 'gemini-3.8-flash'];
const unavailableGeminiModels = new Set();

function geminiModelsToTry(requestedModel) {
  const order = /lite/i.test(requestedModel)
    ? [...GEMINI_LITE_MODELS, ...GEMINI_FULL_MODELS]
    : [...GEMINI_FULL_MODELS, ...GEMINI_LITE_MODELS];
  const all = [requestedModel, ...order, GEMINI_MODEL].filter((model, index, list) => list.indexOf(model) === index);
  const reachable = all.filter(model => !unavailableGeminiModels.has(model));
  return reachable.length ? reachable : all;
}

// Gemini 3.x privzeto vklopi "thinking", ki porabi isti proračun kot izhod.
// Pri prevajanju podnapisov to povzroči prazne odgovore (MAX_TOKENS), zato
// razmišljanje omejimo in izhodni proračun izračunamo glede na število cue-jev.
const GEMINI_THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'low';
const GEMINI_DEFAULT_MAX_OUTPUT_TOKENS = Math.max(1024, Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 32768));
const GEMINI_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_JAILBREAK', threshold: 'BLOCK_ONLY_HIGH' }
];

// Ciljna hitrost branja (characters per second) in omejitev vrstic
// Koliko cue-jev prejšnjega chunka dobi model kot kontekst (kdo govori in komu).
const CONTEXT_CUES = Math.max(0, Math.min(20, Number(process.env.CONTEXT_CUES || 8)));

const TARGET_CPS = Number(process.env.TARGET_CPS || 17);
const MAX_LINE_CHARS = Number(process.env.MAX_LINE_CHARS || 42);
const MAX_LINES = 2;

// 1. AVTOMATSKA IZBIRA VIRA (Prioriteta: 1. Hrvaški, 2. Italijanski, 3. Angleški)
const DEFAULT_LANGUAGE_PRIORITY = ['hr', 'it', 'en'];
const SUPPORTED_SOURCE_LANGUAGES = ['hr', 'it', 'en'];

const LANGUAGE_DISPLAY_NAMES = {
  hr: 'HRVAŠČINA',
  it: 'ITALIJANŠČINA',
  en: 'ANGLEŠČINA'
};

const cache = new Map();
const inflight = new Map();
const completed = new Map();
const jobs = new Map();
const partials = new Map();
// Ključ prevoda -> { error, until }: kako dolgo po napaki ne poskušamo znova.
const recentFailures = new Map();
const FAILURE_RETRY_MS = Math.max(0, Number(process.env.FAILURE_RETRY_MS || 2 * 60 * 1000));

const addonManifest = {
  id: 'com.stremio.slo.ai.translator',
  version: '0.8.2',
  name: 'Slo AI Subtitle Translator (Gemini Flash)',
  description: 'Izjemno hitri in varčni slovenski podnapisi z Gemini Flash: ročna izbira vira (HR, IT, ANG), natančno SDH čiščenje in spolno ujemanje.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: false }
};

// ---------- SRT parsing / building helpers ----------

function parseSrt(srt) {
  const text = String(srt || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const timingRe = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/;
  const entries = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    if (!lines.length) continue;

    let lineIndex = 0;
    let id = lines[0].trim();
    if (/^\d+$/.test(id)) {
      lineIndex = 1;
    } else {
      id = String(entries.length + 1);
    }

    const timingMatch = (lines[lineIndex] || '').match(timingRe);
    if (!timingMatch) continue;

    const start = timingMatch[1].replace('.', ',');
    const end = timingMatch[2].replace('.', ',');
    const textLines = lines.slice(lineIndex + 1);

    entries.push({
      id,
      timecode: `${start} --> ${end}`,
      text: textLines.join('\n').trim()
    });
  }

  return entries;
}

function toSrt(entries) {
  return entries
    .map(e => `${e.id}\n${e.timecode}\n${e.text}`)
    .join('\n\n') + '\n';
}

function chunkSrt(srtOrEntries, chunkSize = CHUNK_SIZE) {
  const entries = Array.isArray(srtOrEntries) ? srtOrEntries : parseSrt(srtOrEntries);
  const chunks = [];
  for (let i = 0; i < entries.length; i += chunkSize) {
    const slice = entries.slice(i, i + chunkSize);
    chunks.push({ index: chunks.length, entries: slice, srt: toSrt(slice) });
  }
  return chunks;
}

function splitIntoTwoLines(text, maxChars = MAX_LINE_CHARS) {
  if (text.length <= maxChars) return text;
  const breakWords = [', ', ' - ', ' in ', ' da ', ' pa ', ' ker ', ' ko ', ' ampak ', ' ali ', ' zato ', '. ', '? ', '! ', ' '];
  for (const bw of breakWords) {
    const parts = text.split(bw);
    if (parts.length < 2) continue;
    let runningLen = 0;
    let bestPos = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < parts.length - 1; i++) {
      runningLen += parts[i].length + bw.length;
      const otherLen = text.length - runningLen;
      const diff = Math.abs(runningLen - otherLen);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestPos = runningLen;
      }
    }
    if (bestPos > 0) {
      const line1 = text.slice(0, bestPos).trim();
      const line2 = text.slice(bestPos).trim();
      if (line1.length <= maxChars && line2.length <= maxChars) {
        return `${line1}\n${line2}`;
      }
    }
  }
  // Sredinski prelom na najbližjem presledku
  const mid = Math.floor(text.length / 2);
  for (let offset = 0; offset < 25; offset++) {
    for (const pos of [mid + offset, mid - offset]) {
      if (pos > 0 && pos < text.length && text[pos] === ' ') {
        return `${text.slice(0, pos).trim()}\n${text.slice(pos + 1).trim()}`;
      }
    }
  }
  return text;
}

function parseAndValidateSrt(source, translated) {
  const original = parseSrt(source);
  const result = parseSrt(translated);
  if (!original.length || original.length !== result.length) {
    throw new Error(`Invalid translated SRT entry count: ${result.length}/${original.length}`);
  }
  for (let i = 0; i < original.length; i += 1) {
    if (original[i].id !== result[i].id || original[i].timecode !== result[i].timecode || !result[i].text) {
      throw new Error(`Invalid SRT structure at cue ${i + 1}`);
    }
  }
  return result;
}

function reconcileTranslatedSrt(source, candidate) {
  const original = parseSrt(source);
  const translated = parseSrt(candidate);
  if (!original.length) throw new Error('Invalid source SRT');
  const byId = new Map(translated.map(entry => [String(entry.id), entry]));
  const repaired = original.map(entry => {
    const found = byId.get(String(entry.id));
    let text = found?.text?.trim() || entry.text;
    // Očisti tehnične oznake govorca [Govorec: ...] in formatiraj na max 2 vrstici
    text = text.replace(SPEAKER_TAG_CLEAN_RE, '').replace(/\s{2,}/g, ' ').trim();
    if (text.length > MAX_LINE_CHARS && !text.includes('\n')) {
      text = splitIntoTwoLines(text);
    }
    return { id: entry.id, timecode: entry.timecode, text };
  });
  return toSrt(repaired);
}

function validateSlovenianSubtitle(text) {
  const lines = String(text || '').split('\n');
  return lines.length <= MAX_LINES && lines.every(line => line.length <= MAX_LINE_CHARS);
}

// ---------- 2. ČIŠČENJE SDH (Subtitles for the Deaf and Hard of Hearing) IN PREPOZNAVA SPOLA GOVORCA ----------

const SDH_BRACKET_RE = /\[[^\]\n]*\]/g;
const SDH_PAREN_RE = /\((?:laughter|giggle|gasp|sobbing|crying|music|sigh|groan|screaming|whisper|cough|applause|cheering|chuckle|snicker)[^)\n]*\)/gi;
const SDH_ASTERISK_RE = /\*[^*]*\*/g;
const SDH_MUSIC_NOTE_RE = /[♪♫][^♪♫\n]*[♪♫]?/g;
const SDH_SPEAKER_LABEL_RE = /^[-\s]*[A-ZČŠŽĐĆ0-9 .'-]{2,30}:\s*/;
const SPEAKER_TAG_CLEAN_RE = /\[(?:Govorec|Govorita|Nagovorjeni|Speaker)[^\]]*\]/gi;

function extractSpeakerFromRawText(rawText) {
  const m = String(rawText || '').match(/^[-\s]*([A-ZČŠŽĐĆa-z0-9 .'-]{2,25}):\s*/);
  if (m) return m[1].trim();
  const bm = String(rawText || '').match(/^\[([A-ZČŠŽĐĆa-z0-9 .'-]{2,25})\]\s*/);
  if (bm) return bm[1].trim();
  return null;
}

function detectGenderFromDialogue(text) {
  const t = String(text || '').toLowerCase();
  // Hrvaške / Srbske / Bosanske ženske končnice
  if (/\b(rekla|bila|vidjela|vidila|htjela|mogla|srećna|sretna|spremna|sama|sigurna|zadovoljna|znala|mislila|osjetila|došla|otišla|morala)\s+(sam|sam bila|bih)\b/i.test(t) ||
      /\b(sam|sam bila)\s+(rekla|bila|vidjela|vidila|htjela|mogla|srećna|sretna|spremna|sama|sigurna|zadovoljna|znala|mislila|osjetila|došla|otišla|morala)\b/i.test(t)) {
    return 'Ženska';
  }
  // Hrvaške / Srbske / Bosanske moške končnice
  if (/\b(rekao|bio|vidio|htio|mogao|srećan|sretan|spreman|sam|siguran|zadovoljan|znao|mislio|osjetio|došao|otišao|morao)\s+(sam|sam bio|bih)\b/i.test(t) ||
      /\b(sam|sam bio)\s+(rekao|bio|vidio|htio|mogao|srećan|sretan|spreman|sam|siguran|zadovoljan|znao|mislio|osjetio|došao|otišao|morao)\b/i.test(t)) {
    return 'Moški';
  }
  // Italijanske ženske končnice
  if (/\b(sono|ero|stata)\s+(andata|arrivata|stata|venuta|rimasta|tornata|contenta|sicura|sola|pronta)\b/i.test(t)) {
    return 'Ženska';
  }
  // Italijanske moške končnice
  if (/\b(sono|ero|stato)\s+(andato|arrivato|stato|venuto|rimasto|tornato|contento|sicuro|solo|pronto)\b/i.test(t)) {
    return 'Moški';
  }
  return null;
}

function stripSdhFromLine(line) {
  return String(line || '')
    .replace(SDH_BRACKET_RE, '')
    .replace(SDH_PAREN_RE, '')
    .replace(SDH_ASTERISK_RE, '')
    .replace(SDH_MUSIC_NOTE_RE, '')
    .replace(SDH_SPEAKER_LABEL_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function removeSdhEntries(srtText, characterMap = new Map()) {
  const parsed = parseSrt(srtText);
  const entries = [];
  let index = 1;

  for (const entry of parsed) {
    const rawLines = entry.text.split('\n');

    // Spol določimo za vsako vrstico posebej: ime govorca iz SDH oznake ("ANA:")
    // ima prednost (TMDB / analiza likov), sicer slovnične končnice izvirnika.
    const lineInfo = rawLines
      .map(line => {
        const speaker = extractSpeakerFromRawText(line);
        const grammar = gender.detectSourceGender(line);
        const speakerGender = lookupCharacterGender(characterMap, speaker) || detectGenderFromDialogue(line) || grammar.speaker;
        return { text: stripSdhFromLine(line), gender: speakerGender, addressee: grammar.addressee, startsTurn: /^\s*[-–—]/.test(line) || Boolean(speaker) };
      })
      .filter(info => info.text);
    if (!lineInfo.length) continue;
    const cleanedLines = lineInfo.map(info => info.text);

    // Cue z dvema govorcema ("- ...\n- ..."): vsak govorec dobi svojo oznako.
    const isTwoSpeakerCue = lineInfo.length === 2 && lineInfo.every(info => info.startsTurn);
    const genderHint = isTwoSpeakerCue
      ? { speaker: null, lineSpeakers: lineInfo.map(info => info.gender || null), addressee: null }
      : {
          speaker: lineInfo.map(info => info.gender).find(Boolean) || null,
          lineSpeakers: null,
          addressee: lineInfo.map(info => info.addressee).find(Boolean) || null
        };
    const genderTag = gender.formatGenderTag(genderHint);

    entries.push({
      ...entry,
      id: String(index++),
      text: cleanedLines.join('\n'),
      genderTag,
      genderHint
    });
  }

  return entries;
}

function removeSdh(srtText, characterMap = new Map()) {
  const entries = removeSdhEntries(srtText, characterMap);
  return toSrt(entries);
}

// ---------- Reading-speed (CPS) & Timing Sync helpers ----------

function secondsToTimecode(sec) {
  const safeSec = Math.max(0, Number(sec) || 0);
  const hours = Math.floor(safeSec / 3600);
  const minutes = Math.floor((safeSec % 3600) / 60);
  const seconds = Math.floor(safeSec % 60);
  const ms = Math.floor((safeSec % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function timecodeToSeconds(hms) {
  const m = String(hms || '').trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!m) return 0;
  const [, hh, mm, ss, ms] = m;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
}

function shiftSrtTimings(srtText, offsetSeconds = 0) {
  if (!offsetSeconds || Math.abs(offsetSeconds) < 0.01) return srtText;
  const entries = parseSrt(srtText);
  const shifted = entries.map(entry => {
    const [startStr, endStr] = String(entry.timecode || '').split(' --> ');
    const startSec = Math.max(0, timecodeToSeconds(startStr) + offsetSeconds);
    const endSec = Math.max(startSec + 0.3, timecodeToSeconds(endStr) + offsetSeconds);
    return {
      ...entry,
      timecode: `${secondsToTimecode(startSec)} --> ${secondsToTimecode(endSec)}`
    };
  });
  return toSrt(shifted);
}

function autoDetectSyncOffset(sourceFileName, videoFileName) {
  const src = String(sourceFileName || '').toLowerCase();
  const vid = String(videoFileName || '').toLowerCase();
  if (!src || !vid) return 0;

  const isSrcWeb = /web-?dl|webrip|\.web\./i.test(src);
  const isVidWeb = /web-?dl|webrip|\.web\./i.test(vid);
  const isSrcBluray = /bluray|bdrip|brrip/i.test(src);
  const isVidBluray = /bluray|bdrip|brrip/i.test(vid);

  if (isSrcWeb && isVidBluray) return -1.0;
  if (isSrcBluray && isVidWeb) return 1.0;
  return 0;
}

function cueDurationSeconds(entry) {
  const [start, end] = String(entry.timecode || '').split(' --> ');
  return Math.max(0.2, timecodeToSeconds(end) - timecodeToSeconds(start));
}

function maxCharsForDuration(durationSeconds, targetCps = TARGET_CPS) {
  return Math.max(8, Math.min(MAX_LINES * MAX_LINE_CHARS, Math.round(durationSeconds * targetCps)));
}

function findTooFastCues(entries) {
  const overLimit = [];
  for (const entry of entries) {
    const duration = cueDurationSeconds(entry);
    const budget = maxCharsForDuration(duration);
    const length = entry.text.replace(/\n/g, ' ').length;
    if (length > budget * 1.15) overLimit.push({ id: entry.id, text: entry.text, budget });
  }
  return overLimit;
}

// ---------- Metadata (TMDB) ----------

function tmdbCastToCredits(cast) {
  return (cast || []).map(c => ({
    name: c.character ? `${c.character} (${c.name})` : c.name,
    character: c.character || '',
    actor: c.name || '',
    gender: c.gender
  }));
}

async function tmdbMetadata(imdbId, season, episode) {
  if (!process.env.TMDB_API_KEY) return { title: imdbId, overview: 'Not provided', genres: [], credits: [], originalLanguage: null };
  const base = 'https://api.themoviedb.org/3';
  const find = await axios.get(`${base}/find/${encodeURIComponent(imdbId)}`, {
    params: { api_key: process.env.TMDB_API_KEY, language: 'en-US', external_source: 'imdb_id' }
  });
  const item = find.data.movie_results?.[0] || find.data.tv_results?.[0];
  if (!item) return { title: imdbId, overview: 'Not provided', genres: [], credits: [], originalLanguage: null };
  const type = find.data.movie_results?.length ? 'movie' : 'tv';
  const details = await axios.get(`${base}/${type}/${item.id}`, {
    params: { api_key: process.env.TMDB_API_KEY, language: 'en-US', append_to_response: 'credits' }
  });
  let cast = (details.data.credits?.cast || []).slice(0, 40);

  // Pri serijah dodamo še gostujoče igralce točno te epizode — ti v splošnem
  // seznamu serije manjkajo, v dialogu epizode pa pogosto govorijo.
  if (type === 'tv' && season && episode) {
    try {
      const ep = await axios.get(`${base}/tv/${item.id}/season/${season}/episode/${episode}/credits`, {
        params: { api_key: process.env.TMDB_API_KEY, language: 'en-US' }
      });
      const seen = new Set(cast.map(c => c.id));
      const extra = [...(ep.data.cast || []), ...(ep.data.guest_stars || [])].filter(c => !seen.has(c.id));
      cast = [...cast, ...extra].slice(0, 60);
    } catch (error) {
      console.warn(`[tmdb] episode credits failed for ${imdbId} S${season}E${episode}: ${error.message}`);
    }
  }

  return {
    title: details.data.title || details.data.name || imdbId,
    overview: details.data.overview || 'Not provided',
    genres: (details.data.genres || []).map(g => g.name),
    originalLanguage: details.data.original_language || null,
    credits: tmdbCastToCredits(cast)
  };
}

// ---------- Zemljevid ime lika -> spol (TMDB + analiza dialoga) ----------

const NAME_STOPWORDS = new Set([
  'the', 'and', 'von', 'van', 'del', 'der', 'voice', 'uncredited', 'young', 'old', 'self',
  'mr', 'mrs', 'ms', 'miss', 'dr', 'sir', 'lady', 'lord', 'agent', 'officer', 'detective',
  'captain', 'sergeant', 'doctor', 'professor', 'father', 'mother', 'man', 'woman', 'boy', 'girl'
]);

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/["'’`.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Vrne Map: normalizirano ime (polno ime, vzdevek, ime, priimek) -> 'Ženska' | 'Moški'.
// Ključ, ki bi kazal na lika različnih spolov (npr. skupni priimek), se zavrže.
function buildCharacterGenderMap(meta = {}, ledger = []) {
  const map = new Map();
  const conflicted = new Set();
  const strong = new Set();

  const add = (key, gender, isStrong) => {
    if (!key || key.length < 2 || conflicted.has(key)) return;
    if (strong.has(key) && !isStrong) return;
    if (map.has(key) && map.get(key) !== gender) {
      if (isStrong && !strong.has(key)) {
        map.set(key, gender);
        strong.add(key);
        return;
      }
      map.delete(key);
      conflicted.add(key);
      return;
    }
    map.set(key, gender);
    if (isStrong) strong.add(key);
  };

  const addCharacter = (rawName, gender, isStrong) => {
    // TMDB zapisuje vzdevke kot "Tony Stark / Iron Man".
    for (const alias of String(rawName || '').split(/\s*\/\s*|\s+aka\s+/i)) {
      const full = normalizeName(alias);
      if (!full) continue;
      add(full, gender, isStrong);
      const tokens = full.split(' ').filter(t => t.length >= 3 && !NAME_STOPWORDS.has(t));
      if (tokens.length > 1) for (const token of tokens) add(token, gender, isStrong);
    }
  };

  // Pri animaciji ženske pogosto posodijo glas dečkom, zato tam bolj zaupamo dialogu.
  const isAnimation = (meta.genres || []).some(g => /animation/i.test(g));
  const tmdbEntries = (meta.credits || [])
    .map(c => ({ name: c.character || c.name, gender: c.gender === 1 ? 'Ženska' : (c.gender === 2 ? 'Moški' : null) }))
    .filter(c => c.name && c.gender);
  const ledgerEntries = (ledger || [])
    .map(c => ({
      names: [c.name, ...(Array.isArray(c.aliases) ? c.aliases : [])],
      gender: c.gender === 'female' ? 'Ženska' : (c.gender === 'male' ? 'Moški' : null),
      confident: c.confidence === 'high'
    }))
    .filter(c => c.gender);

  for (const c of tmdbEntries) addCharacter(c.name, c.gender, !isAnimation);
  for (const c of ledgerEntries) {
    for (const name of c.names) addCharacter(name, c.gender, isAnimation && c.confident);
  }
  return map;
}

function lookupCharacterGender(characterMap, speaker) {
  if (!characterMap || !speaker) return null;
  const full = normalizeName(speaker);
  if (characterMap.has(full)) return characterMap.get(full);
  const tokens = full.split(' ').filter(t => t.length >= 3 && !NAME_STOPWORDS.has(t));
  const hits = new Set(tokens.map(t => characterMap.get(t)).filter(Boolean));
  return hits.size === 1 ? [...hits][0] : null;
}

function buildMetadataContext(meta = {}) {
  const genderLabel = { 1: 'Female', 2: 'Male', 3: 'Non-binary' };
  const characters = (meta.credits || [])
    .map(c => `${c.name}: ${genderLabel[c.gender] || 'Unknown'}`)
    .join('\n') || 'No character gender metadata available.';
  const genresText = (meta.genres && meta.genres.length) ? meta.genres.join(', ') : 'General';
  return `Title: ${meta.title || 'Unknown'}\nGenres: ${genresText}\nPlot: ${meta.overview || 'Not provided'}\nTMDB Cast Genders:\n${characters}`;
}

// ---------- 1. OpenSubtitles Iskanje po Prioriteti (HR -> IT -> EN) ----------

function resolveSourceLanguages(meta, requested, strict) {
  const req = String(requested || '').toLowerCase();
  if (strict && SUPPORTED_SOURCE_LANGUAGES.includes(req) && req !== 'auto') {
    return [req];
  }
  if (req && req !== 'auto' && SUPPORTED_SOURCE_LANGUAGES.includes(req)) {
    return [req, ...DEFAULT_LANGUAGE_PRIORITY.filter(l => l !== req)];
  }
  return [...DEFAULT_LANGUAGE_PRIORITY];
}

let openSubtitlesToken = null;
let openSubtitlesLoginPromise = null;

let openSubtitlesCredentialsWarned = false;

// Opis napake OpenSubtitles: status in sporočilo strežnika (npr. "401 Invalid token").
function openSubtitlesErrorDetail(error) {
  const status = error?.response?.status;
  const data = error?.response?.data;
  let message = '';
  if (data && typeof data === 'object') message = data.message || (Array.isArray(data.errors) ? data.errors.join('; ') : '') || '';
  else if (typeof data === 'string') message = data.slice(0, 160);
  return [status, message || error?.message].filter(Boolean).join(' ');
}

async function openSubtitlesLogin() {
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;
  if (!username || !password) {
    if (!openSubtitlesCredentialsWarned) {
      openSubtitlesCredentialsWarned = true;
      console.warn('[opensubtitles] OPENSUBTITLES_USERNAME/OPENSUBTITLES_PASSWORD nista nastavljena - prenosi so anonimni (OpenSubtitles jih lahko zavrne z 401)');
    }
    return null;
  }
  if (openSubtitlesToken && openSubtitlesToken.expiresAt > Date.now()) return openSubtitlesToken.value;

  if (openSubtitlesLoginPromise) return openSubtitlesLoginPromise;

  openSubtitlesLoginPromise = (async () => {
    try {
      const response = await axios.post('https://api.opensubtitles.com/api/v1/login', { username, password }, {
        headers: {
          'Api-Key': process.env.OPENSUBTITLES_API_KEY,
          'User-Agent': process.env.OPENSUBTITLES_USER_AGENT || 'SloAIAddon v0.7.0',
          'Content-Type': 'application/json',
          Accept: '*/*'
        }
      });
      const token = response.data?.token;
      if (!token) {
        console.warn('[opensubtitles] prijava ni vrnila žetona - prenosi so anonimni');
        return null;
      }
      // VIP računi morajo nadaljnje zahteve pošiljati na base_url iz prijave.
      const baseUrl = String(response.data?.base_url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      openSubtitlesToken = { value: token, expiresAt: Date.now() + 23 * 60 * 60 * 1000, baseUrl: baseUrl || null };
      const remaining = response.data?.user?.remaining_downloads ?? response.data?.user?.allowed_downloads;
      console.log(`[opensubtitles] logged in, using authenticated (higher-quota) access${baseUrl ? ` via ${baseUrl}` : ''}${remaining != null ? `, prenosov danes: ${remaining}` : ''}`);
      return token;
    } catch (error) {
      console.warn(`[opensubtitles] login failed, falling back to anonymous access: ${openSubtitlesErrorDetail(error)}`);
      return null;
    } finally {
      openSubtitlesLoginPromise = null;
    }
  })();

  return openSubtitlesLoginPromise;
}

async function openSubtitlesHeaders() {
  const token = await openSubtitlesLogin();
  const headers = {
    'Api-Key': process.env.OPENSUBTITLES_API_KEY,
    'User-Agent': process.env.OPENSUBTITLES_USER_AGENT || 'SloAIAddon v0.7.0',
    Accept: '*/*'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

let openSubtitlesQueue = Promise.resolve();
function withOpenSubtitlesLimit(task) {
  const run = openSubtitlesQueue.then(task, task);
  openSubtitlesQueue = run.then(() => {}, () => {});
  return run;
}

// ---------- Iskanje, skrbna izbira in sinhronizacija izvornih podnapisov ----------
//
// 1. Če ima video hash, poiščemo VSE podnapise, ki se na OpenSubtitles ujemajo s
//    hashem (v kateremkoli jeziku). Ti so časovno narejeni za točno to datoteko.
// 2. Če med njimi obstaja podnapis v želenem jeziku, ga vzamemo neposredno.
// 3. Sicer je eden od njih "referenca": kandidate v želenem jeziku razvrstimo po
//    metapodatkih (ime izdaje, vir WEB/BluRay, skupina, AI prevod ...), najboljše
//    prenesemo in vsakega časovno primerjamo z referenco (subsync.js). Izberemo
//    tistega z najboljšim potrjenim ujemanjem in ga premaknemo/raztegnemo na čase
//    reference.
// 4. Brez reference (ni hasha ali ni zadetkov) izberemo kandidata, katerega ime
//    izdaje se najbolj ujema z imenom video datoteke.

const OPENSUBTITLES_API = 'https://api.opensubtitles.com/api/v1';
const OPENSUBTITLES_LANGUAGE_CODES = { hr: 'hr,sr,bs', it: 'it', en: 'en', sl: 'sl' };
const LANGUAGE_GROUPS = { hr: 'hr', sr: 'hr', bs: 'hr', it: 'it', en: 'en', sl: 'sl' };
// Koliko kandidatov enega jezika največ prenesemo in časovno preverimo (prenosi štejejo v dnevno kvoto OpenSubtitles).
const SYNC_MAX_CANDIDATES = Math.max(1, Math.min(6, Number(process.env.SYNC_MAX_CANDIDATES || 3)));
// Koliko NOVIH prenosov (brez predpomnilnika) sme porabiti en prevod pri izbiri vira.
const SYNC_DOWNLOAD_BUDGET = Math.max(1, Math.min(15, Number(process.env.SYNC_DOWNLOAD_BUDGET || 6)));
// Koliko ročno izbirnih virov na jezik pokažemo v Stremiu.
const MANUAL_CHOICES_PER_LANGUAGE = Math.max(0, Math.min(8, Number(process.env.MANUAL_CHOICES_PER_LANGUAGE || 4)));
const SUBTITLE_SYNC_ENABLED = String(process.env.SUBTITLE_SYNC || 'true').toLowerCase() !== 'false';

function languageGroup(code) {
  return LANGUAGE_GROUPS[String(code || '').toLowerCase()] || String(code || '').toLowerCase();
}

function toSubtitleCandidate(item) {
  const a = item?.attributes || {};
  const file = a.files?.[0] || {};
  return {
    fileId: file.file_id ? String(file.file_id) : null,
    fileName: String(file.file_name || ''),
    release: String(a.release || ''),
    language: String(a.language || '').toLowerCase(),
    moviehashMatch: a.moviehash_match === true,
    downloads: Number(a.download_count || 0),
    fps: Number(a.fps || 0),
    hearingImpaired: Boolean(a.hearing_impaired),
    machineTranslated: Boolean(a.ai_translated || a.machine_translated),
    trusted: Boolean(a.from_trusted)
  };
}

function baseOpenSubtitlesParams(imdbId, season, episode) {
  const params = { imdb_id: String(imdbId).replace(/^tt/, ''), order_by: 'download_count', order_direction: 'desc' };
  if (season && episode) {
    params.season_number = season;
    params.episode_number = episode;
  }
  return params;
}

async function searchOpenSubtitles(params) {
  return withOpenSubtitlesLimit(async () => {
    const headers = await openSubtitlesHeaders();
    const response = await axios.get(`${OPENSUBTITLES_API}/subtitles`, { headers, params, timeout: 15000 });
    return (response.data?.data || []).map(toSubtitleCandidate).filter(c => c.fileId);
  });
}

const downloadedSubtitleFiles = new Map();

function openSubtitlesFilePath(fileId) {
  return path.join(CACHE_DIR, 'opensubtitles', `${String(fileId).replace(/[^0-9a-z_-]/gi, '_')}.srt`);
}

function isSubtitleFileCached(fileId) {
  return downloadedSubtitleFiles.has(String(fileId)) || fs.existsSync(openSubtitlesFilePath(fileId));
}

function openSubtitlesDownloadError(error) {
  const wrapped = new Error(`OpenSubtitles prenos zavrnjen: ${openSubtitlesErrorDetail(error)}`);
  wrapped.status = error?.response?.status;
  wrapped.code = 'OPENSUBTITLES_DOWNLOAD';
  return wrapped;
}

// Prenos z diskovnim predpomnilnikom, da ista datoteka ne porabi kvote dvakrat.
function downloadOpenSubtitleFile(fileId) {
  const id = String(fileId);
  if (downloadedSubtitleFiles.has(id)) return downloadedSubtitleFiles.get(id);
  const job = (async () => {
    const filePath = openSubtitlesFilePath(id);
    try {
      if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
    } catch (_) {}
    const srt = await withOpenSubtitlesLimit(async () => {
      const requestLink = async () => {
        const headers = await openSubtitlesHeaders();
        const api = openSubtitlesToken?.baseUrl ? `https://${openSubtitlesToken.baseUrl}/api/v1` : OPENSUBTITLES_API;
        return axios.post(`${api}/download`, { file_id: Number(id) || id }, { headers, timeout: 15000 });
      };
      let download;
      try {
        download = await requestLink();
      } catch (error) {
        const status = error?.response?.status;
        // Neveljaven ali potekel žeton: prijavimo se znova in poskusimo še enkrat.
        if ((status === 401 || status === 403) && openSubtitlesToken) {
          console.warn(`[opensubtitles] prenos ${id} zavrnjen (${openSubtitlesErrorDetail(error)}) - ponovna prijava`);
          openSubtitlesToken = null;
          try {
            download = await requestLink();
          } catch (retryError) {
            throw openSubtitlesDownloadError(retryError);
          }
        } else {
          throw openSubtitlesDownloadError(error);
        }
      }
      if (!download.data?.link) throw new Error(`OpenSubtitles ni vrnil povezave za datoteko ${id}`);
      const file = await axios.get(download.data.link, { responseType: 'text', transformResponse: body => body, timeout: 20000 });
      return String(file.data || '');
    });
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, srt, 'utf8');
    } catch (err) {
      console.warn(`[opensubtitles] datoteke ${id} ni bilo mogoče shraniti: ${err.message}`);
    }
    return srt;
  })();
  downloadedSubtitleFiles.set(id, job);
  job.catch(() => downloadedSubtitleFiles.delete(id));
  return job;
}

function releaseSourceFamily(name) {
  const n = String(name || '').toLowerCase();
  if (/blu-?ray|bdrip|brrip|bdremux|\bbd(?:25|50)?\b|remux/.test(n)) return 'bluray';
  if (/web-?dl|web-?rip|\bweb\b|\bamzn\b|\bnf\b|\bdsnp\b|\bhmax\b|\batvp\b|\bhulu\b|\bmax\b/.test(n)) return 'web';
  if (/hdtv|pdtv|\btvrip\b/.test(n)) return 'tv';
  if (/dvd/.test(n)) return 'dvd';
  return null;
}

function releaseGroupName(name) {
  const stripped = String(name || '').replace(/\.(srt|sub|ass|ssa|vtt|mkv|mp4|avi|m4v|ts)$/i, '').replace(/\[[^\]]*\]$/, '').trim();
  const match = stripped.match(/-([a-z0-9]{2,})$/i);
  return match ? match[1].toLowerCase() : null;
}

function releaseEditionTags(name) {
  const n = String(name || '').toLowerCase();
  const tags = new Set();
  if (/extended/.test(n)) tags.add('extended');
  if (/director'?s?.?cut|\bdc\b/.test(n)) tags.add('directors');
  if (/unrated|uncut/.test(n)) tags.add('unrated');
  if (/theatrical/.test(n)) tags.add('theatrical');
  if (/\bimax\b/.test(n)) tags.add('imax');
  return tags;
}

function releaseTokens(name) {
  return new Set(String(name || '').toLowerCase().replace(/\.(srt|sub|mkv|mp4|avi)$/i, '').split(/[^a-z0-9]+/).filter(token => token.length >= 2));
}

// Ocena kandidata samo iz metapodatkov (brez prenosa). Višje = bolje.
function scoreSubtitleCandidate(candidate, videoFileName) {
  let score = 0;
  if (candidate.moviehashMatch) score += 100;
  // Strojno preveden vir bi Gemini prevajal "prevod prevoda" - le v skrajni sili.
  if (candidate.machineTranslated) score -= 80;
  if (candidate.trusted) score += 5;
  score += Math.min(10, Math.log10(1 + candidate.downloads) * 2.5);

  const video = String(videoFileName || '');
  if (video) {
    const names = `${candidate.release} ${candidate.fileName}`;
    const videoFamily = releaseSourceFamily(video);
    const subFamily = releaseSourceFamily(names);
    if (videoFamily && subFamily) score += videoFamily === subFamily ? 15 : -10;

    const videoGroup = releaseGroupName(video);
    if (videoGroup && [candidate.release, candidate.fileName].some(n => releaseGroupName(n) === videoGroup || releaseTokens(n).has(videoGroup))) score += 20;

    const videoEdition = [...releaseEditionTags(video)].sort().join(',');
    const subEdition = [...releaseEditionTags(names)].sort().join(',');
    if (videoEdition !== subEdition) score -= 15;

    const a = releaseTokens(video);
    const b = releaseTokens(names);
    let common = 0;
    for (const token of a) if (b.has(token)) common++;
    const union = a.size + b.size - common;
    if (union > 0) score += (common / union) * 20;
  }
  return score;
}

function rankSubtitleCandidates(candidates, videoFileName) {
  return [...candidates]
    .map(c => ({ ...c, metaScore: scoreSubtitleCandidate(c, videoFileName) }))
    .sort((a, b) => b.metaScore - a.metaScore);
}

function candidateLabel(candidate) {
  const name = candidate.release || candidate.fileName || `datoteka ${candidate.fileId}`;
  return name.length > 60 ? `${name.slice(0, 57)}...` : name;
}

// Kontekst ene izbire vira: hash zadetki, referenca in proračun prenosov.
function createSourceSelection({ imdbId, videoHash, videoFileName, season, episode }) {
  let hashSearch = null;
  let referencePromise = null;
  const selection = {
    imdbId,
    videoHash,
    videoFileName,
    season,
    episode,
    budget: SYNC_DOWNLOAD_BUDGET,

    hashMatches() {
      if (!videoHash) return Promise.resolve([]);
      if (!hashSearch) {
        hashSearch = searchOpenSubtitles({ ...baseOpenSubtitlesParams(imdbId, season, episode), moviehash: videoHash, moviehash_match: 'only' })
          .then(list => list.filter(c => c.moviehashMatch))
          .catch(error => {
            console.warn(`[sync] iskanje po hashu (${imdbId}) ni uspelo: ${error.message}`);
            return [];
          });
      }
      return hashSearch;
    },

    // Referenčna časovnica: podnapis, ki se ujema s hashem videa (jezik ni pomemben).
    reference() {
      if (!SUBTITLE_SYNC_ENABLED || !videoHash) return Promise.resolve(null);
      if (!referencePromise) {
        referencePromise = (async () => {
          const matches = await selection.hashMatches();
          const order = ['en', 'hr', 'it', 'sl'];
          const ranked = [...matches].sort((a, b) => {
            if (a.machineTranslated !== b.machineTranslated) return a.machineTranslated ? 1 : -1;
            const ra = order.indexOf(languageGroup(a.language)); const rb = order.indexOf(languageGroup(b.language));
            const oa = ra < 0 ? order.length : ra; const ob = rb < 0 ? order.length : rb;
            return oa - ob || b.downloads - a.downloads;
          });
          for (const candidate of ranked.slice(0, 2)) {
            try {
              const srt = await selection.download(candidate);
              if (subsync.extractCues(srt).length >= subsync.DEFAULT_THRESHOLDS.minMatches) {
                console.log(`[sync] referenčna časovnica: ${candidate.language} "${candidateLabel(candidate)}" (ujema se s hashem videa)`);
                return { srt, candidate };
              }
            } catch (error) {
              console.warn(`[sync] referenčne datoteke ${candidate.fileId} ni bilo mogoče prenesti: ${error.message}`);
            }
          }
          return null;
        })();
      }
      return referencePromise;
    },

    downloadError: null,

    async download(candidate) {
      const cached = isSubtitleFileCached(candidate.fileId);
      if (!cached) {
        if (selection.budget <= 0) throw new Error('porabljen proračun prenosov za to izbiro');
        selection.budget -= 1;
      }
      try {
        return await downloadOpenSubtitleFile(candidate.fileId);
      } catch (error) {
        if (error.code === 'OPENSUBTITLES_DOWNLOAD') selection.downloadError = error;
        throw error;
      }
    }
  };
  return selection;
}

// Časovno preveri (in po potrebi popravi) en podnapis glede na referenco.
async function syncAgainstReference(selection, srt, label) {
  const reference = await selection.reference();
  if (!reference) return { srt, sync: null, verified: false };
  if (reference.candidate && label && label.fileId && reference.candidate.fileId === label.fileId) {
    return { srt, sync: { ok: true, inSync: true, score: 1 }, verified: true };
  }
  const result = subsync.computeSync(reference.srt, srt);
  const name = label ? candidateLabel(label) : 'podnapis';
  console.log(`[sync] ${name}: ${subsync.describeSync(result)}`);
  if (!result.ok) return { srt, sync: result, verified: false };
  return { srt: subsync.applySync(srt, result), sync: result, verified: true };
}

// Izbere najboljši podnapis enega jezika. Vrne null, če v tem jeziku ni nič.
async function selectSubtitleForLanguage(selection, language) {
  const { imdbId, season, episode, videoFileName } = selection;
  const hashMatches = (await selection.hashMatches()).filter(c => languageGroup(c.language) === language && !c.machineTranslated);
  if (hashMatches.length) {
    const best = rankSubtitleCandidates(hashMatches, videoFileName)[0];
    try {
      const srt = await selection.download(best);
      console.log(`[sync] ${language}: "${candidateLabel(best)}" se ujema s hashem videa - časovnica je že pravilna`);
      return { srt, language, fileName: best.fileName || `${imdbId}.${language}.srt`, candidate: best, matchedByHash: true, verified: true, sync: { ok: true, inSync: true, score: 1 } };
    } catch (error) {
      console.warn(`[sync] ${language}: prenos hash zadetka ni uspel: ${error.message}`);
    }
  }

  const candidates = await searchOpenSubtitles({ ...baseOpenSubtitlesParams(imdbId, season, episode), languages: OPENSUBTITLES_LANGUAGE_CODES[language] || language });
  if (!candidates.length) return null;
  const ranked = rankSubtitleCandidates(candidates, videoFileName);
  const reference = await selection.reference();

  let fallback = null;
  let best = null;
  const toCheck = reference ? ranked.slice(0, SYNC_MAX_CANDIDATES) : ranked.slice(0, 1);
  for (const candidate of toCheck) {
    let srt;
    try {
      srt = await selection.download(candidate);
    } catch (error) {
      console.warn(`[sync] ${language}: "${candidateLabel(candidate)}" ni bil prenesen: ${error.message}`);
      if (/proračun/.test(error.message)) break;
      continue;
    }
    if (!reference) {
      return { srt, language, fileName: candidate.fileName || `${imdbId}.${language}.srt`, candidate, matchedByHash: false, verified: false, sync: null };
    }
    const checked = await syncAgainstReference(selection, srt, candidate);
    const entry = { ...checked, language, fileName: candidate.fileName || `${imdbId}.${language}.srt`, candidate, matchedByHash: false };
    if (!fallback) fallback = entry;
    if (checked.verified && (!best || checked.sync.score > best.sync.score)) best = entry;
    // Zelo dobro ujemanje: ni treba trošiti prenosov za ostale kandidate.
    if (best && best.sync.score >= 0.8) break;
  }
  return best || fallback;
}

// Ročno izbran podnapis (po file_id): ne iščemo drugih, ga pa vseeno uskladimo z referenco.
async function loadChosenSubtitle(selection, language, fileId, fileName) {
  const candidate = { fileId: String(fileId), fileName: fileName || '', release: fileName || '', language };
  const srt = await downloadOpenSubtitleFile(fileId);
  const checked = await syncAgainstReference(selection, srt, candidate);
  return { ...checked, language, fileName: fileName || `opensubtitles-${fileId}.srt`, candidate, matchedByHash: false };
}

function syncNoticeSuffix(found) {
  if (!found) return '';
  if (found.matchedByHash) return ' Časovnica: ujema se z vašo datoteko.';
  if (found.verified && found.sync && !found.sync.inSync) return ' Časovnica: samodejno usklajena.';
  if (found.verified) return ' Časovnica: preverjena.';
  if (found.sync) return ' Časovnica: ni potrjena.';
  return '';
}

// Združljivost: prejšnji vmesnik (en jezik, vrne { srt, language, fileName, matchedByHash }).
async function fetchOpenSubtitleForLanguage(imdbId, language, videoHash, season, episode, videoFileName) {
  const selection = createSourceSelection({ imdbId, videoHash, videoFileName, season, episode });
  return selectSubtitleForLanguage(selection, language);
}

function prependNoticeCue(srtText, noticeMessage) {
  const noticeCue = `0\n00:00:01,000 --> 00:00:05,000\n${noticeMessage}\n\n`;
  const cleanBody = String(srtText || '').replace(/^0\r?\n00:00:0[^\n]*\r?\n[^\n]*\r?\n\r?\n?/, '');
  return `${noticeCue}${cleanBody.trimStart()}`;
}

async function fetchOpenSubtitle(imdbId, meta, requestedLanguage, videoHash, strict, season, episode, options = {}) {
  if (!process.env.OPENSUBTITLES_API_KEY) throw new Error('OPENSUBTITLES_API_KEY is not configured');
  const selection = createSourceSelection({ imdbId, videoHash, videoFileName: options.videoFileName, season, episode });
  const found = await selectSourceSubtitle(selection, imdbId, meta, requestedLanguage, strict, options);
  return { ...found, selection };
}

async function selectSourceSubtitle(selection, imdbId, meta, requestedLanguage, strict, options = {}) {

  // Ročna izbira: uporabnik je v Stremiu izbral točno določen izvorni podnapis.
  if (options.fileId) {
    const chosen = await loadChosenSubtitle(selection, requestedLanguage, options.fileId, options.fileName);
    console.log(`[Subtitles] Ročno izbran vir (${requestedLanguage}): ${chosen.fileName}`);
    return { ...chosen, isNativeSlovene: false, manual: true };
  }

  const reference = await selection.reference();
  let fallback = null;

  // Vedno najprej preverimo, ali že obstajajo originalni slovenski podnapisi na internetu
  try {
    const sloveneFound = await selectSubtitleForLanguage(selection, 'sl');
    if (sloveneFound) {
      if (sloveneFound.verified || !reference) return { ...sloveneFound, isNativeSlovene: true };
      console.log('[sync] slovenski podnapisi obstajajo, a se ne ujemajo z videom - najprej poskusim s potrjenim prevodom');
      fallback = { ...sloveneFound, isNativeSlovene: true };
    }
  } catch (error) {
    console.warn(`[opensubtitles] preverjanje obstoječih slovenskih podnapisov (${imdbId}) ni uspelo: ${error.message}`);
  }

  const languages = resolveSourceLanguages(meta, requestedLanguage, strict);
  for (const language of languages) {
    try {
      const found = await selectSubtitleForLanguage(selection, language);
      if (!found) continue;
      const result = { ...found, isNativeSlovene: false };
      // Brez reference ničesar ne moremo preveriti, zato velja jezikovna prioriteta.
      if (found.verified || !reference) return result;
      if (!fallback) fallback = result;
      console.log(`[sync] ${language}: noben kandidat ni časovno potrjen - preverim naslednji jezik`);
    } catch (error) {
      console.warn(`[opensubtitles] ${imdbId} (${language}) failed: ${error.message}`);
    }
  }
  if (fallback) {
    console.warn(`[sync] ${imdbId}: noben vir ni časovno potrjen, uporabljam najboljšega po imenu izdaje (${fallback.fileName})`);
    return fallback;
  }
  // Podnapisi obstajajo, a jih OpenSubtitles ni dovolil prenesti: povemo pravi vzrok.
  if (selection.downloadError) throw selection.downloadError;
  throw new Error(`No subtitle found in any of: ${languages.join(', ')}`);
}

// ---------- Hrvaški pomočnik za spol ----------
//
// Ko prevajamo iz angleščine (ali italijanščine), poiščemo še hrvaški podnapis istega
// filma. Hrvaščina spol zapiše v glagolu ("rekla sam", "gdje si bio?"), zato iz njega
// po času preberemo spol govorca in nagovorjenega za vsak cue. Strojno prevedenih
// hrvaških podnapisov ne uporabimo, ker je spol v njih pogosto ugibanje.

const GENDER_HELPER_ENABLED = String(process.env.GENDER_HELPER || 'true').toLowerCase() !== 'false';
const GENDER_HELPER_LANGUAGE = 'hr';
// Koliko hrvaških kandidatov največ prenesemo (prenosi štejejo v dnevno kvoto OpenSubtitles).
const GENDER_HELPER_MAX_DOWNLOADS = Math.max(1, Math.min(4, Number(process.env.GENDER_HELPER_MAX_DOWNLOADS || 2)));

// Poravna hrvaški podnapis na časovnico izvornega. Vrne { cues, sync } ali null, če se ne ujemata.
function alignGenderHelper(sourceSrt, helperSrt) {
  const result = subsync.computeSync(sourceSrt, helperSrt);
  if (!result.ok) return { cues: null, sync: result };
  const aligned = result.inSync ? helperSrt : subsync.applySync(helperSrt, result);
  return { cues: gender.buildHelperCues(parseSrt(aligned)), sync: result };
}

async function fetchGenderHelper(selection, sourceLanguage, sourceSrt, sourceCandidate) {
  if (!GENDER_HELPER_ENABLED || !selection || languageGroup(sourceLanguage) === GENDER_HELPER_LANGUAGE) return null;
  const { imdbId, season, episode, videoFileName } = selection;
  try {
    const hashMatches = (await selection.hashMatches())
      .filter(c => languageGroup(c.language) === GENDER_HELPER_LANGUAGE && !c.machineTranslated);
    let candidates = rankSubtitleCandidates(hashMatches, videoFileName);
    if (!candidates.length) {
      const found = await searchOpenSubtitles({ ...baseOpenSubtitlesParams(imdbId, season, episode), languages: OPENSUBTITLES_LANGUAGE_CODES[GENDER_HELPER_LANGUAGE] });
      candidates = rankSubtitleCandidates(found.filter(c => !c.machineTranslated), videoFileName);
    }
    if (sourceCandidate?.fileId) candidates = candidates.filter(c => c.fileId !== sourceCandidate.fileId);
    let downloads = 0;
    for (const candidate of candidates) {
      if (downloads >= GENDER_HELPER_MAX_DOWNLOADS) break;
      if (!isSubtitleFileCached(candidate.fileId)) downloads += 1;
      let helperSrt;
      try {
        helperSrt = await downloadOpenSubtitleFile(candidate.fileId);
      } catch (error) {
        console.warn(`[gender] hrvaški pomočnik "${candidateLabel(candidate)}" ni bil prenesen: ${error.message}`);
        continue;
      }
      const aligned = alignGenderHelper(sourceSrt, helperSrt);
      if (aligned.cues) {
        console.log(`[gender] hrvaški pomočnik: "${candidateLabel(candidate)}" (${subsync.describeSync(aligned.sync)})`);
        return { cues: aligned.cues, candidate };
      }
      console.log(`[gender] hrvaški pomočnik "${candidateLabel(candidate)}" se časovno ne ujema z virom: ${aligned.sync.reason || 'negotovo'}`);
    }
  } catch (error) {
    console.warn(`[gender] hrvaškega pomočnika ni bilo mogoče pridobiti: ${error.message}`);
  }
  return null;
}

// ---------- Kontrolni krog za spol ----------
//
// Po prevodu primerjamo spolne oblike v slovenščini ("sem bil", "si bila") s pričakovanim
// spolom: oznake (SDH, izvirnik, hrvaški pomočnik), analiza likov po imenu govorca, ki ga
// je zapisal model, in doslednost istega imena skozi film. Sporne cue-je popravi močnejši model.

const GENDER_REVIEW_ENABLED = String(process.env.GENDER_REVIEW || 'true').toLowerCase() !== 'false';
const GENDER_REVIEW_MAX_CUES = Math.max(0, Math.min(2000, Number(process.env.GENDER_REVIEW_MAX_CUES || 400)));

async function reviewTranslationGender(partial, sourceEntries, characterMap, context, options = {}) {
  if (!GENDER_REVIEW_ENABLED || GENDER_REVIEW_MAX_CUES <= 0) return { issues: 0, fixed: 0 };
  const items = sourceEntries.map(entry => {
    const stored = partial.entryMap.get(entry.id) || {};
    return { id: entry.id, sourceText: entry.text, text: stored.text || '', hint: entry.genderHint || null, meta: stored.meta || null };
  });
  const issues = gender.findGenderIssues(items, { lookup: name => lookupCharacterGender(characterMap, name) });
  if (!issues.length) return { issues: 0, fixed: 0 };
  const fixes = await gender.reviewGenderIssues(items, issues, {
    context,
    model: ANALYSIS_MODEL,
    maxCues: GENDER_REVIEW_MAX_CUES,
    translate: options.translate || translateWithGemini,
    log: message => console.warn(`[gender] kontrolni krog: ${message}`)
  });
  for (const [id, text] of fixes) {
    const stored = partial.entryMap.get(id);
    if (stored) partial.entryMap.set(id, { ...stored, text });
  }
  return { issues: issues.length, fixed: fixes.size };
}

// Seznam virov za ročno izbiro v Stremiu (samo iskanje, brez prenosov).
const manualChoiceCache = new Map();
async function listManualSourceChoices(imdbId, season, episode, videoFileName) {
  if (!process.env.OPENSUBTITLES_API_KEY || MANUAL_CHOICES_PER_LANGUAGE <= 0) return [];
  const key = `${imdbId}:${season || ''}:${episode || ''}`;
  const cached = manualChoiceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return pickManualChoices(cached.candidates, videoFileName);
  const languages = [...new Set(SUPPORTED_SOURCE_LANGUAGES.flatMap(l => (OPENSUBTITLES_LANGUAGE_CODES[l] || l).split(',')))].join(',');
  const candidates = await searchOpenSubtitles({ ...baseOpenSubtitlesParams(imdbId, season, episode), languages });
  manualChoiceCache.set(key, { candidates, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
  return pickManualChoices(candidates, videoFileName);
}

function pickManualChoices(candidates, videoFileName) {
  const choices = [];
  for (const language of SUPPORTED_SOURCE_LANGUAGES) {
    const ofLanguage = candidates.filter(c => languageGroup(c.language) === language);
    for (const candidate of rankSubtitleCandidates(ofLanguage, videoFileName).slice(0, MANUAL_CHOICES_PER_LANGUAGE)) {
      choices.push({ ...candidate, sourceLanguage: language });
    }
  }
  return choices;
}

// ---------- 3. VRHUNSKI PREVOD Z GEMINI ----------

function buildGeminiGenerationConfig(model, options = {}) {
  const generationConfig = {
    responseMimeType: 'application/json'
  };

  // Gemini 3.6+ je opustil temperature/top_p/top_k. Starejši modeli jih še podpirajo.
  if (!/^gemini-(?:3\.[6-9]|4(?:\.|$))/i.test(model)) {
    generationConfig.temperature = 0.2;
  }
  if (options.maxOutputTokens) {
    // Gemini 1.5 in 2.0 dovolita največ 8192 izhodnih žetonov.
    generationConfig.maxOutputTokens = /^gemini-(?:1\.5|2\.0)/i.test(model)
      ? Math.min(8192, options.maxOutputTokens)
      : options.maxOutputTokens;
  }

  // Gemini 3.x uporablja thinkingLevel, Gemini 2.5 pa thinkingBudget.
  if (/^gemini-(?:3|4)/i.test(model)) {
    generationConfig.thinkingConfig = { thinkingLevel: GEMINI_THINKING_LEVEL };
  } else if (/^gemini-2\.5/i.test(model)) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  return generationConfig;
}

function buildGeminiRequest(systemText, userText, model = GEMINI_MODEL, options = {}) {
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    body: {
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemText}\n\n---\n\n${userText}` }]
        }
      ],
      generationConfig: buildGeminiGenerationConfig(model, options),
      safetySettings: GEMINI_SAFETY_SETTINGS
    }
  };
}

function computeTranslationMaxOutputTokens(entryCount) {
  const count = Math.max(1, Number(entryCount) || 1);
  // 128 žetonov na cue: prevod + imeni ("s", "to") in spola ("g", "a") + rezerva za razmišljanje.
  return Math.max(4096, Math.min(GEMINI_DEFAULT_MAX_OUTPUT_TOKENS, count * 128));
}

function extractGeminiOutputText(data) {
  const textParts = data?.candidates?.[0]?.content?.parts || [];
  return textParts.map(p => p.text || '').join('');
}

async function translateWithGemini(systemText, userText, options = {}) {
  const apiKey = options.apiKey || GEMINI_API_KEY;
  const fetchImpl = options.fetchImpl || fetch;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const requestedModel = options.model || GEMINI_MODEL;
  const modelsToTry = geminiModelsToTry(requestedModel);
  let lastError = null;

  for (const currentModel of modelsToTry) {
    const request = buildGeminiRequest(systemText, userText, currentModel, options);
    const urlWithKey = `${request.url}?key=${apiKey}`;
    const response = await fetchImpl(urlWithKey, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request.body)
    });

    if (response.ok) {
      const data = await response.json();
      const text = extractGeminiOutputText(data).trim();
      if (text) return text;

      const finishReason = data?.candidates?.[0]?.finishReason || 'UNKNOWN';
      const blockReason = data?.promptFeedback?.blockReason || '';
      const thoughts = data?.usageMetadata?.thoughtsTokenCount || 0;
      lastError = new Error(
        `Gemini ${currentModel} returned empty output (finishReason=${finishReason}` +
        `${blockReason ? `, blockReason=${blockReason}` : ''}, thoughts=${thoughts})`
      );
      lastError.code = 'EMPTY_OUTPUT';
      console.warn(`[gemini] ${lastError.message}; trying next model...`);
      continue;
    }

    const detail = await response.text();
    lastError = new Error(`Gemini HTTP ${response.status}: ${detail.slice(0, 300)}`);
    lastError.status = response.status;
    if (response.status === 404 || response.status === 400) {
      if (response.status === 404 && fetchImpl === fetch) unavailableGeminiModels.add(currentModel);
      console.warn(`[gemini] model ${currentModel} returned ${response.status}, trying fallback model...`);
      continue;
    }
    throw lastError;
  }

  throw lastError || new Error('Gemini translation request failed');
}

// Združljivostne funkcije
const translateWithClaude = translateWithGemini;
const buildClaudeRequest = buildGeminiRequest;
const translateWithAnthropic = translateWithGemini;
const buildAnthropicRequest = buildGeminiRequest;
const extractClaudeOutputText = (data) => extractGeminiOutputText(data) || (data?.content?.[0]?.text || '');

// ---------- Pass 1: Analiza likov in spolov (Character Ledger) ----------

function characterAnalysisPrompt(tmdbContext) {
  return `You are preparing a character-gender reference sheet ("ledger") for a professional subtitle translation into Slovenian. Slovenian marks gender on past-tense verbs and adjectives for the speaker, the person addressed and anyone mentioned, so this sheet decides whether the translation says "rekla" or "rekel".

TASK:
1. Identify every named or clearly identifiable character who speaks, is addressed or is talked about — including minor ones and those known only by a role ("Mom", "the nurse", "Captain").
2. Determine each character's gender. Evidence, strongest first:
   a. The TMDB cast list below (the actor's gender is the character's gender; for animation trust the dialogue over the voice actor).
   b. Verb and adjective agreement in the source language (Croatian and Italian explicitly mark feminine past tense verbs like "rekla sam", "bila sam", "sono andata").
   c. Pronouns and kinship/address words used about or to the character (he/she, his/her, sir/ma'am, Mr/Mrs, brother/sister, son/daughter, husband/wife, gospodine/gospođo, signore/signora).
   d. The given name itself — only as weak evidence (confidence "low").
3. List every other name the same character goes by (first name, surname, nickname, title) in "aliases".
4. Mark gender as "male", "female", or "unknown". Never guess: with no real evidence use "unknown".
5. In "note" give the role/relationship and the clue in a few words (e.g. "Ana's husband; 'rekao sam'").
6. Return ONLY valid JSON: {"characters":[{"name":"Character Name","aliases":["Other Name"],"gender":"male|female|unknown","confidence":"high|medium|low","note":"clue"}]}

TMDB CAST METADATA:
${tmdbContext}`;
}

function parseCharacterLedger(raw) {
  try {
    let cleaned = String(raw || '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
    const data = JSON.parse(cleaned);
    if (!Array.isArray(data?.characters)) return [];
    return data.characters
      .filter(c => c && typeof c.name === 'string' && c.name.trim())
      .map(c => ({
        name: c.name.trim(),
        aliases: Array.isArray(c.aliases) ? c.aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim()) : [],
        gender: ['male', 'female', 'unknown'].includes(String(c.gender).toLowerCase()) ? String(c.gender).toLowerCase() : 'unknown',
        confidence: c.confidence || 'low',
        note: c.note || ''
      }));
  } catch (_) {
    return [];
  }
}

function ledgerToText(characters) {
  if (!characters.length) return 'No characters could be reliably identified from the dialogue; rely on TMDB cast metadata above.';
  return characters
    .map(c => `${c.name}${c.aliases?.length ? ` (also: ${c.aliases.join(', ')})` : ''}: ${c.gender}${c.note ? ` (${c.note})` : ''} [confidence: ${c.confidence}]`)
    .join('\n');
}

const CHARACTER_LEDGER_SCHEMA = {
  type: 'object',
  properties: {
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          gender: { type: 'string', enum: ['male', 'female', 'unknown'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          note: { type: 'string' }
        },
        required: ['name', 'gender', 'confidence']
      }
    }
  },
  required: ['characters']
};

async function analyzeCharacters(sourceSrt, meta) {
  const entries = parseSrt(sourceSrt);
  // SDH oznake govorcev ("ANA:") namenoma ostanejo — so najboljši namig za spol.
  const dialogue = entries.map(e => e.text.replace(/\n/g, ' / ')).join('\n');
  const tmdbContext = buildMetadataContext(meta);
  const systemText = characterAnalysisPrompt(tmdbContext);
  const userText = `Dialogue to analyze:\n${dialogue}\n\nReturn JSON only.`;
  try {
    const raw = await translateWithGemini(systemText, userText, { model: ANALYSIS_MODEL });
    return parseCharacterLedger(raw);
  } catch (error) {
    console.warn(`[character-analysis] failed, falling back to TMDB only: ${error.message}`);
    return [];
  }
}

// ---------- Pass 2: Vrhunski prevod v slovenščino ----------

function systemPrompt(context) {
  return `You are an elite, professional film subtitle translator specializing in Croatian/Italian/English to natural, idiomatic Slovenian translation.

CONTEXT:
${context}

CORE TRANSLATION & SUBTITLING RULES:

1. SPOLNO UJEMANJE (ONA / ON) — ZVOČNA/TEKSTOVNA ANALIZA GOVORCA (KRITIČNO):
- Vsak cue ima lahko dodeljeno dinamično oznako govorca, npr. [Govorec: Ženska] ali [Govorec: Moški].
- BREZPOGOJNO upoštevaj te dodeljene oznake spola za vsako posamezno vrstico pri izbiri glagolskih oblik, pridevnikov in zaimkov!
- ŽENSKA ([Govorec: Ženska]): obvezno uporabi ženske oblike glagolov v pretekliku ("rekla sem", "prišla sem", "bila sem", "videla sem", "si videla?", "si pripravljena?"), ženske pridevnike ("sama", "vesela", "utrujena", "hvaležna") in ustrezne ženske zaimke.
- MOŠKI ([Govorec: Moški]): obvezno uporabi moške oblike ("rekel sem", "prišel sem", "bil sem", "videl sem", "si videl?", "si pripravljen?", "sam", "vesel").
- Oznaka [Govorec 1: ...; Govorec 2: ...] pomeni cue z dvema govorcema: prva vrstica pripada prvemu, druga drugemu.
- Oznaka [Nagovorjeni: Ženska] / [Nagovorjeni: Moški] pove spol osebe, ki ji govorec govori ("Kje si bila?" / "Kje si bil?"). Upoštevaj jo enako strogo kot oznako govorca.
- Oznake pogosto izhajajo iz hrvaškega podnapisa istega prizora, ki spol zapiše v glagolu ("rekla sam"), zato so zanesljivejše od ugibanja iz angleščine.
- V hrvaščini in italijanščini dodatno izkoristi očitne spolne končnice izvirnika ("rekla sam" -> "rekla sem", "sono andata" -> "šla sem").
- Pravilno uporabljaj slovensko dvojino (npr. "greva", "bova videla/videli").
- POMEMBNO: Tehničnih oznak [Govorec: ...] NIKOLI ne vključuj v končno besedilo prevoda!

1a. TRIJE SPOLI V VSAKEM STAVKU — GOVOREC, NAGOVORJENI, OMENJENI:
Slovenščina označi spol pri treh različnih osebah. Za vsak cue preveri vse tri:
- GOVOREC (1. oseba): "utrujena sem" / "utrujen sem". Vir: oznaka [Govorec: ...], sicer kdo v prizoru govori.
- NAGOVORJENI (2. oseba): "Kje si bila?" (ženski) / "Kje si bil?" (moškemu); "Si nora?" / "Si nor?". Spol nagovorjenega NI spol govorca! Ugotovi ga iz imena v nagovoru ("Ana, ..."), iz tega, kdo je govoril tik pred tem in komu odgovarja, ter iz CHARACTER LEDGER.
- OMENJENI (3. oseba): "Marko je odšel" / "Ana je odšla"; "he/she", "his/her" -> "on/ona", "njegov/njen". Spol poišči po imenu v CHARACTER LEDGER in TMDB Cast Genders.
- Angleščina spola ne kaže ("I was tired", "Were you there?", "They left"), zato ga pri angleškem viru VEDNO določi iz konteksta, nikoli po privzeti moški obliki.
- Sledi poteku pogovora: v dialogu se govorca izmenjujeta; pomišljaj "-" na začetku vrstice pomeni menjavo govorca. Kdor je vprašan, praviloma odgovarja v naslednjem cue-ju.
- Bodi dosleden: ista oseba ima isti spol skozi ves film. Ko enkrat ugotoviš spol lika, ga ne spreminjaj.

1b. ŠTEVILO IN SPOL SKUPINE:
- Dve osebi -> dvojina: moški + moški ali mešan par "sva šla", "sta bila"; dve ženski "sva šli", "sta bili".
- Tri ali več oseb -> množina: mešana ali moška skupina "smo šli", samo ženske "smo šle".
- Angleški "you" je lahko ednina, dvojina ("vidva/vidve") ali množina ("vi") — odloči se po tem, koliko oseb je nagovorjenih.
- Pri vikanju je deležnik v moški množini ne glede na spol: "Gospa, kje ste bili?".

2. ŽANRSKO PRILAGOJEN SLENG, KLETVICE IN NARAVNI FILMSKI IDIOM:
- Akcija / Kriminalka / Triler: Uporabljaj surov, naraven filmski pogovorni jezik, ulični sleng in pristne slovenske kletvice ("fak", "daj no", "stari", "mater", "k vragu", "kaj dogaja", "gremo"). Brez zastarelih ali prisiljenih knjižnih izrazov.
- Komedija: Živahni, duhoviti in naravni slovenski idiomi ter situacijske šale (ne prevajaj tujih šal dobesedno, ampak jih prilagodi slovenskemu duhu).
- Znanstvena fantastika (Sci-Fi): Uveljavljena slovenska terminologija (nadsvetlobni pogon, ščiti, senzorji, teleportacija, hiper-skok).
- Zgodovinski film / Drama: Rahlo uglajenejši jezik z doslednim vikanjem med uradnimi osebami in gospodo.
- Animacija / Risanka: Prijazen, igriv in naraven slovenski jezik, prilagojen celotni družini.

3. OMEJITEV VRSTIC IN HITROST BRANJA (MAX 2 VRSTICI):
- Vsak posamezen podnapis (cue) mora biti razdeljen na NAJVEČ DVE KRATKI VRSTICI (max ${MAX_LINE_CHARS} znakov na vrstico).
- Za udobno branje na zaslonu se drži hitrosti ${TARGET_CPS} znakov na sekundo glede na čas trajanja.
- Strni predolgo besedilo: izpusti odvečna mašila in ponavljanja ter ohrani bistvo in ton dialoga.

4. VARNOSTNO PRAVILO ZA SPOL (FALLBACK NA NEVTRALNOST):
- Najprej izčrpaj vse vire po vrsti: (1) oznaka [Govorec: ...], (2) spolne končnice izvirnika, (3) ime lika v CHARACTER LEDGER / TMDB Cast Genders, (4) potek pogovora in prejšnji cue-ji. Šele če nobeden ne da odgovora, uporabi nevtralno obliko.
- Če pri določenem stavku ali dialogu nisi 100-odstotno prepričan o spolu govorca, nagovorjenega ali omenjenega (ker kontekst ni jasen ali ni zvočne/tekstovne oznake), se STROGO IZOGNI izpostavljanju spola.
- V takih primerih kreativno obrni stavek, spremeni strukturo ali uporabi nevtralen izraz, ki spola neizogibno ne izdaja (npr. sedanji čas, brezoosebna oblika, preoblikovan stavek, "treba je", "ravnokar prihajam", "kaj se je zgodilo?"), da preprečiš slovnično napačno spolno ujemanje.

5. NARAVEN POGOVORNI JEZIK:
- Uporabljaj naravno, tekočo pogovorno slovenščino. Brez dobesednih ali robotskih prevodov.
- Ohrani dosledno tikanje ali vikanje glede na odnose med liki.

6. POPOLNA TEHNIČNA INTEGRITETA SRT:
- Ohraniti moraš točne ID številke vseh podnapisov.
- Cue-ji pod "PREJŠNJI CUE-JI" so samo kontekst — NE prevajaj jih in jih NE vračaj.
- Za vsak cue NAJPREJ zapiši, kdo govori in komu, ŠELE NATO napiši prevod, ki se s tem ujema:
  "s" = ime govorca, kot je zapisano v CHARACTER LEDGER ali TMDB (pri dveh govorcih "Ana / Marko"); "?" če ga ne poznaš.
  "to" = ime nagovorjene osebe (ali "?" če ni jasno ali nihče ni nagovorjen; "vsi" za skupino).
  "g" = spol govorca: "F" (ženska), "M" (moški), "FM" (dva govorca v cue-ju), "?" (neznan -> nevtralna oblika).
  "a" = spol nagovorjenega: "F", "M", "P" (več oseb ali vikanje), "?" (neznan ali nihče ni nagovorjen).
- Ista oseba ima v "s" in "to" vedno isto ime skozi ves film (ne izmenjuj imena in vzdevka).
- Izhod vrni IZKLJUČNO kot JSON v obliki: {"translations":[{"id":"1","s":"Ana","to":"Marko","g":"F","a":"M","text":"Prva vrstica\\nDruga vrstica"}]}`;
}

function buildTranslationUserText(sourceEntries, previousEntries = []) {
  const lines = sourceEntries.map(entry => {
    const duration = cueDurationSeconds(entry).toFixed(1);
    const budget = maxCharsForDuration(cueDurationSeconds(entry));
    const tag = entry.genderTag ? `${entry.genderTag} ` : '';
    return `[id=${entry.id} duration=${duration}s max_chars=${budget}] ${tag}${entry.text.replace(/\n/g, ' / ')}`;
  });
  // Kontekstni cue-ji namenoma nimajo oblike "[id=...]", da jih model ne vrača.
  const previous = (previousEntries || []).map(entry => {
    const tag = entry.genderTag ? `${entry.genderTag} ` : '';
    return `(prej) ${tag}${entry.text.replace(/\n/g, ' / ')}`;
  });
  const previousBlock = previous.length
    ? `PREJŠNJI CUE-JI (samo kontekst za to, kdo govori in komu — NE prevajaj, NE vračaj):\n${previous.join('\n')}\n\n`
    : '';
  return `Prevedi vsak cue v naravno slovenščino (max 2 vrstici na cue, strogo upoštevaj označeni spol govorca [Govorec: ...]).
Pri vsakem cue-ju najprej določi govorca ("s") in nagovorjenega ("to") ter njun spol ("g", "a"), nato napiši prevod, ki se z njimi ujema.
V izhodu NE vključuj tehničnih oznak [Govorec: ...] ali [Nagovorjeni: ...], ampak samo čist slovenski dialog.
Return JSON: {"translations": [{"id": "...", "s": "ime|?", "to": "ime|?", "g": "F|M|FM|?", "a": "F|M|P|?", "text": "..."}]}

${previousBlock}SOURCE CUES:
${lines.join('\n')}`;
}

function buildTranslationSchema(expectedCount) {
  return {
    type: 'object',
    properties: {
      translations: {
        type: 'array',
        minItems: expectedCount,
        maxItems: expectedCount,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            text: { type: 'string' }
          },
          required: ['id', 'text']
        }
      }
    },
    required: ['translations']
  };
}
const TRANSLATION_SCHEMA = buildTranslationSchema(undefined);

const TRANSLATION_META_FIELDS = ['s', 'to', 'g', 'a'];

function pickTranslationMeta(item) {
  const meta = {};
  for (const field of TRANSLATION_META_FIELDS) {
    if (typeof item?.[field] === 'string' && item[field].trim()) meta[field] = item[field].trim().slice(0, 60);
  }
  return Object.keys(meta).length ? meta : null;
}

function extractTranslationPairsLoosely(text) {
  const map = new Map();
  map.meta = new Map();
  // Med "id" in "text" so lahko kratka polja govorca in spola ("s", "to", "g", "a").
  const regex = /"id"\s*:\s*"?([^"\n,}]+)"?\s*,((?:\s*"[a-z]{1,3}"\s*:\s*"[^"\n]{0,60}"\s*,)*)\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = regex.exec(String(text || ''))) !== null) {
    const id = match[1].trim();
    let decoded;
    try {
      decoded = JSON.parse(`"${match[3]}"`);
    } catch (_) {
      decoded = match[3].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
    decoded = decoded.trim();
    if (id && decoded) {
      map.set(id, decoded);
      const fields = {};
      for (const f of match[2].matchAll(/"([a-z]{1,3})"\s*:\s*"([^"\n]{0,60})"/g)) fields[f[1]] = f[2];
      const meta = pickTranslationMeta(fields);
      if (meta) map.meta.set(id, meta);
    }
  }
  return map;
}

function parseTranslationJson(value) {
  try {
    let raw = String(value || '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : Array.isArray(data?.translations) ? data.translations : null;
    if (list) {
      // Mapa id -> besedilo; `map.meta` hrani id -> { s, to, g, a } (kdo govori in komu).
      const map = new Map();
      map.meta = new Map();
      for (const item of list) {
        if (item?.id != null && typeof item.text === 'string' && item.text.trim()) {
          map.set(String(item.id), item.text.trim());
          const meta = pickTranslationMeta(item);
          if (meta) map.meta.set(String(item.id), meta);
        }
      }
      if (map.size) return map;
    }
  } catch (_) {
    // fallback
  }
  const loose = extractTranslationPairsLoosely(value);
  return loose.size ? loose : null;
}

async function translateEntriesWithGemini(sourceEntries, systemText, label, previousEntries = []) {
  const userText = buildTranslationUserText(sourceEntries, previousEntries);
  const maxOutputTokens = computeTranslationMaxOutputTokens(sourceEntries.length);
  const response = await translateWithGemini(systemText, userText, { maxOutputTokens });
  const translated = parseTranslationJson(response) || new Map();
  const metaById = translated.meta instanceof Map ? translated.meta : new Map();

  let missing = sourceEntries.filter(entry => !translated.has(String(entry.id)));
  if (missing.length) {
    console.warn(`[translation] ${label} incomplete (${sourceEntries.length - missing.length}/${sourceEntries.length}); repairing ${missing.length} missing cue(s)`);
    try {
      const repairUser = `${buildTranslationUserText(missing)}\n\nREPAIR: your previous reply was missing or malformed entries. Return every source id exactly once in JSON {"translations":[{"id":"...","text":"..."}]}.`;
      const repaired = await translateWithGemini(systemText, repairUser, {
        maxOutputTokens: computeTranslationMaxOutputTokens(missing.length)
      });
      const repairedMap = parseTranslationJson(repaired);
      if (repairedMap) {
        for (const entry of missing) {
          const text = repairedMap.get(String(entry.id));
          if (typeof text === 'string' && text.trim()) translated.set(String(entry.id), text.trim());
          const meta = repairedMap.meta?.get(String(entry.id));
          if (meta) metaById.set(String(entry.id), meta);
        }
      }
    } catch (error) {
      console.warn(`[translation] ${label} repair failed: ${error.message}`);
      if (error.code !== 'EMPTY_OUTPUT' && error.code !== 'INCOMPLETE') throw error;
    }
    missing = sourceEntries.filter(entry => !translated.has(String(entry.id)));
  }

  if (missing.length) {
    const error = new Error(`${label} still incomplete after repair (${sourceEntries.length - missing.length}/${sourceEntries.length})`);
    error.code = 'INCOMPLETE';
    translated.meta = metaById;
    error.partialTranslations = translated;
    error.missingEntries = missing;
    throw error;
  }

  return sourceEntries.map(entry => {
    const result = { id: entry.id, timecode: entry.timecode, text: translated.get(String(entry.id)) };
    const meta = metaById.get(String(entry.id));
    if (meta) result.meta = meta;
    return result;
  });
}

async function translateChunkEntries(entries, systemText, label, depth = 0, previousEntries = []) {
  try {
    return await translateEntriesWithGemini(entries, systemText, label, previousEntries);
  } catch (error) {
    if (error.code !== 'INCOMPLETE' && error.code !== 'EMPTY_OUTPUT') throw error;

    const partial = error.partialTranslations instanceof Map ? error.partialTranslations : new Map();
    const missing = Array.isArray(error.missingEntries)
      ? error.missingEntries
      : entries.filter(entry => !partial.has(String(entry.id)));

    // Če je večina cue-jev prevedenih in manjka le nekaj, poskusi samo manjkajoče.
    if (missing.length > 0 && missing.length < entries.length) {
      console.warn(`[translation] ${label}: retrying only ${missing.length} missing cue(s)`);
      try {
        const missingTranslated = await translateChunkEntries(missing, systemText, `${label} [missing]`, depth + 1);
        const partialMeta = partial.meta instanceof Map ? partial.meta : new Map();
        for (const entry of missingTranslated) {
          partial.set(String(entry.id), entry.text);
          if (entry.meta) partialMeta.set(String(entry.id), entry.meta);
        }
        return entries.map(entry => {
          const result = { id: entry.id, timecode: entry.timecode, text: partial.get(String(entry.id)) || entry.text };
          const meta = partialMeta.get(String(entry.id));
          if (meta) result.meta = meta;
          return result;
        });
      } catch (innerError) {
        if (innerError.code !== 'INCOMPLETE' && innerError.code !== 'EMPTY_OUTPUT') throw innerError;
      }
    }

    // Zadnja varovalka: namesto da odpove celoten film, ohrani izvorno besedilo
    // za ta majhen del in nadaljuj. Napaka je jasno zabeležena v logu.
    if (entries.length <= MIN_SPLIT_CHUNK_SIZE || depth >= MAX_SPLIT_DEPTH) {
      console.warn(`[translation] ${label}: ${missing.length}/${entries.length} cue(s) kept in source language after repeated AI failures`);
      return entries.map(entry => ({
        id: entry.id,
        timecode: entry.timecode,
        text: partial.get(String(entry.id)) || entry.text
      }));
    }

    const mid = Math.ceil(entries.length / 2);
    console.warn(`[translation] ${label}: splitting ${entries.length} cues into ${mid}+${entries.length - mid} after: ${error.message}`);
    const left = await translateChunkEntries(entries.slice(0, mid), systemText, `${label} [1/2]`, depth + 1, previousEntries);
    const right = await translateChunkEntries(entries.slice(mid), systemText, `${label} [2/2]`, depth + 1, entries.slice(Math.max(0, mid - CONTEXT_CUES), mid));
    return [...left, ...right];
  }
}

async function translateChunk(chunk, context) {
  const sourceEntries = chunk.entries || parseSrt(chunk.srt);
  const systemText = systemPrompt(context);
  const label = `chunk ${chunk.index + 1}`;

  // Vsak chunk se ob napaki samodejno razdeli na manjše dele, zato en slab
  // odgovor modela ne pomeni več, da celoten film ostane nepreveden.
  let resultEntries = await translateChunkEntries(sourceEntries, systemText, label, 0, chunk.previousEntries || []);

  const tooFast = findTooFastCues(resultEntries);
  if (tooFast.length) {
    console.warn(`[translation] ${label}: ${tooFast.length} cue(s) over reading-speed budget, shortening`);
    const shortenNote = 'SHORTENING PASS: the cues below are too long for their on-screen duration. Rewrite ONLY these cues to fit within max_chars and max 2 lines while preserving meaning and correct gender. Return JSON {"translations":[{"id":"...","text":"..."}]}.';
    const shortenUserText = tooFast.map(c => `[id=${c.id} max_chars=${c.budget}] ${c.text.replace(/\n/g, ' / ')}`).join('\n');
    try {
      const shortenedRaw = await translateWithGemini(systemText, `${shortenNote}\n\n${shortenUserText}`, {
        maxOutputTokens: computeTranslationMaxOutputTokens(tooFast.length)
      });
      const shortenedMap = parseTranslationJson(shortenedRaw);
      if (shortenedMap) {
        resultEntries = resultEntries.map(entry => shortenedMap.has(String(entry.id)) ? { ...entry, text: shortenedMap.get(String(entry.id)) } : entry);
      }
    } catch (error) {
      console.warn(`[translation] shortening pass failed, keeping original lengths: ${error.message}`);
    }
  }

  return resultEntries;
}

// ---------- Orchestration & Shranjevanje v .sl.srt ----------

function parseSeriesId(rawId) {
  const str = String(rawId || '');
  const match = str.match(/^(tt\d+):(\d+):(\d+)$/);
  if (match) return { imdbId: match[1], season: match[2], episode: match[3] };
  return { imdbId: str, season: null, episode: null };
}

function buildCacheKey(imdbId, sourceLanguage, videoHash, season, episode) {
  const episodePart = season && episode ? `:s${season}e${episode}` : '';
  const idPart = videoHash ? `${imdbId}${episodePart}:${videoHash}` : `${imdbId}${episodePart}`;
  return `${idPart}:${sourceLanguage || 'auto'}:slv:gemini:${GEMINI_MODEL}`;
}

function parseExtraHash(extra) {
  const str = String(extra || '');
  const hashMatch = str.match(/(?:^|&)videoHash=([a-f0-9]+)/i);
  const sizeMatch = str.match(/(?:^|&)videoSize=(\d+)/i);
  return {
    videoHash: hashMatch ? hashMatch[1].toLowerCase() : null,
    videoSize: sizeMatch ? sizeMatch[1] : null
  };
}

// Ime video datoteke, ki ga Stremio pošlje v "extra" (filename=...).
function parseExtraFileName(extra) {
  const match = String(extra || '').match(/(?:^|&)filename=([^&]+)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' '));
  } catch (_) {
    return match[1];
  }
}

// Ročno izbran vir dobi svoj ključ, da ne prepiše (ali ne prebere) samodejnega prevoda.
function sourceCacheLanguage(sourceLanguage, options = {}) {
  return options.fileId ? `${sourceLanguage}-file${String(options.fileId).replace(/[^0-9a-z]/gi, '')}` : sourceLanguage;
}

async function translateSubtitle(imdbId, sourceLanguage, videoHash, strict, season, episode, options = {}) {
  const key = buildCacheKey(imdbId, sourceCacheLanguage(sourceLanguage, options), videoHash, season, episode);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    const notice = 'Naloženi že prej prevedeni slovenski podnapisi.';
    console.log(`[Subtitles] ${notice} (${imdbId})`);
    return prependNoticeCue(cached.srt, notice);
  }
  // Prej shranjena .sl.srt datoteka (ne pri ročni izbiri, ki zahteva nov prevod).
  const localDiskSrt = options.fileId ? null : loadSlovenianSrtFile(imdbId, season, episode);
  if (localDiskSrt) {
    const notice = 'Naloženi že prej prevedeni slovenski podnapisi.';
    console.log(`[Subtitles] ${notice} (${imdbId})`);
    if (!videoHash || !SUBTITLE_SYNC_ENABLED || !process.env.OPENSUBTITLES_API_KEY) return prependNoticeCue(localDiskSrt, notice);
    // Shranjen prevod je lahko narejen za drugo izdajo videa: uskladimo ga s časovnico te datoteke.
    const selection = createSourceSelection({ imdbId, videoHash, videoFileName: options.videoFileName, season, episode });
    const aligned = await syncAgainstReference(selection, localDiskSrt, null).catch(() => ({ srt: localDiskSrt }));
    const entry = { srt: prependNoticeCue(aligned.srt, notice), expiresAt: Date.now() + CACHE_TTL_MS };
    cache.set(key, entry);
    saveCacheEntryToDisk(key, entry);
    return entry.srt;
  }
  if (inflight.has(key)) return inflight.get(key);
  // Nedavna napaka (npr. OpenSubtitles 401/429): predvajalnik zahteva datoteko vsako sekundo,
  // zato napako za kratek čas vrnemo takoj, namesto da vsakič znova kličemo OpenSubtitles.
  const recentFailure = recentFailures.get(key);
  if (recentFailure && recentFailure.until > Date.now()) throw recentFailure.error;

  const job = (async () => {
    const meta = await tmdbMetadata(`tt${String(imdbId).replace(/^tt/, '')}`, season, episode);
    const found = await fetchOpenSubtitle(imdbId, meta, sourceLanguage, videoHash, strict, season, episode, options);
    const { srt: rawSource, language: usedLanguage, fileName: sourceFileName, matchedByHash, isNativeSlovene } = found;

    // Če že obstajajo originalni slovenski podnapisi, jih le očistimo (SDH) in postrežemo brez AI prevajanja
    if (isNativeSlovene) {
      const sloveneNotice = 'Najdeni slovenski podnapisi-prevod ni potreben.';
      console.log(`[Subtitles] ${sloveneNotice} (${sourceFileName || `${imdbId}.sl.srt`})`);
      const cleanedSlovene = prependNoticeCue(removeSdh(rawSource), sloveneNotice);
      const entry = { srt: cleanedSlovene, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 };
      cache.set(key, entry);
      saveCacheEntryToDisk(key, entry);
      saveSlovenianSrtFile(imdbId, season, episode, cleanedSlovene);
      return cleanedSlovene;
    }

    // 1. Izpis izbranega jezika in datoteke
    const sourceNotice = `${getTranslationNotice(usedLanguage)}${found.manual ? ' Ročno izbran vir.' : ''}${syncNoticeSuffix(found)}`;
    console.log(`[Subtitles] ${sourceNotice} (${sourceFileName || `${imdbId}.${usedLanguage}.srt`})`);

    if (!matchedByHash && !found.manual) {
      const genericKey = buildCacheKey(imdbId, usedLanguage, null, season, episode);
      const genericCached = cache.get(genericKey);
      if (genericCached && genericCached.expiresAt > Date.now()) {
        const notice = 'Naloženi že prej prevedeni slovenski podnapisi.';
        console.log(`[Subtitles] ${notice} (${imdbId}): reusing existing translation`);
        // Obstoječi prevod je bil morda narejen za drugo izdajo: časovnico uskladimo z izbranim virom.
        let reusedSrt = genericCached.srt;
        const aligned = subsync.computeSync(rawSource, reusedSrt);
        if (aligned.ok && !aligned.inSync) {
          console.log(`[sync] ponovno uporabljen prevod: ${subsync.describeSync(aligned)}`);
          reusedSrt = subsync.applySync(reusedSrt, aligned);
        }
        const reusedEntry = { srt: reusedSrt, expiresAt: genericCached.expiresAt };
        cache.set(key, reusedEntry);
        saveCacheEntryToDisk(key, reusedEntry);
        saveSlovenianSrtFile(imdbId, season, episode, reusedSrt);
        return prependNoticeCue(reusedSrt, notice);
      }
    }

    // 2. Analiza likov in spolov (Gemini + TMDB) -> zemljevid ime lika -> spol
    const characters = await analyzeCharacters(rawSource, meta);
    const characterMap = buildCharacterGenderMap(meta, characters);

    // 3. Čiščenje SDH z dinamičnim dodeljevanjem spola govorca
    const sourceEntries = removeSdhEntries(rawSource, characterMap);
    const source = toSrt(sourceEntries);

    // 3a. Hrvaški pomočnik: spol govorca in nagovorjenega iz hrvaškega podnapisa istega prizora.
    const helper = await fetchGenderHelper(found.selection, usedLanguage, rawSource, found.candidate);
    const helperTagged = helper ? gender.applyHelperHints(sourceEntries, helper.cues) : 0;
    const taggedCount = sourceEntries.filter(e => e.genderTag).length;
    console.log(`[translation] ${imdbId}: cues after SDH cleanup=${sourceEntries.length}/${parseSrt(rawSource).length} (gender-tagged: ${taggedCount}/${sourceEntries.length}${helper ? `, ${helperTagged} from HR helper` : ''})`);

    const context = `${buildMetadataContext(meta)}\n\nCHARACTER LEDGER (from dialogue analysis):\n${ledgerToText(characters)}`;
    const chunks = chunkSrt(sourceEntries, CHUNK_SIZE);
    // Vsak chunk dobi zadnjih nekaj cue-jev prejšnjega kot kontekst, da model ve,
    // kdo govori in komu, tudi na meji med chunki.
    chunks.forEach((chunk, i) => {
      chunk.previousEntries = i > 0 ? chunks[i - 1].entries.slice(-CONTEXT_CUES) : [];
    });
    console.log(`[translation] ${imdbId}: translating ${sourceEntries.length} cues in ${chunks.length} chunk(s) of up to ${CHUNK_SIZE}, model=${GEMINI_MODEL}`);

    const sourceIds = sourceEntries.map(e => e.id);
    const savedPartial = loadPartialFromDisk(key);
    const resumable = savedPartial
      && savedPartial.totalChunks === chunks.length
      && savedPartial.order.length === sourceIds.length
      && savedPartial.order.every((id, i) => id === sourceIds[i]);

    const partial = resumable ? savedPartial : createPartialTracker(sourceEntries, chunks.length);
    partial.sourceNotice = sourceNotice;
    partials.set(key, partial);

    await runWithConcurrency(chunks, TRANSLATION_CONCURRENCY, async chunk => {
      if (partial.doneChunkIndices.has(chunk.index)) return;
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const resultEntries = await translateChunk(chunk, context);
          mergeChunkIntoPartial(partial, resultEntries, chunk.index);
          savePartialToDisk(key, partial);
          console.log(`[translation] ${imdbId}: chunk ${chunk.index + 1}/${chunks.length} done (${partial.doneChunkIndices.size}/${chunks.length} total)`);
          return;
        } catch (error) {
          console.warn(`[translation] ${imdbId}: chunk ${chunk.index + 1} attempt ${attempt}/${maxAttempts} failed: ${error.message}`);
          if (attempt === maxAttempts) {
            markChunkFailed(partial, chunk.index);
            savePartialToDisk(key, partial);
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    });

    if (partial.failedChunkIndices.size > 0) {
      partials.set(key, partial);
      throw new Error(`${partial.failedChunkIndices.size}/${chunks.length} chunk(s) could not be translated this run (will retry next visit)`);
    }

    // 5. Kontrolni krog: sporne spolne oblike popravi močnejši model.
    try {
      const review = await reviewTranslationGender(partial, sourceEntries, characterMap, context);
      if (review.issues) console.log(`[gender] ${imdbId}: kontrolni krog - spornih ${review.issues}, popravljenih ${review.fixed}`);
    } catch (error) {
      console.warn(`[gender] ${imdbId}: kontrolni krog ni uspel, prevod ostane nespremenjen: ${error.message}`);
    }

    const srt = partialToSrt(partial);
    const validated = reconcileTranslatedSrt(source, srt);
    parseAndValidateSrt(source, validated);
    const finalSrtWithNotice = prependNoticeCue(validated, sourceNotice);

    // 4. Shranjevanje v predpomnilnik in novo .sl.srt datoteko
    cache.set(key, { srt: finalSrtWithNotice, expiresAt: Date.now() + CACHE_TTL_MS });
    saveCacheEntryToDisk(key, { srt: finalSrtWithNotice, expiresAt: Date.now() + CACHE_TTL_MS });
    saveSlovenianSrtFile(imdbId, season, episode, finalSrtWithNotice);

    if (!matchedByHash && !found.manual) {
      const genericKey = buildCacheKey(imdbId, usedLanguage, null, season, episode);
      cache.set(genericKey, { srt: finalSrtWithNotice, expiresAt: Date.now() + CACHE_TTL_MS });
      saveCacheEntryToDisk(genericKey, { srt: finalSrtWithNotice, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    deletePartialFromDisk(key);
    partials.delete(key);
    console.log(`[translation] ${imdbId}: successfully translated and saved ${parseSrt(finalSrtWithNotice).length} cues to .sl.srt`);
    return finalSrtWithNotice;
  })();

  inflight.set(key, job);
  try {
    const result = await job;
    recentFailures.delete(key);
    return result;
  } catch (error) {
    recentFailures.set(key, { error, until: Date.now() + FAILURE_RETRY_MS });
    throw error;
  } finally {
    inflight.delete(key);
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be at least 1');
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

// ---------- Progressive state ----------

function createPartialTracker(sourceEntries, totalChunks) {
  return {
    entryMap: new Map(sourceEntries.map(e => [e.id, { timecode: e.timecode, text: e.text }])),
    order: sourceEntries.map(e => e.id),
    totalChunks,
    doneChunkIndices: new Set(),
    failedChunkIndices: new Set()
  };
}

function mergeChunkIntoPartial(partial, entries, chunkIndex) {
  for (const entry of entries) {
    const stored = { timecode: entry.timecode, text: entry.text, translated: true };
    if (entry.meta) stored.meta = entry.meta;
    partial.entryMap.set(entry.id, stored);
  }
  if (typeof chunkIndex === 'number') {
    partial.doneChunkIndices.add(chunkIndex);
    partial.failedChunkIndices.delete(chunkIndex);
  }
  return partial;
}

function markChunkFailed(partial, chunkIndex) {
  partial.failedChunkIndices.add(chunkIndex);
  return partial;
}

function partialToSrt(partial) {
  const entries = partial.order.map(id => {
    const entry = partial.entryMap.get(id);
    return { id, timecode: entry.timecode, text: entry.text };
  });
  return toSrt(entries);
}

// Delni prevod za predvajalnik: obvestilo, koliko je prevedeno, in oznaka na začetku vsakega
// še neprevedenega dela (tam je zaenkrat besedilo vira), da uporabnik ve, da mora podnapise
// po koncu prevoda izbrati znova. Predvajalnik datoteke sam od sebe ne naloži ponovno.
const IN_PROGRESS_MARK = '[Prevod še poteka - znova izberite podnapise]';

function partialProgressSrt(partial) {
  let inGap = false;
  const entries = partial.order.map(id => {
    const entry = partial.entryMap.get(id);
    let text = entry.text;
    if (entry.translated) {
      inGap = false;
    } else {
      if (!inGap) text = `${IN_PROGRESS_MARK}\n${text}`;
      inGap = true;
    }
    return { id, timecode: entry.timecode, text };
  });
  const done = partial.doneChunkIndices.size;
  const notice = `Prevod še poteka (${done}/${partial.totalChunks} delov). Ko bo končan, znova izberite podnapise.`;
  return prependNoticeCue(toSrt(entries), notice);
}

function inProgressPlaceholderSrt() {
  // Dolgo obvestilo, da je vidno kadarkoli med ogledom.
  return `0\n00:00:01,000 --> 09:59:59,000\n${IN_PROGRESS_MARK}\nPrevod se pripravlja (1-2 min).`;
}

// ---------- 4. Shranjevanje rezultata v .sl.srt datoteko ----------

function saveSlovenianSrtFile(imdbId, season, episode, srtContent) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const epSuffix = season && episode ? `_s${season}e${episode}` : '';
    const safeName = `${String(imdbId).replace(/[^a-z0-9_-]/gi, '_')}${epSuffix}.sl.srt`;
    const filePath = path.join(CACHE_DIR, safeName);
    fs.writeFileSync(filePath, srtContent, 'utf8');
    return filePath;
  } catch (err) {
    console.warn(`[storage] failed to save .sl.srt file: ${err.message}`);
    return null;
  }
}

function loadSlovenianSrtFile(imdbId, season, episode) {
  try {
    const epSuffix = season && episode ? `_s${season}e${episode}` : '';
    const safeName = `${String(imdbId).replace(/[^a-z0-9_-]/gi, '_')}${epSuffix}.sl.srt`;
    const filePath = path.join(CACHE_DIR, safeName);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
  } catch (_) {}
  return null;
}

function cacheFilePath(key) {
  const safe = String(key).replace(/[^a-z0-9_-]/gi, '_');
  return path.join(CACHE_DIR, `${safe}.json`);
}

function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
    let loaded = 0;
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
        if (data?.key && data?.srt && data.expiresAt > Date.now()) {
          cache.set(data.key, { srt: data.srt, expiresAt: data.expiresAt });
          loaded += 1;
        }
      } catch (_) {}
    }
    if (loaded) console.log(`[cache] loaded ${loaded} previously translated subtitle(s) from disk`);
  } catch (error) {
    console.warn(`[cache] failed to load from disk: ${error.message}`);
  }
}

function saveCacheEntryToDisk(key, entry) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFilePath(key), JSON.stringify({ key, srt: entry.srt, expiresAt: entry.expiresAt }), 'utf8');
  } catch (error) {
    console.warn(`[cache] failed to persist ${key} to disk: ${error.message}`);
  }
}

function partialFilePath(key) {
  const safe = String(key).replace(/[^a-z0-9_-]/gi, '_');
  return path.join(CACHE_DIR, `partial-${safe}.json`);
}

function savePartialToDisk(key, partial) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const data = {
      key,
      order: partial.order,
      totalChunks: partial.totalChunks,
      doneChunkIndices: [...partial.doneChunkIndices],
      failedChunkIndices: [...(partial.failedChunkIndices || [])],
      entries: Object.fromEntries(partial.entryMap)
    };
    fs.writeFileSync(partialFilePath(key), JSON.stringify(data), 'utf8');
  } catch (error) {
    console.warn(`[cache] failed to persist translation progress for ${key}: ${error.message}`);
  }
}

function loadPartialFromDisk(key) {
  try {
    const file = partialFilePath(key);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.order) || !data.entries) return null;
    return {
      entryMap: new Map(Object.entries(data.entries)),
      order: data.order,
      totalChunks: data.totalChunks,
      doneChunkIndices: new Set(data.doneChunkIndices || []),
      failedChunkIndices: new Set(data.failedChunkIndices || [])
    };
  } catch (_) {
    return null;
  }
}

function deletePartialFromDisk(key) {
  try {
    const file = partialFilePath(key);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_) {}
}

function friendlyErrorMessage(raw) {
  const msg = String(raw || '');
  if (/OpenSubtitles prenos zavrnjen: 401/i.test(msg)) return 'OpenSubtitles je zavrnil prenos (401). Na strežniku preveri OPENSUBTITLES_USERNAME, OPENSUBTITLES_PASSWORD in OPENSUBTITLES_API_KEY.';
  if (/OpenSubtitles prenos zavrnjen: 406/i.test(msg)) return 'Dnevna kvota prenosov na OpenSubtitles je porabljena. Poskusi znova jutri.';
  if (/OpenSubtitles prenos zavrnjen: 429/i.test(msg)) return 'OpenSubtitles trenutno zavrača preveč zahtev. Poskusi znova čez minuto.';
  if (/OpenSubtitles prenos zavrnjen/i.test(msg)) return `Podnapisov ni bilo mogoče prenesti z OpenSubtitles (${msg.replace(/^.*zavrnjen:\s*/i, '').slice(0, 80)}).`;
  if (/credit|quota|resource_exhausted|insufficient_quota/i.test(msg)) return 'Zmanjkalo je AI kvote/kreditov. Preveri Google AI Studio / Gemini konzolo in poskusi znova.';
  if (/rate.?limit|429/i.test(msg)) return 'Trenutno preveč hkratnih zahtev do AI (rate limit). Poskusi znova čez nekaj minut.';
  if (/GEMINI_API_KEY/i.test(msg)) return 'Manjka ali je neveljaven Gemini API ključ na strežniku.';
  if (/No subtitle found/i.test(msg)) return 'Za ta film ni bilo mogoče najti izvirnih podnapisov (HR/ITA/ANG).';
  return msg || 'Translation failed';
}

function statusNoticeSrt(text) {
  return `0\n00:00:01,000 --> 00:00:05,000\n${text}`;
}

const CHOOSE_PLACEHOLDER_SRT = '0\n00:00:01,000 --> 09:59:59,000\n[Slo AI prevod] Izberi vir spodaj v seznamu.';

function getTranslationNotice(lang) {
  if (lang === 'hr') return 'Prevod iz hrvaških podnapisov.';
  if (lang === 'it') return 'Prevod iz italijanskih podnapisov.';
  if (lang === 'en') return 'Prevod iz angleških podnapisov.';
  const name = LANGUAGE_DISPLAY_NAMES[lang] || lang.toUpperCase();
  return `Prevod iz ${name} podnapisov.`;
}

function buildPlaceholderSrt(lang = 'hr') {
  return statusNoticeSrt(getTranslationNotice(lang));
}

function buildErrorSrt(message) {
  const safe = friendlyErrorMessage(message).replace(/[\r\n]+/g, ' ').slice(0, 200);
  return statusNoticeSrt(`Napaka: ${safe}`);
}

let keepAliveTimer = null;

function ensureKeepAlive() {
  if (keepAliveTimer) return;
  const baseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl) return;
  keepAliveTimer = setInterval(async () => {
    const stillActive = [...jobs.values()].some(j => j.status === 'processing');
    if (!stillActive) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      return;
    }
    try {
      await axios.get(`${baseUrl}/health`, { timeout: 10000 });
    } catch (_) {}
  }, 4 * 60 * 1000);
  keepAliveTimer.unref?.();
}

function createSubtitleFileWaiter({ cache: cacheStore, jobs: jobsStore, pollMs = 1000, timeoutMs = SUBTITLE_FILE_TIMEOUT_MS } = {}) {
  return async function waitForSubtitleFile(jobKey) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entry = cacheStore.get(jobKey);
      if (entry?.srt && entry.expiresAt > Date.now()) return entry.srt;
      const job = jobsStore.get(jobKey);
      if (job?.status === 'failed') throw new Error(job.error || 'Translation failed');
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw new Error('Translation timed out');
  };
}

function manifest() { return addonManifest; }

// ---------- HTTP app ----------

function createApp() {
  const app = express();
  const baseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    console.log(`[request] ${req.method} ${req.originalUrl}`);
    return next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/manifest.json', (_req, res) => res.json(manifest()));
  app.get('/manifest', (_req, res) => res.json(manifest()));

  app.get('/health', (_req, res) => res.json({
    status: 'healthy',
    cacheEntries: cache.size,
    processingJobs: jobs.size,
    completedJobs: completed.size,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    geminiModel: GEMINI_MODEL,
    analysisModel: ANALYSIS_MODEL,
    chunkSize: CHUNK_SIZE,
    concurrency: TRANSLATION_CONCURRENCY,
    fileTimeoutMs: SUBTITLE_FILE_TIMEOUT_MS,
    targetCps: TARGET_CPS,
    tmdbConfigured: Boolean(process.env.TMDB_API_KEY),
    openSubtitlesConfigured: Boolean(process.env.OPENSUBTITLES_API_KEY),
    openSubtitlesLoginConfigured: Boolean(process.env.OPENSUBTITLES_USERNAME && process.env.OPENSUBTITLES_PASSWORD),
    cacheDir: CACHE_DIR
  }));

  app.get('/configure', (_req, res) => res.type('html').send('<h1>Slo AI Subtitle Translator (Gemini Flash)</h1><p>Nastavi API ključe v Render Environment Variables (GEMINI_API_KEY, TMDB_API_KEY, OPENSUBTITLES_API_KEY).</p>'));

  function startTranslationJob(imdbId, key, sourceLanguage, videoHash, strict, season, episode) {
    if (jobs.has(key) && jobs.get(key)?.status !== 'failed') return;
    jobs.set(key, { status: 'processing', startedAt: Date.now(), error: null });
    ensureKeepAlive();
    Promise.resolve()
      .then(() => translateSubtitle(imdbId, sourceLanguage, videoHash, strict, season, episode))
      .then(() => { completed.set(key, { status: 'completed', finishedAt: Date.now() }); })
      .catch(error => {
        const job = jobs.get(key);
        if (job) { job.error = error.message; job.status = 'failed'; }
        console.error(`[translation] ${error.message}`);
      });
  }

  app.get('/subtitle-file/:imdbId/:lang.srt', async (req, res) => {
    const { imdbId } = req.params;
    const lang = req.params.lang;
    const videoHash = req.query.hash ? String(req.query.hash) : null;
    const season = req.query.season ? String(req.query.season) : null;
    const episode = req.query.episode ? String(req.query.episode) : null;
    const fileId = req.query.fileId && /^\d+$/.test(String(req.query.fileId)) ? String(req.query.fileId) : null;
    const options = {
      fileId,
      fileName: req.query.source ? String(req.query.source).slice(0, 200) : null,
      videoFileName: req.query.file ? String(req.query.file).slice(0, 300) : null
    };

    if (lang === 'choose') {
      return res.type('application/x-subrip; charset=utf-8').send(CHOOSE_PLACEHOLDER_SRT);
    }
    if (!SUPPORTED_SOURCE_LANGUAGES.includes(lang)) return res.sendStatus(404);

    const key = buildCacheKey(imdbId, sourceCacheLanguage(lang, options), videoHash, season, episode);

    const finalEntry = cache.get(key);
    if (finalEntry && finalEntry.expiresAt > Date.now()) {
      const notice = 'Naloženi že prej prevedeni slovenski podnapisi.';
      return res.type('application/x-subrip; charset=utf-8').send(prependNoticeCue(finalEntry.srt, notice));
    }
    // Brez hasha shranjene datoteke ne moremo uskladiti, zato jo postrežemo takoj (kot doslej).
    // S hashem gre skozi translateSubtitle, ki jo časovno uskladi s to izdajo videa.
    const localDiskSrt = fileId || videoHash ? null : loadSlovenianSrtFile(imdbId, season, episode);
    if (localDiskSrt) {
      const notice = 'Naloženi že prej prevedeni slovenski podnapisi.';
      return res.type('application/x-subrip; charset=utf-8').send(prependNoticeCue(localDiskSrt, notice));
    }

    // Zaženemo prevod / iskanje slovenskih podnapisov
    try {
      // strict = false omogoča samodejni prehod na naslednje jezike po prioriteti (HR -> IT -> EN);
      // pri ročni izbiri (fileId) je vir točno določen.
      const translation = translateSubtitle(imdbId, lang, videoHash, Boolean(fileId), season, episode, options);
      let failure = null;
      translation.catch(err => {
        failure = err;
        console.error(`[translation] ${imdbId}: ${err.message}`);
      });

      // Takoj ko je preveden 1. chunk (ali celoten film), postrežemo podnapise brez čakanja!
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (failure && !cache.get(key) && !partials.get(key)) {
          res.set('Cache-Control', 'no-store');
          return res.status(503).type('application/x-subrip; charset=utf-8').send(buildErrorSrt(failure.message));
        }
        const full = cache.get(key);
        if (full && full.srt) {
          return res.type('application/x-subrip; charset=utf-8').send(full.srt);
        }
        const partial = partials.get(key);
        if (partial && partial.doneChunkIndices && partial.doneChunkIndices.size >= 1) {
          res.set('Cache-Control', 'no-store');
          return res.type('application/x-subrip; charset=utf-8').send(partialProgressSrt(partial));
        }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    } catch (error) {
      console.error(`[translation] ${imdbId}: ${error.message}`);
      return res.status(503).type('application/x-subrip; charset=utf-8').send(buildErrorSrt(error.message));
    }

    res.set('Cache-Control', 'no-store');
    const partial = partials.get(key);
    if (partial && partial.doneChunkIndices && partial.doneChunkIndices.size >= 1) {
      return res.type('application/x-subrip; charset=utf-8').send(partialProgressSrt(partial));
    }

    const job = jobs.get(key);
    if (job?.status === 'failed') {
      return res.status(503).type('application/x-subrip; charset=utf-8').send(buildErrorSrt(job.error));
    }

    return res.type('application/x-subrip; charset=utf-8').send(inProgressPlaceholderSrt());
  });

  app.get(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\.json)?(?:\/([^/]+?))?$/, async (req, res) => {
    console.log(`[subtitle] type=${req.params[0]} id=${req.params[1]} extra=${req.params[2] || ''}`);
    const type = req.params[0];
    const rawId = req.params[1].replace(/\.json$/i, '');
    const { imdbId, season, episode } = parseSeriesId(rawId);
    const explicitLanguage = req.query.sourceLanguage ? String(req.query.sourceLanguage).toLowerCase() : null;
    const videoHash = parseExtraHash(req.params[2]).videoHash;
    const videoFileName = parseExtraFileName(req.params[2]);
    const root = baseUrl || `${req.protocol}://${req.get('host')}`;

    const sourceLangLabel = {
      hr: 'Prevod iz HR',
      it: 'Prevod iz IT',
      en: 'Prevod iz ANG'
    };
    const extraQuery = [
      videoHash ? `hash=${encodeURIComponent(videoHash)}` : null,
      season && episode ? `season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}` : null,
      videoFileName ? `file=${encodeURIComponent(videoFileName)}` : null
    ].filter(Boolean).join('&');
    const queryString = extraQuery ? `?${extraQuery}` : '';

    const buildUrl = lang => `${root}/subtitle-file/${encodeURIComponent(imdbId)}/${lang}.srt${queryString}`;
    const buildChoiceUrl = choice => {
      const params = `fileId=${encodeURIComponent(choice.fileId)}&source=${encodeURIComponent(choice.release || choice.fileName || '')}`;
      return `${buildUrl(choice.sourceLanguage)}${queryString ? '&' : '?'}${params}`;
    };

    // Dodatni vnosi za ročni ponovni prevod iz točno določenega podnapisa.
    // Seznam je le iskanje (brez prenosov), z omejenim časom, da Stremio ne čaka.
    async function manualChoiceEntries(languages) {
      try {
        const choices = await Promise.race([
          listManualSourceChoices(imdbId, season, episode, videoFileName),
          new Promise(resolve => setTimeout(() => resolve([]), 4000))
        ]);
        const counters = {};
        return choices
          .filter(choice => languages.includes(choice.sourceLanguage))
          .map(choice => ({
            id: `slo-ai-${type}-${imdbId}-${choice.sourceLanguage}-file${choice.fileId}`,
            url: buildChoiceUrl(choice),
            lang: 'slv',
            label: `Ponovni prevod iz ${choice.sourceLanguage === 'en' ? 'ANG' : choice.sourceLanguage.toUpperCase()} #${(counters[choice.sourceLanguage] = (counters[choice.sourceLanguage] || 0) + 1)}: ${candidateLabel(choice)}`
          }));
      } catch (error) {
        console.warn(`[subtitle] seznama virov za ročno izbiro ni bilo mogoče pripraviti: ${error.message}`);
        return [];
      }
    }

    if (explicitLanguage && SUPPORTED_SOURCE_LANGUAGES.includes(explicitLanguage)) {
      const id = `slo-ai-${type}-${imdbId}-${explicitLanguage}`;
      const label = sourceLangLabel[explicitLanguage] || `Prevod iz ${explicitLanguage.toUpperCase()}`;
      const manual = await manualChoiceEntries([explicitLanguage]);
      return res.json({ subtitles: [{ id, url: buildUrl(explicitLanguage), lang: 'slv', label }, ...manual] });
    }

    const subtitles = [
      { id: `slo-ai-${type}-${imdbId}-hr`, url: buildUrl('hr'), lang: 'slv', label: 'Prevod iz HR' },
      { id: `slo-ai-${type}-${imdbId}-it`, url: buildUrl('it'), lang: 'slv', label: 'Prevod iz IT' },
      { id: `slo-ai-${type}-${imdbId}-en`, url: buildUrl('en'), lang: 'slv', label: 'Prevod iz ANG' },
      ...await manualChoiceEntries(SUPPORTED_SOURCE_LANGUAGES)
    ];

    return res.json({ subtitles });
  });

  return app;
}

if (require.main === module) {
  loadCacheFromDisk();
  createApp().listen(PORT, '0.0.0.0', () => console.log(`Slo AI addon listening on ${PORT}`));
}

module.exports = {
  chunkSrt,
  parseAndValidateSrt,
  reconcileTranslatedSrt,
  validateSlovenianSubtitle,
  buildMetadataContext,
  systemPrompt,
  manifest,
  createApp,
  buildPlaceholderSrt,
  buildErrorSrt,
  createSubtitleFileWaiter,
  runWithConcurrency,
  CHUNK_SIZE,
  TRANSLATION_CONCURRENCY,
  SUBTITLE_FILE_TIMEOUT_MS,
  GEMINI_MODEL,
  providerConfig,
  buildGeminiRequest,
  computeTranslationMaxOutputTokens,
  translateWithGemini,
  extractGeminiOutputText,
  buildClaudeRequest,
  translateWithClaude,
  buildAnthropicRequest,
  translateWithAnthropic,
  extractClaudeOutputText,
  characterAnalysisPrompt,
  parseCharacterLedger,
  ledgerToText,
  analyzeCharacters,
  ANALYSIS_MODEL,
  geminiModelsToTry,
  buildCharacterGenderMap,
  lookupCharacterGender,
  removeSdhEntries,
  buildTranslationUserText,
  resolveSourceLanguages,
  timecodeToSeconds,
  cueDurationSeconds,
  maxCharsForDuration,
  findTooFastCues,
  TARGET_CPS,
  MAX_LINE_CHARS,
  createPartialTracker,
  mergeChunkIntoPartial,
  markChunkFailed,
  partialToSrt,
  partialProgressSrt,
  inProgressPlaceholderSrt,
  removeSdh,
  stripSdhFromLine,
  DEFAULT_LANGUAGE_PRIORITY,
  SUPPORTED_SOURCE_LANGUAGES,
  saveSlovenianSrtFile,
  cacheFilePath,
  loadCacheFromDisk,
  saveCacheEntryToDisk,
  CACHE_DIR,
  openSubtitlesLogin,
  openSubtitlesHeaders,
  partialFilePath,
  savePartialToDisk,
  loadPartialFromDisk,
  deletePartialFromDisk,
  ensureKeepAlive,
  parseTranslationJson,
  extractTranslationPairsLoosely,
  translateSubtitle,
  openSubtitlesErrorDetail,
  downloadOpenSubtitleFile,
  alignGenderHelper,
  reviewTranslationGender,
  translateChunk,
  friendlyErrorMessage,
  statusNoticeSrt,
  buildCacheKey,
  parseSeriesId,
  parseExtraHash,
  CHARACTER_LEDGER_SCHEMA,
  TRANSLATION_SCHEMA,
  buildTranslationSchema,
  withOpenSubtitlesLimit,
  fetchOpenSubtitleForLanguage,
  shiftSrtTimings,
  autoDetectSyncOffset,
  parseExtraFileName,
  sourceCacheLanguage,
  scoreSubtitleCandidate,
  rankSubtitleCandidates,
  pickManualChoices,
  releaseSourceFamily,
  releaseGroupName,
  syncNoticeSuffix
};
