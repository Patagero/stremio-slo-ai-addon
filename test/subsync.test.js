const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSync, applySync, extractCues, msToTimecode } = require('../subsync');

// Deterministični "naključni" generator, da so testi ponovljivi.
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

// Umetna časovnica filma: ~700 stavkov z naravnimi premori.
function makeTimeline(seed, count = 700) {
  const random = rng(seed);
  const cues = [];
  let t = 60000;
  for (let i = 0; i < count; i++) {
    t += 300 + Math.floor(random() * 6000) + (random() < 0.05 ? 20000 : 0);
    const duration = 900 + Math.floor(random() * 3500);
    cues.push({ start: t, end: t + duration });
    t += duration;
  }
  return cues;
}

function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${msToTimecode(c.start)} --> ${msToTimecode(c.end)}\nVrstica ${i + 1}`).join('\n\n') + '\n';
}

// Vir v drugem jeziku: nekateri stavki manjkajo ali so razdeljeni, časi so malo zamaknjeni,
// nato pa vse skupaj premaknjeno/raztegnjeno (druga izdaja videa).
function deriveSource(reference, { scale, offset, seed }) {
  const random = rng(seed);
  const cues = [];
  for (const cue of reference) {
    if (random() < 0.15) continue;
    const jitter = Math.round((random() - 0.5) * 500);
    const start = cue.start + jitter;
    const end = cue.end + jitter;
    if (random() < 0.1 && end - start > 2000) {
      const mid = Math.round((start + end) / 2);
      cues.push({ start, end: mid }, { start: mid + 40, end });
    } else {
      cues.push({ start, end });
    }
  }
  // Inverzna transformacija: vir je "narobe", sinhronizacija ga mora vrniti na referenco.
  return cues.map(c => ({ start: Math.round((c.start - offset) / scale), end: Math.round((c.end - offset) / scale) }));
}

function assertAligned(referenceCues, syncedSrt, toleranceMs = 400) {
  const synced = extractCues(syncedSrt);
  const starts = referenceCues.map(c => c.start);
  let close = 0;
  for (const cue of synced) {
    const nearest = starts.reduce((best, s) => (Math.abs(s - cue.start) < Math.abs(best - cue.start) ? s : best), Infinity);
    if (Math.abs(nearest - cue.start) <= toleranceMs) close++;
  }
  assert.ok(close / synced.length > 0.85, `samo ${close}/${synced.length} podnapisov je po sinhronizaciji na pravem mestu`);
}

test('computeSync finds a fixed delay between two releases', () => {
  const reference = makeTimeline(1);
  const source = deriveSource(reference, { scale: 1, offset: 4300, seed: 2 });
  const result = computeSync(toSrt(reference), toSrt(source));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.inSync, false);
  assert.ok(Math.abs(result.offsetMs - 4300) < 250, `offset ${result.offsetMs}`);
  assert.equal(result.scale, 1);
  assertAligned(reference, applySync(toSrt(source), result.scale, result.offsetMs));
});

test('computeSync finds a frame-rate difference (23.976 <-> 25 fps) plus a delay', () => {
  const reference = makeTimeline(3);
  const source = deriveSource(reference, { scale: 25 / 23.976, offset: -2100, seed: 4 });
  const result = computeSync(toSrt(reference), toSrt(source));
  assert.equal(result.ok, true, result.reason);
  assert.ok(Math.abs(result.scale - 25 / 23.976) < 0.001, `scale ${result.scale}`);
  assertAligned(reference, applySync(toSrt(source), result.scale, result.offsetMs));
});

test('computeSync reports an already-synced subtitle as in sync and changes nothing', () => {
  const reference = makeTimeline(5);
  const source = deriveSource(reference, { scale: 1, offset: 0, seed: 6 });
  const result = computeSync(toSrt(reference), toSrt(source));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.inSync, true);
  const srt = toSrt(source);
  assert.equal(applySync(srt, result.scale, result.offsetMs === 0 ? 0 : 0), srt);
});

test('computeSync rejects a subtitle that belongs to a different film/episode', () => {
  const reference = makeTimeline(7);
  const unrelated = makeTimeline(99);
  const result = computeSync(toSrt(reference), toSrt(unrelated));
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

test('computeSync refuses to judge when there are too few cues', () => {
  const reference = makeTimeline(8, 5);
  const result = computeSync(toSrt(reference), toSrt(reference));
  assert.equal(result.ok, false);
});

test('applySync shifts and stretches timecodes, never below zero, keeping text intact', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nPrvi\n\n2\n00:10:00,000 --> 00:10:03,500\nDrugi\n';
  const shifted = applySync(srt, 1, -1500);
  assert.match(shifted, /00:00:00,000 --> 00:00:00,500/);
  assert.match(shifted, /00:09:58,500 --> 00:10:02,000/);
  assert.match(shifted, /Prvi/);
  const stretched = applySync(srt, 2, 0);
  assert.match(stretched, /00:20:00,000 --> 00:20:07,000/);
});

test('extractCues skips the notice cue (id 0) and empty cues', () => {
  const cues = extractCues('0\n00:00:01,000 --> 00:00:05,000\nObvestilo\n\n1\n00:01:00,000 --> 00:01:02,000\nBesedilo\n\n2\n00:01:03,000 --> 00:01:04,000\n\n');
  assert.deepEqual(cues, [{ start: 60000, end: 62000 }]);
});

// Druga izdaja z rezi: po vsakem rezu se zamik spremeni (npr. drugačen uvod, TV premori).
function deriveCutSource(reference, cuts, seed) {
  const offsetAt = t => cuts.reduce((sum, cut) => (t >= cut.at ? sum + cut.shift : sum), 0);
  const base = deriveSource(reference, { scale: 1, offset: 0, seed });
  return base.map(c => ({ start: c.start - offsetAt(c.start), end: c.end - offsetAt(c.start) }));
}

test('computeSync aligns a release with cuts piece by piece', () => {
  const reference = makeTimeline(11, 900);
  const source = deriveCutSource(reference, [{ at: 1800000, shift: 3000 }, { at: 3600000, shift: 4500 }], 12);
  const result = computeSync(toSrt(reference), toSrt(source));
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.pieces && result.pieces.length === 3, `pieces ${JSON.stringify(result.pieces)}`);
  assertAligned(reference, applySync(toSrt(source), result));
});

test('computeSync does not invent cuts for a plain delay', () => {
  const reference = makeTimeline(13);
  const source = deriveSource(reference, { scale: 1, offset: 2500, seed: 14 });
  const result = computeSync(toSrt(reference), toSrt(source));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.pieces, null);
});

test('applySync leaves the notice cue (id 0) untouched', () => {
  const srt = '0\n00:00:01,000 --> 00:00:05,000\nObvestilo\n\n1\n00:01:00,000 --> 00:01:02,000\nBesedilo\n';
  const shifted = applySync(srt, 1, 30000);
  assert.match(shifted, /^0\n00:00:01,000 --> 00:00:05,000\nObvestilo/);
  assert.match(shifted, /00:01:30,000 --> 00:01:32,000/);
});
