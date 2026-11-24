import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Chromium namespace exceptions remain argument-restricted on amd64 and arm64', async () => {
  const policy = JSON.parse(await readFile(new URL('../src/host/chromium-seccomp.json', import.meta.url), 'utf8'));
  assert.equal(policy.defaultAction, 'SCMP_ACT_ERRNO');
  for (const arch of ['amd64', 'arm64']) {
    const rules = policy.syscalls.filter(rule => rule.action === 'SCMP_ACT_ALLOW' && rule.includes?.arches?.includes(arch));
    for (const valueTwo of [1879048192, 536870912, 268435456]) {
      assert.ok(rules.some(rule => rule.names.includes('clone') && JSON.stringify(rule.args) ===
        JSON.stringify([{ index: 0, value: 2114060288, op: 'SCMP_CMP_MASKED_EQ', valueTwo }])));
    }
    assert.ok(rules.some(rule => rule.names.includes('unshare') && JSON.stringify(rule.args) ===
      JSON.stringify([{ index: 0, value: 268435456, op: 'SCMP_CMP_EQ' }])));
  }
  for (const rule of policy.syscalls.filter(rule => rule.action === 'SCMP_ACT_ALLOW' &&
    rule.names.some(name => ['clone', 'unshare'].includes(name)))) {
    assert.ok(rule.args?.length || rule.includes?.caps?.includes('CAP_SYS_ADMIN'));
  }
});
