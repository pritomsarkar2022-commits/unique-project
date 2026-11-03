import { Diff, oracleRun, phpAvailable, makeRng } from './harness.mjs';
import { MediaSniffer } from '../site/src/extractor/mediaSniffer.mjs';
import { MediaBundle } from '../site/src/extractor/mediaBundle.mjs';
import { Source } from '../site/src/extractor/source.mjs';

/**
 * Differential suite for the media-discovery core: MediaSniffer, Source and
 * MediaBundle. Everything is compared against the php original through
 * parity/oracle-media.php. Byte payloads travel base64-wrapped (inputs as
 * {_b64:...}, outputs as {~b:...}) so invalid-utf8 fuzz survives the json round
 * trip, and every ordered list (candidates, mediaUrls, playerPages, config pairs)
 * is diffed in order.
 */

if (!phpAvailable()) {
  console.log('SKIPPED: no PHP binary, so nothing was compared. Set PHP_BIN to the reference build.');
  process.exit(0);
}

// ---------------------------------------------------------------- transport

const B64_KEYS = new Set(['text', 'html', 'base', 'url', 't', 'u']);
const b64wrap = (s) => ({ _b64: Buffer.from(String(s), 'latin1').toString('base64') });

/** Rebuild the exact field set the oracle wraps with raw(); nested url rows too. */
function wrapArgs(fn, args) {
  const out = {};
  for (const k of Object.keys(args)) {
    out[k] = B64_KEYS.has(k) && typeof args[k] === 'string' ? b64wrap(args[k]) : args[k];
  }
  if (fn === 'bundle_add_source') out.urls = args.urls.map((o) => ({ url: b64wrap(o.url), kind: o.kind }));
  if (fn === 'bundle_best') {
    out.sources = args.sources.map((o) => ({ url: b64wrap(o.url), kind: o.kind, height: o.height ?? null }));
  }
  return out;
}

/** Fold every {~b:...} the oracle tagged back into a latin1 byte string. */
function unwrap(v) {
  if (Array.isArray(v)) return v.map(unwrap);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '~b' && typeof v['~b'] === 'string') {
      return Buffer.from(v['~b'], 'base64').toString('latin1');
    }
    const o = {};
    for (const k of keys) o[k] = unwrap(v[k]);
    return o;
  }
  return v;
}

function srcSummary(s) {
  return { url: s.url, kind: s.kind, id: s.id, score: s.score };
}

/** Mirror of every oracle-media.php case, run on the plain (already-latin1) args. */
function jsCall(fn, args) {
  switch (fn) {
    case 'media_urls': return MediaSniffer.mediaUrls(args.text);
    case 'clean': return MediaSniffer.clean(args.u);
    case 'sources_from_text':
      return MediaSniffer.sourcesFromText(args.text, args.base, args.headers || []).map(srcSummary);
    case 'kind_of': return MediaSniffer.kindOf(args.url);
    case 'meta': return MediaSniffer.meta(args.html, args.base);
    case 'tidy': return MediaSniffer.tidy(args.t);
    case 'candidates':
      return MediaSniffer.candidates(args.text, args.base, args.headers || []).map(srcSummary);
    case 'base_href': return MediaSniffer.baseHref(args.html);
    case 'tag_urls': return MediaSniffer.tagUrls(args.html);
    case 'data_attribute_urls': return MediaSniffer.dataAttributeUrls(args.html);
    case 'jsonld_urls': return MediaSniffer.jsonLdUrls(args.html);
    case 'jsonld_embed_pages': return MediaSniffer.jsonLdEmbedPages(args.html);
    case 'jsonld_values': return MediaSniffer.jsonLdValues(args.html, args.wanted);
    case 'config_key_urls': return [...MediaSniffer.configKeyUrls(args.text).entries()];
    case 'looks_like_endpoint': return MediaSniffer.looksLikeEndpoint(args.url);
    case 'ad_penalty': return MediaSniffer.adPenalty(args.url);
    case 'player_pages': return MediaSniffer.playerPages(args.html, args.base);
    case 'config_endpoints': return MediaSniffer.configEndpoints(args.html, args.base, args.limit ?? 3);
    case 'source_make': return srcSummary(Source.make(args.url, args.kind ?? Source.MP4));
    case 'source_is_video': { const s = new Source(); s.kind = args.kind; return s.isVideo(); }
    case 'source_token_expiry': {
      const s = Source.make(args.url, Source.MP4);
      s.tokenExpiryFromQuery();
      return s.tokenExpiresAt;
    }
    case 'source_to_array': {
      const s = Source.make(args.url, args.kind ?? Source.MP4);
      for (const f of ['label', 'height', 'bitrate', 'sizeBytes', 'mime', 'tokenExpiresAt',
        'needsProxy', 'duration', 'note', 'variants']) {
        if (f in args) s[f] = args[f];
      }
      return s.toArray();
    }
    case 'bundle_add_source': {
      const b = new MediaBundle();
      for (const o of args.urls) b.addSource(Source.make(o.url, o.kind ?? Source.MP4));
      return b.sources.map((s) => s.url);
    }
    case 'bundle_best': {
      const b = new MediaBundle();
      for (const o of args.sources) {
        const s = Source.make(o.url, o.kind ?? Source.MP4);
        s.height = o.height ?? null;
        b.addSource(s);
      }
      const best = b.best();
      return best ? best.url : null;
    }
    case 'bundle_notice': {
      const b = new MediaBundle();
      for (const m of args.msgs) b.notice(m);
      return b.notices;
    }
    default: throw new Error('unknown fn ' + fn);
  }
}

const d = new Diff();
const probes = [];
const checks = [];
const seen = new Set();

/**
 * Both sides speak php's byte strings, so a fixture literal carrying a real '—'
 * has to arrive as its three utf8 bytes, or the port sees one invalid-utf8 byte
 * where php sees a correct multi-byte character.
 */
function toBytes(s) {
  return /[^\u0000-\u00FF]/.test(s) ? Buffer.from(s, 'utf8').toString('latin1') : s;
}

function normArg(k, v) {
  if (B64_KEYS.has(k) && typeof v === 'string') {
    return toBytes(v);
  }
  if ((k === 'urls' || k === 'sources') && Array.isArray(v)) {
    return v.map((o) => (o && typeof o.url === 'string' ? { ...o, url: toBytes(o.url) } : o));
  }
  return v;
}

function probe(id, fn, args) {
  if (seen.has(id)) throw new Error('duplicate probe id ' + id);
  seen.add(id);
  const norm = {};
  for (const k of Object.keys(args)) {
    norm[k] = normArg(k, args[k]);
  }
  probes.push({ id, fn, args: wrapArgs(fn, norm) });
  checks.push({ id, fn, args: norm });
}

// ---------------------------------------------------------------- mediaUrls
probe('mu/mp4', 'media_urls', { text: 'see https://cdn.example.com/v.mp4 end' });
probe('mu/m3u8', 'media_urls', { text: 'a https://a.com/h/master.m3u8 b' });
probe('mu/webm', 'media_urls', { text: 'x http://x.webm.io/movie.webm?k=v y' });
probe('mu/mkv', 'media_urls', { text: 'x https://x/y.mkv y' });
probe('mu/ts', 'media_urls', { text: 'x https://x/seg-1.ts?auth=abc y' });
probe('mu/upper', 'media_urls', { text: 'HTTP://A.COM/MOVIE.MP4' });
probe('mu/protorel', 'media_urls', { text: 'href=//cdn.example.com/hls/master.m3u8 x' });
probe('mu/two', 'media_urls', { text: 'https://a.mp4/x.mp4 and https://b.com/y.m3u8' });
probe('mu/relmkv', 'media_urls', { text: 'var u="/x.m3u8"; var m="/y.mkv"; var w="/z.webm"; var t="/q.ts";' });
probe('mu/relquote', 'media_urls', { text: "file='/a/b.mp4'" });
probe('mu/empty', 'media_urls', { text: '' });
probe('mu/query300', 'media_urls', { text: 'https://a/x.mp4?' + 'k'.repeat(300) });
probe('mu/querylong', 'media_urls', { text: 'https://a/x.mp4?' + 'k=v&'.repeat(120) });
probe('mu/glued', 'media_urls', { text: 'var a="https://x/a.mp4";var b="https://x/b.mp4"' });
probe('mu/paren', 'media_urls', { text: '(https://x/a.mp4)' });
probe('mu/tagstop', 'media_urls', { text: '<a href="https://x/a.mp4">go</a>' });
probe('mu/nonmediaext', 'media_urls', { text: 'https://x/y.css https://x/z.js https://x/w.php' });
probe('mu/dedup', 'media_urls', { text: 'https://x/a.mp4 https://x/a.mp4' });
probe('mu/sortlen', 'media_urls', { text: 'https://x/a.mp4 https://x/longer/path/b.mp4 https://x/ev.mp4' });

// ---------------------------------------------------------------- clean
probe('cl/quotes', 'clean', { u: '"https://a/b.mp4";' });
probe('cl/comma', 'clean', { u: 'https://a/b.mp4,' });
probe('cl/semi', 'clean', { u: 'https://a/b.mp4;' });
probe('cl/protorel', 'clean', { u: '//x.io/a.mp4' });
probe('cl/blank', 'clean', { u: '   ' });
probe('cl/backtick', 'clean', { u: '`/a/b.mp4`' });
probe('cl/tab', 'clean', { u: '\thttps://a/b.mp4\t' });

// ---------------------------------------------------------------- kindOf
probe('ko/mp4', 'kind_of', { url: 'https://x/y.mp4?z=1' });
probe('ko/hls', 'kind_of', { url: 'https://x/master.m3u8' });
probe('ko/webm', 'kind_of', { url: 'https://x/y.webm' });
probe('ko/mkv', 'kind_of', { url: 'https://x/y.mkv' });
probe('ko/ts', 'kind_of', { url: 'https://x/y.ts?a=1' });
probe('ko/upper', 'kind_of', { url: 'https://x/Y.MP4' });
probe('ko/none', 'kind_of', { url: 'https://x/index.php' });
probe('ko/streamdir', 'kind_of', { url: 'https://x/stream/' });
probe('ko/dotdir', 'kind_of', { url: 'https://x/hls.d' });
probe('ko/dash', 'kind_of', { url: 'https://x/dash/' });
probe('ko/playlistphp', 'kind_of', { url: 'https://x/playlist.php' });
probe('ko/m3u', 'kind_of', { url: 'https://x/index.m3u' });
probe('ko/css', 'kind_of', { url: 'https://x/y.css' });
probe('ko/noext', 'kind_of', { url: 'https://x/watch/movie' });
probe('ko/empty', 'kind_of', { url: '' });
probe('ko/schemeless', 'kind_of', { url: 'a/master.m3u8' });
probe('ko/queryonly', 'kind_of', { url: 'https://x.mp4' });
probe('ko/trailing', 'kind_of', { url: 'https://x/a.mp4.' });

// ---------------------------------------------------------------- meta
probe('meta/ogvalt', 'meta', { html: '<meta property="og:video:alt" content="Big Buck | CloudFam">', base: 'https://x/p.html' });
probe('meta/ogtitle', 'meta', { html: '<meta property="og:title" content="A Movie">', base: 'https://x/' });
probe('meta/titletag', 'meta', { html: '<title>Plain Title</title>', base: 'https://x/' });
probe('meta/ogimage', 'meta', { html: '<meta property="og:image" content="/thumb.jpg">', base: 'https://x/dir/p.html' });
probe('meta/imgjson', 'meta', { html: '{"image": "https://x/thumb.jpg"}', base: 'https://x/' });
probe('meta/imgjs', 'meta', { html: "image: 'https://x/thumb.jpg'", base: 'https://x/' });
probe('meta/empty', 'meta', { html: '', base: 'https://x/' });
probe('meta/entity', 'meta', { html: '<meta property="og:title" content="Tom &amp; Jerry &#65;">', base: 'https://x/' });

// ---------------------------------------------------------------- tidy (valid utf8 only)
probe('tidy/pipe', 'tidy', { t: 'Movie | CloudFam' });
probe('tidy/at', 'tidy', { t: 'Movie at Streamtape.com' });
probe('tidy/on', 'tidy', { t: 'Movie on MixDrop.co' });
probe('tidy/hostdash', 'tidy', { t: 'streamtape.com — My Film' });
probe('tidy/named', 'tidy', { t: 'CloudFam - My Film' });
probe('tidy/prefix', 'tidy', { t: 'Watch Online — Movie' });
probe('tidy/verify', 'tidy', { t: 'Stream Verification - Please wait' });
probe('tidy/edgedash', 'tidy', { t: '———  Title  ———' });
probe('tidy/ws', 'tidy', { t: '  Hi   there\tthere  ' });
probe('tidy/nl', 'tidy', { t: 'Hi\nthere\r\nend\f' });
probe('tidy/vt', 'tidy', { t: 'Hi\x0Bthere\x0Cend' });
probe('tidy/trailingnl', 'tidy', { t: 'Title|Suffix\n' });
probe('tidy/emdash', 'tidy', { t: 'A — B – C' });
probe('tidy/multiword', 'tidy', { t: 'A | B | C' });
probe('tidy/empty', 'tidy', { t: '' });
probe('tidy/onlypipe', 'tidy', { t: '|' });
probe('tidy/onlydash', 'tidy', { t: '-' });
probe('tidy/mixdrop', 'tidy', { t: 'Mxdrop — Film Name' });
probe('tidy/cloudfam', 'tidy', { t: 'Dupload — Movie Title here' });
probe('tidy/download', 'tidy', { t: 'Download — The Film' });
probe('tidy/embed', 'tidy', { t: 'Embed Player | Foo' });
probe('tidy/longtail', 'tidy', { t: 'Title' + '| aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

// ---------------------------------------------------------------- baseHref
probe('bh/basic', 'base_href', { html: '<base href="https://cdn.example.com/">' });
probe('bh/entity', 'base_href', { html: '<base href="https://a.com/?x=1&amp;y=2">' });
probe('bh/short', 'base_href', { html: '<base href="ab">' });
probe('bh/none', 'base_href', { html: '<html></html>' });
probe('bh/rel', 'base_href', { html: '<base href="/player/">' });
probe('bh/order', 'base_href', { html: '<base target="_blank" href="https://x/p/">' });

// ---------------------------------------------------------------- tagUrls
probe('tu/ogv', 'tag_urls', { html: '<meta property="og:video" content="https://x/v.mp4">' });
probe('tu/twitter', 'tag_urls', { html: '<meta name="twitter:player:stream" content="https://x/v.mp4">' });
probe('tu/videosrc', 'tag_urls', { html: '<video src="https://x/v.mp4"></video>' });
probe('tu/sourcesrcset', 'tag_urls', { html: '<source srcset="https://x/v.webm 1280w">' });
probe('tu/sourceboth', 'tag_urls', { html: '<source src="https://x/a.mp4" srcset="https://x/b.webm 640w">' });
probe('tu/anchor', 'tag_urls', { html: '<a href="https://x/download.mkv">DL</a>' });
probe('tu/anchorpage', 'tag_urls', { html: '<a href="https://x/page">Home</a>' });
probe('tu/link', 'tag_urls', { html: '<link rel="alternate" type="application/x-mpegURL" href="https://x/master.m3u8">' });
probe('tu/embedobject', 'tag_urls', { html: '<embed src="https://x/p.mp4"><object data="https://x/q.mp4"></object>' });
probe('tu/entity', 'tag_urls', { html: '<meta property="og:video" content="https://x/v.mp4?a=1&amp;b=2">' });
probe('tu/datalazy', 'tag_urls', { html: '<video data-src="https://x/lazy.mp4"></video>' });
probe('tu/mediacontent', 'tag_urls', { html: '<meta property="media:content" content="https://x/m.mp4">' });
probe('tu/dedup', 'tag_urls', { html: '<source src="https://x/a.mp4"><source src="https://x/a.mp4">' });

// ---------------------------------------------------------------- dataAttributeUrls
probe('da/video', 'data_attribute_urls', { html: '<div data-video="https://x/v.mp4"></div>' });
probe('da/comma', 'data_attribute_urls', { html: '<div data-src="/a.mp4,/b.mp4"></div>' });
probe('da/nonmedia', 'data_attribute_urls', { html: '<div data-foo="https://x/v.mp4"></div>' });
probe('da/rel', 'data_attribute_urls', { html: '<div data-video="/only/rel.ts"></div>' });
probe('da/space', 'data_attribute_urls', { html: '<div data-mp4="/a.mp4 /b.mp4"></div>' });
probe('da/encoded', 'data_attribute_urls', { html: '<div data-hls="https://x/m.m3u8?a=1&amp;b=2"></div>' });
probe('da/embed', 'data_attribute_urls', { html: '<div data-embed-src="https://x/e.mp4"></div>' });

// ---------------------------------------------------------------- jsonLd
probe('jld/content', 'jsonld_urls', { html: '<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://x/v.mp4"}</script>' });
probe('jld/embed', 'jsonld_embed_pages', { html: '<script type="application/ld+json">{"@type":"VideoObject","embedUrl":"https://x/embed"}</script>' });
probe('jld/nonvideo', 'jsonld_urls', { html: '<script type="application/ld+json">{"@type":"Article","contentUrl":"https://x/v.mp4"}</script>' });
probe('jld/arraytop', 'jsonld_urls', { html: '<script type="application/ld+json">[{"@type":"VideoObject","contentUrl":"https://x/v.mp4"}]</script>' });
probe('jld/values', 'jsonld_values', { html: '<script type="application/json">{"@type":"MediaObject","contentUrl":"https://x/v.mp4","streamUrl":"https://x/s.m3u8"}</script>', wanted: ['contenturl', 'streamurl'] });
probe('jld/entity', 'jsonld_urls', { html: '<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://x/v.mp4?a=1&amp;b=2"}</script>' });
probe('jld/nested', 'jsonld_urls', { html: '<script type="application/ld+json">{"@type":"VideoObject","subjectOf":{"videoUrl":"https://x/deep.mp4"}}</script>' });
probe('jld/arrayfield', 'jsonld_urls', { html: '<script type="application/ld+json">{"@type":"VideoObject","mp4Url":["https://x/a.mp4","https://x/b.mp4"]}</script>' });
probe('jld/noblock', 'jsonld_urls', { html: '<p>no json here</p>' });
probe('jld/badjson', 'jsonld_urls', { html: '<script type="application/ld+json">{not json</script>' });

// ---------------------------------------------------------------- configKeyUrls
probe('cku/plain', 'config_key_urls', { text: '{"file":"https://x/v.mp4"}' });
probe('cku/weak', 'config_key_urls', { text: '{"url":"https://x/v.mp4"}' });
probe('cku/coloneq', 'config_key_urls', { text: '{file:"/a.mp4"}' });
probe('cku/single', 'config_key_urls', { text: "{file:'/a.mp4'}" });
probe('cku/sources', 'config_key_urls', { text: '{"sources":[{"file":"https://x/v.mp4"}]}' });
probe('cku/srcset', 'config_key_urls', { text: '{"srcset":"/a.mp4 1280w, /b.mp4 640w"}' });
probe('cku/nolead', 'config_key_urls', { text: 'file:"https://x/v.mp4"' });
probe('cku/skip', 'config_key_urls', { text: '{"nonsense":"https://x/v.mp4"}' });
probe('cku/strongdedup', 'config_key_urls', { text: '{"file":"/a.mp4","fileurl":"/a.mp4"}' });
probe('cku/empty', 'config_key_urls', { text: '' });

// ---------------------------------------------------------------- looksLikeEndpoint
probe('lle/ext', 'looks_like_endpoint', { url: 'https://x/v.mp4' });
probe('lle/extunk', 'looks_like_endpoint', { url: 'https://x/v.foo' });
probe('lle/deep', 'looks_like_endpoint', { url: 'https://x/a/b/c' });
probe('lle/shallow', 'looks_like_endpoint', { url: 'https://x/y' });
probe('lle/short', 'looks_like_endpoint', { url: 'https://x/ab' });
probe('lle/nopath', 'looks_like_endpoint', { url: 'https://x' });

// ---------------------------------------------------------------- adPenalty
probe('ap/ad', 'ad_penalty', { url: 'https://x/ad/v.mp4' });
probe('ap/ads', 'ad_penalty', { url: 'https://x/ads/v.mp4' });
probe('ap/trailers', 'ad_penalty', { url: 'https://x/trailers/v.mp4' });
probe('ap/trailer', 'ad_penalty', { url: 'https://x/trailer/v.mp4' });
probe('ap/promo', 'ad_penalty', { url: 'https://x/promo/v.mp4' });
probe('ap/prefix', 'ad_penalty', { url: 'https://x/p/ad-x.mp4' });
probe('ap/none', 'ad_penalty', { url: 'https://x/movie/v.mp4' });
probe('ap/wordmid', 'ad_penalty', { url: 'https://x/load/v.mp4' });

// ---------------------------------------------------------------- playerPages
probe('pp/iframe', 'player_pages', { html: '<iframe src="https://x/embed/1"></iframe>', base: 'https://x/p.html' });
probe('pp/samehost', 'player_pages', { html: '<iframe src="https://x/e1"></iframe><iframe src="https://y.example/e2"></iframe>', base: 'https://x/p.html' });
probe('pp/refresh', 'player_pages', { html: '<meta http-equiv="refresh" content="0; url=https://x/go">', base: 'https://x/' });
probe('pp/window', 'player_pages', { html: 'window.location="https://x/hop"', base: 'https://x/' });
probe('pp/windowhref', 'player_pages', { html: 'window.location.href = "https://x/hop"', base: 'https://x/' });
probe('pp/dochref', 'player_pages', { html: 'document.location="https://x/hop"', base: 'https://x/' });
probe('pp/locreplace', 'player_pages', { html: 'location.replace="https://x/hop"', base: 'https://x/' });
probe('pp/skipfile', 'player_pages', { html: '<iframe src="https://x/f.mp4"></iframe>', base: 'https://x/' });
probe('pp/count', 'player_pages', { html: '<iframe src="https://x/e"></iframe><embed src="https://x/e"></embed>', base: 'https://x/' });
probe('pp/rel', 'player_pages', { html: '<iframe src="/embed/rel"></iframe>', base: 'https://x/p.html' });

// ---------------------------------------------------------------- configEndpoints
probe('ce/json', 'config_endpoints', { html: 'fetch("/api/video/get.json")', base: 'https://x/' });
probe('ce/jsonp', 'config_endpoints', { html: 'x = "http://y/get.jsonp"', base: 'https://x/' });
probe('ce/config', 'config_endpoints', { html: 'x = "http://y/config.php"', base: 'https://x/', limit: 3 });
probe('ce/sources', 'config_endpoints', { html: 'x = "http://y/sources/list.php"', base: 'https://x/' });
probe('ce/playlist', 'config_endpoints', { html: 'x = "http://y/playlist.php?a=1"', base: 'https://x/' });
probe('ce/getvideo', 'config_endpoints', { html: 'x = "http://y/getVideo?id=1"', base: 'https://x/' });
probe('ce/api', 'config_endpoints', { html: 'x = "http://y/api/stream?id=1"', base: 'https://x/' });
probe('ce/limit', 'config_endpoints', { html: '"http://y/a.json", "http://y/b.json", "http://y/c.json", "http://y/d.json"', base: 'https://x/', limit: 2 });
probe('ce/short', 'config_endpoints', { html: 'x = "/a.json"', base: 'https://x/' });
probe('ce/none', 'config_endpoints', { html: 'no config here', base: 'https://x/' });

// ---------------------------------------------------------------- candidates (ordering)
probe('ca/jwplayer', 'candidates', { text: 'jwplayer().setup({sources:[{file:"https://cdn.host/movie.mp4",label:"HD"},{file:"/hls/master.m3u8"}]})', base: 'https://site.example/watch' });
probe('ca/flowplayer', 'candidates', { text: "flowplayer({clip:{url:'https://host/clip.mp4'}})", base: 'https://site.example/' });
probe('ca/tags', 'candidates', { text: '<video><source src="https://a/v.mp4"><track src="/x.vtt"></video><iframe src="https://b/emb"></iframe>', base: 'https://a/' });
probe('ca/adpenalty', 'candidates', { text: 'https://cdn/x/promo/teaser.mp4 https://cdn/x/main/movie.mp4', base: 'https://p/' });
probe('ca/endpoint', 'candidates', { text: '{"videoUrl":"https://api.host/stream/get"}', base: 'https://p/' });
probe('ca/master', 'candidates', { text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280\n/seg/master.m3u8\n#EXTINF:10,\nseg-1.ts', base: 'https://cdn.host/p/index.html' });
probe('ca/protocolrel', 'candidates', { text: 'var u="//cdn.host/a.mp4";', base: 'https://p/index.html' });
probe('ca/query', 'candidates', { text: 'https://cdn.host/v.mp4?expires=1700000001&sig=abc', base: 'https://p/' });
probe('ca/nonhttp', 'candidates', { text: 'file:///etc/passwd.mp4 javascript:alert(1) data:text/plain,x', base: 'https://p/' });
probe('ca/dedup', 'candidates', { text: 'https://cdn/v.mp4 <video src="https://cdn/v.mp4"></video>', base: 'https://p/' });
probe('ca/disguised', 'candidates', { text: 'https://x/seg.ts?v=1 https://x/style.css https://x/app.js', base: 'https://p/' });
probe('ca/escaped', 'candidates', { text: '<div data-v="{&quot;file&quot;:&quot;https://x/v.mp4&quot;}">', base: 'https://p/' });
probe('ca/empty', 'candidates', { text: '', base: 'https://p/' });

// ---------------------------------------------------------------- sourcesFromText
probe('sft/basic', 'sources_from_text', { text: 'https://x/a.mp4 https://x/b.m3u8', base: 'https://p/' });
probe('sft/query', 'sources_from_text', { text: 'https://x/a.mp4?expires=1700000001', base: 'https://p/', headers: { Referer: 'https://r/' } });
probe('sft/rel', 'sources_from_text', { text: 'file="/hls/m.m3u8"', base: 'https://p/dir/index.html' });
probe('sft/badhost', 'sources_from_text', { text: 'https://x_y.example/a.mp4', base: 'https://p/' });

// ---------------------------------------------------------------- Source
probe('sm/mp4', 'source_make', { url: 'https://x/v.mp4', kind: Source.MP4 });
probe('sm/hls', 'source_make', { url: 'https://x/master.m3u8', kind: Source.HLS });
probe('sm/long', 'source_make', { url: 'x'.repeat(200), kind: Source.MP4 });
probe('sm/bytes', 'source_make', { url: 'https://x/\xff\xfe.mp4', kind: Source.MP4 });
probe('sv/mp4', 'source_is_video', { kind: 'mp4' });
probe('sv/hls', 'source_is_video', { kind: 'hls' });
probe('sv/ts', 'source_is_video', { kind: 'ts' });
probe('sv/webm', 'source_is_video', { kind: 'webm' });
probe('sv/mkv', 'source_is_video', { kind: 'mkv' });
probe('sv/other', 'source_is_video', { kind: 'dash' });
probe('sv/empty', 'source_is_video', { kind: '' });
probe('ste/none', 'source_token_expiry', { url: 'https://x/v.mp4' });
probe('ste/ts', 'source_token_expiry', { url: 'https://x/v.mp4?expires=1700000001' });
probe('ste/timeout', 'source_token_expiry', { url: 'https://x/v.mp4?timeout=1700000002' });
probe('ste/exp', 'source_token_expiry', { url: 'https://x/v.mp4?exp=1700000003' });
probe('ste/ttl', 'source_token_expiry', { url: 'https://x/v.mp4?ttl=1700000004' });
probe('ste/e', 'source_token_expiry', { url: 'https://x/v.mp4?e=1700000005' });
probe('ste/short', 'source_token_expiry', { url: 'https://x/v.mp4?expires=12345678' });
probe('ste/toolong', 'source_token_expiry', { url: 'https://x/v.mp4?expires=123456789012' });
probe('ste/notnum', 'source_token_expiry', { url: 'https://x/v.mp4?expires=abcdef' });
probe('sta/mp4', 'source_to_array', { url: 'https://x/v.mp4' });
probe('sta/hls', 'source_to_array', { url: 'https://x/m.m3u8', kind: Source.HLS });
probe('sta/fields', 'source_to_array', {
  url: 'https://x/v.mp4', kind: Source.MP4, label: 'My movie', height: 1080,
  bitrate: 4500, sizeBytes: 1234567890, mime: 'video/mp4', tokenExpiresAt: 1700000000,
  needsProxy: false, duration: 12.34, note: 'hi', variants: [],
});
probe('sta/variants', 'source_to_array', {
  url: 'https://x/m.m3u8', kind: Source.HLS,
  variants: [{ height: 720, bandwidth: 1500000, codecs: 'avc1.4d401f', segments: 12, duration: 10.5, encrypted: true }],
});
probe('sta/dash', 'source_to_array', { url: 'https://x/y.dash', kind: 'dash' });

// ---------------------------------------------------------------- MediaBundle
probe('bs/add', 'bundle_add_source', { urls: [
  { url: 'https://x/a.mp4', kind: Source.MP4 },
  { url: 'https://x/b.mp4', kind: Source.MP4 },
  { url: 'https://x/a.mp4', kind: Source.MP4 },
] });
probe('bs/bestmp4', 'bundle_best', { sources: [
  { url: 'https://x/hls', kind: Source.HLS, height: 720 },
  { url: 'https://x/mp4', kind: Source.MP4, height: 480 },
] });
probe('bs/bestheight', 'bundle_best', { sources: [
  { url: 'https://x/1080', kind: Source.MP4, height: 1080 },
  { url: 'https://x/720', kind: Source.MP4, height: 720 },
  { url: 'https://x/4k', kind: Source.MP4, height: 2160 },
] });
probe('bs/bestnull', 'bundle_best', { sources: [] });
probe('bs/bestnonvideo', 'bundle_best', { sources: [{ url: 'https://x/a', kind: 'dash', height: 10 }] });
probe('bs/besttie', 'bundle_best', { sources: [
  { url: 'https://x/a', kind: Source.TS, height: null },
  { url: 'https://x/b', kind: Source.TS, height: null },
  { url: 'https://x/c', kind: Source.TS, height: null },
] });
probe('bn/dedupe', 'bundle_notice', { msgs: ['slow', 'slow', 'DRM', 'slow'] });

// ---------------------------------------------------------------- constant tables (local)
{
  const ek = Object.keys(MediaSniffer.EXT_KIND);
  d.ok('EXT_KIND order', ek.join(',') === 'm3u8,mp4,webm,mkv,ts', ek.join(','));
  d.ok('EXT_KIND values', MediaSniffer.EXT_KIND.m3u8 === Source.HLS
    && MediaSniffer.EXT_KIND.mp4 === Source.MP4
    && MediaSniffer.EXT_KIND.webm === Source.WEBM
    && MediaSniffer.EXT_KIND.mkv === Source.MKV
    && MediaSniffer.EXT_KIND.ts === Source.TS);
  const sk = Object.keys(MediaSniffer.SCORE);
  d.ok('SCORE order', sk.join(',') === 'regex,link,config,data,jsonld,tag', sk.join(','));
  d.ok('SCORE values', JSON.stringify(Object.values(MediaSniffer.SCORE)) === '[40,50,62,66,76,80]',
    JSON.stringify(Object.values(MediaSniffer.SCORE)));
  const wantFk = ['file', 'files', 'fileurl', 'file_url', 'videourl', 'video_url', 'mp4', 'mp4url',
    'mp4_url', 'hls', 'hlsurl', 'hls_url', 'm3u8', 'stream', 'streamurl', 'stream_url',
    'playbackurl', 'playback_url', 'playurl', 'src', 'srcset', 'sources', 'url'];
  d.ok('FILE_KEYS exact order', JSON.stringify(MediaSniffer.FILE_KEYS) === JSON.stringify(wantFk),
    JSON.stringify(MediaSniffer.FILE_KEYS));
  d.ok('Source kind constants', [Source.MP4, Source.HLS, Source.TS, Source.WEBM, Source.MKV].join(',') === 'mp4,hls,ts,webm,mkv');
}

// ---------------------------------------------------------------- fuzz
const rng = makeRng(20261103);
const BASE = 'https://host.example/page/watch.html';
const pick = (list) => list[Math.floor(rng.r() * list.length)];
const EXT_LIST = ['mp4', 'm3u8', 'webm', 'mkv', 'ts', 'flv', 'css', 'js', 'txt', 'm3u', 'MP4'];
const HOST_LIST = ['cdn.example.com', 'a.b.co', 'x_y.example', '192.168.1.1', '[::1]', 'evil.io',
  'sub.host.example', 'bad..host', 'EXAMPLE.COM', 'toolonghosttoolonghosttoolong.example'];
const AD_WORDS = ['ads', 'advert', 'promo', 'banner', 'spot', 'intro', 'pixel', 'tracker', 'teaser', 'trail', 'trailer'];
const NAMES = ['movie', 'ep01', 'segment', 'hls', 'dash', 'stream', 'playlist', 'master', 'index', 'file', 'video', 'watch', 'embed'];

function randBytes(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(rng.int(0, 255));
  return s;
}
function randPath() {
  const segs = [];
  const c = rng.int(1, 3);
  for (let i = 0; i < c; i++) segs.push(pick(NAMES));
  return '/' + segs.join('/');
}
function randQuery() {
  if (rng.r() < 0.5) return '';
  const parts = [];
  const c = rng.int(0, 3);
  for (let i = 0; i < c; i++) {
    parts.push(pick(['tok', 'auth', 'e', 'expires', 'ttl', 'x']) + '=' + pick(['abc', '%41', '1', '1700000001', '']));
  }
  return '?' + parts.join('&');
}
function randUrl() {
  const prot = pick(['http://', 'https://', '//', '']);
  const host = pick(HOST_LIST);
  const ad = rng.r() < 0.25 ? '/' + pick(AD_WORDS) : '';
  const path = randPath() + '.' + pick(EXT_LIST);
  return prot + host + ad + path + randQuery();
}
const u002f = (u) => u.replace(/[\\]/g, '\\\\').replace(/[/]/g, '\\u002F');

const GEN = [
  () => randUrl(),
  () => 'file:"' + randUrl() + '"',
  () => '<source src="' + randUrl() + '" type="video/mp4">',
  () => "<video src='" + randUrl() + "'></video><track src='/subs/en.vtt'>",
  () => '<iframe src="' + randUrl() + '"></iframe>',
  () => '<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"' + randUrl() + '"}</script>',
  () => '<script type="application/ld+json">{"@type":"VideoObject","embedUrl":"' + randUrl() + '"}</script>',
  () => 'data-video="' + randUrl() + '"',
  () => '"/x.m3u8"',
  () => "'" + randUrl() + "'",
  () => '{"sources":[{"file":"' + randUrl() + '"}]}',
  () => 'var cfg = {file:\'' + randUrl() + '\', label:\'HD\'}',
  () => '#EXTINF:10,' + randUrl() + '\n',
  () => '<base href="' + randUrl() + '">',
  () => '&quot;file&quot;:&quot;' + randUrl() + '&quot;',
  () => 'window.location=\'' + randUrl() + '\'',
  () => '<meta property="og:video" content="' + randUrl() + '">',
  () => '<meta http-equiv="refresh" content="0;url=' + randUrl() + '">',
  () => '"' + randUrl() + 'A'.repeat(rng.int(0, 50)) + '"',
  () => '<video><source srcset="' + randUrl() + ' 1280w, ' + randUrl() + ' 640w">',
  () => 'fetch("/api/video/get.json"); fetch("/playlist.php")',
  () => 'A'.repeat(rng.int(0, 100)) + '<truncated <source src="' + randUrl(),
  () => randBytes(rng.int(1, 40)) + randUrl() + randBytes(rng.int(1, 40)),
  () => 'var escaped = "{&quot;file&quot;:&quot;' + u002f(randUrl()) + '&quot;}"',
  () => '{"sources":[' + '{"file":"' + randUrl() + '"},{"file":"' + randUrl() + '"}]}',
];
const SEPS = ['', ' ', '\n', '<!--x-->', '%%$$%%', '\\', '<>', '\t', '&&', '||'];

const FUZZ_DOCS = process.env.FZ ? Number(process.env.FZ) : 380;
const LONG_DOCS = process.env.FZL ? Number(process.env.FZL) : 40;
for (let i = 0; i < FUZZ_DOCS; i++) {
  const parts = [];
  const n = rng.int(1, 7);
  for (let k = 0; k < n; k++) parts.push(pick(GEN)());
  if (rng.r() < 0.15) parts.push(randBytes(rng.int(1, 24)));
  const doc = parts.join(pick(SEPS));
  const idp = 'fz/' + i;
  probe(idp + '/mu', 'media_urls', { text: doc });
  probe(idp + '/ca', 'candidates', { text: doc, base: BASE });
  probe(idp + '/pp', 'player_pages', { html: doc, base: BASE });
  probe(idp + '/ck', 'config_key_urls', { text: doc });
}

// some long-attribute and repeated-key stress docs
for (let i = 0; i < LONG_DOCS; i++) {
  const u = randUrl();
  const long = u + 'x'.repeat(rng.int(300, 1500));
  const doc = '<div data-video="' + long + '" data-src="/a.mp4">file:"' + u + '" '
    + 'file:"' + u + '" ' + '{"url":"' + long + '"}';
  const idp = 'fzl/' + i;
  probe(idp + '/mu', 'media_urls', { text: doc });
  probe(idp + '/ca', 'candidates', { text: doc, base: BASE });
  probe(idp + '/da', 'data_attribute_urls', { html: doc });
  probe(idp + '/ck', 'config_key_urls', { text: doc });
}

// ---------------------------------------------------------------- run + compare
const results = oracleRun(probes, 'oracle-media.php');

let firstFailure = null;
for (const c of checks) {
  const rec = results.get(c.id);
  if (!rec) {
    d.ok('oracle answered ' + c.id, false, 'no line for this probe');
    continue;
  }
  if (!rec.ok) {
    d.ok('php ran ' + c.id, false, 'php error: ' + rec.err);
    continue;
  }
  let mine;
  try {
    if (process.env.TRACE) console.log('jsCall>', c.id);
    mine = jsCall(c.fn, c.args);
    if (process.env.TRACE) console.log('jsCall<', c.id);
  } catch (e) {
    d.ok('js ran ' + c.id, false, `${e.name}: ${e.message}`);
    continue;
  }
  const before = d.failures.length;
  d.same(c.id, mine, unwrap(rec.res));
  if (d.failures.length > before && firstFailure === null) {
    firstFailure = { id: c.id, fn: c.fn, args: c.args };
  }
}

console.log(`\nmedia parity: ${probes.length} probes (${FUZZ_DOCS + 40} fuzz docs)`);
d.report('MediaSniffer + Source + MediaBundle differential parity');

if (firstFailure) {
  console.log('\nfirst divergence (re-run reproducible via seed 20261103):');
  console.log('  ' + firstFailure.id + ' fn=' + firstFailure.fn);
  console.log('  args=' + JSON.stringify(firstFailure.args).slice(0, 300));
}

process.exit(d.failures.length === 0 ? 0 : 1);
