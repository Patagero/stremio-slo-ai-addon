const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../index');

test('Stremio route accepts canonical .json and nested extra requests', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  for (const path of ['/subtitles/movie/tt1234567.json', '/subtitles/series/tt1234567/1:1.json']) {
    const response = await new Promise((resolve, reject) => { const request = http.get({ hostname: '127.0.0.1', port: server.address().port, path }, resolve); request.on('error', reject); });
    assert.equal(response.statusCode, 200); response.resume(); await new Promise(resolve => response.once('end', resolve));
  }
  await new Promise(resolve => server.close(resolve));
});
