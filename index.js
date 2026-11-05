const express = require('express');
const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');

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
const CHUNK_SIZE = Math.max(100, Math.min(350, Number(process.env.CHUNK_SIZE || 220)));
const TRANSLATION_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.TRANSLATION_CONCURRENCY || 2)));
const SUBTITLE_FILE_TIMEOUT_MS = Math.max(300000, Number(process.env.SUBTITLE_FILE_TIMEOUT_MS || 300000));
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '.cache');

// Google Gemini Flash konfiguracija
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || GEMINI_MODEL;
const providerConfig = { name: 'gemini', model: GEMINI_MODEL };

const GEMINI_FALLBACK_MODELS = [
  GEMINI_MODEL,
  'gemini-2.5-flash',
  'gemini-3.7-flash',
  'gemini-2.0-flash',
  'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
];

const TARGET_CPS = Number(process.env.TARGET_CPS || 17);
const MAX_LINE_CHARS = Number(process.env.MAX_LINE_CHARS || 42);
const MAX_LINES = 2;

const DEFAULT_LANGUAGE_PRIORITY = ['hr', 'it', 'en'];
const SUPPORTED_SOURCE_LANGUAGES = ['hr', 'it', 'en'];

const cache = new Map();
const inflight = new Map();
const completed = new Map();
const jobs = new Map();
const partials = new Map();

const addonManifest = {
  id: 'com.stremio.slo.ai.translator',
  version: '0.7.5',
  name: 'Slo AI Subtitle Translator (Gemini Flash)',
  description: 'Izjemno hitri in varčni slovenski podnapisi z Gemini Flash: ročna izbira vira, SDH čiščenje in robustno parsanje.',
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

function reconcileTranslatedSrt(source, candidate) {
  const original = parseSrt(source);
  const translated = parseSrt(candidate);
  if (!original.length) throw new Error('Invalid source SRT');
  const byId = new Map(translated.map(entry => [String(entry.id), entry]));
  const repaired = original.map(entry => {
    const found = byId.get(String(entry.id));
    let text = found?.text?.trim() || entry.text;
    text = text.replace(/\[(?:Govorec|Govorita|Speaker)[^\]]*\]/gi, '').replace(/\s{2,}/g, ' ').trim();
    if (text.length > MAX_LINE_CHARS && !text.includes('\n')) {
      text = splitIntoTwoLines(text);
    }
    return { id: entry.id, timecode: entry.timecode, text };
  });
  return toSrt(repaired);
}

// ---------- SDH čiščenje ----------

const SDH_BRACKET_RE = /\[[^\]\n]*\]/g;
const SDH_PAREN_RE = /\((?:laughter|giggle|gasp|sobbing|crying|music|sigh|groan|screaming|whisper|cough|applause|cheering|chuckle|snicker)[^)\n]*\)/gi;
const SDH_ASTERISK_RE = /\*[^*]*\*/g;
const SDH_MUSIC_NOTE_RE = /[♪♫][^♪♫\n]*[♪♫]?/g;
const SDH_SPEAKER_LABEL_RE = /^[-\s]*[A-ZČŠŽĐĆ0-9 .'-]{2,30}:\s*/;

function extractSpeakerFromRawText(rawText) {
  const m = String(rawText || '').match(/^[-\s]*([A-ZČŠŽĐĆa-z0-9 .'-]{2,25}):\s*/);
  if (m) return m[1].trim();
  const bm = String(rawText || '').match(/^\[([A-ZČŠŽĐĆa-z0-9 .'-]{2,25})\]\s*/);
  if (bm) return bm[1].trim();
  return null;
}

function detectGenderFromDialogue(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(rekla|bila|vidjela|vidila|htjela|mogla|srećna|sretna|spremna|sama|sigurna|zadovoljna|znala|mislila|osjetila|došla|otišla|morala)\s+(sam|sam bila|bih)\b/i.test(t)) return 'Ženska';
  if (/\b(rekao|bio|vidio|htio|mogao|srećan|sretan|spreman|sam|siguran|zadovoljan|znao|mislio|osjetio|došao|otišao|morao)\s+(sam|sam bio|bih)\b/i.test(t)) return 'Moški';
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
    let detectedSpeaker = null;
    let detectedGender = null;

    for (const line of rawLines) {
      if (!detectedSpeaker) detectedSpeaker = extractSpeakerFromRawText(line);
      if (!detectedGender) detectedGender = detectGenderFromDialogue(line);
    }

    if (detectedSpeaker && characterMap && characterMap.has(detectedSpeaker.toLowerCase())) {
      const g = characterMap.get(detectedSpeaker.toLowerCase());
      if (g) detectedGender = g;
    }

    const cleanedLines = rawLines.map(stripSdhFromLine).filter(Boolean);
    if (!cleanedLines.length) continue;

    const genderTag = detectedGender ? `[Govorec: ${detectedGender}]` : '';

    entries.push({
      ...entry,
      id: String(index++),
      text: cleanedLines.join('\n'),
      genderTag
    });
  }

  return entries;
}

function removeSdh(srtText, characterMap = new Map()) {
  const entries = removeSdhEntries(srtText, characterMap);
  return toSrt(entries);
}

// ---------- Prevajanje in Parsanje (Popravljeno) ----------

function buildGeminiRequest(systemText, userText, model = GEMINI_MODEL) {
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    body: {
      contents: [{ role: 'user', parts: [{ text: `${systemText}\n\n---\n\n${userText}` }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2
      }
    }
  };
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
  const modelsToTry = [requestedModel, ...GEMINI_FALLBACK_MODELS.filter(m => m !== requestedModel)];
  let lastError = null;

  for (const currentModel of modelsToTry) {
    const request = buildGeminiRequest(systemText, userText, currentModel);
    const urlWithKey = `${request.url}?key=${apiKey}`;
    const response = await fetchImpl(urlWithKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body)
    });

    if (response.ok) {
      const data = await response.json();
      return extractGeminiOutputText(data).trim();
    }

    const detail = await response.text();
    lastError = new Error(`Gemini HTTP ${response.status}: ${detail.slice(0, 300)}`);
    if (response.status === 404 || response.status === 400) continue;
    throw lastError;
  }
  throw lastError || new Error('Gemini translation request failed');
}

// Optimiziran sistemski prompt za zanesljiv JSON
function systemPrompt(context) {
  return `You are an elite, professional film subtitle translator. Your task is to translate movie subtitles into natural Slovenian while strictly adhering to JSON output constraints.

CONTEXT:
${context}

CRITICAL RULES FOR JSON OUTPUT:
1. STRICT JSON FORMAT: Return ONLY a valid JSON object. No markdown formatting blocks around it if possible, no introductory text, no explanations.
2. EXACT STRUCTURE: The JSON must follow this exact schema:
   {"translations": [{"id": "1", "text": "Prevedeno besedilo\\nDruga vrstica"}, {"id": "2", "text": "..."}]}
3. PRESERVE ALL IDS: You MUST include every single requested ID. Never skip or omit any cue ID.
4. PROPER ESCAPING: Escape all double quotes inside subtitle texts using \\" and use \\n strictly for line breaks.
5. GENDER & STYLE: Respect gender tags [Govorec: Ženska/Moški]. Never include these technical tags in the final text.
`;
}

function buildTranslationUserText(sourceEntries) {
  const lines = sourceEntries.map(entry => {
    const duration = ((timecodeToSeconds(entry.timecode.split(' --> ')[1]) - timecodeToSeconds(entry.timecode.split(' --> ')[0]))).toFixed(1);
    const tag = entry.genderTag ? `${entry.genderTag} ` : '';
    return `[id=${entry.id} duration=${duration}s] ${tag}${entry.text.replace(/\n/g, ' / ')}`;
  });
  return `Prevedi vsak cue v naravno slovenščino (max 2 vrstici, upoštevaj spolne oznake [Govorec: ...]).
V izhodu NE vključuj tehničnih oznak, samo čist slovenski dialog.
Return JSON: {"translations": [{"id": "...", "text": "..."}]}

SOURCE CUES:
${lines.join('\n')}`;
}

function timecodeToSeconds(hms) {
  const m = String(hms || '').trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!m) return 0;
  const [, hh, mm, ss, ms] = m;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
}

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

// Robustna funkcija za parsanje JSON-a z varnim fallbackom
function parseTranslationJson(value, expectedEntries = []) {
  let map = new Map();
  
  try {
    let cleaned = String(value || '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      cleaned = cleaned.slice(start, end + 1);
    }
    
    const parsed = JSON.parse(cleaned);
    const list = parsed.translations || parsed;
    
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && item.id != null && item.text != null) {
          map.set(String(item.id), String(item.text));
        }
      }
    }
  } catch (_) {
    map = extractTranslationPairsLoosely(value);
  }

  // Če kateri ID manjka, ga zapolnimo z izvirnim besedilom, da chunk nikoli ne pade na 0
  if (Array.isArray(expectedEntries) && expectedEntries.length > 0) {
    for (const entry of expectedEntries) {
      if (!map.has(String(entry.id))) {
        map.set(String(entry.id), entry.text);
      }
    }
  }

  return map;
}

console.log('Slo AI Subtitle Translator skripta je pripravljena.');