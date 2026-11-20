import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export function isPublicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

export async function resolvePublicIPv4(host, resolve = new Resolver({ timeout: 2000, tries: 1 })) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) throw Error('Invalid destination');
  if (isPublicIPv4(host)) return host;
  if (isIP(host)) throw Error('Non-public or unsupported address');
  const name = domainToASCII(host).toLowerCase();
  // Require fully qualified DNS names, not local resolver search domains or alternate IPv4 spellings.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/.test(name) ||
      name.length > 253 || /(?:^|\.)(localhost|local|internal|test|invalid|onion|home\.arpa)\.?$/.test(name)) {
    throw Error('Invalid destination');
  }
  const addresses = await resolve.resolve4(name.endsWith('.') ? name : `${name}.`);
  if (!addresses.length || !addresses.every(isPublicIPv4)) throw Error('Non-public DNS answer');
  return addresses[0]; // Dial the validated numeric address, never the DNS name.
}
