import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserError, MAX_CHUNK, MAX_FRAME, validId } from '../shared/protocol.js';
import { resolvePublicIPv4 } from './egress.js';
import { createImagePreparer, IMAGE_PLATFORM } from './image.js';

const DEFAULT_SECCOMP = fileURLToPath(new URL('./chromium-seccomp.json', import.meta.url));
const LIMIT = 4 * 1024 * 1024;
const BOOT_MS = 45_000;
const COMMAND_MS = 15_000;
const MAX_TUNNELS = 96;
const INSTANCE_LABEL = 'dev.dsh.workspace-browser.instance';
const containerId = /^[a-f0-9]{64}$/;

const runnerUnavailable = () => new BrowserError('runner_unavailable', 'The Chromium runner stopped.', 503);
const startupFailure = code => new BrowserError(code, 'Chromium runner could not start.', 503);
const startupCodes = new Set(['runner_start_failed', 'runner_isolation_failed', 'runner_display_failed', 'runner_profile_recovery_failed']);
const dockerFailure = (phase, error) => startupFailure(error?.code === 'ENOENT' ? 'docker_cli_missing' :
  phase === 'engine' ? 'docker_engine_unavailable' : phase === 'load' ? 'runner_image_load_failed' : 'runner_start_failed');

function decodeChunk(value) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_CHUNK / 3) * 4) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length <= MAX_CHUNK && bytes.toString('base64') === value ? bytes : null;
}

function dockerCommand(config) {
  const windows = process.platform === 'win32';
  const executable = config.dockerExecutable || (windows
    ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')
    : '/usr/bin/docker');
  if (!isAbsolute(executable)) throw new BrowserError('docker_config_invalid', 'The Docker CLI must use an absolute path.', 503);
  const seccomp = config.seccompProfile || DEFAULT_SECCOMP;
  if (!isAbsolute(seccomp) || /[\r\n]/.test(seccomp)) {
    throw new BrowserError('docker_config_invalid', 'The Docker seccomp profile must use a valid absolute path.', 503);
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^DOCKER_(HOST|CONTEXT|TLS|TLS_VERIFY|CERT_PATH)$/i.test(key)) delete env[key];
  const endpoint = windows ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock';
  return { executable, endpoint, env, seccomp };
}

function runDocker(docker, args, stdio) {
  return spawn(docker.executable, ['--host', docker.endpoint, ...args], {
    env: docker.env, cwd: process.platform === 'win32' ? (process.env.SystemRoot || 'C:\\Windows') : '/',
    stdio, windowsHide: true,
  });
}

function dockerQuery(docker, args, signal, phase) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const limit = phase === 'load' ? 180_000 : 10_000;
    let child;
    try { child = runDocker(docker, args, ['ignore', 'pipe', 'ignore']); }
    catch (error) { reject(dockerFailure(phase, error)); return; }
    let output = '';
    let failure;
    const stop = error => { failure ??= error; child.kill(); };
    const cancel = () => stop(signal.reason);
    const timer = setTimeout(() => stop(dockerFailure(phase)), limit);
    timer.unref?.();
    signal.addEventListener('abort', cancel, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (phase === 'load') return;
      if (output.length + chunk.length > 1024) stop(dockerFailure(phase));
      else output += chunk;
    });
    child.stdout.on('error', () => stop(dockerFailure(phase)));
    child.on('error', error => { failure ??= dockerFailure(phase, error); });
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else resolve({ code, output });
    });
  });
}

export function createRunnerLauncher(config, { spawnDocker = runDocker, queryDocker = dockerQuery, prepareImage = createImagePreparer } = {}) {
  const admission = new AbortController();
  const prepare = prepareImage((args, signal, phase) => queryDocker(dockerCommand(config), args, signal, phase));
  return {
    start(workspaceId, onExit) {
      const docker = dockerCommand(config);
      return createRunner(config, workspaceId, onExit, docker, prepare, admission.signal, spawnDocker, queryDocker);
    },
    async close() {
      admission.abort(runnerUnavailable());
      await prepare.drain();
    },
  };
}

function createRunner(config, workspaceId, onExit, docker, prepare, admissionSignal, spawnDocker, queryDocker) {
  const workspaceKey = createHash('sha256').update(config.profileNamespace || 'default').update('\0').update(workspaceId).digest('hex');
  const volume = `dsh-browser-${workspaceKey}`;
  const name = volume;
  const generation = `dsh-browser-${randomUUID()}`;
  const nameFilter = `name=^/${name}$`;
  const startup = new AbortController();
  const startupSignal = AbortSignal.any([admissionSignal, startup.signal]);
  let child;
  let bootTimer;

  const views = new Map();
  const tunnels = new Map();
  const pending = new Map();
  let stopped = false;
  let readySeen = false;
  let stopPromise;
  let resolveReady;
  let rejectReady;
  let partial = Buffer.alloc(0);
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let reportedFailure;

  function send(payload) {
    if (stopped || !child?.stdin.writable) return false;
    const line = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(line) > MAX_FRAME || child.stdin.writableLength > LIMIT) {
      void stop();
      return false;
    }
    child.stdin.write(line);
    return true;
  }

  function chunks(type, id, data) {
    for (let i = 0; i < data.length; i += MAX_CHUNK) {
      if (!send({ type, id, data: data.subarray(i, i + MAX_CHUNK).toString('base64') })) return false;
    }
    return true;
  }

  function closeTunnel(id, notify) {
    const room = tunnels.get(id);
    if (!room) return;
    tunnels.delete(id);
    room.socket?.destroy();
    if (notify) send({ type: room.connected ? 'net-close' : 'net-opened', id, ...(room.connected ? {} : { ok: false }) });
  }

  async function openTunnel({ id, host, port }) {
    if (tunnels.has(id)) { void stop(); return; }
    if ((port !== 80 && port !== 443) || tunnels.size >= MAX_TUNNELS) {
      send({ type: 'net-opened', id, ok: false });
      return;
    }
    const room = { socket: null, connected: false };
    tunnels.set(id, room);
    try {
      const address = await resolvePublicIPv4(host);
      if (stopped || tunnels.get(id) !== room) return;
      const socket = room.socket = connect({ host: address, port, family: 4 });
      socket.setTimeout(30_000, () => closeTunnel(id, true));
      socket.once('connect', () => {
        if (tunnels.get(id) !== room) return;
        room.connected = true;
        send({ type: 'net-opened', id, ok: true });
      });
      socket.on('data', (data) => chunks('net-data', id, data));
      socket.on('error', () => closeTunnel(id, true));
      socket.on('close', () => closeTunnel(id, true));
    } catch {
      if (tunnels.get(id) === room) closeTunnel(id, true);
    }
  }

  function accept(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    if (!readySeen && message.type === 'startup-error' && startupCodes.has(message.code)) {
      reportedFailure = startupFailure(message.code);
      return true;
    }
    if (reportedFailure) return false;
    if (message.type === 'ready' && !readySeen) {
      readySeen = true;
      clearTimeout(bootTimer);
      resolveReady();
      return true;
    }
    if (!validId(message.id)) return false;
    const { id } = message;
    switch (message.type) {
      case 'rfb': {
        const bytes = decodeChunk(message.data);
        if (!bytes) return false;
        views.get(id)?.send(bytes);
        return true;
      }
      case 'rfb-close': {
        const view = views.get(id);
        views.delete(id);
        view?.close();
        return true;
      }
      case 'net-open':
        void openTunnel(message);
        return true;
      case 'net-data': {
        const bytes = decodeChunk(message.data);
        if (!bytes) return false;
        const room = tunnels.get(id);
        if (!room?.connected) return true;
        if (room.socket.writableLength > LIMIT) closeTunnel(id, true);
        else room.socket.write(bytes);
        return true;
      }
      case 'net-close':
        closeTunnel(id, false);
        return true;
      case 'automation-result': {
        const task = pending.get(id);
        if (message.ok === true) task?.finish(null, message.value);
        else task?.finish(new BrowserError('browser_action_failed', 'Chromium could not complete the operation; the page may have changed.', 409));
        return true;
      }
      default:
        return false;
    }
  }

  function handleOutput(data) {
    while (data.length && !stopped) {
      const newline = data.indexOf(10);
      const part = newline === -1 ? data : data.subarray(0, newline);
      if (partial.length + part.length >= MAX_FRAME) { void stop(); return; }
      if (newline === -1) { partial = Buffer.concat([partial, part]); return; }
      try {
        if (!accept(JSON.parse(Buffer.concat([partial, part]).toString('utf8')))) { void stop(); return; }
      } catch {
        void stop();
        return;
      }
      partial = Buffer.alloc(0);
      data = data.subarray(newline + 1);
    }
  }

  async function containerWithName(signal) {
    const { code, output } = await queryDocker(docker, [
      'ps', '--all', '--no-trunc', '--filter', nameFilter,
      '--format', `{{.ID}} {{.Label "${INSTANCE_LABEL}"}}`,
    ], signal, 'run');
    if (code !== 0) throw startupFailure('runner_start_failed');
    const row = output.trim();
    if (!row) return null;
    const [id, owner = '', ...extra] = row.split(/\s+/);
    if (!containerId.test(id) || extra.length || /[\r\n]/.test(row)) throw startupFailure('runner_start_failed');
    return { id, owner };
  }

  async function dockerClosed() {
    if (stopped) return;
    if (!readySeen && !reportedFailure) {
      // The Docker daemon atomically reserves the fixed name. A racing Host
      // must not launch against, or stop, the winning container.
      const found = await containerWithName(startupSignal).catch(() => null);
      if (found && found.owner !== generation) reportedFailure = startupFailure('runner_profile_in_use');
    }
    void stop();
  }

  void (async () => {
    try {
      const image = await prepare.get(admissionSignal);
      startupSignal.throwIfAborted();
      // Also detect active pre-upgrade containers, which used random names.
      const active = await queryDocker(docker, [
        'ps', '--filter', `volume=${volume}`, '--format', '{{.ID}}',
      ], startupSignal, 'run');
      startupSignal.throwIfAborted();
      if (active.code !== 0) throw startupFailure('runner_start_failed');
      if (active.output.trim()) throw startupFailure('runner_profile_in_use');
      child = spawnDocker(docker, [
        'run', '--rm', '--interactive', '--init', '--pull=never', '--network=none', `--platform=${IMAGE_PLATFORM}`,
        '--security-opt=no-new-privileges', `--security-opt=seccomp=${docker.seccomp}`,
        '--pids-limit=384', '--shm-size=256m', '--memory=2g',
        '--name', name, '--label', 'dev.dsh.workspace-browser=1', '--label', `${INSTANCE_LABEL}=${generation}`,
        '--mount', `type=volume,source=${volume},target=/profile`, image,
      ], ['pipe', 'pipe', 'ignore']);
      bootTimer = setTimeout(() => void stop(startupFailure('runner_start_timeout')), BOOT_MS);
      bootTimer.unref?.();
      child.stdout.on('data', handleOutput);
      child.stdout.on('error', () => void stop());
      // EPIPE can precede the final startup status frame. Let close drain stdout.
      child.stdin.on('error', () => { if (readySeen) void stop(); });
      child.on('error', error => void stop(dockerFailure('run', error)));
      child.once('close', () => { void dockerClosed(); });
    } catch (error) {
      void stop(error instanceof BrowserError ? error : dockerFailure('run', error));
    }
  })();

  function stop(error = reportedFailure ?? (readySeen ? runnerUnavailable() : startupFailure('runner_start_failed'))) {
    if (stopped) return stopPromise ?? Promise.resolve();
    stopped = true;
    startup.abort(error);
    clearTimeout(bootTimer);
    rejectReady(error);
    for (const [id, view] of views) { views.delete(id); view.close(); }
    for (const id of tunnels.keys()) closeTunnel(id, false);
    for (const task of pending.values()) task.finish(runnerUnavailable());
    child?.stdin.end();
    stopPromise = (async () => {
      if (!child?.pid) return;
      // EOF and Docker's SIGTERM both request a graceful Chromium shutdown.
      // Only stop the immutable ID whose generation belongs to this launch.
      const signal = AbortSignal.timeout(9000);
      try {
        const found = await containerWithName(signal);
        if (found?.owner === generation) await queryDocker(docker, ['stop', '--timeout=6', found.id], signal, 'run');
      } catch { /* Uncertain ownership: leave the container alone. */ }
      finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
    })();
    onExit();
    return stopPromise;
  }

  return {
    generation,
    ready,
    stop,
    attach(view) {
      const id = randomUUID();
      views.set(id, view);
      if (!send({ type: 'rfb-open', id })) { views.delete(id); view.close(); }
      return {
        send: (data) => views.has(id) && chunks('rfb', id, data),
        close: () => { if (views.delete(id)) send({ type: 'rfb-close', id }); },
      };
    },
    automation(request, signal) {
      return new Promise((resolve, reject) => {
        if (stopped || signal?.aborted) { reject(runnerUnavailable()); return; }
        const id = randomUUID();
        const abortTask = (error) => {
          finish(error);
          send({ type: 'automation-cancel', id });
        };
        const cancel = () => abortTask(new BrowserError('action_cancelled', 'The browser operation was cancelled.', 409));
        const timer = setTimeout(() => abortTask(new BrowserError('action_timeout', 'The browser operation timed out.', 504)), COMMAND_MS);
        timer.unref?.();
        function finish(error, value) {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          if (error) reject(error); else resolve(value);
        }
        pending.set(id, { finish });
        signal?.addEventListener('abort', cancel, { once: true });
        if (!send({ type: 'automation', id, request })) finish(runnerUnavailable());
      });
    },
  };
}
