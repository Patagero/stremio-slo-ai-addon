const test = require('node:test');
const assert = require('node:assert/strict');
const { cacheableSystemBlock, withAddendum, buildClaudeRequest, translateWithClaude } = require('../index');

test('cacheableSystemBlock wraps text as a single block with an ephemeral 1-hour cache breakpoint', () => {
  const block = cacheableSystemBlock('Long shared context here.');
  assert.deepEqual(block, [
    { type: 'text', text: 'Long shared context here.', cache_control: { type: 'ephemeral', ttl: '1h' } }
  ]);
});

test('withAddendum keeps the base text cacheable (1-hour TTL) and appends the addendum as a second, uncached block', () => {
  const blocks = withAddendum('Long shared context here.', 'REPAIR: fix this.');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'Long shared context here.');
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(blocks[1].text, 'REPAIR: fix this.');
  assert.equal(blocks[1].cache_control, undefined);
});

test('buildClaudeRequest forwards an array-based system (with cache_control) as-is to the request body', () => {
  const cached = cacheableSystemBlock('Shared context');
  const request = buildClaudeRequest(cached, 'Translate this', 'claude-sonnet-5', 1000);
  assert.deepEqual(request.body.system, cached);
});

test('buildClaudeRequest still accepts a plain string system for calls that do not need caching', () => {
  const request = buildClaudeRequest('Plain system prompt', 'Translate this', 'claude-sonnet-5', 1000);
  assert.equal(request.body.system, 'Plain system prompt');
});

test('translateWithClaude sends the cacheable system block through to the Anthropic API call', async () => {
  const calls = [];
  await translateWithClaude(cacheableSystemBlock('Shared context'), 'Chunk text', {
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '[]' }] }) };
    }
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].system, [
    { type: 'text', text: 'Shared context', cache_control: { type: 'ephemeral', ttl: '1h' } }
  ]);
});
