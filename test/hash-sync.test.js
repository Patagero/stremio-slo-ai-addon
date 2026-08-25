const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExtraHash, buildCacheKey } = require('../index');

test('parseExtraHash extracts videoHash and videoSize regardless of field order', () => {
  const a = parseExtraHash('filename=Movie.mkv&videoSize=123456&videoHash=dd630e246fb4d8d0');
  assert.equal(a.videoHash, 'dd630e246fb4d8d0');
  assert.equal(a.videoSize, '123456');

  const b = parseExtraHash('videoHash=412c388974299c51&videoSize=16482909858&filename=Other.mkv');
  assert.equal(b.videoHash, '412c388974299c51');
  assert.equal(b.videoSize, '16482909858');
});

test('parseExtraHash returns nulls when no hash is present (e.g. missing extra segment)', () => {
  assert.deepEqual(parseExtraHash(''), { videoHash: null, videoSize: null });
  assert.deepEqual(parseExtraHash(undefined), { videoHash: null, videoSize: null });
  assert.deepEqual(parseExtraHash('filename=NoHashHere.mkv'), { videoHash: null, videoSize: null });
});

test('buildCacheKey includes the video hash when available, so different releases of the same movie do not share a translation', () => {
  const withHash = buildCacheKey('tt8814476', null, '3728b9709c10d9d6');
  const otherRelease = buildCacheKey('tt8814476', null, 'aaaaaaaaaaaaaaaa');
  assert.notEqual(withHash, otherRelease);
  assert.match(withHash, /^tt8814476:3728b9709c10d9d6:/);
});

test('buildCacheKey falls back to imdbId-only when no hash is available', () => {
  const key = buildCacheKey('tt8814476', null, null);
  assert.match(key, /^tt8814476:auto:slv:/);
});
