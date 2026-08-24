const test = require('node:test');
const assert = require('node:assert/strict');

test('without username/password, OpenSubtitles headers omit the Authorization bearer token', async () => {
  delete process.env.OPENSUBTITLES_USERNAME;
  delete process.env.OPENSUBTITLES_PASSWORD;
  process.env.OPENSUBTITLES_API_KEY = 'test-key';
  delete require.cache[require.resolve('../index')];
  const { openSubtitlesHeaders } = require('../index');

  const headers = await openSubtitlesHeaders();
  assert.equal(headers['Api-Key'], 'test-key');
  assert.equal(headers.Accept, '*/*');
  assert.equal(headers.Authorization, undefined);

  delete process.env.OPENSUBTITLES_API_KEY;
  delete require.cache[require.resolve('../index')];
});
