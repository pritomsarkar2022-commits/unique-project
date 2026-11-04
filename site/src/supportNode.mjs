/**
 * The support.php helpers that cannot run in a browser.
 *
 * Sealed relay links need aes-256-cbc, and the host a request came in on lives in an
 * async context; both are node-only, so they sit here and support.mjs re-exports them
 * next to supportPure.mjs for every server-side import path.
 */
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { cfg } from './config.mjs';

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

/**
 * The address the visitor came in on, for the routes that build links without naming
 * a host themselves.
 *
 * php read $_SERVER['HTTP_HOST'], $_SERVER['HTTPS'] and $_SERVER['SCRIPT_NAME'] out of
 * a superglobal inside site_url(), base_href() and Relay::appUrl(). A function has no
 * superglobal, so the entry layer sets this once per request; passing a host to either
 * helper still wins over it, the way an explicit argument always did.
 *
 * It lives in an async context and not in a module variable because one node process
 * serves several visitors at the same time, where apache gave each request its own. A
 * shared variable here would let one request build a link that names another visitor's
 * host, which is exactly the leak the sealed relay url exists to prevent.
 */
const hostScope = new AsyncLocalStorage();
const outsideRequest = { host: '', https: true, dir: '' };

export function setRequestHost(host = '', https = true, scriptName = '/index.php') {
  hostScope.enterWith({ host: String(host || ''), https: https !== false, dir: hrefDir(scriptName) });
}

export function getRequestHost() {
  return hostScope.getStore() ?? outsideRequest;
}

/** base_href(): the directory the front controller lives in, with a trailing slash. */
export function baseHref() {
  return getRequestHost().dir + '/';
}

function hrefDir(scriptName) {
  const script = String(scriptName ?? '/index.php').replace(/\\/g, '/');
  const cut = script.lastIndexOf('/');
  return (cut < 0 ? '' : script.slice(0, cut)).replace(/\/+$/, '');
}

/** site_url(): config base_url always wins, the requested host is only a fallback. */
export function siteUrl(path = '', hostHeader = '', https = true) {
  let root = String(cfg('app.base_url', '') || '').replace(/\/+$/, '');
  if (root === '') {
    const ambientHost = getRequestHost();
    const ambient = hostHeader === '' || hostHeader === null || hostHeader === undefined;
    let host = String(ambient ? ambientHost.host : hostHeader);
    if (!/^[A-Za-z0-9.\-]{1,100}(:\d{2,5})?$/.test(host)) {
      host = 'localhost';
    }
    const secure = ambient ? ambientHost.https : https !== false;
    root = (secure ? 'https' : 'http') + '://' + host + (ambient ? ambientHost.dir : '');
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
