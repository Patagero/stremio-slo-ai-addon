const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, resolveSourceLanguages, SUPPORTED_SOURCE_LANGUAGES } = require('../index');

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

test('supported source languages include auto, hr, it, en, and whisper_en', () => {
  assert.deepEqual(SUPPORTED_SOURCE_LANGUAGES, ['auto', 'hr', 'it', 'en', 'whisper_en']);
});

test('resolveSourceLanguages handles whisper_en explicitly', () => {
  const resolved = resolveSourceLanguages({}, 'whisper_en', true);
  assert.deepEqual(resolved, ['whisper_en']);
});

test('stremio subtitles endpoint exposes options for HR, ITA, ANG, and Whisper', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  const response = await get(server, '/subtitles/movie/tt1234567.json');
  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body);

  const labels = data.subtitles.map(s => s.label);
  assert.ok(labels.some(l => l.includes('Prevod iz angleščine')));
  assert.ok(labels.some(l => l.includes('Prevod iz hrvaščine')));
  assert.ok(labels.some(l => l.includes('Prevod iz italijanščine')));
  assert.ok(labels.some(l => l.includes('Whisper prevod')));

  await new Promise(resolve => server.close(resolve));
});
