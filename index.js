const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { addonBuilder } = require('stremio-addon-sdk');
const { default: SrtParser } = require('srt-parser-2');
const srtParser = new SrtParser();

const PORT = Number(process.env.PORT || 7002);
const CHUNK_SIZE = 45;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const cache = new Map();
const inflight = new Map();
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
async function translateChunk(chunk, context, previous = '') { if (!anthropic) throw new Error('ANTHROPIC_API_KEY is not configured'); const message = await anthropic.messages.create({ model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20240620', max_tokens: 8192, temperature: 0.1, system: systemPrompt(`${context}\nPrevious translated context:\n${previous || 'None'}`), messages: [{ role: 'user', content: `Translate this SRT chunk. Preserve every number and timestamp exactly.\n\n${chunk.srt}` }] }); return message.content.map(x => x.text || '').join('').replace(/^```(?:srt|text)?\s*/i, '').replace(/\s*```$/i, '').trim(); }
async function translateSubtitle(imdbId, sourceLanguage) { const key = `${imdbId}:${sourceLanguage}:slv:${process.env.ANTHROPIC_MODEL || 'default'}`; const cached = cache.get(key); if (cached && cached.expiresAt > Date.now()) return cached.srt; if (inflight.has(key)) return inflight.get(key); const job = (async () => { const [source, meta] = await Promise.all([fetchOpenSubtitle(imdbId, sourceLanguage), tmdbMetadata(`tt${String(imdbId).replace(/^tt/, '')}`)]); const context = buildMetadataContext(meta); const translated = []; let previous = ''; for (const chunk of chunkSrt(source)) { const result = parseAndValidateSrt(chunk.srt, await translateChunk(chunk, context, previous)); translated.push(...result); previous = result.slice(-3).map(e => e.text).join('\n'); } const srt = toSrt(parseAndValidateSrt(source, toSrt(translated))); cache.set(key, { srt, expiresAt: Date.now() + CACHE_TTL_MS }); return srt; })(); inflight.set(key, job); try { return await job; } finally { inflight.delete(key); } }
function manifest() { return addonManifest; }
function createApp() {
  const app = express();
  const baseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const subtitleFiles = new Map();
  app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Methods', 'GET,OPTIONS'); res.set('Access-Control-Allow-Headers', 'Content-Type'); if (req.method === 'OPTIONS') return res.sendStatus(204); console.log(`[request] ${req.method} ${req.originalUrl}`); return next(); });
  app.use(express.json({ limit: '1mb' }));
  app.get('/manifest.json', (_req, res) => res.json(manifest()));
  app.get('/manifest', (_req, res) => res.json(manifest()));
  app.get('/health', (_req, res) => res.json({ status: 'healthy', cacheEntries: cache.size, anthropicConfigured: Boolean(anthropic), tmdbConfigured: Boolean(process.env.TMDB_API_KEY), openSubtitlesConfigured: Boolean(process.env.OPENSUBTITLES_API_KEY) }));
  app.get('/configure', (_req, res) => res.type('html').send('<h1>Slo AI Subtitle Translator</h1><p>Configure API keys in Render environment variables.</p>'));
  app.get('/subtitle-file/:token.srt', (req, res) => { const srt = subtitleFiles.get(req.params.token); if (!srt) return res.sendStatus(404); return res.type('application/x-subrip; charset=utf-8').send(srt); });
  app.get(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\.json)?(?:\/([^/]+?))?$/, async (req, res) => {
    try {
      const type = req.params[0];
      const rawId = req.params[1];
      const imdbId = rawId.replace(/\.json$/i, '');
      const sourceLanguage = String(req.query.sourceLanguage || 'en').toLowerCase();
      const srt = await translateSubtitle(imdbId, sourceLanguage);
      const token = crypto.randomUUID();
      subtitleFiles.set(token, srt);
      setTimeout(() => subtitleFiles.delete(token), CACHE_TTL_MS).unref?.();
      const root = baseUrl || `${req.protocol}://${req.get('host')}`;
      return res.json({ subtitles: [{ id: `slo-ai-${type}-${imdbId}`, url: `${root}/subtitle-file/${token}.srt`, lang: 'slv', label: 'Slovenian AI' }] });
    } catch (error) {
      console.error(`[translation] ${error.message}`);
      return res.json({ subtitles: [], error: error.message });
    }
  });
  return app;
}
if (require.main === module) createApp().listen(PORT, '0.0.0.0', () => console.log(`Slo AI addon listening on ${PORT}`));
module.exports = { chunkSrt, parseAndValidateSrt, buildMetadataContext, manifest, createApp, systemPrompt };
