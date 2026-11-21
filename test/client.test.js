import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { makeClient } from '../src/client/index.js';
import { createBrowserConnection, makeBrowserView } from '../src/client/browser-view.js';
import { makeNativeMenu } from '../src/client/native-menu.js';
import { post } from '../src/client/http.js';
import { accessErrors as accessErrorsStyle, overlay as overlayStyle } from '../src/client/styles.js';
import { settings as settingsStyles } from '../src/client/settings-styles.js';
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
      useId() { const index = cursor++; cells[index] ??= {}; return `id-${index}`; },
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
    dispose() { for (const cell of cells) cell?.dispose?.(); },
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

const renderFactorySlot = (name, props) => createElement(name, props);
const switchProps = (tree) => find(tree, (node) => node.type === 'input'
  && node.props.type === 'checkbox' && node.props.role === 'switch').props;
const switchLabel = (tree, id) => find(tree, (node) => node.type === 'label' && node.props.htmlFor === id);
const toggleSwitch = (control) => control.onChange({ currentTarget: { checked: !control.checked } });

function fakeMenus() {
  const contributions = new Map();
  let active;
  return {
    register(entry) {
      contributions.set(entry.target, entry);
      return () => contributions.delete(entry.target);
    },
    active: { getSnapshot: () => active },
    open(target) {
      active = target;
      return contributions.get(target.kind)?.resolve(target.value) ?? [];
    },
    close() { active = null; },
  };
}

function installTab() {
  let definition;
  let body;
  let title;
  const slots = [];
  const mounted = mount((props) => body(props));
  const { apply } = makeClient({ React: mounted.React, RFB: null });
  apply({
    effect: (mount) => mount(),
    inject(services) { assert.deepEqual(services, ['configForms', 'slots']); },
    contextMenus: fakeMenus(),
    connection: { openWebSocket: (path) => `owned-host:${path}` },
    locale: { register() {}, bind: () => (key) => key },
    sidebarRightTabs: { register: (entry) => { definition = entry; } },
    slots: {
      inject(name, mount) { slots.push(name); return mount(); },
      register(options, render) {
        assert.equal(options.key, definition.id);
        if (options.name === 'sidebar.right.pane.tab.title') title = render;
        else body = render;
      },
    },
  });
  return { slots, definition, body: mounted.render, title };
}

test('native guide registers only its right-sidebar tab and binds the current visible Session', () => {
  const { slots, definition, body } = installTab();
  assert.deepEqual(slots, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
  assert.equal(definition.id, 'dsh-plugin-workspace-browser');
  assert.equal(definition.kind, 'dsh-plugin-workspace-browser');
  assert.equal(definition.keepMounted, true);
  assert.equal(definition.guide[0].title(), 'open');
  assert.equal(definition.guide[0].description, undefined);

  let closed = 0;
  const occurrence = new AbortController();
  const tab = { visible: true, signal: occurrence.signal, actions: { close() { closed++; occurrence.abort(); } } };
  const a = { workspaceId: 'a', sessionIds: ['blank', 'other'] };
  const b = { workspaceId: 'b', sessionIds: ['elsewhere'] };
  const render = (sessionId, items, phase = 'ready') => body({
    t: (key) => key, sessionId, useTabInfo: () => ({ tab }), renderFactorySlot,
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

test('titles passively follow only their own tab occurrence, leaving the launcher unchanged', () => {
  const { body, title, definition } = installTab();
  const props = () => {
    const tab = { signal: new AbortController().signal, visible: false };
    return { sessionId: 'one', useTabInfo: () => ({ tab }), t: (key) => key,
      useWorkspaces: (select) => select({ phase: 'ready', items: [{ workspaceId: 'w', sessionIds: ['one'] }] }) };
  };
  const first = props();
  const other = props();
  assert.equal(title(first), 'title');
  const { onTitle } = body(first).children[0].props;
  onTitle('Example — Chromium');
  assert.equal(title(first), 'Example — Chromium');
  assert.equal(title(other), 'title');
  assert.equal(definition.title(), 'title');
  onTitle(undefined);
  assert.equal(title(first), 'title');
});

function installSettings() {
  let contribution;
  let Component;
  let snapshot = { status: 'ready', value: { agentEnabled: true, idleTimeoutMinutes: 2, allowedWebOrigins: [] }, writable: true, revision: 1 };
  const writes = [];
  const form = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    async mutate(ops, revision) {
      writes.push({ ops, revision });
      snapshot = { ...snapshot, value: { ...snapshot.value, [ops[0].path[0]]: ops[0].value }, revision: revision + 1 };
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
  const disposers = [];
  const menus = fakeMenus();
  apply({
    effect: (setup) => setup(),
    connection: {}, slots, contextMenus: menus,
    locale: { register() {}, bind: () => (key) => key },
    sidebarRightTabs: { register() {} },
    inject(services, attach) {
      assert.deepEqual(services, ['configForms', 'slots']);
      attach({
        effect: (setup) => { disposers.push(setup()); }, slots,
        configForms: {
          get(entry) { assert.equal(entry, 'dsh-plugin-workspace-browser'); return form; },
          whileServed(entries, register) {
            assert.deepEqual(entries, ['dsh-plugin-workspace-browser']);
            let unregister;
            namespaceAvailable = () => { unregister = register(); };
            return () => unregister?.();
          },
        },
      });
    },
  });
  const t = (key) => key;
  function renderSection(index, beforeCommit) {
    const page = contribution.render({ t, view: 'page' });
    assert.equal(page.type, 'div');
    assert.equal(page.children.length, 6);
    assert.equal(page.children[0].type, 'style');
    const entry = page.children[index + 1];
    Component = entry.type;
    return mounted.render(entry.props, beforeCommit);
  }
  return {
    contribution: () => contribution,
    serve: namespaceAvailable,
    dispose: () => { mounted.dispose(); for (const dispose of disposers.reverse()) dispose(); },
    unmount: mounted.dispose,
    writes, form,
    update: (next) => { snapshot = { ...snapshot, ...next }; },
    renderOrigins: () => renderSection(3),
    renderAccount: () => renderSection(4),
    renderIdle: () => renderSection(1),
    renderEnvironment: (beforeCommit) => renderSection(2, beforeCommit),
    render() {
      const page = renderSection(0);
      assert.equal(find(page, (item) => item.type === 'contextMenu.button'), undefined);
      const control = switchProps(page);
      const description = find(page, (item) => item.children.includes('agentSettingsDescription'));
      assert.equal(control['aria-describedby'], description.props.id);
      return {
        control, label: switchLabel(page, control.id),
        notice: find(page, (item) => item.props?.role === 'status')?.children[0],
      };
    },
  };
}

test('the served bundle settings expose a direct Switch backed by the DSH configuration form', async (t) => {
  const settings = installSettings();
  t.after(settings.dispose);
  assert.equal(settings.contribution(), undefined);
  settings.serve();
  const { options, render } = settings.contribution();
  assert.deepEqual(options, {
    name: 'plugins.bundle.config', key: 'dsh-plugin-workspace-browser', locale: 'dsh-plugin-workspace-browser',
  });
  assert.equal(render({ view: 'summary' }), null);
  const initial = settings.render();
  assert.equal(initial.label.children[0], 'agentSettingsLabel');
  assert.equal(initial.control.checked, true);
  assert.equal(initial.control.disabled, false);
  assert.deepEqual(settings.writes, []);
  await toggleSwitch(initial.control);
  assert.deepEqual(settings.writes, [{ ops: [{ op: 'set', path: ['agentEnabled'], value: false }], revision: 1 }]);
  const saved = settings.render();
  assert.ok(!saved.notice);
  assert.equal(saved.control.checked, false);
  assert.equal(saved.control.id, initial.control.id);
  settings.unmount();
  await toggleSwitch(saved.control);
  assert.equal(settings.writes.length, 1);
  for (const locale of ['en', 'zh']) {
    const messages = JSON.parse(readFileSync(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8'));
    assert.equal(messages.meta.title, 'dsh-plugin-workspace-browser');
    for (const key of ['agentSettingsHeading', 'agentSettingsDescription', 'sessionAgentAccess', 'environmentBuildingButton']) {
      assert.ok(messages[key]);
    }
  }
});

test('idle timeout validates minutes, saves zero, and guards pending and read-only edits', async (t) => {
  const settings = installSettings();
  t.after(settings.dispose);
  settings.serve();
  function controls() {
    const page = settings.renderIdle();
    return { input: find(page, node => node.type === 'input').props,
      save: find(page, node => node.type === 'button').props,
      notice: find(page, node => node.props?.role === 'status').children[0] };
  }
  const edit = value => controls().input.onChange({ currentTarget: { value } });
  assert.equal(controls().input.value, '2');
  for (const value of ['', '-1', '1.5', '1441']) {
    edit(value);
    assert.equal(controls().notice, 'idleInvalid');
    await controls().save.onClick();
  }
  assert.deepEqual(settings.writes, []);
  edit('0');
  await controls().save.onClick();
  assert.deepEqual(settings.writes, [{ ops: [{ op: 'set', path: ['idleTimeoutMinutes'], value: 0 }], revision: 1 }]);
  assert.equal(controls().input.value, '0');
  edit('1440');
  let finish;
  settings.form.mutate = () => new Promise(resolve => { finish = resolve; });
  const saving = controls().save.onClick();
  assert.equal(controls().notice, 'agentSettingsSaving');
  assert.ok(controls().input.disabled && controls().save.disabled);
  finish(false);
  await saving;
  assert.equal(controls().notice, 'agentSettingsNotSaved');
  settings.update({ writable: false });
  assert.equal(controls().notice, 'agentSettingsReadOnly');
  assert.ok(controls().input.disabled && controls().save.disabled);
});

function installOriginSettings(t) {
  const settings = installSettings();
  t.after(settings.dispose);
  settings.serve();
  function controls() {
    const tree = settings.renderOrigins();
    return {
      input: find(tree, node => node.type === 'textarea').props,
      save: find(tree, node => node.type === 'button').props,
      notice: find(tree, node => node.props?.role === 'status').children[0],
    };
  }
  return { ...settings, controls, edit: value => controls().input.onChange({ currentTarget: { value } }) };
}

test('reverse proxy settings default to empty and save only canonical origins at the displayed revision', async (t) => {
  const { form, controls, edit, update, writes } = installOriginSettings(t);
  assert.equal(controls().input.value, '');
  assert.equal(controls().save.disabled, true);
  const first = 'https://first.example';
  const second = 'https://second.example:8443';
  update({ value: { ...form.getSnapshot().value, allowedWebOrigins: [first] }, revision: 7 });
  assert.equal(controls().input.value, first);
  edit(`${first}\n \nHTTPS://SECOND.EXAMPLE:8443/\nhttps://FIRST.EXAMPLE:443/`);
  assert.deepEqual(writes, []);
  await controls().save.onClick();
  assert.equal(controls().input.value, `${first}\n${second}`);
  edit(second);
  await controls().save.onClick();
  assert.equal(controls().input.value, second);
  edit('');
  await controls().save.onClick();
  assert.equal(controls().input.value, '');
  assert.deepEqual(writes, [[first, second], [second], []].map((value, i) => ({
    ops: [{ op: 'set', path: ['allowedWebOrigins'], value }], revision: 7 + i,
  })));
});

test('reverse proxy settings cannot edit a field omitted by the served schema', async (t) => {
  const { controls, update, writes } = installOriginSettings(t);
  update({ value: { idleTimeoutMinutes: 2, agentEnabled: true } });
  const { input, save, notice } = controls();
  assert.equal(notice, 'agentSettingsUnavailable');
  assert.ok(input.disabled && save.disabled);
  await save.onClick();
  assert.deepEqual(writes, []);
});

test('reverse proxy settings reject an invalid line without partially saving and guard stale and read-only edits', async (t) => {
  const { controls, edit, update, writes } = installOriginSettings(t);
  const valid = 'https://web.example';
  for (const line of ['https://web.example/path', 'https://*.example', 'not an origin']) {
    edit(`${valid}\n${line}`);
    const invalid = controls();
    assert.equal(invalid.input['aria-invalid'], true);
    assert.ok(invalid.notice);
    assert.equal(invalid.save.disabled, true);
    await invalid.save.onClick();
  }
  edit(valid);
  const stale = controls().save;
  update({ value: { allowedWebOrigins: ['https://new.example'] }, revision: 2 });
  await stale.onClick();
  assert.equal(controls().notice, 'agentSettingsChanged');
  assert.equal(controls().input.value, 'https://new.example');
  assert.equal(controls().save.disabled, true);
  edit(valid);
  const revoked = controls().save;
  update({ writable: false });
  await revoked.onClick();
  assert.equal(controls().notice, 'agentSettingsReadOnly');
  assert.ok(controls().input.disabled && controls().save.disabled);
  assert.deepEqual(writes, []);
});

test('reverse proxy settings prevent duplicate saves and preserve the draft after a failed write', async (t) => {
  const { form, controls, edit } = installOriginSettings(t);
  edit('https://web.example');
  let finish;
  let attempts = 0;
  form.mutate = () => { attempts++; return new Promise(resolve => { finish = resolve; }); };
  const save = controls().save.onClick;
  const pending = save();
  await save();
  assert.equal(attempts, 1);
  assert.equal(controls().notice, 'agentSettingsSaving');
  assert.ok(controls().input.disabled && controls().save.disabled);
  finish(false);
  await pending;
  assert.equal(controls().notice, 'agentSettingsNotSaved');
  assert.equal(controls().input.value, 'https://web.example');
  assert.equal(controls().save.disabled, false);
  form.mutate = async () => { throw new Error('Disconnected'); };
  await controls().save.onClick();
  assert.equal(controls().notice, 'agentSettingsNotSaved');
});

test('settings guard unavailable, read-only, stale and pending actions and report failures', async (t) => {
  const settings = installSettings();
  t.after(settings.dispose);
  settings.serve();
  settings.update({ status: 'loading' });
  assert.equal(settings.render().notice, 'agentSettingsLoading');
  await toggleSwitch(settings.render().control);
  settings.update({ status: 'error' });
  assert.equal(settings.render().notice, 'agentSettingsUnavailable');
  assert.equal(settings.render().control.disabled, true);
  settings.update({ status: 'ready', writable: false });
  const readOnly = settings.render();
  assert.equal(readOnly.control.disabled, true);
  await toggleSwitch(readOnly.control);
  assert.equal(readOnly.notice, 'agentSettingsReadOnly');
  settings.update({ writable: true });
  const stale = settings.render().control;
  settings.update({ revision: 2 });
  await toggleSwitch(stale);
  assert.equal(settings.render().notice, 'agentSettingsChanged');
  assert.deepEqual(settings.writes, []);

  let finish;
  let started = 0;
  settings.form.mutate = () => { started++; return new Promise((resolve) => { finish = resolve; }); };
  const action = settings.render().control;
  const pending = toggleSwitch(action);
  await toggleSwitch(action);
  const saving = settings.render();
  await toggleSwitch(saving.control);
  assert.equal(started, 1);
  assert.equal(saving.notice, 'agentSettingsSaving');
  assert.equal(saving.control.disabled, false);
  assert.equal(saving.control['aria-disabled'], true);
  assert.equal(saving.control.checked, true);
  assert.equal(saving.control['aria-busy'], true);
  finish(false);
  await pending;
  assert.equal(settings.render().notice, 'agentSettingsNotSaved');
  settings.form.mutate = async () => { throw new Error('Disconnected'); };
  await toggleSwitch(settings.render().control);
  assert.equal(settings.render().control.checked, true);
  assert.equal(settings.render().notice, 'agentSettingsNotSaved');
});

function mountView(sessionId, tabSignal, overrides = {}) {
  let view;
  const hooks = mount((props) => view(props));
  const menus = fakeMenus();
  const menu = makeNativeMenu(hooks.React, 'dsh-plugin-workspace-browser:browser');
  menu.attach(menus);
  view = makeBrowserView(hooks.React, overrides.RFB, menu);
  const render = () => {
    const tree = hooks.render({
      sessionId, tabSignal, visible: true, onClosed() {}, t: (key) => key, renderFactorySlot, ...overrides,
    }, (tree) => {
      const target = find(tree, (node) => node.props?.onKeyDownCapture);
      target.props.ref.current ??= { appendChild() {} };
    });
    return { tree, control: find(tree, (node) => node.type === 'contextMenu.button') };
  };
  render();
  return {
    render: () => render().tree,
    control: () => render().control.props,
    access: () => switchProps(render().tree),
    actions: () => menus.open(render().control.props.target),
    status: () => {
      const overlay = find(render().tree, (node) => node.props?.style === overlayStyle);
      return overlay?.children[0]?.children[0];
    },
    errors: () => find(render().tree, (node) => node.props?.style === accessErrorsStyle)
      ?.children.map((child) => child.children[0]),
    dispose: () => hooks.dispose(),
  };
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
  assert.deepEqual(pending.filter(({ url }) => url.endsWith('/view')).map(({ body }) => body),
    [{ sessionId: 'first' }, { sessionId: 'next' }]);
  const viewRequests = pending.filter(({ url }) => url.endsWith('/view'));
  firstTab.abort();
  assert.equal(viewRequests[0].signal.aborted, true);
  assert.equal(viewRequests[1].signal.aborted, false);
  viewRequests[0].resolve({ ok: true, json: async () => ({ ok: true, ticket: 'stale' }) });
  viewRequests[1].resolve({ ok: false, json: async () => ({ ok: false, code: 'runner_isolation_failed', message: 'test' }) });
  await flush();
  assert.equal(first.status(), 'starting');
  assert.equal(next.status(), 'runnerIsolationFailed');
});

test('profile and environment startup failures use distinct localized messages', async (t) => {
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
    ['runner_workspace_invalid', 'runnerWorkspaceInvalid'],
    ['runner_workspace_permission_denied', 'runnerWorkspacePermissionDenied'],
    ['runner_isolation_failed', 'runnerIsolationFailed'],
    ['docker_config_invalid', 'dockerConfigInvalid'],
    ['docker_cli_missing', 'dockerCliMissing'],
    ['docker_cli_unavailable', 'dockerCliUnavailable'],
    ['docker_engine_unavailable', 'dockerEngineUnavailable'],
    ['docker_engine_incompatible', 'dockerEngineIncompatible'],
    ['runner_image_missing', 'runnerImageMissing'],
    ['runner_image_incompatible', 'runnerImageIncompatible'],
    ['runner_build_inputs_missing', 'runnerBuildInputsMissing'],
    ['runner_build_failed', 'runnerBuildFailed'],
    ['runner_build_timeout', 'runnerBuildTimeout'],
    ['runner_build_image_invalid', 'runnerBuildImageInvalid'],
  ];
  for (const [code, key] of cases) {
    responseCode = code;
    const view = mountView('workspace', new AbortController().signal);
    t.after(view.dispose);
    await flush();
    assert.equal(view.status(), key);
  }
  for (const locale of ['zh', 'en']) {
    const messages = JSON.parse(readFileSync(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8'));
    const texts = cases.map(([, key]) => messages[key]);
    assert.ok(texts.every(text => typeof text === 'string' && text.trim()));
    assert.equal(new Set(texts).size, cases.length);
  }
});

test('Linux account control is hidden unless the Host reports a root Linux platform', async t => {
  const form = installSettings();
  t.after(form.dispose);
  form.serve();
  t.mock.method(globalThis, 'fetch', async () => response({ root: false }));
  assert.equal(form.renderAccount(), null);
  await flush();
  assert.equal(form.renderAccount(), null);
});

test('a root Host shows the account control before a value is stored and saves through its revision', async t => {
  const form = installSettings();
  t.after(form.dispose);
  form.serve();
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(String(url), /\/environment\/platform$/);
    return response({ root: true });
  });
  form.update({ revision: 7 });
  assert.equal(form.renderAccount(), null);
  await flush();
  const input = find(form.renderAccount(), row => row.type === 'input');
  assert.equal(input.props.value, '');
  input.props.onChange({ currentTarget: { value: 'reader' } });
  const save = find(form.renderAccount(), row => row.type === 'button');
  await save.props.onClick();
  assert.deepEqual(form.writes, [{ ops: [{ op: 'set', path: ['rootBrowserAccount'], value: 'reader' }], revision: 7 }]);
});

test('a rejected account write reports failure only when the value did not land', async t => {
  const form = installSettings();
  t.after(form.dispose);
  form.serve();
  t.mock.method(globalThis, 'fetch', async () => response({ root: true }));
  form.update({ revision: 7 });
  form.renderAccount();
  await flush();
  const save = () => find(form.renderAccount(), row => row.type === 'button').props;
  const type = value => find(form.renderAccount(), row => row.type === 'input').props.onChange({ currentTarget: { value } });
  // The Host reloads around the mutation: the reply is a rejection, but the value landed.
  form.form.mutate = async (ops, revision) => { form.update({ value: { ...form.form.getSnapshot().value, ...{ [ops[0].path[0]]: ops[0].value } }, revision: revision + 1 }); return false; };
  type('undefined');
  await save().onClick();
  assert.equal(save().disabled, true);
  assert.equal(find(form.renderAccount(), row => row.children.includes('agentSettingsNotSaved')), undefined);
  // A rejection that leaves the value unchanged is a real failure.
  form.form.mutate = async () => false;
  type('');
  type('other');
  await save().onClick();
  assert.ok(find(form.renderAccount(), row => row.children.includes('agentSettingsNotSaved')));
});

test('root environment reports the resolved account and advisory ACL status', async t => {
  t.mock.method(globalThis, 'fetch', async url => url.endsWith('/build/status') ? envResponse({ state: 'idle' }) : envResponse({ checks: [
    ...['dockerConfig', 'dockerCli', 'dockerEngine', 'runnerImage'].map(id => ({ id, status: 'pass' })),
    { id: 'rootBrowserAccount', status: 'pass', account: { name: 'reader', uid: 1050, gid: 1060 } },
    { id: 'workspaceAclTools', status: 'warn', code: 'workspace_acl_tools_missing' },
  ] }));
  const env = mountEnvironment(t);
  env.render(); await flush();
  await env.check().onClick();
  assert.ok(env.byLabel('workspaceAclToolsMissing'));
  assert.ok(env.byLabel('environmentCheckWarn'));
  assert.ok(find(env.render(), row => row.children.some(text => typeof text === 'string' && text.includes('reader') && text.includes('1050'))));
  assert.equal(env.build(), undefined);
});

function response(data) {
  return { ok: data.ok !== false, json: async () => ({ ok: true, ...data }) };
}

const envResponse = (data) => response({ runnerVersion: '2026.11-test', ...data });

function mountEnvironment(t) {
  const settings = installSettings();
  settings.serve();
  t.after(settings.dispose);
  const render = settings.renderEnvironment;
  const byLabel = (label) => find(render(), (node) => node.children.includes(label));
  // The live region's text nodes, so a test can assert what the status line says.
  const notice = () => {
    const region = find(render(), (node) => node.props?.role === 'status' && node.props?.className);
    const lines = (region?.children ?? []).filter((child) => child && typeof child === 'object');
    return lines.length ? lines.map((line) => line.children[0]).join(' ') : undefined;
  };
  return {
    render, unmount: settings.unmount, byLabel, notice,
    check: () => (byLabel('environmentRecheckButton') ?? byLabel('environmentCheckButton')).props,
    build: () => (byLabel('environmentBuildButton') ?? byLabel('environmentRebuildButton')
      ?? byLabel('environmentRetryBuildButton'))?.props,
  };
}

test('environment settings check manually and only build for a missing or incompatible image', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  const statusPath = '/environment/build/status';
  const checkPath = '/environment/check';
  const buildPath = '/environment/build';
  let status = 'idle';
  let prereqsReady = false;
  let imageError = 'runner_image_missing';
  t.mock.method(globalThis, 'fetch', async (url, { body, method }) => {
    const path = url.slice(API.length);
    assert.equal(method, 'POST');
    assert.deepEqual(JSON.parse(body), {});
    requests.push(path);
    if (path === statusPath) return envResponse({ state: status });
    if (path === buildPath) return envResponse({ state: 'building' });
    assert.equal(path, checkPath);
    return envResponse({ checks: [
      { id: 'dockerConfig', status: 'pass' },
      prereqsReady ? { id: 'dockerCli', status: 'pass' }
        : { id: 'dockerCli', status: 'fail', code: 'docker_cli_unavailable' },
      { id: 'dockerEngine', status: prereqsReady ? 'pass' : 'skipped' },
      { id: 'runnerImage', status: prereqsReady ? (imageError ? 'fail' : 'pass') : 'skipped', code: imageError },
    ] });
  });

  const env = mountEnvironment(t);
  assert.equal(env.build(), undefined);
  assert.equal(env.check()['aria-disabled'], true);
  await flush();
  assert.equal(env.byLabel('2026.11-test').type, 'code');
  assert.equal(env.check()['aria-disabled'], undefined);
  t.mock.timers.tick(4000);
  assert.deepEqual(requests, [statusPath]);

  await env.check().onClick();
  assert.ok(env.byLabel('environmentCheckSkipped'));
  assert.ok(env.byLabel('dockerCliUnavailable'));
  assert.equal(env.build(), undefined);
  prereqsReady = true;
  imageError = undefined;
  await env.check().onClick();
  // A passing image needs no extra sentence: its row already reads as passed.
  assert.equal(env.byLabel('environmentRunnerImage').type, 'div');
  assert.ok(env.byLabel('environmentCheckPass'));
  assert.equal(env.notice(), undefined);
  assert.equal(env.build(), undefined);
  imageError = 'runner_image_incompatible';
  await env.check().onClick();
  assert.ok(env.byLabel('environmentRebuildButton'));
  imageError = 'runner_image_missing';
  await env.check().onClick();
  const build = env.byLabel('environmentBuildButton').props;
  assert.equal(build['aria-describedby'], env.byLabel('environmentBuildHelp').props.id);

  const pending = build.onClick();
  await build.onClick();
  await pending;
  assert.ok(env.byLabel('environmentBuilding'));
  const working = env.byLabel('environmentBuildingButton');
  assert.equal(working.props['aria-disabled'], true);
  assert.equal(working.props['aria-busy'], true);
  assert.ok(working.props.className.includes(settingsStyles.buttonProgress));
  assert.ok(working.props.className.includes(settingsStyles.button));
  const spinner = find(working, (node) => node.props?.className === settingsStyles.spinner);
  assert.equal(spinner.props['aria-hidden'], true);
  assert.deepEqual(requests, [statusPath, checkPath, checkPath, checkPath, checkPath, buildPath]);
  t.mock.timers.tick(1999);
  assert.equal(requests.length, 6);
  status = 'building';
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(requests, [statusPath, checkPath, checkPath, checkPath, checkPath, buildPath, statusPath]);
  status = 'succeeded';
  t.mock.timers.tick(2000);
  await flush();
  assert.deepEqual(requests, [statusPath, checkPath, checkPath, checkPath, checkPath, buildPath, statusPath, statusPath, checkPath]);
  assert.ok(env.byLabel('environmentBuildSucceeded'));
  assert.ok(env.byLabel('environmentCheckPass'));
  // The stub still reports a missing image, so the action returns, enabled and settled.
  assert.equal(env.build()['aria-disabled'], undefined);
  assert.equal(env.byLabel('environmentBuildingButton'), undefined);
  t.mock.timers.tick(4000);
  assert.equal(requests.length, 9);
  const page = env.render();
  const checkButton = find(page, (node) => node.type === 'button' && node.children.includes('environmentRecheckButton'));
  assert.ok(checkButton.props.className.includes(settingsStyles.buttonOutline));
  assert.equal(find(page, (node) => node.props?.className === settingsStyles.spinner), undefined);
});

test('environment settings resume an existing build, show failure, and do not check or poll after failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, `${API}/environment/build/status`);
    if (++polls === 1) return envResponse({ state: 'building' });
    if (polls === 2) throw new TypeError('Network error');
    return envResponse({ state: 'failed', code: 'runner_build_timeout' });
  });
  const env = mountEnvironment(t);
  env.render();
  await flush();
  assert.ok(env.byLabel('environmentBuilding'));
  const resumed = env.byLabel('environmentBuildingButton');
  assert.equal(resumed.props['aria-busy'], true);
  assert.equal(resumed.props['aria-disabled'], true);
  assert.ok(find(resumed, (node) => node.props?.className === settingsStyles.spinner));
  t.mock.timers.tick(2000);
  await flush();
  assert.ok(env.byLabel('environmentBuildStatusError'));
  // An unknown state has no build action and polls no further; the status retry takes its place.
  assert.equal(env.build(), undefined);
  const retryStatus = env.byLabel('environmentRetryStatusButton');
  assert.equal(retryStatus.props['aria-disabled'], undefined);
  t.mock.timers.tick(4000);
  assert.equal(polls, 2);
  await retryStatus.props.onClick();
  await flush();
  assert.equal(env.byLabel('runnerBuildTimeout').props.role, 'alert');
  assert.equal(env.byLabel('environmentBuildingButton'), undefined);
  // The failed build offers a retry, enabled again once the status is known.
  assert.ok(env.byLabel('environmentRetryBuildButton'));
  assert.equal(env.build()['aria-disabled'], undefined);
  t.mock.timers.tick(4000);
  assert.equal(polls, 3);
});

test('a failed build keeps its retry after a recheck, and loses it once the image passes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let status = 'idle';
  let imageStatus = 'fail';
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = url.slice(API.length);
    if (path === '/environment/build/status') return envResponse({ state: status });
    if (path === '/environment/build') {
      status = 'building';
      return envResponse({ state: 'building' });
    }
    return envResponse({ checks: [
      { id: 'dockerConfig', status: 'pass' }, { id: 'dockerCli', status: 'pass' }, { id: 'dockerEngine', status: 'pass' },
      { id: 'runnerImage', status: imageStatus, code: imageStatus === 'fail' ? 'runner_image_missing' : undefined },
    ] });
  });
  const env = mountEnvironment(t);
  env.render();
  await flush();
  await env.check().onClick();
  await env.build().onClick();
  await flush();
  assert.ok(env.byLabel('environmentBuildingButton'));
  assert.ok(env.byLabel('environmentBuilding'));

  status = 'failed';
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(env.byLabel('runnerBuildFailed').props.role, 'alert');
  assert.equal(env.byLabel('environmentBuildingButton'), undefined);
  assert.ok(env.byLabel('environmentRetryBuildButton'));

  // A recheck clears the failure's checks; the retry must survive it.
  await env.check().onClick();
  assert.ok(env.byLabel('runnerImageMissing'));
  assert.ok(env.byLabel('environmentRetryBuildButton'));

  // Once the image passes, the retry is withdrawn with the check-driven action.
  imageStatus = 'pass';
  await env.check().onClick();
  assert.ok(env.byLabel('environmentCheckPass'));
  assert.equal(env.notice(), undefined);
  assert.equal(env.byLabel('environmentRetryBuildButton'), undefined);
  assert.equal(env.build(), undefined);
});

test('unmounting environment settings cancels timers and ignores an in-flight status response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = [];
  t.mock.method(globalThis, 'fetch', (url, { signal }) => new Promise((resolve) => {
    assert.equal(url, `${API}/environment/build/status`);
    pending.push({ resolve, signal });
  }));

  const waiting = mountEnvironment(t);
  waiting.render();
  pending[0].resolve(envResponse({ state: 'building' }));
  await flush();
  waiting.unmount();
  t.mock.timers.tick(2000);
  assert.equal(pending.length, 1);

  const polling = mountEnvironment(t);
  polling.render();
  pending[1].resolve(envResponse({ state: 'building' }));
  await flush();
  t.mock.timers.tick(2000);
  assert.equal(pending[2].signal.aborted, false);
  t.mock.timers.tick(4000);
  assert.equal(pending.length, 3);
  polling.unmount();
  assert.equal(pending[2].signal.aborted, true);
  pending[2].resolve(envResponse({ state: 'succeeded' }));
  await flush();
  t.mock.timers.tick(4000);
  assert.equal(pending.length, 3);
});

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

test('a tab title follows its own run title and clears on retire', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let status = { state: 'ready', generation: 'g1', windowTitle: '  Docs — Chromium  ' };
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    const payload = JSON.parse(body);
    return url.endsWith('/status') ? response(status) : response(ticket(payload.generation ?? 'g1'));
  });
  const titles = [];
  const display = fakeDisplays(t);
  const tab = new AbortController();
  const client = createBrowserConnection({
    sessionId: 'one', tabSignal: tab.signal, target: { appendChild() {} }, ...display,
    onClosed() {}, onChange() {}, onTitle: (title) => titles.push(title),
  });
  t.after(client.dispose);
  client.setVisible(true);
  client.setVisible(false);
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(titles.at(-1), 'Docs — Chromium');
  status = { state: 'ready', generation: 'g1', windowTitle: '   ' };
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(titles.at(-1), undefined);
  status = { state: 'ready', generation: 'g1', windowTitle: 'Later — Chromium' };
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(titles.at(-1), 'Later — Chromium');
  status = { state: 'closed' };
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(titles.at(-1), undefined);
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
  const toolbar = find(tree, (node) => node.props?.tabIndex === -1);
  assert.equal(switchProps(toolbar).role, 'switch');
  const commands = find(toolbar, (node) => node.children?.some((child) => child?.type === 'contextMenu.button'));
  commands.props.ref.current = {
    querySelector(selector) {
      assert.equal(selector, 'button');
      return { focus() { restored = true; } };
    },
  };
  find(tree, (node) => node.props?.onKeyDownCapture).props.onKeyDownCapture({
    key: 'Escape', shiftKey: true, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
  });
  assert.equal(rfb.blurred && restored && stopped && prevented, true);
});

const agentStatus = (access = null, canGrant = true, provider = 'enabled') => ({ provider, canGrant, access });
const accessAlert = (errors) => errors?.[0];

test('the toolbar Switch follows the confirmed Session grant independently of browser commands', async (t) => {
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
  const actions = () => view.actions();
  const describe = () => actions().map(({ id, label, disabled, danger }) => [id, label, disabled, danger]);
  assert.deepEqual(describe(), [
    ['restart', 'restartBrowser', true, undefined],
    ['close', 'closeBrowser', true, true],
  ]);
  const initial = view.access();
  assert.equal(switchLabel(view.render(), initial.id).children[0], 'sessionAgentAccess');
  assert.equal(initial.disabled, true);
  await toggleSwitch(initial);
  await flush();
  assert.equal(view.status(), 'starting');
  const grant = view.access();
  assert.equal(grant.id, initial.id);
  assert.equal(grant.disabled, false);
  assert.equal(grant.checked, false);
  void toggleSwitch(grant);
  await toggleSwitch(grant);
  const granting = view.access();
  assert.equal(granting.disabled, false);
  assert.equal(granting['aria-disabled'], true);
  assert.equal(granting.checked, false);
  assert.equal(granting['aria-busy'], true);
  await toggleSwitch(granting);

  launch(response(ticket('g1')));
  await flush();
  display.rfbs[0].dispatchEvent(new Event('connect'));
  view.render();
  display.rfbs[0].dispatchEvent(new Event('disconnect'));
  view.render();
  assert.equal(mutations[0].signal.aborted, false);
  mutations[0].resolve(response(agentStatus({ sessionId: 'one' }, false)));
  await flush();
  assert.equal(view.status(), 'disconnected');
  assert.deepEqual(describe().slice(2), [
    ['retry', 'reconnect', undefined, undefined],
  ]);
  assert.equal(view.access().checked, true);
  assert.equal(view.access().disabled, false);
  void toggleSwitch(view.access());
  assert.equal(view.access()['aria-disabled'], true);
  assert.equal(view.access().checked, true);
  mutations[1].resolve(response(agentStatus()));
  await flush();
  assert.equal(view.access().checked, false);
  assert.deepEqual(requests.filter(([path]) => path.startsWith('/agent/')), [
    ['/agent/status', { sessionId: 'one' }],
    ['/agent/grant', { sessionId: 'one' }],
    ['/agent/revoke', { sessionId: 'one' }],
  ]);
});

test('agent access reports Host errors and preserves the confirmed state', async (t) => {
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
  const view = mountView('one', new AbortController().signal);
  t.after(view.dispose);
  await flush();
  await toggleSwitch(view.access());
  assert.equal(view.access().checked, false);
  assert.equal(accessAlert(view.errors()), 'Could not grant access (grant_failed)');
  grantError = null;
  await toggleSwitch(view.access());
  assert.equal(view.access().checked, true);
  assert.equal(accessAlert(view.errors()), undefined);
  statusError = 'Could not check access';
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(view.access().checked, true);
  assert.equal(view.access().disabled, false);
  assert.equal(accessAlert(view.errors()), 'Could not check access (status_failed)');
  statusError = null;
  t.mock.timers.tick(2000);
  await flush();
  await toggleSwitch(view.access());
  assert.equal(view.access().checked, true);
  assert.equal(accessAlert(view.errors()), 'Could not revoke access (revoke_failed)');
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
  let sessionId = 'one';
  const tab = new AbortController();
  const menus = fakeMenus();
  let view;
  const hooks = mount((props) => view(props));
  const menu = makeNativeMenu(hooks.React, 'dsh-plugin-workspace-browser:browser');
  menu.attach(menus);
  view = makeBrowserView(hooks.React, null, menu);
  t.after(hooks.dispose);
  const render = () => hooks.render({
    sessionId, tabSignal: tab.signal, visible: true, onClosed() {}, t: (key) => key, renderFactorySlot,
  });
  render();
  await flush();
  const first = switchProps(render());
  assert.equal(first.checked, false);
  void toggleSwitch(first);
  assert.equal(late.signal.aborted, false);
  sessionId = 'two';
  const transitioning = switchProps(render());
  assert.equal(transitioning.checked, false);
  assert.ok(transitioning.disabled || transitioning['aria-disabled']);
  assert.equal(late.signal.aborted, true);
  late.resolve(response(agentStatus({ sessionId: 'one' })));
  await flush();
  const next = render();
  assert.equal(accessAlert(find(next, (node) => node.props?.style === accessErrorsStyle)
    ?.children.map((child) => child.children[0])), 'providerConflict');
  assert.equal(switchProps(next).checked, false);
  assert.equal(switchProps(next).disabled, true);
  await toggleSwitch(first);
  await toggleSwitch(switchProps(next));
  assert.deepEqual(requests, [
    ['/view', { sessionId: 'one' }], ['/agent/status', { sessionId: 'one' }],
    ['/agent/grant', { sessionId: 'one' }],
    ['/view', { sessionId: 'two' }], ['/agent/status', { sessionId: 'two' }],
  ]);
});
