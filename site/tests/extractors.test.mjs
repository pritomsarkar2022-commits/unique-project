import test from 'node:test';
import assert from 'node:assert/strict';

import { BaseExtractor, setVdLog } from '../src/extractor/baseExtractor.mjs';
import { GenericExtractor } from '../src/extractor/genericExtractor.mjs';
import { ExtractorRegistry, HOST_EXTRACTORS } from '../src/extractor/extractorRegistry.mjs';
import { MediaBundle } from '../src/extractor/mediaBundle.mjs';
import { Source } from '../src/extractor/source.mjs';
import { HttpResponse } from '../src/net/httpResponse.mjs';
import { ExtractException, HttpException, UrlGuardException } from '../src/errors.mjs';
import { Analyzer } from '../src/extractor/analyzer.mjs';

/**
 * The stub HttpClient: a scripted reply table plus a call log, so every assertion
 * about the options a probe passes (max_bytes, accept, range, timeout) is exact.
 * That is how the request budgets and header shapes of the php original are proven
 * to have survived the port. No sockets, no loopback server.
 */
class FakeHttp {
  /**
   * @param {Record<string, Array<HttpResponse|Error>>} replies url -> queued replies,
   *   consumed in call order; an Error is thrown instead of returned.
   * @param {number} remaining what http.remaining() answers with
   */
  constructor(replies = {}, remaining = 5) {
    this.replies = replies;
    this.remainingValue = remaining;
    this.calls = [];
  }

  remaining() {
    return this.remainingValue;
  }

  async get(url, opts = {}) {
    this.calls.push({ url, opts });
    return this.#answer(url);
  }

  async post(url, body, opts = {}) {
    this.calls.push({ url, opts, post: body });
    return this.#answer(url);
  }

  #answer(url) {
    const queue = this.replies[url];
    const reply = Array.isArray(queue) && queue.length > 0 ? queue.shift() : undefined;
    if (reply === undefined) {
      throw new Error('FakeHttp: no reply scripted for ' + url);
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }
}

/** A response with php's lower-cased header keys. */
function res(status, body = '', headers = {}, contentType = '', finalUrl = 'https://files.example.org/x.mp4') {
  const lowered = {};
  for (const [k, v] of Object.entries(headers)) {
    lowered[k.toLowerCase()] = v;
  }
  return new HttpResponse(status, body, lowered, contentType, finalUrl, body.length);
}

function mp4Source(url = 'https://files.example.org/x.mp4') {
  const s = Source.make(url, Source.MP4);
  s.headers = { Referer: 'https://page.example.org/' };
  return s;
}

function hlsSource(url = 'https://cdn.example.org/master.m3u8') {
  const s = Source.make(url, Source.HLS);
  s.headers = { Referer: 'https://page.example.org/' };
  return s;
}

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
  'low.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
  'high.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
  'mid.m3u8',
].join('\n');

/** three 1.5s segments behind an AES-128 key, i.e. what a variant read buys */
const MEDIA = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.org/key.bin"',
  '#EXTINF:1.5,',
  'a.ts',
  '#EXTINF:1.5,',
  'b.ts',
  '#EXTINF:1.5,',
  'c.ts',
  '#EXT-X-ENDLIST',
].join('\n');

/** two 9.04s segments, no key: 18.08s total, round(18.08, 1) = 18.1 */
const MEDIA_PLAIN = [
  '#EXTM3U',
  '#EXTINF:9.04,',
  'a.ts',
  '#EXTINF:9.04,',
  'b.ts',
  '#EXT-X-ENDLIST',
].join('\n');

test('name() derives the php display name from the class', () => {
  class BlockedExtractor extends BaseExtractor {
    static phpClass = 'BlockedExtractor';
  }
  class StreamtapeExtractor extends BaseExtractor {}
  class XfsExtractor extends BaseExtractor {
    constructor() { super('XfsExtractor'); }
  }
  class YouTubeExtractor extends BaseExtractor {
    static phpClass = 'YouTubeExtractor';
    hosts() { return ['youtube.com']; }
  }
  assert.equal(new BlockedExtractor().name(), 'blocked');
  assert.equal(new StreamtapeExtractor().name(), 'streamtape');
  assert.equal(new XfsExtractor().name(), 'xfs');
  assert.equal(new YouTubeExtractor().name(), 'youtube');

  // preg_replace('/extractor$/i', '') is a case-insensitive *anchored suffix*: a name
  // that only contains "Extractor" keeps it, and only one copy is removed.
  assert.equal(new BaseExtractor('StreamExtractorExtractor').name(), 'streamextractor');
  assert.equal(new BaseExtractor('extractor').name(), '');
  assert.equal(new BaseExtractor('EXTRACTORX').name(), 'extractorx');
  assert.equal(new BaseExtractor('MxCaptureEXTRACTOR').name(), 'mxcapture');

  // the php defaults
  assert.equal(new BaseExtractor('BaseExtractor').priority(), 10);
  assert.deepEqual(new BaseExtractor('BaseExtractor').hosts(), []);
  assert.equal(new GenericExtractor().priority(), 1);
  assert.equal(new GenericExtractor().name(), 'generic');
  const g = new GenericExtractor();
  g.setProvider('video.site');
  assert.equal(g.name(), 'video.site');
  assert.equal(g.newBundle('https://x/').provider, 'video.site');
});

test('readable/sniff/htmlHeaders/newBundle/fillMeta', () => {
  const ex = new BaseExtractor('VidaraExtractor');
  const page = res(200,
    '<html><head><title>Big Buck Bunny</title>'
    + '<meta property="og:image" content="/poster.png">'
    + '</head><body>an html page</body></html>',
  {}, 'text/html; charset=UTF-8', 'https://page.example.org/watch/42');
  assert.equal(typeof ex.readable(page), 'string');
  assert.deepEqual(ex.htmlHeaders(page), { Referer: 'https://page.example.org/watch/42' });

  const sources = ex.sniff(res(200, 'player.src("https://cdn.example.org/v.mp4")', {}, 'text/html',
    'https://page.example.org/watch/42'), { Referer: 'https://page.example.org/watch/42' });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, 'https://cdn.example.org/v.mp4');
  assert.equal(sources[0].kind, Source.MP4);
  assert.deepEqual(sources[0].headers, { Referer: 'https://page.example.org/watch/42' });
  // php's $headers default is an empty array, and it is what the source keeps
  assert.deepEqual(ex.sniff(res(200, 'player.src("https://cdn.example.org/v.mp4")', {}, 'text/html')).length, 1);
  assert.deepEqual(ex.sniff(res(200, 'nothing here at all', {}, 'text/html')), []);

  const b = ex.newBundle('https://page.example.org/watch/42');
  assert.equal(b.provider, 'vidara');
  assert.equal(b.pageUrl, 'https://page.example.org/watch/42');
  assert.equal(ex.newBundle('https://x/', 'named').provider, 'named');

  ex.fillMeta(b, page);
  assert.equal(b.finalUrl, 'https://page.example.org/watch/42');
  assert.equal(b.title, 'Big Buck Bunny');
  assert.equal(b.thumbnail, 'https://page.example.org/poster.png');
  // ??= never overwrites what the extractor already set
  const preset = ex.newBundle('https://x/');
  preset.title = 'kept';
  preset.thumbnail = 'kept.png';
  ex.fillMeta(preset, page);
  assert.equal(preset.title, 'kept');
  assert.equal(preset.thumbnail, 'kept.png');
});

test('verify(): the one-byte probe passes exactly php\'s options', async () => {
  const ex = new BaseExtractor('StreamfileExtractor');
  const s = mp4Source();
  const http = new FakeHttp({
    'https://files.example.org/x.mp4': [res(206, 'x', { 'content-range': 'bytes 0-0/4194304', 'content-length': '1' }, 'video/mp4')],
  });
  assert.equal(await ex.verify(s, http), true);
  assert.deepEqual(http.calls[0], {
    url: 'https://files.example.org/x.mp4',
    opts: {
      headers: { Referer: 'https://page.example.org/', Range: 'bytes=0-0' },
      max_bytes: 65536,
      timeout: 15,
      accept: '*/*',
    },
  });
  // the content-range total wins over content-length, mime comes from before the ';'
  assert.equal(s.sizeBytes, 4194304);
  assert.equal(s.mime, 'video/mp4');
});

test('verify(): a source that already names its own Range keeps it (php union)', async () => {
  const ex = new BaseExtractor('VixeoExtractor');
  const s = mp4Source();
  s.headers = { Referer: 'https://page.example.org/', Range: 'bytes=100-100' };
  const http = new FakeHttp({ 'https://files.example.org/x.mp4': [res(200, '', { 'content-length': '500000' }, 'video/mp4')] });
  assert.equal(await ex.verify(s, http), true);
  assert.deepEqual(http.calls[0].opts.headers, { Referer: 'https://page.example.org/', Range: 'bytes=100-100' });
});

test('verify(): 416 retries once without the range, other statuses do not', async () => {
  const ex = new BaseExtractor('CloudfamExtractor');
  const s = mp4Source();
  const http = new FakeHttp({
    'https://files.example.org/x.mp4': [
      res(416, 'nope', {}, 'text/plain'),
      res(200, '', { 'content-length': '900000' }, 'application/octet-stream'),
    ],
  });
  assert.equal(await ex.verify(s, http), true);
  assert.equal(http.calls.length, 2);
  assert.deepEqual(http.calls[1].opts, {
    headers: { Referer: 'https://page.example.org/' },
    max_bytes: 65536,
    timeout: 15,
    accept: '*/*',
  });
  assert.equal(s.sizeBytes, 900000);
  assert.equal(s.mime, 'application/octet-stream');

  const refused = new BaseExtractor('PlaymateExtractor');
  for (const status of [401, 403]) {
    const url = 'https://files.example.org/p' + status + '.mp4';
    const probe = mp4Source(url);
    const h = new FakeHttp({ [url]: [res(status, '', {}, 'text/html', url)] });
    assert.equal(await refused.verify(probe, h), false, 'status ' + status);
    assert.equal(h.calls.length, 1, 'no retry for ' + status);
  }
  const goneUrl = 'https://files.example.org/gone.mp4';
  const gone = mp4Source(goneUrl);
  const hg = new FakeHttp({ [goneUrl]: [res(404, '', {}, 'text/html', goneUrl)] });
  assert.equal(await refused.verify(gone, hg), false);
  // only one 416 retry: a second 416 is a refusal, not a loop
  const still416 = mp4Source('https://files.example.org/again.mp4');
  const h416 = new FakeHttp({ 'https://files.example.org/again.mp4': [res(416), res(416)] });
  assert.equal(await refused.verify(still416, h416), false);
  assert.equal(h416.calls.length, 2);
});

test('verify(): the size predicate both ways, and the type/mime rules', async () => {
  const ex = new BaseExtractor('MxdropExtractor');

  const big = mp4Source('https://files.example.org/big.mp4');
  const hBig = new FakeHttp({ 'https://files.example.org/big.mp4': [res(200, '', { 'content-length': '1200' }, 'video/mp4')] });
  assert.equal(await ex.verify(big, hBig), true);
  assert.equal(big.sizeBytes, 1200);

  const small = mp4Source('https://files.example.org/small.mp4');
  const hSmall = new FakeHttp({ 'https://files.example.org/small.mp4': [res(200, '', { 'content-length': '900' }, 'video/mp4')] });
  assert.equal(await ex.verify(small, hSmall), false);
  assert.equal(small.sizeBytes, 900);

  // exactly 1024 is not > 1024
  const edge = mp4Source('https://files.example.org/edge.mp4');
  const hEdge = new FakeHttp({ 'https://files.example.org/edge.mp4': [res(200, '', { 'content-length': '1024' }, 'video/mp4')] });
  assert.equal(await ex.verify(edge, hEdge), false);

  // content-length 1 is not a size at all, so the source stays sizeless and is kept
  const noSize = mp4Source('https://files.example.org/tiny.mp4');
  const hTiny = new FakeHttp({ 'https://files.example.org/tiny.mp4': [res(200, '', { 'content-length': '1' }, 'video/mp4')] });
  assert.equal(await ex.verify(noSize, hTiny), true);
  assert.equal(noSize.sizeBytes, null);

  // php only reads content-length on a 200; a 206 without content-range stays sizeless
  const partNoRange = mp4Source('https://files.example.org/part.mp4');
  const hPart = new FakeHttp({ 'https://files.example.org/part.mp4': [res(206, '', { 'content-length': '5000000' }, 'video/mp4')] });
  assert.equal(await ex.verify(partNoRange, hPart), true);
  assert.equal(partNoRange.sizeBytes, null);

  // an empty type looks like video and must not overwrite the guessed mime
  const unknown = mp4Source('https://files.example.org/unknown.mp4');
  unknown.mime = 'video/mp4';
  const hUnknown = new FakeHttp({ 'https://files.example.org/unknown.mp4': [res(200, '', { 'content-length': '20000' }, '')] });
  assert.equal(await ex.verify(unknown, hUnknown), true);
  assert.equal(unknown.mime, 'video/mp4', 'mime kept when the host says nothing');

  for (const [type, want] of [
    ['application/binary', true],
    ['X-VIDEO/MP4', true],
    ['application/octet-stream', true],
    ['text/html', false],
    ['application/json', false],
    ['', true],
  ]) {
    const url = 'https://files.example.org/t-' + type.replace(/[^a-z]/gi, '') + '.mp4';
    const s = mp4Source(url);
    const h = new FakeHttp({ [url]: [res(200, '', { 'content-length': '20000' }, type, url)] });
    assert.equal(await ex.verify(s, h), want, 'type ' + JSON.stringify(type));
  }

  // a content-range with a trailing newline still matches php's `$` anchor
  const nl = mp4Source('https://files.example.org/nl.mp4');
  const hNl = new FakeHttp({ 'https://files.example.org/nl.mp4': [res(206, '', { 'content-range': 'bytes 0-0/7777777\n' }, 'video/mp4')] });
  assert.equal(await ex.verify(nl, hNl), true);
  assert.equal(nl.sizeBytes, 7777777);

  // a garbage content-range falls through to content-length, exactly like preg_match
  const junk = mp4Source('https://files.example.org/junk.mp4');
  const hJunk = new FakeHttp({ 'https://files.example.org/junk.mp4': [res(206, '', { 'content-range': 'bytes 0-0/*', 'content-length': '8000' }, 'video/mp4')] });
  assert.equal(await ex.verify(junk, hJunk), true);
  assert.equal(junk.sizeBytes, null, 'a 206 ignores content-length even when the range is unreadable');
});

test('verify(): HttpException notes the source, other errors travel', async () => {
  const ex = new BaseExtractor('FirestreamExtractor');
  const s = mp4Source('https://files.example.org/err.mp4');
  const http = new FakeHttp({ 'https://files.example.org/err.mp4': [new HttpException('That site refused the connection.', 0, s.url)] });
  assert.equal(await ex.verify(s, http), false);
  assert.equal(s.note, 'That site refused the connection.');

  const s2 = mp4Source('https://127.0.0.1/y.mp4');
  const http2 = new FakeHttp({ 'https://127.0.0.1/y.mp4': [new UrlGuardException('That address is not reachable from here.')] });
  await assert.rejects(() => ex.verify(s2, http2), UrlGuardException);
});

test('verify(): an hls source is verified as a playlist, not as bytes', async () => {
  const ex = new BaseExtractor('LuluvidoExtractor');
  const s = hlsSource('https://cdn.example.org/hls/master.m3u8');
  const http = new FakeHttp({
    'https://cdn.example.org/hls/master.m3u8': [res(200, MASTER, {}, 'application/vnd.apple.mpegurl', 'https://cdn.example.org/hls/master.m3u8')],
    'https://cdn.example.org/hls/high.m3u8': [res(200, MEDIA, {}, 'application/x-mpegURL', 'https://cdn.example.org/hls/high.m3u8')],
  });
  assert.equal(await ex.verify(s, http), true);
  assert.deepEqual(http.calls[0].opts, {
    headers: { Referer: 'https://page.example.org/' },
    max_bytes: 3000000,
    accept: 'application/x-mpegURL,application/vnd.apple.mpegurl,*/*;q=0.8',
  }, 'a playlist probe carries no Range and no timeout');
});

test('verifyPlaylist(): master -> variants sorted by height, top one read', async () => {
  const ex = new BaseExtractor('StreamtapeExtractor');
  const s = hlsSource('https://cdn.example.org/hls/master.m3u8');
  const http = new FakeHttp({
    'https://cdn.example.org/hls/master.m3u8': [res(200, MASTER, {}, 'application/x-mpegURL', 'https://cdn.example.org/hls/master.m3u8')],
    'https://cdn.example.org/hls/high.m3u8': [res(200, MEDIA, {}, 'application/x-mpegURL', 'https://cdn.example.org/hls/high.m3u8')],
  }, 4);
  assert.equal(await ex.verifyPlaylist(s, http), true);
  assert.equal(s.variants.length, 3);
  assert.deepEqual(s.variants.map((v) => v.height), [1080, 720, 360]);
  assert.deepEqual(s.variants.map((v) => v.bandwidth), [5000000, 2000000, 800000]);
  assert.deepEqual(s.variants.map((v) => v.codecs), [null, null, 'avc1.4d401e,mp4a.40.2']);
  assert.deepEqual(s.variants.map((v) => v.url), [
    'https://cdn.example.org/hls/high.m3u8',
    'https://cdn.example.org/hls/mid.m3u8',
    'https://cdn.example.org/hls/low.m3u8',
  ]);
  assert.equal(s.height, 1080);
  assert.equal(s.bitrate, 5000000);
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[1].url, 'https://cdn.example.org/hls/high.m3u8');
  assert.deepEqual(http.calls[1].opts, {
    headers: { Referer: 'https://page.example.org/' },
    max_bytes: 6000000,
    accept: 'application/x-mpegURL,*/*;q=0.8',
  });
  // what the variant read bought the MP4 builder
  assert.equal(s.variants[0].segments, 3);
  assert.equal(s.variants[0].duration, 4.5);
  assert.equal(s.variants[0].encrypted, true);
  assert.equal(s.duration, 4.5);
  assert.equal(s.keyUri, 'https://cdn.example.org/key.bin');
  assert.equal(s.keyMethod, 'AES-128');
  assert.equal(s.variants[2].segments, undefined, 'only the top variant is read');
});

test('verifyPlaylist(): no budget left means no variant read', async () => {
  const ex = new BaseExtractor('StreamtapeExtractor');
  const s = hlsSource();
  const http = new FakeHttp({
    'https://cdn.example.org/master.m3u8': [res(200, MASTER, {}, '', 'https://cdn.example.org/master.m3u8')],
  }, 0);
  assert.equal(await ex.verifyPlaylist(s, http), true);
  assert.equal(http.calls.length, 1);
  assert.equal(s.height, 1080);
  assert.equal(s.variants[0].segments, undefined);
});

test('verifyPlaylist(): SAMPLE-AES is refused, in its own words', async () => {
  const ex = new BaseExtractor('XfsExtractor');
  const body = ['#EXTM3U', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"', '#EXTINF:10,', 'a.ts', '#EXT-X-ENDLIST'].join('\n');
  const url = 'https://drm.example.org/master.m3u8';
  const s = hlsSource(url);
  const http = new FakeHttp({ [url]: [res(200, body, {}, '', url)] });
  assert.equal(await ex.verifyPlaylist(s, http), false);
  assert.equal(s.note, 'This stream is encrypted in a way that needs its own player, so it cannot be joined into one file.');
  assert.deepEqual(s.variants, []);
});

test('verifyPlaylist(): #EXTM3U is a case-insensitive substring test, not indexOf', async () => {
  const ex = new BaseExtractor('BlockedExtractor');
  let n = 0;
  for (const marker of ['#EXTM3U', '#extm3u', '#eXtM3U']) {
    n++;
    const url = 'https://case.example.org/p' + n + '.m3u8';
    const s = hlsSource(url);
    const http = new FakeHttp({ [url]: [res(200, [marker, '#EXTINF:5,', 'a.ts', '#EXT-X-ENDLIST'].join('\n'), {}, '', url)] });
    assert.equal(await ex.verifyPlaylist(s, http), true, marker);
  }
  const not = hlsSource('https://case.example.org/nope.m3u8');
  const http = new FakeHttp({ 'https://case.example.org/nope.m3u8': [res(200, '<html>EXTM3U inside, no hash</html>', {}, 'text/html')] });
  assert.equal(await ex.verifyPlaylist(not, http), false);
});

test('verifyPlaylist(): a media playlist records one synthetic variant', async () => {
  const ex = new BaseExtractor('VidaraExtractor');
  const url = 'https://cdn.example.org/index.m3u8';
  const s = hlsSource(url);
  const http = new FakeHttp({ [url]: [res(200, MEDIA_PLAIN, {}, '', url)] });
  assert.equal(await ex.verifyPlaylist(s, http), true);
  assert.equal(http.calls.length, 1);
  assert.equal(s.duration, 18.08);
  assert.deepEqual(s.variants, [{
    height: null,
    bandwidth: null,
    codecs: null,
    url,
    segments: 2,
    duration: 18.1,
    encrypted: false,
  }]);

  // a playlist that names no segment is nothing to download
  const emptyUrl = 'https://cdn.example.org/empty.m3u8';
  const empty = hlsSource(emptyUrl);
  const http2 = new FakeHttp({ [emptyUrl]: [res(200, '#EXTM3U\n#EXT-X-ENDLIST', {}, '', emptyUrl)] });
  assert.equal(await ex.verifyPlaylist(empty, http2), false);

  // a master that lists nothing
  const noneUrl = 'https://cdn.example.org/none.m3u8';
  const masterless = hlsSource(noneUrl);
  const http3 = new FakeHttp({ [noneUrl]: [res(200, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100', {}, '', noneUrl)] });
  assert.equal(await ex.verifyPlaylist(masterless, http3), false);

  // a total duration of 0 leaves duration null but still records round(0, 1)
  const zeroUrl = 'https://cdn.example.org/zero.m3u8';
  const zero = hlsSource(zeroUrl);
  const http4 = new FakeHttp({
    [zeroUrl]: [res(200, '#EXTM3U\n#EXT-X-TARGETDURATION:0\nseg.ts\n#EXT-X-ENDLIST', {}, '', zeroUrl)],
  });
  assert.equal(await ex.verifyPlaylist(zero, http4), true);
  assert.equal(zero.duration, null);
  assert.equal(zero.variants[0].duration, 0);
  assert.equal(zero.variants[0].segments, 1);
});

test('verifyPlaylist(): failures stay silent, notes are not invented', async () => {
  const ex = new BaseExtractor('MxdropExtractor');
  const boomUrl = 'https://cdn.example.org/boom.m3u8';
  const boom = hlsSource(boomUrl);
  const http = new FakeHttp({ [boomUrl]: [new HttpException('That site took too long to answer.')] });
  assert.equal(await ex.verifyPlaylist(boom, http), false);
  assert.equal(boom.note, null);

  const badUrl = 'https://cdn.example.org/bad.m3u8';
  const bad = hlsSource(badUrl);
  const http2 = new FakeHttp({ [badUrl]: [res(500, '#EXTM3U', {}, '', badUrl)] });
  assert.equal(await ex.verifyPlaylist(bad, http2), false);
});

test('readVariant(): skips, swallows and records exactly like php', async () => {
  const ex = new BaseExtractor('PlaymateExtractor');

  const same = hlsSource();
  const httpSame = new FakeHttp({}, 5);
  await ex.readVariant(same, same.url, httpSame);
  assert.equal(httpSame.calls.length, 0, 'the source url is already open');

  const url = 'https://cdn.example.org/a.m3u8';
  const s = hlsSource();
  s.variants = [
    { height: 720, bandwidth: 2000000, codecs: null, url },
    { height: 1080, bandwidth: 5000000, codecs: null, url },
  ];
  const http = new FakeHttp({ [url]: [res(200, MEDIA)] });
  await ex.readVariant(s, url, http);
  assert.equal(s.variants[0].segments, 3, 'php takes the FIRST match');
  assert.equal(s.variants[1].segments, undefined);
  assert.equal(s.variants[0].duration, 4.5);
  assert.equal(s.variants[0].encrypted, true);
  assert.equal(s.duration, 4.5);
  assert.equal(s.keyUri, 'https://cdn.example.org/key.bin');
  assert.equal(s.keyMethod, 'AES-128');
  assert.deepEqual(http.calls[0].opts, {
    headers: { Referer: 'https://page.example.org/' },
    max_bytes: 6000000,
    accept: 'application/x-mpegURL,*/*;q=0.8',
  });

  // no variant matched: php's $first stayed 0, so the head of the list is updated
  const headUrl = 'https://cdn.example.org/head.m3u8';
  const head = hlsSource();
  head.variants = [{ height: 1080, bandwidth: 1, codecs: null, url: 'https://cdn.example.org/other.m3u8' }];
  const httpHead = new FakeHttp({ [headUrl]: [res(200, MEDIA)] });
  await ex.readVariant(head, headUrl, httpHead);
  assert.equal(head.variants[0].segments, 3);

  // an empty variant list autovivifies like php instead of throwing
  const bare = hlsSource();
  bare.variants = [];
  const bareUrl = 'https://cdn.example.org/bare.m3u8';
  const httpBare = new FakeHttp({ [bareUrl]: [res(200, MEDIA)] });
  await ex.readVariant(bare, bareUrl, httpBare);
  assert.equal(bare.variants.length, 1);
  assert.equal(bare.variants[0].segments, 3);

  // a master, a non-playlist and a segmentless playlist are all ignored
  for (const [name, body] of [
    ['master', MASTER],
    ['html', '<html>no</html>'],
    ['segmentless', '#EXTM3U\n#EXT-X-ENDLIST'],
    ['not ok', '#EXTM3U\n#EXTINF:1,\na.ts'],
  ]) {
    const vUrl = 'https://cdn.example.org/v-' + name + '.m3u8';
    const s2 = hlsSource();
    s2.variants = [{ height: 1080, bandwidth: 1, codecs: null, url: vUrl }];
    const h2 = new FakeHttp({ [vUrl]: [res(name === 'not ok' ? 503 : 200, body, {}, '', vUrl)] });
    await ex.readVariant(s2, vUrl, h2);
    assert.equal(s2.variants[0].segments, undefined, name);
  }

  // transport errors and refused addresses are swallowed without a note
  for (const err of [new HttpException('That site refused the connection.'), new UrlGuardException('That address is not reachable from here.')]) {
    const wUrl = 'https://cdn.example.org/w-' + err.name + '.m3u8';
    const s3 = hlsSource();
    s3.variants = [{ height: 1080, bandwidth: 1, codecs: null, url: wUrl }];
    const h3 = new FakeHttp({ [wUrl]: [err] });
    await ex.readVariant(s3, wUrl, h3);
    assert.equal(s3.variants[0].segments, undefined, err.name);
    assert.equal(s3.note, null, err.name);
  }

  // totalDuration 0 keeps the duration the master already learned
  const keepUrl = 'https://cdn.example.org/k.m3u8';
  const keep = hlsSource();
  keep.duration = 12;
  keep.variants = [{ height: 1080, bandwidth: 1, codecs: null, url: keepUrl }];
  const h4 = new FakeHttp({ [keepUrl]: [res(200, '#EXTM3U\n#EXT-X-TARGETDURATION:0\nseg.ts\n#EXT-X-ENDLIST', {}, '', keepUrl)] });
  await ex.readVariant(keep, keepUrl, h4);
  assert.equal(keep.duration, 12);
  assert.equal(keep.variants[0].segments, 1);
});

test('verifyAll(): keeps the proven, logs the rejected, lifts confidence', async () => {
  const ex = new BaseExtractor('LuluvidoExtractor');
  const lines = [];
  setVdLog((message, context) => lines.push([message, context]));
  try {
    const good = mp4Source('https://files.example.org/good.mp4');
    const bad = mp4Source('https://files.example.org/bad.mp4');
    const http = new FakeHttp({
      'https://files.example.org/good.mp4': [res(200, '', { 'content-length': '3000000' }, 'video/mp4')],
      'https://files.example.org/bad.mp4': [res(403, '', {}, 'text/html')],
    });
    const b = ex.newBundle('https://page.example.org/');
    const kept = await ex.verifyAll([good, bad], http, b);
    assert.deepEqual(kept.map((s) => s.url), ['https://files.example.org/good.mp4']);
    assert.equal(b.confidence, 0.85);
    assert.deepEqual(lines, [['candidate rejected', { url: 'https://files.example.org/bad.mp4', kind: 'mp4' }]]);

    const none = ex.newBundle('https://page.example.org/');
    const noUrl = 'https://files.example.org/no.mp4';
    const http2 = new FakeHttp({ [noUrl]: [res(404, '', {}, 'text/html', noUrl)] });
    const kept2 = await ex.verifyAll([mp4Source(noUrl)], http2, none);
    assert.deepEqual(kept2, []);
    assert.equal(none.confidence, 0.5, 'confidence only moves when something is kept');

    const empty = ex.newBundle('https://page.example.org/');
    assert.deepEqual(await ex.verifyAll([], new FakeHttp(), empty), []);
    assert.equal(empty.confidence, 0.5);
  } finally {
    setVdLog(null);
  }
});

test('registrable(): the public-suffix tail table', () => {
  const R = ExtractorRegistry.registrable;
  const cases = [
    ['a.co.uk', 'a.co.uk'],
    ['x.y.com.bd', 'y.com.bd'],
    ['foo.localhost', 'foo.localhost'],
    ['single', 'single'],
    ['very.deep.name.co.ke', 'name.co.ke'],
    ['www.example.com', 'example.com'],
    ['EXAMPLE.COM', 'example.com'],
    ['.example.com.', 'example.com'],
    ['gov.uk', 'gov.uk'],
    ['a.b.gov.in', 'b.gov.in'],
    ['x.mil.it', 'x.mil.it'],
    ['cdn.streamtape.com', 'streamtape.com'],
    ['deep.cdn.example.com', 'example.com'],
    ['', ''],
    ['.', ''],
    ['..', ''],
    ['localhost', 'localhost'],
    ['a.b', 'a.b'],
    ['test.co', 'test.co'],
    ['x.ne.jp', 'x.ne.jp'],
    ['sub.or.id', 'sub.or.id'],
    ['go.jp.example', 'jp.example'],
    ['lg.kr', 'lg.kr'],
    ['ac.cn', 'ac.cn'],
    ['ne.uk', 'ne.uk'],
    ['ftp.example.org', 'example.org'],
    ['a.edu.au', 'a.edu.au'],
    ['MIXED.Case.TLD', 'case.tld'],
    ['a.b.c.d.e.f', 'e.f'],
    ['0', '0'],
    ['x.0', 'x.0'],
    ['a.b.c.com', 'c.com'],
    ['sub.example.co.uk', 'example.co.uk'],
    ['deep.sub.example.co.uk', 'example.co.uk'],
    ['x.example', 'x.example'],
    ['example.com.', 'example.com'],
    ['a.co', 'a.co'],
    ['co.uk', 'co.uk'],
    ['a.b.co.uk', 'b.co.uk'],
    ['x.y.z.com.br', 'z.com.br'],
  ];
  for (const [input, want] of cases) {
    assert.equal(R(input), want, 'registrable(' + JSON.stringify(input) + ')');
  }
});

test('forUrl(): strlen*100 + priority, strict >, first registered wins ties', async () => {
  class Stub extends BaseExtractor {
    constructor(phpClass, hostList, prio) {
      super(phpClass);
      this.h = hostList;
      this.p = prio;
    }
    hosts() { return this.h; }
    priority() { return this.p; }
  }
  const first = new Stub('StreamtapeExtractor', ['streamtape.com'], 10);
  const tie = new Stub('VidaraExtractor', ['streamtape.com'], 10);
  const keSuper = new Stub('XfsExtractor', ['co.ke'], 90);
  const keExact = new Stub('VixeoExtractor', ['name.co.ke'], 1);
  const unreachable = new Stub('PlaymateExtractor', ['cdn.streamtape.com'], 999);
  const registry = new ExtractorRegistry({ extractors: [first, tie, keSuper, keExact, unreachable] });

  assert.equal(await registry.forUrl('https://streamtape.com/v/abc'), first, 'equal score: the first registered wins');
  assert.equal(await registry.forUrl('https://www.streamtape.com/v/abc'), first, 'a subdomain matches the pattern');
  assert.equal(await registry.forUrl('https://very.deep.name.co.ke/x'), keExact, 'strlen(pattern)*100 beats priority');
  assert.equal(await registry.forUrl('https://name.co.ke/x'), keExact, 'the registrable host itself matches');

  // a pattern longer than the registrable form can never be reached, because
  // registrable() has already cut "cdn.streamtape.com" down to "streamtape.com"
  assert.equal(await registry.forUrl('https://cdn.streamtape.com/v/abc'), first, 'not the unreachable 3-label pattern');

  // same pattern, different priority: the higher score wins
  const low = new Stub('StreamfileExtractor', ['dup.example'], 5);
  const high = new Stub('LuluvidoExtractor', ['dup.example'], 50);
  const ranked = new ExtractorRegistry({ extractors: [low, high] });
  assert.equal(await ranked.forUrl('https://dup.example/'), high);
  const rankedReverse = new ExtractorRegistry({ extractors: [high, low] });
  assert.equal(await rankedReverse.forUrl('https://dup.example/'), high);
  const bothLow = new ExtractorRegistry({ extractors: [new Stub('AExtractor', ['dup.example'], 5), new Stub('BExtractor', ['dup.example'], 5)] });
  assert.equal((await bothLow.forUrl('https://dup.example/')).name(), 'a');

  // a host that merely ends with the pattern's text is not the pattern's host
  const liar = await registry.forUrl('https://notstreamtape.com/');
  assert.ok(liar instanceof GenericExtractor, 'no dot boundary, no match');
  assert.equal(liar.name(), 'notstreamtape.com');
  assert.equal((await registry.forUrl('https://weird.host.tld/')).name(), 'host.tld');
  assert.equal((await registry.forUrl('not a url at all')).name(), 'generic', 'php: an empty host falls back to the word generic');
  assert.equal((await registry.forUrl('https://single/')).name(), 'single');
  assert.equal((await registry.forUrl('http://0/x')).name(), 'generic', 'php ?: makes the host "0" empty');
});

test('forUrl(): the fallback is a fresh generic extractor per call', async () => {
  const registry = new ExtractorRegistry({ extractors: [] });
  const g = await registry.forUrl('https://deep.cdn.example.co.uk/watch');
  assert.ok(g instanceof GenericExtractor);
  assert.equal(g.name(), 'example.co.uk');
  assert.equal(g.priority(), 1);
  assert.equal(g.newBundle('https://x/').provider, 'example.co.uk');
  const again = await registry.forUrl('https://deep.cdn.example.co.uk/watch');
  assert.notEqual(g, again, 'php news one up per call');
});

test('knownHosts(): skips the refusals and sorts by byte order', async () => {
  const named = (name, hostList) => ({ name: () => name, hosts: () => hostList, priority: () => 10 });
  const registry = new ExtractorRegistry({
    extractors: [
      named('blocked', ['gate.example.com']),
      named('youtube', ['youtube.com', 'youtu.be']),
      named('streamtape', ['streamtape.com', 'sbt.st']),
      named('dup', ['dup.example']),
      named('later', ['dup.example', 'A.example']),
      named('generic', []),
    ],
  });
  const hosts = await registry.knownHosts();
  assert.deepEqual(Object.keys(hosts), ['A.example', 'dup.example', 'sbt.st', 'streamtape.com']);
  assert.equal(hosts['dup.example'], 'later', 'the later extractor overwrites the name, the slot stays');
  assert.equal(hosts['A.example'], 'later');
  assert.ok(!('youtube.com' in hosts));
  assert.ok(!('youtu.be' in hosts));
  assert.ok(!('gate.example.com' in hosts));
});

test('HOST_EXTRACTORS is the php constructor list, in order', () => {
  assert.deepEqual(HOST_EXTRACTORS.map(([, className]) => className), [
    'BlockedExtractor',
    'YouTubeExtractor',
    'StreamtapeExtractor',
    'StreamfileExtractor',
    'LuluvidoExtractor',
    'FirestreamExtractor',
    'PlaymateExtractor',
    'VidaraExtractor',
    'VixeoExtractor',
    'CloudfamExtractor',
    'MxdropExtractor',
    'XfsExtractor',
    'GenericExtractor',
  ]);
});

test('init(): host modules that are not written yet are skipped, not fatal', async () => {
  // Other agents drop the twelve host extractors into this directory one at a time,
  // so this asserts the contract, not a snapshot of which files exist right now.
  const registry = new ExtractorRegistry();
  await registry.init();
  const order = HOST_EXTRACTORS.map(([, className]) => className);
  const present = registry.extractors.map((e) => e.constructor.phpClass ?? e.constructor.name);
  assert.ok(present.includes('GenericExtractor'), 'generic is always registered');
  let last = -1;
  for (const name of present) {
    const at = order.indexOf(name);
    assert.ok(at > last, name + ' registered in the php constructor order');
    last = at;
  }
  assert.equal(registry.missingModules.length + present.length, HOST_EXTRACTORS.length);
  for (const path of registry.missingModules) {
    assert.match(path, /^\.\/[a-z][A-Za-z]*Extractor\.mjs$/);
    assert.ok(HOST_EXTRACTORS.some(([p]) => p === path), path + ' comes from the plan');
  }
  await registry.init();
  assert.equal(registry.extractors.length, present.length, 'building twice registers nothing twice');

  // an unclaimed host still gets the fresh generic extractor with the host as provider
  const g = await registry.forUrl('https://www.nothost-anywhere.example/watch');
  assert.ok(g instanceof GenericExtractor);
  assert.equal(g.name(), 'nothost-anywhere.example');

  // create() is the router's one-liner
  const ready = await ExtractorRegistry.create({ extractors: [] });
  assert.deepEqual(ready.extractors, []);
});

test('GenericExtractor.extract(): a pasted file address costs one peek plus one probe', async () => {
  const ex = new GenericExtractor();
  const fileUrl = 'https://cdn.example.org/clip.m3u8';
  const playlist = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXTINF:10,', 'a.ts', '#EXT-X-ENDLIST'].join('\n');
  // the peek at the address, then the playlist read verify() performs on the same url
  const http = new FakeHttp({ [fileUrl]: [
    res(200, playlist, {}, 'application/x-mpegURL', fileUrl),
    res(200, playlist, {}, 'application/x-mpegURL', fileUrl),
  ] });
  const bundle = await ex.extract(fileUrl, http);
  assert.deepEqual(http.calls[0].opts, {
    headers: { Referer: fileUrl },
    max_bytes: 65536,
    accept: '*/*',
  });
  assert.equal(bundle.confidence, 0.8);
  assert.equal(bundle.provider, 'generic');
  assert.deepEqual(bundle.sources.map((s) => s.kind), [Source.HLS]);
  assert.equal(bundle.sources[0].label, 'Video stream');
  assert.equal(bundle.finalUrl, fileUrl);
  assert.deepEqual(bundle.sources[0].headers, { Referer: fileUrl });

  // an address that answers with html is a page after all: read the whole of it
  const pageUrl = 'https://host.example.org/something.webm';
  const clip = 'https://media.host.example.org/720/clip.mp4';
  const page = '<html><head><title>Clip</title></head><body>'
    + '<video src="' + clip + '"></video></body></html>';
  const http2 = new FakeHttp({
    [pageUrl]: [
      res(200, '<html><body>teaser</body></html>', {}, 'text/html', pageUrl),
      res(200, page, {}, 'text/html', pageUrl),
    ],
    [clip]: [res(200, '', { 'content-length': '4000000' }, 'video/mp4')],
  });
  const smallPage = await ex.extract(pageUrl, http2);
  assert.equal(http2.calls[0].opts.max_bytes, 65536, 'a file-looking address is peeked at first');
  assert.deepEqual(http2.calls[1].opts, { headers: { Referer: pageUrl }, accept: 'text/html,*/*;q=0.8' }, 'then read in full');
  assert.equal(smallPage.title, 'Clip');
  assert.ok(smallPage.sources.map((s) => s.url).includes(clip), 'the file the page names is found');
  assert.equal(smallPage.confidence, 0.85);

  // a real page gets the configured budget on its single read
  const plainPage = 'https://host.example.org/watch/42';
  const http3 = new FakeHttp({
    [plainPage]: [res(200, page, {}, 'text/html', plainPage)],
    [clip]: [res(200, '', { 'content-length': '4000000' }, 'video/mp4')],
  });
  const pageBundle = await ex.extract(plainPage, http3);
  assert.equal(http3.calls[0].opts.max_bytes, 2000000);
  assert.equal(http3.calls[0].opts.accept, '*/*');
  assert.deepEqual(http3.calls.find((c) => c.url === clip).opts.max_bytes, 65536, 'the file probe is the 64 KiB one');
  assert.ok(pageBundle.sources.map((s) => s.url).includes(clip));
  assert.equal(pageBundle.confidence, 0.85);
});

test('GenericExtractor.extract(): the refusals keep their wording', async () => {
  const gate = 'Your own browser passes that check, this server cannot and will not go around it. Open the '
    + 'video in your browser, copy the .m3u8 or file address its player uses, and paste that into '
    + 'Stream address. That save runs on your device.';
  const refusals = [
    [401, 'That page needs a sign in.', 'This tool does not use accounts, so it stops there. Paste a page that is open to visitors.', 'gated'],
    [403, 'That site checks the browser that opens it.', gate, 'gated'],
    [404, 'That page is not there.', 'Check the link, or paste the address of the page that shows the player.', 'not_found'],
    [410, 'That page is not there.', 'Check the link, or paste the address of the page that shows the player.', 'not_found'],
  ];
  for (const [status, message, hint, code] of refusals) {
    const url = 'https://gated.example.org/p' + status;
    const h = new FakeHttp({ [url]: [res(status, '<html><body>no</body></html>', {}, 'text/html', url)] });
    await assert.rejects(() => new GenericExtractor().extract(url, h), (err) => {
      assert.equal(err.name, 'ExtractException');
      assert.equal(err.message, message, 'status ' + status);
      assert.equal(err.hint, hint);
      assert.equal(err.codeName, code);
      return true;
    });
    assert.equal(h.calls.length, 1, 'a login or browser-check wall gets exactly one request, never a bypass');
  }

  const deadUrl = 'https://host.example.org/dead';
  for (const phrase of ['Video Not Found', 'this video has been REMOVED', 'Not available in your country', 'Account has been suspended']) {
    const h = new FakeHttp({ [deadUrl]: [res(200, '<html>Sorry, ' + phrase + '</html>', {}, 'text/html', deadUrl)] });
    await assert.rejects(() => new GenericExtractor().extract(deadUrl, h), (err) => {
      assert.equal(err.codeName, 'file_gone', phrase);
      assert.equal(err.message, 'That file is no longer on the video host.');
      return true;
    });
  }

  // a file address that will not answer (an html answer would make it a page again)
  const goneFile = 'https://cdn.example.org/gone.mp4';
  const hGone = new FakeHttp({ [goneFile]: [
    res(404, '', {}, '', goneFile),
    res(404, '', {}, '', goneFile),
  ] });
  await assert.rejects(() => new GenericExtractor().extract(goneFile, hGone), (err) => {
    assert.equal(err.codeName, 'file_refused');
    assert.equal(err.message, 'That file address did not answer.');
    assert.equal(err.hint, 'Its link may have expired. Paste the address of the page that shows the player.');
    return true;
  });
});

test('GenericExtractor.extract(): the finder seam is where DeepFinder lands', async () => {
  const page = 'https://host.example.org/watch/1';
  const masterUrl = 'https://media.host.example.org/hls/deep.m3u8';
  const variantUrl = 'https://media.host.example.org/hls/v.m3u8';
  const seen = [];
  GenericExtractor.setDeepFinderFactory((http, bundle, response, extractor) => {
    seen.push({ url: response.finalUrl, name: extractor.name(), isMediaBundle: bundle instanceof MediaBundle });
    const s = Source.make(masterUrl, Source.HLS);
    s.headers = { Referer: response.finalUrl };
    return [s];
  });
  try {
    const http = new FakeHttp({
      [page]: [res(200, '<html><body>a wrapper</body></html>', {}, 'text/html', page)],
      [masterUrl]: [res(200, ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720', 'v.m3u8'].join('\n'), {}, '', masterUrl)],
      [variantUrl]: [res(200, ['#EXTM3U', '#EXTINF:4,', 's.ts', '#EXT-X-ENDLIST'].join('\n'), {}, '', variantUrl)],
    });
    const b = await new GenericExtractor().extract(page, http);
    assert.deepEqual(seen, [{ url: page, name: 'generic', isMediaBundle: true }]);
    assert.deepEqual(b.sources.map((s) => s.url), [masterUrl]);
    assert.equal(b.sources[0].height, 720);
    assert.equal(b.sources[0].label, '720p video stream', 'height . p . strtolower(base)');
    assert.equal(b.confidence, 0.85);

    // nothing found is no media at all
    GenericExtractor.setDeepFinderFactory(() => []);
    const http2 = new FakeHttp({ [page]: [res(200, '<html><body>quiet</body></html>', {}, 'text/html', page)] });
    await assert.rejects(() => new GenericExtractor().extract(page, http2), (err) => {
      assert.equal(err.codeName, 'no_media');
      assert.equal(err.hint, 'The page loads its player with javascript after the fact, or the link is not a video page. Paste the address of the page that shows the player.');
      return true;
    });

    // a candidate that will not answer is a refusal, not a half-truth on screen
    GenericExtractor.setDeepFinderFactory(() => {
      const s = Source.make('https://media.host.example.org/lie.mp4', Source.MP4);
      return [s];
    });
    const http3 = new FakeHttp({
      [page]: [res(200, '<html><body>wrapper</body></html>', {}, 'text/html', page)],
      'https://media.host.example.org/lie.mp4': [res(403, '', {}, 'text/html')],
    });
    await assert.rejects(() => new GenericExtractor().extract(page, http3), (err) => {
      assert.equal(err.codeName, 'file_refused');
      assert.equal(err.message, 'That page names a video, but the host will not serve the file.');
      assert.equal(err.hint, 'Its player works with its own session only. Paste the address of the player page, or try again in a minute.');
      return true;
    });

    // the probe list is capped at max(2, cfg('extract.verify_limit'))
    GenericExtractor.setDeepFinderFactory(() => {
      const many = [];
      for (let i = 0; i < 10; i++) {
        many.push(Source.make('https://media.host.example.org/c' + i + '.mp4', Source.MP4));
      }
      return many;
    });
    const replies = { [page]: [res(200, '<html><body>many</body></html>', {}, 'text/html', page)] };
    for (let i = 0; i < 10; i++) {
      replies['https://media.host.example.org/c' + i + '.mp4'] = [res(403, '', {}, 'text/html')];
    }
    const http4 = new FakeHttp(replies);
    await assert.rejects(() => new GenericExtractor().extract(page, http4), (err) => err.codeName === 'file_refused');
    assert.equal(http4.calls.filter((c) => c.url !== page).length, 6, 'verify_limit 6 candidates are probed, not 10');
  } finally {
    GenericExtractor.setDeepFinderFactory(null);
  }
});

/* ---------------- Analyzer.runExtractor(): who gets a second attempt ---------------- */

/** A host extractor with a name, so every branch of the fallback is reachable on one object. */
function hostExtractor(codeName) {
  return {
    name: () => 'cloudfam',
    setEmbedReferrer() { },
    async extract() {
      throw new ExtractException('the host extractor spoke', 'its own hint', codeName);
    },
  };
}

test('a host that did not answer is not asked twice by a second reader', async () => {
  for (const code of ['gated', 'api_down', 'host_down', 'resolve_failed', 'timeout', 'http_503']) {
    const http = new FakeHttp({});
    await assert.rejects(() => Analyzer.runExtractor(hostExtractor(code), 'https://cloudfam.io/v/x', http, null), (err) => {
      assert.equal(err.codeName, code, code + ' is fatal: a generic read of the same address costs the visitor another '
        + 'round of requests to the host that already refused');
      assert.equal(err.message, 'the host extractor spoke', 'and the visitor keeps the words the host extractor chose');
      return true;
    });
    assert.equal(http.calls.length, 0, code + ' never reaches the second reader');
  }
});

test('a page that parsed to nothing still gets the generic read', async () => {
  const page = 'https://cloudfam.io/v/quiet';
  const clip = 'https://cdn.example.org/v.mp4';
  const http = new FakeHttp({
    [page]: [res(200, '<html><body>player.src("https://cdn.example.org/v.mp4")</body></html>', {}, 'text/html', page)],
    [clip]: [res(200, '', { 'content-length': '4000000' }, 'video/mp4')],
  });
  const bundle = await Analyzer.runExtractor(hostExtractor('no_media'), page, http, null);
  assert.deepEqual(bundle.sources.map((s) => s.url), [clip], 'the failure was about the page, so the page is read again');
  assert.equal(bundle.provider, 'cloudfam', 'and the host that owns the link still owns the name on the card');
});

test('a throwable that is not an extractor refusal stays fatal', async () => {
  const ex = { name: () => 'cloudfam', setEmbedReferrer() { }, async extract() { throw new Error('a bug'); } };
  await assert.rejects(() => Analyzer.runExtractor(ex, 'https://cloudfam.io/v/x', new FakeHttp({}), null), /a bug/);
});

test('luluvido: a refused page says what the visitor can still do, and asks once', async () => {
  const { LuluvidoExtractor } = await import('../src/extractor/luluvidoExtractor.mjs');
  for (const status of [401, 403]) {
    const url = 'https://luluvido.com/ielty32jjdm' + status;
    const http = new FakeHttp({ [url]: [res(status, '<html>blocked</html>', {}, 'text/html', url)] });
    await assert.rejects(() => new LuluvidoExtractor().extract(url, http), (err) => {
      assert.equal(err.codeName, 'gated', status + ' is their browser check, not a removed video');
      assert.equal(err.message, 'That site checks the browser that opens it.');
      assert.match(err.hint, /Stream address/, 'the hint is the route that works from the visitor side');
      assert.doesNotMatch(err.hint, /paste the address of the page that shows the player/,
        'the address they hold is the one that was just refused');
      return true;
    });
    assert.equal(http.calls.length, 1, 'one request: a second reader of the same address gets the same answer');
  }
});
