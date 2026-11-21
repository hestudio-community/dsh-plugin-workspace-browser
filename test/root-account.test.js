import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRootAccount, rootAccountName } from '../src/host/root-account.js';

const passwd = 'browser:x:600:601::/nonexistent:/usr/sbin/nologin';
const group = 'browser:x:601:';
function resolve({ name = 'browser', users = passwd, groups = group, nss = {} } = {}) {
  return resolveRootAccount(name, {
    read: async path => ({ '/etc/passwd': users, '/etc/group': groups })[path],
    id: async flag => ({ '-u': '600', '-g': '601', ...nss })[flag],
  });
}

test('a local system account and an ordinary non-root account both resolve', async () => {
  assert.deepEqual(await resolve(), { name: 'browser', uid: 600, gid: 601 });
  // A regular login account is accepted; the runner still drops supplementary groups.
  const login = 'undefined:x:1000:1000:undefined:/home/undefined:/bin/bash';
  assert.deepEqual(await resolve({ name: 'undefined', users: login, groups: 'undefined:x:1000:', nss: { '-u': '1000', '-g': '1000' } }),
    { name: 'undefined', uid: 1000, gid: 1000 });
  for (const options of [{ name: '' }, { users: '' }]) await assert.rejects(resolve(options), { code: 'root_browser_account_missing' });
});

test('the volatile setting is read through its getter, and a plain string still works', () => {
  assert.equal(rootAccountName({ get: () => 'browser' }), 'browser');
  assert.equal(rootAccountName('browser'), 'browser');
  assert.equal(rootAccountName(undefined), '');
  assert.equal(rootAccountName({}), '');
});

test('root, nobody, shared and NSS-mismatched identities fail closed', async () => {
  for (const options of [
    { name: '--bad' }, { name: 'browser\n' }, { users: passwd.replace(':600:', ':0:') },
    { users: passwd.replace(':600:601:', ':65534:601:') }, { users: passwd.replace(/^browser:x:600:601/, 'browser:x:1000:1000').replace('/usr/sbin/nologin', '/bin/bash'), groups: 'browser:x:1000:' },
    { users: passwd + '\nalias:x:600:602::/:/bin/false' }, { users: passwd + '\nother:x:602:601::/:/bin/false' },
    { groups: group + '\nalias:x:601:' },
    { nss: { '-u': '602' } }, { nss: { '-g': '602' } },
  ]) await assert.rejects(resolve(options), { code: 'root_browser_account_invalid' }, JSON.stringify(options));
  // A private numeric primary group may carry any name; uniqueness is what matters.
  assert.deepEqual(await resolve({ groups: 'users:x:601:' }), { name: 'browser', uid: 600, gid: 601 });
});
