/**
 * Port of index.php: the front controller.
 *
 * The php file read php's superglobals, wrote with header()/echo and exited wherever a
 * response was finished. This is the same switch statement, in the same order, with the
 * same routes and the same failure cascade, returning a response object instead. The
 * only structural difference is that every route is async, because outbound http and
 * storage are promises on this platform.
 */

import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { cfg } from '../config.mjs';
import { VD_VERSION, baseHref, e, linkOpen, phpTrim, setRequestHost, siteUrl } from '../support.mjs';
import { BuildStore } from '../build/buildStore.mjs';
import { Mp4Builder } from '../build/buildRunner.mjs';
import { ExtractException, HttpException } from '../errors.mjs';
import { Analyzer } from '../extractor/analyzer.mjs';
import { ExtractorRegistry } from '../extractor/extractorRegistry.mjs';
import { JobStore } from '../job/jobStore.mjs';
import { HttpClient } from '../net/httpClient.mjs';
import { relayRun } from '../net/relayRun.mjs';
import { Throttle } from '../net/throttle.mjs';
import { openKv, storageFault, StorageUnavailable } from '../storage/kv.mjs';
import { UrlGuardException } from '../net/urlGuard.mjs';
import { renderError } from '../views/error.mjs';
import { renderHome } from '../views/home.mjs';
import { ASSET_VER, robotsTpl } from '../views/pages.gen.mjs';
import { VdResponse, applySecurityHeaders, htmlOut, jsonOut, textOut } from './respond.mjs';

/** The php log sink is a file on the host's disk; a function writes to its own log. */
function vdLog(message, context = {}) {
  if (cfg('logging.enabled', true) === false) {
    return;
  }
  console.log(message + (Object.keys(context).length ? ' ' + JSON.stringify(context) : ''));
}

/**
 * How long an analyze may take before this router answers for it: the clamp lives with
 * the route. Netlify cuts a synchronous function off at 30s, and the visitor then reads
 * the platform's own 502 page instead of anything this app wrote, so the deadline stays a
 * few seconds short of it and the answer stays a sentence in the visitor's language.
 * `extract.analyze_budget_ms` moves it; nothing raises it past the platform.
 */

/**
 * @param {{method:string, server:object, query:object, post:object, headers:object,
 *   body:Buffer, host:string, https:boolean, path:string}} ctx from buildContext()
 * @returns {Promise<VdResponse>}
 */
export async function handle(ctx, deps = {}) {
  // php's superglobals, for the helpers that build urls without being told the host.
  setRequestHost(ctx.host, ctx.https, ctx.server.SCRIPT_NAME);

  // Pretty urls (/api/analyze) and query urls (?r=analyze) both work, so the app runs
  // on a host with or without mod_rewrite.
  const query = ctx.query ?? {};
  let route = phpTrim(String(query.r ?? (ctx.server.PATH_INFO ?? '')), '/');
  if (route === '') {
    const m = /^\/(api|health)\/([a-z]+)/i.exec(String(ctx.server.REQUEST_URI ?? ''));
    if (m !== null) {
      route = m[2].toLowerCase();
    }
  }
  if (route === '') {
    const path = String(ctx.path ?? '').split('?')[0];
    if (/^\/robots\.txt$/i.test(path)) {
      route = 'robots';
    } else if (/^\/sitemap\.xml$/i.test(path)) {
      route = 'sitemap';
    } else if (/^\/(health|relay)\/?$/i.test(path)) {
      // The two bare paths netlify.toml proxies here. php only ever had them behind
      // the script as index.php/health, which is the PATH_INFO route above; a platform
      // that hands over the path itself still has to answer the same switch.
      route = path.slice(1).replace(/\/$/, '').toLowerCase();
    }
  }

  try {
    let res;
    switch (route) {
      case 'analyze':
        res = await handleAnalyze(ctx, deps);
        break;
      case 'build':
        res = await handleBuild(ctx, deps);
        break;
      case 'progress':
        res = await handleProgress(ctx, deps);
        break;
      case 'file':
        res = await handleFile(ctx, deps);
        break;
      case 'relay':
        res = await handleRelay(ctx, deps);
        break;
      case 'health':
        res = await handleHealth(deps);
        break;
      case 'robots':
        res = handleRobots();
        break;
      case 'sitemap':
        res = handleSitemap();
        break;
      case '':
      case 'index':
        res = await handlePage();
        break;
      default: {
        const notFound = htmlOut(renderError({ notFound: true, assetVer: ASSET_VER, baseHref: baseHref() }), 404);
        return applySecurityHeaders(notFound);
      }
    }
    return applySecurityHeaders(res);
  } catch (err) {
    return applySecurityHeaders(failure(route, err));
  }
}

/** The catch cascade of index.php, in the same order, with the same bodies. */
function failure(route, err) {
  if (err instanceof ExtractException) {
    return jsonOut({ ok: false, error: err.message, hint: err.hint, code: err.codeName }, 422);
  }
  if (err instanceof UrlGuardException) {
    // The ssrf guard already speaks in visitor terms, and a refused address is a bad
    // link, not our failure, so it must not land in the generic 500 below.
    return jsonOut({
      ok: false,
      error: err.message,
      hint: 'Paste the link of a video page on a public site.',
      code: 'bad_url',
    }, 422);
  }
  if (err instanceof HttpException) {
    vdLog('http failure', { url: err.url, status: err.status, msg: err.message });
    return jsonOut({
      ok: false,
      error: err.message,
      hint: 'The video host is blocking our server or is down. A minute of waiting usually fixes it.',
      code: 'network',
    }, 502);
  }
  if (err instanceof StorageUnavailable) {
    // The one failure that is the deployment's, not the visitor's: say which store is
    // missing instead of letting an EROFS look like a broken video page.
    vdLog('storage unavailable', { msg: err.message });
    return jsonOut({
      ok: false,
      error: 'This site cannot store a request yet.',
      hint: 'The video host needs a durable store to remember your link. On Netlify that is Blobs - '
        + 'see the storage step in README.md.',
      code: 'storage',
    }, 503);
  }
  vdLog('unhandled', { msg: err && err.message, stack: err && err.stack });
  if (/^(api|analyze|relay|build|progress|file|health|json)/.test(route)) {
    return jsonOut({ ok: false, error: 'Something went wrong on our side.', code: 'server' }, 500);
  }
  const fatal = cfg('app.debug', false)
    ? String(err && err.message ? err.message : err) + ' at ' + fatalAt(err)
    : '';
  return htmlOut(renderError({ fatal, assetVer: ASSET_VER, baseHref: baseHref() }), 500);
}

function fatalAt(err) {
  const line = err && err.stack ? String(err.stack).split('\n').find((l) => /\.(mjs|js|php)/.test(l)) : '';
  return line ? line.trim().replace(/^\s*at\s*/, '') : 'unknown';
}

async function handlePage() {
  const registry = new ExtractorRegistry();
  const hosts = await registry.knownHosts();
  return htmlOut(renderHome({
    hosts,
    siteUrl: siteUrl(''),
    baseHref: baseHref(),
    year: new Date().getFullYear(),
    assetVer: ASSET_VER,
  }));
}

async function handleAnalyze(ctx, deps) {
  if (ctx.method !== 'POST') {
    return jsonOut({ ok: false, error: 'Use POST.' }, 405);
  }
  const limit = new Throttle();
  const verdict = await limit.hit(Throttle.clientKey(ctx.server, ctx.headers) + '|api', 20, 60);
  if (verdict.allowed !== true) {
    return jsonOut({
      ok: false,
      error: 'Too many links at once.',
      hint: 'Wait ' + verdict.retryAfter + ' seconds and try again.',
      code: 'rate_limited',
      retryAfter: verdict.retryAfter,
    }, 429);
  }

  let raw = ctx.post.url ?? null;
  if (raw === null || raw === undefined) {
    let decoded = null;
    try {
      decoded = JSON.parse(ctx.body.toString('utf8'));
    } catch {
      decoded = null;
    }
    raw = decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded) ? (decoded.url ?? null) : null;
  }
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 2000) {
    return jsonOut({ ok: false, error: 'Paste a video page link.', code: 'empty' }, 422);
  }

  const budget = Math.max(200, Math.min(26000, Number(deps.analyzeBudgetMs ?? cfg('extract.analyze_budget_ms', 26000)) || 26000));
  const run = deps.analyze ?? ((raw, d) => Analyzer.analyze(raw, d));
  const within = await withinBudget(run(raw, deps.analyzer ?? {}), budget);
  if (within === null) {
    // Answering first is the whole point: the platform's own 502 page is what a dead
    // link looks like otherwise, and a visitor cannot act on it.
    vdLog('analyze out of budget', { host: hostOf(raw) });
    return jsonOut({
      ok: false,
      error: 'That host is still thinking.',
      hint: 'It took longer than this site is allowed to wait. Run the link again, or paste the '
        + '.m3u8 or file address of the video into Stream address - that save runs on your device '
        + 'and never asks this host for permission.',
      code: 'slow',
    }, 504);
  }
  return jsonOut({ ok: true, ...within });
}

/**
 * A promise's value, or null once ms has passed.
 *
 * The timer is cleared either way: a function instance left holding an open timer is one
 * the platform will not freeze. Nothing rejects on the losing branch, so a host that
 * answers late cannot surface as an unhandled rejection after the answer is already sent.
 */
async function withinBudget(promise, ms) {
  const settled = Promise.resolve(promise).then(
    (value) => ({ done: true, value }),
    (error) => ({ done: true, error })
  );
  let timer = null;
  const gate = new Promise((resolve) => { timer = setTimeout(() => resolve({ done: false }), ms); });
  let first = null;
  try {
    first = await Promise.race([settled, gate]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
  if (first.done !== true) {
    return null;
  }
  if (first.error !== undefined) {
    throw first.error;
  }
  return first.value;
}

function hostOf(raw) {
  try {
    return new URL(raw).host;
  } catch {
    return 'unknown';
  }
}

/**
 * Start an HLS -> MP4 build. The work itself happens in small slices, one per request,
 * so a long stream survives a platform cutting an invocation off.
 */
async function handleBuild(ctx, deps) {
  if (ctx.method !== 'POST') {
    return jsonOut({ ok: false, error: 'Use POST.' }, 405);
  }
  const limit = new Throttle();
  const verdict = await limit.hit(Throttle.clientKey(ctx.server, ctx.headers) + '|build', 6, 60);
  if (verdict.allowed !== true) {
    return jsonOut({
      ok: false,
      error: 'Too many saves at once.',
      hint: 'Wait ' + verdict.retryAfter + ' seconds and try again.',
      code: 'rate_limited',
    }, 429);
  }

  const jobs = deps.jobs ?? new JobStore();
  const record = await jobs.find(String(ctx.post.job ?? ''));
  if (record === null) {
    return jsonOut({
      ok: false,
      error: 'That analysis expired.',
      hint: 'Run the video page again.',
      code: 'job_expired',
    }, 410);
  }
  const source = jobs.source(record, String(ctx.post.src ?? ''));
  if (source === null) {
    return jsonOut({ ok: false, error: 'Unknown file in that result.', code: 'bad_source' }, 422);
  }

  const store = deps.builds ?? new BuildStore();
  const http = deps.http ?? new HttpClient(Math.trunc(Number(cfg('build.request_limit', 900))));
  let build = await Mp4Builder.begin(record, source, http, store);
  build = await Mp4Builder.tick(build, store, http);
  return jsonOut({ ok: true, build: build.id, ...(await Mp4Builder.progress(build, store)) });
}

async function handleProgress(ctx, deps) {
  const store = deps.builds ?? new BuildStore();
  let record = await store.find(String(ctx.query.build ?? ''));
  if (record === null) {
    return jsonOut({
      ok: false,
      done: true,
      error: 'This save expired before it finished.',
      hint: 'Run the video page again.',
      code: 'build_expired',
    }, 410);
  }
  // php built no shared client here either: every poll starts its own slice with its
  // own outbound budget, which is what keeps one slow segment from spending the rest.
  record = await Mp4Builder.tick(record, store);
  return jsonOut(await Mp4Builder.progress(record, store));
}

/**
 * Hand out the finished MP4. Only a build this server created and signed can be read,
 * and only by its signature, so this is never an open file download.
 *
 * php read the file with fopen()/fseek(); this reads one span out of storage, which is
 * also what lets a player or a saver take a large file in pieces when the platform
 * caps what a single response may carry.
 */
async function handleFile(ctx, deps) {
  const store = deps.builds ?? new BuildStore();
  const record = await store.find(String(ctx.query.build ?? ''));
  if (record === null || !store.verify(record, String(ctx.query.s ?? ''))) {
    return textOut('This download expired. Run the video page again.', 410);
  }
  if (String(record.status ?? '') !== 'done') {
    return textOut('That file is not ready yet.', 409);
  }

  const size = await outputSize(store, record);
  if (size === null) {
    return textOut('That file is not ready yet.', 409);
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(String(ctx.server.HTTP_RANGE ?? '').trim());
  const wanted = range !== null && (range[1] !== '' || range[2] !== '')
    ? spanFromRange(range[1], range[2], size)
    : null;
  if (wanted !== null && wanted === false) {
    const out = textOut('', 416);
    out.header('Content-Range', 'bytes */' + size);
    return out;
  }

  const start = wanted === null ? 0 : wanted.start;
  const end = wanted === null ? size - 1 : wanted.end;
  const cap = Math.trunc(Number(cfg('limits.function_stream_bytes', 18874368)));
  if (wanted === null && size > cap) {
    // The whole file is bigger than one response may carry, and this request did not
    // ask for a piece of it. Say so instead of handing back half a movie.
    const out = textOut('This file is too large for one response from this host ('
      + Math.ceil(size / 1048576) + ' MB). Play it in the page, or save it from there in pieces.', 413);
    out.header('Accept-Ranges', 'bytes');
    out.header('X-File-Size', String(size));
    return out;
  }
  const piece = await store.readRange(String(record.id), start, end);
  if (piece === null) {
    return textOut('That file is not ready yet.', 409);
  }

  const out = new VdResponse(wanted === null ? 200 : 206);
  // A function may hold a response under about six megabytes in memory and hand a much
  // larger one over as a stream. The bytes are the same either way, but a buffered
  // answer over the ceiling is refused by the platform, so the big ones stream.
  const bufferCap = Math.trunc(Number(cfg('limits.function_buffer_bytes', 6291456)));
  if (bufferCap > 0 && piece.data.length > bufferCap) {
    out.stream = Readable.from(piece.data);
  } else {
    out.body = piece.data;
  }
  out.header('Content-Type', 'video/mp4');
  out.header('Accept-Ranges', 'bytes');
  out.header('Content-Length', String(piece.data.length));
  out.header('Cache-Control', 'private, no-store');
  if (wanted !== null) {
    out.header('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
  }
  // The name comes from the stored record, never from the query string, so a crafted
  // header value cannot ride along with it.
  out.header('Content-Disposition', (String(ctx.query.play ?? '') === '1' ? 'inline' : 'attachment')
    + '; filename="' + record.filename + '"');
  return out;
}

/** php's range arithmetic: an open edge takes the tail or the rest, and never the moon. */
function spanFromRange(rawStart, rawEnd, size) {
  let start = 0;
  let end = size - 1;
  if (rawStart === '') {
    start = Math.max(0, size - Math.trunc(Number(rawEnd)));
  } else {
    start = Math.min(Math.trunc(Number(rawStart)), size - 1);
    if (rawEnd !== '') {
      end = Math.min(Math.trunc(Number(rawEnd)), size - 1);
    }
  }
  return start > end ? false : { start, end };
}

async function outputSize(store, record) {
  const piece = await store.readRange(String(record.id), 0, 0);
  return piece === null ? null : piece.total;
}

async function handleRelay(ctx, deps) {
  const job = String(ctx.query.job ?? '');
  const enc = String(ctx.query.u ?? '');
  const sig = String(ctx.query.s ?? '');
  const store = deps.jobs ?? new JobStore();
  const record = await store.find(job);
  if (record === null) {
    return textOut('This link expired. Go back and analyse the video page again.', 410);
  }
  const url = linkOpen(enc, String(record.secret ?? ''));
  if (url === null || Buffer.byteLength(url, 'utf8') > 4000 || !/^https?:\/\//i.test(url)) {
    return textOut('Bad media reference.', 400);
  }
  return relayRun(store, record, url, sig, {
    download: String(ctx.query.dl ?? '') === '1',
    filename: String(ctx.query.name ?? ''),
    isPlaylist: String(ctx.query.p ?? '') === '1',
    range: String(ctx.server.HTTP_RANGE ?? ''),
    http: deps.http ?? null,
    resolve: deps.resolve,
  });
}

function handleRobots() {
  const out = new VdResponse(200, {}, robotsTpl.split('{{SITE_URL}}').join(siteUrl('')));
  out.header('Content-Type', 'text/plain; charset=utf-8');
  out.header('Cache-Control', 'public, max-age=86400');
  return out;
}

function handleSitemap() {
  // The whole product is one page, so the sitemap is one real url rather than a list of
  // anchors that would only dilute the crawl budget.
  const home = siteUrl('/');
  // date('c') under the app's utc timezone, offset and all.
  const today = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const out = new VdResponse(200, {}, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    '    <loc>' + e(home) + '</loc>',
    '    <lastmod>' + today + '</lastmod>',
    '    <changefreq>monthly</changefreq>',
    '  </url>',
    '</urlset>',
    '',
  ].join('\n'));
  out.header('Content-Type', 'application/xml; charset=utf-8');
  out.header('Cache-Control', 'public, max-age=3600');
  return out;
}

/**
 * The operator's page. php probed its own extensions and its scratch directory; a
 * function has different things to get wrong, so the same questions are asked of this
 * runtime: can it seal a link, can it write to the store it was configured with, and
 * can it reach a file host at all.
 */
async function handleHealth(deps = {}) {
  let storage = 'unwritable';
  let driver = 'unknown';
  try {
    const kv = await openKv('health');
    driver = kv.driver ?? 'unknown';
    const probe = 'probe-' + Math.random().toString(36).slice(2, 10);
    await kv.put(probe, 'ok');
    const back = await kv.get(probe);
    await kv.del(probe);
    storage = back !== null && back.toString('utf8') === 'ok' ? 'writable' : 'unwritable';
  } catch (err) {
    vdLog('health storage probe failed', { msg: err && err.message });
  }

  // The two things that silently break a deploy: a store the platform will not hand
  // out, and an extractor list a bundler emptied. Both answers are worth more in the
  // response than in the log, because the log is only read after someone is upset.
  const faults = storageFault();
  let extractors = -1;
  let hosts = -1;
  try {
    const registry = await ExtractorRegistry.create();
    extractors = registry.extractors.length;
    hosts = Object.keys(await registry.knownHosts()).length;
    if (registry.missingModules.length > 0) {
      vdLog('extractor modules missing', { list: registry.missingModules.join(',') });
    }
  } catch (err) {
    vdLog('extractor registry failed', { msg: err && err.message });
  }

  let outbound = 'unchecked';
  try {
    const res = await (deps.http ?? new HttpClient(1)).get('https://example.com/', { max_bytes: 4096, timeout: 8 });
    outbound = res.status >= 200 && res.status < 500 ? 'ok' : 'blocked';
  } catch (err) {
    outbound = 'blocked: ' + (err && err.message ? err.message : String(err));
  }

  return jsonOut({
    ok: true,
    app: 'video-downloader',
    version: VD_VERSION,
    node: process.version,
    aes: hasAes(),
    storage_driver: driver,
    storage_writable: storage === 'writable',
    storage_reason: faults === null ? null : faults,
    extractors,
    hosts,
    outbound,
  });
}

/** The one crypto question the app can actually fail: can a relay link be opened. */
function hasAes() {
  try {
    crypto.createDecipheriv('aes-256-cbc', Buffer.alloc(32), Buffer.alloc(16));
    return true;
  } catch {
    return false;
  }
}

// spanFromRange is index.php's range arithmetic, kept reachable for site/tests/router.test.mjs.
export const __testing = { spanFromRange };
