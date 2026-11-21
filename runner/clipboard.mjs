import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const MAX = 16384;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const valid = s => typeof s === 'string' && s.length <= MAX && !/[\uD800-\uDFFF]/u.test(s) && Buffer.byteLength(s) <= MAX;

// Selection owners are untrusted X11 clients. Bound xclip's allocation and our collector.
export function createClipboard(env, send) {
  let active, owner;
  function helper(args) {
    return spawn('/usr/bin/prlimit', ['--as=134217728', '--', '/usr/bin/xclip', '-selection', 'clipboard', '-target', 'UTF8_STRING', ...args], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  }
  function read(signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = helper(['-out']);
      const chunks = []; let bytes = 0, failed = false;
      const kill = () => child.kill('SIGKILL');
      signal.addEventListener('abort', kill, { once: true });
      child.stdin.on('error', () => {}); child.stdin.end();
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX) { failed = true; kill(); } else chunks.push(chunk);
      });
      child.on('error', () => { failed = true; });
      child.once('close', code => {
        signal.removeEventListener('abort', kill);
        if (failed || signal.aborted) { reject(new Error('Clipboard unavailable')); return; }
        try { resolve(code === 0 ? decoder.decode(Buffer.concat(chunks)) : null); } catch (error) { reject(error); }
      });
    });
  }
  function drop(entry) {
    if (!entry) return;
    entry.child.kill('SIGKILL');
    if (owner === entry) owner = undefined;
  }
  async function write(grantId, text, signal) {
    drop(owner);
    const child = helper(['-in', '-quiet']); // foreground selection owner, no daemon fork
    const entry = owner = { grantId, child };
    child.stdout.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { if (owner === entry) owner = undefined; });
    child.once('close', () => { if (owner === entry) owner = undefined; });
    child.stdin.end(Buffer.from(text));
    try {
      // Verify actual data before acknowledging a write; the client can then send its paste gesture.
      for (let n = 0; n < 20 && owner === entry; n++) {
        if (await read(signal) === text && owner === entry) return;
        await delay(20, undefined, { signal });
      }
      throw new Error('Clipboard unavailable');
    } catch (error) { drop(entry); throw error; }
  }
  return {
    async run(id, request) {
      const { grantId, action, text } = request ?? {};
      const fail = () => send({ type: 'clipboard-result', id, ok: false });
      if (active || typeof grantId !== 'string' || !/^[\w-]{1,128}$/.test(grantId) || !['read', 'write'].includes(action) || (action === 'write' && !valid(text))) { fail(); return; }
      const controller = new AbortController();
      active = { id, grantId, controller };
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]);
      try {
        const value = action === 'read' ? await read(signal) : await write(grantId, text, signal);
        signal.throwIfAborted();
        send({ type: 'clipboard-result', id, ok: true, value });
      } catch { if (!controller.signal.aborted) fail(); }
      finally { active = undefined; }
    },
    cancel(id) { if (active?.id === id) active.controller.abort(); },
    release(grantId) {
      if (active?.grantId === grantId) active.controller.abort();
      if (owner?.grantId === grantId) drop(owner);
    },
    close() { active?.controller.abort(); drop(owner); },
  };
}
