import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startGrantAccess } from '../src/client/browser-view.js';

const preview = { token: 'host-preview', path: '/srv/project', account: 'browser', uid: 1201 };
function setup(respond) {
  const tab = new AbortController(), requests = [], changes = [];
  let retries = 0;
  const api = startGrantAccess({ sessionId: 's1', tabSignal: tab.signal,
    change: state => changes.push(state), retry: () => retries++, request: async (path, body, signal) => {
      requests.push([path, body]); return respond(path, signal);
    } });
  return { api, tab, changes, requests, retries: () => retries };
}

test('workspace grant requires a current preview and explicit confirmation; cancel drops the token', async t => {
  const s = setup(path => path.endsWith('/prepare') ? preview : { ok: true });
  t.after(s.api.dispose);
  await s.api.confirm();
  await s.api.prepare();
  assert.deepEqual(s.changes.at(-1).preview, preview);
  s.api.cancel();
  await s.api.confirm();
  assert.deepEqual(s.requests, [['/workspace-access/prepare', { sessionId: 's1' }]]);
  await s.api.prepare();
  await Promise.all([s.api.confirm(), s.api.confirm()]);
  await s.api.confirm();
  assert.equal(s.retries(), 1);
  assert.deepEqual(s.requests.slice(1), [['/workspace-access/prepare', { sessionId: 's1' }],
    ['/workspace-access/grant', { sessionId: 's1', token: preview.token }]]);
});

test('stale host confirmation is dropped and never retries the browser', async t => {
  const s = setup(path => {
    if (path.endsWith('/grant')) throw Object.assign(new Error(), { code: 'workspace_access_stale' });
    return preview;
  });
  t.after(s.api.dispose);
  await s.api.prepare(); await s.api.confirm(); await s.api.confirm();
  assert.deepEqual(s.changes.at(-1), { busy: false, preview: undefined, error: 'workspaceAccessStale' });
  assert.equal(s.requests.length, 2); assert.equal(s.retries(), 0);
});

test('invalid preview data never enables grant', async t => {
  const s = setup(() => ({ ...preview, uid: 0 }));
  t.after(s.api.dispose);
  await s.api.prepare(); await s.api.confirm();
  assert.deepEqual(s.changes.at(-1), { busy: false, preview: undefined, error: 'requestFailed' });
  assert.equal(s.requests.length, 1);
});

test('a hidden view ignores late preview data even if fetch ignores cancellation', async () => {
  let finish;
  const s = setup(() => new Promise(resolve => { finish = resolve; }));
  const prepare = s.api.prepare();
  s.api.dispose();
  const count = s.changes.length;
  finish(preview); await prepare; await s.api.confirm();
  assert.equal(s.changes.length, count); assert.equal(s.requests.length, 1);
});

test('a late grant response cannot update or restart a replacement Session', async () => {
  let finish;
  const s = setup(path => path.endsWith('/prepare') ? preview : new Promise(resolve => { finish = resolve; }));
  await s.api.prepare();
  const grant = s.api.confirm();
  s.tab.abort();
  const count = s.changes.length;
  finish({ ok: true }); await grant;
  assert.equal(s.changes.length, count); assert.equal(s.retries(), 0);
});
