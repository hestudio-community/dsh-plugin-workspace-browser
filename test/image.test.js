import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRunnerEnvironment, environmentError } from '../src/host/image.js';
import {
  IMAGE_PLATFORM, RUNNER_BUILD_FILES, RUNNER_IMAGE, RUNNER_PROTOCOL, RUNNER_PROTOCOL_LABEL,
  RUNNER_VERSION, RUNNER_VERSION_LABEL, runnerBuildArgs, runnerImageTag,
} from '../src/shared/runner-image.js';

const imageId = `sha256:${'a'.repeat(64)}`;
const paths = ['dockerConfig', 'dockerCli', 'dockerEngine', 'runnerImage'];
const passed = paths.map(id => ({ id, status: 'pass' }));
const inspected = (id, version) => ({ code: 0, output: `${id} ${IMAGE_PLATFORM} ${RUNNER_PROTOCOL} ${version}\n` });
const matched = inspected(imageId, RUNNER_VERSION);
const missing = { code: 1, output: '' };
const result = (output = '', code = 0) => ({ output, code });
const context = join('test path', 'runner');
const defaultReply = phase => ({ cli: result('Docker version 29.0.0'), engine: result(IMAGE_PLATFORM), image: matched, build: result() })[phase];

function fixture({ reply = defaultReply, configError, absentFile, runnerVersion = RUNNER_VERSION } = {}) {
  const calls = [];
  const files = [];
  const docker = {};
  const controller = new AbortController();
  const environment = createRunnerEnvironment({
    configure() { if (configError) throw configError; return docker; },
    async command(options, args, signal, phase) {
      assert.equal(options, docker);
      assert.equal(signal, controller.signal);
      signal.throwIfAborted();
      calls.push({ args, phase });
      return reply(phase, signal, args);
    },
    context,
    runnerVersion,
    async inputStat(file) {
      files.push(file);
      return { isFile: () => file !== absentFile, size: 1 };
    },
    signal: controller.signal,
  });
  return { calls, files, docker, controller, environment };
}

test('checks and startup share one read-only probe, resolving the local label to an immutable ID', async () => {
  const { environment, calls, files, docker } = fixture();
  const [diagnostic, launch] = await Promise.all([environment.check(), environment.resolveImage()]);
  assert.deepEqual(diagnostic, { checks: passed, runnerVersion: RUNNER_VERSION });
  assert.deepEqual(launch, { docker, image: imageId });
  assert.deepEqual(calls.map(call => call.phase), ['cli', 'engine', 'image']);
  assert.equal(calls.at(-1).args.at(-1), RUNNER_IMAGE);
  assert.ok(calls.at(-1).args[3].includes(RUNNER_PROTOCOL_LABEL));
  assert.ok(calls.at(-1).args[3].includes(RUNNER_VERSION_LABEL));
  assert.deepEqual(files, []);
  await environment.check();
  assert.equal(calls.length, 6, 'completed results must not be cached');
});

test('diagnostics report the failing stage, skip dependencies, and give startup the same error', async () => {
  const cases = [
    [0, 'docker_config_invalid', null],
    [1, 'docker_cli_missing', signalFailure('docker_cli_missing')],
    [1, 'docker_cli_unavailable', missing],
    [2, 'docker_engine_unavailable', missing],
    [2, 'docker_engine_incompatible', result('linux/arm64')],
    [3, 'runner_image_missing', missing],
    [3, 'runner_image_incompatible', result(`${imageId} linux/amd64`)],
    [3, 'runner_image_incompatible', result(`${imageId} linux/amd64 ${RUNNER_PROTOCOL}`)],
    [3, 'runner_image_incompatible', result(`${imageId} linux/amd64 2 ${RUNNER_VERSION}`)],
    [3, 'runner_image_incompatible', result(`${imageId} linux/arm64 ${RUNNER_PROTOCOL} ${RUNNER_VERSION}`)],
    [3, 'runner_image_incompatible', result(`not-a-sha linux/amd64 ${RUNNER_PROTOCOL} ${RUNNER_VERSION}`)],
    [3, 'runner_image_incompatible', inspected(imageId, `${RUNNER_VERSION} `)],
    [3, 'runner_image_incompatible', result(`${matched.output}${matched.output}`)],
  ];
  function signalFailure(code) { return () => { throw environmentError(code); }; }
  for (const [index, code, response] of cases) {
    const { environment, calls } = fixture({
      configError: index === 0 ? environmentError(code) : undefined,
      reply: (phase) => phase === ['config', 'cli', 'engine', 'image'][index]
        ? (typeof response === 'function' ? response() : response) : defaultReply(phase),
    });
    const [diagnostic] = await Promise.all([environment.check(), assert.rejects(environment.resolveImage(), { code })]);
    assert.equal(diagnostic.runnerVersion, RUNNER_VERSION);
    assert.deepEqual(diagnostic.checks, [
      ...passed.slice(0, index), { id: paths[index], status: 'fail', code },
      ...paths.slice(index + 1).map(id => ({ id, status: 'skipped' })),
    ]);
    assert.equal(calls.length, index);
  }
});

test('versioned images coexist: no fallback on upgrade, no mislabeled images, and no rebuild on rollback', async () => {
  const previousVersion = '1.2.3';
  const nextVersion = '1.2.4-rc.1+build.2';
  const previousTag = runnerImageTag(previousVersion);
  const nextTag = runnerImageTag(nextVersion);
  const nextId = `sha256:${'b'.repeat(64)}`;
  const images = new Map([[previousTag, inspected(imageId, previousVersion)]]);
  const reply = (phase, _signal, args) => {
    if (phase === 'image') return images.get(args.at(-1)) ?? missing;
    if (phase !== 'build') return defaultReply(phase);
    assert.deepEqual(args, runnerBuildArgs(context, join(context, 'Dockerfile'), nextVersion));
    images.set(nextTag, inspected(nextId, nextVersion));
    return result();
  };
  const next = fixture({ reply, runnerVersion: nextVersion });
  await assert.rejects(next.environment.resolveImage(), { code: 'runner_image_missing' });
  assert.deepEqual(next.calls.filter(call => call.phase === 'image').map(call => call.args.at(-1)), [nextTag]);

  images.set(nextTag, images.get(previousTag));
  await assert.rejects(next.environment.resolveImage(), { code: 'runner_image_incompatible' });
  assert.deepEqual(next.environment.startBuild(), { state: 'building', runnerVersion: nextVersion });
  await next.environment.drain();
  assert.deepEqual(next.environment.buildStatus(), { state: 'succeeded', runnerVersion: nextVersion });
  assert.deepEqual(await next.environment.resolveImage(), { docker: next.docker, image: nextId });
  assert.deepEqual([...images.keys()], [previousTag, nextTag]);

  images.set(previousTag, images.get(nextTag));
  const rollback = fixture({ reply, runnerVersion: previousVersion });
  await assert.rejects(rollback.environment.resolveImage(), { code: 'runner_image_incompatible' });
  images.set(previousTag, inspected(imageId, previousVersion));
  assert.deepEqual(await rollback.environment.check(), { checks: passed, runnerVersion: previousVersion });
  assert.deepEqual(await rollback.environment.resolveImage(), { docker: rollback.docker, image: imageId });
  assert.ok(rollback.calls.filter(call => call.phase === 'image').every(call => call.args.at(-1) === previousTag));
  assert.equal(rollback.calls.some(call => call.phase === 'build'), false);
});

test('only an explicit build uses packaged inputs; duplicates coalesce and success requires fresh inspection', async () => {
  const running = Promise.withResolvers();
  const released = Promise.withResolvers();
  let ready = false;
  const { environment, calls, files } = fixture({
    async reply(phase) {
      if (phase === 'image') return ready ? matched : missing;
      if (phase !== 'build') return defaultReply(phase);
      running.resolve();
      await released.promise;
      ready = true;
      return result();
    },
  });
  assert.deepEqual(environment.buildStatus(), { state: 'idle', runnerVersion: RUNNER_VERSION });
  assert.equal((await environment.check()).checks.at(-1).code, 'runner_image_missing');
  assert.deepEqual(environment.startBuild(), { state: 'building', runnerVersion: RUNNER_VERSION });
  await running.promise;
  assert.deepEqual(environment.startBuild(), { state: 'building', runnerVersion: RUNNER_VERSION });
  assert.deepEqual(files, RUNNER_BUILD_FILES.map(name => join(context, name)));
  assert.deepEqual(calls.filter(call => call.phase === 'build').map(call => call.args), [
    runnerBuildArgs(context, join(context, 'Dockerfile')),
  ]);
  released.resolve();
  await environment.drain();
  assert.deepEqual(environment.buildStatus(), { state: 'succeeded', runnerVersion: RUNNER_VERSION });
  assert.equal(calls.at(-1).phase, 'image');
  assert.deepEqual(await environment.check(), { checks: passed, runnerVersion: RUNNER_VERSION });
});

test('build rejects missing inputs, nonzero exit, timeout, and unverified output; retry is allowed', async () => {
  const absent = fixture({ absentFile: join(context, 'Dockerfile') });
  absent.environment.startBuild();
  await absent.environment.drain();
  assert.deepEqual(absent.environment.buildStatus(), { state: 'failed', runnerVersion: RUNNER_VERSION, code: 'runner_build_inputs_missing' });
  assert.deepEqual(absent.calls.map(call => call.phase), ['cli', 'engine']);

  let attempts = 0;
  const { environment } = fixture({ reply(phase) {
    if (phase === 'build') {
      attempts++;
      if (attempts === 1) return missing;
      if (attempts === 2) throw environmentError('runner_build_timeout');
    }
    if (phase === 'image' && attempts === 3) return inspected(imageId, `${RUNNER_VERSION}0`);
    return defaultReply(phase);
  } });
  for (const code of ['runner_build_failed', 'runner_build_timeout', 'runner_build_image_invalid']) {
    environment.startBuild();
    await environment.drain();
    assert.deepEqual(environment.buildStatus(), { state: 'failed', runnerVersion: RUNNER_VERSION, code });
  }
  environment.startBuild();
  await environment.drain();
  assert.deepEqual(environment.buildStatus(), { state: 'succeeded', runnerVersion: RUNNER_VERSION });
});

test('Host shutdown cancels inspection and build and drains their work', async () => {
  const checkStarted = Promise.withResolvers();
  const buildStarted = Promise.withResolvers();
  const { environment, controller } = fixture({ reply(phase, signal) {
    if (phase !== 'image' && phase !== 'build') return defaultReply(phase);
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      (phase === 'image' ? checkStarted : buildStarted).resolve();
    });
  } });
  const canceled = assert.rejects(environment.check(), { name: 'AbortError' });
  environment.startBuild();
  await Promise.all([checkStarted.promise, buildStarted.promise]);
  controller.abort();
  await environment.drain();
  await canceled;
  assert.notEqual(environment.buildStatus().state, 'building');
  assert.throws(environment.startBuild, { name: 'AbortError' });
});
