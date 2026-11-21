import assert from 'node:assert/strict';
import { on, once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createAgent, parseAction } from '../src/host/agent.js';
import { isPublicIPv4, resolvePublicIPv4 } from '../src/host/egress.js';
import { apply, Config, inject } from '../src/host/index.js';
import { createPool } from '../src/host/pool.js';
import { registerWeb } from '../src/host/web.js';
import { API, BrowserError, DESKTOP_REQUEST_HEADER, DESKTOP_REQUEST_VERSION, RESIZE_OWNER } from '../src/shared/protocol.js';
import { RUNNER_VERSION } from '../src/shared/runner-image.js';

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
  const rows = new Map([['a', { id: 'a', path: '/registered/a', sessionIds: ['s1', 's2'] }], ['b', { id: 'b', path: '/registered/b', sessionIds: ['s3'] }]]);
  const startups = [];
  const stops = [];
  const pool = createPool({ get: (id) => rows.get(id), list: () => [...rows.values()] }, (id, _onExit, path) => {
    assert.equal(path, `/registered/${id}`);
    startups.push(id);
    return { ready: Promise.resolve(), stop: async () => { stops.push(id); } };
  });
  t.after(() => pool.dispose());
  const [first, second, third] = await Promise.all([pool.issue('s1', 'owner'), pool.issue('s2', 'owner'), pool.issue('s3', 'owner')]);
  assert.deepEqual(startups, ['a', 'b']);
  assert.equal(first.runId, second.runId);
  assert.equal(first.generation, second.generation);
  assert.notEqual(first.runId, third.runId);
  assert.equal(pool.redeem(first.ticket, 'other-peer'), null);
  const a1 = pool.redeem(first.ticket, 'owner');
  const a2 = pool.redeem(second.ticket, 'owner');
  const b = pool.redeem(third.ticket, 'owner');
  assert.equal(pool.redeem(first.ticket, 'owner'), null);
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

  async function request(payload, path = '/view') {
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
    await routes.get(`${API}${path}`)(req, res);
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
  const { runId, generation } = success.body;
  for (const id of [runId, generation]) assert.match(id, /^[0-9a-f-]{36}$/);
  const identity = { sessionId: 'valid', runId };
  const binding = { ...identity, generation };
  assert.equal((await request(binding)).body.runId, runId);
  assert.equal((await request(identity)).body.code, 'invalid_body');
  assert.equal((await request({ ...binding, generation: 'bad/id' })).body.code, 'invalid_body');
  assert.deepEqual((await request(identity, '/browser/status')).body, { ok: true, state: 'ready', generation });
  assert.equal((await request(binding, '/browser/status')).body.code, 'invalid_body');
  const restarted = (await request(binding, '/browser/restart')).body;
  assert.equal(restarted.state, 'restarting');
  assert.notEqual(restarted.generation, generation);
  assert.equal((await request(binding, '/browser/close')).body.code, 'browser_generation_changed');
  assert.deepEqual((await request({ ...identity, generation: restarted.generation }, '/browser/close')).body, { ok: true, state: 'closed' });
  assert.deepEqual((await request(identity, '/browser/status')).body, { ok: true, state: 'closed' });
  const count = startups.length;
  assert.equal((await request(binding)).body.code, 'browser_closed');
  assert.equal(startups.length, count);
});

test('Desktop forwarding accepts only loopback marked JSON POSTs from the authenticated owner', async (t) => {
  const owner = { id: 'browser', principal: { kind: 'owner' }, signal: new AbortController().signal };
  const routes = new Map();
  let upgrade;
  let issued = 0;
  let admitted = 0;
  const environmentCalls = [];
  const runnerVersion = RUNNER_VERSION;
  const checks = ['dockerConfig', 'dockerCli', 'dockerEngine', 'runnerImage'].map(id => ({ id, status: 'pass' }));
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
      return { ticket: 'test-ticket', runId: 'test-run', generation: 'test-generation' };
    },
  }, {
    status(sessionId) {
      assert.equal(sessionId, 'blank');
      return { provider: 'enabled', canGrant: false, access: null };
    },
    grant(sessionId) {
      assert.equal(sessionId, 'blank');
      return { provider: 'enabled', canGrant: true, access: { sessionId } };
    },
    revoke(sessionId) {
      assert.equal(sessionId, 'blank');
      return { provider: 'enabled', canGrant: true, access: null };
    },
  }, {
    async check() {
      environmentCalls.push('check');
      return { runnerVersion, checks };
    },
    startBuild() {
      environmentCalls.push('build');
      return { runnerVersion, state: 'building' };
    },
    buildStatus() {
      environmentCalls.push('status');
      return { runnerVersion, state: 'idle' };
    },
  }, ['https://ui.example.test']);
  t.after(dispose);

  assert.equal(DESKTOP_REQUEST_HEADER, 'x-dsh-plugin-workspace-browser-desktop');
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
    { headers: { [DESKTOP_REQUEST_HEADER]: undefined, 'x-dsh-workspace-browser-desktop': '1' } },
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
  const expectedView = { ok: true, ticket: 'test-ticket', runId: 'test-run', generation: 'test-generation' };
  assert.deepEqual((await request()).body, expectedView);
  assert.deepEqual((await request({ path: '/agent/status' })).body,
    { ok: true, provider: 'enabled', canGrant: false, access: null });
  assert.deepEqual((await request({ path: '/agent/grant' })).body,
    { ok: true, provider: 'enabled', canGrant: true, access: { sessionId: 'blank' } });
  assert.deepEqual((await request({ path: '/agent/revoke' })).body,
    { ok: true, provider: 'enabled', canGrant: true, access: null });
  assert.equal((await request({ path: '/agent/grant', headers: { cookie: undefined } })).body.code, 'access_denied');
  for (const [path, value] of [
    ['/agent/status', { workspaceId: 'a' }], ['/agent/revoke', { sessionId: 'blank', workspaceId: 'a' }],
    ['/agent/grant', { sessionId: 'blank', origin }],
  ]) assert.equal((await request({ path, value })).body.code, 'invalid_body');
  assert.equal(routes.has(`${API}/agent/decision`), false);
  assert.deepEqual((await request({ headers: { origin: 'http://127.0.0.1:4321',
    [DESKTOP_REQUEST_HEADER]: undefined, 'sec-fetch-site': 'same-origin' } })).body, expectedView);
  assert.equal(issued, 2);

  const web = { origin: 'http://127.0.0.1:4321', [DESKTOP_REQUEST_HEADER]: undefined, 'sec-fetch-site': 'same-origin' };
  for (const [path, expected] of [
    ['/environment/check', { ok: true, runnerVersion, checks }],
    ['/environment/build/status', { ok: true, runnerVersion, state: 'idle' }],
    ['/environment/build', { ok: true, runnerVersion, state: 'building' }],
  ]) {
    for (const [headers, status, code] of [
      [{ ...web, origin: 'https://example.com' }, 403, 'origin_denied'],
      [{ [DESKTOP_REQUEST_HEADER]: undefined }, 403, 'origin_denied'],
      [{ ...web, cookie: undefined }, 401, 'access_denied'],
      [{ cookie: 'guest' }, 403, 'access_denied'],
      [{ cookie: 'other' }, 403, 'access_denied'],
    ]) {
      const reply = await request({ path, headers, value: {} });
      assert.equal(reply.status, status);
      assert.equal(reply.body.code, code);
    }
    for (const value of [{ sessionId: 'blank' }, { runnerVersion }, { dockerfile: '/tmp/Dockerfile' }, [], null]) {
      assert.equal((await request({ path, value })).body.code, 'invalid_body');
    }
    for (const headers of [web, {}]) {
      const reply = await request({ path, headers, value: {} });
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, expected);
    }
  }
  assert.deepEqual(environmentCalls, ['check', 'check', 'status', 'status', 'build', 'build']);
  assert.equal(issued, 2);

  const proxy = { remoteAddress: '192.0.2.10' };
  const proxied = { host: 'backend:4321', origin: 'https://ui.example.test', [DESKTOP_REQUEST_HEADER]: undefined };
  const upgradeStatus = (headers) => {
    let response;
    upgrade({ method: 'GET', socket: proxy, headers }, { end(data) { response = data; } });
    return Number(response.split(' ')[1]);
  };
  for (const headers of [
    { origin: 'https://other.example.test' }, { origin: 'https://ui.example.test:444' },
    { origin: undefined, forwarded: 'proto=https;host=ui.example.test',
      'x-forwarded-host': 'ui.example.test', 'x-forwarded-proto': 'https' },
  ]) {
    const before = admitted;
    const merged = { ...proxied, ...headers, cookie: 'owner' };
    assert.equal((await request({ ...proxy, headers: merged })).body.code, 'origin_denied');
    assert.equal(upgradeStatus(merged), 403);
    assert.equal(admitted, before);
  }
  for (const [cookie, status] of [[undefined, 401], ['guest', 403], ['other', 403]]) {
    const headers = { ...proxied, cookie };
    const reply = await request({ ...proxy, headers });
    assert.equal(reply.status, status);
    assert.equal(reply.body.code, 'access_denied');
    assert.equal(upgradeStatus(headers), status);
  }
  assert.deepEqual((await request({ ...proxy, headers: proxied })).body, expectedView);
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
  const seat = pool.redeem((await pool.issue('moving', 'owner')).ticket, 'owner');
  assert.equal(seat.isCurrent(), true);
  assert.deepEqual(startups, ['a', 'b']);
});

test('redemption rechecks Session ownership and consumes the stale ticket', async (t) => {
  const rows = new Map([['a', { id: 'a', sessionIds: ['moving'] }], ['b', { id: 'b', sessionIds: [] }]]);
  const pool = createPool({ get: (id) => rows.get(id), list: () => [...rows.values()] }, () => ({
    ready: Promise.resolve(), stop: async () => {},
  }));
  t.after(() => pool.dispose());
  const { ticket: key } = await pool.issue('moving', 'owner');
  rows.get('a').sessionIds = [];
  rows.get('b').sessionIds = ['moving'];
  assert.equal(pool.redeem(key, 'owner'), null);
  rows.get('b').sessionIds = [];
  rows.get('a').sessionIds = ['moving'];
  assert.equal(pool.redeem(key, 'owner'), null);
});

test('restart fences old tickets and sockets; close during draining prevents replacement', async (t) => {
  const row = { id: 'w', sessionIds: ['one', 'two'] };
  const stopping = Promise.withResolvers();
  const launched = [];
  const pool = createPool({ list: () => [row], get: () => row }, (_id, onExit) => {
    launched.push(onExit);
    return { ready: Promise.resolve(), stop: () => stopping.promise };
  });
  t.after(async () => { stopping.resolve(); await pool.dispose(); });
  const { runId, generation, ticket } = await pool.issue('one', 'owner');
  const lingering = await pool.issue('two', 'owner', runId, generation);
  const owners = [];
  const joined = pool.redeem(ticket, 'owner', {
    onResizeOwner: (enabled) => owners.push(enabled), onClose: () => owners.push('closed'),
  });
  const replacement = pool.restart('two', runId, generation);
  assert.equal(replacement.state, 'restarting');
  assert.notEqual(replacement.generation, generation);
  assert.deepEqual(owners, [true, 'closed']);
  assert.equal(joined.isCurrent(), false);
  assert.equal(pool.redeem(lingering.ticket, 'owner'), null);
  await assert.rejects(pool.issue('one', 'owner', runId, generation), { code: 'browser_generation_changed' });
  assert.throws(() => pool.restart('two', runId, replacement.generation), { code: 'browser_busy' });
  launched[0](new Error('delayed old generation callback'));
  await Promise.resolve();
  assert.deepEqual(pool.status('two', runId), replacement);
  assert.equal(launched.length, 1);
  const waiting = assert.rejects(pool.issue('two', 'owner', runId, replacement.generation), { code: 'browser_closed' });
  assert.deepEqual(pool.close('one', runId, replacement.generation), { state: 'closed' });
  await waiting;
  await assert.rejects(pool.issue('one', 'owner'), { code: 'runner_limit' });
  await assert.rejects(pool.issue('one', 'owner', runId, replacement.generation), { code: 'browser_closed' });
  stopping.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launched.length, 1);
  const fresh = await pool.issue('one', 'owner');
  assert.notEqual(fresh.runId, runId);
  assert.deepEqual(pool.status('one', runId), { state: 'closed' });
});

test('failed replacement is retryable, but post-ready exit and membership loss are terminal for a binding', async (t) => {
  const row = { id: 'w', sessionIds: ['one', 'two'] };
  const launched = [];
  const pool = createPool({ list: () => [row], get: () => row }, (_id, onExit) => {
    const index = launched.push(onExit) - 1;
    const ready = index === 1 ? Promise.reject(new BrowserError('runner_profile_recovery_failed', 'private detail', 503)) : Promise.resolve();
    return { ready, stop: async () => {} };
  });
  t.after(() => pool.dispose());
  const first = await pool.issue('one', 'owner');
  const failed = pool.restart('one', first.runId, first.generation);
  await assert.rejects(pool.issue('two', 'owner', first.runId, failed.generation), { code: 'runner_profile_recovery_failed' });
  assert.deepEqual(await pool.issue('two', 'owner'), {
    runId: first.runId, generation: failed.generation, state: 'failed', code: 'runner_profile_recovery_failed',
  });
  const recovered = pool.restart('two', first.runId, failed.generation);
  const retry = await pool.issue('one', 'owner', first.runId, recovered.generation);
  assert.equal(retry.runId, first.runId);
  assert.notEqual(retry.generation, failed.generation);
  row.sessionIds = ['two'];
  assert.deepEqual(pool.status('one', first.runId), { state: 'closed' });
  await assert.rejects(pool.issue('one', 'owner', first.runId, retry.generation), { code: 'browser_closed' });
  launched[0]();
  await Promise.resolve();
  assert.equal(pool.status('two', first.runId).state, 'ready');
  launched[2]();
  await Promise.resolve();
  assert.deepEqual(pool.status('two', first.runId), { state: 'closed' });
  await assert.rejects(pool.issue('two', 'owner', first.runId, retry.generation), { code: 'browser_closed' });
  assert.equal(launched.length, 3);
});

test('restarting after a rejected stop retries cleanup before launching', async (t) => {
  const row = { id: 'w', sessionIds: ['one'] };
  let starts = 0;
  let stops = 0;
  const pool = createPool({ list: () => [row], get: () => row }, () => {
    const index = ++starts;
    return { ready: Promise.resolve(), async stop() {
      if (index === 1 && ++stops === 1) throw new Error('private cleanup error');
    } };
  });
  t.after(() => pool.dispose());
  const { runId, generation } = await pool.issue('one', 'owner');
  const failed = pool.restart('one', runId, generation);
  await assert.rejects(pool.issue('one', 'owner', runId, failed.generation), { code: 'runner_start_failed' });
  assert.equal(starts, 1);
  const retry = pool.restart('one', runId, failed.generation);
  await pool.issue('one', 'owner', runId, retry.generation);
  assert.equal(starts, 2);
  assert.equal(stops, 2);
});

test('display ownership transfers to the oldest remaining seat; idle status polls do not revive a run', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const row = { id: 'w', sessionIds: ['one', 'two', 'three'] };
  const pool = createPool({ list: () => [row], get: () => row }, () => ({ ready: Promise.resolve(), stop: async () => {} }));
  t.after(() => pool.dispose());
  const phases = [];
  const first = await pool.issue('one', 'owner');
  const seats = [];
  for (const id of row.sessionIds) {
    const { ticket } = id === 'one' ? first : await pool.issue(id, 'owner', first.runId, first.generation);
    seats.push(pool.redeem(ticket, 'owner', { onResizeOwner: (enabled) => phases.push([id, enabled]) }));
  }
  assert.deepEqual(phases, [['one', true], ['two', false], ['three', false]]);
  seats[0].release();
  assert.deepEqual(phases.at(-1), ['two', true]);
  seats[1].release();
  assert.deepEqual(phases.at(-1), ['three', true]);
  seats[2].release();
  t.mock.timers.tick(60_000);
  assert.equal(pool.status('one', first.runId).state, 'ready');
  t.mock.timers.tick(61_000);
  assert.deepEqual(pool.status('one', first.runId), { state: 'closed' });
  await assert.rejects(pool.issue('one', 'owner', first.runId, first.generation), { code: 'browser_closed' });
});

test('idle timeout changes apply to an already idle run on the next sweep', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const row = { id: 'w', sessionIds: ['one'] };
  let minutes = 1;
  const pool = createPool({ list: () => [row], get: () => row }, () => ({ ready: Promise.resolve(), stop: async () => {} }), () => minutes);
  t.after(() => pool.dispose());
  const { runId } = await pool.issue('one', 'owner');
  t.mock.timers.tick(59_000);
  minutes = 1440;
  t.mock.timers.tick(62_000);
  assert.equal(pool.status('one', runId).state, 'ready');
  minutes = 1;
  t.mock.timers.tick(1_000);
  assert.deepEqual(pool.status('one', runId), { state: 'closed' });
});

test('zero disables idle retirement until a positive timeout is restored', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const row = { id: 'w', sessionIds: ['one'] };
  let minutes = 1;
  const pool = createPool({ list: () => [row], get: () => row }, () => ({ ready: Promise.resolve(), stop: async () => {} }), () => minutes);
  t.after(() => pool.dispose());
  const { runId } = await pool.issue('one', 'owner');
  t.mock.timers.tick(59_000);
  minutes = 0;
  t.mock.timers.tick(180_000);
  assert.equal(pool.status('one', runId).state, 'ready');
  minutes = 1;
  t.mock.timers.tick(1_000);
  assert.deepEqual(pool.status('one', runId), { state: 'closed' });
});

test('the idle timeout starts at final seat release and expires at the configured minute', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const row = { id: 'w', sessionIds: ['one'] };
  const pool = createPool({ list: () => [row], get: () => row }, () => ({ ready: Promise.resolve(), stop: async () => {} }), () => 1);
  t.after(() => pool.dispose());
  const { ticket, runId } = await pool.issue('one', 'owner');
  const seat = pool.redeem(ticket, 'owner');
  t.mock.timers.tick(121_000);
  assert.equal(pool.status('one', runId).state, 'ready');
  seat.release();
  t.mock.timers.tick(59_000);
  assert.equal(pool.status('one', runId).state, 'ready');
  t.mock.timers.tick(1_000);
  assert.deepEqual(pool.status('one', runId), { state: 'closed' });
});

test('registration rejects invalid configured Web origins', () => {
  for (const invalid of ['https://*.example.test', 'https://owner@ui.example.test',
    'https://ui.example.test/page', 'https://ui.example.test/?q=1', 'https://ui.example.test/#fragment']) {
    assert.throws(() => registerWeb({}, {}, {}, {}, ['https://ui.example.test', invalid]), /allowedWebOrigins/);
  }
});

test('stream announces ownership only after ticket redemption and leaves RFB binary', { timeout: 5_000 }, async (t) => {
  const row = { id: 'w', sessionIds: ['one', 'two'] };
  const streams = [];
  const received = Promise.withResolvers();
  const pool = createPool({ list: () => [row], get: () => row }, () => ({
    ready: Promise.resolve(), stop: async () => {},
    attach(view) {
      streams.push(view);
      return { send: (data) => { received.resolve(data); return true; }, close() {} };
    },
  }));
  const server = createServer();
  const owner = { id: 'owner', principal: { kind: 'owner' }, signal: new AbortController().signal };
  const dispose = registerWeb({
    connection: { browserPeer: owner, admit: () => ({ peer: owner }) },
    webServer: {
      register: () => () => {},
      registerUpgrade({ handler }) {
        const upgrade = (req, socket, head) => {
          if (req.headers.host === 'backend:4321') {
            Object.defineProperty(socket, 'remoteAddress', { value: '192.0.2.10' });
          }
          handler(req, socket, head);
        };
        server.on('upgrade', upgrade);
        return () => server.off('upgrade', upgrade);
      },
    },
  }, pool, {}, {}, ['https://ui.example.test']);
  t.after(async () => {
    dispose();
    await pool.dispose();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = `127.0.0.1:${server.address().port}`;
  const connect = async (sessionId) => {
    const { ticket } = await pool.issue(sessionId, owner.id);
    const options = sessionId === 'one' ? { origin: `http://${address}` } :
      { origin: 'https://ui.example.test', headers: { host: 'backend:4321' } };
    const ws = new WebSocket(`ws://${address}${API}/stream`, options);
    const messages = on(ws, 'message', { signal: t.signal });
    await once(ws, 'open');
    assert.equal(streams.length, sessionId === 'one' ? 0 : 1);
    ws.send(JSON.stringify({ ticket }));
    return { ws, messages };
  };
  const expectOwner = async (messages, enabled) => {
    const { value: [data, binary] } = await messages.next();
    assert.equal(binary, false);
    assert.deepEqual(JSON.parse(data), { type: RESIZE_OWNER, enabled });
  };
  const leader = await connect('one');
  await expectOwner(leader.messages, true);
  const follower = await connect('two');
  await expectOwner(follower.messages, false);
  const rfb = Buffer.from([0, 128, 255]);
  streams[1].send(rfb);
  assert.deepEqual((await follower.messages.next()).value, [rfb, true]);
  follower.ws.send(rfb);
  assert.deepEqual(await received.promise, rfb);
  // Client-supplied text after admission cannot become an RFB frame or control message.
  leader.ws.send(JSON.stringify({ type: RESIZE_OWNER, enabled: false }));
  await once(leader.ws, 'close');
  await expectOwner(follower.messages, true);
  await leader.messages.return();
  await follower.messages.return();
});

test('navigation needs only a tab and an HTTP(S) URL, without an origin grant or document reference', () => {
  for (const url of ['https://example.com/about', 'https://example.org/']) {
    assert.deepEqual(parseAction({ tabId: 'tab', action: 'navigate', url }), { method: 'navigate', tabId: 'tab', url });
  }
  for (const url of ['chrome://settings/', 'file:///profile', 'https://example.org:9000/', 'https://user@example.org/']) {
    assert.throws(() => parseAction({ tabId: 'tab', action: 'navigate', url }), { code: 'invalid_action' });
  }
  assert.throws(() => parseAction({ action: 'list', workspaceId: 'elsewhere' }), { code: 'invalid_action' });
  assert.throws(() => parseAction({ action: 'fill', tabId: 'tab', documentId: 'doc', elementId: 'field', text: 'line\nbreak' }), { code: 'invalid_action' });
});

test('the agent integration defaults on, but manual browser endpoints do not wait for tools', async () => {
  const routes = new Set();
  const register = ({ path }) => { routes.add(path); return () => routes.delete(path); };
  for (const [options, agentEnabled] of [[{}, true], [{ agentEnabled: false }, false]]) {
    const config = Config(options);
    assert.equal(config.agentEnabled.get(), agentEnabled);
    assert.equal(config.idleTimeoutMinutes.get(), 2);
    assert.deepEqual(Object.keys(Config.dict).filter((key) => Config.dict[key].meta.volatile).sort(), ['agentEnabled', 'idleTimeoutMinutes']);
    let currentValue = agentEnabled;
    let injectionCount = 0;
    let bindingDisposals = 0;
    let changed;
    let dispose;
    const ctx = {
      workspaceRegistry: {},
      connection: {},
      webServer: { register, registerUpgrade: register },
      effect(setup) { dispose = setup(); },
      on(event, listener) {
        assert.equal(event, 'loader/volatile-update');
        changed = listener;
        return () => { changed = undefined; };
      },
      inject(services) {
        injectionCount++;
        assert.deepEqual(services, ['tools']);
        return { dispose() { bindingDisposals++; } }; // The tool registry never becomes available.
      },
    };
    assert.deepEqual(inject, ['workspaceRegistry', 'connection', 'webServer']);
    apply(ctx, { ...config, agentEnabled: { get: () => currentValue } });
    try {
      assert.equal(injectionCount, agentEnabled ? 1 : 0);
      assert.ok(routes.has('/dsh-plugin-workspace-browser/v2/view'));
      assert.ok(routes.has('/dsh-plugin-workspace-browser/v2/browser/status'));
      assert.ok(routes.has('/dsh-plugin-workspace-browser/v2/stream'));
      assert.ok([...routes].every((path) => !path.startsWith('/dsh-browser/')));
      const before = [...routes];
      currentValue = !agentEnabled;
      changed();
      await Promise.resolve();
      assert.equal(injectionCount, 1);
      assert.equal(bindingDisposals, agentEnabled ? 1 : 0);
      assert.deepEqual([...routes], before);
    } finally { await dispose(); }
    assert.equal(changed, undefined);
    assert.equal(routes.size, 0);
  }
});

test('Session grants work before the display connects and last until revoked or the runner changes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let tool;
  let activate;
  let deactivate;
  let disposeGate;
  let unregisters = 0;
  let injections = 0;
  const ctx = {
    inject(services, setup) {
      injections++;
      assert.deepEqual(services, ['tools']);
      activate = (collision = false) => { deactivate = setup({
        tools: { register(value) {
          assert.equal(value.name, 'dsh-plugin-workspace-browser');
          if (collision) throw new Error('tool "dsh-plugin-workspace-browser" is already registered');
          tool = value;
          return () => { tool = undefined; unregisters++; };
        } },
      }); };
      return { async dispose() {
        const cleanup = deactivate;
        deactivate = undefined;
        await cleanup?.();
        await disposeGate;
      } };
    },
  };
  const requests = [];
  const row = { id: 'w', sessionIds: ['s', 'other'] };
  const launch = Promise.withResolvers();
  const replacement = Promise.withResolvers();
  const readiness = [launch.promise, replacement.promise];
  const pool = createPool({ get: (id) => id === row.id ? row : undefined, list: () => [row] }, () => ({
    ready: readiness.shift() ?? Promise.resolve(), stop: async () => {},
    async automation(request, signal) {
      requests.push(request);
      if (request.method === 'click') {
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
          reject(new BrowserError('action_cancelled', 'Cancelled', 409));
        }, { once: true }));
      }
      return { ok: true };
    },
  }));
  const agent = createAgent(ctx, pool, true);
  t.after(async () => { agent.stopAdmission(); await pool.dispose(); await agent.dispose(); });
  assert.deepEqual(agent.status('s'), { provider: 'disabled', canGrant: false, access: null });
  activate(true);
  assert.equal(agent.status('s').provider, 'conflict');
  assert.throws(() => agent.grant('s'), { code: 'agent_access_denied' });
  assert.equal(tool, undefined);
  deactivate();
  activate();
  const run = (id, args = { action: 'list' }) => tool.execute(args, { agent: { id }, signal: new AbortController().signal });
  assert.deepEqual(agent.status('s'), { provider: 'enabled', canGrant: false, access: null });
  assert.throws(() => agent.grant('s'), { code: 'browser_not_ready' });
  const ticket = pool.issue('s', 'owner');
  assert.deepEqual(agent.status('s'), { provider: 'enabled', canGrant: true, access: null });
  await assert.rejects(run('s'), { code: 'agent_access_denied' });
  assert.deepEqual(agent.grant('s'), { provider: 'enabled', canGrant: true, access: { sessionId: 's' } });
  await assert.rejects(run('s'), { code: 'browser_not_ready' });
  assert.deepEqual(requests, []);
  launch.resolve();
  const binding = await ticket;
  const view = pool.redeem(binding.ticket, 'owner');
  assert.equal(view.isCurrent(), true);
  view.release();
  assert.equal(agent.status('s').access.sessionId, 's');
  assert.equal(agent.status('other').access, null);
  await assert.rejects(run('other'), { code: 'agent_access_denied' });
  for (const url of ['https://example.com/', 'https://example.org/']) {
    assert.deepEqual(await run('s', { action: 'navigate', tabId: 'tab', url }), { ok: true });
    assert.deepEqual(requests.at(-1), { method: 'navigate', tabId: 'tab', url });
  }

  const click = { action: 'click', tabId: 'tab', documentId: 'doc', elementId: 'link' };
  const cancelled = () => assert.rejects(run('s', click), { code: 'action_cancelled' });
  let interrupted = cancelled();
  assert.deepEqual(requests.at(-1), { method: 'click', tabId: 'tab', documentId: 'doc', elementId: 'link' });
  agent.grant('other');
  await assert.rejects(run('other'), { code: 'browser_busy' });
  assert.equal(agent.revoke('s').access, null);
  await interrupted;
  await assert.rejects(run('s'), { code: 'agent_access_denied' });
  assert.deepEqual(await run('other'), { ok: true });

  agent.grant('s');
  interrupted = cancelled();
  row.sessionIds = ['other'];
  await assert.rejects(run('s'), { code: 'agent_access_denied' });
  t.mock.timers.tick(1000);
  await interrupted;
  row.sessionIds.push('s');
  assert.equal(agent.status('s').access, null);

  agent.grant('s');
  interrupted = cancelled();
  const restarted = pool.restart('other', binding.runId, binding.generation);
  await interrupted;
  assert.equal(agent.status('other').access, null);
  assert.equal(agent.status('s').access, null);
  assert.equal(agent.grant('s').access.sessionId, 's');
  await assert.rejects(run('s'), { code: 'browser_not_ready' });
  const replacementFailed = assert.rejects(pool.issue('s', 'owner', binding.runId, restarted.generation), { code: 'runner_start_failed' });
  replacement.reject(new Error('Failed to launch replacement'));
  await replacementFailed;
  assert.deepEqual(agent.status('s'), { provider: 'enabled', canGrant: false, access: null });

  const retry = pool.restart('s', binding.runId, restarted.generation);
  const reconnected = pool.redeem((await pool.issue('s', 'owner', binding.runId, retry.generation)).ticket, 'owner');
  agent.grant('s');
  interrupted = cancelled();
  const stop = deactivate;
  deactivate = undefined;
  await stop();
  await interrupted;
  assert.deepEqual(agent.status('s'), { provider: 'disabled', canGrant: false, access: null });
  assert.equal(tool, undefined);
  assert.equal(unregisters, 1);
  assert.equal(reconnected.isCurrent(), true);

  const staleActivation = activate;
  activate();
  const staleTool = tool;
  agent.grant('s');
  agent.grant('other');
  interrupted = cancelled();
  const gate = Promise.withResolvers();
  disposeGate = gate.promise;
  const disabling = agent.setEnabled(false);
  assert.deepEqual(agent.status('s'), { provider: 'disabled', canGrant: false, access: null });
  assert.equal(agent.status('other').access, null);
  assert.equal(reconnected.isCurrent(), true);
  await interrupted;
  assert.equal(tool, undefined);
  assert.equal(unregisters, 2);
  assert.equal(agent.setEnabled(true), disabling);
  assert.equal(agent.setEnabled(false), disabling);
  assert.equal(agent.setEnabled(true), disabling);
  assert.equal(injections, 1);
  staleActivation();
  assert.equal(tool, undefined);
  gate.resolve();
  await disabling;
  assert.equal(injections, 2);
  activate();
  assert.equal(agent.status('s').access, null);
  assert.equal(agent.status('other').access, null);
  await assert.rejects(run('s'), { code: 'agent_access_denied' });
  agent.grant('s');
  await assert.rejects(staleTool.execute({ action: 'list' }, { agent: { id: 's' } }), { code: 'agent_access_denied' });
  assert.deepEqual(await run('s'), { ok: true });

  const shutdown = agent.setEnabled(false);
  agent.setEnabled(true);
  agent.stopAdmission();
  await shutdown;
  assert.equal(injections, 2);
  assert.equal(tool, undefined);
  assert.equal(reconnected.isCurrent(), true);
});
