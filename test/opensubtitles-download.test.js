const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slo-os-'));
process.env.OPENSUBTITLES_API_KEY = 'key';
process.env.OPENSUBTITLES_USERNAME = 'user';
process.env.OPENSUBTITLES_PASSWORD = 'pass';

const axios = require('axios');
const { downloadOpenSubtitleFile, openSubtitlesErrorDetail, friendlyErrorMessage, translateSubtitle } = require('../index');

function httpError(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
}

test('a rejected download logs in again and retries once', async t => {
  const calls = [];
  let logins = 0;
  t.mock.method(axios, 'post', async (url, body, options) => {
    calls.push({ url, auth: options.headers.Authorization });
    if (url.endsWith('/login')) {
      logins += 1;
      return { data: { token: `token-${logins}`, base_url: 'vip-api.opensubtitles.com' } };
    }
    if (options.headers.Authorization === 'Bearer token-1') throw httpError(401, { message: 'Invalid token' });
    return { data: { link: 'https://dl.example/file.srt' } };
  });
  t.mock.method(axios, 'get', async () => ({ data: '1\n00:00:01,000 --> 00:00:02,000\nCiao\n' }));

  const srt = await downloadOpenSubtitleFile('900001');
  assert.match(srt, /Ciao/);
  assert.equal(logins, 2);
  const downloads = calls.filter(c => c.url.endsWith('/download'));
  assert.deepEqual(downloads.map(c => c.auth), ['Bearer token-1', 'Bearer token-2']);
  // VIP račun: prenos gre na base_url iz prijave.
  assert.ok(downloads[1].url.startsWith('https://vip-api.opensubtitles.com/api/v1/'));
});

test('a download that stays rejected reports the OpenSubtitles reason', async t => {
  t.mock.method(axios, 'post', async url => {
    if (url.endsWith('/login')) return { data: { token: 'tok' } };
    throw httpError(401, { message: 'You cannot consume this service' });
  });
  await assert.rejects(downloadOpenSubtitleFile('900002'), error => {
    assert.equal(error.code, 'OPENSUBTITLES_DOWNLOAD');
    assert.match(error.message, /OpenSubtitles prenos zavrnjen: 401 You cannot consume this service/);
    return true;
  });
});

test('OpenSubtitles errors get a clear message for the viewer', () => {
  assert.equal(openSubtitlesErrorDetail(httpError(406, { message: 'quota' })), '406 quota');
  assert.match(friendlyErrorMessage('OpenSubtitles prenos zavrnjen: 401 Invalid token'), /OPENSUBTITLES_USERNAME/);
  assert.match(friendlyErrorMessage('OpenSubtitles prenos zavrnjen: 406 quota'), /kvota/);
  assert.match(friendlyErrorMessage('OpenSubtitles prenos zavrnjen: 429 Too many'), /preveč zahtev/);
});

test('a failed translation is answered from memory for a while instead of retrying every second', async () => {
  delete process.env.OPENSUBTITLES_API_KEY;
  const first = await translateSubtitle('tt0000001', 'it', 'hash1', false, null, null, {}).catch(e => e);
  const second = await translateSubtitle('tt0000001', 'it', 'hash1', false, null, null, {}).catch(e => e);
  assert.match(first.message, /OPENSUBTITLES_API_KEY/);
  assert.equal(second, first);
});
