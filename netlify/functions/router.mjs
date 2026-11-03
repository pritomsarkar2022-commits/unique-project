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

export default async function router(request, context) {
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
    ip: context?.requestContext?.ip ?? '',
    entry: '/index.php',
  });

  return toResponse(await handle(ctx));
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
  };
  return names[status] ?? '';
}
