import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Transform, PassThrough } from 'node:stream';
import { Buffer } from 'node:buffer';
import { cfg } from '../config.mjs';
import { HttpException } from '../errors.mjs';
import { HttpResponse } from './httpResponse.mjs';
import { assertSafeAsync } from './urlGuard.mjs';
import { CertChain } from './certChain.mjs';
import { parseUrl, urlAbsolutize } from '../support.mjs';

/**
 * The app's only outbound door. Manual redirect following so every hop is
 * re-validated by the SSRF wall, a per-analysis request budget, and one cookie
 * jar shared across the whole extraction so session cookies survive the hops.
 *
 * Port of lib/Net/HttpClient.php onto node's core http(s) modules: curl is gone,
 * so each curl behaviour the app relies on is reproduced by hand and the
 * visitor-facing wording is kept identical.
 */

/** curl's own list, so a host that inspects it sees the same request as before. */
const ACCEPT_ENCODING = 'gzip, deflate, br';

export class HttpClient {
  /** @type {Array<{url:string,status:number,bytes:number}>} */
  trace = [];
  /** name => {name, value, domain}; the order is the order the jar file had. */
  #jar = new Map();
  #budget;
  #guard;

  /**
   * @param {number|null} budget the request limit this analysis may spend
   * @param {Function|null} guard test seam for the SSRF wall; production uses UrlGuard
   */
  constructor(budget = null, guard = null) {
    this.#budget = budget ?? Math.trunc(Number(cfg('extract.request_limit', 8)));
    this.#guard = guard ?? assertSafeAsync;
  }

  remaining() {
    return Math.max(0, this.#budget);
  }

  /** Every cookie the jar holds, in the order php's jar reader emitted them. */
  cookieHeader() {
    const out = [];
    for (const [name, entry] of this.#jar) {
      out.push(name + '=' + entry.value);
    }
    return out.join('; ');
  }

  get(url, opts = {}) {
    return this.request(url, opts);
  }

  post(url, body, opts = {}) {
    return this.request(url, { ...opts, body, method: 'POST' });
  }

  async request(url, opts = {}) {
    if (this.#budget <= 0) {
      throw new HttpException('That page needs too many requests to resolve a file.', 504, url);
    }

    let method = String(opts.method ?? 'GET').toUpperCase();
    const maxBytes = Math.trunc(Number(opts.max_bytes ?? cfg('http.page_max_bytes', 2000000)));
    const maxHops = Math.trunc(Number(opts.max_redirects ?? cfg('http.max_redirects', 5)));
    const headers = { ...(opts.headers ?? {}) };
    let current = url;
    let body = opts.body;
    let sendBody = opts.form === undefined ? body : undefined;

    for (let hop = 0; ; hop++) {
      await this.#guard(current);
      // Relay.php hands a finished bundle down from its own retry, so a caller that
      // already knows the missing issuer does not have to learn it from a failure.
      const res = await this.#doRequest(method, current, headers, opts, maxBytes, sendBody,
        opts.ca_bundle ?? null);
      this.#budget--;
      this.trace.push({ url: current, status: res.status, bytes: res.downloadedBytes });

      const location = res.header('location');
      if (res.status >= 300 && res.status < 400 && location !== null && hop < maxHops) {
        const next = urlAbsolutize(current, location);
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          sendBody = undefined;
          delete opts.body;
          delete opts.method;
        }
        headers.Referer = current;
        current = next;
        continue;
      }
      return res;
    }
  }

  /**
   * The browser-ish header set every outbound request carries. Some hosts answer
   * a request without Accept-Language with 403, so the relay must use this too.
   *
   * @returns {string[]} "Name: value" lines
   */
  static headerLines(extra = {}, accept = '') {
    const base = {
      'User-Agent': String(cfg('http.user_agent')),
      Accept: accept !== '' ? accept : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': String(cfg('http.accept_language', 'en-US,en;q=0.9')),
    };
    for (const [k, v] of Object.entries(extra)) {
      base[k] = v;
    }
    return Object.entries(base).map(([k, v]) => k + ': ' + v);
  }

  async #doRequest(method, url, headers, opts, maxBytes, payload, caBundle) {
    const parts = parseUrl(url);
    if (!parts || !parts.scheme) {
      throw new HttpException('That does not look like a link.', 0, url);
    }
    const isTls = parts.scheme === 'https';
    const port = parts.port ?? (isTls ? 443 : 80);
    const headerLines = HttpClient.headerLines(
      { ...headers, ...this.#cookieHeaderFor(String(parts.host).toLowerCase()), ...(opts.range ? { Range: opts.range } : {}) },
      String(opts.accept ?? ''),
    );

    let body = null;
    let contentType = null;
    if (opts.form !== undefined && opts.form !== null) {
      const boundary = '----VdForm' + Math.random().toString(36).slice(2, 14);
      body = multipartBody(opts.form, boundary);
      headerLines.push('Content-Type: multipart/form-data; boundary=' + boundary);
      contentType = 'multipart/form-data; boundary=' + boundary;
    } else if (payload !== undefined && payload !== null && payload !== '') {
      body = Buffer.from(String(payload), 'latin1');
      headerLines.push('Content-Length: ' + body.length);
    }
    headerLines.push('Accept-Encoding: ' + ACCEPT_ENCODING);
    if (headerLines.every((line) => !/^Host: /i.test(line))) {
      headerLines.push('Host: ' + (parts.port ? parts.host + ':' + parts.port : parts.host));
    }

    const toFile = opts.to_file ?? null;
    // A streamed reply belongs to one hop, not to the caller's whole redirect chain:
    // a 302 that carries a body must not have that body glued in front of the file.
    const pipe = opts.stream === true ? new PassThrough() : null;
    // A hop that fails before the caller takes over leaves this stream unread, and
    // node turns an unlistened 'error' into an uncaught exception. Real consumers
    // still get their own listener called; this one only keeps the process up.
    pipe?.on('error', () => {});
    const timeoutMs = Math.trunc(Number(opts.timeout ?? cfg('http.timeout', 20))) * 1000;
    const connectMs = Math.trunc(Number(cfg('http.connect_timeout', 8))) * 1000;

    let result;
    try {
      result = await exchange({
        transport: isTls ? https : http,
        method,
        hostname: bareHost(String(parts.host)),
        port,
        path: requestTarget(parts),
        headers: headerLines,
        body,
        // curl only installs its size-capping progress callback on the
        // return-transfer path; a file download runs uncapped and the caller
        // measures the finished file itself. A relayed stream is the same case,
        // and php set CURLOPT_TIMEOUT to 0 for it.
        maxBytes: toFile !== null || pipe !== null ? Number.POSITIVE_INFINITY : maxBytes,
        caBundle,
        servername: isTls ? bareHost(String(parts.host)) : undefined,
        connectMs,
        timeoutMs,
        sink: toFile,
        pipe,
      });
    } catch (err) {
      if (toFile !== null) {
        fs.rmSync(toFile, { force: true });
      }
      if (caBundle === null && isCertError(err)) {
        const bundle = await CertChain.bundleFor(bareHost(String(parts.host)));
        if (bundle !== null) {
          // A streamed retry gets a fresh hop stream, so the abandoned one is simply
          // never read; the raw error still travels out for Relay, which drives its
          // own second attempt with the bundle the way php did.
          return this.#doRequest(method, url, headers, opts, maxBytes, payload, bundle);
        }
      }
      throw Object.assign(new HttpException(curlMessage(err), 0, url), { causedBy: err });
    }

    this.#storeCookies(result.headers, bareHost(String(parts.host)));

    const responseHeaders = result.headers;
    if (result.truncated) {
      responseHeaders['x-vd-truncated'] = '1';
    }
    const raw = result.content;
    return new HttpResponse(
      result.status,
      toFile !== null || pipe !== null ? '' : raw.toString('latin1'),
      responseHeaders,
      result.contentType ?? '',
      url,
      pipe !== null ? 0 : (toFile !== null ? result.written : raw.length),
      pipe,
    );
  }

  #cookieHeaderFor(host) {
    const out = [];
    for (const entry of this.#jar.values()) {
      if (domainMatches(host, entry.domain)) {
        out.push(entry.name + '=' + entry.value);
      }
    }
    if (out.length === 0) {
      return {};
    }
    return { Cookie: out.join('; ') };
  }

  #storeCookies(headers, host) {
    const raw = headers['set-cookie'];
    if (!raw) {
      return;
    }
    const lines = Array.isArray(raw) ? raw : String(raw).split(/,(?=[^;]+?=)/);
    for (const line of lines) {
      const bits = String(line).split(';').map((s) => s.trim());
      const eq = bits[0].indexOf('=');
      if (eq < 1) {
        continue;
      }
      const name = bits[0].slice(0, eq);
      const value = bits[0].slice(eq + 1);
      let domain = host;
      let deleteAt = null;
      for (const attr of bits.slice(1)) {
        const [k, ...rest] = attr.split('=');
        const v = rest.join('=');
        if (/^domain$/i.test(k)) {
          domain = v.replace(/^\./, '').toLowerCase();
        } else if (/^expires$/i.test(k)) {
          const at = Date.parse(v);
          if (!Number.isNaN(at)) {
            deleteAt = Math.trunc(at / 1000);
          }
        } else if (/^max-age$/i.test(k)) {
          deleteAt = Math.floor(Date.now() / 1000) + Math.trunc(Number(v));
        }
      }
      if (deleteAt !== null && deleteAt < Math.floor(Date.now() / 1000)) {
        this.#jar.delete(name);
        continue;
      }
      // php's jar reader kept the last value written for a name; a re-write keeps
      // the original position, exactly like assigning an existing array key.
      this.#jar.set(name, { name, value, domain });
    }
  }
}

/** What curl actually puts on the wire: the path and query, not the whole url. */
function requestTarget(parts) {
  const path = parts.path ?? '';
  const query = parts.query !== undefined && parts.query !== null ? '?' + parts.query : '';
  const target = path === '' ? '/' : path;
  return target + query;
}

/** php's parse_url hands back user:pass@host; only the host may reach the jar. */
function bareHost(host) {
  const at = String(host).lastIndexOf('@');
  return (at === -1 ? String(host) : String(host).slice(at + 1)).toLowerCase();
}

function domainMatches(host, cookieDomain) {
  const domain = String(cookieDomain || host).toLowerCase();
  return host === domain || host.endsWith('.' + domain);
}

function multipartBody(fields, boundary) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n', 'latin1'));
    chunks.push(Buffer.from(String(value), 'latin1'));
    chunks.push(Buffer.from('\r\n', 'latin1'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n', 'latin1'));
  return Buffer.concat(chunks);
}

/**
 * One exchange, no automatic redirects, cancelled past maxBytes. Two deliberate
 * departures from curl: it measured the compressed wire bytes while this caps the
 * decoded body (the memory actually at stake), and where its abort callback threw
 * the whole body away this hands back the head of it, so a slightly oversized page
 * still yields a page.
 *
 * With o.pipe the body is neither capped nor held: each chunk goes straight into the
 * stream this hop owns and the promise settles as soon as the headers are in, which
 * is what the relay needs — php echoed every chunk from curl's write callback and
 * never kept the file in memory either.
 */
function exchange(o) {
  const maxBytes = Number(o.maxBytes);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const headers = {};
    let status = 0;
    let contentType = null;
    let written = 0;
    let truncated = false;
    let settled = false;
    let finished = false;
    let file = null;
    let body$ = null;
    /** bytes streamed after the promise settled, for the caller's own accounting */
    const counter = { bytes: 0 };
    const pipe = o.pipe ?? null;

    const done = (ok, arg) => {
      if (settled) {
        // A stream already handed to the caller can still die mid-file. The promise
        // settled with the headers, so the only way left to say so is to break the
        // pipe, which is what makes a truncated relay fail instead of look complete.
        if (!ok && pipe !== null && !pipe.writableEnded && !pipe.destroyed) {
          pipe.destroy(arg);
        }
        return;
      }
      settled = true;
      clearTimeout(hard);
      connect.stop();
      if (ok) {
        resolve(arg);
      } else {
        if (file !== null) {
          file.destroy();
        }
        reject(arg);
      }
    };

    const collect = (buf) => {
      if (pipe !== null) {
        written += buf.length;
        counter.bytes += buf.length;
        pipe.write(buf);
        return;
      }
      if (written + buf.length > maxBytes) {
        // curl's abort callback discards the whole body; keeping the head of it
        // is the same read limit with a usable page for an oversized one.
        truncated = true;
        const head = buf.subarray(0, Math.max(0, maxBytes - written));
        if (head.length > 0) {
          if (file !== null) {
            file.write(head);
          } else {
            chunks.push(head);
          }
        }
        written += head.length;
        body$.destroy();
        return;
      }
      written += buf.length;
      if (file !== null) {
        file.write(buf);
      } else {
        chunks.push(buf);
      }
    };

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (pipe !== null) {
        // every byte that arrived was handed on already; closing the pipe is the
        // whole of it, and the promise settled with the headers.
        pipe.end();
        return;
      }
      const deliver = () => done(true, {
        status,
        headers,
        contentType,
        content: Buffer.concat(chunks),
        written,
        truncated,
      });
      if (file !== null) {
        file.end(deliver);
      } else {
        deliver();
      }
    };

    const req = o.transport.request(
      {
        hostname: o.hostname,
        port: o.port,
        path: o.path,
        method: o.method,
        headers: headerObject(o.headers),
        servername: o.servername,
        ca: o.caBundle === null ? undefined : o.caBundle,
        rejectUnauthorized: true,
        setHost: false,
        agent: false,
      },
      (res) => {
        status = res.statusCode;
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) {
            continue;
          }
          // set-cookie stays a list: several cookies share the response, and php's
          // curl handed each one to the jar separately.
          headers[k.toLowerCase()] = Array.isArray(v) && k !== 'set-cookie' ? v.join(', ') : v;
        }
        contentType = typeof headers['content-type'] === 'string' ? headers['content-type'] : null;
        const encoding = typeof headers['content-encoding'] === 'string' ? headers['content-encoding'].toLowerCase().trim() : '';
        body$ = streamFor(res, encoding);
        if (body$ === null) {
          req.destroy();
          done(false, Object.assign(new Error('unknown content-encoding ' + encoding), { code: 'ENCODING' }));
          return;
        }
        if (o.sink) {
          file = fs.createWriteStream(o.sink);
          file.on('error', (e) => done(false, e));
        }
        body$.on('error', (e) => done(false, e));
        body$.on('data', collect);
        body$.on('close', finish);
        body$.on('end', () => {
          if (!truncated) {
            finish();
          }
        });
        if (pipe !== null) {
          done(true, {
            status,
            headers,
            contentType,
            content: Buffer.alloc(0),
            written: 0,
            truncated: false,
            counter,
          });
        }
      },
    );

    req.on('error', (e) => done(false, e));
    // curl splits a connect timeout from the whole-transfer timeout; node's socket
    // timeout is idle-only, so the connect phase gets its own timer.
    let connected = false;
    req.on('socket', (socket) => {
      socket.once('lookup', () => {
        if (!connected) {
          connect.stop();
          connect.start();
        }
      });
      socket.once('connect', () => {
        connected = true;
        connect.stop();
      });
      socket.once('secureConnect', () => {
        connected = true;
        connect.stop();
      });
    });
    const connect = timer(o.connectMs, () => {
      req.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }));
    });
    connect.start();
    const hard = setTimeout(() => {
      req.destroy(Object.assign(new Error('operation timeout'), { code: 'ETIMEDOUT' }));
    }, o.timeoutMs);

    req.end(o.body ?? undefined);
  });
}

function timer(ms, onExpire) {
  let handle = null;
  return {
    start() {
      handle = setTimeout(onExpire, ms);
    },
    stop() {
      if (handle !== null) {
        clearTimeout(handle);
        handle = null;
      }
    },
  };
}

/**
 * curl decoded by the advertised encoding, not by sniffing the bytes, so the
 * mapping is explicit: "deflate" means raw deflate here, the way hosts send it.
 */
function streamFor(res, encoding) {
  if (encoding === '' || encoding === 'identity') {
    return res;
  }
  if (encoding === 'br') {
    return res.pipe(zlib.createBrotliDecompress());
  }
  if (encoding === 'zstd') {
    return typeof zlib.createZstdDecompress === 'function' ? res.pipe(zlib.createZstdDecompress()) : null;
  }
  if (encoding === 'gzip' || encoding === 'x-gzip' || encoding === 'compress') {
    return res.pipe(zlib.createGunzip());
  }
  if (encoding === 'deflate') {
    return res.pipe(deflateTolerant());
  }
  return null;
}

/**
 * "deflate" is sent both raw and zlib-wrapped in the wild, and curl quietly tries
 * each, so the body is buffered and inflated the second way if the first fails.
 */
function deflateTolerant() {
  const parts = [];
  return new Transform({
    transform(chunk, _enc, cb) {
      parts.push(chunk);
      cb();
    },
    flush(cb) {
      const raw = Buffer.concat(parts);
      for (const tryOne of [zlib.inflateRawSync, zlib.inflateSync]) {
        try {
          cb(null, tryOne(raw));
          return;
        } catch {
          /* try the other spelling */
        }
      }
      cb(new Error('the body was not deflate'));
    },
  });
}

function headerObject(lines) {
  const out = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 1) {
      continue;
    }
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** errno values that mean "the chain did not build", not "the host is down". */
export function isCertError(err) {
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? '');
  return code.startsWith('CERT_')
    || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
    || code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || code === 'SELF_SIGNED_CERT'
    || code === 'INVALID_CA'
    || code === 'UNABLE_TO_GET_ISSUER_CERT'
    || code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
    || code === 'HOSTNAME_NOT_SET'
    || code === 'ERR_TLS_CERT_ALTNAME_INVALID'
    || /SSL|TLS|certificate/i.test(message);
}

function curlMessage(err) {
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo/i.test(message)) {
    return 'That web address does not resolve.';
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EPIPE') {
    return 'That site refused the connection.';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timed out|timeout/i.test(message)) {
    return 'That site took too long to answer.';
  }
  if (isCertError(err)) {
    return 'That site has a broken TLS certificate.';
  }
  return 'Could not reach that page' + (message !== '' ? ': ' + message : '.');
}
