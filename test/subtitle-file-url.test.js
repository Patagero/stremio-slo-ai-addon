const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../index');

function get(server, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: server.address().port, path }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    request.on('error', reject);
  });
}

test('subtitle-file URLs are self-describing: no token registry needed to resolve them', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  // The "choose a source" placeholder never needs a translation job or any registry lookup.
  const choose = await get(server, '/subtitle-file/tt1234567/choose.srt');
  assert.equal(choose.statusCode, 200);
  assert.match(choose.body, /Izberi EN, HR ali IT/);

  // An unsupported language segment is rejected outright, not silently served as empty.
  const bad = await get(server, '/subtitle-file/tt1234567/xx.srt');
  assert.equal(bad.statusCode, 404);

  await new Promise(resolve => server.close(resolve));
});

test('the /subtitles response builds direct, self-describing URLs (no random token path)', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  const response = await get(server, '/subtitles/movie/tt1234567.json');
  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body);
  assert.equal(data.subtitles.length, 4); // choose + en + hr + it
  for (const sub of data.subtitles) {
    assert.match(sub.url, /\/subtitle-file\/tt1234567\/(choose|en|hr|it)\.srt$/);
  }

  await new Promise(resolve => server.close(resolve));
});

test('a series id (tt1234567:season:episode) is split correctly: clean imdbId in the path, season/episode in the query', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  const response = await get(server, '/subtitles/series/tt1234567:2:5.json');
  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body);
  assert.equal(data.subtitles.length, 4); // choose + en + hr + it
  for (const sub of data.subtitles) {
    // The base id in the URL PATH must be the clean "tt1234567" — NOT the raw
    // "tt1234567:2:5" string, which is what broke OpenSubtitles/TMDB lookups before.
    assert.match(sub.url, /^https?:\/\/[^/]+\/subtitle-file\/tt1234567\/(choose|en|hr|it)\.srt\?season=2&episode=5$/);
  }

  await new Promise(resolve => server.close(resolve));
});
