const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { addonBuilder } = require('stremio-addon-sdk');
const { default: SrtParser } = require('srt-parser-2');
const srtParser = new SrtParser();

const PORT = Number(process.env.PORT || 7002);
const CHUNK_SIZE = Math.max(80, Math.min(100, Number(process.env.CHUNK_SIZE || 90)));
const TRANSLATION_CONCURRENCY = Math.max(3, Math.min(4, Number(process.env.TRANSLATION_CONCURRENCY || 3)));
const SUBTITLE_FILE_TIMEOUT_MS = Math.max(300000, Number(process.env.SUBTITLE_FILE_TIMEOUT_MS || 300000));
const FAST_TRANSLATION = process.env.FAST_TRANSLATION !== 'false';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const configuredAnthropicModel = String(process.env.ANTHROPIC_MODEL || '').trim();
const RETIRED_ANTHROPIC_MODELS = new Set(['claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-latest', 'claude-sonnet-4-20250514']);
const ANTHROPIC_MODEL = configuredAnthropicModel && !RETIRED_ANTHROPIC_MODELS.has(configuredAnthropicModel) ? configuredAnthropicModel : '';
let resolvedAnthropicModel = ANTHROPIC_MODEL;
const ANTHROPIC_API_VERSION = process.env.ANTHROPIC_API_VERSION || '2023-06-01';
const ANTHROPIC_BETA_MODEL = process.env.ANTHROPIC_BETA_MODEL || '';
const cache = new Map();
const inflight = new Map();
const completed = new Map();
const jobs = new Map();
const subtitleFiles = new Map();
function buildPlaceholderSrt() { return '1\n00:00:00,000 --> 00:00:08,000\nSlovenian AI subtitles are generating... Please reload subtitles shortly.'; }
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const addonManifest = { id: 'com.stremio.slo.ai.translator', version: '0.2.1', name: 'Slo AI Subtitle Translator', description: 'English, Croatian and Italian subtitles translated to Slovenian with TMDB context and gender-aware review.', resources: ['subtitles'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [], behaviorHints: { configurable: true, configurationRequired: false } };

function parseSrt(srt) {
  return srtParser.fromSrt(String(srt || '').replace(/\r/g, '')).map((entry, index) => ({ id: String(entry.id ?? index + 1), timecode: `${entry.startTime} --> ${entry.endTime}`, text: String(entry.text || '').trim() }));
}
function toSrt(entries) { return srtParser.toSrt(entries.map(e => ({ id: e.id, startTime: e.timecode.split(' --> ')[0], endTime: e.timecode.split(' --> ')[1], text: e.text }))); }
function chunkSrt(srt, chunkSize = CHUNK_SIZE) { const entries = parseSrt(srt); const chunks = []; for (let i = 0; i < entries.length; i += chunkSize) chunks.push({ index: chunks.length, entries: entries.slice(i, i + chunkSize), srt: toSrt(entries.slice(i, i + chunkSize)) }); return chunks; }
function parseAndValidateSrt(source, translated) { const original = parseSrt(source); const result = parseSrt(translated); if (!original.length || original.length !== result.length) throw new Error(`Invalid translated SRT entry count: ${result.length}/${original.length}`); for (let i = 0; i < original.length; i += 1) if (original[i].id !== result[i].id || original[i].timecode !== result[i].timecode || !result[i].text) throw new Error(`Invalid SRT structure at cue ${i + 1}`); return result; }
function buildMetadataContext(meta = {}) { const gender = { 1: 'Female', 2: 'Male' }; const characters = (meta.credits || []).map(c => `${c.name}: ${gender[c.gender] || 'Unknown'}`).join('\n') || 'No character gender metadata available.'; return `Movie Title: ${meta.title || 'Unknown'}\nPlot Summary: ${meta.overview || 'Not provided'}\nCharacters & Genders:\n${characters}`; }
function systemPrompt(context) { return `You are a professional subtitle translator from English, Croatian, and Italian to natural Slovenian.\n\nCONTEXT FOR THIS TITLE:\n${context}\n\nSTRICT TRANSLATION RULES:\n1. GENDER ACCURACY: Deduce who is speaking from dialogue flow, stable character metadata and previous context. Never infer gender from voice alone. Distinguish speaker gender from addressee gender. Apply Slovenian forms: female "bila sem", "šla sem", "rekla sem", "vesela sem"; male "bil sem", "šel sem", "rekel sem", "vesel sem". Correct second-person forms: "si videla/videl", "si pripravljena/pripravljen". If evidence is insufficient, do not invent a gendered fact; use natural wording that avoids unsupported gender.\n2. FORMAT INTEGRITY: Keep all SRT timing tags, line numbers, cue order, cue count, formatting and intentional line breaks EXACTLY intact. Never merge, split, omit, reorder or renumber cues.\n3. STYLE: Use natural conversational Slovenian, preserve register, relationships, humour, idioms, names and terminology consistently. Keep text concise for its display duration.\n4. OUTPUT: Output ONLY the translated SRT text. No introductions, markdown wrappers or comments.`; }
async function tmdbMetadata(imdbId) { if (!process.env.TMDB_API_KEY) return { title: imdbId, overview: 'Not provided', credits: [] }; const base = 'https://api.themoviedb.org/3'; const find = await axios.get(`${base}/find/${encodeURIComponent(imdbId)}`, { params: { api_key: process.env.TMDB_API_KEY, language: 'en-US', external_source: 'imdb_id' } }); const item = find.data.movie_results?.[0] || find.data.tv_results?.[0]; if (!item) return { title: imdbId, overview: 'Not provided', credits: [] }; const type = find.data.movie_results?.length ? 'movie' : 'tv'; const details = await axios.get(`${base}/${type}/${item.id}`, { params: { api_key: process.env.TMDB_API_KEY, language: 'en-US', append_to_response: 'credits' } }); return { title: details.data.title || details.data.name || imdbId, overview: details.data.overview || 'Not provided', credits: (details.data.credits?.cast || []).slice(0, 20).map(c => ({ name: c.character ? `${c.character} (${c.name})` : c.name, gender: c.gender })) }; }
async function fetchOpenSubtitle(imdbId, language) { if (!process.env.OPENSUBTITLES_API_KEY) throw new Error('OPENSUBTITLES_API_KEY is not configured'); const headers = { 'Api-Key': process.env.OPENSUBTITLES_API_KEY, 'User-Agent': process.env.OPENSUBTITLES_USER_AGENT || 'SloAIAddon v0.2.1', Accept: 'application/json' }; const search = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', { headers, params: { imdb_id: String(imdbId).replace(/^tt/, ''), languages: language, order_by: 'downloads', order_direction: 'desc' } }); const file = search.data.data?.[0]?.attributes?.files?.[0]; if (!file?.file_id) throw new Error(`No ${language} subtitle found`); const download = await axios.post('https://api.opensubtitles.com/api/v1/download', { file_id: file.file_id }, { headers }); return (await axios.get(download.data.link)).data; }
function selectAnthropicModel(models = []) { const ids = models.map(model => String(model.id || model.name || '')).filter(Boolean); const preferred = FAST_TRANSLATION ? [/claude-haiku-4/i, /claude-3-5-haiku/i, /claude-sonnet-4/i, /claude-3-7-sonnet/i, /claude-3-5-sonnet/i, /claude-sonnet/i] : [/claude-sonnet-4/i, /claude-3-7-sonnet/i, /claude-3-5-sonnet/i, /claude-sonnet/i, /claude-haiku-4/i, /claude-3-5-haiku/i]; for (const pattern of preferred) { const match = ids.find(id => pattern.test(id)); if (match) return match; } return ids[0] || null; }
async function resolveAnthropicModel() { if (resolvedAnthropicModel) return resolvedAnthropicModel; if (!anthropic) throw new Error('ANTHROPIC_API_KEY is not configured'); const result = await anthropic.models.list({ limit: 100 }); resolvedAnthropicModel = selectAnthropicModel(result.data || []); if (!resolvedAnthropicModel) throw new Error('Anthropic account exposes no usable models'); console.log(`[anthropic] selected model ${resolvedAnthropicModel}`); return resolvedAnthropicModel; }
async function translateChunk(chunk, context, previous = '') { if (!anthropic) throw new Error('ANTHROPIC_API_KEY is not configured'); const message = await anthropic.messages.create({ model: await resolveAnthropicModel(), max_tokens: 8192, temperature: 0.1, system: systemPrompt(`${context}\nPrevious translated context:\n${previous || 'None'}`), messages: [{ role: 'user', content: `Translate this SRT chunk. Preserve every number and timestamp exactly.\n\n${chunk.srt}` }] }); return message.content.map(x => x.text || '').join('').replace(/^```(?:srt|text)?\s*/i, '').replace(/\s*```$/i, '').trim(); }
async function translateSubtitle(imdbId, sourceLanguage) { const key = `${imdbId}:${sourceLanguage}:slv:${ANTHROPIC_MODEL || 'auto'}`; const cached = cache.get(key); if (cached && cached.expiresAt > Date.now()) return cached.srt; if (inflight.has(key)) return inflight.get(key); const job = (async () => { const [source, meta] = await Promise.all([fetchOpenSubtitle(imdbId, sourceLanguage), tmdbMetadata(`tt${String(imdbId).replace(/^tt/, '')}`)]); const context = buildMetadataContext(meta); const chunks = chunkSrt(source); console.log(`[translation] ${imdbId}: ${chunks.length} chunks, concurrency=${TRANSLATION_CONCURRENCY}`); const translatedChunks = await runWithConcurrency(chunks, TRANSLATION_CONCURRENCY, async (chunk, index) => { const result = parseAndValidateSrt(chunk.srt, await translateChunk(chunk, context, '')); console.log(`[translation] ${imdbId}: chunk ${index + 1}/${chunks.length} complete`); return result; }); const translated = translatedChunks.flat(); const srt = toSrt(parseAndValidateSrt(source, toSrt(translated))); cache.set(key, { srt, expiresAt: Date.now() + CACHE_TTL_MS }); console.log(`[translation] ${imdbId}: completed ${translated.length} cues`); return srt; })(); inflight.set(key, job); try { return await job; } finally { inflight.delete(key); } }
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
function buildPlaceholderSrt() {
  return '1\n00:00:00,000 --> 00:00:08,000\nSlovenian AI subtitles are generating... Please reload subtitles shortly.';
}
function buildErrorSrt(message) {
  const safe = String(message || 'Translation failed').replace(/[\r\n]+/g, ' ').slice(0, 180);
  return `1\n00:00:00,000 --> 00:00:08,000\nSlovenian AI translation unavailable: ${safe}`;
}
function createSubtitleFileWaiter({ cache: cacheStore, jobs: jobsStore, pollMs = 1000, timeoutMs = 120000 } = {}) {
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
function createApp() {
  const app = express();
  const baseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Methods', 'GET,OPTIONS'); res.set('Access-Control-Allow-Headers', 'Content-Type'); if (req.method === 'OPTIONS') return res.sendStatus(204); console.log(`[request] ${req.method} ${req.originalUrl}`); return next(); });
  app.use(express.json({ limit: '1mb' }));
  app.get('/manifest.json', (_req, res) => res.json(manifest()));
  app.get('/manifest', (_req, res) => res.json(manifest()));
  app.get('/health', (_req, res) => res.json({ status: 'healthy', cacheEntries: cache.size, processingJobs: jobs.size, completedJobs: completed.size, anthropicConfigured: Boolean(anthropic), anthropicModel: resolvedAnthropicModel || 'auto-detect', fastTranslation: FAST_TRANSLATION, chunkSize: CHUNK_SIZE, concurrency: TRANSLATION_CONCURRENCY, fileTimeoutMs: SUBTITLE_FILE_TIMEOUT_MS, tmdbConfigured: Boolean(process.env.TMDB_API_KEY), openSubtitlesConfigured: Boolean(process.env.OPENSUBTITLES_API_KEY) }));
  app.get('/configure', (_req, res) => res.type('html').send('<h1>Slo AI Subtitle Translator</h1><p>Configure API keys in Render environment variables.</p>'));
  app.get('/subtitle-file/:token.srt', async (req, res) => {
    const file = subtitleFiles.get(req.params.token);
    if (!file) return res.sendStatus(404);
    if (file.status === 'ready') return res.type('application/x-subrip; charset=utf-8').send(file.srt);
    try {
      const srt = await createSubtitleFileWaiter({ cache, jobs, pollMs: 500, timeoutMs: SUBTITLE_FILE_TIMEOUT_MS })(file.jobKey);
      file.status = 'ready'; file.srt = srt;
      return res.type('application/x-subrip; charset=utf-8').send(srt);
    } catch (error) {
      console.error(`[translation-file] ${error.message}`);
      return res.status(503).type('application/x-subrip; charset=utf-8').send(buildErrorSrt(error.message));
    }
  });
  app.get(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\.json)?(?:\/([^/]+?))?$/, (req, res) => {
    console.log(`[subtitle] type=${req.params[0]} id=${req.params[1]} extra=${req.params[2] || ''}`);
    const type = req.params[0];
    const rawId = req.params[1];
    const imdbId = rawId.replace(/\.json$/i, '');
    const sourceLanguage = String(req.query.sourceLanguage || 'en').toLowerCase();
    const key = `${imdbId}:${sourceLanguage}:slv:${ANTHROPIC_MODEL || 'auto'}`;
    const root = baseUrl || `${req.protocol}://${req.get('host')}`;
    const publish = (srt, label = 'Slovenian AI', status = 'ready') => {
      const token = crypto.randomUUID();
      subtitleFiles.set(token, { status, jobKey: key, srt });
      setTimeout(() => subtitleFiles.delete(token), CACHE_TTL_MS).unref?.();
      return { id: `slo-ai-${type}-${imdbId}`, url: `${root}/subtitle-file/${token}.srt`, lang: 'slv', label };
    };
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ subtitles: [publish(cached.srt)] });
    }
    if (!jobs.has(key)) {
      jobs.set(key, { status: 'processing', startedAt: Date.now(), error: null });
      Promise.resolve().then(() => translateSubtitle(imdbId, sourceLanguage))
        .then(srt => { completed.set(key, { status: 'completed', finishedAt: Date.now() }); })
        .catch(error => { jobs.get(key).error = error.message; jobs.get(key).status = 'failed'; console.error(`[translation] ${error.message}`); })
        .finally(() => { const job = jobs.get(key); if (job?.status === 'processing') job.status = 'completed'; });
    }
    return res.json({ subtitles: [publish(buildPlaceholderSrt(), 'Slovenian AI (processing — reload shortly)', 'waiting')] });
  });
  app.get('/jobs/:jobKey', (req, res) => { const key = decodeURIComponent(req.params.jobKey); return res.json(jobs.get(key) || completed.get(key) || { status: 'unknown' }); });
  return app;
}
if (require.main === module) createApp().listen(PORT, '0.0.0.0', () => console.log(`Slo AI addon listening on ${PORT}`));
module.exports = { chunkSrt, parseAndValidateSrt, buildMetadataContext, manifest, createApp, systemPrompt, selectAnthropicModel, buildPlaceholderSrt, buildErrorSrt, createSubtitleFileWaiter, runWithConcurrency, CHUNK_SIZE, TRANSLATION_CONCURRENCY, SUBTITLE_FILE_TIMEOUT_MS };
