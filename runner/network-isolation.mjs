import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

const deviceName = /^(?!\.{1,2}$)[a-zA-Z0-9_.-]+$/;
const hex = (value, width) => new RegExp(`^[0-9a-fA-F]{${width}}$`).test(value);
const rows = text => text.trim().split('\n').map(line => line.trim().split(/\s+/));

// Read failures and unrecognized kernel metadata must never establish isolation.
export async function networkIsolated(interfaces, read = readFile) {
  try {
    const [devicesText, routesText, routes6Text] = await Promise.all([
      read('/proc/net/dev', 'utf8'),
      read('/proc/net/route', 'utf8'),
      read('/proc/net/ipv6_route', 'utf8'),
    ]);
    if (![devicesText, routesText, routes6Text].every(value => typeof value === 'string')) return false;
    const deviceLines = devicesText.trim().split('\n');
    if (deviceLines.length < 3 ||
        !/^Inter-\|\s*Receive\s*\|\s*Transmit\s*$/.test(deviceLines[0].trim()) ||
        !/^face\s*\|\s*bytes\s+packets\s+errs\s+drop\s+fifo\s+frame\s+compressed\s+multicast\s*\|\s*bytes\s+packets\s+errs\s+drop\s+fifo\s+colls\s+carrier\s+compressed\s*$/.test(deviceLines[1].trim())) return false;
    const devices = new Set();
    for (const line of deviceLines.slice(2)) {
      const parts = line.trim().split(':');
      const name = parts[0].trim();
      if (parts.length !== 2 || !deviceName.test(name) || devices.has(name)) return false;
      const counters = parts[1].trim().split(/\s+/);
      if (counters.length !== 16 || !counters.every(value => /^\d+$/.test(value))) return false;
      devices.add(name);
    }
    if (!devices.has('lo')) return false;
    if (!interfaces || typeof interfaces !== 'object' || Array.isArray(interfaces) ||
        !Object.hasOwn(interfaces, 'lo') || !Array.isArray(interfaces.lo) || !interfaces.lo.length) return false;
    for (const [name, entries] of Object.entries(interfaces)) {
      if (!devices.has(name) || !Array.isArray(entries) || (name !== 'lo' && entries.length !== 0)) return false;
      for (const entry of entries) {
        if (!entry || entry.internal !== true || typeof entry.address !== 'string') return false;
        const family = isIP(entry.address);
        if (family === 4 && entry.family === 'IPv4' && entry.address.startsWith('127.')) continue;
        if (family === 6 && entry.family === 'IPv6' && entry.address === '::1') continue;
        return false;
      }
    }
    for (const name of devices) {
      if (name === 'lo') continue;
      const flags = await read(`/sys/class/net/${name}/flags`, 'utf8');
      if (typeof flags !== 'string' || !/^0x[0-9a-fA-F]{1,8}$/.test(flags.trim()) ||
          (Number.parseInt(flags.trim(), 16) & 1) !== 0) return false;
    }
    const routes = rows(routesText);
    if (routes[0].join(' ') !== 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT') return false;
    for (const row of routes.slice(1)) {
      if (row.length !== 11 || row[0] !== 'lo' ||
          ![row[1], row[2], row[7]].every(value => hex(value, 8)) ||
          !/^[0-9a-fA-F]{4,8}$/.test(row[3]) ||
          ![row[4], row[5], row[6], row[8], row[9], row[10]].every(value => /^\d+$/.test(value))) return false;
    }
    // Linux also emits unreachable fallback routes on lo; these are not external routes.
    for (const row of routes6Text.trim() ? rows(routes6Text) : []) {
      if (row.length !== 10 || row[9] !== 'lo' ||
          ![row[0], row[2], row[4]].every(value => hex(value, 32)) ||
          ![row[1], row[3]].every(value => hex(value, 2) && Number.parseInt(value, 16) <= 128) ||
          !row.slice(5, 9).every(value => hex(value, 8))) return false;
    }
    return true;
  } catch {
    return false;
  }
}
