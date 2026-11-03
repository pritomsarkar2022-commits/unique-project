import crypto from 'node:crypto';
import { parseUrl, phpTrim } from '../support.mjs';
import { ExtractException } from '../errors.mjs';
import { assertSafeAsync } from '../net/urlGuard.mjs';
import { relayLink } from '../net/relay.mjs';
import { Source } from './source.mjs';

/**
 * Port of lib/Extractor/Analyzer.php: a pasted url in, a stored job plus the only
 * links the browser is allowed to use (signed relay urls) out.
 *
 * ## The one structural difference from php: async
 *
 * php built `new ExtractorRegistry()`, `new HttpClient()` and `new JobStore()`
 * inside analyze() and every call below them was synchronous. Here the registry is
 * imported lazily (its extractor list is a dynamic import) and the http client
 * awaits every hop, so `analyze()` and `normalize()` (UrlGuard resolves DNS) are
 * `async`. `present()` touches no socket and stays synchronous, like the php one.
 *
 * ## The injection seam
 *
 * `analyze(raw, deps)` takes `{registry, jobs, http, clock, guard, dns}`; anything
 * absent is built for real, lazily, from the modules above. `clock` is
 * `() => seconds since the epoch` (php's time()/microtime(true)) and reaches
 * JobStore's `now`; `dns` is the resolver UrlGuard uses. The seam exists because a
 * test suite cannot otherwise run without a network or without the two modules that
 * were being ported alongside this one - see site/tests/analyzer.test.mjs.
 *
 * Byte strings again: every value here is a php byte string held as one javascript
 * char per byte, so strlen/substr/md5 line up with php. The one place php switches
 * to code points is the `/u` pattern in fileName(), handled by pregReplaceU() below
 * the same way mediaSniffer.mjs handles its own `/u` patterns.
 */
export class Analyzer {
  /**
   * @param {string} raw what the visitor pasted
   * @param {object} [deps] {registry, jobs, http, clock, guard, dns}
   * @returns {Promise<object>} the payload the browser reads
   */
  static async analyze(raw, deps = {}) {
    const pageUrl = await Analyzer.normalize(raw, deps);
    const registry = deps.registry ?? await createRegistry();
    const http = deps.http ?? await createHttp();
    const store = deps.jobs ?? await createStore(deps);

    const extractor = await registry.forUrl(pageUrl);
    const bundle = await Analyzer.runExtractor(extractor, pageUrl, http, registry);

    // !$bundle->sources : an empty array, php's empty(), not isset().
    if (!bundle.sources || bundle.sources.length === 0) {
      throw new ExtractException(
        'No downloadable file could be found on that page.',
        'Check that the link points straight at a video page, not a profile or a list.',
        'no_media',
      );
    }

    const record = await store.create(bundle);
    return Analyzer.present(record, store);
  }

  /**
   * @param {object} record a stored job record
   * @param {object} store  JobStore-shaped: source(record, id), sign(record, url)
   * @param {Array<Source|object>|null} extraSources
   * @returns {object}
   */
  static present(record, store, extraSources = null) {
    const sources = [];
    for (const data of (extraSources !== null && extraSources !== undefined ? extraSources : (record.sources ?? []))) {
      const s = data instanceof Source
        ? data
        : store.source(record, data !== null && typeof data === 'object' && data.id !== undefined && data.id !== null ? String(data.id) : '');
      if (s === null || s === undefined) {
        continue;
      }
      const row = s.toArray();
      const isHls = s.kind === Source.HLS;
      row.previewUrl = relayLink(store, record, s.url, { download: false, isPlaylist: isHls });
      row.downloadUrl = relayLink(store, record, s.url, {
        download: true,
        name: Analyzer.fileName(record, s),
        isPlaylist: isHls,
      });
      // php copied the variant array by value and mutated the copy; javascript
      // would rewrite the stored source without the same copy.
      row.variants = s.variants.map((v) => {
        const copy = { ...v };
        if (copy.url !== undefined && copy.url !== null) {
          // A variant line is always a playlist of its own.
          copy.streamUrl = relayLink(store, record, String(copy.url), { download: false, isPlaylist: true });
          delete copy.url;
        }
        return copy;
      });
      sources.push(row);
    }

    return {
      job: record.id,
      provider: record.provider,
      title: Analyzer.titleFor(strOrNull(record.title), strOrNull(record.pageUrl)),
      thumbnail: phpEmpty(record.thumbnail)
        ? null
        : relayLink(store, record, String(record.thumbnail), { download: false }),
      pageUrl: record.pageUrl,
      notices: record.notices,
      confidence: record.confidence,
      expiresAt: record.expires,
      sources,
    };
  }

  /**
   * The download name. Distinct from BuildStore's file name: this one is built from
   * the page title, so it has to survive whatever the page called itself.
   */
  static fileName(record, s) {
    // trim(preg_replace('/[^\w\-. ]+/u', '', (string) ($record['title'] ?? '')) ?? '')
    // The 'u' flag makes php answer null for a subject that is not valid utf-8, and
    // `?? ''` turns that into the empty string, which then takes the md5 branch.
    const cleaned = pregReplaceUOrNull(WORD_CLEAN, '', strOrNull(record.title));
    let base = phpTrim(cleaned === null ? '' : cleaned);
    if (base === '' || base === '-') {
      base = md5Hex(s.url).slice(0, 10);
    }
    const ext = extensionFor(s.kind);
    base = base.slice(0, 90); // substr(): bytes, and a byte is a char here
    if (new RegExp('\\.' + ext + '$', 'i').test(base)) {
      // Pages love naming the file after itself, and "clip.mp4.mp4" in the
      // downloads folder reads like a bug rather than a renamed file.
      return base;
    }
    return base + '.' + ext;
  }

  /**
   * A page title that is only the site's own name tells the visitor nothing, and it
   * would also become the filename of the download. Fall back to a plain host label
   * in that case.
   */
  static titleFor(title, pageUrl) {
    const host = registrable(strOrNull(hostOf(pageUrl)));
    const core = pregReplaceTail(host);
    const flat = strtolowerBytes(pregReplaceNonAlnum(title));
    const flatCore = strtolowerBytes(pregReplaceNonAlnum(core));
    if (title === ''
      // php's `~^[0-9a-f]{16,}$~i` over trim($title); a hash-looking title is a slug, not a name.
      || /^[0-9a-f]{16,}$/i.test(phpTrim(title))
      || (flatCore !== '' && (flat.startsWith(flatCore) || flat === flatCore))) {
      return Analyzer.label(host);
    }
    return title;
  }

  /** ucwords(str_replace('-', ' ', preg_replace('~\.[a-z]{2,}$~i', '', $host))) */
  static label(host) {
    return ucwordsBytes(strOrNull(host).replace(/-/g, ' ').replace(TAIL_DOT, ''));
  }

  /**
   * @returns {Promise<string>} the url to fetch, after the SSRF wall has said yes
   */
  static async normalize(url, deps = {}) {
    let u = phpTrim(String(url === null || url === undefined ? '' : url));
    if (u === '') {
      throw new ExtractException('Paste a video link first.', '', 'empty');
    }
    if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(u)) {
      // People paste "youtube.com/watch?v=..." constantly.
      u = 'https://' + u.replace(/^\/+/, '');
    }
    if (!filterVarUrl(u)) {
      throw new ExtractException('That is not a valid link.', '', 'bad_url');
    }
    const guard = deps.guard ?? assertSafeAsync;
    // php's UrlGuard::assertSafe($url); in this port the resolver is injectable.
    await guard(u, deps.dns);
    return u;
  }

  /**
   * A specialised extractor that fails should not be the last word: the generic
   * reader often finds what the host-specific rule missed. An intentional refusal
   * is the last word, though, and falling through to the generic reader there would
   * paper over it with a dead link.
   *
   * @returns {Promise<import('./mediaBundle.mjs').MediaBundle>}
   */
  static async runExtractor(extractor, pageUrl, http, registry) { // eslint-disable-line no-unused-vars
    let bundle;
    try {
      bundle = await extractor.extract(pageUrl, http);
    } catch (e) {
      // php caught ExtractException only; any other throwable is still fatal here.
      if (!(e instanceof ExtractException) && String(e?.name ?? '') !== 'ExtractException') {
        throw e;
      }
      const { GenericExtractor } = await import('./genericExtractor.mjs');
      if (extractor instanceof GenericExtractor || e.codeName === 'gated') {
        throw e;
      }
      vdLog('host extractor failed, retrying generic', { host: extractor.name(), error: e.message });
      bundle = await new GenericExtractor().extract(pageUrl, http);
    }
    bundle.provider = extractor.name() !== 'generic'
      ? extractor.name()
      : registrable(strOrNull(hostOf(pageUrl)));
    return bundle;
  }
}

/**
 * `preg_replace('/[^\w\-. ]+/u', '', $t)` with the code-point class php uses once
 * the 'u' modifier is on: \w there is every Unicode letter and number plus the ascii
 * underscore, and it is not \p{M} (a combining mark is stripped) and not \p{Pc} (a
 * fullwidth low line is stripped) - both pinned against php 8.3 in
 * parity/test-analyzer.mjs. The literal ' ' is the single byte 0x20, so NBSP and the
 * other separators go too.
 */
const WORD_CLEAN = /[^\p{L}\p{N}_\.\- ]+/gu;

/** ~\.[a-z]{2,}$~i over a byte string: one trailing dot-label of two or more letters. */
const TAIL_DOT = /\.[a-z]{2,}$/i;

// ------------------------------------------------------------------ php helpers

/**
 * ExtractorRegistry::registrable(), copied here rather than imported because the
 * registry is another module's port and present()/runExtractor() reach it from
 * synchronous code. parity/test-analyzer.mjs diffs every line of this copy against
 * the php original, the same way jobStore.mjs pins its own copy.
 */
function registrable(host) {
  const h = strtolowerBytes(trimDots(String(host ?? '')));
  const parts = h.split('.');
  if (parts.length < 2) {
    return h;
  }
  // co.uk / com.bd / gov.in style second-level public suffixes.
  const tails = ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'mil', 'ne', 'or', 'go', 'lg'];
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  if (last.length === 2 && tails.includes(second)) {
    return parts.slice(-3).join('.');
  }
  return second + '.' + last;
}

function trimDots(s) {
  return s.replace(/^\.+/, '').replace(/\.+$/, '');
}

/** parse_url($url, PHP_URL_HOST) ?: '' as a string; a false parse is '' too. */
function hostOf(url) {
  const p = parseUrl(String(url));
  if (!p || typeof p !== 'object') {
    return null;
  }
  const host = p.host === undefined ? null : p.host;
  return host ? String(host) : null;
}

/** (string) of a value that php wrote as `(string) $x` where $x may be null. */
function strOrNull(v) {
  if (v === null || v === undefined) {
    return '';
  }
  return typeof v === 'boolean' ? (v ? '1' : '') : String(v);
}

/** empty(): '', '0', 0, null, false and [] are all empty in php. */
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

/** strtolower(): php folds ascii bytes only, javascript's toLowerCase folds unicode. */
function strtolowerBytes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/**
 * ucwords() over the default php word delimiters (" \t\r\n\f\v"), ascii-only case
 * folding like php's on a byte string. The only caller feeds it a host name.
 */
function ucwordsBytes(s) {
  const delimiters = ' \t\n\r\x0B\f';
  let out = '';
  let atWordStart = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (delimiters.includes(ch)) {
      atWordStart = true;
      out += ch;
      continue;
    }
    if (atWordStart) {
      const c = s.charCodeAt(i);
      out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : ch;
      atWordStart = false;
      continue;
    }
    out += ch;
  }
  return out;
}

/** preg_replace('~[^a-z0-9]+~', '', $t) - byte mode, so every non-ascii byte is dropped. */
function pregReplaceNonAlnum(t) {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      out += t[i];
    }
  }
  return out;
}

function pregReplaceTail(host) {
  return host.replace(TAIL_DOT, '');
}

/** match ($s->kind) { MP4 => mp4, WEBM => webm, MKV => mkv, HLS, TS => ts, default => bin } */
function extensionFor(kind) {
  switch (kind) {
    case Source.MP4: return 'mp4';
    case Source.WEBM: return 'webm';
    case Source.MKV: return 'mkv';
    case Source.HLS:
    case Source.TS: return 'ts';
    default: return 'bin';
  }
}

/** md5($url) over the bytes, hex, lowercase - the same digest php's md5() answers. */
function md5Hex(url) {
  return crypto.createHash('md5').update(Buffer.from(String(url), 'latin1')).digest('hex');
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
 * preg_replace with the 'u' modifier: null when the subject is not valid utf-8
 * (which is what php answers and what `?? ''` then swallows), otherwise the
 * replacement over code points, re-encoded to bytes. Same technique as the private
 * pregReplaceU() in mediaSniffer.mjs, which is not exported.
 */
function pregReplaceUOrNull(re, replacement, subject) {
  if (!bytesAreUtf8(subject)) {
    return null;
  }
  const decoded = Buffer.from(subject, 'latin1').toString('utf8');
  const replaced = decoded.replace(re, replacement);
  return Buffer.from(replaced, 'utf8').toString('latin1');
}

/**
 * filter_var($u, FILTER_VALIDATE_URL). Copied from the implementation pinned byte
 * by byte against php 8.3 in mediaSniffer.mjs (it is module-private there): the
 * whole string must be printable ascii, the scheme is `[a-z0-9+.-]+`, the userinfo
 * may not hold `"<>\[]^`{|}`, a host must be a label list or a bracketed ipv6, and
 * a port is at most five digits and at most 65535. normalize() reaches here with
 * anything the visitor pasted, so none of the "only ever https" shortcuts apply.
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

function userinfoOk(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (USERINFO_BAD.has(c)) {
      return false;
    }
    if (c === '%') {
      if (!/^[0-9A-Fa-f]{2}/.test(text.slice(i + 1, i + 3))) {
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
  for (const lab of h.split('.')) {
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
  return parseInt(/^[0-9]+/.exec(field)[0], 10) <= 65535;
}

function ipv6Ok(content) {
  if (content === '' || /:::/.test(content)) {
    return false;
  }
  const dbl = content.indexOf('::');
  const hasDouble = dbl >= 0;
  if (hasDouble && content.indexOf('::', dbl + 1) >= 0) {
    return false;
  }
  const seg = (x) => (x === '' ? [] : x.split(':'));
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

// ------------------------------------------------------------------ the lazy defaults

/** vd_log() from lib/support.php. Like streamtapeExtractor.mjs, this port has no
 *  filesystem logger, and the sink baseExtractor.mjs installs with setVdLog() is
 *  module-private there; the line is kept in place for when one is wired up. */
function vdLog() { /* see baseExtractor.mjs on setVdLog(); no visitor-facing effect */ }

async function createRegistry() {
  const { ExtractorRegistry } = await import('./extractorRegistry.mjs');
  return new ExtractorRegistry();
}

async function createHttp() {
  const { HttpClient } = await import('../net/httpClient.mjs');
  return new HttpClient();
}

async function createStore(deps) {
  const { JobStore } = await import('../job/jobStore.mjs');
  if (typeof deps.clock === 'function') {
    return new JobStore({ now: () => Math.floor(deps.clock()) });
  }
  return new JobStore();
}

export const __testing = { registrable, filterVarUrl, pregReplaceUOrNull, WORD_CLEAN, extensionFor, md5Hex, ucwordsBytes };
