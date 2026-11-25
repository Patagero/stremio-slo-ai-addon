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

function activityBins(cues, mapTime) {
  let maxEnd = 0;
  const spans = cues.map(c => {
    const start = Math.max(0, mapTime(c.start, c.start));
    const end = Math.max(start + 1, mapTime(c.end, c.start));
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
// `scaleOrMap` je lahko število (z `offset`) ali funkcija (t, začetekCueja) -> t'.
function activityScore(refCues, srcCues, scaleOrMap, offset = 0) {
  const mapTime = typeof scaleOrMap === 'function' ? scaleOrMap : t => t * scaleOrMap + offset;
  const ref = activityBins(refCues, t => t);
  const src = activityBins(srcCues, mapTime);
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


// ---------- Sinhronizacija po odsekih ----------
//
// Dve izdaji se pogosto ne razlikujeta le za en zamik: drugačen uvod sredi filma,
// izrezan/dodan prizor ali TV premori za oglase pomenijo, da ima vsak del filma svoj
// zamik. En sam linearni popravek takrat uskladi le del filma. Zato (kot alass)
// z dinamičnim programiranjem poiščemo zaporedje zamikov po referenčni časovnici:
// vsak cue "plača" razdaljo do najbližjega začetka vira, vsaka sprememba zamika
// pa fiksno kazen, tako da odsek nastane le, kadar ga podpira dovolj stavkov.

const PIECE_BIN_MS = 100;
const PIECE_SWITCH_PENALTY = 9;     // koliko "slabih" cue-jev odtehta en rez
const PIECE_MIN_MATCHES = 12;       // vsak odsek mora imeti vsaj toliko ujemanj
const PIECE_MIN_DURATION_MS = 90000;
const PIECE_MERGE_MS = 400;         // bližnja zamika združimo v en odsek
const MAX_PIECES = 8;

function evaluateMapping(refCues, srcCues, refStarts, mapStart, mapTime) {
  const mapped = srcCues.map(c => mapStart(c.start)).sort((a, b) => a - b);
  const matches = matchStarts(refStarts, mapped, 0);
  return {
    matches: matches.length,
    score: matches.length / Math.min(refStarts.length, srcCues.length),
    segments: segmentsCovered(matches, refStarts),
    activity: activityScore(refCues, srcCues, mapTime)
  };
}

// Vrne [{ srcFrom, offset }] (urejeno po srcFrom; prvi ima srcFrom = -Infinity) ali null.
function findPieces(refStarts, srcScaled, centerOffset) {
  const n = refStarts.length;
  if (n < PIECE_MIN_MATCHES * 2) return null;
  const halfBins = Math.round(MAX_OFFSET_MS / PIECE_BIN_MS);
  const bins = halfBins * 2 + 1;
  const base = Math.round(centerOffset / PIECE_BIN_MS) - halfBins; // offset(b) = (base + b) * BIN
  const tolBins = Math.ceil(MATCH_TOLERANCE_MS / PIECE_BIN_MS);
  const cost = new Float32Array(bins);
  let dp = new Float32Array(bins);
  let next = new Float32Array(bins);
  const switched = new Uint8Array(n * bins);
  const switchFrom = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    const r = refStarts[i];
    cost.fill(1);
    const lo = (base) * PIECE_BIN_MS;
    const hi = (base + bins - 1) * PIECE_BIN_MS;
    for (let j = lowerBound(srcScaled, r - hi - MATCH_TOLERANCE_MS); j < srcScaled.length && srcScaled[j] <= r - lo + MATCH_TOLERANCE_MS; j++) {
      const exact = (r - srcScaled[j]) / PIECE_BIN_MS - base;
      const from = Math.max(0, Math.ceil(exact - tolBins));
      const to = Math.min(bins - 1, Math.floor(exact + tolBins));
      for (let b = from; b <= to; b++) {
        const c = Math.abs(b - exact) * PIECE_BIN_MS / MATCH_TOLERANCE_MS;
        if (c < cost[b]) cost[b] = c;
      }
    }
    if (i === 0) {
      for (let b = 0; b < bins; b++) dp[b] = cost[b];
      continue;
    }
    let bestPrev = 0;
    for (let b = 1; b < bins; b++) if (dp[b] < dp[bestPrev]) bestPrev = b;
    switchFrom[i] = bestPrev;
    const switchCost = dp[bestPrev] + PIECE_SWITCH_PENALTY;
    const row = i * bins;
    for (let b = 0; b < bins; b++) {
      if (switchCost < dp[b]) { next[b] = switchCost + cost[b]; switched[row + b] = 1; } else next[b] = dp[b] + cost[b];
    }
    [dp, next] = [next, dp];
  }

  let b = 0;
  for (let k = 1; k < bins; k++) if (dp[k] < dp[b]) b = k;
  const path = new Int32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    path[i] = b;
    if (i > 0 && switched[i * bins + b]) b = switchFrom[i];
  }

  // Odseki v referenčni časovnici, z natančnim zamikom (mediana ostankov ujemanj).
  let pieces = [];
  for (let i = 0; i < n; i++) {
    const offset = (base + path[i]) * PIECE_BIN_MS;
    const last = pieces[pieces.length - 1];
    if (last && last.binOffset === offset) last.to = i; else pieces.push({ binOffset: offset, from: i, to: i });
  }
  const refine = piece => {
    const starts = refStarts.slice(piece.from, piece.to + 1);
    const matches = matchStarts(starts, srcScaled, piece.binOffset, FINE_TOLERANCE_MS);
    piece.matches = matches;
    piece.offset = matches.length ? median(matches.map(m => m.ref - m.src)) : piece.binOffset;
    return piece;
  };
  pieces.forEach(refine);

  // Prekratke odseke in skoraj enake sosede združimo.
  for (let changed = true; changed && pieces.length > 1;) {
    changed = false;
    let weakest = -1;
    for (let k = 0; k < pieces.length; k++) {
      const p = pieces[k];
      const duration = refStarts[p.to] - refStarts[p.from];
      const neighbourClose = (k > 0 && Math.abs(pieces[k - 1].offset - p.offset) < PIECE_MERGE_MS)
        || (k + 1 < pieces.length && Math.abs(pieces[k + 1].offset - p.offset) < PIECE_MERGE_MS);
      if (p.matches.length < PIECE_MIN_MATCHES || duration < PIECE_MIN_DURATION_MS || neighbourClose) {
        if (weakest < 0 || p.matches.length < pieces[weakest].matches.length) weakest = k;
      }
    }
    if (weakest < 0) break;
    const p = pieces[weakest];
    const prev = pieces[weakest - 1];
    const nxt = pieces[weakest + 1];
    const target = !prev ? nxt : !nxt ? prev
      : (Math.abs(prev.offset - p.offset) <= Math.abs(nxt.offset - p.offset) ? prev : nxt);
    target.from = Math.min(target.from, p.from);
    target.to = Math.max(target.to, p.to);
    target.binOffset = target.offset;
    pieces.splice(weakest, 1);
    refine(target);
    changed = true;
  }
  if (pieces.length < 2 || pieces.length > MAX_PIECES) return null;

  // Meje v časovnici vira: sredina med zadnjim ujemanjem enega in prvim ujemanjem naslednjega odseka.
  const result = [{ srcFrom: -Infinity, offset: pieces[0].offset }];
  for (let k = 1; k < pieces.length; k++) {
    const prevMatches = pieces[k - 1].matches;
    const curMatches = pieces[k].matches;
    if (!prevMatches.length || !curMatches.length) return null;
    const a = prevMatches[prevMatches.length - 1].src;
    const c = curMatches[0].src;
    if (!(c > a)) return null; // odseka se v viru prekrivata - ni smiselna rešitev
    result.push({ srcFrom: (a + c) / 2, offset: pieces[k].offset });
  }
  return result;
}

function pieceOffsetAt(pieces, scaledTime) {
  let offset = pieces[0].offset;
  for (const p of pieces) if (scaledTime >= p.srcFrom) offset = p.offset; else break;
  return offset;
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
  let matches = finalMatches.length;
  let score = matches / Math.min(refStarts.length, srcStartsRaw.length);
  let segments = segmentsCovered(finalMatches, refStarts);
  let activity = activityScore(refCues, srcCues, scale, offset);
  let margin = best.margin;
  let pieces = null;

  // Ali ima film več odsekov z različnimi zamiki? Pri tem uporabimo hitrost iz
  // kandidatov (regresija čez rez bi hitrost popačila).
  if (limits.piecewise !== false) {
    const pieceScale = best.scale;
    const scaledSorted = srcStartsRaw.map(t => t * pieceScale);
    const found = findPieces(refStarts, scaledSorted, best.offset);
    if (found) {
      const mapStart = t => t * pieceScale + pieceOffsetAt(found, t * pieceScale);
      const mapTime = (t, cueStart) => t * pieceScale + pieceOffsetAt(found, cueStart * pieceScale);
      const evaluated = evaluateMapping(refCues, srcCues, refStarts, mapStart, mapTime);
      // Odseke sprejmemo le, če opazno izboljšajo ujemanje in ne pokvarijo prekrivanja.
      if (evaluated.score >= score + 0.04 && evaluated.activity >= activity - 0.02) {
        pieces = found.map(p => ({ srcFrom: Number.isFinite(p.srcFrom) ? Math.round(p.srcFrom / pieceScale) : null, offsetMs: Math.round(p.offset) }));
        scale = pieceScale;
        offset = found[0].offset;
        ({ matches, score, segments, activity } = evaluated);
        // Dvoumnost med dvema zamikoma je zdaj razložena z rezom.
        margin = Math.max(margin, limits.minMargin);
      }
    }
  }

  const problems = [];
  if (matches < limits.minMatches) problems.push(`premalo ujemanj (${matches})`);
  if (score < limits.minScore) problems.push(`nizko ujemanje (${score.toFixed(2)})`);
  if (segments < limits.requiredSegments) problems.push(`ujemanje le v ${segments}/3 delih filma`);
  if (margin < limits.minMargin) problems.push(`negotova rešitev (razlika ${margin.toFixed(2)})`);
  if (activity < limits.minActivity) problems.push(`slabo prekrivanje (${activity.toFixed(2)})`);

  const roundedScale = Math.abs(scale - 1) < 0.0003 ? 1 : scale;
  const offsetMs = Math.round(offset);
  // "Že usklajeno": pri dolžini 2 h pomeni 0,0003 največ ~2 s razlike na koncu, kar regresija že pokrije.
  const inSync = !pieces && roundedScale === 1 && Math.abs(offsetMs) < 200;

  return {
    ok: problems.length === 0,
    inSync,
    scale: roundedScale,
    offsetMs,
    pieces,
    score,
    matches,
    margin,
    segments,
    activity,
    reason: problems.join(', ') || null
  };
}

// Uporabi transformacijo t' = scale * t + offset na vse časovne žige SRT besedila.
// Klic: applySync(srt, scale, offsetMs[, pieces]) ali applySync(srt, rezultatComputeSync).
// Pri odsekih ima vsak del vira svoj zamik (meja `srcFrom` je v časih vira).
// Obvestilni cue (id 0) ostane, kjer je.
function applySync(srt, scale = 1, offsetMs = 0, pieces = null) {
  if (scale && typeof scale === 'object') {
    ({ scale = 1, offsetMs = 0, pieces = null } = scale);
  }
  const hasPieces = Array.isArray(pieces) && pieces.length > 1;
  if (!hasPieces && scale === 1 && Math.abs(offsetMs) < 1) return srt;
  const offsetFor = srcStart => {
    if (!hasPieces) return offsetMs;
    let offset = pieces[0].offsetMs;
    for (const p of pieces) if (p.srcFrom == null || srcStart >= p.srcFrom) offset = p.offsetMs; else break;
    return offset;
  };
  const text = String(srt || '');
  return text.replace(new RegExp(TIMING_RE.source, 'g'), (all, h1, m1, s1, ms1, h2, m2, s2, ms2, at) => {
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    const prevLineStart = lineStart > 0 ? text.lastIndexOf('\n', lineStart - 2) + 1 : -1;
    const idLine = prevLineStart >= 0 ? text.slice(prevLineStart, lineStart - 1) : '';
    if (idLine.replace(/^\uFEFF/, '').trim() === '0') return all;
    const srcStart = toMs(h1, m1, s1, ms1);
    const offset = offsetFor(srcStart);
    const start = Math.max(0, srcStart * scale + offset);
    const end = Math.max(start + 300, toMs(h2, m2, s2, ms2) * scale + offset);
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
  if (result.pieces && result.pieces.length > 1) {
    parts.push(`${result.pieces.length} odseki: ${result.pieces.map(p => `${(p.offsetMs / 1000).toFixed(2)} s`).join(' / ')}`);
  }
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
