const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

const {
  buildGeminiRequest,
  computeTranslationMaxOutputTokens,
  translateWithGemini,
  translateChunk
} = require('../index');

test('translation requests cap thinking and reserve enough output tokens', () => {
  const request = buildGeminiRequest('System', 'User', 'gemini-3.7-flash', { maxOutputTokens: 12000 });
  const config = request.body.generationConfig;

  assert.equal(config.responseMimeType, 'application/json');
  assert.equal(config.maxOutputTokens, 12000);
  assert.deepEqual(config.thinkingConfig, { thinkingLevel: 'low' });
  // Gemini 3.6+ no longer accepts temperature.
  assert.equal('temperature' in config, false);
});

test('Gemini 2.5 requests disable thinking to avoid empty output', () => {
  const request = buildGeminiRequest('System', 'User', 'gemini-2.5-flash');
  assert.deepEqual(request.body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

test('empty Gemini candidate falls back to the next model', async () => {
  const calls = [];
  const result = await translateWithGemini('System', 'User', {
    apiKey: 'test-key',
    model: 'gemini-3.7-flash',
    fetchImpl: async url => {
      calls.push(url);
      if (calls.length === 1) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }],
            usageMetadata: { thoughtsTokenCount: 8192 }
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"translations":[]}' }] } }]
        })
      };
    }
  });

  assert.equal(result, '{"translations":[]}');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('gemini-3.7-flash'));
  // A full Flash model falls back to another full Flash model first.
  assert.ok(calls[1].includes('gemini-3.6-flash'));
});

test('output token budget grows with cue count and stays bounded', () => {
  assert.ok(computeTranslationMaxOutputTokens(1) >= 4096);
  assert.ok(computeTranslationMaxOutputTokens(120) > computeTranslationMaxOutputTokens(30));
  assert.ok(computeTranslationMaxOutputTokens(10000) <= 32768);
});

test('an oversized chunk that returns empty output is split and still fully translated', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.contents[0].parts[0].text;
    const ids = [...prompt.matchAll(/\[id=(\d+)/g)].map(match => match[1]);
    calls.push(ids.length);

    if (ids.length > 30) {
      return {
        ok: true,
        json: async () => ({
          candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }]
        })
      };
    }

    const translations = ids.map(id => ({ id, text: `Prevod ${id}` }));
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ translations }) }] } }]
      })
    };
  };

  try {
    const entries = Array.from({ length: 60 }, (_, index) => ({
      id: String(index + 1),
      timecode: '00:00:00,000 --> 00:00:10,000',
      text: `Hello ${index + 1}`
    }));

    const result = await translateChunk({ index: 0, entries }, 'Title: Test');

    assert.equal(result.length, 60);
    assert.ok(result.every((entry, index) => entry.text === `Prevod ${index + 1}`));
    assert.ok(calls.some(count => count === 60), 'the original oversized chunk must be attempted first');
    assert.ok(calls.some(count => count <= 30), 'the chunk must be retried in smaller pieces');
  } finally {
    global.fetch = originalFetch;
  }
});
