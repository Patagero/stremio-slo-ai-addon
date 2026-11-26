const test = require('node:test');
const assert = require('node:assert/strict');
const { createPartialTracker, mergeChunkIntoPartial, markChunkFailed, partialToSrt } = require('../index');

const sourceEntries = [
  { id: '1', timecode: '00:00:00,000 --> 00:00:02,000', text: 'Hello there.' },
  { id: '2', timecode: '00:00:02,500 --> 00:00:04,000', text: 'How are you?' },
  { id: '3', timecode: '00:00:04,500 --> 00:00:06,000', text: 'Fine, thanks.' }
];

test('a fresh partial tracker starts with the source-language text for every cue', () => {
  const partial = createPartialTracker(sourceEntries, 2);
  assert.equal(partial.entryMap.get('1').text, 'Hello there.');
  assert.equal(partial.doneChunkIndices.size, 0);
  assert.equal(partial.failedChunkIndices.size, 0);
  assert.equal(partial.totalChunks, 2);
  assert.deepEqual(partial.order, ['1', '2', '3']);
});

test('merging a translated chunk replaces only the cues it covers', () => {
  const partial = createPartialTracker(sourceEntries, 2);
  const translated = [
    { id: '1', timecode: '00:00:00,000 --> 00:00:02,000', text: 'Živjo.' },
    { id: '2', timecode: '00:00:02,500 --> 00:00:04,000', text: 'Kako si?' }
  ];
  mergeChunkIntoPartial(partial, translated, 0);
  assert.equal(partial.entryMap.get('1').text, 'Živjo.');
  assert.equal(partial.entryMap.get('2').text, 'Kako si?');
  // Cue 3 was not part of this chunk, so it must still be in the source language.
  assert.equal(partial.entryMap.get('3').text, 'Fine, thanks.');
  assert.ok(partial.doneChunkIndices.has(0));
});

test('partialToSrt renders a mixed source/translated subtitle in the original cue order', () => {
  const partial = createPartialTracker(sourceEntries, 2);
  mergeChunkIntoPartial(partial, [{ id: '1', timecode: '00:00:00,000 --> 00:00:02,000', text: 'Živjo.' }], 0);
  const srt = partialToSrt(partial);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:02,000\nŽivjo\./);
  assert.match(srt, /3\n00:00:04,500 --> 00:00:06,000\nFine, thanks\./);
});

test('a chunk marked failed is NOT in doneChunkIndices, so it will be retried next run', () => {
  const partial = createPartialTracker(sourceEntries, 2);
  markChunkFailed(partial, 1);
  assert.ok(partial.failedChunkIndices.has(1));
  assert.equal(partial.doneChunkIndices.has(1), false);
});

test('successfully retrying a previously-failed chunk clears it from failedChunkIndices', () => {
  const partial = createPartialTracker(sourceEntries, 2);
  markChunkFailed(partial, 0);
  assert.ok(partial.failedChunkIndices.has(0));
  mergeChunkIntoPartial(partial, [{ id: '1', timecode: '00:00:00,000 --> 00:00:02,000', text: 'Živjo.' }], 0);
  assert.equal(partial.failedChunkIndices.has(0), false);
  assert.ok(partial.doneChunkIndices.has(0));
});

test('an in-progress subtitle tells the viewer to reselect and marks each untranslated stretch', () => {
  const { partialProgressSrt } = require('../index');
  const partial = createPartialTracker(sourceEntries, 2);
  mergeChunkIntoPartial(partial, [{ id: '2', timecode: '00:00:02,000 --> 00:00:04,000', text: 'Kako si?' }], 0);
  const srt = partialProgressSrt(partial);
  assert.match(srt, /^0\n00:00:01,000 --> 00:00:05,000\nPrevod še poteka \(1\/2 delov\)\. Ko bo končan, znova izberite podnapise\./);
  // Neprevedena 1. in 3. vrstica sta ločena dela, zato ima vsak svojo oznako; prevedena 2. je nima.
  assert.equal((srt.match(/\[Prevod še poteka - znova izberite podnapise\]/g) || []).length, 2);
  assert.match(srt, /\nKako si\?\n/);
});

test('a finished translation is stored without the in-progress flag in the output', () => {
  const partial = createPartialTracker(sourceEntries, 1);
  mergeChunkIntoPartial(partial, sourceEntries.map(e => ({ ...e, text: `SL ${e.text}` })), 0);
  assert.doesNotMatch(partialToSrt(partial), /Prevod še poteka/);
});

test('the placeholder shown before the first part is ready stays on screen and says to reselect', () => {
  const { inProgressPlaceholderSrt } = require('../index');
  assert.match(inProgressPlaceholderSrt(), /^0\n00:00:01,000 --> 09:59:59,000\n\[Prevod še poteka - znova izberite podnapise\]/);
});
