import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createRunnerLauncher } from '../src/host/runner.js';

const key = id => `dsh-browser-${createHash('sha256').update('default\0' + id).digest('hex')}`;
const label = 'dev.dsh.workspace-browser.instance';

function fakeEngine({ active = [], preflightCode = 0, frame = { type: 'ready' }, invalidCleanup = false } = {}) {
  const containers = new Map(active.map(row => [row.name, row]));
  const launches = [];
  const stops = [];
  const probes = [];
  const result = (output = '', code = 0) => ({ output, code });
  async function queryDocker(_docker, args, signal) {
    signal.throwIfAborted();
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
    launches.push({ name, volume, owner, args });
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
  const launcher = () => createRunnerLauncher({}, {
    queryDocker, spawnDocker,
    prepareImage: () => ({ get: async () => `sha256:${'a'.repeat(64)}`, drain: async () => {} }),
  });
  return { containers, launcher, launches, probes, stops };
}

const start = (launcher, workspace) => launcher.start(workspace, () => {});

test('two Hosts racing for one profile do not start or stop a second container', async () => {
  const engine = fakeEngine();
  const first = start(engine.launcher(), 'shared');
  const second = start(engine.launcher(), 'shared');
  assert.notEqual(first.generation, second.generation);
  try {
    await Promise.all([first.ready, assert.rejects(second.ready, { code: 'runner_profile_in_use', status: 503 })]);
    await second.stop();
    const name = key('shared');
    assert.deepEqual(engine.probes, [`volume=${name}`, `volume=${name}`]);
    assert.deepEqual(engine.launches.map(({ name, volume }) => [name, volume]), [[name, name], [name, name]]);
    assert.equal(engine.launches[0].owner, first.generation);
    assert.equal(engine.containers.get(name).owner, first.generation);
    assert.deepEqual(engine.stops, []);
    const id = engine.containers.get(name).id;
    await first.stop();
    assert.deepEqual(engine.stops, [id]);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test('an active old runner or a failed Docker volume query blocks startup', async () => {
  const old = fakeEngine({ active: [{ name: 'old-random-name', volume: key('old'), id: 'b'.repeat(64) }] });
  const failed = fakeEngine({ preflightCode: 1 });
  await assert.rejects(start(old.launcher(), 'old').ready, { code: 'runner_profile_in_use' });
  await assert.rejects(start(failed.launcher(), 'other').ready, { code: 'runner_start_failed' });
  assert.deepEqual(old.launches, []);
  assert.deepEqual(failed.launches, []);
  assert.deepEqual(old.stops, []);
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
      assert.ok(args.includes('--network=none'));
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
  const runner = engine.launcher().start('terminated', () => { exits++; });
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
