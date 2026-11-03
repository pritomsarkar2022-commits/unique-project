import { cfg } from '../config.mjs';
import { parseUrl, phpInt } from '../support.mjs';
import { HttpException, UrlGuardException } from '../errors.mjs';
import { JsUnpacker } from './jsUnpacker.mjs';
import { MediaSniffer } from './mediaSniffer.mjs';
import { Source } from './source.mjs';
import { strtolowerBytes } from './baseExtractor.mjs';

/**
 * Port of lib/Extractor/DeepFinder.php: the general deep reader for hosts that have
 * no dedicated rules.
 *
 * It opens the page, then every player document the page points at (iframe, embed,
 * meta refresh, a javascript location), then the sidecar config files a player
 * fetches to get its file list. Media urls found at any level are merged, ranked by
 * the shape they appeared in, and handed back for verification, which is the only
 * step that proves a candidate is a real file.
 *
 * ## The one structural difference from php: async
 *
 * HttpClient is asynchronous here, so the two methods that open documents -
 * `discover()` and `withPage()` (and the private `drain()` behind both) - return
 * promises and must be awaited. `readDocument()`, `ranked()`, `queued()`,
 * `skipped()` and `heightHint()` touch no socket and stay synchronous, exactly like
 * the php originals.
 *
 * Every string that crosses a boundary here is a php *byte* string carried as one
 * javascript char per byte (latin1), so strlen/substr and the byte-oriented regexes
 * agree with php byte for byte. The two regexes in this file are transcribed by
 * hand: php's non-unicode `\s` is six bytes, not javascript's wider \s, and the
 * height regex has no anchors to lean on.
 *
 * @see parity/test-analyzer.mjs for the differential probes over the pure parts
 *      (skipped/heightHint/key/ranked) and site/tests/deepFinder.test.mjs for the
 *      walk itself against a scripted http.
 */

/** Sites this tool will not reach into, whatever wrapper names them. */
const SKIP_HOSTS = [
  'youtube.com', 'youtu.be', 'ytimg.com', 'googlevideo.com', 'youtubekids.com',
  'music.youtube.com', 'm.youtube.com',
];

/** The two wordings php puts in front of the visitor; byte-for-byte, by product rule. */
const NOTICE_TOO_DEEP = 'The player for that page is nested more deeply than this tool can follow in one request.';
const NOTICE_PRIVATE_PLAYER = 'A player that site keeps to itself is inside this page, so its file is not reachable from here.';

/** php's non-unicode \s: space plus the five control bytes, nothing more. */
const PHP_WS = /[\x09\x0A\x0B\x0C\x0D\x20]/g;

export class DeepFinder {
  #http;
  #bundle;
  maxDepth;
  maxPages;
  framesPerPage;
  configsPerPage;
  reserve;
  deadline;

  /** () => seconds since the epoch, php's microtime(true). */
  #clock;

  /** @var Array<{url:string,depth:int,referer:string}> what the walk still intends to open */
  #queue = [];

  /** @var Map<string,true> */
  #seen = new Map();

  /** @var Map<string,Source> insertion order is what ranked() starts from, so a Map, not an object */
  #collected = new Map();

  /**
   * @param {object} http   HttpClient-shaped: remaining(), get(url, opts) -> HttpResponse
   * @param {import('./mediaBundle.mjs').MediaBundle} bundle where the two notices land
   * @param {{clock?: () => number}} [deps] clock seam (seconds) for the deadline
   */
  constructor(http, bundle, deps = {}) {
    this.#http = http;
    this.#bundle = bundle;
    this.#clock = typeof deps.clock === 'function' ? deps.clock : () => Date.now() / 1000;
    this.maxDepth = phpInt(cfg('extract.depth', 3));
    this.maxPages = phpInt(cfg('extract.max_pages', 8));
    this.framesPerPage = phpInt(cfg('extract.frames_per_page', 5));
    this.configsPerPage = phpInt(cfg('extract.json_configs', 3));
    // Verification costs one request per candidate. Keep that much budget for
    // the end instead of spending it all on reading pages. (php's fallback is 7
    // while the shipped config says 6; both literals are kept.)
    this.reserve = phpInt(cfg('extract.verify_limit', 7));
    this.deadline = this.#clock() + (phpInt(cfg('extract.deadline_ms', 18000)) / 1000);
  }

  /**
   * @param {string} pageUrl
   * @param {object|Map|array} headers php read `$headers['Referer'] ?? $pageUrl`
   * @returns {Promise<Source[]>}
   */
  async discover(pageUrl, headers = {}) {
    this.#push(pageUrl, 0, refererOrPage(headers, pageUrl));
    return this.drain();
  }

  /**
   * Read one document the caller already fetched, so the request a host extractor
   * paid for is not paid for twice, then follow what it points at.
   *
   * @returns {Promise<Source[]>}
   */
  async withPage(res) {
    this.readDocument(res, 0);
    return this.drain();
  }

  /** Walk the queue until the budget, the depth or the clock says stop. */
  async drain() {
    let pages = 0;
    while (this.#queue.length > 0 && pages < this.maxPages) {
      // array_shift() happens before the budget test in php, so the document that
      // tripped it is already off the queue; keep that order.
      const job = this.#queue.shift();
      if (this.#http.remaining() <= this.reserve || this.#clock() > this.deadline) {
        this.#bundle.notice(NOTICE_TOO_DEEP);
        break;
      }
      pages++;
      let res;
      try {
        res = await this.#http.get(job.url, {
          headers: { Referer: job.referer },
          max_bytes: phpInt(cfg('http.page_max_bytes', 2000000)),
        });
      } catch (e) {
        // php caught HttpException|UrlGuardException and moved on to the next job;
        // anything else is a bug and still has to surface.
        if (isHttpException(e) || isUrlGuardException(e)) {
          continue;
        }
        throw e;
      }
      if (!res.ok()) {
        continue;
      }
      this.readDocument(res, phpInt(job.depth));
      res.free();
    }
    return this.ranked();
  }

  /**
   * Collect the media this document names and queue the documents it delegates to.
   * Candidates from an embed are not a fallback for candidates from the page: a
   * poster file on the page and the real playlist in the frame is the usual shape of
   * these players.
   *
   * @returns {void}
   */
  readDocument(res, depth) {
    this.#seen.set(this.#key(res.finalUrl), true);
    this.#seen.set(this.#key(res.finalUrl, true), true);
    const headers = { Referer: res.finalUrl };
    const flat = JsUnpacker.flatten(res.body);
    for (const s of MediaSniffer.candidates(flat, res.finalUrl, headers)) {
      this.#keep(s, depth, res.finalUrl);
    }

    if (depth >= this.maxDepth || this.#http.remaining() <= this.reserve) {
      return;
    }

    for (const frame of MediaSniffer.playerPages(res.body, res.finalUrl).slice(0, this.framesPerPage)) {
      if (DeepFinder.skipped(frame)) {
        this.#bundle.notice(NOTICE_PRIVATE_PLAYER);
        continue;
      }
      this.#push(frame, depth + 1, res.finalUrl);
    }
    for (const cfgUrl of MediaSniffer.configEndpoints(res.body, res.finalUrl, this.configsPerPage).slice(0, this.configsPerPage)) {
      if (DeepFinder.skipped(cfgUrl)) {
        continue;
      }
      this.#push(cfgUrl, depth + 1, res.finalUrl);
    }
  }

  #keep(s, depth, from) {
    if (this.#collected.has(s.url)) {
      return;
    }
    s.score = s.score + Math.max(0, 6 - depth * 3);
    if (s.height === null && s.kind !== Source.HLS) {
      s.height = DeepFinder.heightHint(s.url);
    }
    if (depth > 0) {
      const host = phpString(hostOf(from));
      // $s->note = $s->note ?? (...) : ?? semantics, so an existing note (a refusal,
      // a broken stream) is never overwritten by the discovery line.
      s.note = s.note !== null && s.note !== undefined
        ? s.note
        : (host !== '' ? 'Found inside the player at ' + host : null);
    }
    this.#collected.set(s.url, s);
  }

  /** @returns {Source[]} best first, whatever the walk found */
  ranked() {
    const list = [...this.#collected.values()];
    // usort with php's chained <=> comparator, transcribed in full; php 8's usort
    // and javascript's Array#sort are both stable, so equal rows keep insertion
    // order in each language.
    list.sort((a, b) => phpSpaceship(b.score, a.score)
      || phpSpaceship(kindRank(b), kindRank(a))
      || phpSpaceship(phpInt(b.height), phpInt(a.height))
      || phpSpaceship(a.url.length, b.url.length));
    return list;
  }

  /** @returns {Array<{url:string,depth:int,referer:string}>} what the walk still intends to open */
  queued() {
    return this.#queue;
  }

  #push(url, depth, referer) {
    url = String(url).replace(PHP_WS, '');
    if (url === '' || url.length > 2000) {
      return;
    }
    for (const k of [this.#key(url), this.#key(url, true)]) {
      if (this.#seen.has(k)) {
        return;
      }
      this.#seen.set(k, true);
    }
    this.#queue.push({ url, depth, referer });
  }

  /** The same player reached with a different token is still the same player. */
  #key(url, pathOnly = false) {
    const host = strtolowerBytes(phpString(hostOf(url)));
    if (pathOnly) {
      const p = pathOf(url);
      return host + (p ? String(p) : '/');
    }
    return url;
  }

  /** @returns {boolean} whether this tool refuses to reach into that url at all */
  static skipped(url) {
    const host = strtolowerBytes(phpString(hostOf(url)));
    for (const blocked of SKIP_HOSTS) {
      if (host === blocked || host.endsWith('.' + blocked)) {
        return true;
      }
    }
    return false;
  }

  /** "/1080/index.m3u8" and "?h=720" are how hosts spell a quality in a file name. */
  static heightHint(url) {
    const hay = strtolowerBytes(phpString(pathOf(url)) + '?' + phpString(queryOf(url)));
    const m = /(?:^|[^0-9])(2160|1440|1080|720|480|360|240|144)p?(?![0-9])/.exec(hay);
    return m === null ? null : phpInt(m[1]);
  }

  /**
   * Seam for the differential probe and the tests: a finder whose collected map is
   * exactly these rows, so ranked()'s comparator can be diffed against php without
   * a network. Not part of the visitor-facing behaviour.
   *
   * @param {Array<{url:string,kind?:string,score?:number,height?:number|null,note?:string|null}>} rows
   * @returns {DeepFinder}
   */
  static withCollected(rows) {
    const finder = new DeepFinder(noHttp, silentBundle);
    for (const row of rows) {
      const s = Source.make(String(row.url), row.kind === undefined ? '' : row.kind);
      s.score = row.score === undefined ? 0 : row.score;
      s.height = row.height === undefined ? null : row.height;
      s.note = row.note === undefined ? null : row.note;
      finder.#collected.set(s.url, s);
    }
    return finder;
  }

  /** The private key() the oracle reaches through reflection on the php side. */
  static keyOf(url, pathOnly = false) {
    return new DeepFinder(noHttp, silentBundle).#key(String(url), pathOnly === true);
  }

  /** The private push() the oracle reaches through reflection on the php side. */
  static pushedQueue(rows) {
    const finder = new DeepFinder(noHttp, silentBundle);
    for (const row of rows) {
      finder.#push(String(row[0]), phpInt(row[1] ?? 0), String(row[2] ?? ''));
    }
    return finder.queued();
  }
}

/** Stands in for the http client inside the seams above, which never reach it. */
const noHttp = { remaining: () => 0, get: async () => { throw new HttpException('unused'); } };
const silentBundle = { notice() {} };

/**
 * `parse_url($x, PHP_URL_HOST) ?: ''` - a false parse, a missing part and the host
 * "0" all land on the empty string, exactly like php's `?:`.
 */
function hostOf(url) {
  const p = parseUrl(String(url));
  if (!p || typeof p !== 'object') {
    return null;
  }
  const host = p.host === undefined ? null : p.host;
  return host ? host : null;
}

function pathOf(url) {
  return component(url, 'path');
}

function queryOf(url) {
  return component(url, 'query');
}

function component(url, name) {
  const p = parseUrl(String(url));
  if (!p || typeof p !== 'object') {
    return null;
  }
  const v = p[name] === undefined ? null : p[name];
  // php's `?:` also treats the string "0" as absent.
  return v ? v : null;
}

/** (string) cast as php's phpString of a `?: ''` result: null/false become ''. */
function phpString(v) {
  if (v === null || v === undefined || v === false) {
    return '';
  }
  return String(v);
}

/** match ($s->kind) { MP4 => 4, HLS => 3, WEBM => 2, MKV => 2, default => 1 }. */
function kindRank(s) {
  switch (s.kind) {
    case Source.MP4: return 4;
    case Source.HLS: return 3;
    case Source.WEBM: return 2;
    case Source.MKV: return 2;
    default: return 1;
  }
}

/** php's <=> over numbers (and null, which is smaller than every number). */
function phpSpaceship(a, b) {
  const x = a === null || a === undefined ? null : Number(a);
  const y = b === null || b === undefined ? null : Number(b);
  if (x === null) {
    return y === null ? 0 : -1;
  }
  if (y === null) {
    return 1;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

/** $headers['Referer'] ?? $pageUrl over php-array-shaped headers (isset, not empty). */
function refererOrPage(headers, pageUrl) {
  const value = headerValue(headers, 'Referer');
  return value === null || value === undefined ? pageUrl : value;
}

function headerValue(headers, name) {
  if (headers === null || headers === undefined) {
    return undefined;
  }
  if (headers instanceof Map) {
    return headers.get(name);
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && pair[0] === name) {
        return pair[1];
      }
    }
    return undefined;
  }
  return headers[name];
}

function isHttpException(e) {
  return e instanceof HttpException || String(e?.name ?? '') === 'HttpException';
}

function isUrlGuardException(e) {
  // errors.mjs and net/urlGuard.mjs each declare the class; match by name too.
  return e instanceof UrlGuardException || String(e?.name ?? '') === 'UrlGuardException';
}

export const __testing = { NOTICE_TOO_DEEP, NOTICE_PRIVATE_PLAYER, refererOrPage, kindRank, hostOf };
