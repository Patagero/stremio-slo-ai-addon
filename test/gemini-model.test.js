const test = require('node:test');
const assert = require('node:assert/strict');
const { GEMINI_MODEL, providerConfig, buildGeminiRequest } = require('../index');

test('uses the currently available Gemini Flash model', () => {
  assert.equal(GEMINI_MODEL, 'gemini-3.6-flash');
  assert.equal(providerConfig.model, 'gemini-3.6-flash');
  assert.match(buildGeminiRequest('system', 'srt').url, /models\/gemini-3\.6-flash:generateContent$/);
});
