import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { BrowserError } from '../shared/protocol.js';

const run = promisify(execFile);
const identityId = async (flag, name) => (await run('/usr/bin/id', [flag, '--', name], {
  cwd: '/', env: { LC_ALL: 'C' }, timeout: 3000, maxBuffer: 4096,
})).stdout.trim();
const missing = () => new BrowserError('root_browser_account_missing', 'Configure an existing local browser account.', 503);
const invalid = () => new BrowserError('root_browser_account_invalid', 'The configured browser account is not a usable local non-root account with a unique UID and a private primary group.', 503);

// The setting is volatile so saving it applies to the next launch without
// restarting the Host plugin; accept a plain string for tests and older callers.
export function rootAccountName(setting) {
  if (typeof setting === 'string') return setting;
  return typeof setting?.get === 'function' ? setting.get() : '';
}

// Confirm local ownership and uniqueness before consulting NSS for the actual
// identity. A dedicated system account is preferred, but an ordinary non-root
// account is accepted because the runner always drops groups and never escalates.
// No shell, user database or workspace writes.
export async function resolveRootAccount(name, { read = readFile, id = identityId } = {}) {
  if (name === undefined || name === '') throw missing();
  if (typeof name !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(name) || /\s/.test(name)) throw invalid();
  try {
    const [passwd, group] = await Promise.all(['/etc/passwd', '/etc/group'].map(path => read(path, 'utf8')));
    const rows = text => text.split('\n').filter(Boolean).map(line => line.split(':'));
    const users = rows(passwd), groups = rows(group);
    const candidates = users.filter(row => row[0] === name);
    if (!candidates.length) throw missing();
    const [[, , rawUid, rawGid]] = candidates;
    const uid = Number(rawUid), gid = Number(rawGid);
    if (candidates.length !== 1 || !/^[1-9]\d*$/.test(rawUid) || !/^[1-9]\d*$/.test(rawGid) ||
        uid === 65534 || gid === 65534 || users.some(row => row !== candidates[0] && Number(row[2]) === uid) ||
        users.some(row => row !== candidates[0] && Number(row[3]) === gid)) throw invalid();
    const primary = groups.filter(row => row[0] === name || Number(row[2]) === gid);
    if (primary.length !== 1 || Number(primary[0][2]) !== gid) throw invalid();
    const [actualUid, actualGid] = await Promise.all(['-u', '-g'].map(flag => id(flag, name)));
    if (actualUid !== rawUid || actualGid !== rawGid) throw invalid();
    return { name, uid, gid };
  } catch (error) {
    if (error instanceof BrowserError) throw error;
    throw invalid();
  }
}
