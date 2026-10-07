const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGeminiRequest,
  CHARACTER_LEDGER_SCHEMA,
  TRANSLATION_SCHEMA,
  buildTranslationSchema,
  translateWithGemini,
  extractGeminiOutputText
} = require('../index');

test('extractGeminiOutputText reads text from Gemini candidate response shape', () => {
  const realResponse = {
    candidates: [
      {
        content: {
          parts: [{ text: 'hello world' }]
        }
      }
    ]
  };
  assert.equal(extractGeminiOutputText(realResponse), 'hello world');
});

test('extractGeminiOutputText concatenates multiple text parts across parts', () => {
  const response = {
    candidates: [
      {
        content: {
          parts: [
            { text: 'part one ' },
            { text: 'part two' }
          ]
        }
      }
    ]
  };
  assert.equal(extractGeminiOutputText(response), 'part one part two');
});

test('extractGeminiOutputText returns an empty string for missing/malformed content rather than throwing', () => {
  assert.equal(extractGeminiOutputText({}), '');
  assert.equal(extractGeminiOutputText({ candidates: [] }), '');
  assert.equal(extractGeminiOutputText(null), '');
});

test('buildTranslationSchema pins minItems and maxItems to the exact expected count', () => {
  const schema = buildTranslationSchema(45);
  assert.equal(schema.properties.translations.minItems, 45);
  assert.equal(schema.properties.translations.maxItems, 45);
});

test('buildTranslationSchema adapts to a different count for the shortening pass', () => {
  const schema = buildTranslationSchema(3);
  assert.equal(schema.properties.translations.minItems, 3);
  assert.equal(schema.properties.translations.maxItems, 3);
});

test('buildGeminiRequest targets the Gemini generateContent API with model, system, and messages', () => {
  const request = buildGeminiRequest('System prompt', 'User prompt', 'gemini-3.1-pro-preview');
  assert.ok(request.url.includes('gemini-3.1-pro-preview:generateContent'));
  assert.equal(request.body.contents[0].role, 'user');
  assert.ok(request.body.contents[0].parts[0].text.includes('System prompt'));
  assert.ok(request.body.contents[0].parts[0].text.includes('User prompt'));
  assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
});

test('CHARACTER_LEDGER_SCHEMA requires a characters array with name/gender/confidence', () => {
  assert.equal(CHARACTER_LEDGER_SCHEMA.type, 'object');
  assert.ok(CHARACTER_LEDGER_SCHEMA.required.includes('characters'));
  const itemSchema = CHARACTER_LEDGER_SCHEMA.properties.characters.items;
  assert.deepEqual(itemSchema.required, ['name', 'gender', 'confidence']);
  assert.deepEqual(itemSchema.properties.gender.enum, ['male', 'female', 'unknown']);
});

test('TRANSLATION_SCHEMA requires a translations array of {id, text} pairs', () => {
  assert.equal(TRANSLATION_SCHEMA.type, 'object');
  assert.ok(TRANSLATION_SCHEMA.required.includes('translations'));
  const itemSchema = TRANSLATION_SCHEMA.properties.translations.items;
  assert.deepEqual(itemSchema.required, ['id', 'text']);
});

test('translateWithGemini sends key param and reads text from parts[] response shape', async () => {
  const calls = [];
  const result = await translateWithGemini('system prompt', 'user prompt', {
    apiKey: 'test-key',
    model: 'gemini-3.1-pro-preview',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: '{"translations":[]}' }]
              }
            }
          ]
        })
      };
    }
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('key=test-key'));
  assert.ok(calls[0].url.includes('gemini-3.1-pro-preview'));
  assert.equal(result, '{"translations":[]}');
});

test('translateWithGemini throws a clear error on a non-ok HTTP response', async () => {
  await assert.rejects(
    translateWithGemini('input', 'user', {
      apiKey: 'test-key',
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' })
    }),
    /Gemini HTTP 429/
  );
});
