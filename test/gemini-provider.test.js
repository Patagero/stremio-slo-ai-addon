const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClaudeRequest,
  CHARACTER_LEDGER_SCHEMA,
  TRANSLATION_SCHEMA,
  buildTranslationSchema,
  translateWithClaude,
  extractClaudeOutputText
} = require('../index');

test('extractClaudeOutputText reads text from Anthropic response shape (content[].text)', () => {
  const realResponse = {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'hello world' }],
    model: 'claude-3-5-sonnet-20241022'
  };
  assert.equal(extractClaudeOutputText(realResponse), 'hello world');
});

test('extractClaudeOutputText concatenates multiple text parts across content blocks', () => {
  const response = {
    content: [
      { type: 'text', text: 'part one ' },
      { type: 'text', text: 'part two' }
    ]
  };
  assert.equal(extractClaudeOutputText(response), 'part one part two');
});

test('extractClaudeOutputText returns an empty string for missing/malformed content rather than throwing', () => {
  assert.equal(extractClaudeOutputText({}), '');
  assert.equal(extractClaudeOutputText({ content: [] }), '');
  assert.equal(extractClaudeOutputText(null), '');
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

test('buildClaudeRequest targets the Anthropic Messages API with model, system, and messages', () => {
  const request = buildClaudeRequest('System prompt', 'User prompt', 'claude-3-5-sonnet-20241022');
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.body.model, 'claude-3-5-sonnet-20241022');
  assert.equal(request.body.system, 'System prompt');
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'User prompt' }]);
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
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

test('translateWithClaude sends x-api-key and reads text from content[] response shape', async () => {
  const calls = [];
  const result = await translateWithClaude('system prompt', 'user prompt', {
    apiKey: 'test-key',
    model: 'claude-3-5-sonnet-20241022',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '{"translations":[]}' }]
        })
      };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['x-api-key'], 'test-key');
  assert.equal(calls[0].body.model, 'claude-3-5-sonnet-20241022');
  assert.equal(result, '{"translations":[]}');
});

test('translateWithClaude throws a clear error on a non-ok HTTP response', async () => {
  await assert.rejects(
    translateWithClaude('input', 'user', {
      apiKey: 'test-key',
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' })
    }),
    /Anthropic HTTP 429/
  );
});
