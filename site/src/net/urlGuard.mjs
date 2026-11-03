import { parseUrl } from '../support.mjs';

/**
 * SSRF wall. This server fetches attacker-supplied urls, so every url and every
 * redirect hop must be proven public before the request is allowed out.
 *
 * Port of lib/Net/UrlGuard.php. The only structural change is that DNS is
 * asynchronous in node, so resolution is injected: production passes
 * resolveDns(), tests pass the exact answers php got, which keeps the
 * comparison about the decision rather than about the resolver.
 */
export class UrlGuardException extends Error {
  constructor(message) {
    super(message);
    this.name = 'UrlGuardException';
  }
}

/** php's gethostbyname: an A record only, and the input back when it fails. */
export async function resolveDns(host) {
  const { promises: dns } = await import('node:dns');
  try {
    const found = await dns.lookup(host, { family: 4 });
    return found.address;
  } catch {
    return host;
  }
}

const IPV4_PRIVATE = [
  [0x00000000, 0xff000000], // 0.0.0.0/8      this network
  [0x0a000000, 0xff000000], // 10.0.0.0/8     private
  [0x7f000000, 0xff000000], // 127.0.0.0/8    loopback
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 link local
  [0xac100000, 0xfff00000], // 172.16.0.0/12  private
  [0xc0000000, 0xff000000], // 192.0.0.0/8    IETF assignments
  [0xc0000200, 0xffffff00], // 192.0.2.0/24   documentation
  [0xc0586300, 0xffffff00], // 192.88.99.0/24 6to4 relay
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16 private
  [0xc6120000, 0xfffe0000], // 198.18.0.0/15  benchmarking
  [0xc6336400, 0xffffff00], // 198.51.100.0/24 documentation
  [0xcb006400, 0xffffff00], // 203.0.113.0/24  documentation
  [0xe0000000, 0xf0000000], // 224.0.0.0/4    multicast
  [0xf0000000, 0xf0000000], // 240.0.0.0/4    reserved
  [0x64400000, 0xffc00000], // 100.64.0.0/10  carrier-grade nat
];

export function assertSafe(url, resolve = resolveDns) {
  return assertSafeAsync(url, resolve);
}

/**
 * @returns {Promise<string>} "scheme://host" when the fetch is allowed.
 * @throws {UrlGuardException} with a message already written for a visitor.
 */
export async function assertSafeAsync(url, resolve = resolveDns) {
  const p = parseUrl(url);
  // The "0" test is not paranoia: php's empty() treats the host "0" as absent, so
  // http://0/x is refused as an unreadable link rather than as a machine address.
  if (!p || !p.scheme || !p.host || p.host === '0') {
    throw new UrlGuardException('That does not look like a link.');
  }
  const scheme = String(p.scheme).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new UrlGuardException('Only web links work here, http or https.');
  }
  let host = String(p.host).toLowerCase().replace(/\.+$/, '');
  if (host.length > 253 || host.includes('@') || String(url).includes('\\')) {
    throw new UrlGuardException('That link is not shaped like a web address.');
  }
  // Bracketed ipv6 literals and single-label names are never a public video site,
  // and decimal, octal or hex encoded hosts (0x7f000001, 2130706433) are how a url
  // reaches the machine itself while looking like a number.
  const labels = host.split('.');
  const last = labels[labels.length - 1] ?? '';
  if (labels.length < 2 || host.includes(':') || !/^[a-z][a-z0-9-]*$/.test(last)) {
    throw new UrlGuardException('That link points at a machine address, not a video site.');
  }
  if (host.endsWith('.local') || host.endsWith('.internal') || host === 'localhost') {
    throw new UrlGuardException('That site is not reachable from here.');
  }

  if (await isPrivateHost(host, resolve)) {
    throw new UrlGuardException('That link points inside a private network.');
  }

  const port = p.port ?? (scheme === 'https' ? 443 : 80);
  if (![80, 443, 8080, 8443].includes(port)) {
    throw new UrlGuardException('That link uses an address this tool does not open.');
  }
  return scheme + '://' + host;
}

async function isPrivateHost(host, resolve) {
  const ip = isIpv4Literal(host) ? host : await resolve(host);
  if (ip === '' || ip === host) {
    // An unresolved name is not private; let the request fail naturally the way
    // the php original does, so a typo is not reported as a security refusal.
    return false;
  }
  if (/^169\.254\./.test(ip)) {
    return true; // cloud metadata
  }
  if (!isIpv4Literal(ip)) {
    // php's filter_var() refuses anything that is not a plain address.
    return true;
  }
  return ipv4IsPrivate(ip);
}

export function isIpv4Literal(text) {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(text)
    && text.split('.').every((part) => Number(part) <= 255 && String(Number(part)) === part);
}

export function ipv4ToLong(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] * 0x1000000) + (parts[1] * 0x10000) + (parts[2] * 0x100) + parts[3]) >>> 0;
}

export function ipv4IsPrivate(ip) {
  const value = ipv4ToLong(ip);
  return IPV4_PRIVATE.some(([base, mask]) => (value & mask) >>> 0 === (base & mask) >>> 0);
}
