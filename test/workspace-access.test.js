import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
import { checkMounts, checkWorkspacePath, createWorkspaceAccess, workspaceAclPlan } from '../src/host/workspace-access.js';

const base = 'user::rwx\ngroup::r--\nother::---\n';
test('workspace ACL rejects latent group and named-user permissions when opening the mask', () => {
  for (const entry of ['group::rwx', 'group:87:rwx', 'user:87:rwx']) {
    const acl = entry.startsWith('group::') ? base.replace('group::r--', entry) : base + entry + '\n';
    assert.throws(() => workspaceAclPlan(acl + 'mask::r--', 42), { code: 'workspace_access_unavailable' });
  }
  const defaults = 'default:user::rwx\ndefault:group::rwx\ndefault:other::---\n';
  const expected = new Map(JSON.parse(workspaceAclPlan(base + defaults, 42)));
  assert.equal(expected.get('default:group:'), 'rwx');
  assert.equal(expected.get('user:42'), 'rwx');
  assert.equal(expected.get('group:'), 'r--');
});
test('protect system, home, config, protected trees and ancestors', () => {
  const check = path => checkWorkspacePath(path, ['/disk/data/profile/'], ['/root', '/users/me']);
  for (const path of ['/', '/root', '/etc/ssh', '/home/me', '/users/me', '/users', '/home/me/.ssh/keys', '/disk', '/disk/data/profile/sub', '/disk/../other']) {
    assert.throws(() => check(path), { code: 'workspace_access_unavailable' });
  }
  check('/disk/data/profile-project'); check('/home/me/project'); check('/root/workspace'); check('/root/workspace/project');
  for (const path of ['/root/.ssh', '/root/workspace/.config', '/root/credentials', '/root/workspace/project\u202Ehidden']) assert.throws(() => check(path));
});
test('refuse visible bind alias sources on the Host filesystem', () => {
  const mounts = '21 1 8:1 / / rw - ext4 /dev/sda1 rw\n22 21 8:1 /projects/a /etc/myconf rw - ext4 /dev/sda1 rw';
  for (const path of ['/projects', '/projects/a', '/projects/a/sub']) {
    assert.throws(() => checkMounts(path, mounts, '21'), { code: 'workspace_access_unavailable' });
  }
  checkMounts('/projects/ab', mounts, '21');
});
test('real root Linux ACL grant requires matching failure, peer, directory and single-use token', async t => {
  if (process.platform !== 'linux' || process.geteuid() !== 0) return t.skip('requires root Linux');
  try { await Promise.all(['/usr/bin/getfacl', '/usr/bin/setfacl'].map(p => access(p))); } catch { return t.skip('requires Linux ACL tools'); }
  const root = await mkdtemp('/dsh-workspace-access-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = { id: 'workspace', path: `${root}/project` };
  await mkdir(workspace.path);
  let retargetOnResolve = 0;
  const gate = createWorkspaceAccess({ resolveWorkspace: () => --retargetOnResolve === 0 ? { ...workspace, id: 'different' } : workspace,
    resolveAccount: () => ({ name: 'runner', uid: 40003, gid: 40003 }) });
  t.after(() => gate.dispose());
  const prepare = () => gate.prepare('session', 'peer');
  const grant = token => gate.grant('session', 'peer', token);
  await assert.rejects(prepare, { code: 'workspace_access_stale' });
  gate.noteFailure('session', 'peer', workspace);
  await chmod(root, 0o777);
  await assert.rejects(prepare, { code: 'workspace_access_unavailable' });
  await chmod(root, 0o700);
  const redirected = await prepare();
  retargetOnResolve = 2;
  await assert.rejects(grant(redirected.token), { code: 'workspace_access_stale' });
  const first = await prepare();
  await assert.rejects(gate.grant('session', 'other', first.token), { code: 'workspace_access_stale' });
  await rename(workspace.path, `${root}/original`);
  await symlink(`${root}/original`, workspace.path);
  await assert.rejects(grant(first.token));
  await rm(workspace.path);
  await mkdir(workspace.path);
  const next = await prepare();
  await rename(workspace.path, `${root}/replacement`);
  await rename(`${root}/original`, workspace.path);
  await assert.rejects(grant(next.token), { code: 'workspace_access_stale' });
  const child = `${workspace.path}/child`;
  await mkdir(child);
  await exec('/usr/bin/setfacl', ['-m', 'd:u:40005:r-x', workspace.path]);
  const acl = async path => (await exec('/usr/bin/getfacl', ['-cEn', path])).stdout;
  const childAcl = await acl(child);
  const defaults = text => text.split('\n').filter(line => line.startsWith('default:'));
  const beforeDefaults = defaults(await acl(workspace.path));
  const final = await prepare();
  assert.deepEqual(await grant(final.token), { ok: true });
  assert.deepEqual(defaults(await acl(workspace.path)), beforeDefaults);
  assert.equal(await acl(child), childAcl);
  await assert.rejects(grant(final.token), { code: 'workspace_access_stale' });
});
