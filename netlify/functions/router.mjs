/**
 * The netlify entry point.
 *
 * Everything that decides what a visitor gets lives in site/src/http/router.mjs and
 * knows nothing about this platform; this file only translates a Request into the
 * php-shaped context the port reads, and a built response back into what the runtime
 * delivers. It is the one file here that has no php ancestor.
 */

import { Readable } from 'node:stream';

import { buildContext } from '../../site/src/http/request.mjs';
import { handle } from '../../site/src/http/router.mjs';
import { adoptBlobsContext } from '../../site/src/storage/kv.mjs';

// Nothing but a Netlify deploy imports this file, and the storage layer asks the
// environment which platform it is on. The runtime's own NETLIFY flag is documented for
// the build, not for an invoke, so a deploy that should have used Blobs answered that it
// was on a plain filesystem and fell back to a directory it cannot write.
process.env.NETLIFY = process.env.NETLIFY ?? '1';

export default async function router(request, context) {
  // The store credentials a function gets can ride on the event rather than the
  // environment, and the blobs client only looks at the event when it is told to.
  await adoptBlobsContext(context);

  const incoming = new URL(request.url);
  const method = String(request.method ?? 'GET').toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? null : Buffer.from(await request.arrayBuffer());

  // A proxy rewrite leaves the original path on the event rather than on the url the
  // function is addressed by, and index.php routed partly from that path.
  const eventPath = context?.event?.path;
  const path = typeof eventPath === 'string' && eventPath !== '' && eventPath !== incoming.pathname
    ? eventPath
    : incoming.pathname;

  const ctx = buildContext({
    method,
    url: path + incoming.search,
    headers: request.headers,
    body,
    ip: clientIp(request, context),
    entry: '/index.php',
  });

  return toResponse(await handle(ctx));
}

/**
 * The key the rate limiter buckets a visitor under. Netlify has moved this between
 * `context.ip` and `context.requestContext.ip` across runtimes, but the edge always
 * sets the header, so the header leads and the two context shapes follow. An empty
 * answer would put every visitor into one shared bucket, so it is never worth
 * guessing at: a throttle that fires for nobody is better than one that fires for
 * everyone.
 */
function clientIp(request, context) {
  const fromHeader = request.headers.get('x-nf-client-connection-ip');
  if (typeof fromHeader === 'string' && fromHeader !== '') {
    return fromHeader;
  }
  const fromContext = context?.ip ?? context?.requestContext?.ip;
  if (typeof fromContext === 'string' && fromContext !== '') {
    return fromContext;
  }
  const forwarded = request.headers.get('x-forwarded-for');
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return first;
}

function toResponse(res) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    // A length computed by the port is the truth about the bytes it hands over, so it
    // goes out; the runtime may re-chunk it for a stream and that is the platform's
    // business, not a difference the visitor can see.
    headers.append(name, String(value));
  }
  const init = { status: res.status, statusText: statusText(res.status), headers };
  if (res.stream !== null && res.stream !== undefined) {
    return new Response(Readable.toWeb(res.stream), init);
  }
  if (res.body === null || res.body === undefined) {
    return new Response(null, init);
  }
  return new Response(res.body, init);
}

/**
 * Netlify answers 200 for a function that returns no status text, and the reason a
 * 410 or a 422 is worth showing is the body, not the phrase. This keeps the status line
 * readable for a human opening the link in a tab.
 */
function statusText(status) {
  const names = {
    206: 'Partial Content',
    400: 'Bad Request',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    410: 'Gone',
    413: 'Content Too Large',
    416: 'Range Not Satisfiable',
    422: 'Unprocessable Content',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return names[status] ?? '';
}
