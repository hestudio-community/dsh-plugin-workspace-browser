import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from '../scripts/runner-release.mjs';
import { dockerCommand } from '../src/host/runner.js';
import { RUNNER_IMAGE } from '../src/shared/runner-image.js';

test('release builds preserve PATH resolution outside macOS and select the local daemon platform', () => {
  for (const platform of ['linux', 'darwin', ...(process.platform === 'win32' ? ['win32'] : [])]) {
    const host = { platform, geteuid: () => 0, env: { PATH: '/custom/docker/bin', HOME: '/Users/release', SystemRoot: 'C:\\Windows' } };
    const calls = [];
    build({ host, execute: (executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0, stdout: 'linux/aarch64\n' };
    } });
    const docker = dockerCommand({}, host);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.executable, platform === 'darwin' ? docker.executable : 'docker');
      assert.deepEqual(call.args.slice(0, 2), ['--host', docker.endpoint]);
      assert.deepEqual(call.options.env, docker.env);
      assert.equal(call.options.cwd, platform === 'win32' ? 'C:\\Windows' : '/');
    }
    assert.equal(calls[0].options.timeout, 10_000);
    assert.deepEqual(calls[1].args.slice(2, 5), ['build', '--platform', 'linux/arm64']);
    assert.equal(calls[1].args[calls[1].args.indexOf('--tag') + 1], RUNNER_IMAGE);
  }
});

test('release build stops before building on an unsupported or failed daemon probe', () => {
  for (const probe of [{ status: 0, stdout: 'linux/ppc64le\n' }, { status: 1 }, { error: new Error('spawn failed') }]) {
    let calls = 0;
    assert.throws(() => build({ host: { platform: 'linux', geteuid: () => 0, env: {} }, execute: () => { calls++; return probe; } }));
    assert.equal(calls, 1);
  }
});
