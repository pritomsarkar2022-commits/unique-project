/**
 * The response half of the port.
 *
 * index.php answered with http_response_code(), header() and echo. A function answers
 * with one object, so every route builds this and the adapters (netlify's Request/
 * Response and the local node server) turn it into what their platform wants. A
 * header name is therefore only ever assigned once: php's header() replaced an earlier
 * value with the same name, and these setters do the same by keying on the lower-cased
 * name.
 */

export class VdResponse {
  /**
   * @param {number} status
   * @param {Record<string,string>} headers
   * @param {string|Buffer|null} body
   * @param {import('node:stream').Readable|null} [stream] a file the relay hands over
   *   without holding it, which is the only way a 300 MB video fits in a function
   */
  constructor(status = 200, headers = {}, body = null, stream = null) {
    this.status = status;
    this.headers = Object.create(null);
    this.body = body;
    this.stream = stream;
    for (const [name, value] of Object.entries(headers)) {
      this.header(name, value);
    }
  }

  header(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
    return this;
  }

  getHeader(name) {
    return this.headers[String(name).toLowerCase()];
  }
}

/** json_out() from lib/support.php. */
export function jsonOut(data, status = 200, headers = {}) {
  const res = new VdResponse(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.body = JSON.stringify(data === undefined ? null : data);
  for (const [name, value] of Object.entries(headers)) {
    res.header(name, value);
  }
  return res;
}

/** The plain text the byte routes answer with when they refuse. */
export function textOut(body, status = 200) {
  return new VdResponse(status, { 'Content-Type': 'text/plain' }, body);
}

export function htmlOut(body, status = 200) {
  return new VdResponse(status, { 'Content-Type': 'text/html; charset=utf-8' }, body);
}

/**
 * The four headers index.php put on every response, before the route ran. A route that
 * names one of them again (the relay sets its own Referrer-Policy) overwrites it, the
 * way a second header() call did in php.
 */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

export function applySecurityHeaders(res) {
  const base = Object.create(null);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    base[name.toLowerCase()] = value;
  }
  res.headers = Object.assign(base, res.headers);
  return res;
}
