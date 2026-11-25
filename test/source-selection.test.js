const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseExtraFileName,
  sourceCacheLanguage,
  buildCacheKey,
  rankSubtitleCandidates,
  pickManualChoices,
  releaseSourceFamily,
  releaseGroupName,
  syncNoticeSuffix
} = require('../index');

function candidate(overrides) {
  return {
    fileId: '1', fileName: '', release: '', language: 'hr', moviehashMatch: false, downloads: 100,
    fps: 0, hearingImpaired: false, machineTranslated: false, trusted: false, ...overrides
  };
}

test('parseExtraFileName decodes the video file name Stremio sends', () => {
  assert.equal(parseExtraFileName('filename=The.Movie.2024.1080p.WEB-DL.mkv&videoSize=1&videoHash=abc'), 'The.Movie.2024.1080p.WEB-DL.mkv');
  assert.equal(parseExtraFileName('videoHash=abc&filename=My%20Movie%20(2024).mkv'), 'My Movie (2024).mkv');
  assert.equal(parseExtraFileName('videoHash=abc'), null);
});

test('a manually chosen source gets its own cache key, separate from the automatic translation', () => {
  const auto = buildCacheKey('tt1', sourceCacheLanguage('hr', {}), 'hash', null, null);
  const chosen = buildCacheKey('tt1', sourceCacheLanguage('hr', { fileId: '12345' }), 'hash', null, null);
  const other = buildCacheKey('tt1', sourceCacheLanguage('hr', { fileId: '999' }), 'hash', null, null);
  assert.notEqual(auto, chosen);
  assert.notEqual(chosen, other);
  assert.match(chosen, /:hr-file12345:/);
});

test('release helpers recognise source family and release group', () => {
  assert.equal(releaseSourceFamily('Movie.2024.1080p.BluRay.x264-SPARKS'), 'bluray');
  assert.equal(releaseSourceFamily('Movie.2024.1080p.AMZN.WEB-DL.DDP5.1-FLUX'), 'web');
  assert.equal(releaseGroupName('Movie.2024.1080p.WEB-DL-FLUX.mkv'), 'flux');
});

test('ranking prefers the subtitle made for the same release as the video', () => {
  const video = 'Movie.2024.1080p.BluRay.x264-SPARKS.mkv';
  const ranked = rankSubtitleCandidates([
    candidate({ fileId: 'web', release: 'Movie.2024.1080p.WEB-DL-FLUX', downloads: 5000 }),
    candidate({ fileId: 'bluray', release: 'Movie.2024.1080p.BluRay.x264-SPARKS', downloads: 300 }),
    candidate({ fileId: 'ai', release: 'Movie.2024.1080p.BluRay.x264-SPARKS', downloads: 9000, machineTranslated: true })
  ], video);
  assert.equal(ranked[0].fileId, 'bluray');
  assert.equal(ranked[ranked.length - 1].fileId, 'ai');
});

test('ranking puts a hash-matched subtitle first and penalises a different edition', () => {
  const video = 'Movie.2024.Extended.1080p.BluRay-GRP.mkv';
  const ranked = rankSubtitleCandidates([
    candidate({ fileId: 'theatrical', release: 'Movie.2024.1080p.BluRay-GRP' }),
    candidate({ fileId: 'extended', release: 'Movie.2024.Extended.1080p.BluRay-GRP' }),
    candidate({ fileId: 'hash', release: 'something else', moviehashMatch: true })
  ], video);
  assert.deepEqual(ranked.map(c => c.fileId), ['hash', 'extended', 'theatrical']);
});

test('pickManualChoices groups Serbian/Bosnian with Croatian and limits choices per language', () => {
  const list = [
    candidate({ fileId: 'a', language: 'hr' }),
    candidate({ fileId: 'b', language: 'sr' }),
    candidate({ fileId: 'c', language: 'bs' }),
    candidate({ fileId: 'd', language: 'hr' }),
    candidate({ fileId: 'e', language: 'hr' }),
    candidate({ fileId: 'f', language: 'en' }),
    candidate({ fileId: 'g', language: 'de' })
  ];
  const choices = pickManualChoices(list, null);
  const hr = choices.filter(c => c.sourceLanguage === 'hr');
  assert.equal(hr.length, 4);
  assert.ok(choices.some(c => c.sourceLanguage === 'en' && c.fileId === 'f'));
  assert.ok(!choices.some(c => c.fileId === 'g'));
});

test('syncNoticeSuffix says how the timing was checked', () => {
  assert.match(syncNoticeSuffix({ matchedByHash: true }), /ujema se z vašo datoteko/);
  assert.match(syncNoticeSuffix({ verified: true, sync: { inSync: false } }), /samodejno usklajena/);
  assert.match(syncNoticeSuffix({ verified: false, sync: { ok: false } }), /ni potrjena/);
  assert.equal(syncNoticeSuffix({ verified: false, sync: null }), '');
});
