const test = require('node:test');
const assert = require('node:assert/strict');
const { systemPrompt, translateWithClaude, validateSlovenianSubtitle } = require('../index');

test('full Slovenian prompt contains all requested quality rules', () => {
  const prompt = systemPrompt('Title: Demo\nPlot: Story\nTMDB Cast Genders:\nAna: Female\n\nCHARACTER LEDGER (from dialogue analysis):\nAna: female [confidence: high]');
  for (const phrase of [
    'READING SPEED & LENGTH CONTROL',
    'characters per second',
    'CHARACTER LEDGER',
    'GENDER & CONTEXT ACCURACY',
    'Never infer gender from voice alone',
    'rekla sem',
    'rekel sem',
    'tikanje',
    'vikanje',
    'PERFECT SRT SYNTAX',
    'Output ONLY the requested JSON'
  ]) assert.match(prompt, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
});

test('Claude provider is used and receives the current SRT chunk', async () => {
  const calls = [];
  const result = await translateWithClaude('SYSTEM', 'Hello', {
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '[{"id":"1","text":"Živjo"}]' }] }) };
    }
  });
  assert.equal(result.includes('Živjo'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.match(calls[0].options.body, /Hello/);
  assert.equal(calls[0].options.headers['x-api-key'], 'test-key');
});

test('subtitle validator enforces at most two lines and the configured character limit', () => {
  assert.equal(validateSlovenianSubtitle('Kratek\nprevod'), true);
  assert.equal(validateSlovenianSubtitle('Ena\nDve\nTri'), false);
  assert.equal(validateSlovenianSubtitle('To je namenoma predolga vrstica, ki dale\u010d prese\u017ee \u0161tirideset dva znakov meje'), false);
});
