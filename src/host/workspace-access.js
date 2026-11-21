import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { BrowserError } from '../shared/protocol.js';

const messages = {
  unavailable: 'The Host cannot safely grant access to this directory.',
  stale: 'Start the browser again and request a fresh workspace access confirmation.',
  busy: 'Another workspace access check is running. Retry shortly.',
  failed: 'The Host could not complete or verify the workspace ACL operation.',
};
function fail(reason) {
  throw new BrowserError(`workspace_access_${reason}`, messages[reason], reason === 'busy' ? 429 : reason === 'stale' ? 409 : 403);
}
const within = (path, parent) => path === parent || path.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
const canonical = path => typeof path === 'string' && path.startsWith('/') && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path) && posix.resolve(path) === path;
function normalizedProtected(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.split('/').includes('..') || /[\x00-\x1f\x7f]/.test(path)) fail('unavailable');
  return posix.resolve(path);
}
export function checkWorkspacePath(path, protectedPaths, homes) {
  if (!canonical(path) || path === '/' || path.split('/').some(p => p.startsWith('.')) ||
      /^\/(?:bin|boot|dev|etc|lib(?:32|64|x32)?|lost\+found|opt|proc|run|sbin|sys|usr|var)(?:\/|$)/.test(path) ||
      (within(path, '/root') && !within(path, '/root/workspace')) ||
      /^\/(?:home(?:\/[^/]+)?|tmp|mnt|srv|media)$/.test(path) || homes.some(home => home !== '/' && within(home, path)) ||
      protectedPaths.map(normalizedProtected).some(p => within(path, p) || within(p, path))) fail('unavailable');
}
// Only traverse the Host root mount. Also exclude the source of any visible
// bind alias on that filesystem, including a subtree mounted over a protected path.
export function checkMounts(path, mountinfo, id) {
  const rows = mountinfo.trim().split('\n').map(l => l.split(' '));
  const root = rows.find(r => r[0] === id);
  if (!root || root[3] !== '/' || root[4] !== '/') fail('unavailable');
  for (const row of rows) {
    if (row[0] === id || row[2] !== root[2]) continue;
    const source = row[3].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (!canonical(source) || within(path, source) || within(source, path)) fail('unavailable');
  }
}
async function mountId(handle) {
  const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
  const id = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1];
  if (!id) fail('unavailable');
  return id;
}
async function pin(path) {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let handle = await open('/', flags);
  try {
    const rootMount = await mountId(handle);
    checkMounts(path, await readFile('/proc/self/mountinfo', 'utf8'), rootMount);
    for (const component of path.slice(1).split('/')) {
      const parent = await handle.stat();
      if (parent.uid !== 0 || ((parent.mode & 0o022) && !(parent.mode & 0o1000))) fail('unavailable');
      const next = await open(`/proc/self/fd/${handle.fd}/${component}`, flags);
      const previous = handle;
      handle = next;
      await previous.close();
      if ((await handle.stat()).uid !== 0 || await mountId(handle) !== rootMount) fail('unavailable');
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
function aclCommand(tool, args, fd) {
  return new Promise((resolve, reject) => {
    const child = spawn(`/usr/bin/${tool}`, [...args, '--', '/proc/self/fd/3'], {
      stdio: ['ignore', 'pipe', 'ignore', fd], env: { LC_ALL: 'C' }, timeout: 3000, killSignal: 'SIGKILL',
    });
    let text = '', overflow = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (!overflow) text += chunk;
      if (text.length > 65536) { overflow = true; child.kill('SIGKILL'); }
    });
    child.once('error', reject);
    child.once('close', code => code === 0 && !overflow ? resolve(text) : reject(new Error('ACL utility failed')));
  });
}
const readAcl = fd => aclCommand('getfacl', ['-cEn'], fd);
function parseAcl(text) {
  const entries = new Map();
  for (const line of text.trim().split('\n')) {
    const m = /^((?:default:)?(?:user|group|other|mask):[0-9]*):([r-][w-][x-])$/.exec(line);
    if (!m || entries.has(m[1])) fail('unavailable');
    entries.set(m[1], m[2]);
  }
  if (!['user:', 'group:', 'other:'].every(k => entries.has(k))) fail('unavailable');
  return entries;
}
const sorted = map => JSON.stringify([...map].sort(([a], [b]) => a.localeCompare(b)));
export function workspaceAclPlan(text, uid) {
  const entries = parseAcl(text), mask = entries.get('mask:') || 'rwx';
  const target = `user:${uid}`;
  for (const [key, perms] of entries) {
    if (key !== target && /^(?:group:\d*|user:\d+)$/.test(key) &&
        [...perms].some((p, i) => p !== '-' && mask[i] === '-')) fail('unavailable');
  }
  entries.set(target, 'rwx'); entries.set('mask:', 'rwx');
  return sorted(entries);
}
const validNumber = n => Number.isInteger(n) && n > 0 && n < 0xffffffff;
const identity = stat => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.ctimeNs].join(':');

export function createWorkspaceAccess({ resolveWorkspace, resolveAccount, protectedPaths = [] }) {
  const failures = new Map();
  let busy = false, disposed = false;
  const now = () => performance.now();
  function key(session, peer) {
    if (![session, peer].every(s => typeof s === 'string' && s.length && s.length <= 1024)) fail('stale');
    return JSON.stringify([session, peer]);
  }
  function noteFailure(session, peer, workspace) {
    if (disposed || process.platform !== 'linux' || process.geteuid() !== 0 || !workspace?.id || !canonical(workspace.path)) return;
    const k = key(session, peer);
    failures.delete(k);
    if (failures.size >= 128) failures.delete(failures.keys().next().value);
    failures.set(k, { id: workspace.id, path: workspace.path, expires: now() + 120000 });
  }
  async function operate(session, peer, token, grant) {
    if (disposed || process.platform !== 'linux' || process.geteuid() !== 0) fail('unavailable');
    if (busy) fail('busy');
    const k = key(session, peer), failure = failures.get(k), preview = failure?.preview;
    function fresh() {
      if (disposed || !failure || failures.get(k) !== failure || failure.expires <= now() ||
          (grant && (!preview || preview.expires <= now()))) fail('stale');
    }
    fresh();
    if (grant && (typeof token !== 'string' || token !== preview.token)) fail('stale');
    delete failure.preview;
    busy = true;
    let handle;
    try {
      const workspace = await resolveWorkspace(session);
      if (workspace?.id !== failure.id || workspace.path !== failure.path) fail('stale');
      const account = await resolveAccount();
      if (!account || !validNumber(account.uid) || !validNumber(account.gid) || typeof account.name !== 'string' || !account.name) fail('unavailable');
      const homes = (await readFile('/etc/passwd', 'utf8')).split('\n').map(l => l.split(':')[5]).filter(canonical);
      const protectedReal = await Promise.all(protectedPaths.map(p => realpath(normalizedProtected(p))));
      checkWorkspacePath(failure.path, [...protectedPaths, ...protectedReal], homes);
      handle = await pin(failure.path);
      const stat = await handle.stat({ bigint: true });
      if (stat.uid === BigInt(account.uid)) fail('unavailable'); // owner entry takes precedence
      const acl = await readAcl(handle.fd);
      const expected = workspaceAclPlan(acl, account.uid);
      const snapshot = JSON.stringify([identity(stat), acl, account.name, account.uid, account.gid]);
      fresh();
      if (!grant) {
        const ticket = randomBytes(32).toString('hex');
        failure.preview = { token: ticket, snapshot, expires: now() + 30000 };
        return { token: ticket, path: failure.path, account: account.name, uid: account.uid };
      }
      if (preview.snapshot !== snapshot) fail('stale');
      const confirmedAccount = await resolveAccount();
      const confirmedWorkspace = await resolveWorkspace(session);
      if (confirmedWorkspace?.id !== failure.id || confirmedWorkspace.path !== failure.path ||
          confirmedAccount?.name !== account.name || confirmedAccount.uid !== account.uid || confirmedAccount.gid !== account.gid ||
          identity(await handle.stat({ bigint: true })) !== identity(stat)) fail('stale');
      fresh(); failures.delete(k);
      // Replace only the access ACL with the inspected entries plus our grant;
      // never let setfacl recalculate a mask against a second, uninspected ACL.
      const access = JSON.parse(expected).filter(([key]) => !key.startsWith('default:'));
      await aclCommand('setfacl', ['-n', `--set=${access.map(([key, perms]) => `${key}:${perms}`).join(',')}`], handle.fd);
      if (sorted(parseAcl(await readAcl(handle.fd))) !== expected) fail('failed');
      return { ok: true };
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      fail(grant ? 'failed' : 'unavailable');
    } finally { try { await handle?.close(); } finally { busy = false; } }
  }
  return { noteFailure, prepare: (s, p) => operate(s, p, null, false), grant: (s, p, t) => operate(s, p, t, true),
    dispose() { disposed = true; failures.clear(); } };
}
