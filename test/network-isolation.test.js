import assert from 'node:assert/strict';
import { test } from 'node:test';
import { networkIsolated } from '../runner/network-isolation.mjs';

const devHeader = 'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n';
const routeHeader = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n';
const devRow = name => `${name}: ${Array(16).fill('0').join(' ')}\n`;
const route = name => `${name}\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0\n`;
const zero6 = '0'.repeat(32);
const route6 = (name, destination = zero6, prefix = '00', flags = '00200200') => `${destination} ${prefix} ${zero6} 00 ${zero6} ffffffff 00000001 00000000 ${flags}       ${name}\n`;
const loopback = () => ({ lo: [
  { address: '127.0.0.1', family: 'IPv4', internal: true },
  { address: '::1', family: 'IPv6', internal: true },
] });

function fixture(devices = ['lo']) {
  const files = new Map([
    ['/proc/net/dev', devHeader + devices.map(devRow).join('')],
    ['/proc/net/route', routeHeader],
    ['/proc/net/ipv6_route', route6('lo') + route6('lo', `${'0'.repeat(31)}1`, '80', '80200001') + route6('lo')],
    ...devices.filter(name => name !== 'lo').map(name => [`/sys/class/net/${name}/flags`, '0x80\n']),
  ]);
  const read = async (path, encoding) => {
    assert.equal(encoding, 'utf8');
    if (!files.has(path)) throw new Error(`Unreadable ${path}`);
    return files.get(path);
  };
  return { files, read };
}

test('accepts loopback, including kernel IPv6 unreachable fallback records', async () => {
  const { files, read } = fixture();
  assert.equal(await networkIsolated(loopback(), read), true);
  files.set('/proc/net/route', routeHeader + route('lo'));
  assert.equal(await networkIsolated(loopback(), read), true);
  files.set('/proc/net/ipv6_route', '');
  assert.equal(await networkIsolated(loopback(), read), true);
});

test('accepts Docker network=none fallback tunnels only when administratively down', async () => {
  const tunnels = ['tunl0', 'gre0', 'gretap0', 'erspan0', 'ip_vti0', 'ip6_vti0', 'sit0', 'ip6tnl0', 'ip6gre0'];
  const { files, read } = fixture(['lo', ...tunnels]);
  for (const name of ['gretap0', 'erspan0']) files.set(`/sys/class/net/${name}/flags`, '0x1002\n');
  assert.equal(await networkIsolated(loopback(), read), true);
  for (const name of tunnels) {
    const path = `/sys/class/net/${name}/flags`;
    const flags = files.get(path);
    files.set(path, '0x81\n');
    assert.equal(await networkIsolated(loopback(), read), false, name);
    files.set(path, flags);
  }
});

test('rejects an UP tunnel even without addresses or routes', async () => {
  const { files, read } = fixture(['lo', 'tun0']);
  files.set('/sys/class/net/tun0/flags', '0x1\n');
  assert.equal(await networkIsolated(loopback(), read), false);
});

test('rejects all non-loopback interface addresses, including internal-labelled addresses', async () => {
  const { read } = fixture(['lo', 'tun0']);
  for (const entry of [
    { address: '10.0.0.2', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
    { address: '127.0.0.2', family: 'IPv4', internal: true },
  ]) {
    assert.equal(await networkIsolated({ ...loopback(), tun0: [entry] }, read), false);
  }
});

test('rejects non-loopback IPv4 and IPv6 routes, even on a DOWN device', async () => {
  for (const path of ['/proc/net/route', '/proc/net/ipv6_route']) {
    const { files, read } = fixture(['lo', 'tun0']);
    files.set(path, files.get(path) + (path.endsWith('ipv6_route') ? route6('tun0') : route('tun0')));
    assert.equal(await networkIsolated(loopback(), read), false, path);
  }
});

test('requires loopback in both device and address metadata', async () => {
  assert.equal(await networkIsolated(loopback(), fixture(['tun0']).read), false);
  for (const interfaces of [{}, { lo: [] }, { lo: undefined }]) {
    assert.equal(await networkIsolated(interfaces, fixture().read), false);
  }
});

test('rejects malformed address metadata', async () => {
  for (const interfaces of [null, [], { lo: null }, { lo: [null] }, { lo: [{}] },
    { lo: [{ address: '10.0.0.1', family: 'IPv4', internal: true }] },
    { lo: [{ address: '::1', family: 'IPv4', internal: true }] },
    { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: false }] },
    { ...loopback(), unknown: [] },
  ]) assert.equal(await networkIsolated(interfaces, fixture().read), false);
});

test('rejects malformed device, flag, and route metadata', async () => {
  const malformed = [
    ['/proc/net/dev', ''],
    ['/proc/net/dev', 'bad header\n' + devRow('lo')],
    ['/proc/net/dev', devHeader + devRow('lo') + devRow('lo')],
    ['/proc/net/dev', devHeader + devRow('lo') + devRow('../tun0')],
    ['/proc/net/dev', devHeader + devRow('lo').replace('0 0', '0 nope')],
    ['/proc/net/dev', devHeader + 'lo: 0\n'],
    ['/sys/class/net/tun0/flags', ''],
    ['/sys/class/net/tun0/flags', '0x80junk'],
    ['/sys/class/net/tun0/flags', '0x100000000'],
    ['/sys/class/net/tun0/flags', 'not flags'],
    ['/proc/net/route', ''],
    ['/proc/net/route', routeHeader + 'lo invalid\n'],
    ['/proc/net/route', routeHeader + route('lo').replace('00000000', 'zzzzzzzz')],
    ['/proc/net/ipv6_route', 'lo invalid\n'],
    ['/proc/net/ipv6_route', route6('lo', zero6, '81')],
    ['/proc/net/ipv6_route', route6('lo').replace('00200200', 'invalid!')],
    ['/proc/net/ipv6_route', null],
  ];
  for (const [path, value] of malformed) {
    const { files, read } = fixture(['lo', 'tun0']);
    files.set(path, value);
    assert.equal(await networkIsolated(loopback(), read), false, `${path}: ${value}`);
  }
});

test('fails closed for every proc and sys read error', async () => {
  for (const path of ['/proc/net/dev', '/proc/net/route', '/proc/net/ipv6_route', '/sys/class/net/tun0/flags']) {
    const { files, read } = fixture(['lo', 'tun0']);
    files.delete(path);
    assert.equal(await networkIsolated(loopback(), read), false, path);
  }
});
