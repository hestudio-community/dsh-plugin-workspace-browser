import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachClipboard } from '../src/client/clipboard.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(t, granted = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const handlers = new Map(), screen = { addEventListener(name, fn, { signal }) {
    handlers.set(name, fn); signal.addEventListener('abort', () => handlers.delete(name), { once: true });
  } };
  const win = new EventTarget(), doc = new EventTarget();
  const local = [], keys = [], calls = [], pending = [];
  let text = 'old', permission = 'granted', snapshot;
  win.navigator = { permissions: { query: async () => ({ state: await permission }) },
    clipboard: { writeText: value => local.push(value) } };
  Object.assign(doc, { defaultView: win, activeElement: screen, visibilityState: 'visible', hasFocus: () => true });
  Object.assign(screen, { ownerDocument: doc, contains: node => screen === node });
  const identity = { sessionId: 'one', runId: 'run', generation: 'g1' };
  const api = attachClipboard({ screen, identity, rfb: { focus() { doc.activeElement = screen; }, sendKey(...args) { keys.push(args); } },
    change: state => { snapshot = state; }, request: async (path, body, signal) => {
      assert.deepEqual({ ...body, text: undefined }, { ...identity, text: undefined });
      const op = path.split('/').at(-1); calls.push(op);
      if (op === 'status') return { granted };
      if (op === 'grant' || op === 'revoke') return { granted: granted = op === 'grant' };
      if (op === 'read') return { text };
      if (op === 'write') return new Promise(resolve => pending.push({ resolve, signal, text: body.text }));
      throw new Error('Unexpected route');
    } });
  t.after(api.dispose);
  function event(name, fields) {
    const e = { isTrusted: true, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...fields };
    handlers.get(name)?.(e); return e;
  }
  return { api, calls, pending, keys, local, event, doc, snapshot: () => snapshot, text: next => { text = next; },
    permission: next => { permission = next; }, tick: async ms => { t.mock.timers.tick(ms); await flush(); } };
}

test('clipboard is independent and opt-in; only a plain-text paste forwards one chord after acknowledgement', async t => {
  const x = harness(t); await flush(); await x.tick(1000);
  const key = { ctrlKey: true, code: 'KeyV' };
  assert.deepEqual(x.calls, ['status']); assert.equal(x.event('keydown', key).stopped, undefined);
  await x.api.toggle(true);
  const intercepted = x.event('keydown', key); assert.equal(intercepted.stopped, true); assert.equal(intercepted.prevented, undefined);
  x.event('paste', { clipboardData: { types: ['image/png'] } });
  assert.equal(x.snapshot().note, 'clipboardInvalid');
  await x.api.send('a'.repeat(16385)); await x.api.send('\ud800'); assert.equal(x.pending.length, 0);
  const paste = x.event('paste', { clipboardData: { types: ['text/plain'], getData: () => '文字\n😀' } });
  assert.equal(paste.prevented, true); assert.equal(x.pending[0].text, '文字\n😀'); assert.deepEqual(x.keys, []);
  x.pending[0].resolve({}); await flush(); assert.equal(x.keys.filter(k => k[1] === 'KeyV').length, 1);
  await x.api.toggle(false); assert.equal(x.snapshot().granted, false);
});

test('focus loss, visibility changes and disposal invalidate paste even when a write ignores abort', async t => {
  const x = harness(t, true); await flush();
  for (const cancel of [() => x.event('focusout'), () => { x.doc.visibilityState = 'hidden'; x.doc.dispatchEvent(new Event('visibilitychange')); }, () => x.api.dispose()]) {
    x.doc.visibilityState = 'visible'; const promise = x.api.send('secret');
    const op = x.pending.at(-1); cancel(); assert.equal(op.signal.aborted, true); op.resolve({}); await promise;
    assert.deepEqual(x.keys, []);
  }
});

test('a delayed browser permission result cannot copy after focus loss or discard a newer transfer', async t => {
  const x = harness(t, true); await flush(); await x.tick(250);
  let release;
  x.permission(new Promise(resolve => { release = resolve; })); x.text('stale'); await x.tick(750);
  x.event('focusout'); x.event('focusin'); x.permission('granted'); x.text('next baseline'); await x.tick(250);
  release('granted'); await flush(); assert.deepEqual(x.local, []);
  x.text('new'); await x.tick(750); assert.deepEqual(x.local, ['new']);
});

test('automatic receive ignores baseline and requires browser permission; manual copy is a separate gesture', async t => {
  const x = harness(t, true); await flush(); await x.tick(250); assert.deepEqual(x.local, []);
  x.text('new'); await x.tick(750); assert.deepEqual(x.local, ['new']);
  x.permission('prompt'); x.text('manual'); await x.tick(750); assert.deepEqual(x.local, ['new']);
  assert.equal(x.snapshot().note, 'clipboardManualHint');
  await x.api.manual(); assert.equal(x.snapshot().remote, 'manual'); await x.api.copy(); assert.deepEqual(x.local, ['new', 'manual']);
  x.doc.visibilityState = 'hidden'; x.doc.dispatchEvent(new Event('visibilitychange')); assert.equal(x.snapshot().remote, undefined);
  const reads = x.calls.filter(x => x === 'read').length; await x.tick(3000);
  assert.equal(x.calls.filter(x => x === 'read').length, reads);
});

test('text denied by a missing permission is delivered once permission is granted, without another edit', async t => {
  const x = harness(t, true); await flush(); await x.tick(250);
  x.permission('prompt'); x.text('blocked'); await x.tick(750);
  assert.deepEqual(x.local, []); assert.equal(x.snapshot().note, 'clipboardManualHint');
  // Same text is still pending; granting permission delivers it on the next poll.
  x.permission('granted'); await x.tick(750); assert.deepEqual(x.local, ['blocked']);
  // A delivered value is not copied again while it remains unchanged.
  await x.tick(1500); assert.deepEqual(x.local, ['blocked']);
});
