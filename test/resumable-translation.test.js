const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('in-progress translation state is saved to disk and can be loaded back with completed chunk indices intact', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloai-partial-'));
  process.env.CACHE_DIR = tmpDir;
  delete require.cache[require.resolve('../index')];
  const mod = require('../index');

  const key = 'tt2222222:auto:slv:anthropic:claude-sonnet-5';
  const sourceEntries = [
    { id: '1', timecode: '00:00:00,000 --> 00:00:02,000', text: 'Hello.' },
    { id: '2', timecode: '00:00:02,500 --> 00:00:04,000', text: 'World.' }
  ];
  const partial = mod.createPartialTracker(sourceEntries, 2);
  mod.mergeChunkIntoPartial(partial, '1\n00:00:00,000 --> 00:00:02,000\nŽivjo.\n', 0);
  mod.savePartialToDisk(key, partial);

  assert.ok(fs.existsSync(mod.partialFilePath(key)));

  const reloaded = mod.loadPartialFromDisk(key);
  assert.ok(reloaded.doneChunkIndices.has(0));
  assert.equal(reloaded.doneChunkIndices.has(1), false);
  assert.equal(reloaded.entryMap.get('1').text, 'Živjo.');
  assert.equal(reloaded.entryMap.get('2').text, 'World.'); // chunk 1 never ran, still source language
  assert.deepEqual(reloaded.order, ['1', '2']);

  mod.deletePartialFromDisk(key);
  assert.equal(fs.existsSync(mod.partialFilePath(key)), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CACHE_DIR;
  delete require.cache[require.resolve('../index')];
});

test('loadPartialFromDisk returns null when nothing has been saved yet for that key', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloai-partial-'));
  process.env.CACHE_DIR = tmpDir;
  delete require.cache[require.resolve('../index')];
  const mod = require('../index');

  assert.equal(mod.loadPartialFromDisk('tt0000000:auto:slv:anthropic:claude-sonnet-5'), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CACHE_DIR;
  delete require.cache[require.resolve('../index')];
});
