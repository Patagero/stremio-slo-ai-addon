const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGeminiRequest,
  combineForGemini,
  CHARACTER_LEDGER_SCHEMA,
  TRANSLATION_SCHEMA,
  buildTranslationSchema,
  translateWithGemini,
  extractOutputText
} = require('../index');

test('extractOutputText reads text from the real REST response shape (steps[].content[].text)', () => {
  // This is the ACTUAL shape documented for the raw REST API — "output_text" is only an
  // SDK convenience property and does NOT exist as a field on the raw JSON response.
  const realResponse = {
    id: 'v1_abc',
    status: 'completed',
    steps: [
      { type: 'thought', signature: 'xyz' },
      { type: 'model_output', content: [{ type: 'text', text: 'hello world' }] }
    ],
    object: 'interaction',
    model: 'gemini-3.7-flash'
  };
  assert.equal(extractOutputText(realResponse), 'hello world');
});

test('extractOutputText concatenates multiple text parts across model_output steps', () => {
  const response = {
    steps: [
      { type: 'model_output', content: [{ type: 'text', text: 'part one ' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'part two' }] }
    ]
  };
  assert.equal(extractOutputText(response), 'part one part two');
});

test('extractOutputText returns an empty string for missing/malformed steps rather than throwing', () => {
  assert.equal(extractOutputText({}), '');
  assert.equal(extractOutputText({ steps: [] }), '');
  assert.equal(extractOutputText({ steps: [{ type: 'thought' }] }), '');
  assert.equal(extractOutputText(null), '');
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

test('combineForGemini puts the shared context first, so repeated chunk calls share a prefix', () => {
  const combined = combineForGemini('SHARED CONTEXT', 'chunk-specific text');
  assert.ok(combined.indexOf('SHARED CONTEXT') < combined.indexOf('chunk-specific text'));
});

test('buildGeminiRequest targets the Interactions API endpoint with the model and input', () => {
  const request = buildGeminiRequest('hello world', 'gemini-3.7-flash');
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(request.body.model, 'gemini-3.7-flash');
  assert.equal(request.body.input, 'hello world');
  assert.equal(request.body.response_format, undefined);
});

test('buildGeminiRequest attaches a JSON schema as response_format when provided', () => {
  const request = buildGeminiRequest('hello', 'gemini-3.7-flash', { schema: TRANSLATION_SCHEMA });
  assert.equal(request.body.response_format.type, 'text');
  assert.equal(request.body.response_format.mime_type, 'application/json');
  assert.deepEqual(request.body.response_format.schema, TRANSLATION_SCHEMA);
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

test('translateWithGemini sends x-goog-api-key and reads text from the real steps[] response shape', async () => {
  const calls = [];
  const result = await translateWithGemini('some input', {
    apiKey: 'test-key',
    model: 'gemini-3.7-flash',
    schema: TRANSLATION_SCHEMA,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
      return {
        ok: true,
        json: async () => ({
          steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"translations":[]}' }] }]
        })
      };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['x-goog-api-key'], 'test-key');
  assert.equal(calls[0].body.model, 'gemini-3.7-flash');
  assert.equal(result, '{"translations":[]}');
});

test('translateWithGemini throws a clear error on a non-ok HTTP response', async () => {
  await assert.rejects(
    translateWithGemini('input', {
      apiKey: 'test-key',
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' })
    }),
    /Gemini HTTP 429/
  );
});
