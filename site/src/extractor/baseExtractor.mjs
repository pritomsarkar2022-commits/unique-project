import { JsUnpacker } from './jsUnpacker.mjs';
import { MediaSniffer } from './mediaSniffer.mjs';
import { Source } from './source.mjs';
import { MediaBundle } from './mediaBundle.mjs';
import { Playlist } from '../hls/playlist.mjs';
import { HttpException, UrlGuardException } from '../errors.mjs';
import { phpInt, phpRound } from '../support.mjs';

/**
 * Port of lib/Extractor/BaseExtractor.php: shared plumbing for extractors - read a
 * page, decode the js that hides the file, verify a candidate really is video, and
 * chase nested players.
 *
 * ## The one structural difference from php: async
 *
 * HttpClient is asynchronous here (node's sockets are), so every protected method
 * that touches it is `async` and returns a promise:
 *
 *     name()/hosts()/priority()/readable()/sniff()/htmlHeaders()/newBundle()/fillMeta()  sync
 *     verify()/verifyPlaylist()/readVariant()/verifyAll()/extract()                       async
 *
 * A host extractor must therefore `await this.verify(s, http)` where php wrote
 * `if ($this->verify($s, $http))`. Nothing else about the semantics moved.
 *
 * ## How name() knows the php class (subclass authors, read this)
 *
 * php derives the display name from `static::class`, which javascript has no
 * equivalent of. The port looks for the php class name in three places, first hit
 * wins:
 *
 *   1. `new Subclass('XfsExtractor')` - the constructor argument, kept as an escape
 *      hatch for a class built dynamically.
 *   2. `static phpClass = 'XfsExtractor'` - the normal way: declare it on the
 *      subclass next to its hosts().
 *   3. `this.constructor.name` - works unchanged as long as the ported class keeps
 *      the php name (`class XfsExtractor extends BaseExtractor`), which all of them do.
 *
 * A subclass that overrides name() itself wins over all three - GenericExtractor
 * does exactly that, because php's answers with its provider instead.
 */
export class BaseExtractor {
  /** @param {string|null} phpClassName see the note on name() */
  constructor(phpClassName = null) {
    if (phpClassName !== null && phpClassName !== undefined && phpClassName !== '') {
      this.phpClassName = String(phpClassName);
    }
  }

  /** Higher wins when several extractors claim a host. */
  priority() {
    return 10;
  }

  /**
   * The display name, derived the php way: the short class name with a trailing
   * "Extractor" stripped case-insensitively, then lower-cased.
   */
  name() {
    const parts = String(this.phpClassName ?? this.constructor.phpClass ?? this.constructor.name).split('\\');
    return strtolowerBytes(pregReplaceExtractorSuffix(parts[parts.length - 1]));
  }

  /** Domains this extractor owns, matched against the registrable host. */
  hosts() {
    return [];
  }

  /**
   * @param {string[]} visited guards against redirect loops between players
   * @returns {Promise<MediaBundle>}
   */
  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.name()}: extract() is abstract in php and must be implemented by the subclass`);
  }

  // ---------------------------------------------------------------- protected

  /** Page text with packed/escaped/concatenated js flattened out. */
  readable(res) {
    return JsUnpacker.flatten(res.body);
  }

  /** @returns {Source[]} */
  sniff(res, headers = []) {
    return MediaSniffer.sourcesFromText(this.readable(res), res.finalUrl, headers);
  }

  htmlHeaders(res) {
    return { Referer: res.finalUrl };
  }

  /**
   * Ask the file host for one byte. This is what turns a regex match into a result
   * we are willing to show: real content-type, real size, real liveness.
   *
   * @returns {Promise<boolean>}
   */
  async verify(s, http) {
    if (s.kind === Source.HLS) {
      return this.verifyPlaylist(s, http);
    }
    let res;
    try {
      res = await http.get(s.url, {
        headers: withProbeRange(s.headers),
        max_bytes: 65536,
        timeout: 15,
        accept: '*/*',
      });
      // Some file hosts answer a ranged probe with 416 while the plain request a
      // player makes works fine, so ask once without it.
      if (res.status === 416) {
        res = await http.get(s.url, {
          headers: s.headers,
          max_bytes: 65536,
          timeout: 15,
          accept: '*/*',
        });
      }
    } catch (e) {
      if (isHttpException(e)) {
        s.note = e.message;
        return false;
      }
      throw e;
    }
    if (res.status === 401 || res.status === 403) {
      return false;
    }
    if (res.status !== 200 && res.status !== 206) {
      return false;
    }
    const type = strtolowerBytes(String(res.contentType));
    const clen = phpInt(res.header('content-length') ?? 0);
    const total = res.header('content-range');
    // php's `$` allows one trailing newline, which javascript's does not, so the
    // anchor is spelled out.
    const rangeTotal = typeof total === 'string' ? /\/(\d+)(?=\n?$)/.exec(total) : null;
    if (rangeTotal !== null) {
      s.sizeBytes = phpInt(rangeTotal[1]);
    } else if (res.status === 200 && clen > 1) {
      s.sizeBytes = clen;
    }
    const looksVideo = type === ''
      || type.includes('video')
      || type.includes('octet-stream')
      || type.includes('binary');
    s.mime = type !== '' ? type.split(';')[0] : s.mime;
    return looksVideo && (s.sizeBytes === null || s.sizeBytes > 1024);
  }

  /** @returns {Promise<boolean>} */
  async verifyPlaylist(s, http) {
    let res;
    try {
      res = await http.get(s.url, {
        headers: s.headers,
        max_bytes: 3000000,
        accept: 'application/x-mpegURL,application/vnd.apple.mpegurl,*/*;q=0.8',
      });
    } catch (e) {
      if (isHttpException(e)) {
        return false;
      }
      throw e;
    }
    if (!res.ok() || striposFalse(res.body, '#EXTM3U')) {
      return false;
    }
    const pl = Playlist.parse(res.body, res.finalUrl);
    if (pl.sampleAes) {
      s.note = 'This stream is encrypted in a way that needs its own player, so it cannot be joined into one file.';
      return false;
    }
    if (pl.isMaster) {
      for (const v of pl.variants) {
        s.variants.push({
          height: v.height ?? null,
          bandwidth: v.bandwidth ?? null,
          codecs: v.codecs ?? null,
          url: v.url ?? null,      // server-side only; the UI gets relay links
        });
      }
      if (s.variants.length === 0) {
        return false;
      }
      // (int)($b['height'] ?? 0) <=> (int)($a['height'] ?? 0): height descending,
      // null and text counting as 0, transcribed exactly (see mediaBundle.mjs on
      // why the tie order is reproducible).
      s.variants.sort((a, b) => phpInt(b.height ?? 0) - phpInt(a.height ?? 0));
      s.height = s.variants[0].height;
      s.bitrate = s.variants[0].bandwidth;
      // One more read tells us length, segment count and whether the payload is
      // encrypted, which is what the MP4 builder needs to plan the work.
      if (http.remaining() > 0 && !phpEmpty(s.variants[0].url)) {
        await this.readVariant(s, String(s.variants[0].url), http);
      }
      return true;
    }
    if (pl.segments.length === 0) {
      return false;
    }
    s.duration = pl.totalDuration > 0 ? pl.totalDuration : null;
    s.variants = [{
      height: null,
      bandwidth: null,
      codecs: null,
      url: s.url,
      segments: pl.segments.length,
      duration: roundTo(pl.totalDuration, 1),
      encrypted: pl.key !== null,
    }];
    return true;
  }

  /**
   * Open the chosen media playlist and record what a download would involve.
   *
   * @returns {Promise<void>}
   */
  async readVariant(s, variantUrl, http) {
    if (variantUrl === s.url) {
      return;
    }
    let res;
    try {
      res = await http.get(variantUrl, {
        headers: s.headers,
        max_bytes: 6000000,
        accept: 'application/x-mpegURL,*/*;q=0.8',
      });
    } catch (e) {
      if (isHttpException(e) || isUrlGuardException(e)) {
        return;
      }
      throw e;
    }
    if (!res.ok() || striposFalse(res.body, '#EXTM3U')) {
      return;
    }
    const pl = Playlist.parse(res.body, res.finalUrl);
    if (pl.isMaster || pl.segments.length === 0) {
      return;
    }
    s.duration = pl.totalDuration > 0 ? pl.totalDuration : s.duration;
    let first = 0;
    for (let i = 0; i < s.variants.length; i++) {
      if ((s.variants[i].url ?? '') === variantUrl) {
        first = i;
        break;
      }
    }
    // php autovivifies $s->variants[0] when the list is empty; keep that shape
    // instead of throwing where php simply stored a record.
    if (s.variants[first] === undefined) {
      s.variants[first] = {};
    }
    s.variants[first].segments = pl.segments.length;
    s.variants[first].duration = roundTo(pl.totalDuration, 1);
    s.variants[first].encrypted = pl.key !== null;
    if (pl.key !== null) {
      s.keyUri = pl.key.uri;
      s.keyMethod = pl.key.method;
    }
  }

  /**
   * @param {Source[]} sources
   * @returns {Promise<Source[]>}
   */
  async verifyAll(sources, http, b) {
    const kept = [];
    for (const s of sources) {
      if (await this.verify(s, http)) {
        kept.push(s);
      } else {
        // php: vd_log('candidate rejected', ['url' => ..., 'kind' => ...]). The
        // filesystem logger is not part of this port (a Netlify function cannot
        // append to storage/logs/app.log), so the line goes to the sink the host
        // installs with setVdLog(), and nowhere by default.
        vdLog('candidate rejected', { url: s.url, kind: s.kind });
      }
    }
    if (kept.length > 0) {
      b.confidence = 0.85;
    }
    return kept;
  }

  /**
   * Some pages are only a wrapper around an embed, so the search has to go through
   * documents, not just read one. That job moved to DeepFinder, which reads every
   * level instead of stopping at the first one that names a file.
   */
  newBundle(pageUrl, provider = '') {
    const b = new MediaBundle();
    b.pageUrl = pageUrl;
    b.provider = provider !== '' ? provider : this.name();
    return b;
  }

  fillMeta(b, res) {
    b.finalUrl = res.finalUrl;
    const meta = MediaSniffer.meta(res.body, res.finalUrl);
    b.title ??= meta.title;
    b.thumbnail ??= meta.thumbnail;
  }
}

// ------------------------------------------------------------------ vd_log sink

let logSink = null;

/** Install the app's log sink; without one the php log line is simply dropped. */
export function setVdLog(fn) {
  logSink = typeof fn === 'function' ? fn : null;
}

function vdLog(message, context = {}) {
  if (logSink !== null) {
    logSink(message, context);
  }
}

// ------------------------------------------------------------------ php helpers

/**
 * `$s->headers + ['Range' => 'bytes=0-0']`: php's union keeps the LEFT entry for a
 * key both sides have, and compares array keys case-sensitively, so a source that
 * already names its own Range keeps it.
 */
function withProbeRange(headers) {
  const out = {};
  for (const [k, v] of pairsOf(headers)) {
    out[k] = v;
  }
  if (!Object.prototype.hasOwnProperty.call(out, 'Range')) {
    out.Range = 'bytes=0-0';
  }
  return out;
}

/** php arrays are ordered maps; the port writes them as objects or as [k,v] pairs. */
function pairsOf(headers) {
  if (headers === null || headers === undefined) {
    return [];
  }
  if (headers instanceof Map) {
    return [...headers.entries()];
  }
  if (Array.isArray(headers)) {
    return headers;                    // already [name, value] pairs
  }
  return Object.entries(headers);
}

/** stripos($haystack, $needle) === false, i.e. "the needle is not in there". */
function striposFalse(haystack, needle) {
  return stripos(haystack, needle) === false;
}

/**
 * stripos(): the byte index of the first case-insensitive occurrence, or false.
 * php folds the ascii bytes only, so both sides go through strtolowerBytes and
 * javascript's indexOf does the rest. Exported because host extractors reach for
 * the same test, and parity/test-extractors.mjs pins it against php.
 */
export function stripos(haystack, needle) {
  const at = strtolowerBytes(String(haystack)).indexOf(strtolowerBytes(String(needle)));
  return at === -1 ? false : at;
}

/** strtolower(): php folds ascii bytes only, javascript's toLowerCase folds unicode. */
export function strtolowerBytes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/** preg_replace('/extractor$/i', '', $name): a case-insensitive trailing suffix. */
function pregReplaceExtractorSuffix(name) {
  const m = /extractor$/i.exec(name);
  return m === null ? name : name.slice(0, m.index) + name.slice(m.index + m[0].length);
}

/** round($v, $precision): half away from zero at the requested precision. */
function roundTo(value, precision) {
  const factor = Math.pow(10, precision);
  return phpRound(Number(value) * factor) / factor;
}

/** empty(): '', '0', 0, null, false and an empty array are all empty in php. */
function phpEmpty(v) {
  if (v === null || v === undefined || v === false || v === '' || v === 0 || v === '0') {
    return true;
  }
  if (Array.isArray(v)) {
    return v.length === 0;
  }
  if (v instanceof Map) {
    return v.size === 0;
  }
  return false;
}

function isHttpException(e) {
  return e instanceof HttpException || String(e?.name ?? '') === 'HttpException';
}

function isUrlGuardException(e) {
  // errors.mjs and net/urlGuard.mjs each declare the class; match by name too.
  return e instanceof UrlGuardException || String(e?.name ?? '') === 'UrlGuardException';
}
