const test = require('node:test');
const assert = require('node:assert/strict');
const { systemPrompt, translateWithGemini, validateSlovenianSubtitle } = require('../index');

test('full Slovenian prompt contains all requested quality rules', () => {
  const prompt = systemPrompt('Title: Demo\nPlot: Story\nCharacters & Genders:\nAna: Female');
  for (const phrase of [
    'READABILITY & LENGTH CONTROL',
    '37-40 characters',
    'no more than 2 lines',
    'GENDER & CONTEXT ACCURACY',
    'Analyze the conversation flow',
    'rekla sem',
    'rekel sem',
    'tikanje',
    'vikanje',
    'PERFECT SRT SYNTAX',
    'Output ONLY raw translated SRT'
  ]) assert.match(prompt, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
});

test('Gemini provider is used and receives the current SRT chunk', async () => {
  const calls = [];
  const result = await translateWithGemini('SYSTEM', '1\n00:00:00,000 --> 00:00:01,000\nHello', {
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '1\n00:00:00,000 --> 00:00:01,000\nŽivjo' }] } }] }) };
    }
  });
  assert.equal(result.includes('Živjo'), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /gemini-2\.5-flash:generateContent/);
  assert.match(calls[0].options.body, /Hello/);
});

test('subtitle validator enforces at most two lines and 40 characters per line', () => {
  assert.equal(validateSlovenianSubtitle('Kratek\nprevod'), true);
  assert.equal(validateSlovenianSubtitle('Ena\nDve\nTri'), false);
  assert.equal(validateSlovenianSubtitle('To je namenoma predolga vrstica, ki preseže štirideset znakov'), false);
});
