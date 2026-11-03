/**
 * The request half of the port.
 *
 * index.php read php's superglobals, so this builds the same shapes from whatever the
 * platform hands over: $_SERVER (including the HTTP_* copies apache makes), $_GET and
 * $_POST. Every module that was ported from php keeps reading those names, which is
 * what keeps the entry layer a translation instead of a rewrite.
 */

/** @typedef {{
 *   method: string,
 *   server: Record<string,string>,
 *   query: Record<string,string>,
 *   post: Record<string,string>,
 *   headers: Record<string,string>,
 *   body: Buffer,
 *   host: string,
 *   https: boolean,
 *   path: string,
 * }} RequestContext */

/**
 * @param {{method?: string, url?: string, headers?: Iterable<[string,string]>|Record<string,string>,
 *   body?: Buffer|string|null, ip?: string, entry?: string}} input
 *   `url` is the absolute or root-relative url the visitor asked for; `entry` is the
 *   script name the platform runs this handler as, which apache put in SCRIPT_NAME and
 *   a netlify function reports as its own route.
 * @returns {RequestContext}
 */
export function buildContext(input = {}) {
  const method = String(input.method ?? 'GET').toUpperCase();
  const headers = lowerHeaders(input.headers ?? {});
  const url = new URL(String(input.url ?? '/'), 'https://placeholder.local');
  const host = headers.host || url.host || 'localhost';
  const forwardedProto = String(headers['x-forwarded-proto'] || '');
  const https = forwardedProto !== ''
    ? forwardedProto.split(',')[0].trim() === 'https'
    : url.protocol === 'https:';
  const search = url.search;

  const server = {
    REQUEST_METHOD: method,
    REQUEST_URI: url.pathname + search,
    PATH_INFO: '',
    QUERY_STRING: search.replace(/^\?/, ''),
    HTTPS: https ? 'on' : '',
    HTTP_HOST: host,
    REMOTE_ADDR: String(input.ip ?? ''),
    SCRIPT_NAME: String(input.entry ?? '/index.php'),
  };
  for (const [name, value] of Object.entries(headers)) {
    server['HTTP_' + name.replace(/-/g, '_').toUpperCase()] = value;
  }

  const query = parsePairs(search);
  const post = method === 'POST' ? parsePost(headers['content-type'] ?? '', input.body) : {};

  return { method, server, query, post, headers, body: toBuffer(input.body), host, https, path: url.pathname };
}

/** The first value php's $_GET would have dropped is the one apache kept: the last. */
function parsePairs(search) {
  const out = {};
  for (const piece of String(search ?? '').replace(/^\?/, '').split('&')) {
    if (piece === '') {
      continue;
    }
    const eq = piece.indexOf('=');
    const rawKey = eq < 0 ? piece : piece.slice(0, eq);
    const rawValue = eq < 0 ? '' : piece.slice(eq + 1);
    const key = expand(keyOf(rawKey), decode(rawValue));
    if (key === null) {
      continue;
    }
    out[key.name] = key.value;
  }
  return out;
}

function keyOf(rawKey) {
  return decode(rawKey);
}

/**
 * apache runs the request body through the same url-decoder, but only for the shapes
 * a form makes: urlencoded, and multipart for the fields this app reads. A json body
 * stays raw, because handle_analyze() reads php://input for it.
 */
function parsePost(contentType, body) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const text = toBuffer(body).toString('utf8');
  if (type === 'application/x-www-form-urlencoded') {
    return parsePairs(text === '' ? '' : '?' + text);
  }
  if (type === 'multipart/form-data') {
    return parseMultipart(text, String(contentType ?? ''));
  }
  return {};
}

function parseMultipart(text, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) {
    return {};
  }
  const boundary = '--' + (m[1] ?? m[2]).trim();
  const out = {};
  for (const part of text.split(boundary)) {
    const head = part.indexOf('\r\n\r\n');
    if (head < 0) {
      continue;
    }
    const name = /name="([^"]*)"/.exec(part.slice(0, head));
    if (name && name[1] !== '' && !name[1].includes('[')) {
      let value = part.slice(head + 4).replace(/\r\n$/, '');
      const charset = /charset="utf-8"/i.test(part.slice(0, head));
      if (!charset) {
        value = Buffer.from(value, 'latin1').toString('utf8');
      }
      out[name[1]] = value;
    }
  }
  return out;
}

/**
 * php's $_GET/$_POST key rules, trimmed to what this app uses: a trailing [] or
 * [anything] nests, and a bare name keeps a scalar. A key that would nest is refused
 * rather than guessed at, because nothing in this app sends one.
 */
function expand(name, value) {
  if (name.includes('[')) {
    return null;
  }
  return { name, value };
}

function decode(piece) {
  let out = '';
  const text = String(piece ?? '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '+') {
      out += ' ';
    } else if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      out += Buffer.from(text.slice(i + 1, i + 3), 'hex').toString('latin1');
      i += 2;
    } else {
      out += ch;
    }
  }
  // Percent-decoding produced latin1 bytes; a form sends utf-8, so reinterpret them.
  return Buffer.from(out, 'latin1').toString('utf8');
}

export function toBuffer(body) {
  if (body === null || body === undefined) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return Buffer.from(String(body), 'utf8');
}

function lowerHeaders(input) {
  const out = {};
  if (input instanceof Headers || typeof (input && input.forEach) === 'function') {
    input.forEach((value, name) => {
      out[String(name).toLowerCase()] = value;
    });
    return out;
  }
  for (const [name, value] of Object.entries(input)) {
    out[String(name).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return out;
}
