import { chmod, lchown, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

function id(text, minimum) {
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)$/.test(text) || Number(text) < minimum || Number(text) > 4294967294) throw new Error('Invalid browser identity');
  return Number(text);
}

export function browserIdentity(env, fallback) {
  const { DSH_BROWSER_UID: uid, DSH_BROWSER_GID: gid, DSH_BROWSER_GROUPS: groups } = env;
  if ([uid, gid, groups].every(value => value === undefined)) return { uid: fallback[0], gid: fallback[1], groups: [] };
  if (typeof groups !== 'string') throw new Error('Incomplete browser identity');
  return { uid: id(uid, 1), gid: id(gid, 1), groups: groups === '' ? [] : [...new Set(groups.split(',').map(value => id(value, 0)))] };
}

export function displayIdentity(browser, [uid, gid]) {
  while (uid === browser.uid) uid++;
  while ([browser.gid, ...browser.groups].includes(gid)) gid++;
  return { uid, gid, groups: [] };
}

export function privilegeArgs({ uid, gid, groups }) {
  return [`--reuid=${uid}`, `--regid=${gid}`, groups.length ? `--groups=${groups.join(',')}` : '--clear-groups', '--'];
}

// Only the reserved, offline profile volume is eligible. Do not follow symlinks,
// cross mounts (including same-device bind mounts), or mutate hard-linked inodes.
export async function migrateProfile(directory, mountPaths, { uid, gid }) {
  if (!mountPaths.includes(directory) || mountPaths.some(path => path.startsWith(`${directory}/`))) throw new Error('Unsafe profile mount');
  const root = await lstat(directory);
  if (!root.isDirectory()) throw new Error('Invalid profile directory');
  async function visit(path) {
    const entry = await lstat(path);
    if (entry.dev !== root.dev || !(entry.isDirectory() || ((entry.isFile() || entry.isSymbolicLink()) && entry.nlink === 1))) throw new Error('Unsafe profile entry');
    if (entry.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
    if (entry.uid !== uid || entry.gid !== gid) await lchown(path, uid, gid);
  }
  await visit(directory);
  await chmod(directory, 0o700);
}
