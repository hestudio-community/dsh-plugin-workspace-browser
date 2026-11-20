import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgent, parseAction } from '../src/host/agent.js';
import { isPublicIPv4, resolvePublicIPv4 } from '../src/host/egress.js';
import { apply, inject } from '../src/host/index.js';
import { createPool } from '../src/host/pool.js';
import { registerWeb } from '../src/host/web.js';
import { API, DESKTOP_REQUEST_HEADER, DESKTOP_REQUEST_VERSION } from '../src/shared/protocol.js';

const origin = 'https://example.com';

test('DNS answers are pinned only if every A record belongs to public IPv4 space', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicIPv4(address), false, address);
  }
  assert.equal(await resolvePublicIPv4('example.com', { resolve4: async (name) => {
    assert.equal(name, 'example.com.');
    return ['93.184.215.14'];
  } }), '93.184.215.14');
  await assert.rejects(resolvePublicIPv4('example.com', { resolve4: async () => ['93.184.215.14', '127.0.0.1'] }));
  await assert.rejects(resolvePublicIPv4('2130706433', { resolve4: async () => assert.fail('Numeric aliases must not reach DNS') }));
});

test('runner is shared only within a workspace; tickets are peer-bound and single-use', async (t) => {
  const rows = new Map([['a', { id: 'a', sessionIds: ['s1', 's2'] }], ['b', { id: 'b', sessionIds: ['s3'] }]]);
  const startups = [];
  const stops = [];
  const pool = createPool({ get: (id) => rows.get(id), list: () => [...rows.values()] }, (id) => {
    startups.push(id);
    return { ready: Promise.resolve(), stop: async () => { stops.push(id); } };
  });
  t.after(() => pool.dispose());
  const [key1, key2, key3] = await Promise.all([pool.issue('s1', 'owner'), pool.issue('s2', 'owner'), pool.issue('s3', 'owner')]);
  assert.deepEqual(startups, ['a', 'b']);
  assert.equal(pool.redeem(key1, 'other-peer'), null);
  const a1 = pool.redeem(key1, 'owner');
  const a2 = pool.redeem(key2, 'owner');
  const b = pool.redeem(key3, 'owner');
  assert.equal(pool.redeem(key1, 'owner'), null);
  assert.equal(a1.runner, a2.runner);
  assert.notEqual(a1.runner, b.runner);
  assert.equal(pool.findSession('s1'), rows.get('a'));
  assert.equal(a1.isCurrent(), true);
  rows.get('b').sessionIds.push('s1');
  assert.equal(pool.findSession('s1'), null);
  assert.equal(a1.isCurrent(), false);
  assert.equal(a2.isCurrent(), true);
  rows.delete('a');
  assert.equal(a2.isCurrent(), false);
  await pool.dispose();
  assert.deepEqual(stops, ['a', 'b']);
});

test('view request rejects legacy bodies and unresolved Sessions without starting a runner', async (t) => {
  const rows = new Map([
    ['a', { id: 'a', sessionIds: ['valid', 'duplicate', 'formerly-bound'] }],
    ['b', { id: 'b', sessionIds: ['duplicate'] }],
    ['bad/workspace', { id: 'bad/workspace', sessionIds: ['invalid-workspace'] }],
  ]);
  const startups = [];
  const pool = createPool({ get: (id) => rows.get(id), list: () => [...rows.values()] }, (id) => {
    startups.push(id);
    return { ready: Promise.resolve(), stop: async () => {} };
  });
  const routes = new Map();
  const peer = { id: 'owner', principal: { kind: 'owner' }, signal: new AbortController().signal };
  const dispose = registerWeb({
    connection: { browserPeer: peer, admit: () => ({ peer }) },
    webServer: {
      register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); },
      registerUpgrade: () => () => {},
    },
  }, pool, {});
  t.after(async () => { dispose(); await pool.dispose(); });

  async function request(payload) {
    let response;
    const req = {
      method: 'POST', socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost:1234', origin: 'http://localhost:1234', 'content-type': 'application/json' },
      async *iterator() { yield Buffer.from(JSON.stringify(payload)); },
    };
    const res = {
      writeHead(status) { response = { status }; },
      end(data) { response.body = JSON.parse(data); },
    };
    await routes.get(`${API}/view`)(req, res);
    return response;
  }

  for (const payload of [{ workspaceId: 'a' }, { sessionId: 'valid', workspaceId: 'a' }]) {
    const { status, body } = await request(payload);
    assert.equal(status, 400);
    assert.equal(body.code, 'invalid_body');
  }
  rows.get('a').sessionIds.pop();
  for (const sessionId of ['formerly-bound', 'unknown', 'invalid/id', 'duplicate', 'invalid-workspace']) {
    const unresolved = await request({ sessionId });
    assert.equal(unresolved.status, 404, sessionId);
    assert.equal(unresolved.body.code, 'session_workspace_missing', sessionId);
  }
  assert.deepEqual(startups, []);
  const success = await request({ sessionId: 'valid' });
  assert.equal(success.status, 200);
  assert.equal(success.body.ok, true);
  assert.match(success.body.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(startups, ['a']);
});

test('Desktop forwarding accepts only loopback marked JSON POSTs from the authenticated owner', async (t) => {
  const owner = { id: 'browser', principal: { kind: 'owner' }, signal: new AbortController().signal };
  const routes = new Map();
  let upgrade;
  let issued = 0;
  let admitted = 0;
  const dispose = registerWeb({
    connection: {
      browserPeer: owner,
      admit({ headers }) {
        admitted++;
        if (!headers.cookie) return { rejection: 401 };
        if (headers.cookie === 'other') return { peer: { ...owner, id: 'other' } };
        if (headers.cookie === 'guest') return { peer: { ...owner, principal: { kind: 'guest' } } };
        return { peer: owner };
      },
    },
    webServer: {
      register({ path, handler }) { routes.set(path, handler); return () => {}; },
      registerUpgrade({ handler }) { upgrade = handler; return () => {}; },
    },
  }, {
    async issue(session, peer) {
      assert.equal(session, 'blank');
      assert.equal(peer, owner.id);
      issued++;
      return 'test-ticket';
    },
  }, { status: (id) => ({ provider: 'disabled', workspaceId: id }) });
  t.after(dispose);

  const desktop = { host: '127.0.0.1:4321', 'content-type': 'application/json',
    [DESKTOP_REQUEST_HEADER]: DESKTOP_REQUEST_VERSION, cookie: 'owner' };
  const request = async ({ headers = {}, remoteAddress = '127.0.0.1', method = 'POST', path = '/view', value = { sessionId: 'blank' } } = {}) => {
    let reply;
    await routes.get(`${API}${path}`)({
      method, socket: { remoteAddress }, headers: { ...desktop, ...headers },
      async *iterator() { yield Buffer.from(JSON.stringify(value)); },
    }, {
      writeHead(status, fields) { reply = { status, fields }; },
      end(data) { reply.body = JSON.parse(data); },
    });
    assert.equal(reply.fields['Access-Control-Allow-Origin'], undefined);
    return reply;
  };
  for (const variant of [
    { headers: { [DESKTOP_REQUEST_HEADER]: undefined } },
    { headers: { [DESKTOP_REQUEST_HEADER]: '2' } },
    { headers: { origin: 'null' } },
    { headers: { origin: 'https://example.com' } },
    { headers: { origin: 'http://127.0.0.1:4322' } },
    { headers: { origin: 'dsh-app://app' } },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { 'content-type': 'text/plain' } },
    { headers: { host: 'example.com:4321' } },
    { headers: { host: 'user@127.0.0.1:4321' } },
    { remoteAddress: '192.0.2.1' },
    { method: 'OPTIONS' },
  ]) {
    const { status, body } = await request(variant);
    assert.equal(status, 403);
    assert.equal(body.code, 'origin_denied');
  }
  let upgradeReply;
  upgrade({ method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: desktop }, {
    end(data) { upgradeReply = data; },
  });
  assert.match(upgradeReply, /^HTTP\/1\.1 403/);
  assert.equal(admitted, 0);
  for (const [cookie, expected] of [[undefined, 401], ['other', 403], ['guest', 403]]) {
    const { status, body } = await request({ headers: { cookie } });
    assert.equal(status, expected);
    assert.equal(body.code, 'access_denied');
  }
  assert.equal(issued, 0);
  assert.deepEqual((await request()).body, { ok: true, ticket: 'test-ticket' });
  assert.deepEqual((await request({ path: '/agent/status', value: { workspaceId: 'a' } })).body,
    { ok: true, provider: 'disabled', workspaceId: 'a' });
  assert.deepEqual((await request({ headers: { origin: 'http://127.0.0.1:4321',
    [DESKTOP_REQUEST_HEADER]: undefined, 'sec-fetch-site': 'same-origin' } })).body, { ok: true, ticket: 'test-ticket' });
  assert.equal(issued, 2);
});

test('Session changing workspace while runner starts cannot obtain a ticket for the old room', async (t) => {
  const rows = new Map([['a', { id: 'a', sessionIds: ['moving'] }], ['b', { id: 'b', sessionIds: [] }]]);
  const startups = [];
  const { promise: ready, resolve } = Promise.withResolvers();
  const pool = createPool({ get: (id) => rows.get(id), list: () => [...rows.values()] }, (id) => {
    startups.push(id);
    return { ready, stop: async () => {} };
  });
  t.after(() => pool.dispose());
  const pending = pool.issue('moving', 'owner');
  const rejected = assert.rejects(pending, { code: 'session_workspace_changed', status: 409 });
  assert.deepEqual(startups, ['a']);
  rows.get('a').sessionIds = [];
  rows.get('b').sessionIds = ['moving'];
  resolve();
  await rejected;
  assert.deepEqual(startups, ['a']);
  const seat = pool.redeem(await pool.issue('moving', 'owner'), 'owner');
  assert.equal(seat.isCurrent(), true);
  assert.deepEqual(startups, ['a', 'b']);
});

test('redemption rechecks Session ownership and consumes the stale ticket', async (t) => {
  const rows = new Map([['a', { id: 'a', sessionIds: ['moving'] }], ['b', { id: 'b', sessionIds: [] }]]);
  const pool = createPool({ get: (id) => rows.get(id), list: () => [...rows.values()] }, () => ({
    ready: Promise.resolve(), stop: async () => {},
  }));
  t.after(() => pool.dispose());
  const key = await pool.issue('moving', 'owner');
  rows.get('a').sessionIds = [];
  rows.get('b').sessionIds = ['moving'];
  assert.equal(pool.redeem(key, 'owner'), null);
  rows.get('b').sessionIds = [];
  rows.get('a').sessionIds = ['moving'];
  assert.equal(pool.redeem(key, 'owner'), null);
});

test('action parser rejects another origin, unexpected controls and unsafe fill', () => {
  const base = { tabId: 'tab', documentId: 'doc' };
  assert.equal(parseAction({ ...base, action: 'navigate', url: `${origin}/about` }, origin).url, `${origin}/about`);
  assert.throws(() => parseAction({ ...base, action: 'navigate', url: 'https://example.org/' }, origin));
  assert.throws(() => parseAction({ action: 'list', workspaceId: 'elsewhere' }, origin));
  assert.throws(() => parseAction({ ...base, action: 'fill', elementId: 'field', text: 'line\nbreak' }, origin));
});

test('manual browser endpoints register without Browser Use or tools', async () => {
  const routes = new Set();
  const register = ({ path }) => { routes.add(path); return () => routes.delete(path); };
  for (const agentEnabled of [false, true]) {
    let dispose;
    const ctx = {
      workspaceRegistry: {},
      connection: {},
      webServer: { register, registerUpgrade: register },
      effect(setup) { dispose = setup(); },
      inject(services) {
        assert.equal(agentEnabled, true);
        assert.deepEqual(services, ['browserUse', 'tools']);
        return { dispose() {} }; // Agent services never become available.
      },
    };
    assert.deepEqual(inject, ['workspaceRegistry', 'connection', 'webServer']);
    apply(ctx, { agentEnabled });
    try {
      assert.ok(routes.has(`${API}/view`));
      assert.ok(routes.has(`${API}/stream`));
    } finally { await dispose(); }
    assert.equal(routes.size, 0);
  }
});

test('only the bound Session can use the visible runner and mutations require a decision', async (t) => {
  let tool;
  let activate;
  let deactivate;
  let releases = 0;
  const ctx = {
    inject(services, setup) {
      assert.deepEqual(services, ['browserUse', 'tools']);
      activate = () => { deactivate = setup({
        browserUse: { register: () => async () => { releases++; } },
        tools: { register(value) { tool = value; return () => { tool = undefined; }; } },
      }); };
      return { async dispose() {
        const cleanup = deactivate;
        deactivate = undefined;
        await cleanup?.();
      } };
    },
  };
  const requests = [];
  const row = { id: 'w', sessionIds: ['s', 'other'] };
  const pool = createPool({ get: (id) => id === row.id ? row : undefined, list: () => [row] }, () => ({
    ready: Promise.resolve(), stop: async () => {},
    async automation(request) {
      requests.push(request);
      return request.method === 'inspect'
        ? { tabId: 'tab', documentId: 'doc', url: 'https://93.184.215.14/', elements: [{ id: 'link', role: 'link', label: 'About' }] }
        : { ok: true };
    },
  }));
  const agent = createAgent(ctx, pool, true);
  t.after(async () => { agent.stopAdmission(); await pool.dispose(); await agent.dispose(); });
  const view = pool.redeem(await pool.issue('s', 'owner'), 'owner');
  assert.equal(agent.status('w').provider, 'disabled');
  assert.equal(tool, undefined);
  activate();
  const run = (id, args) => tool.execute(args, { agent: { id }, signal: new AbortController().signal });
  await assert.rejects(run('s', { action: 'list' }), { code: 'agent_access_denied' });
  await agent.grant('w', 's', 'https://93.184.215.14');
  await assert.rejects(run('other', { action: 'list' }), { code: 'agent_access_denied' });
  await run('s', { action: 'inspect', tabId: 'tab' });
  const click = { action: 'click', tabId: 'tab', documentId: 'doc', elementId: 'link' };
  const denied = run('s', click);
  assert.equal(requests.length, 1);
  agent.decide('w', agent.status('w').pending.id, false);
  await assert.rejects(denied, { code: 'approval_denied' });
  const allowed = run('s', click);
  assert.equal(requests.length, 1);
  agent.decide('w', agent.status('w').pending.id, true);
  await allowed;
  assert.equal(requests.length, 2);
  await run('s', { action: 'inspect', tabId: 'tab' });
  const pending = run('s', click);
  const canceled = assert.rejects(pending, { code: 'approval_denied' });
  const stop = deactivate;
  deactivate = undefined;
  await stop();
  await canceled;
  assert.equal(requests.length, 3);
  assert.deepEqual(agent.status('w'), { provider: 'disabled', access: null, pending: null });
  assert.equal(tool, undefined);
  assert.equal(releases, 1);
  assert.equal(view.isCurrent(), true);

  activate();
  await assert.rejects(run('s', { action: 'list' }), { code: 'agent_access_denied' });
  await agent.grant('w', 's', 'https://93.184.215.14');
  view.release();
  await assert.rejects(run('s', { action: 'list' }), { code: 'agent_access_denied' });
});
