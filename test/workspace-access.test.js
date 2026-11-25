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
test('workspace mount checks allow full filesystems and reject overlapping same-device aliases', async t => {
  const root = '21 1 8:1 / / rw - ext4 /dev/root rw';
  const disk = '22 21 8:2 / /disk rw - ext4 /dev/data rw';
  const alias = (device, source) => `24 21 ${device} ${source} /alias rw - ext4 /dev/data rw`;
  const cases = [
    { name: 'independent device', path: '/disk/projects', rows: [disk], id: '22' },
    { name: 'nested independent mount', path: '/disk/nested/projects', rows: [disk, '23 22 8:3 / /disk/nested rw - ext4 /dev/nested rw'], id: '23' },
    { name: 'escaped mountpoint', path: '/disk name/projects', rows: [disk.replace('/disk ', '/disk\\040name ')], id: '22' },
    { name: 'same source name on another device', path: '/disk/projects', rows: [disk, alias('8:3', '/projects')], id: '22' },
    { name: 'disjoint same-device alias', path: '/disk/projects', rows: [disk, alias('8:2', '/projects-other')], id: '22' },
    { name: 'alias uses filesystem coordinates', path: '/disk/projects', rows: [disk, alias('8:2', '/disk/projects')], id: '22' },
    { name: 'alias of target', path: '/disk/projects', rows: [disk, alias('8:2', '/projects')], id: '22', reject: true },
    { name: 'alias of ancestor', path: '/disk/projects/child', rows: [disk, alias('8:2', '/projects')], id: '22', reject: true },
    { name: 'alias of descendant', path: '/disk/projects', rows: [disk, alias('8:2', '/projects/child')], id: '22', reject: true },
    { name: 'escaped alias source', path: '/disk/project name', rows: [disk, alias('8:2', '/project\\040name')], id: '22', reject: true },
    { name: 'subtree bind mount', path: '/disk/projects', rows: [disk.replace('8:2 / ', '8:2 /projects ')], id: '22', reject: true },
    { name: 'subvolume root', path: '/disk/projects', rows: [disk.replace('8:2 / ', '8:2 /@data ')], id: '22', reject: true },
    { name: 'mountpoint does not contain path', path: '/disk-other/projects', rows: [disk], id: '22', reject: true },
    { name: 'missing target mount metadata', path: '/disk/projects', rows: [disk], id: '99', reject: true },
  ];
  for (const entry of cases) await t.test(entry.name, () => {
    const check = () => checkMounts(entry.path, [root, ...entry.rows].join('\n'), entry.id);
    if (entry.reject) assert.throws(check, { code: 'workspace_access_unavailable' });
    else assert.doesNotThrow(check);
  });
});

function fakeWorkspaceAccess(t, { onAccount = () => {}, onWorkspace = () => {}, nested = false, extraMounts = [] } = {}) {
  const workspace = { id: 'workspace', path: '/disk/projects/workspace' };
  const state = { mountId: nested ? '23' : '22', inode: 100, writes: [], accountChecks: 0, workspaceChecks: 0 };
  const handles = new Map();
  let nextFd = 10, acl = base;
  const gate = createWorkspaceAccess({
    resolveWorkspace() { onWorkspace(++state.workspaceChecks, state); return workspace; },
    resolveAccount() { onAccount(++state.accountChecks, state); return { name: 'runner', uid: 40003, gid: 40003 }; },
  }, {
    host: { platform: 'linux', geteuid: () => 0 },
    resolvePath: async path => path,
    async openDirectory(path) {
      const match = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(path);
      const resolved = path === '/' ? '/' : `${handles.get(Number(match?.[1])).path.replace(/\/$/, '')}/${match[2]}`;
      const target = resolved === workspace.path;
      const record = { path: resolved, mountId: resolved === '/' ? '21' : nested && resolved === '/disk' ? '22' : state.mountId,
        dev: resolved === '/' ? 1 : nested && resolved !== '/disk' ? 3 : 2, ino: target ? state.inode : resolved.length };
      const fd = nextFd++;
      handles.set(fd, record);
      return {
        fd,
        async stat({ bigint = false } = {}) {
          const values = { dev: record.dev, ino: record.ino, uid: 0, gid: 0, mode: target ? 0o40700 : 0o40755, ctimeNs: 1 };
          return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, bigint ? BigInt(value) : value]));
        },
        async close() { handles.delete(fd); },
      };
    },
    async read(path) {
      if (path === '/etc/passwd') return 'root:x:0:0:root:/root:/bin/sh\nrunner:x:40003:40003::/nonexistent:/usr/sbin/nologin\n';
      if (path === '/proc/self/mountinfo') {
        const root = ['21 1 8:1 / / rw - ext4 /dev/root rw', ...extraMounts, ''].join('\n');
        if (state.missingMount) return root;
        return root + (nested ? `22 21 8:2 / /disk rw - ext4 /dev/data rw\n${state.mountId} 22 8:3 / /disk/projects rw - ext4 /dev/nested rw\n` :
          `${state.mountId} 21 8:2 / /disk rw - ext4 /dev/data rw\n`);
      }
      const match = /^\/proc\/self\/fdinfo\/(\d+)$/.exec(path);
      assert.ok(match, `unexpected read: ${path}`);
      return `mnt_id:\t${handles.get(Number(match[1])).mountId}\n`;
    },
    async command(tool, args, fd) {
      assert.equal(handles.get(fd)?.path, workspace.path);
      if (tool === 'getfacl') return acl;
      assert.equal(tool, 'setfacl');
      state.writes.push({ args, fd });
      acl = `${args.find(arg => arg.startsWith('--set=')).slice('--set='.length).split(',').join('\n')}\n`;
      return '';
    },
  });
  t.after(() => { gate.dispose(); assert.equal(handles.size, 0, 'all directory handles must close'); });
  gate.noteFailure('session', 'peer', workspace);
  return { gate, state };
}

test('fake Linux IO grants access across filesystem boundaries', async t => {
  const cases = [
    { name: 'independent filesystem' },
    { name: 'nested independent filesystem', nested: true },
    { name: 'alias on parent filesystem does not alias the workspace',
      extraMounts: ['24 21 8:1 /disk/projects /alias rw - ext4 /dev/root rw'] },
    { name: 'aliases on both ancestor filesystems do not alias the nested workspace', nested: true,
      extraMounts: ['24 21 8:1 /disk/projects /alias rw - ext4 /dev/root rw',
        '25 21 8:2 /projects/workspace /alias-nested rw - ext4 /dev/data rw'] },
  ];
  for (const entry of cases) await t.test(entry.name, async t => {
    const { gate, state } = fakeWorkspaceAccess(t, entry);
    const preview = await gate.prepare('session', 'peer');
    assert.equal(preview.path, '/disk/projects/workspace');
    assert.deepEqual(state.writes, [], 'preview does not write an ACL');
    assert.deepEqual(await gate.grant('session', 'peer', preview.token), { ok: true });
    assert.equal(state.writes.length, 1);
    assert.ok(state.writes[0].args.includes('-n'));
    assert.match(state.writes[0].args.join(' '), /user:40003:rwx/);
    await assert.rejects(gate.grant('session', 'peer', preview.token), { code: 'workspace_access_stale' });
    assert.equal(state.writes.length, 1, 'reused tokens must not write');
  });
});

test('fake Linux IO fails closed on missing metadata and target-filesystem aliases', async t => {
  const cases = [
    { name: 'missing mount metadata', missingMount: true },
    { name: 'overlapping target alias', extraMounts: ['24 21 8:2 /projects /alias rw - ext4 /dev/data rw'] },
  ];
  for (const entry of cases) await t.test(entry.name, async t => {
    const { gate, state } = fakeWorkspaceAccess(t, entry);
    state.missingMount = entry.missingMount;
    await assert.rejects(gate.prepare('session', 'peer'), { code: 'workspace_access_unavailable' });
    assert.deepEqual(state.writes, []);
  });
});

test('fake Linux IO rejects mount and directory changes without writing ACLs', async t => {
  const cases = [
    { name: 'target mount changes after preview', afterPreview: state => { state.mountId = '23'; } },
    { name: 'target mount changes in final account recheck', onAccount: (count, state) => { if (count === 3) state.mountId = '23'; } },
    { name: 'target mount changes in final workspace recheck', onWorkspace: (count, state) => { if (count === 3) state.mountId = '23'; } },
    { name: 'directory is replaced in final workspace recheck', onWorkspace: (count, state) => { if (count === 3) state.inode++; } },
    { name: 'mount metadata disappears in final account recheck', onAccount: (count, state) => { if (count === 3) state.missingMount = true; } },
  ];
  for (const entry of cases) await t.test(entry.name, async t => {
    const { gate, state } = fakeWorkspaceAccess(t, entry);
    const preview = await gate.prepare('session', 'peer');
    entry.afterPreview?.(state);
    await assert.rejects(gate.grant('session', 'peer', preview.token), { code: 'workspace_access_stale' });
    assert.deepEqual(state.writes, []);
  });
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
