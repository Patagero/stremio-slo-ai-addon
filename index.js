const express = require('express');
const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 7002);
const CHUNK_SIZE = Math.max(40, Math.min(50, Number(process.env.CHUNK_SIZE || 45)));
const TRANSLATION_CONCURRENCY = Math.max(1, Math.min(2, Number(process.env.TRANSLATION_CONCURRENCY || 1)));
const SUBTITLE_FILE_TIMEOUT_MS = Math.max(300000, Number(process.env.SUBTITLE_FILE_TIMEOUT_MS || 300000));
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
// Where finished translations are persisted so a Render restart/redeploy doesn't force
// re-translating a movie that was already done. Point CACHE_DIR at a Render Persistent Disk
// mount for this to actually survive redeploys; otherwise it only survives simple restarts
// within the same container's lifetime (still better than pure in-memory).
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '.cache');

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
// Same model for both passes, per explicit choice — Gemini 3.7 Flash for everything.
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || GEMINI_MODEL;
const providerConfig = { name: 'gemini', model: GEMINI_MODEL };

// Ciljna hitrost branja (characters per second). 17 CPS je standardni okvir za odrasle gledalce
// (Netflix/BBC uporabljata podobne vrednosti). Nižje je počasneje/bolj berljivo.
const TARGET_CPS = Number(process.env.TARGET_CPS || 17);
const MAX_LINE_CHARS = Number(process.env.MAX_LINE_CHARS || 42);
const MAX_LINES = 2;

// Jeziki, ki jih ta addon zna prevesti v slovenščino, po prioriteti iskanja na OpenSubtitles.
const SUPPORTED_SOURCE_LANGUAGES = ['en', 'hr', 'it'];

const cache = new Map();
const inflight = new Map();
const completed = new Map();
const jobs = new Map();
// Progressive translation state: jobKey -> { entryMap, order, totalChunks, doneChunks }
// Lets us serve "chunk 1 already done, rest still in the source language" instead of
// making the player wait for the whole film to finish translating.
const partials = new Map();

const addonManifest = {
  id: 'com.stremio.slo.ai.translator',
  version: '0.5.0',
  name: 'Slo AI Subtitle Translator',
  description: 'High-quality English, Croatian and Italian to Slovenian subtitles with two-pass, gender-aware AI translation (Gemini).',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: false }
};

// ---------- SRT parsing / building helpers ----------

// A hand-written, dependency-free SRT reader/writer. We previously relied on the
// 'srt-parser-2' npm package for both reading and writing, and even after fixing the write
// side to emit timecodes verbatim, timestamps were STILL getting corrupted — meaning the
// library's own *reading* logic was also mangling them, right from the very first parse of
// a freshly downloaded subtitle. Owning both sides ourselves removes that risk entirely.
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
      lineIndex = 1; // standard case: first line is the numeric cue index
    } else {
      id = String(entries.length + 1); // tolerate files missing the index line
    }

    const timingMatch = (lines[lineIndex] || '').match(timingRe);
    if (!timingMatch) continue; // not a valid cue block, skip it

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

function chunkSrt(srt, chunkSize = CHUNK_SIZE) {
  const entries = parseSrt(srt);
  const chunks = [];
  for (let i = 0; i < entries.length; i += chunkSize) {
    const slice = entries.slice(i, i + chunkSize);
    chunks.push({ index: chunks.length, entries: slice, srt: toSrt(slice) });
  }
  return chunks;
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
    return { id: entry.id, timecode: entry.timecode, text: found?.text?.trim() || entry.text };
  });
  return toSrt(repaired);
}

function validateSlovenianSubtitle(text) {
  const lines = String(text || '').split('\n');
  return lines.length <= MAX_LINES && lines.every(line => line.length <= MAX_LINE_CHARS);
}

// ---------- SDH cleanup ----------
// Strips hearing-impaired-only markup that regular subtitles don't need: bracketed sound
// descriptions ("[door creaks]"), music-note delimited lines, and ALL-CAPS speaker labels
// ("JOHN:"). This runs on the source subtitle before translation so it doesn't waste
// translation budget or get carried into the Slovenian output.
const SDH_BRACKET_RE = /\[[^\]\n]*\]/g;
const SDH_MUSIC_NOTE_RE = /♪[^♪\n]*♪?/g;
const SDH_SPEAKER_LABEL_RE = /^[-\s]*[A-ZČŠŽ][A-ZČŠŽ0-9 .'-]{1,30}:\s*/;

function stripSdhFromLine(line) {
  return String(line || '')
    .replace(SDH_BRACKET_RE, '')
    .replace(SDH_MUSIC_NOTE_RE, '')
    .replace(SDH_SPEAKER_LABEL_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function removeSdh(srtText) {
  const entries = parseSrt(srtText)
    .map(entry => ({
      ...entry,
      text: entry.text.split('\n').map(stripSdhFromLine).filter(Boolean).join('\n')
    }))
    .filter(entry => entry.text.trim().length > 0)
    .map((entry, index) => ({ ...entry, id: String(index + 1) }));
  return toSrt(entries);
}

// ---------- Reading-speed (CPS) helpers ----------

function timecodeToSeconds(hms) {
  const m = String(hms || '').trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!m) return 0;
  const [, hh, mm, ss, ms] = m;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
}

function cueDurationSeconds(entry) {
  const [start, end] = String(entry.timecode || '').split(' --> ');
  return Math.max(0.2, timecodeToSeconds(end) - timecodeToSeconds(start));
}

function maxCharsForDuration(durationSeconds, targetCps = TARGET_CPS) {
  return Math.max(8, Math.min(MAX_LINES * MAX_LINE_CHARS, Math.round(durationSeconds * targetCps)));
}

// Returns entries whose translated text is meaningfully over the reading-speed budget.
function findTooFastCues(entries) {
  const overLimit = [];
  for (const entry of entries) {
    const duration = cueDurationSeconds(entry);
    const budget = maxCharsForDuration(duration);
    const length = entry.text.replace(/\n/g, ' ').length;
    // 15% tolerance to avoid pointless repair round-trips for near-misses.
    if (length > budget * 1.15) overLimit.push({ id: entry.id, text: entry.text, budget });
  }
  return overLimit;
}

// ---------- Metadata (TMDB) ----------

async function tmdbMetadata(imdbId) {
  if (!process.env.TMDB_API_KEY) return { title: imdbId, overview: 'Not provided', credits: [], originalLanguage: null };
  const base = 'https://api.themoviedb.org/3';
  const find = await axios.get(`${base}/find/${encodeURIComponent(imdbId)}`, {
    params: { api_key: process.env.TMDB_API_KEY, language: 'en-US', external_source: 'imdb_id' }
  });
  const item = find.data.movie_results?.[0] || find.data.tv_results?.[0];
  if (!item) return { title: imdbId, overview: 'Not provided', credits: [], originalLanguage: null };
  const type = find.data.movie_results?.length ? 'movie' : 'tv';
  const details = await axios.get(`${base}/${type}/${item.id}`, {
    params: { api_key: process.env.TMDB_API_KEY, language: 'en-US', append_to_response: 'credits' }
  });
  return {
    title: details.data.title || details.data.name || imdbId,
    overview: details.data.overview || 'Not provided',
    originalLanguage: details.data.original_language || null,
    credits: (details.data.credits?.cast || []).slice(0, 20).map(c => ({
      name: c.character ? `${c.character} (${c.name})` : c.name,
      gender: c.gender // TMDB: 0=unknown, 1=female, 2=male, 3=non-binary
    }))
  };
}

function buildMetadataContext(meta = {}) {
  const genderLabel = { 1: 'Female', 2: 'Male', 3: 'Non-binary' };
  const characters = (meta.credits || [])
    .map(c => `${c.name}: ${genderLabel[c.gender] || 'Unknown'}`)
    .join('\n') || 'No character gender metadata available.';
  return `Title: ${meta.title || 'Unknown'}\nPlot: ${meta.overview || 'Not provided'}\nTMDB Cast Genders:\n${characters}`;
}

// ---------- OpenSubtitles (EN / HR / IT, ordered by original-language priority) ----------

// Fiksna prioriteta iskanja izvornih podnapisov: angleščina, nato hrvaščina, nato
// italijanščina. Angleščina je na prvem mestu, ker je na OpenSubtitles bistežno bolj
// razpoložljiva kot HR/IT, kar poveča verjetnost pravega moviehash ujemanja (glej
// moviehash_match popravek) — na račun manjše slovnične podpore pri prepoznavi spola,
// ki jo HR/IT sicer dajeta z glagolskimi oblikami v izvirniku.
const DEFAULT_LANGUAGE_PRIORITY = ['en', 'hr', 'it'];

function resolveSourceLanguages(meta, requested, strict) {
  const req = String(requested || '').toLowerCase();
  if (strict && SUPPORTED_SOURCE_LANGUAGES.includes(req)) {
    // The person explicitly picked this exact source from Stremio's subtitle menu — if it
    // has no subtitle available, we should say so, not silently substitute another language
    // they didn't choose (that would defeat the whole point of offering separate options).
    return [req];
  }
  if (SUPPORTED_SOURCE_LANGUAGES.includes(req)) {
    return [req, ...DEFAULT_LANGUAGE_PRIORITY.filter(lang => lang !== req)];
  }
  return [...DEFAULT_LANGUAGE_PRIORITY];
}

// Anonymous Api-Key access on OpenSubtitles has a very low daily quota. Logging in with a
// real account (even a free one) gets a JWT token that unlocks a much higher daily quota,
// so we log in once and reuse the token for every search/download call.
let openSubtitlesToken = null; // { value, expiresAt }
let openSubtitlesLoginPromise = null; // in-flight login request, shared by concurrent callers

async function openSubtitlesLogin() {
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;
  if (!username || !password) return null;
  if (openSubtitlesToken && openSubtitlesToken.expiresAt > Date.now()) return openSubtitlesToken.value;

  // The EN/HR/IT multi-track feature starts three translation jobs at once, each of which
  // needs this token — without a single-flight guard, all three would fire simultaneous
  // login requests the moment a new film is opened, which can itself trip OpenSubtitles'
  // rate limit (this is what caused the 406/429 failures during testing).
  if (openSubtitlesLoginPromise) return openSubtitlesLoginPromise;

  openSubtitlesLoginPromise = (async () => {
    try {
      const response = await axios.post('https://api.opensubtitles.com/api/v1/login', { username, password }, {
        headers: {
          'Api-Key': process.env.OPENSUBTITLES_API_KEY,
          'User-Agent': process.env.OPENSUBTITLES_USER_AGENT || 'SloAIAddon v0.5.0',
          'Content-Type': 'application/json',
          Accept: '*/*'
        }
      });
      const token = response.data?.token;
      if (!token) return null;
      // OpenSubtitles JWTs are valid ~24h; refresh a bit early to stay safe.
      openSubtitlesToken = { value: token, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
      console.log('[opensubtitles] logged in, using authenticated (higher-quota) access');
      return token;
    } catch (error) {
      console.warn(`[opensubtitles] login failed, falling back to anonymous access: ${error.message}`);
      return null;
    } finally {
      openSubtitlesLoginPromise = null; // clear so a later, non-concurrent call can retry
    }
  })();

  return openSubtitlesLoginPromise;
}

async function openSubtitlesHeaders() {
  const token = await openSubtitlesLogin();
  const headers = {
    'Api-Key': process.env.OPENSUBTITLES_API_KEY,
    'User-Agent': process.env.OPENSUBTITLES_USER_AGENT || 'SloAIAddon v0.5.0',
    Accept: '*/*'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// The EN/HR/IT multi-track feature starts three translation jobs at once, each of which
// searches OpenSubtitles (hash search + fallback search, up to 2 requests each) — without
// limiting this, opening a new film can burst up to 6 near-simultaneous requests and trip
// OpenSubtitles' own rate limit, which is exactly what caused several failed lookups in
// testing. This is a simple serial queue: every OpenSubtitles call waits its turn.
let openSubtitlesQueue = Promise.resolve();
function withOpenSubtitlesLimit(task) {
  const run = openSubtitlesQueue.then(task, task);
  openSubtitlesQueue = run.then(() => {}, () => {}); // one failure must not block the next caller
  return run;
}

async function fetchOpenSubtitleForLanguage(imdbId, language, videoHash) {
  return withOpenSubtitlesLimit(() => fetchOpenSubtitleForLanguageUnqueued(imdbId, language, videoHash));
}

async function fetchOpenSubtitleForLanguageUnqueued(imdbId, language, videoHash) {
  const headers = await openSubtitlesHeaders();
  const baseParams = { imdb_id: String(imdbId).replace(/^tt/, ''), languages: language, order_by: 'downloads', order_direction: 'desc' };

  // Prefer an EXACT hash match first. Different releases of the same movie (BluRay vs
  // WEBDL, theatrical vs extended cut, different intro/logo lengths) are very often NOT in
  // sync with each other even though OpenSubtitles treats them as "the same movie" — the
  // moviehash uniquely fingerprints the specific file, guaranteeing correct timing.
  //
  // IMPORTANT: sending `moviehash` alone does NOT guarantee the API only returns hash-
  // verified results — it can still fall back to its normal best-match ranking (e.g. most
  // downloaded) even when nothing actually matches the hash. `moviehash_match: 'only'` is
  // the parameter that actually forces exclusively hash-verified results; without it, our
  // earlier "hash-matched" logging was a false positive; we additionally double-check the
  // `moviehash_match` attribute on the returned result itself, rather than trusting the
  // request parameters alone, in case the API's filtering behavior changes.
  if (videoHash) {
    try {
      const hashSearch = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
        headers,
        params: { ...baseParams, moviehash: videoHash, moviehash_match: 'only' }
      });
      const hashResult = hashSearch.data.data?.[0];
      const hashFile = hashResult?.attributes?.files?.[0];
      const verifiedMatch = hashResult?.attributes?.moviehash_match !== false; // treat missing field as trust the 'only' filter
      if (hashFile?.file_id && verifiedMatch) {
        const download = await axios.post('https://api.opensubtitles.com/api/v1/download', { file_id: hashFile.file_id }, { headers });
        if (download.data.link) {
          const srt = (await axios.get(download.data.link)).data;
          return { srt, language, matchedByHash: true };
        }
      }
    } catch (error) {
      console.warn(`[opensubtitles] hash search failed for ${imdbId} (${language}): ${error.message}`);
    }
  }

  // Fall back to a generic, most-downloaded subtitle for the movie. Better than nothing,
  // but sync with this exact file is not guaranteed.
  const search = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', { headers, params: baseParams });
  const file = search.data.data?.[0]?.attributes?.files?.[0];
  if (!file?.file_id) return null;
  const download = await axios.post('https://api.opensubtitles.com/api/v1/download', { file_id: file.file_id }, { headers });
  if (!download.data.link) return null;
  const srt = (await axios.get(download.data.link)).data;
  return { srt, language, matchedByHash: false };
}

async function fetchOpenSubtitle(imdbId, meta, requestedLanguage, videoHash, strict) {
  if (!process.env.OPENSUBTITLES_API_KEY) throw new Error('OPENSUBTITLES_API_KEY is not configured');
  const languages = resolveSourceLanguages(meta, requestedLanguage, strict);
  for (const language of languages) {
    try {
      const found = await fetchOpenSubtitleForLanguage(imdbId, language, videoHash);
      if (found) return found;
    } catch (error) {
      console.warn(`[opensubtitles] ${imdbId} (${language}) failed: ${error.message}`);
    }
  }
  throw new Error(`No subtitle found in any of: ${languages.join(', ')}`);
}

// ---------- Gemini provider ----------

function buildGeminiRequest(inputText, model = GEMINI_MODEL, options = {}) {
  const body = { model, input: inputText };
  if (options.schema) {
    body.response_format = { type: 'text', mime_type: 'application/json', schema: options.schema };
  }
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
    body
  };
}

// Gemini's Interactions API has no separate "system" concept the way Anthropic does —
// everything goes into one "input" string. Putting the large, STABLE/shared context first
// (before the small, per-call content) maximizes the chance that Gemini's automatic
// implicit caching — enabled by default for 2.5+ models, no code required, unlike
// Anthropic's manual cache_control/TTL handling — recognizes and reuses that shared prefix
// across the ~20-26 chunk calls that make up one film's translation.
function combineForGemini(sharedContext, perCallContent) {
  return `${sharedContext}\n\n---\n\n${perCallContent}`;
}

async function translateWithGemini(inputText, options = {}) {
  const apiKey = options.apiKey || GEMINI_API_KEY;
  const model = options.model || GEMINI_MODEL;
  const fetchImpl = options.fetchImpl || fetch;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  const request = buildGeminiRequest(inputText, model, options);
  const response = await fetchImpl(request.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(request.body)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }
  const data = await response.json();
  return String(data.output_text || '').trim();
}

// ---------- Pass 1: character / gender ledger extraction ----------

function characterAnalysisPrompt(tmdbContext) {
  return `You are preparing a character-gender reference sheet ("ledger") for a professional English/Croatian/Italian to Slovenian subtitle translation.

You will be given the full dialogue text of a film or episode (one line per subtitle cue, in original order) and TMDB cast metadata.

TASK:
1. Identify every named or clearly identifiable character who speaks or is spoken to.
2. Determine each character's gender using: their name, how other characters address them, pronouns/verb agreement in the source dialogue (Croatian and Italian mark gender directly on past-tense verbs and adjectives), and the TMDB cast list below.
3. If the source is English and no strong textual evidence exists, rely on the TMDB cast metadata as the primary signal.
4. If a character's gender truly cannot be determined from any source, mark it "unknown" rather than guessing.
5. Note any characters who are addressed with formal "vikanje" vs informal "tikanje" if this is evident from context (e.g. rank, age gap, formality of a scene).

TMDB CAST METADATA:
${tmdbContext}

Return ONLY a JSON object, no markdown, no commentary, in this exact shape:
{"characters":[{"name":"<name as it appears/is addressed in dialogue>","gender":"male|female|unknown","confidence":"high|medium|low","note":"<one short clause of supporting evidence>"}]}

Limit to at most 25 characters, prioritizing anyone with more than a couple of lines.`;
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
        gender: ['male', 'female', 'unknown'].includes(c.gender) ? c.gender : 'unknown',
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
    .map(c => `${c.name}: ${c.gender}${c.note ? ` (${c.note})` : ''} [confidence: ${c.confidence}]`)
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
  // Plain dialogue lines are enough for this pass and keep the request compact; timestamps
  // and IDs add no value for gender inference.
  const dialogue = entries.map(e => e.text.replace(/\n/g, ' ')).join('\n');
  const tmdbContext = buildMetadataContext(meta);
  const inputText = combineForGemini(characterAnalysisPrompt(tmdbContext), dialogue);
  try {
    const raw = await translateWithGemini(inputText, { model: ANALYSIS_MODEL, schema: CHARACTER_LEDGER_SCHEMA });
    return parseCharacterLedger(raw);
  } catch (error) {
    console.warn(`[character-analysis] failed, falling back to TMDB only: ${error.message}`);
    return [];
  }
}

// ---------- Pass 2: translation ----------

function systemPrompt(context) {
  return `You are an elite, professional subtitle translator and localizer specializing in English/Croatian/Italian to natural Slovenian translation.

CONTEXT:
${context}

CORE TRANSLATION & SUBTITLE RULES:

1. READING SPEED & LENGTH CONTROL (CRITICAL):
- Every cue includes its allowed on-screen duration. Keep translated text within roughly ${TARGET_CPS} characters per second of that duration so viewers have time to read it comfortably.
- Hard limits regardless of duration: maximum ${MAX_LINE_CHARS} characters per line, maximum ${MAX_LINES} lines per cue.
- Condense wordy or literal translations: drop filler words, merge redundant phrases, prefer short natural Slovenian equivalents over long literal ones. Never sacrifice meaning, but prefer the shorter of two equally natural options.

2. GENDER & CONTEXT ACCURACY (ON/ONA) — CRITICAL:
- Use the CHARACTER LEDGER above as the authoritative source for each named character's gender. Apply it consistently for every single cue that character appears in, from the first line to the last.
- For characters not in the ledger, infer gender from dialogue context (who is addressed, who is being talked about) and keep it consistent once established.
- Never infer gender from voice alone — you cannot hear the audio. Use names, forms of address, relationships and the ledger only.
- Apply correct Slovenian first-person forms: female "rekla sem", "prišla sem", "bila sem", "vesela sem"; male "rekel sem", "prišel sem", "bil sem", "vesel sem".
- Apply correct second-person forms depending on the addressee's gender: "si videla" / "si videl", "si pripravljena" / "si pripravljen".
- Distinguish the speaker's own gender from the gender of whoever they are addressing or describing — these are often different.
- If evidence is genuinely insufficient for a minor, unnamed character, prefer neutral phrasing that avoids committing to an unsupported gender rather than guessing.

3. NATURAL LOCALIZED LANGUAGE:
- Avoid robotic literal translation. Localize idioms, slang and banter into modern conversational Slovenian.
- Keep tikanje/vikanje consistent per relationship, per the ledger's formality notes where available.

4. PERFECT SRT SYNTAX & STRUCTURAL INTEGRITY:
- Retain every cue id exactly. Do not skip, merge, split, re-index, reorder or omit cues.
- Output ONLY the requested JSON. No markdown, no commentary, no explanations.`;
}

function buildTranslationUserText(sourceEntries) {
  const lines = sourceEntries.map(entry => {
    const duration = cueDurationSeconds(entry).toFixed(1);
    const budget = maxCharsForDuration(cueDurationSeconds(entry));
    return `[id=${entry.id} duration=${duration}s max_chars=${budget}] ${entry.text.replace(/\n/g, ' / ')}`;
  });
  return `Translate every source cue below into Slovenian. Return one entry per cue in the "translations" array, with "id" matching the source id exactly. Use "\\n" inside "text" only for a genuine second line. Never merge or omit entries.

SOURCE CUES (duration and character budget shown for each; stay within budget where possible):
${lines.join('\n')}`;
}

// minItems/maxItems are set dynamically per call (see buildTranslationSchema) to exactly
// match the number of source cues — without this, the schema only constrains the SHAPE of
// each item, not the COUNT, so Gemini could return a shorter-but-valid array that still
// passes schema validation while being incomplete for our purposes.
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
// Kept for anything that needs a generic (unbounded-count) schema, e.g. tests.
const TRANSLATION_SCHEMA = buildTranslationSchema(undefined);

// Lenient fallback kept as a defensive safety net even though Gemini's schema enforcement
// should make malformed JSON structurally impossible — cheap insurance against network
// hiccups or partial responses.
function extractTranslationPairsLoosely(text) {
  const map = new Map();
  const regex = /"id"\s*:\s*"?([^"\n,}]+)"?\s*,\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = regex.exec(String(text || ''))) !== null) {
    const id = match[1].trim();
    let decoded;
    try {
      decoded = JSON.parse(`"${match[2]}"`);
    } catch (_) {
      decoded = match[2].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
    decoded = decoded.trim();
    if (id && decoded) map.set(id, decoded);
  }
  return map;
}

function parseTranslationJson(value) {
  try {
    const data = JSON.parse(String(value || '').trim());
    const list = Array.isArray(data) ? data : Array.isArray(data?.translations) ? data.translations : null;
    if (list) {
      const map = new Map();
      for (const item of list) {
        if (item?.id != null && typeof item.text === 'string' && item.text.trim()) map.set(String(item.id), item.text.trim());
      }
      if (map.size) return map;
    }
  } catch (_) {
    // Fall through to the lenient extractor below.
  }
  const loose = extractTranslationPairsLoosely(value);
  return loose.size ? loose : null;
}

async function translateChunk(chunk, context) {
  const sourceEntries = chunk.entries || parseSrt(chunk.srt);
  const systemText = systemPrompt(context);
  const userText = buildTranslationUserText(sourceEntries);
  const fullSchema = buildTranslationSchema(sourceEntries.length);
  // systemText is IDENTICAL for every chunk of the same film (same context/ledger). Putting
  // it FIRST in the combined input lets Gemini's automatic implicit caching (no code
  // required, unlike Anthropic's manual TTL handling) recognize and reuse that shared
  // prefix across the ~20-25 calls that make up one film's translation.
  const response = await translateWithGemini(combineForGemini(systemText, userText), { schema: fullSchema });
  let translated = parseTranslationJson(response);

  if (!translated || translated.size !== sourceEntries.length) {
    console.warn(`[translation] chunk ${chunk.index + 1} incomplete (${translated?.size || 0}/${sourceEntries.length}); repairing`);
    const repairInput = combineForGemini(systemText, `${userText}\n\nREPAIR: your previous reply was missing or malformed entries. Return every source id exactly once.`);
    const repaired = await translateWithGemini(repairInput, { schema: fullSchema });
    translated = parseTranslationJson(repaired) || translated || new Map();

    if (translated.size !== sourceEntries.length) {
      // The repair attempt ALSO came back incomplete. Silently continuing here used to mean
      // the chunk was marked "done" while some of its cues quietly stayed in the source
      // language — throwing instead makes this a real failure, which the caller's existing
      // 3-attempt retry loop (see translateSubtitle) will properly retry from scratch,
      // rather than accepting a partially-untranslated chunk as if it succeeded.
      throw new Error(`chunk ${chunk.index + 1} still incomplete after repair (${translated.size}/${sourceEntries.length})`);
    }
  }

  let resultEntries = sourceEntries.map(entry => ({
    id: entry.id,
    timecode: entry.timecode,
    text: translated.get(String(entry.id)) || entry.text
  }));

  // Reading-speed repair pass: ask Gemini to shorten only the cues that are over budget.
  const tooFast = findTooFastCues(resultEntries);
  if (tooFast.length) {
    console.warn(`[translation] chunk ${chunk.index + 1}: ${tooFast.length} cue(s) over reading-speed budget, shortening`);
    const shortenSchema = buildTranslationSchema(tooFast.length);
    const shortenNote = 'SHORTENING PASS: the cues below are too long for their on-screen duration. Rewrite ONLY these cues to fit within max_chars while preserving meaning and correct gender. Return the same "translations" format as before, one entry per listed id.';
    const shortenUserText = tooFast.map(c => `[id=${c.id} max_chars=${c.budget}] ${c.text.replace(/\n/g, ' / ')}`).join('\n');
    try {
      const shortenedRaw = await translateWithGemini(combineForGemini(systemText, `${shortenNote}\n\n${shortenUserText}`), { schema: shortenSchema });
      const shortenedMap = parseTranslationJson(shortenedRaw);
      if (shortenedMap) {
        resultEntries = resultEntries.map(entry => shortenedMap.has(String(entry.id)) ? { ...entry, text: shortenedMap.get(String(entry.id)) } : entry);
      }
    } catch (error) {
      console.warn(`[translation] shortening pass failed, keeping original lengths: ${error.message}`);
    }
  }

  // Return structured entries directly — NOT a serialized string. Serializing here and
  // re-parsing it back in the caller (mergeChunkIntoPartial) was an unnecessary round trip
  // through the SRT library on both ends, which risked corrupting timestamps a second time
  // even after toSrt() itself was fixed to write timecodes verbatim.
  return resultEntries;
}

// ---------- Orchestration ----------

// Different releases of the same movie can have different timing (different intro length,
// theatrical vs extended cut, etc.), so once we're matching subtitles by exact video hash,
// the cache/job key needs to include that hash too — otherwise two different releases of
// the same film would incorrectly share one cached translation timed for only one of them.
function buildCacheKey(imdbId, sourceLanguage, videoHash) {
  const idPart = videoHash ? `${imdbId}:${videoHash}` : imdbId;
  return `${idPart}:${sourceLanguage || 'auto'}:slv:gemini:${GEMINI_MODEL}`;
}

// Stremio sends extra request parameters (filename, videoSize, videoHash) as a single
// encoded path segment. We only need videoHash/videoSize; a small targeted regex is more
// robust here than a generic query-string parser, since filenames can contain characters
// (+, brackets, spaces) that confuse strict URLSearchParams parsing.
function parseExtraHash(extra) {
  const str = String(extra || '');
  const hashMatch = str.match(/(?:^|&)videoHash=([a-f0-9]+)/i);
  const sizeMatch = str.match(/(?:^|&)videoSize=(\d+)/i);
  return {
    videoHash: hashMatch ? hashMatch[1].toLowerCase() : null,
    videoSize: sizeMatch ? sizeMatch[1] : null
  };
}

async function translateSubtitle(imdbId, sourceLanguage, videoHash, strict) {
  const key = buildCacheKey(imdbId, sourceLanguage, videoHash);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.srt;
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const meta = await tmdbMetadata(`tt${String(imdbId).replace(/^tt/, '')}`);
    const { srt: rawSource, language: usedLanguage, matchedByHash } = await fetchOpenSubtitle(imdbId, meta, sourceLanguage, videoHash, strict);

    // When there's no exact hash match, OpenSubtitles returns the same "most downloaded"
    // generic subtitle no matter which release asked for it — so the source content (and
    // therefore the correct translation) is identical across releases in that case. Reuse
    // it instead of re-translating byte-identical text just because videoHash differs.
    if (!matchedByHash) {
      const genericKey = buildCacheKey(imdbId, usedLanguage, null);
      const genericCached = cache.get(genericKey);
      if (genericCached && genericCached.expiresAt > Date.now()) {
        console.log(`[translation] ${imdbId}: reusing existing non-hash-matched ${usedLanguage} translation for this release`);
        cache.set(key, genericCached);
        saveCacheEntryToDisk(key, genericCached);
        return genericCached.srt;
      }
    }

    const source = removeSdh(rawSource);
    console.log(`[translation] ${imdbId}: source language=${usedLanguage}, hash-matched=${Boolean(matchedByHash)}, cues after SDH cleanup=${parseSrt(source).length}/${parseSrt(rawSource).length}`);

    const characters = await analyzeCharacters(source, meta);
    const context = `${buildMetadataContext(meta)}\n\nCHARACTER LEDGER (from dialogue analysis):\n${ledgerToText(characters)}`;

    const chunks = chunkSrt(source, CHUNK_SIZE);
    console.log(`[translation] ${imdbId}: translating ${parseSrt(source).length} cues in ${chunks.length} chunk(s) of up to ${CHUNK_SIZE}, model=${GEMINI_MODEL}`);

    const sourceEntries = parseSrt(source);
    const sourceIds = sourceEntries.map(e => e.id);
    const savedPartial = loadPartialFromDisk(key);
    const resumable = savedPartial
      && savedPartial.totalChunks === chunks.length
      && savedPartial.order.length === sourceIds.length
      && savedPartial.order.every((id, i) => id === sourceIds[i]);

    const partial = resumable ? savedPartial : createPartialTracker(sourceEntries, chunks.length);
    if (resumable && partial.doneChunkIndices.size) {
      console.log(`[translation] ${imdbId}: resuming from disk, ${partial.doneChunkIndices.size}/${chunks.length} chunk(s) already done`);
    }
    if (resumable && partial.failedChunkIndices.size) {
      console.log(`[translation] ${imdbId}: retrying ${partial.failedChunkIndices.size} previously failed chunk(s)`);
    }
    partials.set(key, partial);

    await runWithConcurrency(chunks, TRANSLATION_CONCURRENCY, async chunk => {
      if (partial.doneChunkIndices.has(chunk.index)) return; // truly translated already, never redo
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
            // Leave this chunk in the source language for now, but mark it as FAILED (not
            // done) so it gets retried on the next visit instead of being skipped forever —
            // this matters most for temporary causes like running out of AI credits.
            console.error(`[translation] ${imdbId}: chunk ${chunk.index + 1} failed this run, will retry next time`);
            markChunkFailed(partial, chunk.index);
            savePartialToDisk(key, partial);
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    });

    if (partial.failedChunkIndices.size > 0) {
      // Don't finalize/cache an incomplete translation — leave it servable as a partial
      // (whatever succeeded so far) and let the job be retried on the next visit.
      partials.set(key, partial);
      throw new Error(`${partial.failedChunkIndices.size}/${chunks.length} chunk(s) could not be translated this run (will retry next visit)`);
    }

    const srt = partialToSrt(partial);
    const validated = reconcileTranslatedSrt(source, srt);
    parseAndValidateSrt(source, validated);

    cache.set(key, { srt: validated, expiresAt: Date.now() + CACHE_TTL_MS });
    saveCacheEntryToDisk(key, { srt: validated, expiresAt: Date.now() + CACHE_TTL_MS });
    if (!matchedByHash) {
      // Let other releases that also fall back to the same generic search reuse this
      // translation instead of each paying to redo it from scratch.
      const genericKey = buildCacheKey(imdbId, usedLanguage, null);
      cache.set(genericKey, { srt: validated, expiresAt: Date.now() + CACHE_TTL_MS });
      saveCacheEntryToDisk(genericKey, { srt: validated, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    deletePartialFromDisk(key);
    partials.delete(key);
    console.log(`[translation] ${imdbId}: completed ${parseSrt(validated).length} cues`);
    return validated;
  })();

  inflight.set(key, job);
  try {
    return await job;
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

// ---------- Progressive ("watch while it translates") state ----------

function createPartialTracker(sourceEntries, totalChunks) {
  return {
    entryMap: new Map(sourceEntries.map(e => [e.id, { timecode: e.timecode, text: e.text }])),
    order: sourceEntries.map(e => e.id),
    totalChunks,
    doneChunkIndices: new Set(),
    // Chunks that permanently failed this session (e.g. out of credits) — left in the
    // source language for now, but MUST be retried on the next run, not skipped forever.
    failedChunkIndices: new Set()
  };
}

// entries: array of {id, timecode, text} — already structured, no re-parsing needed.
function mergeChunkIntoPartial(partial, entries, chunkIndex) {
  for (const entry of entries) partial.entryMap.set(entry.id, { timecode: entry.timecode, text: entry.text });
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

// ---------- Disk-persisted cache (survives restarts, not necessarily redeploys) ----------

function cacheFilePath(key) {
  const safe = String(key).replace(/[^a-z0-9:_-]/gi, '_');
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
      } catch (_) {
        // Corrupt/partial cache file, skip it.
      }
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

// ---------- Resumable progress (survives a mid-translation restart/spin-down) ----------

function partialFilePath(key) {
  const safe = String(key).replace(/[^a-z0-9:_-]/gi, '_');
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
  } catch (_) {
    // best effort cleanup, not critical
  }
}

// Wraps a raw error message in a friendlier Slovenian explanation for the most common,
// actionable failure causes (out of AI credits, rate limited, missing config, no subtitles).
function friendlyErrorMessage(raw) {
  const msg = String(raw || '');
  if (/credit|quota|resource_exhausted/i.test(msg)) return 'Zmanjkalo je AI kvote/kreditov. Preveri Google AI Studio / Gemini API konzolo in poskusi znova.';
  if (/rate.?limit|429/i.test(msg)) return 'Trenutno preveč hkratnih zahtev do AI (rate limit). Poskusi znova čez nekaj minut.';
  if (/GEMINI_API_KEY/i.test(msg)) return 'Manjka ali je neveljaven Gemini API ključ na strežniku.';
  if (/No subtitle found/i.test(msg)) return 'Za ta film ni bilo mogoče najti izvirnih podnapisov (HR/IT/EN).';
  return msg || 'Translation failed';
}

// A short, low-risk info cue shown at the very start of the file so it's visible without
// digging through server logs. Uses id "0" so it never collides with the real cue numbering.
function statusNoticeSrt(text) {
  return `0\n00:00:00,000 --> 00:00:04,000\n[Slo AI prevod] ${text}`;
}

// Stays visible for the whole runtime (not just 4s) so it's impossible to miss if left
// selected by accident — nudging the person toward the real EN/HR/IT variants below.
const CHOOSE_PLACEHOLDER_SRT = '0\n00:00:00,000 --> 09:59:59,000\n[Slo AI prevod] To ni prevod. Izberi EN, HR ali IT spodaj v seznamu variant.';

function buildPlaceholderSrt() {
  return statusNoticeSrt('Prevajanje se je začelo, prosim počakaj...');
}

function buildErrorSrt(message) {
  const safe = friendlyErrorMessage(message).replace(/[\r\n]+/g, ' ').slice(0, 200);
  return statusNoticeSrt(`Napaka: ${safe}`);
}

// ---------- Keep-alive (best effort) ----------
// Render's free tier can spin the service down after ~15 min without inbound HTTP traffic.
// While a translation job is actively running, we self-ping our own /health endpoint every
// few minutes so an in-progress translation isn't killed just because nobody is watching.
let keepAliveTimer = null;

function ensureKeepAlive() {
  if (keepAliveTimer) return;
  const baseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl) return; // no public URL configured, can't self-ping
  keepAliveTimer = setInterval(async () => {
    const stillActive = [...jobs.values()].some(j => j.status === 'processing');
    if (!stillActive) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      return;
    }
    try {
      await axios.get(`${baseUrl}/health`, { timeout: 10000 });
    } catch (_) {
      // best effort only, a failed ping is not fatal
    }
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

  app.get('/configure', (_req, res) => res.type('html').send('<h1>Slo AI Subtitle Translator</h1><p>Configure API keys in Render environment variables (GEMINI_API_KEY, TMDB_API_KEY, OPENSUBTITLES_API_KEY).</p>'));

  // Starts (or resumes) a translation job for a given cache key, unless one is already
  // running. Shared by both routes below: /subtitles uses it for the explicit-language
  // debug path, /subtitle-file uses it to LAZILY start a translation the first time the
  // person actually opens that specific language's subtitle — not before, so listing three
  // language options no longer means paying to translate all three "just in case".
  function startTranslationJob(imdbId, key, sourceLanguage, videoHash, strict) {
    if (jobs.has(key) && jobs.get(key)?.status !== 'failed') return;
    jobs.set(key, { status: 'processing', startedAt: Date.now(), error: null });
    ensureKeepAlive();
    Promise.resolve()
      .then(() => translateSubtitle(imdbId, sourceLanguage, videoHash, strict))
      .then(() => { completed.set(key, { status: 'completed', finishedAt: Date.now() }); })
      .catch(error => {
        const job = jobs.get(key);
        if (job) { job.error = error.message; job.status = 'failed'; }
        console.error(`[translation] ${error.message}`);
      });
  }

  // Subtitle URLs are self-describing (imdbId + language + optional videoHash query param)
  // instead of a random token looked up in an in-memory registry. A registry entry doesn't
  // survive a Render restart/redeploy/spin-down (all of which wipe in-memory state and even
  // the "persisted" disk cache without a paid Persistent Disk) — a self-describing URL does,
  // since every request can reconstruct the exact same cache/job key from the URL itself,
  // with no dependency on anything that could have been wiped in between.
  app.get('/subtitle-file/:imdbId/:lang.srt', (req, res) => {
    const { imdbId } = req.params;
    const lang = req.params.lang;
    const videoHash = req.query.hash ? String(req.query.hash) : null;

    if (lang === 'choose') {
      return res.type('application/x-subrip; charset=utf-8').send(CHOOSE_PLACEHOLDER_SRT);
    }
    if (!SUPPORTED_SOURCE_LANGUAGES.includes(lang)) return res.sendStatus(404);

    const key = buildCacheKey(imdbId, lang, videoHash);
    startTranslationJob(imdbId, key, lang, videoHash, true);

    // 1) Fully translated and cached — best case.
    const finalEntry = cache.get(key);
    if (finalEntry && finalEntry.expiresAt > Date.now()) {
      return res.type('application/x-subrip; charset=utf-8').send(finalEntry.srt);
    }

    // 2) Translation in progress — serve whatever chunks are done so far so the player
    //    never has to wait for the whole file. Cues not yet translated stay in the
    //    source language until a later request picks up the finished version. A short
    //    status cue at the very start reports progress without digging through logs.
    const partial = partials.get(key);
    if (partial) {
      const body = partialToSrt(partial);
      const done = partial.doneChunkIndices.size;
      let notice = null;
      if (done === 0) {
        notice = statusNoticeSrt('Prevajanje se je začelo, prvi del bo kmalu na voljo...');
      } else if (done < partial.totalChunks) {
        notice = statusNoticeSrt(`Prvi del je preveden (${done}/${partial.totalChunks}), preostanek se prevaja v ozadju.`);
      }
      const combined = notice ? `${notice}\n\n${body}` : body;
      return res.type('application/x-subrip; charset=utf-8').send(combined);
    }

    // 3) Job failed before any chunk finished.
    const job = jobs.get(key);
    if (job?.status === 'failed') {
      return res.status(503).type('application/x-subrip; charset=utf-8').send(buildErrorSrt(job.error));
    }

    // 4) Job just started, nothing to show yet (should only last a second or two).
    return res.type('application/x-subrip; charset=utf-8').send(buildPlaceholderSrt());
  });

  app.get(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\.json)?(?:\/([^/]+?))?$/, (req, res) => {
    console.log(`[subtitle] type=${req.params[0]} id=${req.params[1]} extra=${req.params[2] || ''}`);
    const type = req.params[0];
    const imdbId = req.params[1].replace(/\.json$/i, '');
    const explicitLanguage = req.query.sourceLanguage ? String(req.query.sourceLanguage).toLowerCase() : null;
    // Stremio passes the OpenSubtitles-compatible file hash for the exact video the person
    // is playing — using it lets us fetch a subtitle that is actually in sync with THIS
    // release, instead of a generic one that may have different intro/cut timing.
    const videoHash = parseExtraHash(req.params[2]).videoHash;
    const root = baseUrl || `${req.protocol}://${req.get('host')}`;
    const sourceLangLabel = { en: 'EN', hr: 'HR', it: 'IT' };
    const hashQuery = videoHash ? `?hash=${encodeURIComponent(videoHash)}` : '';

    // Self-describing URL — no token registry, so this survives any restart/redeploy that
    // wipes in-memory state, since the URL itself contains everything /subtitle-file needs.
    const buildUrl = lang => `${root}/subtitle-file/${encodeURIComponent(imdbId)}/${lang}.srt${hashQuery}`;

    // Manual override for testing/debugging a specific source via ?sourceLanguage=en|hr|it —
    // not exposed anywhere in Stremio's own UI, just a URL-level escape hatch.
    if (explicitLanguage && SUPPORTED_SOURCE_LANGUAGES.includes(explicitLanguage)) {
      const id = `slo-ai-${type}-${imdbId}-${explicitLanguage}`;
      const label = `Slovenian AI · ${sourceLangLabel[explicitLanguage]}`;
      return res.json({ subtitles: [{ id, url: buildUrl(explicitLanguage), lang: 'slv', label }] });
    }

    // Default: offer EN/HR/IT as separate, explicitly-picked options — none of them starts
    // translating until the person actually opens that specific one (handled in
    // /subtitle-file), so this costs exactly the same as translating one language, not
    // three, no matter how many are listed.
    // Stremio auto-selects the FIRST subtitle for whichever language is clicked, so this
    // harmless placeholder goes first — it prompts an explicit pick instead of silently and
    // automatically starting (and billing) a real translation the moment "Slovenian" is
    // clicked, before the person has actually chosen a source.
    const subtitles = [
      { id: `slo-ai-${type}-${imdbId}-choose`, url: buildUrl('choose'), lang: 'slv', label: '— Izberi vir spodaj (EN/HR/IT) —' },
      ...SUPPORTED_SOURCE_LANGUAGES.map(lang => ({
        id: `slo-ai-${type}-${imdbId}-${lang}`,
        url: buildUrl(lang),
        lang: 'slv',
        label: `Slovenian AI · ${sourceLangLabel[lang]}`
      }))
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
  translateWithGemini,
  combineForGemini,
  characterAnalysisPrompt,
  parseCharacterLedger,
  ledgerToText,
  analyzeCharacters,
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
  removeSdh,
  stripSdhFromLine,
  DEFAULT_LANGUAGE_PRIORITY,
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
  friendlyErrorMessage,
  statusNoticeSrt,
  buildCacheKey,
  parseExtraHash,
  CHARACTER_LEDGER_SCHEMA,
  TRANSLATION_SCHEMA,
  buildTranslationSchema,
  withOpenSubtitlesLimit,
  fetchOpenSubtitleForLanguage
};
