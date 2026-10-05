const test = require('node:test');
const assert = require('node:assert/strict');
const { withOpenSubtitlesLimit } = require('../index');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('withOpenSubtitlesLimit runs concurrent calls strictly one at a time', async () => {
  const order = [];
  async function fakeCall(id, delayMs) {
    order.push(`start-${id}`);
    await sleep(delayMs);
    order.push(`end-${id}`);
    return id;
  }

  // Simulates the EN/HR/IT multi-track feature firing three OpenSubtitles lookups at once.
  const results = await Promise.all([
    withOpenSubtitlesLimit(() => fakeCall('en', 30)),
    withOpenSubtitlesLimit(() => fakeCall('hr', 10)),
    withOpenSubtitlesLimit(() => fakeCall('it', 20))
  ]);

  assert.deepEqual(results, ['en', 'hr', 'it']);

  // Every "end" must immediately follow its own "start" — never interleaved with another
  // call's start, which would mean two OpenSubtitles requests were in flight at once.
  for (let i = 0; i < order.length; i += 2) {
    const startId = order[i].replace('start-', '');
    const endId = order[i + 1].replace('end-', '');
    assert.equal(startId, endId, `call ${startId} overlapped with another queued call`);
  }
});

test('one queued call failing does not block or break the next queued call', async () => {
  const attemptOrder = [];
  const failing = withOpenSubtitlesLimit(async () => {
    attemptOrder.push('fail');
    throw new Error('simulated OpenSubtitles error');
  });
  const succeeding = withOpenSubtitlesLimit(async () => {
    attemptOrder.push('succeed');
    return 'ok';
  });

  await assert.rejects(failing, /simulated OpenSubtitles error/);
  assert.equal(await succeeding, 'ok');
  assert.deepEqual(attemptOrder, ['fail', 'succeed']);
});
