import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, chown, copyFile, mkdtemp, readFile, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { stdout } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';
import { AutomationError, createAutomation } from './automation.mjs';
import { recoverProfile } from './profile-recovery.mjs';
import { readFrames, send, sendChunk } from './protocol.mjs';
import { createProxy } from './proxy.mjs';

const exec = promisify(execFile);
const display = ':91';
const width = 1280;
const height = 800;
const browserAuth = '/home/browser/.dsh-xauth';
const workers = new Set();
const sessions = new Map();
const jobs = new Map();
let ready = false;
let stopping = false;
let browser;
let proxy;
let vncPath;
let automate;
let pumping = false;
let startupCode = 'runner_isolation_failed';

function log(message) {
  process.stderr.write(`runner: ${message}\n`);
}

function stop(reason) {
  if (stopping) return;
  stopping = true;
  let flushed;
  if (reason) {
    log(reason);
    if (!ready && reason !== 'host output failed') {
      flushed = new Promise(resolve => send({ type: 'startup-error', code: startupCode }, resolve));
    }
  }
  ready = false;
  for (const { controller } of jobs.values()) controller.abort();
  for (const socket of sessions.values()) socket.destroy();
  proxy?.close();
  void (async () => {
    await Promise.race([browser?.close().catch(() => {}), delay(3000)]);
    for (const child of workers) {
      try { child.kill('SIGTERM'); } catch { /* The container init reaps remaining processes. */ }
    }
    if (flushed) await Promise.race([flushed, delay(500)]);
    process.exit(reason ? 1 : 0);
  })();
}

function worker(label, executable, args, env = process.env) {
  const child = spawn(executable, args, { stdio: 'ignore', env });
  workers.add(child);
  child.once('error', () => stop(`${label} failed to start`));
  child.once('exit', () => {
    workers.delete(child);
    stop(`${label} exited`);
  });
}

async function waitFor(test) {
  for (let i = 0; i < 60 && !stopping; i++) {
    if (await test().catch(() => false)) return;
    await delay(100);
  }
  throw new Error('Startup check failed');
}

function hasRfbBanner() {
  return new Promise(resolve => {
    let banner = '';
    const socket = createConnection(vncPath);
    const finish = value => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('end', () => finish(false));
    socket.on('data', chunk => {
      banner += chunk.toString('ascii');
      if (banner.length >= 12) finish(/^RFB 003\.\d{3}\n$/.test(banner));
    });
  });
}

function openRfb(id) {
  if (sessions.has(id)) return;
  if (sessions.size >= 4) return send({ type: 'rfb-close', id });
  const socket = createConnection(vncPath);
  let resume;
  sessions.set(id, socket);
  socket.on('error', () => {});
  socket.once('close', () => {
    if (resume) stdout.off('drain', resume);
    if (sessions.get(id) === socket) {
      sessions.delete(id);
      if (ready) send({ type: 'rfb-close', id });
    }
  });
  socket.on('data', chunk => {
    if (sendChunk('rfb', id, chunk)) return;
    socket.pause();
    resume = () => {
      resume = undefined;
      socket.resume();
    };
    stdout.once('drain', resume);
  });
}

async function runJobs() {
  if (pumping) return;
  pumping = true;
  try {
    for (const [id, { request, controller }] of jobs) {
      try {
        controller.signal.throwIfAborted();
        const value = await automate(request, controller.signal);
        if (ready && !controller.signal.aborted) send({ type: 'automation-result', id, ok: true, value });
      } catch (error) {
        const message = error instanceof AutomationError ? error.message : 'Browser operation failed or became stale';
        if (ready && !controller.signal.aborted) send({ type: 'automation-result', id, ok: false, error: message });
      } finally {
        jobs.delete(id);
      }
    }
  } finally {
    pumping = false;
  }
}

function dispatch(frame) {
  if (stopping) return;
  if (frame.type.startsWith('net-')) {
    proxy?.handle(frame);
    return;
  }
  if (frame.type === 'automation-cancel') {
    jobs.get(frame.id)?.controller.abort();
    return;
  }
  if (!ready) return;
  const { id } = frame;
  switch (frame.type) {
    case 'rfb-open': openRfb(id); break;
    case 'rfb': {
      const socket = sessions.get(id);
      if (socket && socket.writableLength + frame.data.length <= 256 * 1024) socket.write(frame.data);
      else socket?.destroy();
      break;
    }
    case 'rfb-close': {
      const socket = sessions.get(id);
      sessions.delete(id);
      socket?.destroy();
      break;
    }
    case 'automation':
      if (jobs.has(id)) break;
      if (jobs.size >= 16) send({ type: 'automation-result', id, ok: false, error: 'Browser operation queue is busy' });
      else {
        jobs.set(id, { request: frame.request, controller: new AbortController() });
        void runJobs();
      }
      break;
  }
}

async function setup() {
  let phase = 'container isolation is unavailable';
  try {
    if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error();
    const interfaces = Object.entries(networkInterfaces());
    const devices = (await readFile('/proc/net/dev', 'utf8')).split('\n').slice(2).filter(line => line.trim()).map(line => line.split(':')[0].trim());
    if (devices.length !== 1 || devices[0] !== 'lo' || interfaces.some(([name, entries]) => name !== 'lo' || !entries.every(entry => entry.internal))) throw new Error();
    if (!/^NoNewPrivs:\s*1$/m.test(await readFile('/proc/self/status', 'utf8'))) throw new Error();
    if (!(await readFile('/proc/self/mountinfo', 'utf8')).split('\n').some(line => line.split(' ')[4] === '/profile')) throw new Error();

    startupCode = 'runner_display_failed';
    phase = 'display and profile preparation failed';
    const ids = async account => Promise.all(['-u', '-g'].map(async flag => Number((await exec('id', [flag, account])).stdout.trim())));
    const [browserUid, browserGid] = await ids('browser');
    const [deskUid, deskGid] = await ids('dshdesk');
    await chown('/profile', browserUid, browserGid);
    await chmod('/profile', 0o700);
    const runDirectory = await mkdtemp('/tmp/dsh-plugin-workspace-browser-');
    await chown(runDirectory, deskUid, deskGid);
    await chmod(runDirectory, 0o700);
    const displayAuth = `${runDirectory}/Xauthority`;
    vncPath = `${runDirectory}/rfb.sock`;
    await exec('gosu', ['dshdesk', 'xauth', '-f', displayAuth, 'add', display, '.', randomBytes(16).toString('hex')]);
    await copyFile(displayAuth, browserAuth);
    await chown(browserAuth, browserUid, browserGid);
    await chmod(browserAuth, 0o600);
    const deskEnv = { ...process.env, DISPLAY: display, XAUTHORITY: displayAuth, HOME: '/home/dshdesk' };

    phase = 'X11 display readiness failed';
    // Xtigervnc owns the X11 framebuffer, so a remote resize changes the maximized Chromium window.
    // Keep unauthenticated RFB private to dshdesk and prevent X11 clients from enabling clipboard exchange.
    worker('X11/RFB server', 'gosu', ['dshdesk', '/usr/bin/Xtigervnc', display,
      '-geometry', `${width}x${height}`, '-depth', '24', '-noreset', '-nolisten', 'tcp', '-auth', displayAuth,
      '-desktop', 'Chromium', '-rfbport', '-1', '-rfbunixpath', vncPath, '-rfbunixmode', '0600',
      '-SecurityTypes', 'None', '-AlwaysShared', '-AcceptSetDesktopSize=1', '-noclipboard',
      '-AcceptCutText=0', '-SendCutText=0', '-SendPrimary=0', '-SetPrimary=0', '-AllowOverride='], deskEnv);
    await waitFor(async () => Boolean(await exec('xdpyinfo', [], { env: deskEnv, timeout: 800 })));
    worker('window manager', 'gosu', ['dshdesk', 'openbox', '--config-file', '/app/openbox.xml'], deskEnv);
    await waitFor(async () => {
      const { stdout: output } = await exec('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { env: deskEnv, timeout: 800 });
      return /window id # 0x[0-9a-f]+/i.test(output);
    });
    phase = 'private RFB readiness failed';
    await waitFor(async () => {
      const socket = await stat(vncPath);
      return socket.isSocket() && socket.uid === deskUid && (socket.mode & 0o777) === 0o600 && await hasRfbBanner();
    });

    startupCode = 'runner_start_failed';
    phase = 'browser proxy could not listen';
    proxy = await createProxy();
    if (stopping) return;
    startupCode = 'runner_profile_recovery_failed';
    phase = 'Chromium profile recovery failed';
    await recoverProfile('/profile');
    if (stopping) return;

    startupCode = 'runner_start_failed';
    phase = 'Chromium could not launch';
    browser = await puppeteer.launch({
      executablePath: '/app/chromium.sh', userDataDir: '/profile', headless: false,
      pipe: true, defaultViewport: null, timeout: 15_000, protocolTimeout: 10_000,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      ignoreDefaultArgs: ['--disable-popup-blocking'],
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', DISPLAY: display, XAUTHORITY: browserAuth },
      args: [
        '--disable-setuid-sandbox', '--disable-quic', '--lang=en-US', '--start-maximized', `--window-size=${width},${height}`,
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        `--proxy-server=${proxy.address}`, '--proxy-bypass-list=<-loopback>',
      ],
    });
    browser.once('disconnected', () => stop('Chromium disconnected'));

    startupCode = 'runner_isolation_failed';
    phase = 'Chromium did not report its required namespace and seccomp sandbox layers';
    const sandbox = await browser.newPage();
    await sandbox.goto('chrome://sandbox/', { timeout: 8000 });
    const enabled = await sandbox.evaluate(() => {
      const rows = new Map([...document.querySelectorAll('#sandbox-status tr')].map(row => [...row.cells].map(cell => cell.textContent.trim())));
      return rows.get('Layer 1 Sandbox') === 'Namespace' && rows.get('PID namespaces') === 'Yes' &&
        rows.get('Network namespaces') === 'Yes' && rows.get('Seccomp-BPF sandbox') === 'Yes';
    });
    await sandbox.close();
    if (!enabled || !(await browser.pages()).length || stopping) throw new Error();

    phase = 'runner privilege drop failed';
    process.setgroups([]);
    process.setgid(deskGid);
    process.setuid(deskUid);
    if (process.getuid() !== deskUid || deskUid === browserUid || deskUid === 0) throw new Error();
    automate = createAutomation(browser);
    ready = true;
    send({ type: 'ready' });
  } catch {
    stop(phase);
  }
}

// Never print raw errors: they may contain Chromium URLs, HTTP data or frame payloads.
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
process.once('SIGHUP', () => stop());
process.once('uncaughtException', () => stop('unexpected runner failure'));
process.once('unhandledRejection', () => stop('unexpected asynchronous runner failure'));
stdout.setMaxListeners(80); // At most one drain callback per tunnel/RFB socket.
readFrames(dispatch, stop);
void setup();
