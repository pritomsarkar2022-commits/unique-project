import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { config } from '../src/config.mjs';
import { BuildStore } from '../src/build/buildStore.mjs';
import { MediaBundle } from '../src/extractor/mediaBundle.mjs';
import { Source } from '../src/extractor/source.mjs';
import { buildContext } from '../src/http/request.mjs';
import { handle, __testing as routerTesting } from '../src/http/router.mjs';
import { HttpException } from '../src/errors.mjs';
import { UrlGuardException } from '../src/net/urlGuard.mjs';
import { HttpResponse } from '../src/net/httpResponse.mjs';
import { JobStore } from '../src/job/jobStore.mjs';
import { linkOpen, linkSeal } from '../src/support.mjs';
import { openKv } from '../src/storage/kv.mjs';

/**
 * Tests for the entry layer: the front controller's routes, the response it builds for
 * each of them, and the byte rules the netlify platform forced onto the relay.
 *
 * Nothing here reaches the network. Every outbound call goes through a stubbed http
 * object and every ssrf decision through a stubbed resolver, so the relay's size rules
 * and the wall's refusals are both assertable on a machine with no dns.
 */

// openKv() resolves its root per call, so this catches the stores and the throttle the
// router constructs for itself, and keeps the repo's storage/ directory out of it.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-router-'));
process.env.VD_STORE = 'fs';
process.env.VD_STORAGE_DIR = ROOT;
// Several cases below drive the failure cascade on purpose, and its log line is the
// php error_log write; here it would only bury the test report.
config.logging.enabled = false;

let counter = 0;
let ipCounter = 0;
function tempRoot() {
  const dir = path.join(ROOT, 'n' + ++counter);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A different address per test: the throttle buckets by ip and the router's own
 *  Throttle instance is not injected, so this is what keeps the windows apart. */
function nextIp() {
  return '203.0.113.' + (10 + ++ipCounter);
}

function jobStore() {
  const root = tempRoot();
  return new JobStore({
    kv: openKv('jobs', { driver: 'fs', root }),
    files: openKv('files', { driver: 'fs', root }),
    random: () => 0.99,
  });
}

function buildStore(appUrlBase = 'https://grably.test/index.php?') {
  const root = tempRoot();
  return new BuildStore({
    kv: openKv('builds', { driver: 'fs', root }),
    files: openKv('files', { driver: 'fs', root }),
    now: () => 5000,
    random: () => 0.99,
    appUrl: (q) => appUrlBase + q,
  });
}

function bundle(url = 'https://cdn.cloudfam.io/f/abc123.mp4?token=xyz') {
  const b = new MediaBundle();
  b.provider = 'cloudfam';
  b.title = 'Big Buck Bunny 4K';
  b.thumbnail = 'https://cdn.cloudfam.io/t/01.png';
  b.pageUrl = 'https://cloudfam.io/v/abc123';
  b.finalUrl = 'https://cloudfam.io/v/abc123';
  b.confidence = 0.8;
  const s = Source.make(url, Source.MP4);
  s.label = 'MP4 file';
  s.height = 2160;
  s.mime = 'video/mp4';
  s.headers = { Referer: 'https://cloudfam.io/v/abc123' };
  b.addSource(s);
  return b;
}

/** The job record plus the signed relay link the browser would have been given. */
async function relayQuery(store, url, opts = {}) {
  const record = await store.create(bundle(url));
  const sealed = linkSeal(url, String(record.secret));
  const sig = store.sign(record, url);
  const params = new URLSearchParams({ r: 'relay', job: record.id, u: sealed, s: sig });
  for (const [k, v] of Object.entries(opts)) {
    params.set(k, v);
  }
  return { record, query: params.toString() };
}

function stubHttp(handler) {
  const calls = [];
  return {
    calls,
    async get(url, opts) {
      calls.push({ url, opts });
      return handler(url, opts, calls.length - 1);
    },
    async request(url, opts) {
      return this.get(url, opts);
    },
  };
}

function res(status, body, headers = {}, finalUrl = null, stream = null) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[String(k).toLowerCase()] = String(v);
  }
  return new HttpResponse(status, body, lower, lower['content-type'] ?? '', finalUrl ?? '', 0, stream);
}

async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function get(route, extra = {}) {
  return buildContext({
    method: extra.method ?? 'GET',
    url: 'https://grably.test' + route,
    headers: { host: 'grably.test', ...(extra.headers ?? {}) },
    body: extra.body ?? null,
    ip: extra.ip ?? nextIp(),
    entry: '/index.php',
  });
}

function post(route, form, extra = {}) {
  const body = new URLSearchParams(form).toString();
  return get(route, {
    ...extra,
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(extra.headers ?? {}) },
  });
}

/* ------------------------------------------------------------------ routing */

test('the front controller answers the routes it always answered', async () => {
  const robots = await handle(get('/robots.txt'));
  assert.equal(robots.status, 200);
  assert.equal(robots.getHeader('content-type'), 'text/plain; charset=utf-8');
  assert.equal(robots.body, 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /health\nSitemap: https://grably.test/sitemap.xml\n');

  const sitemap = await handle(get('/sitemap.xml'));
  assert.equal(sitemap.status, 200);
  assert.equal(sitemap.getHeader('content-type'), 'application/xml; charset=utf-8');
  assert.match(sitemap.body, /<loc>https:\/\/grably\.test\/<\/loc>/);
  assert.match(sitemap.body, /<lastmod>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00<\/lastmod>/,
    "date('c') under the app's UTC timezone");

  const home = await handle(get('/'));
  assert.equal(home.status, 200);
  assert.match(home.getHeader('content-type'), /^text\/html/);
  assert.match(home.body, /Grably/);

  const alsoHome = await handle(get('/index.php'));
  assert.equal(alsoHome.status, 200);
  assert.match(alsoHome.body, /Grably/);
});

test('an unknown route is the php 404 page, and an unknown path is the home page', async () => {
  const fromQuery = await handle(get('/index.php?r=bogus'));
  assert.equal(fromQuery.status, 404);
  assert.match(fromQuery.getHeader('content-type'), /^text\/html/);
  assert.match(fromQuery.body, /No page here/);

  const fromPath = await handle(get('/nothing/here'));
  assert.equal(fromPath.status, 200, 'the apache rewrite sent every unmatched path to the unrouted index');
  assert.match(fromPath.body, /Grably/, 'and the unrouted index renders the home page');
});

test('the four headers index.php set are on every answer', async () => {
  for (const route of ['/robots.txt', '/index.php?r=bogus', '/index.php?r=analyze']) {
    const r = await handle(get(route));
    assert.equal(r.getHeader('x-content-type-options'), 'nosniff', route);
    assert.equal(r.getHeader('x-frame-options'), 'SAMEORIGIN', route);
    assert.equal(r.getHeader('referrer-policy'), 'strict-origin-when-cross-origin', route);
    assert.equal(r.getHeader('permissions-policy'), 'geolocation=(), microphone=(), camera=()', route);
  }
});

test('the relay overwrites the referrer policy the way a second header() did', async () => {
  const store = jobStore();
  const url = 'https://cdn.cloudfam.io/f/abc123.mp4?token=xyz';
  const { query } = await relayQuery(store, url);
  const r = await handle(get('/relay?' + query), {
    jobs: store,
    http: stubHttp(() => res(200, 'body', { 'content-type': 'video/mp4', 'content-length': '4' })),
    resolve: async () => '93.184.216.34',
  });
  assert.equal(r.getHeader('referrer-policy'), 'no-referrer');
  assert.equal(r.getHeader('cache-control'), 'no-store');
});

test('pretty urls and ?r= both reach the same handler', async () => {
  const getAnalyze = await handle(get('/api/analyze'));
  assert.equal(getAnalyze.status, 405, '/api/analyze resolves to the analyze route');
  assert.deepEqual(JSON.parse(getAnalyze.body), { ok: false, error: 'Use POST.' });

  const q = await handle(get('/index.php?r=analyze'));
  assert.equal(q.status, 405, 'and so does the query form');

  const postForm = await handle(post('/api/analyze', { url: '' }));
  assert.equal(postForm.status, 422, 'a POST with no url is the empty-link refusal');
});

/* ------------------------------------------------------------------ analyze */

test('analyze takes the link from the form or from json, and refuses an overlong one', async () => {
  const fake = {
    registry: { forUrl: async () => ({ name: () => 'cloudfam', extract: async () => bundle() }) },
    http: {},
    guard: async () => 'https://cloudfam.io',
  };
  const store = jobStore();

  const byJson = await handle(get('/index.php?r=analyze', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://cloudfam.io/v/abc123' }),
    headers: { 'content-type': 'application/json' },
  }), { jobs: store, analyzer: { ...fake, jobs: store } });
  assert.equal(byJson.status, 200);
  const payload = JSON.parse(byJson.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.provider, 'cloudfam');
  assert.equal(payload.title, 'Big Buck Bunny 4K');
  assert.equal(payload.sources.length, 1);
  assert.match(payload.sources[0].previewUrl,
    /^https:\/\/grably\.test\/index\.php\?r=relay&job=[0-9a-f]{20}&u=/,
    'the browser is handed a same-origin relay link on the requested host');
  assert.equal(payload.sources[0].downloadUrl.includes('&dl=1'), true);

  const byForm = await handle(post('/index.php?r=analyze', { url: 'https://cloudfam.io/v/abc123' }),
    { analyzer: { ...fake, jobs: store } });
  assert.equal(byForm.status, 200, 'the form field the php read from $_POST still works');

  const tooLong = await handle(post('/index.php?r=analyze', { url: 'x'.repeat(2001) }), { analyzer: fake });
  assert.equal(tooLong.status, 422);
  assert.deepEqual(JSON.parse(tooLong.body), { ok: false, error: 'Paste a video page link.', code: 'empty' });

  const notJson = await handle(get('/index.php?r=analyze', {
    method: 'POST', body: 'not json at all', headers: { 'content-type': 'application/json' },
  }), { analyzer: fake });
  assert.equal(notJson.status, 422, 'a body that is neither a form nor readable json is the same refusal');

  const ssrf = await handle(post('/index.php?r=analyze', { url: 'http://127.0.0.1/x' }), {
    analyzer: { ...fake, guard: async () => { throw new UrlGuardException('That link points inside a private network.'); } },
  });
  assert.equal(ssrf.status, 422);
  const guardBody = JSON.parse(ssrf.body);
  assert.equal(guardBody.code, 'bad_url', 'the wall answers as a bad link, not as our failure');
  assert.equal(guardBody.error, 'That link points inside a private network.');
  assert.equal(guardBody.hint, 'Paste the link of a video page on a public site.');
});

test('analyze is rate limited per client, 20 a minute', async () => {
  const ip = nextIp();
  let last;
  for (let i = 0; i < 21; i++) {
    last = await handle(post('/index.php?r=analyze', { url: '' }, { ip }));
  }
  assert.equal(last.status, 429);
  const body = JSON.parse(last.body);
  assert.equal(body.code, 'rate_limited');
  assert.equal(body.error, 'Too many links at once.');
  assert.ok(body.retryAfter >= 1 && body.retryAfter <= 60, 'the refusal names the end of the window');

  const other = await handle(post('/index.php?r=analyze', { url: '' }, { ip: nextIp() }));
  assert.equal(other.status, 422, 'a different visitor has its own bucket');
});

/* ------------------------------------------------------------------ build + progress */

test('build refuses what php refused, before any work', async () => {
  assert.equal((await handle(get('/index.php?r=build'))).status, 405);

  const store = jobStore();
  const rec = await store.create(bundle());

  const expired = await handle(post('/index.php?r=build', { job: 'f'.repeat(20), src: 'abc' }),
    { jobs: store });
  assert.equal(expired.status, 410);
  assert.deepEqual(JSON.parse(expired.body), {
    ok: false, error: 'That analysis expired.', hint: 'Run the video page again.', code: 'job_expired',
  });

  const badSource = await handle(post('/index.php?r=build', { job: rec.id, src: 'nosuch' }),
    { jobs: store });
  assert.equal(badSource.status, 422);
  assert.deepEqual(JSON.parse(badSource.body), { ok: false, error: 'Unknown file in that result.', code: 'bad_source' });

  const many = [];
  const ip = nextIp();
  for (let i = 0; i < 7; i++) {
    many.push(await handle(post('/index.php?r=build', { job: rec.id, src: 'nosuch' }, { ip }), { jobs: store }));
  }
  assert.equal(many[5].status, 422, 'six saves a minute get to the checks');
  assert.equal(many[6].status, 429);
  assert.equal(JSON.parse(many[6].body).error, 'Too many saves at once.');
});

test('progress reports a finished build and its file url', async () => {
  const store = buildStore();
  const src = Source.make('https://cdn.example-media.test/hls/master.m3u8', Source.HLS);
  const rec = await store.create({ id: 'a'.repeat(20), provider: 'cloudfam', title: 'My Video' }, src,
    [{ url: 'https://cdn.example-media.test/hls/1.ts', bytes: 10 }], null, 12.5);
  rec.status = 'done';
  rec.cursor = 1;
  rec.bytes = 4096;
  await store.save(rec);

  const missing = await handle(get('/index.php?r=progress&build=' + 'f'.repeat(20)));
  assert.deepEqual(JSON.parse(missing.body), {
    ok: false, done: true, error: 'This save expired before it finished.',
    hint: 'Run the video page again.', code: 'build_expired',
  });

  const done = await handle(get('/index.php?r=progress&build=' + rec.id), { builds: store });
  assert.equal(done.status, 200);
  const body = JSON.parse(done.body);
  assert.deepEqual(body, {
    ok: true,
    build: rec.id,
    status: 'done',
    percent: 100,
    segments: 1,
    parts: 1,
    duration: 12.5,
    size: 4096,
    sizeHuman: '4 KB',
    videoSamples: 0,
    filename: 'My-Video.mp4',
    done: true,
    fileUrl: 'https://grably.test/index.php?r=file&build=' + rec.id + '&s=' + store.sign(rec) + '&name=My-Video.mp4',
    error: null,
    hint: null,
    note: null,
  }, 'the php progress payload, key for key');
});

/* ------------------------------------------------------------------ file */

async function readyFile(body = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) {
  const store = buildStore();
  const src = Source.make('https://cdn.example-media.test/hls/master.m3u8', Source.HLS);
  const rec = await store.create({ id: 'a'.repeat(20), provider: 'p', title: 'My Video' }, src,
    [{ url: 'https://cdn.example-media.test/hls/1.ts', bytes: 10 }], null, 1);
  rec.status = 'done';
  rec.cursor = 1;
  await store.save(rec);
  await store.writeOutput(rec.id, body, Buffer.from('log'));
  return { store, rec, sig: store.sign(rec), body };
}

function fileQuery(rec, sig, extra = '') {
  return '/index.php?r=file&build=' + rec.id + '&s=' + sig + extra;
}

test('file answers the four states php had for it', async () => {
  const { store, rec, sig, body } = await readyFile();

  const pendingStore = buildStore();
  const pending = await pendingStore.create({ id: 'a'.repeat(20), provider: 'p', title: 'My Video' },
    Source.make('https://cdn.example-media.test/hls/master.m3u8', Source.HLS), [], null, 1);

  const gone = await handle(get(fileQuery(rec, sig)), { builds: buildStore() });
  assert.equal(gone.status, 410);
  assert.equal(gone.body, 'This download expired. Run the video page again.');

  const wrongSig = await handle(get(fileQuery(rec, '0'.repeat(32))), { builds: store });
  assert.equal(wrongSig.status, 410, 'an unsigned build is the same refusal as an unknown one');

  const notReady = await handle(get('/index.php?r=file&build=' + pending.id + '&s=' + pendingStore.sign(pending)),
    { builds: pendingStore });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.body, 'That file is not ready yet.');

  const whole = await handle(get(fileQuery(rec, sig)), { builds: store });
  assert.equal(whole.status, 200);
  assert.equal(whole.getHeader('content-type'), 'video/mp4');
  assert.equal(whole.getHeader('content-length'), '10');
  assert.equal(whole.getHeader('accept-ranges'), 'bytes');
  assert.equal(whole.getHeader('cache-control'), 'private, no-store');
  assert.equal(whole.getHeader('content-disposition'), 'attachment; filename="My-Video.mp4"');
  assert.deepEqual([...whole.body], [...body], 'the stored bytes, unchanged');

  const inline = await handle(get(fileQuery(rec, sig, '&play=1')), { builds: store });
  assert.match(inline.getHeader('content-disposition'), /^inline; filename="My-Video\.mp4"$/,
    'the player asks for the same url with play=1');
});

test('file serves a range, and the name comes from the record', async () => {
  const { store, rec, sig, body } = await readyFile();

  const middle = await handle(get(fileQuery(rec, sig), { headers: { range: 'bytes=3-6' } }), { builds: store });
  assert.equal(middle.status, 206);
  assert.equal(middle.getHeader('content-range'), 'bytes 3-6/10');
  assert.equal(middle.getHeader('content-length'), '4');
  assert.deepEqual([...middle.body], [...body.subarray(3, 7)]);

  const tail = await handle(get(fileQuery(rec, sig), { headers: { range: 'bytes=-4' } }), { builds: store });
  assert.equal(tail.status, 206);
  assert.equal(tail.getHeader('content-range'), 'bytes 6-9/10');
  assert.deepEqual([...tail.body], [...body.subarray(6)]);

  const openEnd = await handle(get(fileQuery(rec, sig), { headers: { range: 'bytes=8-' } }), { builds: store });
  assert.equal(openEnd.getHeader('content-range'), 'bytes 8-9/10');

  const clamped = await handle(get(fileQuery(rec, sig), { headers: { range: 'bytes=0-9999' } }), { builds: store });
  assert.equal(clamped.status, 206, 'an end past the file is cut to the file, the way php cut it');
  assert.equal(clamped.getHeader('content-range'), 'bytes 0-9/10');

  const unsatisfiable = await handle(get(fileQuery(rec, sig), { headers: { range: 'bytes=-0' } }), { builds: store });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.getHeader('content-range'), 'bytes */10');

  const junk = await handle(get(fileQuery(rec, sig), { headers: { range: 'bytes=nope' } }), { builds: store });
  assert.equal(junk.status, 200, 'a range the php regex did not match is no range at all');

  const crafted = await handle(get(fileQuery(rec, sig) + '&name=../../etc/passwd'), { builds: store });
  assert.equal(crafted.getHeader('content-disposition'), 'attachment; filename="My-Video.mp4"',
    'the query name is ignored; the stored one is what the browser saves as');
});

test('spanFromRange is the php arithmetic', () => {
  const { spanFromRange } = routerTesting;
  assert.deepEqual(spanFromRange('0', '9', 100), { start: 0, end: 9 });
  assert.deepEqual(spanFromRange('50', '', 100), { start: 50, end: 99 });
  assert.deepEqual(spanFromRange('', '20', 100), { start: 80, end: 99 });
  assert.deepEqual(spanFromRange('500', '600', 100), { start: 99, end: 99 }, 'a start past the file clamps, it does not fail');
  assert.equal(spanFromRange('', '0', 100), false, 'bytes=-0 is the unsatisfiable one');
  assert.deepEqual(spanFromRange('99', '99', 100), { start: 99, end: 99 });
});

test('a whole file bigger than one response may carry is refused, not truncated', async () => {
  const original = config.limits.function_stream_bytes;
  config.limits.function_stream_bytes = 8;
  try {
    const { store, rec, sig } = await readyFile(Buffer.alloc(9, 7));
    const r = await handle(get(fileQuery(rec, sig)), { builds: store });
    assert.equal(r.status, 413);
    assert.match(r.body, /too large for one response/);
    assert.equal(r.getHeader('accept-ranges'), 'bytes');
    assert.equal(r.getHeader('x-file-size'), '9');

    const piece = await handle(get(fileQuery(rec, sig), { headers: { range: 'bytes=0-8' } }), { builds: store });
    assert.equal(piece.status, 206, 'the same file is still readable in a piece');
    assert.equal(piece.body.length, 9);
  } finally {
    config.limits.function_stream_bytes = original;
  }
});

/* ------------------------------------------------------------------ relay guards */

test('the relay refuses links it did not sign', async () => {
  const store = jobStore();
  const url = 'https://cdn.cloudfam.io/f/abc123.mp4?token=xyz';
  const { record, query } = await relayQuery(store, url);

  const expired = await handle(get('/relay?r=relay&job=' + 'f'.repeat(20) + '&u=zz&s=' + '0'.repeat(32)),
    { jobs: store });
  assert.equal(expired.status, 410);
  assert.equal(expired.body, 'This link expired. Go back and analyse the video page again.');

  const garbage = await handle(get('/relay?r=relay&job=' + record.id + '&u=not-a-sealed-link&s=' + '0'.repeat(32)),
    { jobs: store });
  assert.equal(garbage.status, 400);
  assert.equal(garbage.body, 'Bad media reference.');

  const tampered = new URLSearchParams(query);
  tampered.set('s', '0'.repeat(32));
  const badSig = await handle(get('/relay?' + tampered.toString()), { jobs: store });
  assert.equal(badSig.status, 403);
  assert.equal(badSig.body, 'This download link is not valid.');

  const foreignUrl = 'https://evil.example.org/whatever.mp4';
  const params = new URLSearchParams(query);
  params.set('u', linkSeal(foreignUrl, String(record.secret)));
  params.set('s', store.sign(record, foreignUrl));
  const foreign = await handle(get('/relay?' + params.toString()), { jobs: store });
  assert.equal(foreign.status, 403, 'a signature this job made for a host it never saw is still refused');
  assert.equal(foreign.body, 'That file host is not part of this analysis.');

  const internal = await handle(get('/relay?' + query), {
    jobs: store,
    resolve: async () => '127.0.0.1',
    http: stubHttp(() => { throw new Error('must not reach the file host'); }),
  });
  assert.equal(internal.status, 403);
  assert.equal(internal.body, 'That file address is not reachable.',
    'the second wall: a stored job whose file address has since become an internal one');
});

/* ------------------------------------------------------------------ relay streaming */

test('the relay passes the host answer through with the php header rules', async () => {
  const store = jobStore();
  const url = 'https://cdn.cloudfam.io/f/abc123.mp4?token=xyz';
  const { query } = await relayQuery(store, url);
  const http = stubHttp(() => res(200, null,
    { 'content-type': 'application/octet-stream', 'content-length': '6', 'accept-ranges': 'bytes' },
    url, Readable.from([Buffer.from([9, 8, 7, 6, 5, 4])])));

  const r = await handle(get('/relay?' + query), {
    jobs: store, http, resolve: async () => '93.184.216.34',
  });
  assert.equal(r.status, 200);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, url);
  assert.equal(http.calls[0].opts.range, undefined, 'a whole-file ask goes upstream without a range');
  assert.equal(http.calls[0].opts.headers.Referer, 'https://cloudfam.io/v/abc123',
    'the headers the analysis stored travel with the request');
  assert.equal(r.getHeader('content-type'), 'video/mp4',
    'an octet-stream answer is re-typed from the file name, like MediaSniffer did');
  assert.equal(r.getHeader('content-length'), '6');
  assert.equal(r.getHeader('accept-ranges'), 'bytes');
  assert.deepEqual([...await drain(r.stream)], [9, 8, 7, 6, 5, 4], 'and the bytes come back as they went in');
});

test('a ranged relay ask is narrowed before it goes upstream', async () => {
  const store = jobStore();
  const url = 'https://cdn.cloudfam.io/f/abc123.mp4?token=xyz';
  const cap = config.limits.function_stream_bytes;
  const { query } = await relayQuery(store, url);

  /** One ranged visit to the relay, with the file host's answer supplied by the test. */
  async function relayed(range, answer) {
    const http = stubHttp(() => answer(url));
    const r = await handle(get('/relay?' + query, { headers: { range } }), {
      jobs: store, http, resolve: async () => '93.184.216.34',
    });
    return { r, sent: http.calls[0].opts.range };
  }

  const open = await relayed('bytes=0-', (u) => res(206, null,
    { 'content-type': 'video/mp4', 'content-length': String(cap), 'content-range': `bytes 0-${cap - 1}/500000000` },
    u, Readable.from([Buffer.alloc(1024)])));
  assert.equal(open.sent, `bytes=0-${cap - 1}`,
    'the player asks for the rest of the file and the function only ever takes one response-sized piece');
  assert.equal(open.r.status, 206, 'a partial answer to a partial ask is still partial');
  assert.equal(open.r.getHeader('content-range'), `bytes 0-${cap - 1}/500000000`);
  assert.equal(open.r.getHeader('content-length'), String(cap));
  assert.equal(open.r.getHeader('accept-ranges'), 'bytes');

  const small = await relayed('bytes=100-199', (u) => res(206, null,
    { 'content-range': 'bytes 100-199/500000000', 'content-length': '100' }, u, Readable.from([Buffer.alloc(100)])));
  assert.equal(small.sent, 'bytes=100-199', 'a piece inside the cap is asked for verbatim');
  assert.equal(small.r.getHeader('content-range'), 'bytes 100-199/500000000');

  const suffix = await relayed('bytes=-1000', (u) => res(206, null,
    { 'content-length': '1000' }, u, Readable.from([Buffer.alloc(1000)])));
  assert.equal(suffix.sent, 'bytes=-1000');
  assert.equal(suffix.r.status, 206);

  const wide = await relayed('bytes=0-', (u) => res(206, null,
    { 'content-length': String(cap + 1000), 'content-range': `bytes 0-${cap + 999}/500000000` },
    u, Readable.from([Buffer.alloc(cap + 1000)])));
  assert.equal(wide.r.getHeader('content-length'), String(cap),
    'a host that answers a narrow ask with a wide piece is cut');
  assert.equal(wide.r.getHeader('content-range'), `bytes 0-${cap - 1}/500000000`);
  assert.equal((await drain(wide.r.stream)).length, cap, 'and exactly that many bytes arrive');
});

test('a whole file over the ceiling is a refusal from the relay too', async () => {
  const store = jobStore();
  const url = 'https://cdn.cloudfam.io/f/abc123.mp4?token=xyz';
  const { query } = await relayQuery(store, url);
  let piped = false;
  const upstream = new Readable({ read() { } });
  upstream.on('newListener', (event) => {
    if (event === 'data') {
      piped = true;
    }
  });
  const r = await handle(get('/relay?' + query), {
    jobs: store,
    resolve: async () => '93.184.216.34',
    http: stubHttp(() => res(200, null, { 'content-length': '500000000' }, url, upstream)),
  });
  assert.equal(r.status, 413);
  assert.equal(r.getHeader('x-file-size'), '500000000');
  assert.match(r.body, /too large for one response/);
  assert.equal(piped, false, 'the body is never even read off the host');
});

test('the relay rewrites a playlist so every line comes back through this origin', async () => {
  const store = jobStore();
  const url = 'https://cdn.cloudfam.io/hls/master.m3u8';
  const { record, query } = await relayQuery(store, url, { p: '1' });
  const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720\n720/index.m3u8\n';
  const http = stubHttp(() => res(200, manifest, { 'content-type': 'application/vnd.apple.mpegurl' }, url));

  const r = await handle(get('/relay?' + query), { jobs: store, http, resolve: async () => '93.184.216.34' });
  assert.equal(r.status, 200);
  assert.equal(r.getHeader('content-type'), 'application/vnd.apple.mpegurl');
  assert.equal(r.getHeader('access-control-allow-origin'), '*');
  assert.equal(http.calls[0].opts.max_bytes, 4000000, 'a manifest is read whole, never streamed');

  const lines = r.body.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.equal(lines[1], '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720');
  assert.match(lines[2], /^https:\/\/grably\.test\/index\.php\?r=relay&job=/);
  assert.match(lines[2], /&p=1$/, 'in a master playlist the bare line is another playlist');
  const params = new URLSearchParams(lines[2].split('?')[1]);
  assert.equal(params.get('job'), record.id);
  assert.equal(store.verify(record, url.replace('/master.m3u8', '/720/index.m3u8'), params.get('s')), true,
    'the child link is signed for the child url');

  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg/1.ts\n';
  const seg = await handle(get('/relay?' + query), {
    jobs: store,
    resolve: async () => '93.184.216.34',
    http: stubHttp(() => res(200, media, { 'content-type': 'application/vnd.apple.mpegurl' }, url)),
  });
  const segmentLine = seg.body.split('\n')[3];
  assert.match(segmentLine, /^https:\/\/grably\.test\/index\.php\?r=relay&job=/);
  assert.equal(segmentLine.includes('&p=1'), false,
    'in a media playlist the bare line is a segment, so it is not asked for as a manifest');
  const segmentParams = new URLSearchParams(segmentLine.split('?')[1]);
  assert.equal(linkOpen(segmentParams.get('u'), String(record.secret)),
    'https://cdn.cloudfam.io/hls/seg/1.ts',
    'a relative segment line is resolved against the manifest, exactly as php rewrote it');
});

/**
 * The contract the in-page muxer walks.
 *
 * site/src/engine/localMux.mjs runs on the visitor's own device, one small relay fetch
 * per part, and it has no cookies for the video host and no CORS on its side of the
 * request. That only works if a rewritten playlist leaves no off-origin address behind,
 * so this follows the whole path a browser would: master, variant, then the key and the
 * segment out of the media playlist. Every link it finds must be this origin's, must
 * carry this job's signature, and must be signed for the url it stands for.
 */
test('a rewritten playlist is walkable by the browser with nothing but this origin', async () => {
  const store = jobStore();
  const masterUrl = 'https://cdn.cloudfam.io/hls/master.m3u8';
  const variantUrl = 'https://cdn.cloudfam.io/hls/720/index.m3u8';
  const keyUrl = 'https://cdn.cloudfam.io/hls/keys/abc';
  const segmentUrl = 'https://cdn.cloudfam.io/hls/720/seg/1.ts';
  const media = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.cloudfam.io/hls/keys/abc",IV=0X1234',
    '#EXTINF:10.0,',
    'seg/1.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const { record, query } = await relayQuery(store, masterUrl, { p: '1' });
  const http = stubHttp((url) => res(200, url === masterUrl
    ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720\n720/index.m3u8\n'
    : media, { 'content-type': 'application/vnd.apple.mpegurl' }, url));
  const relayTo = (absoluteUrl) => handle(get('/relay?' + new URL(absoluteUrl).searchParams.toString()), {
    jobs: store, http, resolve: async () => '93.184.216.34',
  });

  const master = await handle(get('/relay?' + query), {
    jobs: store, http, resolve: async () => '93.184.216.34',
  });
  const variant = await relayTo(master.body.split('\n')[2]);
  assert.equal(variant.status, 200, 'the child link the master handed out is a valid relay link');

  const body = variant.body;
  const offOrigin = (body.match(/https?:\/\/[^\s,"]+/g) ?? []).filter((u) => !u.startsWith('https://grably.test/'));
  assert.deepEqual(offOrigin, [], 'the browser never has to leave this origin');
  assert.equal(body.includes('cdn.cloudfam.io'), false, 'not one host url survives the rewrite');

  const keyLine = body.split('\n').find((l) => l.startsWith('#EXT-X-KEY'));
  const keyLink = /URI="([^"]+)"/.exec(keyLine)[1];
  assert.match(keyLink, /^https:\/\/grably\.test\/index\.php\?r=relay&job=/);
  const keyParams = new URL(keyLink).searchParams;
  assert.equal(keyParams.get('p'), null, 'a key is bytes, so it is never asked for as a manifest');
  assert.match(keyLine, /,IV=0X1234/, 'the tag around the rewritten uri is untouched');
  assert.equal(store.verify(record, keyUrl, keyParams.get('s')), true, 'signed for the resolved key url');
  assert.equal(linkOpen(keyParams.get('u'), String(record.secret)), keyUrl);

  const segmentLink = body.split('\n').find((l) => l.startsWith('https://grably.test'));
  const segmentParams = new URL(segmentLink).searchParams;
  assert.equal(store.verify(record, segmentUrl, segmentParams.get('s')), true, 'signed for the resolved segment url');

  // and the walk actually ends: a relay fetch of that segment link returns the bytes
  const segment = await relayTo(segmentLink);
  assert.equal(segment.status, 200);
});

test('download mode names the file the way addslashes did', async () => {
  const store = jobStore();
  const url = 'https://cdn.cloudfam.io/f/abc123.mp4?token=xyz';
  const http = () => stubHttp(() => res(200, null, { 'content-type': 'video/mp4', 'content-length': '2' },
    url, Readable.from([Buffer.from([1, 2])])));

  const plain = await handle(get('/relay?' + (await relayQuery(store, url, { dl: '1' })).query), {
    jobs: store, http: http(), resolve: async () => '93.184.216.34',
  });
  assert.equal(plain.getHeader('content-disposition'), 'attachment; filename="abc123.mp4"',
    'no name parameter takes the leaf of the file address');

  const odd = await handle(get('/relay?' + (await relayQuery(store, url, { dl: '1', name: 'a"b\'c\\d' })).query), {
    jobs: store, http: http(), resolve: async () => '93.184.216.34',
  });
  assert.equal(odd.getHeader('content-disposition'), 'attachment; filename="a\\"b\\\'c\\\\d"',
    'the php addslashes() quoting, inherited byte for byte');

  const ts = await handle(get('/relay?' + (await relayQuery(store, 'https://cdn.cloudfam.io/hls/1.ts', { dl: '1' })).query), {
    jobs: store, http: http(), resolve: async () => '93.184.216.34',
  });
  assert.equal(ts.getHeader('content-disposition'), 'attachment; filename="1.ts"');
});

test('a file host that fails gets the php status codes', async () => {
  const store = jobStore();
  const url = 'https://cdn.cloudfam.io/f/abc123.mp4?token=xyz';
  const { query } = await relayQuery(store, url);

  const refused = await handle(get('/relay?' + query), {
    jobs: store,
    resolve: async () => '93.184.216.34',
    http: stubHttp(() => { throw new HttpException('The host closed the connection.', 0, url); }),
  });
  assert.equal(refused.status, 502);
  assert.equal(refused.body, 'The video host would not send this file.');

  const manifest = await handle(get('/relay?' + (await relayQuery(store, url, { p: '1' })).query), {
    jobs: store,
    resolve: async () => '93.184.216.34',
    http: stubHttp(() => { throw new HttpException('nope', 0, url); }),
  });
  assert.equal(manifest.status, 502);
  assert.equal(manifest.body, 'The video host refused to send its playlist.');

  const unreadable = await handle(get('/relay?' + (await relayQuery(store, url, { p: '1' })).query), {
    jobs: store,
    resolve: async () => '93.184.216.34',
    http: stubHttp(() => res(200, 'not a manifest at all', { 'content-type': 'text/html' }, url)),
  });
  assert.equal(unreadable.status, 502);
  assert.equal(unreadable.body, 'That playlist could not be read.');

  const hostError = await handle(get('/relay?' + query), {
    jobs: store,
    resolve: async () => '93.184.216.34',
    http: stubHttp(() => res(403, 'denied', { 'content-type': 'text/plain' }, url)),
  });
  assert.equal(hostError.status, 403, 'an error from the file host travels as the host sent it');
});

/* ------------------------------------------------------------------ failure cascade */

test('an unhandled throw is json on an api route and the error page elsewhere', async () => {
  const store = jobStore();
  const { query } = await relayQuery(store, 'https://cdn.cloudfam.io/f/abc123.mp4?token=xyz');
  const boom = await handle(get('/relay?' + query), {
    jobs: store,
    resolve: async () => { throw new Error('resolver exploded'); },
  });
  assert.equal(boom.status, 500);
  assert.deepEqual(JSON.parse(boom.body), { ok: false, error: 'Something went wrong on our side.', code: 'server' });

  const buildBoom = await handle(get('/index.php?r=progress&build=' + 'f'.repeat(20)), {
    builds: { async find() { throw new Error('storage exploded'); } },
  });
  assert.equal(buildBoom.status, 500);
  assert.equal(JSON.parse(buildBoom.body).code, 'server');

  const extractBoom = await handle(post('/index.php?r=analyze', { url: 'https://cloudfam.io/v/x' }), {
    analyzer: { guard: async () => 'https://cloudfam.io', registry: { forUrl: async () => { throw new Error('no'); } } },
  });
  assert.equal(extractBoom.status, 500);
  assert.equal(JSON.parse(extractBoom.body).code, 'server', 'the analyze route answers json even for our own failure');
});

test('an extractor refusal keeps its visitor-facing words', async () => {
  const { ExtractException } = await import('../src/errors.mjs');
  const r = await handle(post('/index.php?r=analyze', { url: 'https://cloudfam.io/v/x' }), {
    analyzer: {
      guard: async () => 'https://cloudfam.io',
      registry: {
        forUrl: async () => ({
          name: () => 'cloudfam',
          extract: async () => { throw new ExtractException('That page is behind a login.', 'Use a public link.', 'gated'); },
        }),
      },
      http: {},
    },
  });
  assert.equal(r.status, 422);
  assert.deepEqual(JSON.parse(r.body), {
    ok: false, error: 'That page is behind a login.', hint: 'Use a public link.', code: 'gated',
  });
});

/* ------------------------------------------------------------------ the platform adapter */

test('the netlify adapter turns a Request into the php context and back', async () => {
  const routerModule = await import('../../netlify/functions/router.mjs');
  const router = routerModule.default;

  const robots = await router(new Request('https://grably.netlify.app/.netlify/functions/router?r=robots', {
    headers: { host: 'grably.netlify.app' },
  }), { event: { path: '/robots.txt' }, requestContext: { ip: '203.0.113.7' } });
  assert.equal(robots.status, 200);
  assert.equal(robots.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(robots.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(await robots.text(),
    'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /health\nSitemap: https://grably.netlify.app/sitemap.xml\n',
    'the proxy rewrite leaves the function url on the request, so the event path names the site the links use');

  const notFound = await router(new Request('https://grably.netlify.app/index.php?r=nope', {
    headers: { host: 'grably.netlify.app' },
  }), { event: { path: '/index.php' }, requestContext: { ip: '203.0.113.7' } });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.statusText, 'Not Found', 'a status phrase apache would have sent');

  const form = await router(new Request('https://grably.netlify.app/index.php?r=analyze', {
    method: 'POST',
    headers: { host: 'grably.netlify.app', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'url=',
  }), { event: { path: '/index.php' }, requestContext: { ip: '203.0.113.77' } });
  assert.equal(form.status, 422);
  assert.equal(form.statusText, 'Unprocessable Content');
  assert.deepEqual(await form.json(), { ok: false, error: 'Paste a video link first.', hint: '', code: 'empty' });
});

/* ------------------------------------------------------------------ the deploy's own questions */

test('/health answers what a bundle can silently lose', async () => {
  const http = stubHttp(() => res(200, 'hello'));
  const r = await handle(get('/health'), { http });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.storage_writable, true, 'the store the router was configured with takes a write');
  assert.equal(body.storage_reason, null, 'and nothing fell over on the way there');
  assert.equal(body.extractors, 13, 'every extractor in HOST_EXTRACTORS is registered');
  assert.ok(body.hosts >= 40, 'and they answer for more than forty hosts');
  assert.equal(body.outbound, 'ok');

  const bare = await handle(get('/health'), { http });
  assert.equal(JSON.parse(bare.body).app, 'video-downloader',
    'the netlify.toml proxy sends a visitor to /health, not to /health/something');
});

test('a file answer above the buffered ceiling leaves as a stream', async () => {
  const original = config.limits.function_buffer_bytes;
  config.limits.function_buffer_bytes = 4;
  try {
    const { store, rec, sig, body } = await readyFile();
    const r = await handle(get(fileQuery(rec, sig)), { builds: store });
    assert.equal(r.status, 200);
    assert.equal(r.body, null, 'the bytes are not held in the body');
    assert.ok(r.stream !== null, 'they go out as a stream, which is the only way a platform '
      + 'with a six megabyte buffer hands over a bigger file');
    assert.deepEqual([...await drain(r.stream)], [...body], 'and they are the same bytes');
    assert.equal(r.getHeader('content-length'), '10');
  } finally {
    config.limits.function_buffer_bytes = original;
  }

  const { store, rec, sig, body } = await readyFile();
  const small = await handle(get(fileQuery(rec, sig)), { builds: store });
  assert.deepEqual([...small.body], [...body], 'at the default ceiling a ten byte file is a body again');
  assert.equal(small.stream, null);
});

test('a deploy with no store says so instead of failing every write', async () => {
  // The state a netlify function is in when it has no blob credentials and a directory
  // it cannot write to. The two halves of that are each survivable on their own; the
  // pair is not, and a visitor needs to be told that rather than handed a 500.
  const file = path.join(ROOT, 'not-a-directory');
  fs.writeFileSync(file, 'x');
  const warned = [];
  const realWarn = console.warn;
  console.warn = (m) => warned.push(m);
  const stored = { VD_STORE: process.env.VD_STORE, VD_STORAGE_DIR: process.env.VD_STORAGE_DIR };
  process.env.VD_STORE = 'blobs';
  process.env.VD_STORAGE_DIR = path.join(file, 'storage');
  try {
    const r = await handle(post('/index.php?r=build', { job: 'deadbeefdeadbeefdead' }));
    assert.equal(r.status, 503);
    const body = JSON.parse(r.body);
    assert.equal(body.code, 'storage');
    assert.match(body.error, /store/i);

    // The same state read from the operator's page, because that is where the reason
    // gets looked for. Once the platform hands out credentials the fallback is not
    // needed, but until then /health is the only place that says which half is missing.
    const faulted = JSON.parse((await handle(get('/health'), { http: stubHttp(() => res(200, '')) })).body);
    assert.equal(faulted.storage_writable, false);
    assert.ok(typeof faulted.storage_reason === 'object' && faulted.storage_reason !== null,
      'and it names the namespaces that could not be opened');
    assert.match(Object.values(faulted.storage_reason).join(' '), /read-only/,
      'with the reason the platform store failed and why the fallback will not do');
  } finally {
    process.env.VD_STORE = stored.VD_STORE;
    process.env.VD_STORAGE_DIR = stored.VD_STORAGE_DIR;
    console.warn = realWarn;
    assert.ok(warned.length > 0, 'the fallback attempt is still logged');
  }
});

test('analyze answers for a slow host before the platform kills the function', async () => {
  const never = () => new Promise(() => { });
  const slow = await handle(post('/index.php?r=analyze', { url: 'https://cloudfam.io/v/x' }), {
    analyze: never,
    analyzeBudgetMs: 40,
  });
  assert.equal(slow.status, 504);
  const body = JSON.parse(slow.body);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'slow');
  assert.match(body.hint, /Stream address/, 'the answer tells the visitor the one route that still works');
  assert.doesNotMatch(slow.body, /errorType|errorMessage|Invoke|timeout/i,
    'never the platform words: a visitor cannot act on a function being killed');

  // A host that answers after the answer went out must not become an unhandled rejection,
  // which on netlify is how a healthy function instance dies.
  const seen = [];
  const note = (p) => seen.push(p);
  process.on('unhandledRejection', note);
  const boom = () => new Promise((_, reject) => setTimeout(() => reject(new Error('late host')), 700));
  const late = await handle(post('/index.php?r=analyze', { url: 'https://cloudfam.io/v/y' }), {
    analyze: boom,
    analyzeBudgetMs: 200,
  });
  await new Promise((r) => setTimeout(r, 900));
  process.off('unhandledRejection', note);
  assert.equal(late.status, 504, 'the budget answered first');
  assert.deepEqual(seen, [], 'and the late rejection was swallowed by the race');

  const quick = await handle(post('/index.php?r=analyze', { url: 'https://cloudfam.io/v/z' }), {
    analyze: async () => ({ job: 'a'.repeat(20) }),
    analyzeBudgetMs: 4000,
  });
  assert.equal(quick.status, 200, 'a host inside the budget is untouched by it');

  const refused = await handle(post('/index.php?r=analyze', { url: 'https://cloudfam.io/v/w' }), {
    analyze: async () => { throw new (await import('../src/errors.mjs')).ExtractException('That page is not there.', 'Check the link.', 'not_found'); },
    analyzeBudgetMs: 4000,
  });
  assert.equal(refused.status, 422, 'an extractor refusal still answers as itself, not as a timeout');
});
