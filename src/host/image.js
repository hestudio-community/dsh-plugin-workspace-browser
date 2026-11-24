import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserError } from '../shared/protocol.js';
import {
  runnerPlatform, RUNNER_BUILD_FILES, RUNNER_PROTOCOL, RUNNER_PROTOCOL_LABEL, RUNNER_VERSION, RUNNER_VERSION_LABEL,
  runnerBuildArgs, runnerImageTag,
} from '../shared/runner-image.js';

const defaultContext = fileURLToPath(new URL('../../runner/', import.meta.url));
const checkIds = ['dockerConfig', 'dockerCli', 'dockerEngine', 'runnerImage'];
const imageFormat = `{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "${RUNNER_PROTOCOL_LABEL}"}} {{index .Config.Labels "${RUNNER_VERSION_LABEL}"}}`;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;

export function environmentError(code) {
  const messages = {
    docker_config_invalid: 'The Docker CLI and seccomp profile must use valid absolute paths.',
    docker_endpoint_unsupported: 'Select the default local Docker endpoint; remote engines cannot mount this workspace.',
    docker_identity_unsupported: 'On Linux, use a local rootful Docker engine without user namespace remapping. On Windows or macOS, use local Docker Desktop.',
    runner_workspace_invalid: 'Verify that the registered workspace still names the original directory and Docker can share it with read/write access.',
    docker_cli_missing: 'The local Docker CLI was not found.',
    docker_cli_unavailable: 'The local Docker CLI could not be run.',
    docker_engine_unavailable: 'The local Docker engine could not be reached.',
    docker_engine_incompatible: 'A local Linux/amd64 or Linux/arm64 Docker engine is required.',
    runner_image_missing: 'The Runner image is missing or could not be inspected. Check the environment or build the image in the plugin settings.',
    runner_image_incompatible: 'The local Runner image is incompatible. Rebuild it in the plugin settings.',
    runner_build_inputs_missing: 'Runner build files are missing or unreadable. Reinstall the complete plugin package.',
    runner_build_failed: 'Docker could not build the Runner image.',
    runner_build_timeout: 'The Runner image build timed out.',
    runner_build_image_invalid: 'The built Runner image could not be verified.',
  };
  return new BrowserError(code, messages[code], 503);
}

async function detectAclTools() {
  try {
    for (const path of ['/usr/bin/getfacl', '/usr/bin/setfacl']) {
      if (!(await stat(path)).isFile()) return false;
      await access(path, constants.X_OK);
    }
    return true;
  } catch { return false; }
}

export function createRunnerEnvironment({ configure, command, signal, rootAccount, aclTools = detectAclTools, context = defaultContext, inputStat = stat, runnerVersion = RUNNER_VERSION }) {
  const imageTag = runnerImageTag(runnerVersion);
  let checking;
  let building;
  let buildStatus = { state: 'idle' };

  async function inspectImage(docker) {
    const { code, output } = await command(docker, ['image', 'inspect', '--format', imageFormat, imageTag], signal, 'image');
    signal.throwIfAborted();
    if (code !== 0) throw environmentError('runner_image_missing');
    const row = output.replace(/\r?\n$/, '');
    const [id, platform, protocol, version, ...extra] = row.split(' ');
    if (/[\r\n]/.test(row) || extra.length || !imageIdPattern.test(id) ||
        platform !== docker.imagePlatform || protocol !== RUNNER_PROTOCOL || version !== runnerVersion) {
      throw environmentError('runner_image_incompatible');
    }
    return id;
  }

  async function probe(includeImage) {
    const checks = [];
    let docker;
    let image;
    const steps = [
      async () => { docker = configure(); },
      async () => {
        const result = await command(docker, ['--version'], signal, 'cli');
        if (result.code !== 0 || !result.output.trim()) throw environmentError('docker_cli_unavailable');
      },
      async () => {
        const result = await command(docker, ['info', '--format', '{{.OSType}}/{{.Architecture}} {{json .SecurityOptions}}'], signal, 'engine');
        if (result.code !== 0 || !result.output.trim()) throw environmentError('docker_engine_unavailable');
        const match = /^(linux\/\S+) (.+)$/.exec(result.output.trim());
        const platform = runnerPlatform(match?.[1]);
        if (!platform) throw environmentError('docker_engine_incompatible');
        docker.imagePlatform = platform;
        let options;
        try { options = JSON.parse(match[2]); } catch { /* Unknown identity mapping: fail closed. */ }
        if (!Array.isArray(options) || options.some(value => typeof value !== 'string' || /(?:^|,)name=(?:rootless|userns)(?:,|$)/.test(value))) {
          throw environmentError('docker_identity_unsupported');
        }
      },
      async () => { image = await inspectImage(docker); },
    ];
    let error;
    for (let i = 0; i < (includeImage ? steps.length : steps.length - 1); i++) {
      signal.throwIfAborted();
      const id = checkIds[i];
      if (error) { checks.push({ id, status: 'skipped' }); continue; }
      try {
        await steps[i]();
        checks.push({ id, status: 'pass' });
      } catch (failure) {
        signal.throwIfAborted();
        if (!(failure instanceof BrowserError)) throw failure;
        error = failure;
        checks.push({ id, status: 'fail', code: failure.code });
      }
    }
    signal.throwIfAborted();
    if (includeImage && rootAccount) {
      try {
        const account = await rootAccount();
        checks.push({ id: 'rootBrowserAccount', status: 'pass', account });
        if (docker) docker.rootAccount = account;
      } catch (failure) {
        if (!(failure instanceof BrowserError)) throw failure;
        // Root sessions always direct the owner to configuration first. The
        // complete environment report still includes independent Docker failures.
        error = failure;
        checks.push({ id: 'rootBrowserAccount', status: 'fail', code: failure.code });
      }
      checks.push(await aclTools() ? { id: 'workspaceAclTools', status: 'pass' }
        : { id: 'workspaceAclTools', status: 'warn', code: 'workspace_acl_tools_missing' });
      signal.throwIfAborted();
    }
    return { checks, error, docker, image };
  }

  function check() {
    checking ??= probe(true).finally(() => { checking = undefined; });
    return checking;
  }

  async function build() {
    try {
      const { docker, error } = await probe(false);
      if (error) throw error;
      for (const name of RUNNER_BUILD_FILES) {
        signal.throwIfAborted();
        const info = await inputStat(join(context, name)).catch(() => null);
        if (!info?.isFile() || !info.size) throw environmentError('runner_build_inputs_missing');
      }
      const result = await command(docker, runnerBuildArgs(context, join(context, 'Dockerfile'), runnerVersion, docker.imagePlatform), signal, 'build');
      signal.throwIfAborted();
      if (result.code !== 0) throw environmentError('runner_build_failed');
      try { await inspectImage(docker); }
      catch { signal.throwIfAborted(); throw environmentError('runner_build_image_invalid'); }
      buildStatus = { state: 'succeeded' };
    } catch (error) {
      buildStatus = { state: 'failed', code: !signal.aborted && error instanceof BrowserError ? error.code : 'runner_build_failed' };
    }
  }

  return {
    async check() { return { checks: (await check()).checks, runnerVersion }; },
    async resolveImage() {
      const { docker, image, error } = await check();
      if (error) throw error;
      return { docker, image };
    },
    startBuild() {
      signal.throwIfAborted();
      if (!building) {
        buildStatus = { state: 'building' };
        building = build().finally(() => { building = undefined; });
      }
      return { ...buildStatus, runnerVersion };
    },
    buildStatus: () => ({ ...buildStatus, runnerVersion }),
    async drain() { await Promise.allSettled([checking, building]); },
  };
}
