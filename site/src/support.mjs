import crypto from 'node:crypto';
import { cfg } from './config.mjs';

/**
 * Ports of the helpers in lib/support.php, plus a PHP-compatible parse_url.
 *
 * Node's WHATWG URL cannot stand in for PHP's parse_url: it normalises, resolves
 * "..", lower-cases and throws on inputs PHP accepts. This app makes security
 * decisions from those fields, so the parser mirrors PHP and is fuzz-diffed
 * against it in parity/test-support.mjs rather than assumed.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };

/** htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') */
export function e(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}

/** human_bytes() from lib/support.php. */
export function humanBytes(bytes) {
  if (bytes === null || bytes === undefined || !(bytes > 0)) {
    return null;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / Math.pow(1024, i);
  // number_format($v, $v < 10 ? 2 : 1, '.', '') then strips trailing zeros.
  return numberFormat(v, v < 10 ? 2 : 1).replace(/0+$/, '').replace(/\.$/, '') + ' ' + units[i];
}

/** PHP number_format: half-up rounding, forced decimals, no thousands separator here. */
export function numberFormat(value, decimals) {
  const factor = Math.pow(10, decimals);
  // PHP rounds half away from zero on the decimal string; JS toFixed is
  // implementation-affected by float error, so scale and round explicitly.
  const rounded = phpRound(value * factor);
  return (rounded / factor).toFixed(decimals);
}

/** round(): half away from zero, which is not what Math.round does to negatives. */
export function phpRound(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) {
    return v;
  }
  return v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5);
}

/** (int) cast: leading whitespace and sign, longest numeric prefix, truncate toward zero. */
export function phpInt(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }
  if (value === null || value === undefined || typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const prefix = /^[ \t\n\r\x0B\u0000]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(String(value));
  if (prefix === null) {
    return 0;
  }
  const n = Number(prefix[0]);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** (float) cast, same shape as the int cast. */
export function phpFloat(value) {
  if (typeof value === 'number') {
    return value;
  }
  const prefix = /^[ \t\n\r\x0B\u0000]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(String(value));
  return prefix === null ? 0 : Number(prefix[0]);
}

/** intdiv() for the positive operands this code uses. */
export function intDiv(a, b) {
  return Math.trunc(a / b);
}

const TRIM_CHARS = ' \t\n\r\x0B\u0000';

/** trim($s): php's default character list, which is narrower than javascript's. */
export function phpTrim(s, chars = TRIM_CHARS) {
  return phpTrimEnd(phpTrimStart(s, chars), chars);
}

export function phpTrimStart(s, chars = TRIM_CHARS) {
  const str = String(s);
  let i = 0;
  while (i < str.length && chars.includes(str[i])) {
    i++;
  }
  return str.slice(i);
}

export function phpTrimEnd(s, chars = TRIM_CHARS) {
  const str = String(s);
  let end = str.length;
  while (end > 0 && chars.includes(str[end - 1])) {
    end--;
  }
  return str.slice(0, end);
}

/**
 * parse_url() from PHP.
 *
 * The authority grammar ("scheme://host:port/path") is reproduced key for key,
 * including the quirks that decide what UrlGuard does with a link: the host/port
 * split happens at the LAST colon, so "ok.com:80:/x" really is the host
 * "ok.com:80"; the port is the leading integer after that colon, so ":1x" is port 1;
 * a port over 65535 makes the whole url unparseable; and "http://" with no host at
 * all is false, not an empty host.
 *
 * Inputs with no "//" go the other way. PHP's legacy parser sometimes reads
 * "a.b.c:80/x" as host "a.b.c" port 80 and sometimes as scheme "a.b.c", depending on
 * undocumented character tests, and it is not worth cloning. That is safe because
 * every consumer in this app requires both a scheme and a host before it acts, and
 * the legacy branch never produces both: UrlGuard answers "That does not look like a
 * link." and url_absolutize() returns the relative string unchanged either way.
 * parity/test-support.mjs asserts decision parity on those inputs, not key parity.
 */
export function parseUrl(url) {
  if (typeof url !== 'string') {
    return false;
  }
  if (url === '') {
    return { path: '' };
  }
  const out = {};
  let rest = url;
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    out.fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  const question = rest.indexOf('?');
  if (question !== -1) {
    out.query = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }

  const scheme = /^([A-Za-z][A-Za-z0-9+.\-]*):/.exec(rest);
  let authority;
  if (scheme && rest.slice(scheme[0].length, scheme[0].length + 2) === '//') {
    out.scheme = scheme[1];
    authority = rest.slice(scheme[0].length + 2);
  } else if (scheme) {
    return { ...out, scheme: scheme[1], path: rest.slice(scheme[0].length) };
  } else if (rest.startsWith('//')) {
    authority = rest.slice(2);
  } else {
    return { ...out, path: rest };
  }

  let path = '';
  const slash = authority.indexOf('/');
  if (slash !== -1) {
    path = authority.slice(slash);
    authority = authority.slice(0, slash);
  }
  if (authority === '') {
    return false; // php refuses "http://", "http:///a" and "http://?x" outright
  }

  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    const userinfo = authority.slice(0, at);
    authority = authority.slice(at + 1);
    const colon = userinfo.indexOf(':');
    if (colon === -1) {
      out.user = userinfo;
    } else {
      out.user = userinfo.slice(0, colon);
      out.pass = userinfo.slice(colon + 1);
    }
  }

  let host = authority;
  let portText = null;
  let bracketed = false;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close !== -1) {
      const after = authority.slice(close + 1);
      // A bracket is only honoured when nothing but a port follows it; "[::1]x" is
      // read as an ordinary host again, which is how php lands on host "[:".
      // A second colon after the digits also breaks the bracket form, so
      // "[::1]:80:90" is the host "[::1]:80" with port 90.
      if (after === '' || (after.startsWith(':') && bracketPortHolds(after.slice(1)))) {
        bracketed = true;
        host = authority.slice(0, close + 1);
        portText = after === '' ? null : after.slice(1);
      }
    }
  }
  if (!bracketed) {
    const colon = authority.lastIndexOf(':');
    if (colon !== -1) {
      host = authority.slice(0, colon);
      portText = authority.slice(colon + 1);
    }
  }
  if (host === '') {
    return false; // php refuses "http://:80"
  }
  if (portText !== null && portText !== '') {
    const digits = /^[ \t]*\+?(\d+)/.exec(portText);
    if (digits === null) {
      return false;
    }
    const port = Number(digits[1]);
    if (port > 65535) {
      return false;
    }
    out.port = port;
  }
  out.host = host;
  if (path !== '') {
    out.path = path;
  }
  return out;
}

/**
 * php keeps the bracketed form only while the text after "]" is a port that ends
 * there; a second colon ("[::1]:80:90") or a non-digit start makes it re-read the
 * whole authority the naive way.
 */
function bracketPortHolds(text) {
  if (text === '') {
    return true;
  }
  const digits = /^[ \t]*\+?\d+/.exec(text);
  return digits !== null && text[digits[0].length] !== ':';
}

/** url_absolutize() from lib/support.php. */
export function urlAbsolutize(base, maybeRelative) {
  let rel = phpTrim(maybeRelative);
  if (rel === '') {
    return base;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(rel)) {
    return rel;
  }
  const p = parseUrl(base);
  // isset(), not empty(): php does build an origin out of the host "0".
  if (!p || p.scheme === undefined || p.host === undefined) {
    return rel;
  }
  const origin = p.scheme + '://' + p.host + (p.port !== undefined && p.port !== null ? ':' + p.port : '');
  if (rel.startsWith('//')) {
    return p.scheme + ':' + rel;
  }
  if (rel[0] === '/') {
    return origin + rel;
  }
  const path = p.path !== undefined && p.path !== '' ? p.path : '/';
  const dir = path.endsWith('/') ? path : dirnamePhp(path) + '/';
  return origin + dir + (rel.startsWith('./') ? rel.slice(2) : rel);
}

/** PHP dirname(): strips the trailing /path component, "" becomes "." on Windows only. */
export function dirnamePhp(path) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const pos = normalized.lastIndexOf('/');
  if (pos === -1) {
    return '.';
  }
  if (pos === 0) {
    return '/';
  }
  return normalized.slice(0, pos);
}

/**
 * link_seal() / link_open(): aes-256-cbc with the key HMAC-SHA256('relay-link', secret),
 * iv prepended, base64url without padding.
 */
export function linkSeal(url, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('relay-link').digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(String(url), 'utf8'), cipher.final()]);
  return base64Url(Buffer.concat([iv, ct]));
}

export function linkOpen(sealed, secret) {
  const raw = base64UrlDecode(String(sealed));
  if (raw === null || raw.length < 32) {
    return null;
  }
  const key = crypto.createHmac('sha256', String(secret)).update('relay-link').digest();
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, raw.subarray(0, 16));
    return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function base64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text) {
  let b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 1) {
    return null;
  }
  if (pad) {
    b64 += '='.repeat(4 - pad);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    return null;
  }
  return Buffer.from(b64, 'base64');
}

export const VD_VERSION = '1.0.0';

/** site_url(): config base_url always wins, the requested host is only a fallback. */
export function siteUrl(path = '', hostHeader = '', https = true) {
  let root = String(cfg('app.base_url', '') || '').replace(/\/+$/, '');
  if (root === '') {
    let host = String(hostHeader || '');
    if (!/^[A-Za-z0-9.\-]{1,100}(:\d{2,5})?$/.test(host)) {
      host = 'localhost';
    }
    root = (https ? 'https' : 'http') + '://' + host;
  }
  return root + (path === '' ? '' : '/' + String(path).replace(/^\/+/, ''));
}

/** Relay::appUrl(): the base the browser is given for every api call. */
export function appUrl(query, hostHeader = '', https = true) {
  // The php app could answer ?r=... on the directory index because apache sent every
  // unknown path to index.php. On static hosting the directory index is the html page,
  // which ignores a query string, so the links name the entry file the way app.js does.
  const entry = String(cfg('app.entry', 'index.php')).replace(/^\/+/, '');
  const base = cfg('app.base_url', '');
  if (typeof base === 'string' && base !== '') {
    return base.replace(/\/+$/, '') + '/' + entry + '?' + query;
  }
  return siteUrl('', hostHeader, https) + '/' + entry + '?' + query;
}
