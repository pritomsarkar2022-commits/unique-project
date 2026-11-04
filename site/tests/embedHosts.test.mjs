import test from 'node:test';
import assert from 'node:assert/strict';

import { BaseExtractor } from '../src/extractor/baseExtractor.mjs';
import { GenericExtractor } from '../src/extractor/genericExtractor.mjs';
import { ExtractorRegistry } from '../src/extractor/extractorRegistry.mjs';
import { StreamfileExtractor } from '../src/extractor/streamfileExtractor.mjs';
import { FirestreamExtractor } from '../src/extractor/firestreamExtractor.mjs';
import { LuluvidoExtractor } from '../src/extractor/luluvidoExtractor.mjs';
import { Analyzer } from '../src/extractor/analyzer.mjs';
import { embedReferrerOf } from '../src/extractor/embedReferrer.mjs';
import { HttpResponse } from '../src/net/httpResponse.mjs';
import { ExtractException } from '../src/errors.mjs';

/**
 * The three hosts that changed shape after the port was written, and the two
 * abilities they turned up: a stream that only arrives with the player (a POST and a
 * packed script, not the page markup) and an embed address whose referrer belongs to
 * the page holding it.
 *
 * Same stub client as extractors.test.mjs: every byte these extractors send and read
 * is scripted, so a passing test is a transcript, not a visit.
 */
class FakeHttp {
  constructor(replies = {}, remaining = 12) {
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

function res(status, body = '', headers = {}, contentType = '', finalUrl = 'https://files.example.org/x.mp4') {
  const lowered = {};
  for (const [k, v] of Object.entries(headers)) {
    lowered[k.toLowerCase()] = v;
  }
  return new HttpResponse(status, body, lowered, contentType, finalUrl, body.length);
}

/**
 * A Dean Edwards packed script with the url inside it: index 1 is "hls2", index 2 is
 * "https", so the packed body reads 2://host/1/master.m3u8 and the reader has to
 * substitute to see it. This is the shape the luluvido and streamfile players ship.
 */
function packedSample(url) {
  const packed = 'var f="' + url.replace(/https/g, '2').replace(/hls2/g, '1') + '";';
  return "<script type='text/javascript'>eval(function(p,a,c,k,e,d){while(c--)"
    + "if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}"
    + "('" + packed + "',36,3,'|hls2|https'.split('|')))</script>";
}

const SF_PAGE = 'https://streamfile.net/5fiez7fe88ld.html';
const SF_PASTED = 'https://streamfiles.net/5fiez7fe88ld.html';
const SF_DL = 'https://streamfile.net/dl';
const SF_M3U8 = 'https://fs1.streamfiles.site/hls2/01/00003/,5fiez7fe88ld_l,.urlset/master.m3u8?t=UcSo9x&s=1793813448&e=18000';
const MEDIA_PL = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXTINF:10,', 'a1.ts', '#EXT-X-ENDLIST'].join('\n');

test('the plural streamfiles.net is the streamfile reader, not the generic one', async () => {
  const registry = await ExtractorRegistry.create();
  const ex = await registry.forUrl(SF_PASTED);
  assert.equal(ex.constructor.phpClass, 'StreamfileExtractor');
  assert.equal((await registry.forUrl('https://frstream.life/e/_-8OHH3J')).constructor.phpClass, 'FirestreamExtractor');
});

test('streamfile asks the host for its player when the page shows none', async () => {
  const http = new FakeHttp({
    // the visitor pasted the plural; the host 301s the reader onto the singular page
    [SF_PASTED]: [res(200, '<html><body>a poster only</body></html>', {}, 'text/html', SF_PAGE)],
    [SF_DL]: [res(200, JSON.stringify({ ad_code: '', js: packedSample(SF_M3U8) }), {}, 'application/json', SF_DL)],
    [SF_M3U8]: [res(200, MEDIA_PL, {}, 'application/vnd.apple.mpegurl', SF_M3U8)],
  });
  const bundle = await new StreamfileExtractor().extract(SF_PASTED, http);

  assert.equal(bundle.sources.length, 1);
  assert.equal(bundle.sources[0].url, SF_M3U8, 'the comma-laden signed path survived the match');
  const call = http.calls.find((c) => c.post !== undefined);
  assert.equal(call.url, SF_DL, 'the player is asked for the way a click asks');
  assert.match(call.post, /^op=play&file_code=5fiez7fe88ld&embed=0&u=https%3A%2F%2Fstreamfile\.net%2F5fiez7fe88ld\.html&ref=$/);
  assert.equal(call.opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(call.opts.headers.Referer, SF_PAGE, 'the POST comes from the page it belongs to');
});

test('a page that already names the playlist never pays for the player request', async () => {
  const http = new FakeHttp({
    [SF_PAGE]: [res(200, '<video><source src="' + SF_M3U8 + '"></video>', {}, 'text/html', SF_PAGE)],
    [SF_M3U8]: [res(200, MEDIA_PL, {}, 'application/vnd.apple.mpegurl', SF_M3U8)],
  });
  const bundle = await new StreamfileExtractor().extract(SF_PAGE, http);
  assert.equal(bundle.sources[0].url, SF_M3U8);
  assert.equal(http.calls.filter((c) => c.url === SF_DL).length, 0);
});

test('a /dl that will not answer leaves the old behaviour intact', async () => {
  const http = new FakeHttp({
    [SF_PAGE]: [res(200, '<html><body>nothing</body></html>', {}, 'text/html', SF_PAGE)],
    [SF_DL]: [res(404, 'nope', {}, 'text/html', SF_DL)],
  });
  await assert.rejects(() => new StreamfileExtractor().extract(SF_PAGE, http), (e) => e.codeName === 'no_media');
});

test('frstream.life resolves through the firestream token, slug and all', async () => {
  const page = 'https://frstream.life/e/_-8OHH3J';
  const mp4 = 'https://encoder-de-temp-0.firestream.to/uploads/68b5/d693.mp4?md5=5r9u&expires=1793820613';
  const http = new FakeHttp({
    [page]: [res(200, '<html><script id="token-blob" type="text/plain"> ytgtIp7KlB== </script></html>', {}, 'text/html', page)],
    'https://frstream.life/api/videos/_-8OHH3J/resolve': [
      res(200, JSON.stringify({ signedVideoUrl: mp4, signedVideoSdUrl: null }), {}, 'application/json'),
    ],
    [mp4]: [res(206, 'x', { 'content-range': 'bytes 0-0/35788016', 'content-length': '1' }, 'video/mp4')],
  });
  const bundle = await new FirestreamExtractor().extract(page, http);
  assert.equal(bundle.sources[0].url, mp4);
  assert.equal(bundle.sources[0].sizeBytes, 35788016, 'the real size came back from the probe');
  const post = http.calls.find((c) => c.post !== undefined);
  assert.deepEqual(JSON.parse(post.post), { blob: 'ytgtIp7KlB==' }, 'the single-use blob is posted as their app posts it');
});

test('a luluvido link that is only a frame reads the player inside it', async () => {
  const outer = 'https://luluvido.com/35dosti0m24r';
  const inner = 'https://luluvido.com/e/35dosti0m24r';
  const m3u8 = 'https://iztwj4ujaovv.tnmr.org/hls2/02/04649/35dosti0m24r_h/master.m3u8?t=Dh66E&s=1793813168&e=28800';
  const keyed = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="https://iztwj4ujaovv.tnmr.org/k.key"', '#EXTINF:10,', 'a1.ts', '#EXT-X-ENDLIST'].join('\n');
  const http = new FakeHttp({
    [outer]: [res(200, '<html><body><iframe src="/e/35dosti0m24r" width="640"></iframe></body></html>', {}, 'text/html', outer)],
    [inner]: [res(200, '<html><body>' + packedSample(m3u8) + '</body></html>', {}, 'text/html', inner)],
    [m3u8]: [res(200, keyed, {}, 'application/vnd.apple.mpegurl', m3u8)],
  });
  const bundle = await new LuluvidoExtractor().extract(outer, http);
  assert.equal(bundle.sources[0].url, m3u8, 'the stream the framed player names');
  assert.equal(bundle.finalUrl, inner, 'and the document it came from is what the record carries');
  assert.equal(http.calls.filter((c) => c.url === outer).length, 1, 'the wrapper is read once');
  assert.match(http.calls.find((c) => c.url === inner).opts.headers.Referer, /luluvido\.com/, 'the frame is opened as the page that holds it');
  assert.deepEqual(bundle.notices, ['This stream is AES-128 encrypted in transit. Preview works, and the MP4 save decrypts it as it goes.']);
});

test('the wrapper does not chase itself when the frame is the page it already read', async () => {
  const outer = 'https://luluvido.com/e/35dosti0m24r';
  const http = new FakeHttp({
    [outer]: [res(200, '<html><body><iframe src="' + outer + '"></iframe></body></html>', {}, 'text/html', outer)],
  });
  await assert.rejects(() => new LuluvidoExtractor().extract(outer, http), (e) => e.codeName === 'no_media');
  assert.equal(http.calls.length, 1, 'one document, no loop');
});

test('the page that holds an embed is the referrer of the request for it', () => {
  assert.equal(embedReferrerOf('https://frstream.life/e/_-8OHH3J?parent_ref=https%3A%2F%2Fmmshunt.net%2F'), 'https://mmshunt.net/');
  assert.equal(embedReferrerOf('https://p.example/v/1?ref=https%3A%2F%2Fa.example%2Fw%2F2&t=1'), 'https://a.example/w/2');
  assert.equal(embedReferrerOf('https://p.example/v/1?parent_ref=not-a-url'), null, 'a bare word is not a referrer');
  assert.equal(embedReferrerOf('https://p.example/v/1?ref=javascript%3Aalert%281%29'), null, 'and neither is a script');
  assert.equal(embedReferrerOf('https://p.example/v/1?ref=https%3A%2F%2Fuser%3Apass%40a.example%2F'), null, 'credentials never travel in a referrer');
  assert.equal(embedReferrerOf('https://p.example/v/1'), null, 'an ordinary link names no parent');
  assert.equal(embedReferrerOf('not a link at all'), null);

  const ex = new BaseExtractor('StreamfileExtractor');
  assert.deepEqual(ex.pageHeaders('https://p.example/v/1'), { Referer: 'https://p.example/v/1' });
  ex.setEmbedReferrer('https://mmshunt.net/');
  assert.deepEqual(ex.pageHeaders('https://p.example/v/1'), { Referer: 'https://mmshunt.net/' });
});

test('runExtractor hands the parent to the host reader and to its own generic retry', async () => {
  const seen = [];
  const proto = GenericExtractor.prototype;
  const original = proto.setEmbedReferrer;
  proto.setEmbedReferrer = function spy(url) { seen.push(url); return original.call(this, url); };
  const page = 'https://p.example/e/1?parent_ref=https%3A%2F%2Fmmshunt.net%2F';
  const stub = new BaseExtractor('VixeoExtractor');
  stub.extract = async () => { throw new ExtractException('nothing here', '', 'no_media'); };
  const http = new FakeHttp({ [page]: [res(404, '', {}, 'text/html', page)] });
  try {
    await assert.rejects(() => Analyzer.runExtractor(stub, page, http, null), (e) => e.codeName === 'not_found');
  } finally {
    proto.setEmbedReferrer = original;
  }
  assert.deepEqual(seen, ['https://mmshunt.net/'], 'the generic retry was told too');
  assert.equal(stub.embedReferrer, 'https://mmshunt.net/');
  assert.deepEqual(http.calls[0].opts.headers, { Referer: 'https://mmshunt.net/' });
});
