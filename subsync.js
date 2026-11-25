'use strict';

// Samodejna sinhronizacija podnapisov na referenčno časovnico.
//
// Pristop je enak kot pri predvajalnikih s "subtitle auto-sync": ne posluša zvoka
// in ne primerja besedila, ampak primerja SAMO ČASE (kdaj se podnapis začne in
// konča). Zato je referenca lahko v kateremkoli jeziku - npr. angleški podnapis,
// ki se na OpenSubtitles ujema s hashem videa, je dober "metronom" za hrvaški vir.
//
// Model: t_ref = scale * t_src + offset
//   - offset: fiksen zamik (npr. drugačen uvod/logotip)
//   - scale:  drugačna hitrost (23,976 <-> 25 fps, 24 <-> 25, NTSC 1,001)

const MAX_OFFSET_MS = 180000;      // iščemo zamike do ±3 min
const HISTOGRAM_BIN_MS = 250;
const MATCH_TOLERANCE_MS = 1250;   // kako daleč sta lahko začetka, da štejeta za isti stavek
const FINE_TOLERANCE_MS = 600;
const DISTINCT_OFFSET_MS = 3000;
const MAX_SEEDS = 12;
const MIN_SCALE = 0.94;
const MAX_SCALE = 1.06;
const ACTIVITY_BIN_MS = 100;
const MAX_CUE_MS = 20000;

// Znane razlike v hitrosti: 25/23.976, 23.976/25, 25/24, 24/25, NTSC 1.001
const SCALE_CANDIDATES = [1, 25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25, 1.001, 1 / 1.001];

const DEFAULT_THRESHOLDS = {
  minScore: 0.5,         // delež ujemajočih se začetkov (glede na krajši podnapis)
  minMatches: 15,
  minMargin: 0.05,       // za koliko mora biti najboljša rešitev boljša od druge najboljše
  minActivity: 0.55,     // prekrivanje "kdaj je na zaslonu podnapis"
  requiredSegments: 3    // ujemanje mora obstajati v vseh treh tretjinah filma
};

const TIMING_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function toMs(h, m, s, ms) {
  return Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + Number(String(ms).padEnd(3, '0'));
}

function msToTimecode(totalMs) {
  const ms = Math.max(0, Math.round(totalMs));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rest).padStart(3, '0')}`;
}

// Iz SRT besedila izlušči časovnico [{ start, end }] v ms, urejeno po začetku.
// Cue-je brez besedila in "obvestila" na začetku (id 0) izpustimo.
function extractCues(srt) {
  const text = String(srt || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timingIndex = lines.findIndex(line => TIMING_RE.test(line));
    if (timingIndex < 0) continue;
    if (timingIndex > 0 && lines[0].trim() === '0') continue;
    const body = lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!body) continue;
    const m = lines[timingIndex].match(TIMING_RE);
    const start = toMs(m[1], m[2], m[3], m[4]);
    const end = toMs(m[5], m[6], m[7], m[8]);
    if (!(end > start)) continue;
    cues.push({ start, end: Math.min(end, start + MAX_CUE_MS) });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Za vsak referenčni začetek poišče najbližji (zamaknjen) začetek vira; ujemanja so monotona.
function matchStarts(refStarts, srcStarts, offsetMs, tolerance = MATCH_TOLERANCE_MS) {
  const matches = [];
  let minIndex = 0;
  for (const r of refStarts) {
    const expected = r - offsetMs;
    let best = -1;
    let bestResidual = Infinity;
    for (let i = Math.max(lowerBound(srcStarts, expected - tolerance), minIndex); i < srcStarts.length && srcStarts[i] <= expected + tolerance; i++) {
      const residual = Math.abs(srcStarts[i] + offsetMs - r);
      if (residual < bestResidual) {
        bestResidual = residual;
        best = i;
      }
    }
    if (best >= 0) {
      matches.push({ ref: r, src: srcStarts[best], index: best });
      minIndex = best + 1;
    }
  }
  return matches;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function segmentsCovered(matches, refStarts) {
  if (!matches.length || refStarts.length < 2) return 0;
  const first = refStarts[0];
  const span = Math.max(1, refStarts[refStarts.length - 1] - first);
  const seen = new Set();
  for (const m of matches) seen.add(Math.min(2, Math.max(0, Math.floor(((m.ref - first) * 3) / (span + 1)))));
  return seen.size;
}

function evaluateOffset(refStarts, srcStarts, seedOffset) {
  const first = matchStarts(refStarts, srcStarts, seedOffset);
  if (!first.length) return { offset: seedOffset, matches: 0, score: 0, segments: 0 };
  const refined = Math.round(median(first.map(m => m.ref - m.src)));
  const second = matchStarts(refStarts, srcStarts, refined);
  return {
    offset: refined,
    matches: second.length,
    score: second.length / Math.min(refStarts.length, srcStarts.length),
    segments: segmentsCovered(second, refStarts)
  };
}

// Histogram razlik med vsemi bližnjimi pari začetkov -> kandidati za zamik.
function findBestOffset(refStarts, srcStarts) {
  const histogram = new Map();
  for (const r of refStarts) {
    for (let i = lowerBound(srcStarts, r - MAX_OFFSET_MS); i < srcStarts.length && srcStarts[i] <= r + MAX_OFFSET_MS; i++) {
      const bin = Math.round((r - srcStarts[i]) / HISTOGRAM_BIN_MS);
      histogram.set(bin, (histogram.get(bin) || 0) + 1);
    }
  }
  const seeds = [];
  for (const [bin] of [...histogram.entries()].sort((a, b) => b[1] - a[1])) {
    const offset = bin * HISTOGRAM_BIN_MS;
    if (seeds.every(seed => Math.abs(seed - offset) >= DISTINCT_OFFSET_MS)) seeds.push(offset);
    if (seeds.length >= MAX_SEEDS) break;
  }
  const candidates = seeds.map(seed => evaluateOffset(refStarts, srcStarts, seed)).sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return null;
  const runnerUp = candidates.find(c => Math.abs(c.offset - best.offset) >= DISTINCT_OFFSET_MS);
  return { ...best, margin: best.score - (runnerUp ? runnerUp.score : 0) };
}

// Linearna regresija t_ref = a * t_src + b na ujemajočih se parih.
function fitLine(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  let sx = 0; let sy = 0;
  for (const p of pairs) { sx += p.src; sy += p.ref; }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0; let sxy = 0;
  for (const p of pairs) {
    sxx += (p.src - mx) * (p.src - mx);
    sxy += (p.src - mx) * (p.ref - my);
  }
  if (sxx <= 0) return null;
  const scale = sxy / sxx;
  return { scale, offset: my - scale * mx };
}

function activityBins(cues, scale, offset) {
  let maxEnd = 0;
  const spans = cues.map(c => {
    const start = Math.max(0, c.start * scale + offset);
    const end = Math.max(start + 1, c.end * scale + offset);
    maxEnd = Math.max(maxEnd, end);
    return [start, end];
  });
  const bins = new Uint8Array(Math.ceil((maxEnd + 1) / ACTIVITY_BIN_MS) + 1);
  for (const [start, end] of spans) {
    const lastBin = Math.min(bins.length, Math.ceil(end / ACTIVITY_BIN_MS));
    for (let i = Math.floor(start / ACTIVITY_BIN_MS); i < lastBin; i++) bins[i] = 1;
  }
  return bins;
}

// Koliko se "kdaj je na zaslonu podnapis" ujema po transformaciji (0..1).
function activityScore(refCues, srcCues, scale, offset) {
  const ref = activityBins(refCues, 1, 0);
  const src = activityBins(srcCues, scale, offset);
  let first = -1; let last = -1; let srcActive = 0; let intersection = 0;
  for (let i = 0; i < src.length; i++) {
    if (!src[i]) continue;
    if (first < 0) first = i;
    last = i;
    srcActive++;
    if (i < ref.length && ref[i]) intersection++;
  }
  if (!srcActive) return 0;
  let refActive = 0;
  for (let i = Math.max(0, first); i <= Math.min(last, ref.length - 1); i++) if (ref[i]) refActive++;
  const precision = intersection / srcActive;
  const recall = refActive ? intersection / refActive : 0;
  return 0.72 * precision + 0.28 * recall;
}

/**
 * Izračuna, kako je treba premakniti/raztegniti `sourceSrt`, da se ujema z `referenceSrt`.
 * Vrne { ok, inSync, scale, offsetMs, score, matches, margin, segments, activity, reason }.
 */
function computeSync(referenceSrt, sourceSrt, thresholds = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const refCues = extractCues(referenceSrt);
  const srcCues = extractCues(sourceSrt);
  if (refCues.length < limits.minMatches || srcCues.length < limits.minMatches) {
    return { ok: false, reason: `premalo podnapisov za primerjavo (referenca ${refCues.length}, vir ${srcCues.length})` };
  }
  const refStarts = refCues.map(c => c.start);
  const srcStartsRaw = srcCues.map(c => c.start);

  const scales = [...SCALE_CANDIDATES];
  const refSpan = refStarts[refStarts.length - 1] - refStarts[0];
  const srcSpan = srcStartsRaw[srcStartsRaw.length - 1] - srcStartsRaw[0];
  if (refSpan > 0 && srcSpan > 0) scales.push(refSpan / srcSpan);

  let best = null;
  for (const scale of scales) {
    if (!(scale >= MIN_SCALE && scale <= MAX_SCALE)) continue;
    const scaled = srcStartsRaw.map(t => t * scale);
    const found = findBestOffset(refStarts, scaled);
    if (!found) continue;
    // Majhna prednost za "brez spremembe hitrosti", da je ob enakem rezultatu ne spreminjamo po nepotrebnem.
    const rank = found.score + (scale === 1 ? 0.01 : 0);
    if (!best || rank > best.rank) best = { ...found, scale, rank };
  }
  if (!best) return { ok: false, reason: 'ni bilo mogoče najti ujemanja' };

  // Natančna nastavitev: regresija na ujemajočih se parih, nato še enkrat z ožjo toleranco.
  let scale = best.scale;
  let offset = best.offset;
  for (let round = 0; round < 2; round++) {
    const tolerance = round === 0 ? MATCH_TOLERANCE_MS : FINE_TOLERANCE_MS;
    const scaled = srcStartsRaw.map(t => t * scale);
    const pairs = matchStarts(refStarts, scaled, offset, tolerance).map(m => ({ ref: m.ref, src: srcStartsRaw[m.index] }));
    const line = fitLine(pairs);
    if (!line || !(line.scale >= MIN_SCALE && line.scale <= MAX_SCALE)) break;
    scale = line.scale;
    offset = line.offset;
  }

  const finalScaled = srcStartsRaw.map(t => t * scale);
  const finalMatches = matchStarts(refStarts, finalScaled, offset);
  const matches = finalMatches.length;
  const score = matches / Math.min(refStarts.length, srcStartsRaw.length);
  const segments = segmentsCovered(finalMatches, refStarts);
  const activity = activityScore(refCues, srcCues, scale, offset);
  const margin = best.margin;

  const problems = [];
  if (matches < limits.minMatches) problems.push(`premalo ujemanj (${matches})`);
  if (score < limits.minScore) problems.push(`nizko ujemanje (${score.toFixed(2)})`);
  if (segments < limits.requiredSegments) problems.push(`ujemanje le v ${segments}/3 delih filma`);
  if (margin < limits.minMargin) problems.push(`negotova rešitev (razlika ${margin.toFixed(2)})`);
  if (activity < limits.minActivity) problems.push(`slabo prekrivanje (${activity.toFixed(2)})`);

  const roundedScale = Math.abs(scale - 1) < 0.0003 ? 1 : scale;
  const offsetMs = Math.round(offset);
  // "Že usklajeno": pri dolžini 2 h pomeni 0,0003 največ ~2 s razlike na koncu, kar regresija že pokrije.
  const inSync = roundedScale === 1 && Math.abs(offsetMs) < 200;

  return {
    ok: problems.length === 0,
    inSync,
    scale: roundedScale,
    offsetMs,
    score,
    matches,
    margin,
    segments,
    activity,
    reason: problems.join(', ') || null
  };
}

// Uporabi transformacijo t' = scale * t + offset na vse časovne žige SRT besedila.
function applySync(srt, scale = 1, offsetMs = 0) {
  if (scale === 1 && Math.abs(offsetMs) < 1) return srt;
  return String(srt || '').replace(new RegExp(TIMING_RE.source, 'g'), (_all, h1, m1, s1, ms1, h2, m2, s2, ms2) => {
    const start = Math.max(0, toMs(h1, m1, s1, ms1) * scale + offsetMs);
    const end = Math.max(start + 300, toMs(h2, m2, s2, ms2) * scale + offsetMs);
    return `${msToTimecode(start)} --> ${msToTimecode(end)}`;
  });
}

function describeSync(result) {
  if (!result) return 'brez reference';
  if (!result.ok) return `ni potrjeno (${result.reason})`;
  if (result.inSync) return `že usklajeno (ujemanje ${(result.score * 100).toFixed(0)} %)`;
  const parts = [];
  if (result.offsetMs) parts.push(`zamik ${(result.offsetMs / 1000).toFixed(2)} s`);
  if (result.scale !== 1) parts.push(`hitrost ×${result.scale.toFixed(5)}`);
  return `${parts.join(', ')} (ujemanje ${(result.score * 100).toFixed(0)} %)`;
}

module.exports = {
  extractCues,
  computeSync,
  applySync,
  describeSync,
  activityScore,
  msToTimecode,
  DEFAULT_THRESHOLDS,
  SCALE_CANDIDATES
};
