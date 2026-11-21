import { isIP } from 'node:net';

export function isTcpDestination(host, port) {
  return typeof host === 'string' && host.length > 0 && host.length <= 254 &&
    (isIP(host) === 6 && !host.includes('%') || /^(?:[a-z\d_-]{1,63}\.)*[a-z\d_-]{1,63}\.?$/i.test(host)) &&
    Number.isInteger(port) && port >= 1 && port <= 65535;
}
