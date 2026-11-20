import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { makeClient } from '../src/client/index.js';
import { makeBrowserView } from '../src/client/browser-view.js';
import { post } from '../src/client/http.js';
import { createStreamChannel } from '../src/client/stream.js';
import { API, DESKTOP_REQUEST_HEADER, DESKTOP_REQUEST_VERSION } from '../src/shared/protocol.js';

const createElement = (type, props, ...children) => ({ type, props, children });

function installTab() {
  let definition;
  let body;
  const slots = [];
  const { apply } = makeClient({ React: { createElement }, RFB: null });
  apply({
    effect: (mount) => mount(),
    connection: { openWebSocket: (path) => `owned-host:${path}` },
    locale: { register() {}, bind: () => (key) => key },
    sidebarRightTabs: { register: (entry) => { definition = entry; } },
    slots: {
      inject(name, mount) { slots.push(name); return mount(); },
      register(options, render) {
        assert.equal(options.key, definition.id);
        body = render;
      },
    },
  });
  return { slots, definition, body };
}

test('native guide registers only its right-sidebar tab and binds the current visible Session', () => {
  const { slots, definition, body } = installTab();
  assert.deepEqual(slots, ['sidebar.right.pane.tab']);
  assert.equal(definition.kind, 'workspace-browser');
  assert.equal(definition.guide[0].title(), 'open');

  const tab = { visible: true, signal: new AbortController().signal };
  const a = { workspaceId: 'a', sessionIds: ['blank', 'other'] };
  const b = { workspaceId: 'b', sessionIds: ['elsewhere'] };
  const render = (sessionId, items, phase = 'ready') => body({
    t: (key) => key, sessionId, useTabInfo: () => ({ tab }),
    useWorkspaces: (select) => select({ phase, items }),
  });
  const noView = (node, label) => assert.equal(node.children[0].children[0], label);
  noView(render('blank', [], 'loading'), 'loadingWorkspace');
  noView(render('unassigned', [a, b]), 'sessionWorkspaceMissing');
  noView(render('blank', [a, { ...b, sessionIds: ['blank'] }]), 'sessionWorkspaceMissing');
  const first = render('blank', [a, b]);
  const next = render('other', [a, b]);
  assert.equal(first.children[0].props.sessionId, 'blank');
  assert.equal(first.children[0].props.openWebSocket(`${API}/stream`), `owned-host:${API}/stream`);
  assert.equal(first.children[1].props.workspace, a);
  assert.notEqual(first.children[0].props.key, next.children[0].props.key);
  assert.equal(render('elsewhere', [a, b]).children[1].props.workspace, b);
  tab.visible = false;
  assert.equal(render('blank', [a, b]), null);
});

function mountView(sessionId, tabSignal, RFB) {
  const states = [];
  let effect;
  const React = {
    createElement,
    useRef: () => ({ current: { appendChild() {} } }),
    useState(initial) {
      const index = states.length;
      states.push(initial);
      return [initial, (value) => { states[index] = value; }];
    },
    useLayoutEffect: (mount) => { effect = mount; },
  };
  makeBrowserView(React, RFB)({ sessionId, tabSignal, t: (key) => key });
  const dispose = effect();
  return { dispose, phase: () => states[1] };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('only the Desktop main document marks relative authenticated JSON requests', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else delete globalThis.location;
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  for (const [page, marker, path] of [
    ['http://127.0.0.1:4321/', undefined, '/view'],
    ['dsh-app://app/', DESKTOP_REQUEST_VERSION, '/view'],
    ['dsh-app://app/session', DESKTOP_REQUEST_VERSION, '/agent/status'],
    ['dsh-app://shell/', undefined, '/view'],
    ['dsh-app://app:123/', undefined, '/view'],
  ]) {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(page) });
    await post(path, {});
    const { url, init } = requests.at(-1);
    assert.equal(url, `${API}${path}`);
    assert.equal(init.headers[DESKTOP_REQUEST_HEADER], marker);
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
  }
});

test('display uses the Connection carrier, sends one ticket before binary data, and closes safely', () => {
  const frames = [];
  const socket = {
    readyState: WebSocket.CONNECTING, binaryType: 'blob', protocol: '',
    send(value) { frames.push(value); },
    close() { this.readyState = WebSocket.CLOSING; },
  };
  const channel = createStreamChannel('ticket', (path) => {
    assert.equal(path, `${API}/stream`);
    return socket;
  });
  assert.equal(socket.binaryType, 'arraybuffer');
  assert.equal(channel.readyState, WebSocket.CONNECTING);
  const bytes = new Uint8Array([1, 2]);
  channel.send(bytes);
  assert.deepEqual(frames, []);
  channel.onopen = () => channel.send(bytes);
  socket.readyState = WebSocket.OPEN;
  socket.onopen({});
  socket.onopen({});
  assert.deepEqual(frames, ['{"ticket":"ticket"}', bytes]);
  const received = [];
  channel.onmessage = ({ data }) => received.push(data);
  socket.onmessage({ data: bytes.buffer });
  assert.deepEqual(received, [bytes.buffer]);
  socket.onmessage({ data: 'unexpected text' });
  assert.equal(socket.readyState, WebSocket.CLOSING);
  socket.onmessage({ data: bytes.buffer });
  channel.send(bytes);
  assert.equal(received.length, 1);
  assert.equal(frames.length, 2);

  const unopened = { ...socket, readyState: WebSocket.CONNECTING };
  const retired = createStreamChannel('stale-ticket', () => unopened);
  retired.close();
  unopened.readyState = WebSocket.OPEN;
  unopened.onopen({});
  assert.equal(frames.length, 2);
});

test('a retired view aborts its request and ignores a late ticket after switching Sessions', async (t) => {
  const pending = [];
  t.mock.method(globalThis, 'fetch', (url, { body, signal }) => new Promise((resolve) => {
    pending.push({ url, body: JSON.parse(body), signal, resolve });
  }));
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { createElement: () => ({ style: {}, remove() {} }) },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });

  const firstTab = new AbortController();
  const nextTab = new AbortController();
  const first = mountView('first', firstTab.signal);
  const next = mountView('next', nextTab.signal);
  t.after(first.dispose);
  t.after(next.dispose);
  assert.deepEqual(pending.map(({ body }) => body), [{ sessionId: 'first' }, { sessionId: 'next' }]);
  firstTab.abort();
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending[1].signal.aborted, false);
  pending[0].resolve({ ok: true, json: async () => ({ ok: true, ticket: 'stale' }) });
  pending[1].resolve({ ok: false, json: async () => ({ ok: false, code: 'runner_isolation_failed', message: 'test' }) });
  await flush();
  assert.equal(first.phase(), 'starting');
  assert.equal(next.phase(), 'runnerIsolationFailed');
});

test('profile startup failures use distinct localized messages', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { createElement: () => ({ style: {}, remove() {} }) },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });
  let responseCode;
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false, json: async () => ({ ok: false, code: responseCode, message: 'test' }),
  }));
  const cases = [
    ['runner_profile_in_use', 'runnerProfileInUse'],
    ['runner_profile_recovery_failed', 'runnerProfileRecoveryFailed'],
    ['runner_start_failed', 'runnerStartFailed'],
    ['runner_isolation_failed', 'runnerIsolationFailed'],
  ];
  for (const [code, key] of cases) {
    responseCode = code;
    const view = mountView('workspace', new AbortController().signal);
    t.after(view.dispose);
    await flush();
    assert.equal(view.phase(), key);
  }
  for (const locale of ['zh', 'en']) {
    const messages = JSON.parse(readFileSync(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8'));
    const texts = cases.map(([, key]) => messages[key]);
    assert.ok(texts.every(text => typeof text === 'string' && text.trim()));
    assert.equal(new Set(texts).size, cases.length);
  }
});
