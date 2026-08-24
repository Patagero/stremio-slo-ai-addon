const express = require('express');
const axios = require('axios');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { default: SrtParser } = require('srt-parser-2');
const srtParser = new SrtParser();

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

const ANTHROPIC_API_KEY = String(process.env.ANTHROPIC_API_KEY || '').trim();
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const providerConfig = { name: 'anthropic', model: ANTHROPIC_MODEL };

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
const subtitleFiles = new Map();
// Progressive translation state: jobKey -> { entryMap, order, totalChunks, doneChunks }
// Lets us serve "chunk 1 already done, rest still in the source language" instead of
// making the player wait for the whole film to finish translating.
const partials = new Map();

const addonManifest = {
  id: 'com.stremio.slo.ai.translator',
  version: '0.5.0',
  name: 'Slo AI Subtitle Translator',
  description: 'High-quality English, Croatian and Italian to Slovenian subtitles with two-pass, gender-aware AI translation (Claude).',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: false }
};

// ---------- SRT parsing / building helpers ----------

function parseSrt(srt) {
  return srtParser.fromSrt(String(srt || '').replace(/\r/g, '')).map((entry, index) => ({
    id: String(entry.id ?? index + 1),
    timecode: `${entry.startTime} --> ${entry.endTime}`,
    text: String(entry.text || '').trim()
  }));
}

function toSrt(entries) {
  return srtParser.toSrt(entries.map(e => ({
    id: e.id,
    startTime: e.timecode.split(' --> ')[0],
    endTime: e.timecode.split(' --> ')[1],
    text: e.text
  })));
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

// Fiksna prioriteta iskanja izvornih podnapisov: hrvaščina, nato italijanščina, šele nato
// angleščina (angleščina je najpogosteje na voljo, a je zadnja izbira po uporabnikovi želji).
const DEFAULT_LANGUAGE_PRIORITY = ['hr', 'it', 'en'];

function resolveSourceLanguages(meta, requested) {
  const req = String(requested || '').toLowerCase();
  if (SUPPORTED_SOURCE_LANGUAGES.includes(req)) {
    return [req, ...DEFAULT_LANGUAGE_PRIORITY.filter(lang => lang !== req)];
  }
  return [...DEFAULT_LANGUAGE_PRIORITY];
}

// Anonymous Api-Key access on OpenSubtitles has a very low daily quota. Logging in with a
// real account (even a free one) gets a JWT token that unlocks a much higher daily quota,
// so we log in once and reuse the token for every search/download call.
let openSubtitlesToken = null; // { value, expiresAt }

async function openSubtitlesLogin() {
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;
  if (!username || !password) return null;
  if (openSubtitlesToken && openSubtitlesToken.expiresAt > Date.now()) return openSubtitlesToken.value;
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
  }
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

async function fetchOpenSubtitleForLanguage(imdbId, language) {
  const headers = await openSubtitlesHeaders();
  const search = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
    headers,
    params: { imdb_id: String(imdbId).replace(/^tt/, ''), languages: language, order_by: 'downloads', order_direction: 'desc' }
  });
  const file = search.data.data?.[0]?.attributes?.files?.[0];
  if (!file?.file_id) return null;
  const download = await axios.post('https://api.opensubtitles.com/api/v1/download', { file_id: file.file_id }, { headers });
  if (!download.data.link) return null;
  const srt = (await axios.get(download.data.link)).data;
  return { srt, language };
}

async function fetchOpenSubtitle(imdbId, meta, requestedLanguage) {
  if (!process.env.OPENSUBTITLES_API_KEY) throw new Error('OPENSUBTITLES_API_KEY is not configured');
  const languages = resolveSourceLanguages(meta, requestedLanguage);
  for (const language of languages) {
    try {
      const found = await fetchOpenSubtitleForLanguage(imdbId, language);
      if (found) return found;
    } catch (error) {
      console.warn(`[opensubtitles] ${imdbId} (${language}) failed: ${error.message}`);
    }
  }
  throw new Error(`No subtitle found in any of: ${languages.join(', ')}`);
}

// ---------- Claude (Anthropic) provider ----------

function buildClaudeRequest(system, userText, model = ANTHROPIC_MODEL, maxTokens = 8192) {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    body: {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userText }]
    }
  };
}

async function translateWithClaude(system, userText, options = {}) {
  const apiKey = options.apiKey || ANTHROPIC_API_KEY;
  const model = options.model || ANTHROPIC_MODEL;
  const maxTokens = options.maxTokens || 8192;
  const fetchImpl = options.fetchImpl || fetch;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const request = buildClaudeRequest(system, userText, model, maxTokens);
  const response = await fetchImpl(request.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(request.body)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Claude HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }
  const data = await response.json();
  return (data.content || [])
    .map(block => block.text || '')
    .join('')
    .replace(/^```(?:json|srt|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
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

async function analyzeCharacters(sourceSrt, meta) {
  const entries = parseSrt(sourceSrt);
  // Plain dialogue lines are enough for this pass and keep the request compact; timestamps
  // and IDs add no value for gender inference.
  const dialogue = entries.map(e => e.text.replace(/\n/g, ' ')).join('\n');
  const tmdbContext = buildMetadataContext(meta);
  try {
    const raw = await translateWithClaude(characterAnalysisPrompt(tmdbContext), dialogue, { maxTokens: 3000 });
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
  return `Return ONLY a JSON array with exactly one object per source cue: [{"id":"<source id>","text":"Slovenian translation"}]. Use "\\n" inside "text" only if you need a genuine second line. Never merge or omit entries.

SOURCE CUES (duration and character budget shown for each; stay within budget where possible):
${lines.join('\n')}`;
}

function parseTranslationJson(value) {
  try {
    let cleaned = String(value || '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
    const data = JSON.parse(cleaned);
    if (!Array.isArray(data)) return null;
    const map = new Map();
    for (const item of data) {
      if (item?.id != null && typeof item.text === 'string' && item.text.trim()) map.set(String(item.id), item.text.trim());
    }
    return map;
  } catch (_) {
    return null;
  }
}

async function translateChunk(chunk, context) {
  const sourceEntries = chunk.entries || parseSrt(chunk.srt);
  const system = systemPrompt(context);
  const userText = buildTranslationUserText(sourceEntries);
  const response = await translateWithClaude(system, userText, { maxTokens: Math.min(8192, sourceEntries.length * 120 + 500) });
  let translated = parseTranslationJson(response);

  if (!translated || translated.size !== sourceEntries.length) {
    console.warn(`[translation] chunk ${chunk.index + 1} incomplete (${translated?.size || 0}/${sourceEntries.length}); repairing`);
    const repaired = await translateWithClaude(`${system}\n\nREPAIR: your previous reply was missing or malformed entries. Return every source id exactly once.`, userText, { maxTokens: Math.min(8192, sourceEntries.length * 120 + 500) });
    translated = parseTranslationJson(repaired) || translated || new Map();
  }

  let resultEntries = sourceEntries.map(entry => ({
    id: entry.id,
    timecode: entry.timecode,
    text: translated.get(String(entry.id)) || entry.text
  }));

  // Reading-speed repair pass: ask Claude to shorten only the cues that are over budget.
  const tooFast = findTooFastCues(resultEntries);
  if (tooFast.length) {
    console.warn(`[translation] chunk ${chunk.index + 1}: ${tooFast.length} cue(s) over reading-speed budget, shortening`);
    const shortenPrompt = `${system}\n\nSHORTENING PASS: the cues below are too long for their on-screen duration. Rewrite ONLY these cues to fit within max_chars while preserving meaning and correct gender. Return the same JSON array format as before, one object per listed id.`;
    const shortenUserText = tooFast.map(c => `[id=${c.id} max_chars=${c.budget}] ${c.text.replace(/\n/g, ' / ')}`).join('\n');
    try {
      const shortenedRaw = await translateWithClaude(shortenPrompt, shortenUserText, { maxTokens: Math.min(4096, tooFast.length * 150 + 300) });
      const shortenedMap = parseTranslationJson(shortenedRaw);
      if (shortenedMap) {
        resultEntries = resultEntries.map(entry => shortenedMap.has(String(entry.id)) ? { ...entry, text: shortenedMap.get(String(entry.id)) } : entry);
      }
    } catch (error) {
      console.warn(`[translation] shortening pass failed, keeping original lengths: ${error.message}`);
    }
  }

  return toSrt(resultEntries);
}

// ---------- Orchestration ----------

async function translateSubtitle(imdbId, sourceLanguage) {
  const key = `${imdbId}:${sourceLanguage || 'auto'}:slv:anthropic:${ANTHROPIC_MODEL}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.srt;
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const meta = await tmdbMetadata(`tt${String(imdbId).replace(/^tt/, '')}`);
    const { srt: rawSource, language: usedLanguage } = await fetchOpenSubtitle(imdbId, meta, sourceLanguage);
    const source = removeSdh(rawSource);
    console.log(`[translation] ${imdbId}: source language=${usedLanguage}, cues after SDH cleanup=${parseSrt(source).length}/${parseSrt(rawSource).length}`);

    const characters = await analyzeCharacters(source, meta);
    const context = `${buildMetadataContext(meta)}\n\nCHARACTER LEDGER (from dialogue analysis):\n${ledgerToText(characters)}`;

    const chunks = chunkSrt(source, CHUNK_SIZE);
    console.log(`[translation] ${imdbId}: translating ${parseSrt(source).length} cues in ${chunks.length} chunk(s) of up to ${CHUNK_SIZE}, model=${ANTHROPIC_MODEL}`);

    const partial = createPartialTracker(parseSrt(source), chunks.length);
    partials.set(key, partial);

    await runWithConcurrency(chunks, TRANSLATION_CONCURRENCY, async chunk => {
      const chunkSrtResult = await translateChunk(chunk, context);
      mergeChunkIntoPartial(partial, chunkSrtResult);
      console.log(`[translation] ${imdbId}: chunk ${chunk.index + 1}/${chunks.length} done (${partial.doneChunks}/${chunks.length} total)`);
      return chunkSrtResult;
    });

    const srt = partialToSrt(partial);
    const validated = reconcileTranslatedSrt(source, srt);
    parseAndValidateSrt(source, validated);

    cache.set(key, { srt: validated, expiresAt: Date.now() + CACHE_TTL_MS });
    saveCacheEntryToDisk(key, { srt: validated, expiresAt: Date.now() + CACHE_TTL_MS });
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
    doneChunks: 0
  };
}

function mergeChunkIntoPartial(partial, chunkSrtText) {
  const entries = parseSrt(chunkSrtText);
  for (const entry of entries) partial.entryMap.set(entry.id, { timecode: entry.timecode, text: entry.text });
  partial.doneChunks += 1;
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

function buildPlaceholderSrt() {
  return '1\n00:00:00,000 --> 00:00:08,000\nSlovenian AI subtitles are generating... Please reload subtitles shortly.';
}

function buildErrorSrt(message) {
  const safe = String(message || 'Translation failed').replace(/[\r\n]+/g, ' ').slice(0, 180);
  return `1\n00:00:00,000 --> 00:00:08,000\nSlovenian AI translation unavailable: ${safe}`;
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
    anthropicConfigured: Boolean(ANTHROPIC_API_KEY),
    anthropicModel: ANTHROPIC_MODEL,
    chunkSize: CHUNK_SIZE,
    concurrency: TRANSLATION_CONCURRENCY,
    fileTimeoutMs: SUBTITLE_FILE_TIMEOUT_MS,
    targetCps: TARGET_CPS,
    tmdbConfigured: Boolean(process.env.TMDB_API_KEY),
    openSubtitlesConfigured: Boolean(process.env.OPENSUBTITLES_API_KEY),
    openSubtitlesLoginConfigured: Boolean(process.env.OPENSUBTITLES_USERNAME && process.env.OPENSUBTITLES_PASSWORD),
    cacheDir: CACHE_DIR
  }));

  app.get('/configure', (_req, res) => res.type('html').send('<h1>Slo AI Subtitle Translator</h1><p>Configure API keys in Render environment variables (ANTHROPIC_API_KEY, TMDB_API_KEY, OPENSUBTITLES_API_KEY).</p>'));

  app.get('/subtitle-file/:token.srt', (req, res) => {
    const file = subtitleFiles.get(req.params.token);
    if (!file) return res.sendStatus(404);

    // 1) Fully translated and cached — best case.
    const finalEntry = cache.get(file.jobKey);
    if (finalEntry && finalEntry.expiresAt > Date.now()) {
      file.status = 'ready';
      file.srt = finalEntry.srt;
      return res.type('application/x-subrip; charset=utf-8').send(finalEntry.srt);
    }

    // 2) Translation in progress — serve whatever chunks are done so far so the player
    //    never has to wait for the whole file. Cues not yet translated stay in the
    //    source language until a later request picks up the finished version.
    const partial = partials.get(file.jobKey);
    if (partial) {
      return res.type('application/x-subrip; charset=utf-8').send(partialToSrt(partial));
    }

    // 3) Job failed before any chunk finished.
    const job = jobs.get(file.jobKey);
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
    const sourceLanguage = req.query.sourceLanguage ? String(req.query.sourceLanguage).toLowerCase() : null;
    const key = `${imdbId}:${sourceLanguage || 'auto'}:slv:anthropic:${ANTHROPIC_MODEL}`;
    const root = baseUrl || `${req.protocol}://${req.get('host')}`;

    const publish = (srt, label = 'Slovenian AI', status = 'ready') => {
      const token = crypto.randomUUID();
      subtitleFiles.set(token, { status, jobKey: key, srt });
      setTimeout(() => subtitleFiles.delete(token), CACHE_TTL_MS).unref?.();
      return { id: `slo-ai-${type}-${imdbId}`, url: `${root}/subtitle-file/${token}.srt`, lang: 'slv', label };
    };

    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return res.json({ subtitles: [publish(cached.srt)] });

    if (!jobs.has(key)) {
      jobs.set(key, { status: 'processing', startedAt: Date.now(), error: null });
      Promise.resolve()
        .then(() => translateSubtitle(imdbId, sourceLanguage))
        .then(() => { completed.set(key, { status: 'completed', finishedAt: Date.now() }); })
        .catch(error => {
          const job = jobs.get(key);
          if (job) { job.error = error.message; job.status = 'failed'; }
          console.error(`[translation] ${error.message}`);
        });
    }
    return res.json({ subtitles: [publish(buildPlaceholderSrt(), 'Slovenian AI (processing — reload shortly)', 'waiting')] });
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
  ANTHROPIC_MODEL,
  providerConfig,
  buildClaudeRequest,
  translateWithClaude,
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
  partialToSrt,
  removeSdh,
  stripSdhFromLine,
  DEFAULT_LANGUAGE_PRIORITY,
  cacheFilePath,
  loadCacheFromDisk,
  saveCacheEntryToDisk,
  CACHE_DIR,
  openSubtitlesLogin,
  openSubtitlesHeaders
};
