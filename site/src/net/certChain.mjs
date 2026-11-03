import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { parseUrl } from '../support.mjs';
import { assertSafe } from './urlGuard.mjs';

/**
 * Completes a certificate chain a file host forgot to send.
 *
 * Small hosts often run Apache with nothing but the leaf certificate on the
 * socket, so a client that does not chase the AIA pointer inside that leaf
 * cannot build a path to a root and curl stops with errno 60. Browsers hide the
 * defect by fetching the issuer over plain http; this does the same fetch, then
 * hands the request agent a CA bundle made of the machine's own store plus those
 * issuers.
 *
 * Verification is never switched off. A fetched issuer is only used after it has
 * been checked against the system store, and a self-signed root is never added,
 * so the anchor at the top of the chain still has to be one this machine already
 * trusts. An attacker who could fake the AIA response would still have to
 * produce a chain that reaches a real root and names the host we asked for.
 *
 * Port of lib/Net/CertChain.php. php hands curl a cafile path; node wants the
 * PEM text, so bundleFor() answers with a string. The two "does it verify"
 * questions are answered with real handshakes wherever a handshake can see the
 * material; see trustedByStore() for the one place it cannot.
 */

// php's base64 alphabet, in the order its lookup table expects.
const ALPHABET_64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const MAX_HOPS = 3;
const MAX_ISSUER_BYTES = 65_536;
const CACHE_HOURS = 6;

// OID 06 08 2B 06 01 05 05 07 30 02 followed by [6] IA5String (0x86)
const AIA_NEEDLE = Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x02, 0x86]);

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const PEM_ONE = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/;
const PEM_START = '-----BEGIN CERTIFICATE-----';
const PEM_END = '-----END CERTIFICATE-----';

// php's ~^https?://\S{1,300}$~ without /D, so a single trailing newline still matches.
const AIA_URI = /^https?:\/\/\S{1,300}\n?$/;

/** @var Map<string,string|null> */
const done = new Map();

export class CertChain {
  static MAX_HOPS = MAX_HOPS;
  static MAX_ISSUER_BYTES = MAX_ISSUER_BYTES;
  static CACHE_HOURS = CACHE_HOURS;
  static done = done;

  /** PEM bundle text that can verify $host, or null when there is nothing to fix. */
  static async bundleFor(host, options = {}) {
    if (done.has(host)) {
      return done.get(host);
    }
    done.set(host, null);

    const store = CertChain.machineStore();
    if (store === null) {
      return null;
    }

    const file = CertChain.cachePath(host);
    let stamp = 0;
    try {
      stamp = Math.floor(fs.statSync(file).mtimeMs / 1000);
    } catch {
      stamp = 0;
    }
    if (stamp > Math.floor(Date.now() / 1000) - CACHE_HOURS * 3600) {
      try {
        const cached = fs.readFileSync(file, 'utf8');
        done.set(host, cached);
        return cached;
      } catch {
        return null;
      }
    }

    const chain = await CertChain.peerChain(host, options);
    if (chain.length === 0) {
      return null;
    }

    const extras = await CertChain.walk(host, chain, store, options);
    if (extras.length === 0) {
      return null;
    }

    if (!CertChain.trustedByStore(String(extras[extras.length - 1]), store)) {
      log(options, 'cert chain not trusted', { host });
      return null;
    }

    const bundle = store + '\n' + extras.join('\n') + '\n';
    try {
      fs.writeFileSync(file, bundle, { mode: 0o600 });
    } catch {
      return null;
    }

    if (!(await CertChain.verifies(host, bundle, options))) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* the php original ignores an unlink failure too */
      }
      return null;
    }
    log(options, 'certificate chain completed', { host, added: extras.length });
    done.set(host, bundle);
    return bundle;
  }

  /**
   * The certificates the host presents, leaf first, as PEM.
   *
   * The handshake here is unverified, and only to read what the host sends: the
   * bytes it answers with are checked again against the machine store below.
   *
   * node has no array form of this (php reads stream_context's
   * peer_certificate_chain): the socket only hands back the leaf, and the chain is
   * the issuerCertificate links hanging off it. A root the host sent therefore
   * arrives here exactly the way it arrives in php, and the cycle guard is only
   * that, a guard; php's own list has the same shape either way.
   */
  static peerChain(host, options = {}) {
    return handshake(host, options, (socket) => {
      const out = [];
      const seen = new Set();
      let cert;
      try {
        cert = socket.getPeerCertificate(true);
      } catch {
        return [];
      }
      while (cert !== null && cert !== undefined && Object.keys(cert).length > 0) {
        if (!Buffer.isBuffer(cert.raw)) {
          break;
        }
        let pem = '';
        try {
          pem = new crypto.X509Certificate(cert.raw).toString();
        } catch {
          break;
        }
        const fp = CertChain.fingerprint(pem);
        if (fp === '' || seen.has(fp)) {
          break;
        }
        seen.add(fp);
        out.push(pem.trim());
        cert = cert.issuerCertificate;
      }
      return out.filter((text) => text.includes(PEM_START));
    }, false);
  }

  /**
   * Issuer certificates above whatever the host already sent, fetched from the
   * AIA pointer each certificate carries.
   */
  static async walk(host, chain, store, options = {}) {
    const extras = chain.slice(1);
    const seen = chain.map((pem) => CertChain.fingerprint(pem));
    let cursor = String(chain[chain.length - 1] ?? '');

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      let next = null;
      for (const uri of CertChain.aiaUris(cursor)) {
        next = await CertChain.fetchIssuer(uri, options);
        if (next !== null) {
          break;
        }
      }
      if (next === null) {
        break;
      }
      const fp = CertChain.fingerprint(next);
      if (fp === '' || seen.includes(fp)) {
        break;
      }
      if (CertChain.isSelfSigned(next)) {
        break; // a root belongs to the machine's store, not to us
      }
      extras.push(next);
      seen.push(fp);
      cursor = next;

      // it reaches a root the machine already trusts
      if (await CertChain.verifies(host, store, options)) {
        break;
      }
    }
    return extras;
  }

  /**
   * UniformResourceIdentifier entries tagged as id-ad-caIssuers
   * (1.3.6.1.5.5.7.48.2) inside the DER.
   */
  static aiaUris(pem) {
    const der = CertChain.der(pem);
    if (der.length === 0) {
      return [];
    }
    const out = [];
    let pos = 0;
    for (;;) {
      const i = der.indexOf(AIA_NEEDLE, pos);
      if (i === -1) {
        break;
      }
      pos = i + AIA_NEEDLE.length;
      let len = pos < der.length ? der[pos] : 0;
      let offset = 1;
      if (len >= 0x81 && len <= 0x84) {
        const count = len & 0x7f;
        len = 0;
        for (let k = 0; k < count; k++) {
          // php shifts into a 64-bit int, so this stays exact well past 32 bits.
          len = len * 256 + (pos + 1 + k < der.length ? der[pos + 1 + k] : 0);
        }
        offset = 1 + count;
      }
      const uri = der.subarray(pos + offset, pos + offset + len).toString('latin1');
      if (AIA_URI.test(uri)) {
        out.push(uri);
      }
    }
    return [...new Set(out)];
  }

  static async fetchIssuer(uri, options = {}) {
    if (!validatesUrl(uri)) {
      return null;
    }
    try {
      await assertSafe(uri, options.resolve);
    } catch {
      return null;
    }
    const body = await (options.get ?? getBytes)(uri, options);
    if (body === null || body.length < 200 || body.length > MAX_ISSUER_BYTES) {
      return null;
    }
    const raw = body.toString('latin1');
    if (raw.includes(PEM_START)) {
      let pem = raw.slice(raw.indexOf(PEM_START));
      const end = pem.indexOf(PEM_END);
      pem = end === -1 ? pem : pem.slice(0, end + PEM_END.length);
      return parses(pem) ? pem.trim() : null;
    }
    const pem = PEM_START + '\n' + chunkSplit(base64(body), 64, '\n') + PEM_END + '\n';
    return parses(pem) ? pem.trim() : null;
  }

  /** Raw certificate bytes of the first PEM block, or an empty buffer. */
  static der(pem) {
    const m = PEM_ONE.exec(String(pem));
    if (m === null) {
      return Buffer.alloc(0);
    }
    return phpBase64Decode(m[1].replace(/[ \t\n\r\f\v]+/g, ''));
  }

  static fingerprint(pem) {
    const der = CertChain.der(pem);
    return der.length === 0 ? '' : crypto.createHash('sha256').update(der).digest('hex');
  }

  static isSelfSigned(pem) {
    let cert;
    try {
      cert = new crypto.X509Certificate(String(pem));
    } catch {
      return true; // unreadable: refuse rather than treat it as an issuer
    }
    if (!cert.subject || !cert.issuer) {
      return true;
    }
    return cert.subject === cert.issuer;
  }

  /**
   * Path to the bundle of roots this machine already trusts, chosen exactly the
   * way php chose it. Both ini slots become environment slots here.
   */
  static systemStore(candidates = null) {
    const list = (candidates ?? [
      process.env.VD_CURL_CAINFO ?? '',
      process.env.VD_OPENSSL_CAFILE ?? '',
      '/etc/ssl/certs/ca-certificates.crt',
      '/etc/pki/tls/certs/ca-bundle.crt',
      '/etc/ssl/cert.pem',
    ]).filter((file) => String(file) !== '');
    for (const file of list) {
      let head;
      try {
        fs.accessSync(file, fs.constants.R_OK);
        if (Math.floor(fs.statSync(file).size) <= 4096) {
          continue;
        }
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(4096);
          const read = fs.readSync(fd, buf, 0, 4096, 0);
          head = buf.subarray(0, read).toString('latin1');
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      if (head.includes('BEGIN CERTIFICATE')) {
        return file;
      }
    }
    return null;
  }

  /**
   * The trust anchors as PEM text. php read them out of the file above; node has
   * no cafile of its own, so when the file search comes up empty it falls back to
   * the roots the runtime was built with.
   */
  static machineStore() {
    const file = CertChain.systemStore();
    if (file !== null) {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        /* unreadable after all; the compiled-in roots still answer */
      }
    }
    return tls.rootCertificates.length > 0 ? tls.rootCertificates.join('\n') : null;
  }

  /**
   * Whether the machine store signed this certificate. php asked openssl to build
   * a path from it to any anchor in the store; a node handshake cannot do that for
   * an issuer we are holding out of band, so this asks openssl for the signature
   * check one hop at a time instead. It is the narrower test: a fetched chain that
   * needed more than one hop inside the store is refused rather than accepted, and
   * nothing is ever trusted that the store did not sign.
   */
  static trustedByStore(pem, store) {
    let cert;
    try {
      cert = new crypto.X509Certificate(pem);
    } catch {
      return false;
    }
    for (const block of store.match(PEM_BLOCK) ?? []) {
      try {
        // verify() wants the issuer's public key, not its certificate.
        if (cert.verify(new crypto.X509Certificate(block).publicKey)) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  /**
   * A verified handshake to the host, anchored on ca. Unlike php's
   * openssl_x509_checkpurpose() this also pins the name on the certificate, which
   * is the stricter answer, so it is the one this port keeps.
   */
  static verifies(host, ca, options = {}) {
    return handshake(host, { ...options, ca }, () => true, true);
  }

  /**
   * Per-instance on Netlify: the cache only ever saves a second walk on the same
   * warm container, never across one.
   */
  static cachePath(host) {
    const dir = path.join(process.env.VD_ROOT || process.cwd(), 'storage', 'cert');
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      /* php's @mkdir kept going after a failure too */
    }
    return path.join(dir, crypto.createHash('sha256').update(String(host).toLowerCase()).digest('hex').slice(0, 24) + '.pem');
  }
}

/**
 * One tls.connect to port 443 of the host, its result read by `onSecure`, and
 * `failure` whenever the socket cannot be reached. `rejectUnauthorized` is the
 * only switch between the chain reader and the verifier.
 */
function handshake(host, options, onSecure, rejectUnauthorized) {
  const failure = rejectUnauthorized ? false : [];
  return new Promise((resolve) => {
    const port = options.port ?? 443;
    const timeoutMs = options.timeoutMs ?? 8000;
    let socket;
    try {
      socket = tls.connect({
        host,
        port,
        servername: options.servername ?? host,
        ca: options.ca,
        rejectUnauthorized,
        timeout: timeoutMs,
      });
    } catch {
      resolve(failure);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('secureConnect', () => {
      try {
        finish(onSecure(socket));
      } catch {
        finish(failure);
      }
    });
    socket.once('error', () => finish(failure));
    socket.once('timeout', () => finish(failure));
  });
}

function parses(pem) {
  try {
    new crypto.X509Certificate(pem);
    return true;
  } catch {
    return false;
  }
}

function base64(buf) {
  return buf.toString('base64');
}

/** chunk_split($s, $width, $end): the separator also closes the final chunk. */
function chunkSplit(s, width, end) {
  let out = '';
  for (let i = 0; i < s.length; i += width) {
    out += s.slice(i, i + width) + end;
  }
  return out;
}

/**
 * base64_decode() in php's non-strict mode: every character outside the alphabet
 * is skipped, including the '=' padding, so the valid letters simply stream.
 */
function phpBase64Decode(s) {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | ALPHABET_64.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

const ASCII_ONLY = /^[\x21-\x7e]+$/;
const HOST_GRAMMAR = /^(?:\[[^\]]*\]|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?)$/;

// php's filter grammar only ever reads five digits of a port, so a longer digit
// run is refused even though the number itself would still be in range.
const AUTHORITY = /^[A-Za-z][A-Za-z0-9+.\-]*:\/\/([^/?#]*)/;
const PORT_TOO_LONG = /^[ \t]*\+?[0-9]{6,}/;

function portRunTooLong(text) {
  const m = AUTHORITY.exec(text);
  if (m === null) {
    return false;
  }
  let authority = m[1];
  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    authority = authority.slice(at + 1);
  }
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close !== -1) {
      authority = authority.slice(close + 1);
    }
  }
  const colon = authority.lastIndexOf(':');
  return colon !== -1 && PORT_TOO_LONG.test(authority.slice(colon + 1));
}

/**
 * filter_var($uri, FILTER_VALIDATE_URL) for the shapes aiaUris can hand over.
 * Everything here is already free of whitespace and under 300 characters, so what
 * is left of php's filter grammar is the scheme, the host labels, the port range
 * (which parseUrl() already enforces) and the five-digit port window above.
 */
export function validatesUrl(uri) {
  const text = String(uri);
  if (!ASCII_ONLY.test(text)) {
    return false;
  }
  const p = parseUrl(text);
  if (!p || p.scheme === undefined || p.host === undefined || p.host === '') {
    return false;
  }
  return HOST_GRAMMAR.test(p.host) && !portRunTooLong(text);
}

/**
 * A plain http(s) read of an issuer file. php guarded only the url it was given
 * and let its stream context follow the redirects on its own, so this does the
 * same; the mirror is deliberately not an improvement.
 */
function getBytes(uri, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxRedirects = options.maxRedirects ?? 3;
  return new Promise((resolve) => {
    let hops = 0;
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const step = (target) => {
      let req;
      try {
        const mod = target.startsWith('https:') ? https : http;
        req = mod.get(target, { timeout: timeoutMs });
      } catch {
        finish(null);
        return;
      }
      req.setTimeout(timeoutMs, () => req.destroy());
      req.on('error', () => finish(null));
      req.on('timeout', () => {
        req.destroy();
        finish(null);
      });
      req.on('response', (res) => {
        const location = res.headers.location;
        const redirect = typeof location === 'string' && res.statusCode >= 300 && res.statusCode < 400;
        if (redirect) {
          res.resume();
          if (hops++ >= maxRedirects) {
            finish(null);
            return;
          }
          let next;
          try {
            next = new URL(location, target).toString();
          } catch {
            finish(null);
            return;
          }
          step(next);
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          chunks.push(chunk);
          total += chunk.length;
          if (total > MAX_ISSUER_BYTES) {
            res.destroy();
            finish(null);
          }
        });
        res.on('error', () => finish(null));
        res.on('aborted', () => finish(null));
        res.on('end', () => finish(Buffer.concat(chunks)));
      });
    };
    step(uri);
  });
}

/** vd_log(): the port takes the sink from the caller instead of owning a log file. */
function log(options, message, context) {
  if (typeof options.log === 'function') {
    options.log(message, context);
  }
}
