import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { browserIdentity, workspaceMount } from '../src/host/workspace.js';
import { dockerCommand, createRunnerLauncher } from '../src/host/runner.js';
import { IMAGE_PLATFORM, RUNNER_IMAGE, RUNNER_PROTOCOL, RUNNER_VERSION } from '../src/shared/runner-image.js';

const key = id => `dsh-plugin-workspace-browser-${createHash('sha256').update('default\0' + id).digest('hex')}`;
const label = 'dev.dsh.dsh-plugin-workspace-browser.instance';
const imageId = `sha256:${'a'.repeat(64)}`;

function fakeEngine({ active = [], preflightCode = 0, frame = { type: 'ready' }, invalidCleanup = false, imageMissing = false } = {}) {
  const containers = new Map(active.map(row => [row.name, row]));
  const launches = [];
  const stops = [];
  const probes = [];
  const result = (output = '', code = 0) => ({ output, code });
  async function queryDocker(_docker, args, signal) {
    signal.throwIfAborted();
    if (args[0] === '--version') return result('Docker version 29.0.0');
    if (args[0] === 'info') return result('linux/x86_64 ["name=seccomp,profile=builtin"]');
    if (args[0] === 'image') {
      assert.equal(args.at(-1), RUNNER_IMAGE);
      return imageMissing ? result('', 1) : result(`${imageId} ${IMAGE_PLATFORM} ${RUNNER_PROTOCOL} ${RUNNER_VERSION}`);
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
    launches.push({ name, volume, owner, args, stdout: child.stdout });
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
  const launcher = () => createRunnerLauncher({}, { queryDocker, spawnDocker, host });
  return { containers, launcher, launches, probes, stops };
}

const start = (launcher, workspace) => launcher.start(workspace, () => {}, process.cwd());

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

test('identity rejects root or unmappable IDs, preserves actual groups, and omits mapping on Desktop', () => {
  const host = { platform: 'linux', geteuid: () => 1001, getegid: () => 1002, getgroups: () => [1002, 0, 42, 42] };
  assert.deepEqual(browserIdentity(host), ['--env', 'DSH_BROWSER_UID=1001', '--env', 'DSH_BROWSER_GID=1002', '--env', 'DSH_BROWSER_GROUPS=0,42']);
  for (const override of [{ geteuid: () => 0 }, { getegid: () => 0 }, { getgroups: () => [0xffffffff] }]) {
    assert.throws(() => browserIdentity({ ...host, ...override }), { code: 'docker_identity_unsupported' });
  }
  for (const platform of ['win32', 'darwin']) assert.deepEqual(browserIdentity({ platform }), []);
  for (const env of [{ DOCKER_HOST: 'ssh://remote' }, { DOCKER_CONTEXT: 'remote' }]) {
    assert.throws(() => dockerCommand({ dockerExecutable: process.execPath }, { ...host, env }), { code: 'docker_endpoint_unsupported' });
  }
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
  for (const code of ['runner_profile_recovery_failed', 'runner_isolation_failed', 'runner_start_failed']) {
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
