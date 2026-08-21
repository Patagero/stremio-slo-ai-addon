const test = require('node:test');
const assert = require('node:assert/strict');
const { selectAnthropicModel } = require('../index');

test('selects the best available Sonnet model instead of a retired hard-coded id', () => {
  const models = [
    { id: 'claude-3-haiku-20240307' },
    { id: 'claude-sonnet-4-20250514' },
    { id: 'claude-3-7-sonnet-20250219' },
    { id: 'claude-3-5-sonnet-20240620' }
  ];
  assert.equal(selectAnthropicModel(models), 'claude-sonnet-4-20250514');
});

test('uses any available Claude model when Sonnet is unavailable', () => {
  assert.equal(selectAnthropicModel([{ id: 'claude-3-haiku-20240307' }]), 'claude-3-haiku-20240307');
});

test('returns null when the account exposes no models', () => {
  assert.equal(selectAnthropicModel([]), null);
});
