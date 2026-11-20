import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createImagePreparer, parseImageManifest } from '../src/host/image.js';

const imageId = `sha256:${'a'.repeat(64)}`;
const platform = 'linux/amd64';
const matching = { code: 0, output: `${imageId} ${platform}\n` };
const missing = { code: 1, output: '' };
const archive = Buffer.from('test runner archive');
const manifest = { imageId, platform, archiveSha256: createHash('sha256').update(archive).digest('hex') };

async function fixture(t, contents = archive) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runner-test-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, 'runner-image.json'), JSON.stringify(manifest));
  if (contents !== null) await writeFile(join(root, 'runner-image.tar.gz'), contents);
  return pathToFileURL(root + sep);
}

function prepare(dir, f) {
  const signal = new AbortController().signal;
  const calls = [];
  const preparer = createImagePreparer((args, requestSignal, phase) => {
    requestSignal.throwIfAborted();
    calls.push({ args, phase });
    if (args[0] === 'version') return Promise.resolve({ code: 0, output: `${platform}\n` });
    return f(args);
  }, dir);
  return { get: () => preparer.get(signal), calls };
}

test('verifies image identity, and only a missing image imports the bundled archive once', async t => {
  let loaded = false;
  const { get, calls } = prepare(await fixture(t), async args => {
    if (args[1] === 'inspect') {
      assert.equal(args.at(-1), imageId);
      return loaded ? matching : missing;
    }
    assert.deepEqual(args.slice(0, 3), ['image', 'load', '--input']);
    assert.deepEqual(await readFile(args[3]), archive);
    loaded = true;
    return { code: 0, output: '' };
  });
  const first = get();
  assert.strictEqual(get(), first);
  assert.equal(await first, imageId);
  assert.equal(await get(), imageId);
  assert.deepEqual(calls.map(call => call.args[1]), ['--format', 'inspect', 'load', 'inspect', '--format', 'inspect']);
});

test('does not load an invalid archive or accept an unexpected cached image', async t => {
  const dir = await fixture(t, 'corrupt archive');
  for (const inspect of [missing, { code: 0, output: `${imageId} linux/arm64` }]) {
    const { get } = prepare(dir, async args => {
      assert.equal(args[1], 'inspect');
      return inspect;
    });
    await assert.rejects(get(), { code: 'runner_bundle_invalid' });
  }
  assert.throws(() => parseImageManifest({ ...manifest, platform: 'linux/arm64' }));
  assert.throws(() => parseImageManifest({ ...manifest, archive: '../../image.tar' }));
});

test('does not trust Docker load success alone and permits a later retry', async t => {
  let loads = 0;
  const { get } = prepare(await fixture(t), async args => {
    if (args[1] === 'load') {
      loads++;
      return { code: loads === 1 ? 1 : 0 };
    }
    return loads >= 3 ? matching : missing;
  });
  await assert.rejects(get(), { code: 'runner_image_load_failed' });
  await assert.rejects(get(), { code: 'runner_image_load_failed' });
  assert.equal(await get(), imageId);
});

test('engine refusal does not inspect or load an image; disposal cancels pending preparation', async t => {
  const dir = await fixture(t);
  const controller = new AbortController();
  let calls = 0;
  const refused = createImagePreparer(async args => {
    calls++;
    assert.equal(args[0], 'version');
    return { code: 1, output: '' };
  }, dir);
  await assert.rejects(refused.get(controller.signal), { code: 'docker_engine_unavailable' });
  assert.equal(calls, 1);

  const started = Promise.withResolvers();
  const preparer = createImagePreparer(async (_args, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    started.resolve();
  }), dir);
  const canceled = assert.rejects(preparer.get(controller.signal), { name: 'AbortError' });
  await started.promise;
  controller.abort();
  await preparer.drain();
  await canceled;
});
