import { urlAbsolutize } from '../support.mjs';
import { ExtractException } from '../errors.mjs';
import { Source, phpUrlComponent } from './source.mjs';
import { BaseExtractor, strtolowerBytes } from './baseExtractor.mjs';

/**
 * Port of lib/Extractor/XfsExtractor.php: the XFS file host family (dupload.net and
 * its mirrors).
 *
 * One form does everything: the page posts its own hidden fields back and the answer
 * is a 302 straight to the file, whose name is in the path. The link is minted per
 * request and the token folder changes every time, so it must never be cached.
 *
 * Mirrors of the same script differ only in what they put in front of that form.
 * When a captcha or a countdown is on the page we say so instead of pretending the
 * link is broken: defeating either one is not something this tool does. That refusal
 * is the feature here - formFields()/gateOn() are the pure helpers, differential-tested.
 */

const S = '\\x09\\x0A\\x0B\\x0C\\x0D\\x20';
const QUOTE = '[\\x22\\x27]';
const NOTQ = '[^\\x22\\x27]';
const W = 'A-Za-z0-9_';

export class XfsExtractor extends BaseExtractor {
  static phpClass = 'XfsExtractor';

  hosts() {
    return ['dupload.net', 'dupload.pro', 'dupload.info'];
  }

  priority() {
    return 20;
  }

  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    const b = this.newBundle(pageUrl, 'xfs');

    const res = await http.get(pageUrl, { headers: { Referer: pageUrl } });
    this.fillMeta(b, res);
    if (!res.ok()) {
      throw new ExtractException('That file host answered HTTP ' + res.status + '.', 'The link is probably dead.', 'http_' + res.status);
    }

    const fields = XfsExtractor.formFields(res.body);
    if (Object.keys(fields).length === 0) {
      throw new ExtractException('That page has no download form on it.', 'Use the address of the file page.', 'no_form');
    }
    const gate = XfsExtractor.gateOn(res.body);
    if (gate !== '') {
      throw new ExtractException('This host puts a ' + gate + ' in front of the file.', 'That is their rule, and this tool will not get around it. Download from their own page instead.', 'gated');
    }

    if (!Object.prototype.hasOwnProperty.call(fields, 'method_free')) {
      fields.method_free = 'Normal Download';
    }
    fields.adblock_detected = '0';

    const post = await http.post(res.finalUrl, '', {
      form: fields,
      headers: { Referer: res.finalUrl },
      max_redirects: 0,
      timeout: 20,
    });
    const location = String((post.header('location') ?? ''));
    if (post.status !== 302 || location === '') {
      throw new ExtractException('The host did not hand over a file.', 'Its free queue is probably full. Try again in a minute.', 'no_redirect');
    }

    const media = urlAbsolutize(res.finalUrl, location);
    const s = Source.make(media, media.includes('.m3u8') ? Source.HLS : Source.MP4);
    const name = rawurldecode(phpUrlComponent(media, 'path') ? String(phpUrlComponent(media, 'path')) : '');
    const base = basenamePhp(name);
    if (base !== '' && base.includes('.')) {
      s.label = 'Original file';
      if (b.title === null || b.title === undefined) {
        b.title = base.replace(/\.[a-z0-9]{2,4}$/i, '');
      }
    }
    s.headers = { Referer: res.finalUrl };
    b.addSource(s);

    b.sources = await this.verifyAll(b.sources, http, b);
    if (b.sources.length === 0) {
      throw new ExtractException('The file address that host gave was refused.', 'Its links expire almost immediately. Paste the page again.', 'token_expired');
    }
    s.note = 'This host mints a new file address every time the page opens, so paste the link again if this one stops working.';
    b.confidence = 0.88;
    return b;
  }

  /**
   * Hidden inputs of the download form, kept as the page sent them.
   * @returns {Record<string,string>}
   */
  static formFields(html) {
    let content = null;
    const f1 = new RegExp('<form[^>]+name=' + QUOTE + 'F1' + QUOTE + '(.{0,4000}?)</form>', 'is').exec(html);
    if (f1 !== null) {
      content = f1[1];
    } else {
      const f2 = new RegExp('<form(.{0,4000}?)</form>', 'is').exec(html);
      if (f2 !== null) {
        content = f2[1];
      } else {
        return {};
      }
    }
    const out = {};
    const inputRe = new RegExp('<input[^>]+type=' + QUOTE + 'hidden' + QUOTE + '[^>]*>', 'i');
    for (const tag of matchAll(inputRe, content)) {
      const n = new RegExp('name=' + QUOTE + '(' + W + '+)' + QUOTE).exec(tag);
      if (n === null) {
        continue;
      }
      const v = new RegExp('value=' + QUOTE + '(' + NOTQ + '*)' + QUOTE).exec(tag);
      const value = v !== null ? v[1] : '';
      out[n[1]] = htmlEntityDecode(value);
    }
    const has = (k) => Object.prototype.hasOwnProperty.call(out, k) && out[k] !== null;
    return has('op') && has('id') ? out : {};
  }

  /** What the host put between the visitor and the file, or '' when there is nothing. */
  static gateOn(html) {
    const hay = strtolowerBytes(String(html));
    if (hay.includes('h-captcha') || hay.includes('hcaptcha.com')) {
      return 'captcha check';
    }
    if (hay.includes('g-recaptcha') || hay.includes('recaptcha/api.js')) {
      return 'captcha check';
    }
    const hasCountdown = new RegExp('id=' + QUOTE + 'countdown' + QUOTE, 'i').test(html);
    const waits = new RegExp('Wait[' + S + ']*<|<span[^>]*id=' + QUOTE + 'seconds' + QUOTE, 'i').test(html);
    if (hasCountdown && waits) {
      return 'wait timer';
    }
    return '';
  }
}

// ------------------------------------------------------------------ helpers

function matchAll(re, subject) {
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

/** rawurldecode(): %XX becomes the byte, '+' left alone. */
function rawurldecode(text) {
  let out = '';
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9a-fA-F]{2}/.test(s.slice(i + 1, i + 3))) {
      out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out += s[i];
    }
  }
  return out;
}

/** html_entity_decode($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') for a byte string. */
function htmlEntityDecode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: '\u00A0' };
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (all, inner) => {
    if (inner[0] === '#') {
      const hex = inner[1] === 'x' || inner[1] === 'X';
      const cp = parseInt(hex ? inner.slice(2) : inner.slice(1), hex ? 16 : 10);
      if (Number.isNaN(cp)) return all;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return all;
      }
    }
    return Object.prototype.hasOwnProperty.call(named, inner) ? named[inner] : all;
  });
}

/** basename() with the forward-slash separator the deployed (linux) php uses. */
function basenamePhp(path) {
  let i = path.length;
  while (i > 0 && path[i - 1] === '/') i--;
  if (i === 0) return '';
  let j = i;
  while (j > 0 && path[j - 1] !== '/') j--;
  return path.slice(j, i);
}

export default XfsExtractor;
