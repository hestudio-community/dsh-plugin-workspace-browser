import assert from 'node:assert/strict';
import test from 'node:test';
import { createPool } from '../src/host/pool.js';

test('clipboard checks Session, generation and grant before operations and before returning text', async t => {
  const row = { id: 'work', sessionIds: ['s1', 's2'] };
  const released = [], calls = [];
  let result;
  const pool = createPool({ list: () => [row], get: () => row }, () => ({
    ready: Promise.resolve(), stop() {}, releaseClipboard(id) { released.push(id); },
    clipboard(request, signal) { calls.push({ request, signal }); return result; },
  }));
  t.after(() => pool.dispose());
  const { runId, generation } = await pool.issue('s1', 'owner');
  const op = (action, sessionId = 's1', extra = {}) => pool.clipboard(action, { runId, generation, sessionId, ...extra });
  assert.deepEqual(await op('status'), { granted: false });
  await assert.rejects(op('read'), { code: 'clipboard_access_denied' });
  await op('grant');
  assert.equal(pool.current('work').permissions.size, 0);
  pool.invalidateAll(); // Agent provider changes do not revoke clipboard.
  await assert.rejects(op('write', 's2', { text: 'no' }), { code: 'clipboard_access_denied' });
  for (const text of ['🚀'.repeat(4097), '\uD800']) await assert.rejects(op('write', 's1', { text }), { code: 'invalid_clipboard_text' });
  assert.equal(calls.length, 0);
  await op('write', 's1', { text: '🚀'.repeat(4096) });
  const deferred = Promise.withResolvers(); result = deferred.promise;
  const read = op('read');
  await op('revoke');
  assert.equal(calls.at(-1).signal.aborted, true);
  assert.deepEqual(released, [calls.at(-1).request.grantId]);
  await op('grant'); deferred.resolve('must not leak');
  await assert.rejects(read, { code: 'clipboard_access_denied' });
  pool.restart('s1', runId, generation);
  assert.equal(released.length, 2);
  await assert.rejects(op('read'), { code: 'browser_generation_changed' });
});
