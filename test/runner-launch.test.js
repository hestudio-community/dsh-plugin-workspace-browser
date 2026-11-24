import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer as createHttpServer, request } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createProxy } from '../runner/proxy.mjs';
import { resolveRootAccount } from '../src/host/root-account.js';
import { browserIdentity, workspaceMount } from '../src/host/workspace.js';
import { dockerCommand, createRunnerLauncher } from '../src/host/runner.js';
import { IMAGE_PLATFORM, RUNNER_IMAGE, RUNNER_PROTOCOL, RUNNER_VERSION } from '../src/shared/runner-image.js';

const key = id => `dsh-plugin-workspace-browser-${createHash('sha256').update('default\0' + id).digest('hex')}`;
const label = 'dev.dsh.dsh-plugin-workspace-browser.instance';
const imageId = `sha256:${'a'.repeat(64)}`;

function fakeEngine({ platform = IMAGE_PLATFORM, active = [], preflightCode = 0, frame = { type: 'ready' }, invalidCleanup = false, imageMissing = false } = {}) {
  const containers = new Map(active.map(row => [row.name, row]));
  const launches = [];
  const stops = [];
  const probes = [];
  const result = (output = '', code = 0) => ({ output, code });
  async function queryDocker(_docker, args, signal) {
    signal.throwIfAborted();
    if (args[0] === '--version') return result('Docker version 29.0.0');
    if (args[0] === 'info') return result(`${platform === 'linux/arm64' ? 'linux/aarch64' : 'linux/x86_64'} ["name=seccomp,profile=builtin"]`);
    if (args[0] === 'image') {
      assert.equal(args.at(-1), RUNNER_IMAGE);
      return imageMissing ? result('', 1) : result(`${imageId} ${platform} ${RUNNER_PROTOCOL} ${RUNNER_VERSION}`);
    }
    if (args[0] === 'stop') {
      const id = args.at(-1);
      assert.match(id, /^[0-9a-f]{64}$/);
      stops.push(id);
      for (const [name, row] of containers) {
        if (row.id !== id) continue;
        containers.delete(name);
        row.close?.(0);
      }
      return result();
    }
    assert.equal(args[0], 'ps');
    const filter = args[args.indexOf('--filter') + 1];
    if (filter.startsWith('volume=')) {
      probes.push(filter);
      const volume = filter.slice('volume='.length);
      return result([...containers.values()].filter(row => row.volume === volume).map(row => row.id).join('\n'), preflightCode);
    }
    assert.ok(filter.startsWith('name=^/'));
    assert.ok(filter.endsWith('$'));
    const row = containers.get(filter.slice('name=^/'.length, -1));
    return result(row ? `${row.id} ${row.owner ?? ''}${invalidCleanup ? '\ninvalid second row' : ''}` : '');
  }
  function spawnDocker(_docker, args) {
    const name = args[args.indexOf('--name') + 1];
    const volume = args[args.indexOf('--mount') + 1].match(/,source=([^,]+),/)[1];
    const owner = args.find(arg => arg.startsWith(`${label}=`)).split('=')[1];
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null, pid: 1,
    });
    function close(code) {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      child.emit('close', code);
    }
    child.kill = () => close(1);
    launches.push({ name, volume, owner, args, stdin: child.stdin, stdout: child.stdout });
    if (containers.has(name)) {
      queueMicrotask(() => close(125));
    } else {
      const id = String(launches.length).padStart(64, '0');
      containers.set(name, { id, volume, owner, close });
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify(frame)}\n`);
        if (frame.type === 'startup-error') {
          containers.delete(name);
          close(1);
        }
      });
    }
    return child;
  }
  const host = { platform: 'linux', env: {}, geteuid: () => 1001, getegid: () => 1002, getgroups: () => [1002, 123] };
  const launcher = (hostOverrides = {}, overrides = {}, config = { rootBrowserAccount: 'browser-only' }) => createRunnerLauncher(config, {
    queryDocker, spawnDocker, host: { ...host, ...hostOverrides }, ...overrides,
  });
  return { containers, launcher, launches, probes, stops };
}

const start = (launcher, workspace) => launcher.start(workspace, () => {}, process.cwd());

async function listenLocally(t, server, hostname = '127.0.0.1') {
  await once(server.listen(0, hostname), 'listening');
  t.after(() => { if (server.listening) server.close(); });
  return server.address().port;
}

async function localProxy(t) {
  const engine = fakeEngine();
  const runner = start(engine.launcher(), 'proxy-test');
  t.after(() => runner.stop());
  await runner.ready;
  const [{ stdin, stdout }] = engine.launches;
  const send = frame => stdout.write(`${JSON.stringify(frame)}\n`);
  const proxy = await createProxy(send, (type, id, data) => send({ type, id, data: data.toString('base64') }));
  t.after(() => proxy.close());
  // PassThrough delivers each complete Host write in this simulated Docker pipe.
  stdin.on('data', line => {
    const frame = JSON.parse(line.toString());
    if (frame.type === 'net-data') frame.data = Buffer.from(frame.data, 'base64');
    proxy.handle(frame);
  });
  return { ...proxy, send, stdin };
}

async function proxiedHttp(address, target) {
  const { hostname, port } = new URL(address);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: target, headers: { Host: 'ignored.example' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, body }));
    });
    req.once('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Local HTTP integration timed out')));
    req.end();
  });
}

function proxiedConnect(t, address, target, head = '') {
  const { hostname, port } = new URL(address);
  const client = connect({ host: hostname, port: Number(port) });
  t.after(() => client.destroy());
  client.setEncoding('utf8');
  client.setTimeout(2000, () => client.destroy(new Error('Local CONNECT integration timed out')));
  client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ignored.example\r\n\r\n${head}`);
  return client;
}

async function readTunnel(client) {
  let data = '';
  for await (const chunk of client) data += chunk;
  return data;
}

test('Runner proxy uses the Host TCP broker for local HTTP and CONNECT on custom ports', { timeout: 8000 }, async t => {
  const http = createHttpServer((req, res) => res.end(`${req.headers.host} ${req.url}`));
  const httpPort = await listenLocally(t, http);
  const tcp = createTcpServer(socket => socket.once('data', chunk => socket.end(`reply: ${chunk}`)));
  const tcpPort = await listenLocally(t, tcp);
  const proxy = await localProxy(t);

  assert.deepEqual(await proxiedHttp(proxy.address, `http://localhost:${httpPort}/health?q=1`),
    { status: 200, body: `localhost:${httpPort} /health?q=1` });
  assert.equal(await readTunnel(proxiedConnect(t, proxy.address, `127.0.0.1:${tcpPort}`, 'opaque request')),
    'HTTP/1.1 200 Connection Established\r\n\r\nreply: opaque request');

  // A client disconnect must also close the Host's upstream connection.
  const accepted = once(tcp, 'connection');
  const abandoned = proxiedConnect(t, proxy.address, `127.0.0.1:${tcpPort}`);
  const handshakeData = once(abandoned, 'data');
  const [upstream] = await accepted;
  const upstreamClosed = once(upstream, 'close');
  const [handshake] = await handshakeData;
  assert.match(handshake, /^HTTP\/1\.1 200 /);
  abandoned.destroy();
  await upstreamClosed;

  const closed = once(tcp, 'close');
  tcp.close();
  await closed;
  assert.equal(await readTunnel(proxiedConnect(t, proxy.address, `127.0.0.1:${tcpPort}`)),
    'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  assert.equal((await proxiedHttp(proxy.address, `http://127.0.0.1:${tcpPort}/`)).status, 502);
  assert.equal((await proxiedHttp(proxy.address, `http://127.0.0.1:${httpPort}/`)).status, 200);

  for (const [host, port] of [['localhost', 0], ['localhost', '80'], ['http://localhost', httpPort]]) {
    const response = once(proxy.stdin, 'data');
    proxy.send({ type: 'net-open', id: 'invalid-destination', host, port });
    const [line] = await response;
    assert.deepEqual(JSON.parse(line.toString()), { type: 'net-opened', id: 'invalid-destination', ok: false });
  }
});

test('Host broker connects to bracketed IPv6 URL destinations where local IPv6 is available', { timeout: 8000 }, async t => {
  const http = createHttpServer((req, res) => res.end(req.headers.host));
  let port;
  try { port = await listenLocally(t, http, '::1'); }
  catch (error) {
    if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) throw error;
    return t.skip('IPv6 loopback is unavailable');
  }
  const proxy = await localProxy(t);
  assert.deepEqual(await proxiedHttp(proxy.address, `http://[::1]:${port}/`), { status: 200, body: `[::1]:${port}` });
});

test('window title frames update only the owning runner and stop exposing retired titles', async () => {
  const engine = fakeEngine();
  const first = start(engine.launcher(), 'first');
  const second = start(engine.launcher(), 'second');
  try {
    await Promise.all([first.ready, second.ready]);
    const { stdout } = engine.launches.find(entry => entry.owner === first.generation);
    const title = windowTitle => stdout.write(`${JSON.stringify({ type: 'window-title', windowTitle })}\n`);
    title('  工作区\nChromium  ');
    assert.equal(first.windowTitle, '工作区 Chromium');
    assert.equal(second.windowTitle, '');
    title('🌏'.repeat(520));
    assert.equal(first.windowTitle, '🌏'.repeat(512));
    title('');
    assert.equal(first.windowTitle, '');
    title('retired');
    await first.stop();
    assert.equal(first.windowTitle, '');
  } finally { await Promise.all([first.stop(), second.stop()]); }
});

test('workspace source is an existing canonical directory encoded as one CSV field', async () => {
  const fs = { canonicalize: async path => path, inspect: async () => ({ isDirectory: () => true }) };
  for (const [platform, path, escaped] of [
    ['linux', '/my dir/a,"b"', '/my dir/a,""b""'], ['win32', 'C:\\my dir\\a,b', 'C:\\my dir\\a,b'],
  ]) assert.equal(await workspaceMount(path, { ...fs, platform }), `type=bind,"source=${escaped}",target=/workspace,bind-recursive=disabled`);
  for (const [path, overrides] of [[undefined, {}], ['relative', {}], ['/line\nbreak', {}], ['/redirected', { canonicalize: async () => '/other' }],
    ['/missing', { canonicalize: async () => { throw Error(); } }], ['/file', { inspect: async () => ({ isDirectory: () => false }) }],
    ['C:relative', { platform: 'win32' }], ['\\relative', { platform: 'win32' }]]) {
    await assert.rejects(workspaceMount(path, { ...fs, platform: 'linux', ...overrides }), { code: 'runner_workspace_invalid' });
  }
});

const account = { name: 'browser-only', uid: 600, gid: 601 };
const rootHost = { geteuid: () => 0, getegid: () => 0, getgroups: () => [0, 27] };
const rootOptions = { resolveAccount: async name => { assert.equal(name, account.name); return account; }, aclTools: async () => false };

test('root launcher uses only the configured identity; absent ACL tools are advisory', async () => {
  const engine = fakeEngine();
  const launcher = engine.launcher(rootHost, rootOptions);
  assert.deepEqual((await launcher.environment.check()).checks.slice(-2), [
    { id: 'rootBrowserAccount', status: 'pass', account }, { id: 'workspaceAclTools', status: 'warn', code: 'workspace_acl_tools_missing' },
  ]);
  assert.equal(engine.launches.length, 0);
  const runner = start(launcher, 'root');
  try {
    await runner.ready;
    const [{ args }] = engine.launches;
    assert.deepEqual(args.filter(arg => /DSH_BROWSER_(UID|GID|GROUPS)\b/.test(arg)), ['DSH_BROWSER_UID=600', 'DSH_BROWSER_GID=601', 'DSH_BROWSER_GROUPS=']);
  } finally { await runner.stop(); }
});

test('a volatile account setting is read at every probe without a Host restart', async () => {
  const engine = fakeEngine();
  let current = 'browser-only';
  const seen = [];
  const launcher = engine.launcher(rootHost, {
    resolveAccount: async name => { seen.push(name); return account; }, aclTools: async () => true,
  }, { rootBrowserAccount: { get: () => current } });
  await launcher.environment.check();
  current = 'browser-two';
  await launcher.environment.check();
  assert.deepEqual(seen, ['browser-only', 'browser-two']);
});

test('only a permission startup frame for a validated root account requests a grant', async () => {
  const engine = fakeEngine({ frame: { type: 'startup-error', code: 'runner_workspace_permission_denied' } });
  await assert.rejects(start(engine.launcher(rootHost, rootOptions), 'root').ready, { code: 'runner_workspace_grant_required' });
  const invalid = engine.launcher(rootHost, { ...rootOptions, resolveAccount: () => resolveRootAccount('') });
  assert.deepEqual((await invalid.environment.check()).checks.at(-2), { id: 'rootBrowserAccount', status: 'fail', code: 'root_browser_account_missing' });
  await assert.rejects(start(invalid, 'invalid').ready, { code: 'root_browser_account_missing' });
  assert.equal(engine.launches.length, 1);
});

test('identity rejects unmappable IDs, preserves actual groups, and omits mapping on Desktop', () => {
  const host = { platform: 'linux', geteuid: () => 1001, getegid: () => 1002, getgroups: () => [1002, 0, 42, 42] };
  assert.deepEqual(browserIdentity(host), ['--env', 'DSH_BROWSER_UID=1001', '--env', 'DSH_BROWSER_GID=1002', '--env', 'DSH_BROWSER_GROUPS=0,42']);
  for (const override of [{ geteuid: () => -1 }, { getegid: () => 0 }, { getegid: () => 0xffffffff }, { getgroups: () => [0xffffffff] }]) {
    assert.throws(() => browserIdentity({ ...host, ...override }), { code: 'docker_identity_unsupported' });
  }
  for (const platform of ['win32', 'darwin']) assert.deepEqual(browserIdentity({ platform }), []);
  for (const env of [{ DOCKER_HOST: 'ssh://remote' }, { DOCKER_CONTEXT: 'remote' }]) {
    assert.throws(() => dockerCommand({ dockerExecutable: process.execPath }, { ...host, env }), { code: 'docker_endpoint_unsupported' });
  }
});

test('macOS resolves Desktop CLI and user socket without depending on shell PATH', () => {
  const home = '/Users/test owner';
  const host = { platform: 'darwin', env: { HOME: home } };
  const candidates = ['/usr/local/bin/docker', `${home}/.docker/bin/docker`, '/Applications/Docker.app/Contents/Resources/bin/docker'];
  const socket = `${home}/.docker/run/docker.sock`;
  for (let i = 0; i < candidates.length; i++) {
    const docker = dockerCommand({}, host, path => [...candidates.slice(i), socket].includes(path));
    assert.equal(docker.executable, candidates[i]);
    assert.equal(docker.endpoint, `unix://${socket}`);
    assert.deepEqual(docker.identity, []);
  }
  const fallback = dockerCommand({}, host, () => false);
  assert.equal(fallback.executable, candidates[0]);
  assert.equal(fallback.endpoint, 'unix:///var/run/docker.sock');
  assert.equal(dockerCommand({ dockerExecutable: '/custom/docker' }, host, () => false).executable, '/custom/docker');
  assert.throws(() => dockerCommand({ dockerExecutable: 'docker' }, host), { code: 'docker_config_invalid' });
  for (const DOCKER_HOST of ['ssh://remote', 'tcp://127.0.0.1:2375', 'unix:///other/docker.sock']) {
    assert.throws(() => dockerCommand({}, { ...host, env: { ...host.env, DOCKER_HOST } }), { code: 'docker_endpoint_unsupported' });
  }
  for (const DOCKER_HOST of ['unix:///var/run/docker.sock', `unix://${socket}`]) {
    const docker = dockerCommand({}, { ...host, env: { ...host.env, DOCKER_HOST, DOCKER_CONTEXT: 'desktop-linux' } }, () => true);
    assert.equal(docker.env.DOCKER_HOST, undefined);
    assert.equal(docker.env.DOCKER_CONTEXT, undefined);
  }
});

test('Apple Silicon launches native arm64 with the existing isolation and no Host UID mapping', async () => {
  const engine = fakeEngine({ platform: 'linux/arm64' });
  const launcher = engine.launcher({ platform: 'darwin' });
  const runner = start(launcher, 'apple-silicon');
  try {
    await runner.ready;
    const [{ args }] = engine.launches;
    assert.ok(args.includes('--platform=linux/arm64'));
    assert.ok(args.includes('--network=none'));
    assert.ok(args.includes('--security-opt=no-new-privileges'));
    assert.ok(args.some(arg => arg.startsWith('--security-opt=seccomp=')));
    assert.equal(args.some(arg => /DSH_BROWSER_(UID|GID|GROUPS)=/.test(arg)), false);
  } finally { await runner.stop(); await launcher.close(); }
});

test('two Hosts racing for one profile do not start or stop a second container', async () => {
  const engine = fakeEngine();
  const first = start(engine.launcher(), 'shared');
  const second = start(engine.launcher(), 'shared');
  assert.notEqual(first.generation, second.generation);
  assert.match(first.generation, /^dsh-plugin-workspace-browser-[\da-f-]+$/);
  try {
    // Both preflights can pass before either name is reserved, so which Host wins
    // the Docker name race is not fixed; exactly one must win and the other must
    // report the occupied profile without launching or stopping anything.
    const settled = await Promise.allSettled([first.ready, second.ready]);
    assert.deepEqual(settled.map(({ status }) => status).sort(), ['fulfilled', 'rejected']);
    const winner = settled[0].status === 'fulfilled' ? first : second;
    const loser = winner === first ? second : first;
    const failure = settled.find(({ status }) => status === 'rejected').reason;
    assert.equal(failure.code, 'runner_profile_in_use');
    assert.equal(failure.status, 503);
    await loser.stop();
    const name = key('shared');
    assert.deepEqual(engine.probes, [`volume=${name}`, `volume=${name}`]);
    assert.deepEqual(engine.launches.map(({ name, volume }) => [name, volume]), [[name, name], [name, name]]);
    assert.equal(engine.launches[0].owner, winner.generation);
    assert.equal(engine.containers.get(name).owner, winner.generation);
    assert.deepEqual(engine.stops, []);
    const id = engine.containers.get(name).id;
    await winner.stop();
    assert.deepEqual(engine.stops, [id]);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test('an active container using the same volume or a failed Docker volume query blocks startup', async () => {
  const old = fakeEngine({ active: [{ name: 'old-random-name', volume: key('old'), id: 'b'.repeat(64) }] });
  const failed = fakeEngine({ preflightCode: 1 });
  await assert.rejects(start(old.launcher(), 'old').ready, { code: 'runner_profile_in_use' });
  await assert.rejects(start(failed.launcher(), 'other').ready, { code: 'runner_start_failed' });
  assert.deepEqual(old.launches, []);
  assert.deepEqual(failed.launches, []);
  assert.deepEqual(old.stops, []);
});

test('opening Chromium without an installed image never creates a container or starts a build', async () => {
  const engine = fakeEngine({ imageMissing: true });
  await assert.rejects(start(engine.launcher(), 'missing-image').ready, { code: 'runner_image_missing' });
  assert.deepEqual(engine.launches, []);
  assert.deepEqual(engine.probes, []);
});

test('the renamed runner does not use or stop a legacy profile container', async () => {
  const legacyName = `dsh-browser-${key('shared').slice(-64)}`;
  const legacy = { name: legacyName, volume: legacyName, id: 'b'.repeat(64) };
  const engine = fakeEngine({ active: [legacy] });
  const runner = start(engine.launcher(), 'shared');
  try {
    await runner.ready;
    assert.deepEqual(engine.probes, [`volume=${key('shared')}`]);
    assert.equal(engine.launches[0].volume, key('shared'));
  } finally {
    await runner.stop();
  }
  assert.equal(engine.containers.get(legacyName), legacy);
  assert.ok(!engine.stops.includes(legacy.id));
});

test('separate profile volumes run independently with unchanged Docker sandbox flags', async () => {
  const engine = fakeEngine();
  const launcher = engine.launcher();
  const first = start(launcher, 'first');
  const second = start(launcher, 'second');
  try {
    await Promise.all([first.ready, second.ready]);
    assert.notEqual(engine.launches[0].name, engine.launches[1].name);
    for (const { args } of engine.launches) {
      assert.ok(args.includes('dev.dsh.dsh-plugin-workspace-browser=1'));
      assert.deepEqual(args.flatMap((arg, i) => arg === '--mount' ? [args[i+1]] : []), [
        `type=volume,source=${args[args.indexOf('--name') + 1]},target=/profile`, await workspaceMount(process.cwd()),
      ]);
      assert.deepEqual(args.flatMap((arg, i) => arg === '--env' ? [args[i+1]] : []),
        ['DSH_BROWSER_UID=1001', 'DSH_BROWSER_GID=1002', 'DSH_BROWSER_GROUPS=123']);
      assert.ok(args.includes('--network=none'));
      assert.ok(args.includes('--pull=never'));
      assert.equal(args.at(-1), imageId);
      assert.ok(args.includes('--security-opt=no-new-privileges'));
      assert.ok(args.some(arg => arg.startsWith('--security-opt=seccomp=')));
    }
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test('startup frames keep recovery and sandbox failures distinct', async () => {
  for (const code of ['runner_profile_recovery_failed', 'runner_isolation_failed', 'runner_workspace_invalid', 'runner_workspace_permission_denied', 'runner_start_failed']) {
    const engine = fakeEngine({ frame: { type: 'startup-error', code } });
    const runner = start(engine.launcher(), code);
    await assert.rejects(runner.ready, { code, status: 503 });
    await runner.stop();
    assert.deepEqual(engine.stops, []);
  }
});

test('a ready runner exiting independently notifies the pool once and closes attached displays', async () => {
  const engine = fakeEngine();
  let exits = 0;
  let displayCloses = 0;
  const runner = engine.launcher().start('terminated', () => { exits++; }, process.cwd());
  await runner.ready;
  runner.attach({ send: () => {}, close: () => { displayCloses++; } });
  const name = key('terminated');
  const container = engine.containers.get(name);
  engine.containers.delete(name); // Docker --rm removes the container when the runner exits.
  container.close(0);
  assert.equal(exits, 1);
  assert.equal(displayCloses, 1);
  await runner.stop();
  assert.equal(exits, 1);
  assert.deepEqual(engine.stops, []);
});

test('ambiguous container lookup prevents shutdown by name or ID', async () => {
  const engine = fakeEngine({ invalidCleanup: true });
  const runner = start(engine.launcher(), 'ambiguous');
  await runner.ready;
  await runner.stop();
  assert.deepEqual(engine.stops, []);
});
