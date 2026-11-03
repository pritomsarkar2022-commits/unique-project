import { cfg } from '../config.mjs';
import { urlAbsolutize } from '../support.mjs';
import { Source, phpUrlComponent } from './source.mjs';

/**
 * Port of lib/Extractor/MediaSniffer.php.
 *
 * Like Source, every string here is a php byte string carried as one javascript
 * char per byte (latin1), so strlen/substr and the byte-oriented regexes agree
 * with php byte for byte. The regexes are transcribed by hand rather than by a
 * generic translator because php's non-unicode \s, case-folding and $ anchor all
 * differ from javascript's default behaviour.
 */

/** php's non-unicode \s: space plus the five control bytes, nothing more. */
const AWWW = '[\\x09\\x0A\\x0B\\x0C\\x0D\\x20]';
/** php's [^"\'\s]: neither quote nor any byte \s matches (the ] comes from AWWW). */
const NOT_QUOTE_WS = '[^\\x27\\x22' + AWWW.slice(1);
/** the media url "stop" class: \s, both quotes, backtick and the html shell chars. */
const MEDIA_EXCL = '[^\\x27\\x22\\x60\\x3c\\x3e\\x28\\x29\\x7b\\x7d\\x7c\\x5c' + AWWW.slice(1);
/** the rel url "stop" class: \s, both quotes and backtick. */
const REL_EXCL = '[^\\x27\\x22\\x60' + AWWW.slice(1);

const EXT_KIND = {
  m3u8: Source.HLS,
  mp4: Source.MP4,
  webm: Source.WEBM,
  mkv: Source.MKV,
  ts: Source.TS,
};

const SCORE = {
  regex: 40,
  link: 50,
  config: 62,
  data: 66,
  jsonld: 76,
  tag: 80,
};

/** Attribute names a player uses to hand its file url to itself. */
const FILE_KEYS = [
  'file', 'files', 'fileurl', 'file_url', 'videourl', 'video_url', 'mp4', 'mp4url',
  'mp4_url', 'hls', 'hlsurl', 'hls_url', 'm3u8', 'stream', 'streamurl', 'stream_url',
  'playbackurl', 'playback_url', 'playurl', 'src', 'srcset', 'sources', 'url',
];

const AD_TOKENS = ['ad', 'ads', 'advert', 'promo', 'promotion', 'banner', 'spot', 'trailers?', 'intro', 'preload', 'pixel', 'tracker', 'teaser'];

export class MediaSniffer {
  /** @return string[] absolute-ish media urls, most specific first */
  static mediaUrls(text) {
    const out = new Map();
    // (?:https?:)?// + lazy run of non-quote/non-ws bytes + a media extension, with an
    // optional query. Excluding quotes stops minified js gluing two urls together.
    const re = new RegExp(
      '(?:https?:)?//' + MEDIA_EXCL + '+?\\.(?:m3u8|mp4|webm|mkv|ts)(?:\\?' + MEDIA_EXCL + '{0,300})?',
      'gi');
    for (const u of matchAllFull(re, text)) {
      const c = MediaSniffer.clean(u);
      if (c !== '') {
        out.set(c, true);
      }
    }
    // Also catch protocol-relative and root-relative player config values.
    const rel = new RegExp('[\\x27\\x22\\x60](/' + REL_EXCL + '{3,400}?\\.(?:m3u8|mp4|webm|ts)(?:\\?' + REL_EXCL + '{0,300})?)[\\x27\\x22\\x60]', 'gi');
    for (const u of matchAllGroup(rel, text, 1)) {
      out.set(MediaSniffer.clean(u), true);
    }
    const list = [...out.keys()];
    list.sort((a, b) => b.length - a.length); // usort strlen desc; node's sort is stable
    return list.filter((u) => u !== '');
  }

  static clean(u) {
    let s = phpTrimCustom(String(u), " \t\n\r\0\x0B\"'`,;");
    // A url can legitimately end in .mp4 with no scheme inside a js string.
    if (s.startsWith('//')) {
      s = 'https:' + s;
    }
    return s;
  }

  /** @return Source[] */
  static sourcesFromText(text, baseUrl, headers = []) {
    const out = [];
    for (const u of MediaSniffer.mediaUrls(text)) {
      const abs = urlAbsolutize(baseUrl, u);
      // A flattened js string can glue a filename onto the page url, and handing
      // that to the relay would only produce a broken download.
      if (!/^https?:\/\//i.test(abs) || !filterVarUrl(abs)) {
        continue;
      }
      const kind = MediaSniffer.kindOf(abs);
      if (kind === null) {
        continue;
      }
      const s = Source.make(abs, kind);
      s.headers = headers;
      s.tokenExpiryFromQuery();
      out.push(s);
    }
    return out;
  }

  static kindOf(url) {
    const comp = phpUrlComponent(url, 'path');
    const path = comp ? comp : url;
    const ext = asciiLower(pathinfoExtension(String(path)));
    if (ext === '' && new RegExp('/(hls|dash|stream|playlist|master|index)[./]', 'i').test(String(path))) {
      return Source.HLS;
    }
    return Object.prototype.hasOwnProperty.call(EXT_KIND, ext) ? EXT_KIND[ext] : null;
  }

  /** @return {title:?string,thumbnail:?string} */
  static meta(html, baseUrl) {
    const pick = (re) => {
      const m = re.exec(html);
      return m ? phpTrimDefault(htmlEntityDecode(m[1])) : null;
    };
    const title =
      pick(new RegExp('<meta[^>]+property=["\']og:video:alt["\'][^>]+content=["\']([^"\']{2,200})["\']', 'i'))
      ?? pick(new RegExp('<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']{2,200})["\']', 'i'))
      ?? pick(new RegExp('<title[^>]*>([^<]{2,200})</title>', 'i'));
    const thumb =
      pick(new RegExp('<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']{4,400})["\']', 'i'))
      ?? pick(new RegExp('["\']image["\']' + AWWW + '*:' + AWWW + '*["\'](https?:[^"\']{4,400})["\']', 'i'))
      ?? pick(new RegExp('image:' + AWWW + '*["\'](https?://[^"\']{4,400})["\']', 'i'));
    return {
      title: title !== null && title !== '' ? MediaSniffer.tidy(title) : null,
      thumbnail: thumb ? urlAbsolutize(baseUrl, thumb) : null,
    };
  }

  static tidy(t) {
    // The 'u'-flag replaces yield null (-> '' after php's (string) cast) when the
    // title is not valid utf-8; the third replace has no 'u' and runs on raw bytes.
    t = phpTrimDefault(pregReplaceU(new RegExp(AWWW + '+', 'gu'), ' ', t));
    t = pregReplaceU(new RegExp(AWWW + '*\\|' + AWWW + '*[^' + AWWW.slice(1, -1) + '|]{2,26}' + AWWW + '*$', 'gu'), '', t);
    t = String(t).replace(new RegExp(AWWW + '+(?:at|on)' + AWWW + '+[a-z0-9][a-z0-9.-]*\\.[a-z]{2,6}' + AWWW + '*$', 'gi'), '');
    t = pregReplaceU(new RegExp('^(?:[A-Za-z0-9][A-Za-z0-9.-]*\\.[A-Za-z]{2,6}|CloudFam|MixDrop|Mxdrop|Streamtape|Dupload)' + AWWW + '*[\\u2014\\u2013|-]' + AWWW + '*', 'giu'), '', t);
    t = pregReplaceU(new RegExp('^(?:Stream Verification|Watch Online|Watch|Download|Embed Player)' + AWWW + '*[\\u2014\\u2013|-]?' + AWWW + '*', 'giu'), '', t);
    const trimmed = pregReplaceUOrNull(new RegExp('^[\\u2014\\u2013|-]+|[\\u2014\\u2013|-]+$', 'gu'), '', t);
    if (trimmed !== null) {
      t = trimmed;
    }
    return phpTrimCustom(String(t), " \t\0\x0B-|");
  }

  /** @return Source[] ranked by trust, best first */
  static candidates(text, baseUrl, headers = []) {
    let base = baseUrl;
    const href = MediaSniffer.baseHref(text);
    if (href !== null) {
      const abs = urlAbsolutize(baseUrl, href);
      if (/^https?:\/\//i.test(abs)) {
        base = abs;
      }
    }

    /** @var Map<string,{score:int,kind:string}> */
    const found = new Map();
    const add = (u, score, allowEndpoint) => {
      u = MediaSniffer.clean(u);
      if (u === '' || u.length > 1200) {
        return;
      }
      if (new RegExp('^(?:javascript|data|blob|about|mailto|tel|file|chrome|view-source):', 'i').test(u)) {
        return;
      }
      const abs = urlAbsolutize(base, u);
      if (!/^https?:\/\//i.test(abs) || abs.length > 2400 || !filterVarUrl(abs)) {
        return;
      }
      let kind = MediaSniffer.kindOf(abs);
      if (kind === null) {
        if (!allowEndpoint || !MediaSniffer.looksLikeEndpoint(abs)) {
          return;
        }
        // No extension: the file type is whatever the host answers with, and
        // verify() is the one that gets to decide, not this guess.
        kind = Source.MP4;
      }
      const penalised = score - MediaSniffer.adPenalty(abs);
      if (!found.has(abs) || found.get(abs).score < penalised) {
        found.set(abs, { score: penalised, kind });
      }
    };

    for (const u of MediaSniffer.mediaUrls(text)) add(u, SCORE.regex, false);
    for (const u of MediaSniffer.tagUrls(text)) add(u, SCORE.tag, true);
    for (const u of MediaSniffer.jsonLdUrls(text)) add(u, SCORE.jsonld, true);
    for (const u of MediaSniffer.dataAttributeUrls(text)) add(u, SCORE.data, true);
    for (const [u, score] of MediaSniffer.configKeyUrls(text)) add(String(u), phpInt(score), phpInt(score) >= SCORE.config);

    // uasort by score desc, stable; array_slice keeps the surviving key order.
    const rows = [...found.entries()].sort((a, b) => b[1].score - a[1].score);
    const limit = Math.max(4, phpInt(cfg('extract.deep_candidates', 40)));
    const out = [];
    for (const [u, row] of rows.slice(0, limit)) {
      const s = Source.make(String(u), row.kind);
      s.headers = headers;
      s.score = row.score;
      s.tokenExpiryFromQuery();
      out.push(s);
    }
    return out;
  }

  /** The page's own <base href>, which root-relative player paths resolve against. */
  static baseHref(html) {
    const m = new RegExp('<base' + WORD_BOUNDARY + '[^>]+href=["\']([^"\']{4,300})["\']', 'i').exec(html);
    return m ? htmlEntityDecode(m[1]) : null;
  }

  /** @return string[] */
  static tagUrls(html) {
    const out = [];
    const metaKeys = ['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream', 'video:src', 'media:content'];
    for (const tag of matchAllFull(new RegExp('<meta' + WORD_BOUNDARY + '[^>]*>', 'gi'), html)) {
      const k = new RegExp('(?:property|name)=["\']([^"\']+)["\']', 'i').exec(tag);
      if (!k) {
        continue;
      }
      if (!metaKeys.includes(asciiLower(k[1]))) {
        continue;
      }
      const v = new RegExp('content=["\']([^"\']{6,700})["\']', 'i').exec(tag);
      if (v) {
        out.push(htmlEntityDecode(v[1]));
      }
    }

    const tagRe = new RegExp('<(video|source|audio|embed|object|a|link)' + WORD_BOUNDARY + '[^>]*>', 'gi');
    for (const set of matchAllSets(tagRe, html)) {
      const name = asciiLower(set[1]);
      const attrs = name === 'link' || name === 'a' ? ['href']
        : name === 'object' ? ['data']
          : name === 'source' ? ['src', 'srcset']
            : ['src', 'data-src', 'data-file', 'data-video', 'data-mp4', 'data-hls', 'data-url'];
      const mediaOnly = name === 'a' || name === 'link';
      const whole = set[0];
      for (const attr of attrs) {
        const m = new RegExp('(?:^|' + AWWW + ')' + phpPregQuote(attr, '~') + '=["\'](' + NOT_QUOTE_WS + '{6,700})["\']', 'i').exec(whole);
        if (!m) {
          continue;
        }
        const u = htmlEntityDecode(m[1]);
        // A link tag or an anchor only counts when the address itself names a file.
        if (mediaOnly && MediaSniffer.kindOf(u) === null) {
          continue;
        }
        out.push(u);
      }
    }
    return [...new Set(out)];
  }

  /** @return string[] */
  static dataAttributeUrls(html) {
    const out = [];
    const re = new RegExp('\\bdata-(mp4|webm|hls|video|media|source|file|stream|src|url|embed)[a-z0-9_-]*=["\'](' + NOT_QUOTE_WS + '{6,900})["\']', 'gi');
    for (const v of matchAllGroup(re, html, 2)) {
      const dec = htmlEntityDecode(v);
      for (const piece of pregSplit(new RegExp('[,' + AWWW.slice(1) + '+', 'g'), dec)) {
        if (piece === '') {
          continue;
        }
        if (MediaSniffer.kindOf(piece) !== null || new RegExp('^(?:https?:|//|/)', 'i').test(piece)) {
          out.push(piece);
        }
      }
    }
    return [...new Set(out)];
  }

  /** @return string[] file urls, not pages */
  static jsonLdUrls(html) {
    return MediaSniffer.jsonLdValues(html, ['contenturl', 'videourl', 'streamurl', 'mp4url', 'hlsurl']);
  }

  /** The embed page a VideoObject points at, for sites that only publish that. */
  static jsonLdEmbedPages(html) {
    return MediaSniffer.jsonLdValues(html, ['embedurl', 'embed']);
  }

  static jsonLdValues(html, wanted) {
    const out = [];
    const re = new RegExp('<script[^>]+type=["\']application/(?:ld\\+json|json)["\'][^>]*>(.*?)</script>', 'gis');
    for (const json of matchAllGroup(re, html, 1)) {
      const decoded = jsonDecodeAssoc(htmlEntityDecode(json));
      if (decoded !== null && typeof decoded === 'object') {
        walkJsonLd(decoded, wanted, out);
      }
    }
    return [...new Set(out)];
  }

  /** @return Map<string,int> url => score */
  static configKeyUrls(text) {
    const out = new Map();
    const strong = ['file', 'files', 'fileurl', 'file_url', 'videourl', 'video_url', 'mp4', 'mp4url',
      'hls', 'hlsurl', 'hls_url', 'm3u8', 'streamurl', 'stream_url', 'playbackurl', 'playurl', 'sources'];
    const weak = ['src', 'srcset', 'url', 'stream', 'embed', 'embedurl'];
    const re = new RegExp('[{"\\[,' + AWWW.slice(1, -1) + '](["\']?)([a-zA-Z0-9_-]{2,20})\\1' + AWWW + '*[:=]' + AWWW + '*(["\'])([^"\x27\\n]{6,900})\\3', 'g');
    for (const row of matchAllSets(re, text)) {
      const key = asciiLower(row[2]);
      const isStrong = strong.includes(key);
      if (!isStrong && !weak.includes(key)) {
        continue;
      }
      const value = row[4];
      // A sources array holds objects, so scan its text rather than itself.
      if (key === 'sources' && phpTrimDefault(value).startsWith('[')) {
        for (const [u, s] of MediaSniffer.configKeyUrls(value)) {
          out.set(String(u), Math.max(out.has(String(u)) ? out.get(String(u)) : 0, s));
        }
        continue;
      }
      let pieces;
      if (value.includes(',') && key === 'srcset') {
        pieces = value.split(',').map((p) => phpTrimDefault(phpTrimDefault(p).split(' ')[0]));
      } else {
        pieces = [value];
      }
      for (const u of pieces) {
        if (u === '' || !new RegExp('^[A-Za-z0-9_./:%?&=+#-]{6,}$').test(u)) {
          continue;
        }
        const score = isStrong ? SCORE.config : SCORE.link;
        out.set(u, Math.max(out.has(u) ? out.get(u) : 0, score));
      }
    }
    return out;
  }

  static looksLikeEndpoint(url) {
    const comp = phpUrlComponent(url, 'path');
    const path = comp ? comp : '';
    const ext = asciiLower(pathinfoExtension(String(path)));
    if (ext !== '') {
      return ['mp4', 'm3u8', 'webm', 'mkv', 'ts'].includes(ext);
    }
    return substrCount(String(path), '/') >= 2 && String(path).length >= 8;
  }

  static adPenalty(url) {
    const comp = phpUrlComponent(url, 'path');
    const path = asciiLower(String(comp ? comp : ''));
    const re = new RegExp('(?:^|[/_.-])(?:' + AD_TOKENS.join('|') + ')(?:[/_.-]|$)');
    return re.test(path) ? 25 : 0;
  }

  /** @return string[] absolute urls, same-host first */
  static playerPages(html, baseUrl) {
    const out = new Map();
    const push = (u) => {
      u = MediaSniffer.clean(htmlEntityDecode(u));
      if (u === '' || new RegExp('^(?:javascript|data|blob|about|mailto|#)', 'i').test(u)) {
        return;
      }
      const abs = urlAbsolutize(baseUrl, u);
      if (!/^https?:\/\//i.test(abs) || !filterVarUrl(abs)) {
        return;
      }
      if (MediaSniffer.kindOf(abs) !== null) {
        return; // a file, not a page
      }
      const baseHost = phpUrlComponent(baseUrl, 'host');
      const absHost = phpUrlComponent(abs, 'host');
      const inc = baseHost === absHost ? 2 : 1;
      out.set(abs, (out.has(abs) ? out.get(abs) : 0) + inc);
    };

    const ts = matchAllSets(new RegExp('<(iframe|embed|frame|object)' + WORD_BOUNDARY + '[^>]*>', 'gi'), html);
    for (const set of ts) {
      for (const attr of ['src', 'data-src', 'data-original', 'data-embed', 'data-url', 'data']) {
        const m = new RegExp('(?:^|' + AWWW + ')' + phpPregQuote(attr, '~') + '=["\'](' + NOT_QUOTE_WS + '{6,700})["\']', 'i').exec(set[0]);
        if (m) {
          push(m[1]);
        }
      }
    }
    for (const u of MediaSniffer.jsonLdEmbedPages(html)) push(u);
    const refresh = new RegExp('<meta[^>]+http-equiv=["\']refresh["\'][^>]+content=["\'][^"\']*url=([^"\']+)["\']', 'i').exec(html);
    if (refresh) {
      push(refresh[1]);
    }
    for (const u of matchAllGroup(new RegExp('(?:window\\.|top\\.|self\\.|document\\.)(?:location(?:\\.href)?|location)' + AWWW + '*=' + AWWW + '*["\'](' + NOT_QUOTE_WS + '{6,500})["\']', 'gi'), html, 1)) push(u);
    for (const u of matchAllGroup(new RegExp('location(?:\\.href|\\.replace)' + AWWW + '*=' + AWWW + '*["\'](' + NOT_QUOTE_WS + '{6,500})["\']', 'gi'), html, 1)) push(u);

    const rows = [...out.entries()].sort((a, b) => b[1] - a[1]);
    return rows.map(([u]) => u);
  }

  /** @return string[] */
  static configEndpoints(html, baseUrl, limit = 3) {
    const out = new Map();
    const re = new RegExp('["\'](' + NOT_QUOTE_WS + '{0,500}?(?:\\.json(?:p)?|/config[a-z0-9_-]*|/sources[a-z0-9_-]*|/playlist[a-z0-9_-]*|/getvideo[a-z0-9_-]*|/api/(?:video|player|media|stream)' + NOT_QUOTE_WS + '{0,120}))["\']', 'gi');
    for (const u of matchAllGroup(re, html, 1)) {
      const abs = urlAbsolutize(baseUrl, MediaSniffer.clean(u));
      if (u.length >= 6 && /^https?:\/\//i.test(abs) && filterVarUrl(abs) && !abs.includes('{')) {
        out.set(abs, true);
      }
      if (out.size >= limit) {
        break;
      }
    }
    return [...out.keys()];
  }
}

MediaSniffer.EXT_KIND = EXT_KIND;
MediaSniffer.SCORE = SCORE;
MediaSniffer.FILE_KEYS = FILE_KEYS;

// ---------------------------------------------------------------- helpers

/** \b against a byte string: the ASCII word characters php uses without /u. */
const WORD_BOUNDARY = '\\b';

function matchAllFull(re, subject) {
  if (!re.global) {
    throw new Error('matchAll needs a /g regex'); // exec would never advance otherwise
  }
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(subject)) !== null) {
    out.push(m[0]);
    if (m[0] === '') {
      re.lastIndex++;
    }
  }
  return out;
}

function matchAllGroup(re, subject, group) {
  if (!re.global) {
    throw new Error('matchAll needs a /g regex');
  }
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(subject)) !== null) {
    if (m[group] !== undefined) {
      out.push(m[group]);
    }
    if (m[0] === '') {
      re.lastIndex++;
    }
  }
  return out;
}

function matchAllSets(re, subject) {
  if (!re.global) {
    throw new Error('matchAll needs a /g regex');
  }
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(subject)) !== null) {
    out.push(m.slice());
    if (m[0] === '') {
      re.lastIndex++;
    }
  }
  return out;
}

/**
 * preg_split() for a pattern with no flags and no limit. Empty trailing fields are
 * dropped by php, but only trailing ones; a leading empty piece stays.
 */
function pregSplit(re, subject) {
  const pieces = subject.split(re);
  // Array.prototype.split keeps the trailing empty piece that php would drop only
  // when it is the *last* one from a match at end of string; reproduce that.
  if (pieces.length > 0 && pieces[pieces.length - 1] === '' && pieces.length > 1) {
    // php's preg_split drops nothing by default (no PREG_SPLIT_NO_EMPTY), so the
    // empty tail from a trailing separator IS kept. Do not trim it.
  }
  return pieces;
}

function substrCount(haystack, needle) {
  if (needle === '') {
    return 0;
  }
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function asciiLower(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

function phpTrimDefault(s) {
  return phpTrimCustom(String(s), ' \t\n\r\x0B\0');
}

function phpTrimCustom(s, list) {
  let start = 0;
  let end = s.length;
  while (start < end && list.includes(s[start])) {
    start++;
  }
  while (end > start && list.includes(s[end - 1])) {
    end--;
  }
  return s.slice(start, end);
}

/** pathinfo($p, PATHINFO_EXTENSION): everything after the last '.' of the basename. */
function pathinfoExtension(p) {
  const s = String(p);
  let sep = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '/' || s[i] === '\\') {
      sep = i;
    }
  }
  const base = s.slice(sep + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1);
}

/** preg_quote($s, '~'): escapes the php set plus the delimiter; '/' is left alone. */
function phpPregQuote(s) {
  return s.replace(/[.*+?^${}()|[\]\\=#!<>:$\-]/g, '\\$&');
}

/**
 * (int) cast: php reads an optional sign then digits (leading whitespace allowed);
 * anything else is 0. Supports the string keys/values MediaSniffer sees.
 */
function phpInt(v) {
  if (typeof v === 'number') {
    return Math.trunc(v) | 0;
  }
  const m = /^[ \t]*[+-]?\d+/.exec(String(v));
  return m ? parseInt(m[0], 10) : 0;
}

/** json_decode($x, true): arrays become JS arrays, objects become JS objects, or null. */
function jsonDecodeAssoc(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- html_entity_decode

const NAMED_ENTITIES = {
  '&#039;': 39, '&AElig;': 198, '&Aacute;': 193, '&Acirc;': 194, '&Agrave;': 192,
  '&Alpha;': 913, '&Aring;': 197, '&Atilde;': 195, '&Auml;': 196, '&Beta;': 914,
  '&Ccedil;': 199, '&Chi;': 935, '&Dagger;': 8225, '&Delta;': 916, '&ETH;': 208,
  '&Eacute;': 201, '&Ecirc;': 202, '&Egrave;': 200, '&Epsilon;': 917, '&Eta;': 919,
  '&Euml;': 203, '&Gamma;': 915, '&Iacute;': 205, '&Icirc;': 206, '&Igrave;': 204,
  '&Iota;': 921, '&Iuml;': 207, '&Kappa;': 922, '&Lambda;': 923, '&Mu;': 924,
  '&Ntilde;': 209, '&Nu;': 925, '&OElig;': 338, '&Oacute;': 211, '&Ocirc;': 212,
  '&Ograve;': 210, '&Omega;': 937, '&Omicron;': 927, '&Oslash;': 216, '&Otilde;': 213,
  '&Ouml;': 214, '&Phi;': 934, '&Pi;': 928, '&Prime;': 8243, '&Psi;': 936,
  '&Rho;': 929, '&Scaron;': 352, '&Sigma;': 931, '&THORN;': 222, '&Tau;': 932,
  '&Theta;': 920, '&Uacute;': 218, '&Ucirc;': 219, '&Ugrave;': 217, '&Upsilon;': 933,
  '&Uuml;': 220, '&Xi;': 926, '&Yacute;': 221, '&Yuml;': 376, '&Zeta;': 918,
  '&aacute;': 225, '&acirc;': 226, '&acute;': 180, '&aelig;': 230, '&agrave;': 224,
  '&alefsym;': 8501, '&alpha;': 945, '&amp;': 38, '&and;': 8743, '&ang;': 8736,
  '&aring;': 229, '&asymp;': 8776, '&atilde;': 227, '&auml;': 228, '&bdquo;': 8222,
  '&beta;': 946, '&brvbar;': 166, '&bull;': 8226, '&cap;': 8745, '&ccedil;': 231,
  '&cedil;': 184, '&cent;': 162, '&chi;': 967, '&circ;': 710, '&clubs;': 9827,
  '&cong;': 8773, '&copy;': 169, '&crarr;': 8629, '&cup;': 8746, '&curren;': 164,
  '&dArr;': 8659, '&dagger;': 8224, '&darr;': 8595, '&deg;': 176, '&delta;': 948,
  '&diams;': 9830, '&divide;': 247, '&eacute;': 233, '&ecirc;': 234, '&egrave;': 232,
  '&empty;': 8709, '&emsp;': 8195, '&ensp;': 8194, '&epsilon;': 949, '&equiv;': 8801,
  '&eta;': 951, '&eth;': 240, '&euml;': 235, '&euro;': 8364, '&exist;': 8707,
  '&fnof;': 402, '&forall;': 8704, '&frac12;': 189, '&frac14;': 188, '&frac34;': 190,
  '&frasl;': 8260, '&gamma;': 947, '&ge;': 8805, '&gt;': 62, '&hArr;': 8660,
  '&harr;': 8596, '&hearts;': 9829, '&hellip;': 8230, '&iacute;': 237, '&icirc;': 238,
  '&iexcl;': 161, '&igrave;': 236, '&image;': 8465, '&infin;': 8734, '&int;': 8747,
  '&iota;': 953, '&iquest;': 191, '&isin;': 8712, '&iuml;': 239, '&kappa;': 954,
  '&lArr;': 8656, '&lambda;': 955, '&lang;': 9001, '&laquo;': 171, '&larr;': 8592,
  '&lceil;': 8968, '&ldquo;': 8220, '&le;': 8804, '&lfloor;': 8970, '&lowast;': 8727,
  '&loz;': 9674, '&lrm;': 8206, '&lsaquo;': 8249, '&lsquo;': 8216, '&lt;': 60,
  '&macr;': 175, '&mdash;': 8212, '&micro;': 181, '&middot;': 183, '&minus;': 8722,
  '&mu;': 956, '&nabla;': 8711, '&nbsp;': 160, '&ndash;': 8211, '&ne;': 8800,
  '&ni;': 8715, '&not;': 172, '&notin;': 8713, '&nsub;': 8836, '&ntilde;': 241,
  '&nu;': 957, '&oacute;': 243, '&ocirc;': 244, '&oelig;': 339, '&ograve;': 242,
  '&oline;': 8254, '&omega;': 969, '&omicron;': 959, '&oplus;': 8853, '&or;': 8744,
  '&ordf;': 170, '&ordm;': 186, '&oslash;': 248, '&otilde;': 245, '&otimes;': 8855,
  '&ouml;': 246, '&para;': 182, '&part;': 8706, '&permil;': 8240, '&perp;': 8869,
  '&phi;': 966, '&pi;': 960, '&piv;': 982, '&plusmn;': 177, '&pound;': 163,
  '&prime;': 8242, '&prod;': 8719, '&prop;': 8733, '&psi;': 968, '&quot;': 34,
  '&rArr;': 8658, '&radic;': 8730, '&rang;': 9002, '&raquo;': 187, '&rarr;': 8594,
  '&rceil;': 8969, '&rdquo;': 8221, '&real;': 8476, '&reg;': 174, '&rfloor;': 8971,
  '&rho;': 961, '&rlm;': 8207, '&rsaquo;': 8250, '&rsquo;': 8217, '&sbquo;': 8218,
  '&scaron;': 353, '&sdot;': 8901, '&sect;': 167, '&shy;': 173, '&sigma;': 963,
  '&sigmaf;': 962, '&sim;': 8764, '&spades;': 9824, '&sub;': 8834, '&sube;': 8838,
  '&sum;': 8721, '&sup1;': 185, '&sup2;': 178, '&sup3;': 179, '&sup;': 8835,
  '&supe;': 8839, '&szlig;': 223, '&tau;': 964, '&there4;': 8756, '&theta;': 952,
  '&thetasym;': 977, '&thinsp;': 8201, '&thorn;': 254, '&tilde;': 732, '&times;': 215,
  '&trade;': 8482, '&uArr;': 8657, '&uacute;': 250, '&uarr;': 8593, '&ucirc;': 251,
  '&ugrave;': 249, '&uml;': 168, '&upsih;': 978, '&upsilon;': 965, '&uuml;': 252,
  '&weierp;': 8472, '&xi;': 958, '&yacute;': 253, '&yen;': 165, '&yuml;': 255,
  '&zeta;': 950, '&zwj;': 8205, '&zwnj;': 8204,
};

/** A numeric reference decodes only for the code points php's html filter accepts. */
function decodableCp(cp) {
  if (cp === 9 || cp === 10 || cp === 13) {
    return true;
  }
  if (cp >= 0x20 && cp <= 0x7e) {
    return true;
  }
  return cp >= 0xa0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
}

function utf8Bytes(cp) {
  if (cp < 0x80) {
    return String.fromCharCode(cp);
  }
  if (cp < 0x800) {
    return String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  }
  if (cp < 0x10000) {
    return String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
}

/** html_entity_decode($s, ENT_QUOTES, 'UTF-8') with the HTML401 entity set php uses. */
function htmlEntityDecode(text) {
  const s = String(text);
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] !== '&') {
      out += s[i++];
      continue;
    }
    const rest = s.slice(i);
    const num = /^&#(x?)([0-9A-Fa-f]+);/.exec(rest);
    if (num) {
      // php's decimal form is digits-only; a stray hex letter kills the match.
      const isHex = num[1] === 'x' || num[1] === 'X';
      const valid = isHex || /^[0-9]+$/.test(num[2]);
      const cp = valid ? parseInt(num[2], isHex ? 16 : 10) : NaN;
      if (valid && decodableCp(cp)) {
        out += utf8Bytes(cp);
        i += num[0].length;
        continue;
      }
      out += s[i++];
      continue;
    }
    const name = /^&([A-Za-z][A-Za-z0-9]*);/.exec(rest);
    if (name && Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name[0])) {
      out += utf8Bytes(NAMED_ENTITIES[name[0]]);
      i += name[0].length;
      continue;
    }
    out += s[i++];
  }
  return out;
}

/** Valid UTF-8 over the byte string, mirroring what makes a 'u'-flag preg fail. */
function bytesAreUtf8(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const b = s.charCodeAt(i);
    let len;
    if (b <= 0x7f) {
      i++;
      continue;
    } else if ((b & 0xe0) === 0xc0) {
      len = 1;
    } else if ((b & 0xf0) === 0xe0) {
      len = 2;
    } else if ((b & 0xf8) === 0xf0) {
      len = 3;
    } else {
      return false;
    }
    if (i + len >= n) {
      return false;
    }
    for (let k = 1; k <= len; k++) {
      if ((s.charCodeAt(i + k) & 0xc0) !== 0x80) {
        return false;
      }
    }
    const cp = len === 1 ? ((b & 0x1f) << 6) | (s.charCodeAt(i + 1) & 0x3f)
      : len === 2 ? ((b & 0x0f) << 12) | ((s.charCodeAt(i + 1) & 0x3f) << 6) | (s.charCodeAt(i + 2) & 0x3f)
        : ((b & 0x07) << 18) | ((s.charCodeAt(i + 1) & 0x3f) << 12) | ((s.charCodeAt(i + 2) & 0x3f) << 6) | (s.charCodeAt(i + 3) & 0x3f);
    if (len === 1 && cp < 0x80) {
      return false;
    }
    if (len === 2 && cp < 0x800) {
      return false;
    }
    if (len === 3 && cp < 0x1000) {
      return false;
    }
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      return false;
    }
    i += len + 1;
  }
  return true;
}

/**
 * preg_replace with the 'u' modifier: php returns null when the subject is not valid
 * utf-8, and otherwise works on code points. Reaching this at byte level would mix
 * ascii ranges with multibyte dashes, so decode, replace over code points, re-encode.
 * pregReplaceU mirrors the (string) cast in php's tidy (null -> ''); the Or version
 * keeps the null so the caller can reproduce the `?? $t` fallback.
 */
function pregReplaceUOrNull(re, replacement, subject) {
  if (!bytesAreUtf8(subject)) {
    return null;
  }
  const decoded = Buffer.from(subject, 'latin1').toString('utf8');
  const replaced = decoded.replace(re, replacement);
  return Buffer.from(replaced, 'utf8').toString('latin1');
}

function pregReplaceU(re, replacement, subject) {
  const r = pregReplaceUOrNull(re, replacement, subject);
  return r === null ? '' : r;
}

function walkJsonLd(node, wanted, out) {
  if (!isPhpArray(node)) {
    return;
  }
  const typeVal = node['@type'] !== undefined ? node['@type'] : '';
  const type = asciiLower(String(jsonEncodeLoose(typeVal)));
  const isVideo = type === '' || type.includes('video') || type.includes('media');
  for (const key of Object.keys(node)) {
    const v = node[key];
    const lk = asciiLower(String(key));
    if (typeof v === 'string') {
      if (wanted.includes(lk) && isVideo && v.length > 5) {
        out.push(v);
      }
    } else if (v !== null && typeof v === 'object') {
      if (wanted.includes(lk) && isVideo) {
        for (const one of Object.values(v)) {
          if (typeof one === 'string' && one.length > 5) {
            out.push(one);
          }
        }
      }
      walkJsonLd(v, wanted, out);
    }
  }
}

function isPhpArray(node) {
  return node !== null && typeof node === 'object';
}

function jsonEncodeLoose(v) {
  // json_encode of a scalar string is the quoted string; of an array/object the json.
  if (typeof v === 'string') {
    return JSON.stringify(v);
  }
  if (v === null) {
    return 'null';
  }
  if (typeof v === 'object') {
    return JSON.stringify(v);
  }
  return String(v);
}

// ---------------------------------------------------------------- filter_var URL

/**
 * filter_var($u, FILTER_VALIDATE_URL). MediaSniffer only ever reaches here with a
 * string that already matched ^https?://, but the grammar is implemented in full so
 * a probe can pin it. The observable rules were pinned against php 8.3 byte by byte.
 */
function filterVarUrl(u) {
  const s = String(u);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) {
      return false; // space, controls, DEL and every non-ascii byte are refused
    }
  }
  const m = /^([A-Za-z0-9+.\-]*):\/\/(.*)$/s.exec(s);
  if (!m) {
    return false;
  }
  const rest = m[2];
  const delim = rest.search(/[/?#]/);
  const auth = delim === -1 ? rest : rest.slice(0, delim);
  const atCount = (auth.match(/@/g) || []).length;
  if (atCount > 1) {
    return false;
  }
  let hostport = auth;
  if (atCount === 1) {
    const idx = auth.indexOf('@');
    if (!userinfoOk(auth.slice(0, idx))) {
      return false;
    }
    hostport = auth.slice(idx + 1);
  }
  if (hostport === '') {
    return false;
  }
  if (hostport[0] === '[') {
    const close = hostport.indexOf(']');
    if (close === -1) {
      return false;
    }
    if (!ipv6Ok(hostport.slice(1, close))) {
      return false;
    }
    const after = hostport.slice(close + 1);
    if (after === '') {
      return true;
    }
    if (after[0] !== ':') {
      return false;
    }
    return portOk(after.slice(1));
  }
  const colon = hostport.indexOf(':');
  const host = colon === -1 ? hostport : hostport.slice(0, colon);
  const field = colon === -1 ? null : hostport.slice(colon + 1);
  if (!domainOk(host)) {
    return false;
  }
  return field === null || portOk(field);
}

const USERINFO_BAD = new Set(['"', '<', '>', '[', '\\', ']', '^', '`', '{', '|', '}']);

function userinfoOk(u) {
  for (let i = 0; i < u.length; i++) {
    const c = u[i];
    if (USERINFO_BAD.has(c)) {
      return false;
    }
    if (c === '%') {
      if (!/^[0-9A-Fa-f]{2}/.test(u.slice(i + 1, i + 3))) {
        return false;
      }
      i += 2;
    }
  }
  return true;
}

function domainOk(host) {
  if (host === '' || host.length > 253) {
    return false;
  }
  let h = host;
  if (h.endsWith('.')) {
    h = h.slice(0, -1);
  }
  const labels = h.split('.');
  if (labels.length === 0) {
    return false;
  }
  for (const lab of labels) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(lab)) {
      return false;
    }
  }
  return true;
}

function portOk(field) {
  if (field === '') {
    return true;
  }
  if (field.length > 5 || field.includes(':') || !/^[0-9]/.test(field)) {
    return false;
  }
  const digits = /^[0-9]+/.exec(field)[0];
  return parseInt(digits, 10) <= 65535;
}

/** inet_pton AF_INET6: eight 16-bit groups, one optional '::' standing for 1+ zeros, optional trailing ipv4. */
function ipv6Ok(content) {
  if (content === '' || /:::/.test(content)) {
    return false;
  }
  const dbl = content.indexOf('::');
  const hasDouble = dbl >= 0;
  if (hasDouble && content.indexOf('::', dbl + 1) >= 0) {
    return false;
  }
  const seg = (s) => (s === '' ? [] : s.split(':'));
  const hexg = (g) => /^[0-9A-Fa-f]{1,4}$/.test(g);
  const v4 = (g) => {
    const p = g.split('.');
    return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
  };
  const count = (parts, allowV4Last) => {
    let w = 0;
    for (let i = 0; i < parts.length; i++) {
      const g = parts[i];
      if (allowV4Last && i === parts.length - 1 && v4(g)) {
        w += 2;
      } else if (hexg(g)) {
        w++;
      } else {
        return -1;
      }
    }
    return w;
  };
  if (hasDouble) {
    const lw = count(seg(content.slice(0, dbl)), false);
    const rw = count(seg(content.slice(dbl + 2)), true);
    if (lw < 0 || rw < 0) {
      return false;
    }
    // '::' stands for at least one group, so the explicit words must be under 8.
    return lw + rw <= 7;
  }
  return count(seg(content), true) === 8;
}
