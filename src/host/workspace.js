import { realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { environmentError } from './image.js';

export async function workspaceMount(path, { platform = process.platform, canonicalize = realpath, inspect = stat } = {}) {
  // Registry paths are already canonical. Never follow a replacement symlink
  // to a directory other than the one DSH originally registered.
  try {
    if (typeof path !== 'string' || /[\0\r\n]/.test(path) ||
        !(platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) : posix.isAbsolute(path)) ||
        await canonicalize(path) !== path || !(await inspect(path)).isDirectory()) throw new Error();
  } catch { throw environmentError('runner_workspace_invalid'); }
  // Docker parses --mount as a CSV record, not as shell syntax. Quote the
  // entire source field, not just its value. Omit readonly to allow writes.
  return `type=bind,"source=${path.replaceAll('"', '""')}",target=/workspace,bind-recursive=disabled`;
}

export function browserIdentity(host = process, account) {
  if (host.platform === 'win32' || host.platform === 'darwin') return [];
  if (host.platform !== 'linux') throw environmentError('docker_identity_unsupported');
  const root = host.geteuid() === 0;
  const uid = root ? account?.uid : host.geteuid();
  const gid = root ? account?.gid : host.getegid();
  const groups = root ? [] : [...new Set(host.getgroups())].filter(id => id !== gid);
  if (!uid) throw environmentError('docker_identity_unsupported');
  if (![uid, gid, ...groups].every(id => Number.isInteger(id) && id >= 0 && id < 0xffffffff) || !gid) {
    throw environmentError('docker_identity_unsupported');
  }
  return ['--env', `DSH_BROWSER_UID=${uid}`, '--env', `DSH_BROWSER_GID=${gid}`, '--env', `DSH_BROWSER_GROUPS=${groups.join(',')}`];
}
