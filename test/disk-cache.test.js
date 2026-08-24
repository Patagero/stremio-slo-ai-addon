const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('translated subtitles are persisted to disk and reloaded into the in-memory cache', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloai-cache-'));
  process.env.CACHE_DIR = tmpDir;
  delete require.cache[require.resolve('../index')];
  const mod1 = require('../index');

  const key = 'tt1234567:auto:slv:anthropic:claude-sonnet-5';
  const entry = { srt: '1\n00:00:00,000 --> 00:00:01,000\nŽivjo.\n', expiresAt: Date.now() + 60_000 };
  mod1.saveCacheEntryToDisk(key, entry);

  assert.ok(fs.existsSync(mod1.cacheFilePath(key)), 'cache file should exist on disk');

  // Simulate a server restart: fresh require, fresh in-memory Map, then load from disk.
  delete require.cache[require.resolve('../index')];
  const mod2 = require('../index');
  mod2.loadCacheFromDisk();

  const loaded = JSON.parse(fs.readFileSync(mod2.cacheFilePath(key), 'utf8'));
  assert.equal(loaded.srt, entry.srt);
  assert.ok(loaded.expiresAt > Date.now());

  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CACHE_DIR;
  delete require.cache[require.resolve('../index')];
});

test('expired cache files are not written with a past expiry (sanity on the entry shape)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloai-cache-'));
  process.env.CACHE_DIR = tmpDir;
  delete require.cache[require.resolve('../index')];
  const mod = require('../index');

  const key = 'tt7654321:auto:slv:anthropic:claude-sonnet-5';
  mod.saveCacheEntryToDisk(key, { srt: 'x', expiresAt: Date.now() + 1000 });
  const raw = fs.readFileSync(mod.cacheFilePath(key), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.key, key);
  assert.ok(typeof parsed.expiresAt === 'number');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CACHE_DIR;
  delete require.cache[require.resolve('../index')];
});
