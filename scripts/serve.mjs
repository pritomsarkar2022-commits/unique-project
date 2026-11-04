/**
 * A local stand-in for the netlify platform, for running the port before it is pushed.
 *
 * It mirrors netlify.toml exactly: the same paths go to the same router, the rest comes
 * out of site/public with the same cache headers. Where netlify hands a function a
 * Request, node http hands this a req, and both end in the same handle() call, so a
 * route that works here has no platform-specific code left to fail on.
 *
 *   node scripts/serve.mjs [port]
 *
 * Storage defaults to the filesystem driver under site/storage, which is what a netlify
 * dev sandbox does with its own blob layer; set VD_KV_DRIVER=blobs to point at a real
 * site instead.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildContext } from '../site/src/http/request.mjs';
import { handle } from '../site/src/http/router.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const publicDir = path.join(root, 'site', 'public');
const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
};

/** The five rules in netlify.toml that point at the function. */
function isFunctionPath(pathname) {
  return pathname === '/index.php'
    || /^\/api\/[a-z]+$/i.test(pathname)
    || pathname === '/health'
    || pathname === '/relay'
    || pathname === '/sitemap.xml';
}

function security(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
}

function serveStatic(res, pathname) {
  const wanted = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(publicDir, path.normalize(wanted).replace(/^([/\\])+/, ''));
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // The catch-all in netlify.toml: an unknown url is the home page, because that is
    // what the apache rewrite did when nothing else matched.
    const home = path.join(publicDir, 'index.html');
    if (!fs.existsSync(home)) {
      security(res);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('site/public is not built; run node scripts/generate-static.mjs');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'public, max-age=0, must-revalidate' });
    fs.createReadStream(home).pipe(res);
    return;
  }
  security(res);
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const cache = file.startsWith(path.join(publicDir, 'assets'))
    ? 'public, max-age=2592000'
    : 'public, max-age=0, must-revalidate';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost:' + port);
  security(res);
  if (!isFunctionPath(url.pathname)) {
    serveStatic(res, url.pathname);
    return;
  }

  const chunks = [];
  req.on('data', (piece) => chunks.push(piece));
  req.on('end', async () => {
    try {
      const ctx = buildContext({
        method: req.method ?? 'GET',
        // The absolute url, so the scheme this connection really used decides whether
        // the links the page gets back say http or https, the way apache's HTTPS flag
        // did. Netlify says it with x-forwarded-proto instead.
        url: url.href,
        headers: req.headers,
        body: Buffer.concat(chunks),
        ip: req.socket.remoteAddress ?? '127.0.0.1',
        entry: '/index.php',
      });
      const out = await handle(ctx);
      const headers = { ...out.headers };
      if (out.stream !== null && out.stream !== undefined) {
        res.writeHead(out.status, headers);
        out.stream.pipe(res);
        out.stream.on('error', () => res.destroy());
        return;
      }
      res.writeHead(out.status, headers);
      res.end(out.body === null || out.body === undefined ? '' : out.body);
    } catch (err) {
      console.error('serve: uncaught', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });
});

server.listen(port, () => {
  console.log('serve: http://localhost:' + port + '  (router on ' + '/index.php?r=...' + ')');
});
