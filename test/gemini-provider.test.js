const test = require('node:test');
const assert = require('node:assert/strict');
const { providerConfig, buildGeminiRequest } = require('../index');

test('uses Gemini as the translation provider', () => {
  assert.equal(providerConfig.name, 'gemini');
  assert.equal(providerConfig.model, 'gemini-2.5-flash');
});

test('builds a Gemini request with the Slovenian prompt and SRT content', () => {
  const request = buildGeminiRequest('SYSTEM PROMPT', '1\\n00:00:00,000 --> 00:00:01,000\\nHello');
  assert.equal(request.body.generationConfig.temperature, 0.1);
  assert.match(request.body.contents[0].parts[0].text, /SYSTEM PROMPT/);
  assert.match(request.body.contents[0].parts[0].text, /Hello/);
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
});
