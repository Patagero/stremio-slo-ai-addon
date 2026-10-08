const test = require('node:test');
const assert = require('node:assert/strict');
const { systemPrompt, translateWithGemini, validateSlovenianSubtitle } = require('../index');

test('full Slovenian prompt contains all requested quality rules', () => {
  const prompt = systemPrompt('Title: Demo\nGenres: Action, Sci-Fi\nPlot: Story\nTMDB Cast Genders:\nAna: Female\n\nCHARACTER LEDGER (from dialogue analysis):\nAna: female [confidence: high]');
  for (const phrase of [
    'SPOLNO UJEMANJE',
    'CHARACTER LEDGER',
    'rekla sem',
    'rekel sem',
    'ŽANRSKO PRILAGOJEN SLENG',
    'OMEJITEV VRSTIC',
    'tikanje',
    'vikanje',
    'POPOLNA TEHNIČNA INTEGRITETA',
    'translations'
  ]) assert.match(prompt, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
});

test('Gemini provider is used and receives the current SRT chunk', async () => {
  const calls = [];
  const result = await translateWithGemini('SYSTEM', 'Hello', {
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: '{"translations":[{"id":"1","text":"Živjo"}]}' }]
              }
            }
          ]
        })
      };
    }
  });
  assert.equal(result.includes('Živjo'), true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('generateContent'));
  assert.ok(calls[0].url.includes('key=test-key'));
});

test('subtitle validator enforces at most two lines and the configured character limit', () => {
  assert.equal(validateSlovenianSubtitle('Kratek\nprevod'), true);
  assert.equal(validateSlovenianSubtitle('Ena\nDve\nTri'), false);
  assert.equal(validateSlovenianSubtitle('To je namenoma predolga vrstica, ki dale\u010d prese\u017ee \u0161tirideset dva znakov meje'), false);
});
