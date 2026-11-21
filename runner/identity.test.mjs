import assert from 'node:assert/strict';
import { test } from 'node:test';
import { link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserIdentity, displayIdentity, migrateProfile, privilegeArgs, workspaceStartupError } from './identity.mjs';

const mapped = { DSH_BROWSER_UID: '1002', DSH_BROWSER_GID: '121', DSH_BROWSER_GROUPS: '0,1002,1003' };
test('Desktop defaults and complete numeric mappings keep browser and display identities separate', () => {
  assert.deepEqual(browserIdentity({}, [1001, 1001]), { uid: 1001, gid: 1001, groups: [] });
  const browser = browserIdentity(mapped, [1001, 1001]);
  assert.deepEqual(privilegeArgs(browser), ['--reuid=1002', '--regid=121', '--groups=0,1002,1003', '--']);
  const display = displayIdentity(browser, [1002, 1002]);
  assert.deepEqual(privilegeArgs(display), ['--reuid=1003', '--regid=1004', '--clear-groups', '--']);
  for (const invalid of [{ DSH_BROWSER_UID: '1' }, ...['0', '-1', '4294967295', '1e3', '01'].map(uid => ({ ...mapped, DSH_BROWSER_UID: uid })), { ...mapped, DSH_BROWSER_GROUPS: '2,' }])
    assert.throws(() => browserIdentity(invalid, [1001, 1001]));
});

test('workspace startup distinguishes a browser denial from missing mounts and probe failures', async () => {
  const identity = browserIdentity(mapped, [1001, 1001]);
  const mounts = ['/workspace'];
  let calls = 0;
  const probe = stdout => async (command, args) => {
    calls++;
    assert.equal(command, 'setpriv');
    assert.deepEqual(args.slice(0, -1), [...privilegeArgs(identity), 'sh', '-c']);
    return { stdout };
  };
  assert.equal(await workspaceStartupError(['/workspace/sub'], identity, probe('denied\n')), 'runner_workspace_invalid');
  assert.equal(calls, 0);
  assert.equal(await workspaceStartupError(mounts, identity, probe('')), null);
  assert.equal(await workspaceStartupError(mounts, identity, probe('denied\n')), 'runner_workspace_permission_denied');
  assert.equal(await workspaceStartupError(mounts, identity, probe('unexpected')), 'runner_workspace_invalid');
  for (const code of [1, 127, 'ENOENT']) {
    const failed = async () => { throw Object.assign(new Error(), { code }); };
    assert.equal(await workspaceStartupError(mounts, identity, failed), 'runner_workspace_invalid');
  }
});

test('migration rejects nested mounts and hard links, leaves symlink targets alone', { skip: process.platform === 'win32' }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-profile-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, 'profile'), target = join(base, 'external');
  await mkdir(dir);
  const owner = await stat(dir);
  await assert.rejects(migrateProfile(dir, [], owner));
  await assert.rejects(migrateProfile(dir, [dir, join(dir, 'other')], owner));
  await writeFile(target, 'external', { mode: 0o644 });
  const originalMode = (await stat(target)).mode;
  await symlink(target, join(dir, 'SingletonLock'));
  const child = join(dir, 'Default');
  await mkdir(child);
  await writeFile(join(child, 'Preferences'), '{}');
  const browser = process.getuid() === 0 ? { uid: 10001, gid: 10002 } : owner;
  await migrateProfile(dir, [dir], browser);
  const prefs = await stat(join(child, 'Preferences'));
  assert.equal(prefs.uid, browser.uid);
  assert.equal(prefs.gid, browser.gid);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(target)).uid, owner.uid);
  assert.equal((await stat(target)).mode, originalMode);
  await link(target, join(dir, 'hardlink'));
  await assert.rejects(migrateProfile(dir, [dir], owner), /Unsafe profile entry/);
});
