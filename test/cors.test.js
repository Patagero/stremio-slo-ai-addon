const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../index');

test('manifest is fetchable cross-origin by Stremio clients', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  const response = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/manifest.json', headers: { Origin: 'https://web.stremio.com' } }, resolve);
    request.on('error', reject);
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  response.resume();
  await new Promise(resolve => response.once('end', resolve));
  await new Promise(resolve => server.close(resolve));
});
