import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recoverProfile } from '../runner/profile-recovery.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-test-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const profile = join(root, 'profile');
  await mkdir(profile);
  return { root, profile };
}

async function link(t, target, path, type = 'file') {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip('Windows does not allow creating symbolic links in this environment');
    return false;
  }
}

const recoverable = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

async function assertMissing(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}

test('an empty profile is benign', async t => {
  const { profile } = await fixture(t);
  await recoverProfile(profile);
});

test('recovers a partial singleton set', async t => {
  const { root, profile } = await fixture(t);
  for (const name of recoverable) {
    const path = join(profile, name);
    if (!await link(t, join(root, 'missing'), path)) return;
    await recoverProfile(profile);
    await assertMissing(path);
  }
});

test('removes only singleton links at the profile root, never their targets', async t => {
  const { root, profile } = await fixture(t);
  const file = join(root, 'file-target');
  const directory = join(root, 'directory-target');
  await writeFile(file, 'outside');
  await mkdir(directory);
  await writeFile(join(directory, 'data'), 'outside directory');
  const nested = join(profile, 'Default');
  await mkdir(nested);
  await writeFile(join(nested, 'SingletonLock'), 'nested data');

  if (!await link(t, file, join(profile, 'SingletonLock'))) return;
  if (!await link(t, directory, join(profile, 'SingletonSocket'), 'dir')) return;
  if (!await link(t, join(root, 'missing'), join(profile, 'SingletonCookie'))) return;
  const unrelated = join(profile, 'OtherLink');
  if (!await link(t, file, unrelated)) return;

  await recoverProfile(profile);
  for (const name of recoverable) await assertMissing(join(profile, name));
  assert.equal(await readFile(file, 'utf8'), 'outside');
  assert.equal(await readFile(join(directory, 'data'), 'utf8'), 'outside directory');
  assert.equal(await readFile(join(nested, 'SingletonLock'), 'utf8'), 'nested data');
  assert.ok((await lstat(unrelated)).isSymbolicLink());
});

test('rejects anomalous singleton files and directories without modifying them', async t => {
  const { profile } = await fixture(t);
  const anomalous = join(profile, 'SingletonCookie');
  await writeFile(anomalous, 'do not delete');
  await assert.rejects(recoverProfile(profile), /Unexpected Chromium singleton entry/);
  assert.equal(await readFile(anomalous, 'utf8'), 'do not delete');

  await rm(anomalous);
  await mkdir(anomalous);
  await writeFile(join(anomalous, 'data'), 'do not recurse');
  await assert.rejects(recoverProfile(profile), /Unexpected Chromium singleton entry/);
  assert.equal(await readFile(join(anomalous, 'data'), 'utf8'), 'do not recurse');
});

test('validates the singleton set before unlinking any of it', async t => {
  const { root, profile } = await fixture(t);
  const lock = join(profile, 'SingletonLock');
  if (!await link(t, join(root, 'missing'), lock)) return;
  await mkdir(join(profile, 'SingletonCookie'));

  await assert.rejects(recoverProfile(profile), /Unexpected Chromium singleton entry/);
  assert.ok((await lstat(lock)).isSymbolicLink());
});

const fsError = code => Object.assign(new Error('Filesystem error'), { code });
const linkEntry = { isSymbolicLink: () => true };

test('checks only top-level singleton entries and unlinks only the links present', async () => {
  const paths = recoverable.map(name => join('profile', name));
  const calls = [];
  await recoverProfile('profile', {
    async lstat(path) {
      calls.push(['lstat', path]);
      if (path === paths[1]) throw fsError('ENOENT');
      return linkEntry;
    },
    async unlink(path) { calls.push(['unlink', path]); },
  });
  assert.deepEqual(calls, [...paths.map(path => ['lstat', path]), ['unlink', paths[0]], ['unlink', paths[2]]]);
});

test('does not unlink after a lookup error other than ENOENT', async () => {
  const paths = recoverable.map(name => join('profile', name));
  const attempted = [];
  await assert.rejects(recoverProfile('profile', {
    async lstat(path) {
      attempted.push(path);
      if (path === paths[2]) throw fsError('EACCES');
      return linkEntry;
    },
    async unlink() { assert.fail('unlink called before completing validation'); },
  }), { code: 'EACCES' });
  assert.deepEqual(attempted, paths);
});

test('ignores a missing link at unlink but stops on any other unlink error', async () => {
  const paths = recoverable.map(name => join('profile', name));
  const attempted = [];
  await assert.rejects(recoverProfile('profile', {
    async lstat() { return linkEntry; },
    async unlink(path) {
      attempted.push(path);
      throw fsError(path === paths[0] ? 'ENOENT' : 'EACCES');
    },
  }), { code: 'EACCES' });
  assert.deepEqual(attempted, paths.slice(0, 2));
});
