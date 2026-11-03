import { urlAbsolutize, phpTrim } from '../support.mjs';
import { ExtractException } from '../errors.mjs';
import { phpUrlComponent, Source } from './source.mjs';
import { BaseExtractor } from './baseExtractor.mjs';
import { ExtractorRegistry } from './extractorRegistry.mjs';

/**
 * Port of lib/Extractor/StreamtapeExtractor.php: streamtape.com.
 *
 * The page assembles its download link in js and scatters decoys:
 *   document.getElementById('captchalink').innerHTML = '//streamtape.com/get_video?id='
 *       + ('defg74Awo...&token=lgLw_dA8kbiI').substring(4);
 *   document.getElementById('norobotlink').innerHTML = "/streamtape.com/get_video?id=7"
 *       + ''+ ('xcdd4Awo...').substring(1).substring(2);   // corrupted id
 * plus hidden divs holding dead tokens. Which line is live moves around, so the
 * only safe reading is to evaluate every builder expression and then test the
 * results against the server, keeping whichever one answers with video.
 *
 * Byte-string rule: this host's markup is a php latin1 string, one javascript char
 * per byte. Every regex below spells out php's non-unicode character classes
 * (\s, \w, \d) as the exact ASCII bytes php matches, so a match on a real page and a
 * match here agree byte for byte. The pure helpers linkCandidates()/evalConcat() are
 * public and differential-tested against php in parity/test-hosts.mjs.
 */

/** php's non-unicode \s: the six ASCII whitespace bytes, nothing more. */
const S = '\\x09\\x0A\\x0B\\x0C\\x0D\\x20';
/** php's \w (no /u): [0-9A-Za-z_]. */
const W = 'A-Za-z0-9_';
/** the php [A-Za-z0-9] the id and page-id patterns use (no underscore). */
const ALNUM = 'A-Za-z0-9';
/** the html shell bytes excluded from the url stop class: < and > (quotes handled inline). */

/** A streamtape decoy that never reaches the visitor: php routes it to vd_log, whose
 *  filesystem sink is not part of this port, so the redacted line is dropped by
 *  default exactly as baseExtractor drops 'candidate rejected'. */
function vdLog() { /* see baseExtractor.mjs on setVdLog(); no visitor-facing effect */ }

export class StreamtapeExtractor extends BaseExtractor {
  static phpClass = 'StreamtapeExtractor';

  hosts() {
    return ['streamtape.com', 'streamtape.net', 'streamtape.to', 'streamta.pe', 'shrtst.com', 'streamdav.net', 'tapecontent.net', 'advtpe.com', 'advtpe.net'];
  }

  priority() {
    return 20;
  }

  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    const b = this.newBundle(pageUrl, 'streamtape');
    const who = ucfirst(ExtractorRegistry.registrable(hostOrEmpty(pageUrl)));
    const res = await http.get(pageUrl, { headers: { Referer: pageUrl } });
    if (!res.ok()) {
      throw new ExtractException(who + ' answered HTTP ' + res.status + '.', 'The file may be gone, or the link is wrong.', 'http_' + res.status);
    }
    this.fillMeta(b, res);

    const candidates = StreamtapeExtractor.linkCandidates(res.body, res.finalUrl);
    if (candidates.length === 0) {
      throw new ExtractException(who + ' gave no download link.', 'Their page changed, or this video is locked to their app.', 'no_link');
    }

    let chosen = null;
    for (const url of candidates) {
      if (http.remaining() <= 0) {
        break;
      }
      const s = Source.make(url, Source.MP4);
      s.label = 'Original quality';
      s.headers = { Referer: res.finalUrl };
      s.tokenExpiryFromQuery();
      if (await this.verify(s, http)) {
        chosen = s;
        break;
      }
      vdLog('streamtape decoy or dead token', { url: redactToken(url) });
    }

    if (chosen === null) {
      throw new ExtractException(who + ' refused every link the page offered.', 'Their token usually clears on a second try. Paste the same address again.', 'token_expired');
    }
    chosen.note = who + ' links stay open roughly 19 hours.';
    b.sources = [chosen];
    b.confidence = 0.92;
    return b;
  }

  /**
   * @returns {string[]} candidate get_video urls, js-built ones first.
   * Verbatim port of StreamtapeExtractor::linkCandidates().
   */
  static linkCandidates(html, baseUrl) {
    const out = [];

    // 1. innerHTML / href assignments built from string literals and .substring()
    for (const expr of matchAllGroup(new RegExp('\\.innerHTML[' + S + ']*=[' + S + ']*([^;\\x0A]{10,600})'), html, 1)) {
      const built = StreamtapeExtractor.evalConcat(expr);
      if (built !== null && built.includes('get_video') && built.includes('token=')) {
        out.push(urlAbsolutize(baseUrl, built));
      }
    }

    // 2. a complete literal in the markup (older mirrors)
    const literal = new RegExp('(?:https?:)?//[^' + S + '"\\' + '\x27<>]*?/get_video\\?[^' + S + '"\\' + '\x27<>]*token=[' + W + '\\-]+', 'gi');
    for (const u of matchAllFull(literal, html)) {
      out.push(urlAbsolutize(baseUrl, u));
    }

    // 3. reconstructed from the loose parts, in case the shape changes again
    const parts = new RegExp('get_video\\?(id=[' + ALNUM + ']+&expires=[0-9]+&ip=[' + W + ']+&token=[' + W + '\\-]+)');
    for (const q of matchAllGroup(parts, html, 1)) {
      out.push('https://' + (hostOrEmpty(baseUrl) || 'streamtape.com') + '/get_video?' + q);
    }

    let uniq = arrayUnique(out);
    // A url whose id matches the page id is far more likely to be the live one.
    let pageId = null;
    const pm = new RegExp('/(?:v|e|embed|f)/([' + ALNUM + ']+)').exec(baseUrl);
    if (pm !== null) {
      pageId = pm[1];
    }
    if (pageId !== null) {
      const rank = (u) => (u.includes('id=' + pageId + '&') ? 0 : 1);
      // usort height 0/1, stable in php 8 and in node, so relative order is kept.
      uniq = uniq.map((v, i) => [v, i]).sort((a, c) => rank(a[0]) - rank(c[0]) || a[1] - c[1]).map((p) => p[0]);
    }
    return uniq.slice(0, 5);
  }

  /**
   * Evaluate a safe js string expression made only of literals, + and .substring(n).
   * Returns null when the expression uses anything else, so a changed shape fails
   * loudly instead of producing a half-built url.
   */
  static evalConcat(expr) {
    expr = phpTrim(expr);
    if (expr === '' || expr.length > 900) {
      return null;
    }
    const terms = splitTopLevel(expr, '+');
    if (terms === null || terms.length === 0) {
      return null;
    }
    let out = '';
    let sawLiteral = false;
    for (const t of terms) {
      const val = evalTerm(t);
      if (val === null) {
        return null;
      }
      if (phpTrim(t) !== '') {
        sawLiteral = true;
      }
      out += val;
    }
    return sawLiteral ? out : null;
  }
}

// ---------------------------------------------------------------- private statics

/** One term: a quoted literal, a parenthesised sub-expression, or either with .substring() applied. */
function evalTerm(t) {
  t = phpTrim(t);
  if (t === '') {
    return '';
  }
  if (t[0] === '(') {
    const close = matchingParen(t);
    if (close === null) {
      return null;
    }
    let value = StreamtapeExtractor.evalConcat(t.slice(1, close));
    if (value === null) {
      return null;
    }
    let rest = phpTrim(t.slice(close + 1));
    while (rest !== '') {
      const m = new RegExp('^\\.substring\\([' + S + ']*([0-9]+)[' + S + ']*\\)(.*)$', 's').exec(rest);
      if (m === null) {
        return null;
      }
      value = value.slice(phpIntDigits(m[1]));
      rest = phpTrim(m[2]);
    }
    return value;
  }
  const m = new RegExp("^(['\"])((?:(?!\\1).)*)\\1$", 's').exec(t);
  if (m !== null) {
    return m[2];
  }
  return null;
}

/** Index of the ) that closes the ( at position 0, quote aware. */
function matchingParen(s) {
  let depth = 0;
  let quote = null;
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const c = s[i];
    if (quote !== null) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) {
        return i;
      }
      if (depth < 0) {
        return null;
      }
    }
  }
  return null;
}

/** @returns {string[]|null} split on $delim, ignoring it inside quotes and brackets */
function splitTopLevel(s, delim) {
  const parts = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const c = s[i];
    if (quote !== null) {
      buf += c;
      if (c === '\\') {
        buf += s[++i] ?? '';
        continue;
      }
      if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      buf += c;
      continue;
    }
    if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
      if (depth < 0) {
        return null;
      }
    }
    if (c === delim && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  parts.push(buf);
  return depth === 0 && quote === null ? parts : null;
}

// ------------------------------------------------------------------ byte helpers

/** parse_url($url, PHP_URL_HOST) ?: '' as a php byte string. */
function hostOrEmpty(url) {
  const h = phpUrlComponent(url, 'host');
  return h ? String(h) : '';
}

/** ucfirst(): the C-locale fold, only a-z gains a case. */
function ucfirst(s) {
  if (s === '') {
    return s;
  }
  const c = s.charCodeAt(0);
  return c >= 97 && c <= 122 ? String.fromCharCode(c - 32) + s.slice(1) : s;
}

/** preg_replace('/token=\w+/', 'token=***', $url) with php's \w. */
function redactToken(url) {
  return url.replace(new RegExp('token=[' + W + ']+', 'g'), 'token=***');
}

/** (int) of a pure-digit capture, without letting JS's unicode \d widen the input. */
function phpIntDigits(digits) {
  return Number(digits);
}

/** array_values(array_unique($arr)): keep first occurrence of each value, in order. */
function arrayUnique(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function matchAllFull(re, subject) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(subject)) !== null) {
    out.push(m[0]);
    if (m[0] === '') {
      g.lastIndex++;
    }
  }
  return out;
}

function matchAllGroup(re, subject, group) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(subject)) !== null) {
    if (m[group] !== undefined) {
      out.push(m[group]);
    }
    if (m[0] === '') {
      g.lastIndex++;
    }
  }
  return out;
}

export default StreamtapeExtractor;
