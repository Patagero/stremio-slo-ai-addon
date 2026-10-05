const express = require('express');
const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function secondsToTimecode(sec) {
  const totalMs = Math.round(sec * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

async function runLocalWhisperExtraction(streamUrl, startSec = 0, durationSec = 120, modelSize = 'small') {
  return new Promise((resolve) => {
    const pythonScript = path.join(__dirname, 'whisper-engine.py');
    const pyProc = spawn('python', [
      pythonScript,
      '--url', streamUrl,
      '--start', String(startSec),
      '--duration', String(durationSec),
      '--model', modelSize
    ]);

    let stdout = '';
    let stderr = '';
    pyProc.stdout.on('data', data => { stdout += data; });
    pyProc.stderr.on('data', data => { stderr += data; });

    pyProc.on('close', code => {
      if (code !== 0) {
        console.warn(`[whisper-local] failed with code ${code}: ${stderr}`);
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error || !Array.isArray(parsed.cues) || !parsed.cues.length) {
          console.warn(`[whisper-local] returned error or no cues: ${parsed.error || '0 cues'}`);
          return resolve(null);
        }
        const entries = parsed.cues.map((c, i) => ({
          id: String(i + 1),
          timecode: `${secondsToTimecode(c.start)} --> ${secondsToTimecode(c.end)}`,
          text: c.text
        }));
        return resolve(toSrt(entries));
      } catch (err) {
        console.warn(`[whisper-local] JSON parse error: ${err.message}`);
        return resolve(null);
      }
    });

    pyProc.on('error', err => {
      console.warn(`[whisper-local] spawn error: ${err.message}`);
      return resolve(null);
    });
  });
}

const PORT = Number(process.env.PORT || 7002);
const CHUNK_SIZE = Math.max(40, Math.min(50, Number(process.env.CHUNK_SIZE || 45)));
const TRANSLATION_CONCURRENCY = Math.max(1, Math.min(2, Number(process.env.TRANSLATION_CONCURRENCY || 1)));
const SUBTITLE_FILE_TIMEOUT_MS = Math.max(300000, Number(process.env.SUBTITLE_FILE_TIMEOUT_MS || 300000));
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '.cache');

// Sonnet 5.5 konfiguracija
const ANTHROPIC_API_KEY = String(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.OPENROUTER_API_KEY || '').trim();
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || ANTHROPIC_MODEL;
const providerConfig = { name: 'anthropic', model: ANTHROPIC_MODEL };

const CLAUDE_FALLBACK_MODELS = [
  ANTHROPIC_MODEL,
  'claude-sonnet-5-5',
  'claude-sonnet-5.5',
  'claude-3-5-sonnet-latest',
  'claude-3-7-sonnet-latest'
];

// Ciljna hitrost branja (characters per second). 17 CPS je standardni okvir za odrasle gledalce.
const TARGET_CPS = Number(process.env.TARGET_CPS || 17);
const MAX_LINE_CHARS = Number(process.env.MAX_LINE_CHARS || 42);
const MAX_LINES = 2;

// Podprti viri: Angleščina (EN), Hrvaščina (HR), Italijanščina (ITA) in Whisper prevod iz angleščine
const SUPPORTED_SOURCE_LANGUAGES = ['en', 'hr', 'it', 'whisper_en'];

const cache = new Map();
const inflight = new Map();
const completed = new Map();
const jobs = new Map();
const partials = new Map();

const addonManifest = {
  id: 'com.stremio.slo.ai.translator',
  version: '0.6.0',
  name: 'Slo AI Subtitle Translator (Sonnet 5.5 & Whisper)',
  description: 'Visokokakovostni slovenski podnapisi iz angleških, hrvaških in italijanskih podnapisov ter Whisper angleškega zvoka (Sonnet 5.5).',
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
      gender: c.gender
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

// ---------- OpenSubtitles & Whisper Source Resolution ----------

const DEFAULT_LANGUAGE_PRIORITY = ['en', 'hr', 'it'];

function resolveSourceLanguages(meta, requested, strict) {
  const req = String(requested || '').toLowerCase();
  if (strict && SUPPORTED_SOURCE_LANGUAGES.includes(req)) {
    return [req];
  }
  if (SUPPORTED_SOURCE_LANGUAGES.includes(req)) {
    const baseReq = req === 'whisper_en' ? 'en' : req;
    return [req, ...DEFAULT_LANGUAGE_PRIORITY.filter(lang => lang !== baseReq)];
  }
  return [...DEFAULT_LANGUAGE_PRIORITY];
}

let openSubtitlesToken = null;
let openSubtitlesLoginPromise = null;

async function openSubtitlesLogin() {
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;
  if (!username || !password) return null;
  if (openSubtitlesToken && openSubtitlesToken.expiresAt > Date.now()) return openSubtitlesToken.value;

  if (openSubtitlesLoginPromise) return openSubtitlesLoginPromise;

  openSubtitlesLoginPromise = (async () => {
    try {
      const response = await axios.post('https://api.opensubtitles.com/api/v1/login', { username, password }, {
        headers: {
          'Api-Key': process.env.OPENSUBTITLES_API_KEY,
          'User-Agent': process.env.OPENSUBTITLES_USER_AGENT || 'SloAIAddon v0.6.0',
          'Content-Type': 'application/json',
          Accept: '*/*'
        }
      });
      const token = response.data?.token;
      if (!token) return null;
      openSubtitlesToken = { value: token, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
      console.log('[opensubtitles] logged in, using authenticated (higher-quota) access');
      return token;
    } catch (error) {
      console.warn(`[opensubtitles] login failed, falling back to anonymous access: ${error.message}`);
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
    'User-Agent': process.env.OPENSUBTITLES_USER_AGENT || 'SloAIAddon v0.6.0',
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

async function fetchOpenSubtitleForLanguage(imdbId, language, videoHash, season, episode) {
  return withOpenSubtitlesLimit(() => fetchOpenSubtitleForLanguageUnqueued(imdbId, language, videoHash, season, episode));
}

async function fetchOpenSubtitleForLanguageUnqueued(imdbId, language, videoHash, season, episode) {
  const headers = await openSubtitlesHeaders();
  // Če je zahtevan whisper_en, iščemo angleške podnapise (en)
  const searchLang = language === 'whisper_en' ? 'en' : language;
  const baseParams = { imdb_id: String(imdbId).replace(/^tt/, ''), languages: searchLang, order_by: 'downloads', order_direction: 'desc' };
  if (season && episode) {
    baseParams.season_number = season;
    baseParams.episode_number = episode;
  }

  if (videoHash) {
    try {
      const hashSearch = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
        headers,
        params: { ...baseParams, moviehash: videoHash, moviehash_match: 'only' }
      });
      const hashResult = hashSearch.data.data?.[0];
      const hashFile = hashResult?.attributes?.files?.[0];
      const verifiedMatch = hashResult?.attributes?.moviehash_match !== false;
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

  const search = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', { headers, params: baseParams });
  const file = search.data.data?.[0]?.attributes?.files?.[0];
  if (!file?.file_id) return null;
  const download = await axios.post('https://api.opensubtitles.com/api/v1/download', { file_id: file.file_id }, { headers });
  if (!download.data.link) return null;
  const srt = (await axios.get(download.data.link)).data;
  return { srt, language, matchedByHash: false };
}

async function fetchOpenSubtitle(imdbId, meta, requestedLanguage, videoHash, strict, season, episode) {
  if (!process.env.OPENSUBTITLES_API_KEY) throw new Error('OPENSUBTITLES_API_KEY is not configured');
  const languages = resolveSourceLanguages(meta, requestedLanguage, strict);
  for (const language of languages) {
    try {
      const found = await fetchOpenSubtitleForLanguage(imdbId, language, videoHash, season, episode);
      if (found) return found;
    } catch (error) {
      console.warn(`[opensubtitles] ${imdbId} (${language}) failed: ${error.message}`);
    }
  }
  throw new Error(`No subtitle found in any of: ${languages.join(', ')}`);
}

// ---------- Claude (Anthropic Sonnet 3.5 / 3.7) Provider ----------

function buildClaudeRequest(systemText, userText, model = ANTHROPIC_MODEL, maxTokens = 4096) {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: {
      model,
      max_tokens: maxTokens,
      system: systemText,
      messages: [{ role: 'user', content: userText }]
    }
  };
}

function extractClaudeOutputText(data) {
  if (!data?.content || !Array.isArray(data.content)) return '';
  return data.content
    .filter(part => part?.type === 'text')
    .map(part => part.text || '')
    .join('');
}

async function translateWithClaude(systemText, userText, options = {}) {
  const apiKey = options.apiKey || ANTHROPIC_API_KEY;
  const fetchImpl = options.fetchImpl || fetch;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  // Prepoznaj OpenRouter ključ
  const isOpenRouter = apiKey.startsWith('sk-or-') || process.env.OPENROUTER_API_KEY;
  if (isOpenRouter) {
    const orModel = options.model || (process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet');
    const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: orModel,
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: userText }
        ]
      })
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenRouter HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    const data = await response.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  // Anthropic Messages API z verigo modelov ob 404
  const requestedModel = options.model || ANTHROPIC_MODEL;
  const modelsToTry = [requestedModel, ...CLAUDE_FALLBACK_MODELS.filter(m => m !== requestedModel)];
  let lastError = null;

  for (const currentModel of modelsToTry) {
    const request = buildClaudeRequest(systemText, userText, currentModel, options.maxTokens || 4096);
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(request.body)
    });

    if (response.ok) {
      const data = await response.json();
      return extractClaudeOutputText(data).trim();
    }

    const detail = await response.text();
    lastError = new Error(`Anthropic HTTP ${response.status}: ${detail.slice(0, 300)}`);
    // Če model ne obstaja (404), poskusi naslednjega v verigi
    if (response.status === 404 && detail.includes('not_found_error')) {
      console.warn(`[claude] model ${currentModel} returned 404, trying fallback model...`);
      continue;
    }
    throw lastError;
  }

  throw lastError || new Error('Anthropic request failed');
}

// Združljivostna alias funkcija za Anthropic/Claude
const translateWithAnthropic = translateWithClaude;
const buildAnthropicRequest = buildClaudeRequest;

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
  const dialogue = entries.map(e => e.text.replace(/\n/g, ' ')).join('\n');
  const tmdbContext = buildMetadataContext(meta);
  const systemText = characterAnalysisPrompt(tmdbContext);
  const userText = `Dialogue to analyze for character genders:\n${dialogue}\n\nReturn JSON only.`;
  try {
    const raw = await translateWithClaude(systemText, userText, { model: ANALYSIS_MODEL });
    return parseCharacterLedger(raw);
  } catch (error) {
    console.warn(`[character-analysis] failed, falling back to TMDB only: ${error.message}`);
    return [];
  }
}

// ---------- Pass 2: translation ----------

function systemPrompt(context) {
  return `You are an elite, professional subtitle translator and localizer specializing in English/Croatian/Italian to natural Slovenian translation (powered by Sonnet 5.5).

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
- Output ONLY valid JSON in the requested shape {"translations":[{"id":"...","text":"..."}]}. No markdown, no commentary, no explanations.`;
}

function buildTranslationUserText(sourceEntries) {
  const lines = sourceEntries.map(entry => {
    const duration = cueDurationSeconds(entry).toFixed(1);
    const budget = maxCharsForDuration(cueDurationSeconds(entry));
    return `[id=${entry.id} duration=${duration}s max_chars=${budget}] ${entry.text.replace(/\n/g, ' / ')}`;
  });
  return `Translate every source cue below into Slovenian. Return one entry per cue in the "translations" array, with "id" matching the source id exactly. Use "\\n" inside "text" only for a genuine second line. Never merge or omit entries.

Format: {"translations": [{"id": "1", "text": "Prevod..."}, ...]}

SOURCE CUES (duration and character budget shown for each; stay within budget where possible):
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
    let raw = String(value || '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : Array.isArray(data?.translations) ? data.translations : null;
    if (list) {
      const map = new Map();
      for (const item of list) {
        if (item?.id != null && typeof item.text === 'string' && item.text.trim()) map.set(String(item.id), item.text.trim());
      }
      if (map.size) return map;
    }
  } catch (_) {
    // Fall through to lenient extractor
  }
  const loose = extractTranslationPairsLoosely(value);
  return loose.size ? loose : null;
}

async function translateChunk(chunk, context) {
  const sourceEntries = chunk.entries || parseSrt(chunk.srt);
  const systemText = systemPrompt(context);
  const userText = buildTranslationUserText(sourceEntries);

  const response = await translateWithClaude(systemText, userText);
  let translated = parseTranslationJson(response);

  if (!translated || translated.size !== sourceEntries.length) {
    console.warn(`[translation] chunk ${chunk.index + 1} incomplete (${translated?.size || 0}/${sourceEntries.length}); repairing`);
    const repairUser = `${userText}\n\nREPAIR: your previous reply was missing or malformed entries. Return every source id exactly once in JSON {"translations":[{"id":"...","text":"..."}]}.`;
    const repaired = await translateWithClaude(systemText, repairUser);
    translated = parseTranslationJson(repaired) || translated || new Map();

    if (translated.size !== sourceEntries.length) {
      throw new Error(`chunk ${chunk.index + 1} still incomplete after repair (${translated.size}/${sourceEntries.length})`);
    }
  }

  let resultEntries = sourceEntries.map(entry => ({
    id: entry.id,
    timecode: entry.timecode,
    text: translated.get(String(entry.id)) || entry.text
  }));

  const tooFast = findTooFastCues(resultEntries);
  if (tooFast.length) {
    console.warn(`[translation] chunk ${chunk.index + 1}: ${tooFast.length} cue(s) over reading-speed budget, shortening`);
    const shortenNote = 'SHORTENING PASS: the cues below are too long for their on-screen duration. Rewrite ONLY these cues to fit within max_chars while preserving meaning and correct gender. Return the same JSON format {"translations":[{"id":"...","text":"..."}]}.';
    const shortenUserText = tooFast.map(c => `[id=${c.id} max_chars=${c.budget}] ${c.text.replace(/\n/g, ' / ')}`).join('\n');
    try {
      const shortenedRaw = await translateWithClaude(systemText, `${shortenNote}\n\n${shortenUserText}`);
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

// ---------- Orchestration ----------

function parseSeriesId(rawId) {
  const str = String(rawId || '');
  const match = str.match(/^(tt\d+):(\d+):(\d+)$/);
  if (match) return { imdbId: match[1], season: match[2], episode: match[3] };
  return { imdbId: str, season: null, episode: null };
}

function buildCacheKey(imdbId, sourceLanguage, videoHash, season, episode) {
  const episodePart = season && episode ? `:s${season}e${episode}` : '';
  const idPart = videoHash ? `${imdbId}${episodePart}:${videoHash}` : `${imdbId}${episodePart}`;
  return `${idPart}:${sourceLanguage || 'auto'}:slv:anthropic:${ANTHROPIC_MODEL}`;
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

async function translateSubtitle(imdbId, sourceLanguage, videoHash, strict, season, episode) {
  const key = buildCacheKey(imdbId, sourceLanguage, videoHash, season, episode);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.srt;
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const meta = await tmdbMetadata(`tt${String(imdbId).replace(/^tt/, '')}`);
    const { srt: rawSource, language: usedLanguage, matchedByHash } = await fetchOpenSubtitle(imdbId, meta, sourceLanguage, videoHash, strict, season, episode);

    if (!matchedByHash) {
      const genericKey = buildCacheKey(imdbId, usedLanguage, null, season, episode);
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
    console.log(`[translation] ${imdbId}: translating ${parseSrt(source).length} cues in ${chunks.length} chunk(s) of up to ${CHUNK_SIZE}, model=${ANTHROPIC_MODEL}`);

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
      partials.set(key, partial);
      throw new Error(`${partial.failedChunkIndices.size}/${chunks.length} chunk(s) could not be translated this run (will retry next visit)`);
    }

    const srt = partialToSrt(partial);
    const validated = reconcileTranslatedSrt(source, srt);
    parseAndValidateSrt(source, validated);

    cache.set(key, { srt: validated, expiresAt: Date.now() + CACHE_TTL_MS });
    saveCacheEntryToDisk(key, { srt: validated, expiresAt: Date.now() + CACHE_TTL_MS });
    if (!matchedByHash) {
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

// ---------- Disk-persisted cache ----------

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
      } catch (_) {
        // Corrupt cache file
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

// ---------- Resumable progress ----------

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
  } catch (_) {
    // cleanup
  }
}

function friendlyErrorMessage(raw) {
  const msg = String(raw || '');
  if (/credit|quota|resource_exhausted|insufficient_quota/i.test(msg)) return 'Zmanjkalo je AI kvote/kreditov. Preveri Anthropic Claude konzolo in poskusi znova.';
  if (/rate.?limit|429/i.test(msg)) return 'Trenutno preveč hkratnih zahtev do AI (rate limit). Poskusi znova čez nekaj minut.';
  if (/ANTHROPIC_API_KEY|CLAUDE_API_KEY/i.test(msg)) return 'Manjka ali je neveljaven Anthropic API ključ na strežniku.';
  if (/No subtitle found/i.test(msg)) return 'Za ta film ni bilo mogoče najti izvirnih podnapisov (ANG/HR/ITA/Whisper).';
  return msg || 'Translation failed';
}

function statusNoticeSrt(text) {
  return `0\n00:00:00,000 --> 00:00:04,000\n[Slo AI prevod] ${text}`;
}

const CHOOSE_PLACEHOLDER_SRT = '0\n00:00:00,000 --> 09:59:59,000\n[Slo AI prevod] To ni prevod. Izberi ANG, HR, ITA ali Whisper spodaj v seznamu.';

function buildPlaceholderSrt() {
  return statusNoticeSrt('Prevajanje se je začelo (Sonnet 5.5), prosim počakaj...');
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
    claudeConfigured: Boolean(ANTHROPIC_API_KEY),
    claudeModel: ANTHROPIC_MODEL,
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

  app.get('/configure', (_req, res) => res.type('html').send('<h1>Slo AI Subtitle Translator (Sonnet 5.5 & Whisper)</h1><p>Nastavi API ključe v Render Environment Variables (ANTHROPIC_API_KEY, TMDB_API_KEY, OPENSUBTITLES_API_KEY).</p>'));

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

  app.get('/subtitle-file/:imdbId/:lang.srt', (req, res) => {
    const { imdbId } = req.params;
    const lang = req.params.lang;
    const videoHash = req.query.hash ? String(req.query.hash) : null;
    const season = req.query.season ? String(req.query.season) : null;
    const episode = req.query.episode ? String(req.query.episode) : null;

    if (lang === 'choose') {
      return res.type('application/x-subrip; charset=utf-8').send(CHOOSE_PLACEHOLDER_SRT);
    }
    if (!SUPPORTED_SOURCE_LANGUAGES.includes(lang)) return res.sendStatus(404);

    const key = buildCacheKey(imdbId, lang, videoHash, season, episode);
    startTranslationJob(imdbId, key, lang, videoHash, true, season, episode);

    const finalEntry = cache.get(key);
    if (finalEntry && finalEntry.expiresAt > Date.now()) {
      return res.type('application/x-subrip; charset=utf-8').send(finalEntry.srt);
    }

    const partial = partials.get(key);
    if (partial) {
      const body = partialToSrt(partial);
      const done = partial.doneChunkIndices.size;
      let notice = null;
      if (done === 0) {
        notice = statusNoticeSrt('Prevajanje s Claude Sonnet se je začelo, prvi del bo kmalu na voljo...');
      } else if (done < partial.totalChunks) {
        notice = statusNoticeSrt(`Prvi del je preveden (${done}/${partial.totalChunks}), preostanek se prevaja v ozadju.`);
      }
      const combined = notice ? `${notice}\n\n${body}` : body;
      return res.type('application/x-subrip; charset=utf-8').send(combined);
    }

    const job = jobs.get(key);
    if (job?.status === 'failed') {
      return res.status(503).type('application/x-subrip; charset=utf-8').send(buildErrorSrt(job.error));
    }

    return res.type('application/x-subrip; charset=utf-8').send(buildPlaceholderSrt());
  });

  app.get(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\.json)?(?:\/([^/]+?))?$/, (req, res) => {
    console.log(`[subtitle] type=${req.params[0]} id=${req.params[1]} extra=${req.params[2] || ''}`);
    const type = req.params[0];
    const rawId = req.params[1].replace(/\.json$/i, '');
    const { imdbId, season, episode } = parseSeriesId(rawId);
    const explicitLanguage = req.query.sourceLanguage ? String(req.query.sourceLanguage).toLowerCase() : null;
    const videoHash = parseExtraHash(req.params[2]).videoHash;
    const root = baseUrl || `${req.protocol}://${req.get('host')}`;
    const sourceLangLabel = {
      hr: 'Prevod iz hrvaščine',
      it: 'Prevod iz italijanščine',
      en: 'Prevod iz angleščine',
      whisper_en: 'Whisper prevod'
    };
    const extraQuery = [
      videoHash ? `hash=${encodeURIComponent(videoHash)}` : null,
      season && episode ? `season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}` : null
    ].filter(Boolean).join('&');
    const queryString = extraQuery ? `?${extraQuery}` : '';

    const buildUrl = lang => `${root}/subtitle-file/${encodeURIComponent(imdbId)}/${lang}.srt${queryString}`;

    if (explicitLanguage && SUPPORTED_SOURCE_LANGUAGES.includes(explicitLanguage)) {
      const id = `slo-ai-${type}-${imdbId}-${explicitLanguage}`;
      const label = sourceLangLabel[explicitLanguage] || 'Slovenski prevod';
      return res.json({ subtitles: [{ id, url: buildUrl(explicitLanguage), lang: 'slv', label }] });
    }

    const subtitles = [
      { id: `slo-ai-${type}-${imdbId}-choose`, url: buildUrl('choose'), lang: 'slv', label: '— Izberi vir (Hrvaščina / Italijanščina / Angleščina / Whisper) —' },
      ...SUPPORTED_SOURCE_LANGUAGES.map(lang => ({
        id: `slo-ai-${type}-${imdbId}-${lang}`,
        url: buildUrl(lang),
        lang: 'slv',
        label: sourceLangLabel[lang] || 'Slovenski prevod'
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
  ANTHROPIC_MODEL,
  providerConfig,
  buildClaudeRequest,
  buildAnthropicRequest,
  translateWithClaude,
  translateWithAnthropic,
  extractClaudeOutputText,
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
  SUPPORTED_SOURCE_LANGUAGES,
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
  parseSeriesId,
  parseExtraHash,
  CHARACTER_LEDGER_SCHEMA,
  TRANSLATION_SCHEMA,
  buildTranslationSchema,
  withOpenSubtitlesLimit,
  fetchOpenSubtitleForLanguage,
  runLocalWhisperExtraction,
  secondsToTimecode
};