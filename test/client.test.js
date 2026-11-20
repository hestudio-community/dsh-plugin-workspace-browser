import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { makeClient } from '../src/client/index.js';
import { createBrowserConnection, makeBrowserView } from '../src/client/browser-view.js';
import { makeAgentAccess } from '../src/client/agent-access.js';
import { post } from '../src/client/http.js';
import { createStreamChannel } from '../src/client/stream.js';
import { API, DESKTOP_REQUEST_HEADER, DESKTOP_REQUEST_VERSION } from '../src/shared/protocol.js';

const createElement = (type, props, ...children) => ({ type, props, children });

function mount(Component) {
  const cells = [];
  let cursor = 0;
  let effects = [];
  return {
    React: {
      createElement, Fragment: Symbol('fragment'),
      useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
      useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial }; },
      useState(initial) {
        const index = cursor++;
        const cell = cells[index] ??= { value: initial };
        return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
      },
      useLayoutEffect(effect, deps) {
        const index = cursor++;
        const prev = cells[index];
        if (!prev || !deps || deps.some((value, i) => !Object.is(value, prev.deps[i]))) {
          effects.push(() => {
            prev?.dispose?.();
            cells[index] = { deps, dispose: effect() };
          });
        }
      },
    },
    render(props, beforeCommit = () => {}) {
      cursor = 0;
      effects = [];
      const result = Component(props);
      beforeCommit(result);
      for (const effect of effects) effect();
      return result;
    },
    dispose() { for (const cell of cells) cell.dispose?.(); },
  };
}

function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = find(child, predicate);
      if (result) return result;
    }
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  return find(node.children, predicate);
}

function installTab() {
  let definition;
  let body;
  const slots = [];
  const mounted = mount((props) => body(props));
  const { apply } = makeClient({ React: mounted.React, RFB: null });
  apply({
    effect: (mount) => mount(),
    inject(services) { assert.deepEqual(services, ['configForms', 'slots']); },
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
  return { slots, definition, body: mounted.render };
}

test('native guide registers only its right-sidebar tab and binds the current visible Session', () => {
  const { slots, definition, body } = installTab();
  assert.deepEqual(slots, ['sidebar.right.pane.tab']);
  assert.equal(definition.kind, 'workspace-browser');
  assert.equal(definition.keepMounted, true);
  assert.equal(definition.guide[0].title(), 'open');
  assert.equal(definition.guide[0].description, undefined);

  let closed = 0;
  const occurrence = new AbortController();
  const tab = { visible: true, signal: occurrence.signal, actions: { close() { closed++; occurrence.abort(); } } };
  const a = { workspaceId: 'a', sessionIds: ['blank', 'other'] };
  const b = { workspaceId: 'b', sessionIds: ['elsewhere'] };
  const render = (sessionId, items, phase = 'ready') => body({
    t: (key) => key, sessionId, useTabInfo: () => ({ tab }),
    useWorkspaces: (select) => select({ phase, items }),
  });
  const noView = (node, label) => assert.equal(node.children[1].children[0], label);
  noView(render('blank', [], 'loading'), 'loadingWorkspace');
  noView(render('unassigned', [a, b]), 'sessionWorkspaceMissing');
  noView(render('blank', [a, { ...b, sessionIds: ['blank'] }]), 'sessionWorkspaceMissing');
  const first = render('blank', [a, b]).children[0];
  const next = render('other', [a, b]).children[0];
  assert.equal(first.props.sessionId, 'blank');
  assert.equal(first.props.openWebSocket(`${API}/stream`), `owned-host:${API}/stream`);
  assert.notEqual(first.props.key, next.props.key);
  const selected = render('elsewhere', [a, b]).children[0];
  const loading = render('elsewhere', [], 'loading').children[0];
  assert.equal(loading.props.key, selected.props.key);
  assert.equal(loading.props.visible, false);
  assert.equal(closed, 0);
  tab.visible = false;
  const hidden = render('elsewhere', [a, b]);
  assert.equal(hidden.props.hidden, true);
  assert.equal(hidden.children[0].props.key, selected.props.key);
  assert.equal(hidden.children[0].props.visible, false);
  render('elsewhere', [a]);
  assert.equal(closed, 1);
  assert.equal(render('elsewhere', [a, b]), null);
});

function installSettings() {
  let contribution;
  let Component;
  let snapshot = { status: 'ready', value: { agentEnabled: true }, writable: true, revision: 1 };
  const writes = [];
  const form = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    async mutate(ops, revision) {
      writes.push({ ops, revision });
      snapshot = { ...snapshot, value: { agentEnabled: ops[0].value }, revision: revision + 1 };
      return true;
    },
  };
  const mounted = mount((props) => Component(props));
  const { apply } = makeClient({ React: mounted.React, RFB: null });
  const slots = {
    inject: (_slot, register) => register(),
    register(options, render) {
      if (options.name !== 'plugins.bundle.config') return;
      contribution = { options, render };
      return () => { contribution = undefined; };
    },
  };
  let namespaceAvailable;
  let dispose;
  apply({
    effect: (setup) => setup(),
    connection: {}, slots,
    locale: { register() {}, bind: () => (key) => key },
    sidebarRightTabs: { register() {} },
    inject(services, attach) {
      assert.deepEqual(services, ['configForms', 'slots']);
      attach({
        effect: (setup) => { dispose = setup(); }, slots,
        configForms: {
          get(entry) { assert.equal(entry, 'workspace-browser'); return form; },
          whileServed(entries, register) {
            assert.deepEqual(entries, ['workspace-browser']);
            let unregister;
            namespaceAvailable = () => { unregister = register(); };
            return () => unregister?.();
          },
        },
      });
    },
  });
  const t = (key) => key;
  return {
    contribution: () => contribution,
    serve: namespaceAvailable,
    dispose: () => { mounted.dispose(); dispose(); },
    writes, form,
    update: (next) => { snapshot = { ...snapshot, ...next }; },
    render() {
      Component = contribution.render({ t, view: 'page' }).type;
      const page = mounted.render({ t });
      const toggle = find(page, (item) => item.props?.role === 'switch');
      const save = find(page, (item) => item.type === 'button');
      const status = find(page, (item) => item.props?.role === 'status');
      return {
        checked: toggle?.props.checked, readOnly: toggle?.props.disabled,
        change: (checked) => toggle.props.onChange({ currentTarget: { checked } }),
        canSave: !save.props.disabled, save: () => page.props.onSubmit({ preventDefault() {} }),
        notice: status.children[0],
      };
    },
  };
}

test('the workspace browser bundle form uses the served entry and only writes on Save', (t) => {
  const settings = installSettings();
  t.after(settings.dispose);
  assert.equal(settings.contribution(), undefined);
  settings.serve();
  const { options, render } = settings.contribution();
  assert.deepEqual(options, {
    name: 'plugins.bundle.config', key: '@local/dsh-workspace-browser', locale: '@local/dsh-workspace-browser',
  });
  assert.equal(render({ view: 'summary' }), null);
  const initial = settings.render();
  assert.equal(initial.checked, true);
  assert.equal(initial.canSave, false);
  initial.change(false);
  assert.deepEqual(settings.writes, []);
  const draft = settings.render();
  assert.equal(draft.checked, false);
  assert.equal(draft.canSave, true);
  return draft.save().then(() => {
    assert.deepEqual(settings.writes, [{ ops: [{ op: 'set', path: ['agentEnabled'], value: false }], revision: 1 }]);
    assert.equal(settings.render().checked, false);
    assert.equal(settings.render().canSave, false);
  });
});

test('the workspace browser bundle form rejects stale and read-only edits and recovers after failed saves', async (t) => {
  const settings = installSettings();
  t.after(settings.dispose);
  settings.serve();
  settings.update({ writable: false });
  const readOnly = settings.render();
  assert.equal(readOnly.readOnly, true);
  assert.equal(readOnly.notice, 'agentSettingsReadOnly');
  assert.equal(readOnly.canSave, false);
  settings.update({ writable: true });
  settings.render().change(false);
  settings.update({ revision: 2 });
  const stale = settings.render();
  assert.equal(stale.checked, true);
  assert.equal(stale.canSave, false);
  assert.equal(stale.notice, 'agentSettingsChanged');
  await stale.save();
  assert.deepEqual(settings.writes, []);

  for (const mutate of [async () => false, async () => { throw new Error('Disconnected'); }]) {
    settings.form.mutate = mutate;
    settings.render().change(false);
    await settings.render().save();
    assert.equal(settings.render().checked, true);
    assert.equal(settings.render().canSave, false);
    assert.equal(settings.render().notice, 'agentSettingsNotSaved');
  }
});

function mountView(sessionId, tabSignal, overrides = {}) {
  let view;
  const hooks = mount((props) => view(props));
  view = makeBrowserView(hooks.React, overrides.RFB);
  const render = () => hooks.render({
    sessionId, tabSignal, visible: true, onClosed() {}, t: (key) => key, ...overrides,
  }, (tree) => {
    const target = find(tree, (node) => node.props?.onKeyDownCapture);
    target.props.ref.current ??= { appendChild() {} };
  });
  render();
  return { render, dispose: hooks.dispose, phase: () => find(render(),
    (node) => ['status', 'alert'].includes(node.props?.role))?.children[0] };
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
  const owners = [];
  const socket = {
    readyState: WebSocket.CONNECTING, binaryType: 'blob', protocol: '',
    send(value) { frames.push(value); },
    close() { this.readyState = WebSocket.CLOSING; },
  };
  const channel = createStreamChannel('ticket', (path) => {
    assert.equal(path, `${API}/stream`);
    return socket;
  }, (enabled) => owners.push(enabled));
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
  socket.onmessage({ data: JSON.stringify({ type: 'resize-owner', enabled: true }) });
  socket.onmessage({ data: JSON.stringify({ type: 'resize-owner', enabled: false }) });
  assert.deepEqual(owners, [true, false]);
  socket.onmessage({ data: JSON.stringify({ type: 'resize-owner', enabled: 'true' }) });
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

function response(data) {
  return { ok: data.ok !== false, json: async () => ({ ok: true, ...data }) };
}

function fakeDisplays(t) {
  const sockets = [];
  const rfbs = [];
  const observers = [];
  for (const [key, value] of Object.entries({
    document: { createElement: () => ({ style: {}, clientWidth: 0, clientHeight: 0, remove() {} }) },
    ResizeObserver: class {
      constructor(callback) { this.resize = callback; observers.push(this); }
      observe() {}
      disconnect() { this.stopped = true; }
    },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  class RFB extends EventTarget {
    constructor(screen) { super(); this.screen = screen; this.resizeSession = false; rfbs.push(this); }
    disconnect() { this.disconnected = true; this.dispatchEvent(new Event('disconnect')); }
    blur() { this.blurred = true; }
  }
  function openWebSocket() {
    const socket = {
      readyState: WebSocket.CONNECTING, binaryType: 'blob', send() {},
      close() { this.readyState = WebSocket.CLOSING; },
      open() { this.readyState = WebSocket.OPEN; this.onopen({}); },
      owner(enabled) { this.onmessage({ data: JSON.stringify({ type: 'resize-owner', enabled }) }); },
    };
    sockets.push(socket);
    return socket;
  }
  return { sockets, rfbs, observers, RFB, openWebSocket };
}

const ticket = (generation) => ({ ticket: 'display', runId: 'run', generation });

function mountConnection(t, display, sessionId = 'one') {
  let closed = 0;
  let state;
  const tab = new AbortController();
  const client = createBrowserConnection({
    sessionId, tabSignal: tab.signal, target: { appendChild() {} },
    ...display, onClosed: () => { closed++; }, onChange: (next) => { state = next; },
  });
  t.after(client.dispose);
  return { client, tab, closed: () => closed, state: () => state };
}

test('hidden tabs drop RFB, poll the logical run, rejoin a new generation, and close only their own tab', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  let status = { state: 'restarting', generation: 'g2' };
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    const payload = JSON.parse(body);
    const path = url.slice(API.length);
    requests.push([path, payload]);
    return response(path === '/view' ? ticket(payload.generation ?? 'g1') : status);
  });
  const display = fakeDisplays(t);
  const { client, closed, state } = mountConnection(t, display);
  client.setVisible(true);
  await flush();
  const [original] = display.rfbs;
  original.dispatchEvent(new Event('connect'));
  assert.equal(state().phase, 'connected');
  client.setVisible(false);
  assert.equal(original.disconnected, true);
  assert.equal(display.sockets[0].readyState, WebSocket.CLOSING);
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(state().phase, 'restarting');
  assert.equal(display.rfbs.length, 1);
  status = { state: 'ready', generation: 'g2' };
  client.setVisible(true);
  await flush();
  assert.deepEqual(requests, [
    ['/view', { sessionId: 'one' }],
    ['/browser/status', { sessionId: 'one', runId: 'run' }],
    ['/browser/status', { sessionId: 'one', runId: 'run' }],
    ['/view', { sessionId: 'one', runId: 'run', generation: 'g2' }],
  ]);
  original.dispatchEvent(new Event('connect'));
  assert.equal(state().phase, 'connecting');
  display.rfbs[1].dispatchEvent(new Event('connect'));
  client.setVisible(false);
  status = { state: 'closed' };
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(closed(), 1);
  client.setVisible(true);
  assert.equal(requests.length, 5);
});

test('a first ticket received while hidden binds the run but never opens a display', async (t) => {
  let launch;
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    bodies.push(JSON.parse(body));
    if (bodies.length === 1) return new Promise((resolve) => { launch = resolve; });
    return response(url.endsWith('/status') ? { state: 'ready', generation: 'g1' } : ticket('g1'));
  });
  const display = fakeDisplays(t);
  const { client } = mountConnection(t, display);
  client.setVisible(true);
  client.setVisible(false);
  launch(response(ticket('g1')));
  await flush();
  assert.equal(display.sockets.length, 0);
  client.setVisible(true);
  await flush();
  assert.deepEqual(bodies.at(-1), { sessionId: 'one', runId: 'run', generation: 'g1' });
  assert.equal(display.sockets.length, 1);
});

test('a status transport failure during reopen is retryable and never closes the tab', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/status')) throw new TypeError('Network error');
    return response(ticket('g1'));
  });
  const display = fakeDisplays(t);
  const { client, closed, state } = mountConnection(t, display);
  client.setVisible(true);
  await flush();
  client.setVisible(false);
  client.setVisible(true);
  await flush();
  assert.equal(state().phase, 'requestFailed');
  assert.equal(state().canRetry, true);
  assert.equal(closed(), 0);
  client.retry();
  await flush();
  assert.equal(display.rfbs.length, 2);
});

test('an interrupted display can rejoin the same run and never sends browser close', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    requests.push([url.slice(API.length), JSON.parse(body)]);
    return response(url.endsWith('/status') ? { state: 'ready', generation: 'g1' } : ticket('g1'));
  });
  const display = fakeDisplays(t);
  const { client, closed, tab, state } = mountConnection(t, display);
  client.setVisible(true);
  await flush();
  display.rfbs[0].dispatchEvent(new Event('connect'));
  display.rfbs[0].dispatchEvent(new Event('disconnect'));
  await flush();
  assert.equal(state().phase, 'disconnected');
  assert.equal(display.rfbs.length, 1);
  assert.equal(closed(), 0);
  client.retry();
  await flush();
  assert.deepEqual(requests.at(-1), ['/view', { sessionId: 'one', runId: 'run', generation: 'g1' }]);
  assert.equal(display.rfbs.length, 2);
  tab.abort();
  assert.equal(display.rfbs[1].disconnected, true);
  assert.equal(requests.some(([path]) => path === '/browser/close'), false);
});

test('restart invalidates stale status; a failed new generation can retry before closing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const actions = [];
  let oldStatus;
  let statuses = 0;
  t.mock.method(globalThis, 'fetch', async (url, { body, signal }) => {
    if (url.endsWith('/view')) return response(ticket('g1'));
    if (url.endsWith('/status')) {
      statuses++;
      if (statuses === 1) return new Promise((resolve) => { oldStatus = { resolve, signal }; });
      return response(statuses === 2 ? { state: 'failed', code: 'runner_start_failed', generation: 'g2' }
        : { state: 'restarting', generation: 'g3' });
    }
    actions.push([url.slice(API.length), JSON.parse(body)]);
    return response(url.endsWith('/close') ? { state: 'closed' }
      : { state: 'restarting', generation: actions.length === 1 ? 'g2' : 'g3' });
  });
  const display = fakeDisplays(t);
  const { client, closed, state } = mountConnection(t, display);
  client.setVisible(true);
  await flush();
  t.mock.timers.tick(2000);
  await client.mutate('restart');
  await flush();
  assert.equal(oldStatus.signal.aborted, true);
  oldStatus.resolve(response({ state: 'closed' }));
  await flush();
  assert.equal(closed(), 0);
  assert.equal(state().phase, 'runnerStartFailed');
  assert.equal(state().canRetry, true);
  assert.equal(display.rfbs.length, 1);
  client.retry();
  await flush();
  assert.equal(state().phase, 'restarting');
  await client.mutate('close');
  assert.deepEqual(actions, [
    ['/browser/restart', { sessionId: 'one', runId: 'run', generation: 'g1' }],
    ['/browser/restart', { sessionId: 'one', runId: 'run', generation: 'g2' }],
    ['/browser/close', { sessionId: 'one', runId: 'run', generation: 'g3' }],
  ]);
  assert.equal(closed(), 1);
});

test('native resize ownership follows measured dimensions and Shift+Escape returns to controls', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response(ticket('g1')));
  const { rfbs, sockets, observers, RFB, openWebSocket } = fakeDisplays(t);
  const view = mountView('one', new AbortController().signal, { RFB, openWebSocket });
  t.after(view.dispose);
  await flush();
  const [rfb] = rfbs;
  const [socket] = sockets;
  socket.open();
  socket.owner(true);
  rfb.dispatchEvent(new Event('connect'));
  assert.equal(rfb.scaleViewport, true);
  assert.equal(rfb.resizeSession, false);
  Object.assign(rfb.screen, { clientWidth: 480, clientHeight: 720 });
  observers[0].resize();
  assert.equal(rfb.resizeSession, true);
  socket.owner(false);
  assert.equal(rfb.resizeSession, false);
  socket.owner(true);
  assert.equal(rfb.resizeSession, true);
  rfb.screen.clientWidth = 1;
  observers[0].resize();
  assert.equal(rfb.resizeSession, false);
  let restored = false;
  let stopped = false;
  let prevented = false;
  const tree = view.render();
  assert.equal(find(tree, (node) => node.children?.includes('focusBrowser')), undefined);
  assert.equal(find(tree, (node) => node.props?.title !== undefined), undefined);
  assert.equal(find(tree, (node) => node.props?.role === 'status'), undefined);
  find(tree, (node) => node.props?.barRef).props.barRef.current = { focus() { restored = true; } };
  find(tree, (node) => node.props?.onKeyDownCapture).props.onKeyDownCapture({
    key: 'Escape', shiftKey: true, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
  });
  assert.equal(rfb.blurred && restored && stopped && prevented, true);
});

const agentStatus = (access = null, canGrant = true, provider = 'enabled') => ({ provider, canGrant, access });
const accessSwitch = (tree) => find(tree, (node) => node.props?.role === 'switch');
const accessAlert = (tree) => find(tree, (node) => node.props?.role === 'alert')?.children[0];

function mountAccess(t, sessionId = 'one') {
  let view;
  const hooks = mount((props) => view(props));
  view = makeAgentAccess(hooks.React);
  t.after(hooks.dispose);
  const tab = new AbortController();
  return (overrides) => hooks.render({ sessionId, tabSignal: tab.signal, visible: true, t: (key) => key, ...overrides });
}

test('agent opt-in grants during startup and revokes with a disconnected display', async (t) => {
  const requests = [];
  let launch;
  const mutations = [];
  t.mock.method(globalThis, 'fetch', (url, { body, signal }) => {
    const path = url.slice(API.length);
    requests.push([path, JSON.parse(body)]);
    if (path === '/view') return new Promise((resolve) => { launch = resolve; });
    if (path === '/agent/status') return response(agentStatus());
    if (path === '/browser/status') return response({ state: 'ready', generation: 'g1' });
    return new Promise((resolve) => mutations.push({ resolve, signal }));
  });
  const display = fakeDisplays(t);
  const view = mountView('one', new AbortController().signal, display);
  t.after(view.dispose);
  const access = mountAccess(t);
  const render = () => access(find(view.render(), (node) => node.props?.barRef).props);
  const button = () => accessSwitch(render()).props;
  const assertToolbarOnly = () => {
    const children = render().children.filter(Boolean);
    assert.equal(children.length, 1);
    assert.equal(children[0].props.role, 'group');
    const toggle = accessSwitch(children[0]);
    assert.equal(toggle.children[0], 'agentAccess');
    assert.equal(toggle.props['aria-describedby'], undefined);
  };
  assert.equal(button()['aria-checked'], false);
  assert.equal(button().disabled, true);
  assertToolbarOnly();
  await flush();
  assert.equal(view.phase(), 'starting');
  assert.equal(button().disabled, false);
  assertToolbarOnly();
  button().onClick();
  assert.equal(button()['aria-checked'], false);
  assert.equal(button().disabled, true);

  launch(response(ticket('g1')));
  await flush();
  display.rfbs[0].dispatchEvent(new Event('connect'));
  render();
  display.rfbs[0].dispatchEvent(new Event('disconnect'));
  render();
  assert.equal(mutations[0].signal.aborted, false);
  mutations[0].resolve(response(agentStatus({ sessionId: 'one' }, false)));
  await flush();
  assert.equal(view.phase(), 'disconnected');
  assert.equal(button()['aria-checked'], true);
  assert.equal(button().disabled, false);
  button().onClick();
  assert.equal(button()['aria-checked'], true);
  assert.equal(button().disabled, true);
  mutations[1].resolve(response(agentStatus()));
  await flush();
  assert.equal(button()['aria-checked'], false);
  assert.deepEqual(requests.filter(([path]) => path.startsWith('/agent/')), [
    ['/agent/status', { sessionId: 'one' }],
    ['/agent/grant', { sessionId: 'one' }],
    ['/agent/revoke', { sessionId: 'one' }],
  ]);
});

test('agent access reports Host errors and preserves the checked state until a confirmed response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const data = agentStatus();
  let statusError;
  let grantError = 'Could not grant access';
  t.mock.method(globalThis, 'fetch', (url) => {
    if (url.endsWith('/status')) return response(statusError
      ? { ok: false, code: 'status_failed', message: statusError } : data);
    if (url.endsWith('/grant')) {
      if (grantError) return response({ ok: false, code: 'grant_failed', message: grantError });
      data.access = { sessionId: 'one' };
      return response(data);
    }
    return response({ ok: false, code: 'revoke_failed', message: 'Could not revoke access' });
  });
  const render = mountAccess(t);
  const button = () => accessSwitch(render()).props;
  render();
  await flush();
  button().onClick();
  await flush();
  assert.equal(button()['aria-checked'], false);
  assert.equal(accessAlert(render()), 'Could not grant access (grant_failed)');
  grantError = null;
  button().onClick();
  await flush();
  assert.equal(button()['aria-checked'], true);
  assert.equal(accessAlert(render()), undefined);
  statusError = 'Could not check access';
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(button()['aria-checked'], true);
  assert.equal(button().disabled, false);
  assert.equal(accessAlert(render()), 'Could not check access (status_failed)');
  statusError = null;
  t.mock.timers.tick(2000);
  await flush();
  button().onClick();
  await flush();
  assert.equal(button()['aria-checked'], true);
  assert.equal(accessAlert(render()), 'Could not revoke access (revoke_failed)');
});

test('changing Sessions ignores a late mutation and never shows another Session’s authorization', async (t) => {
  const requests = [];
  let late;
  t.mock.method(globalThis, 'fetch', (url, { body, signal }) => {
    const path = url.slice(API.length);
    const payload = JSON.parse(body);
    requests.push([path, payload]);
    if (path === '/agent/grant') return new Promise((resolve) => { late = { resolve, signal }; });
    return response(payload.sessionId === 'one' ? agentStatus() : agentStatus({ sessionId: 'one' }, false, 'conflict'));
  });
  const render = mountAccess(t);
  render();
  await flush();
  accessSwitch(render()).props.onClick();
  const next = { sessionId: 'two' };
  assert.equal(accessSwitch(render(next)).props['aria-checked'], false);
  assert.equal(late.signal.aborted, true);
  late.resolve(response(agentStatus({ sessionId: 'one' })));
  await flush();
  const tree = render(next);
  const button = accessSwitch(tree).props;
  assert.equal(button['aria-checked'], false);
  assert.equal(button.disabled, true);
  assert.equal(accessAlert(tree), 'providerConflict');
  assert.deepEqual(requests, [
    ['/agent/status', { sessionId: 'one' }], ['/agent/grant', { sessionId: 'one' }],
    ['/agent/status', { sessionId: 'two' }],
  ]);
});
