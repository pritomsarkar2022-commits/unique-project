import { urlAbsolutize } from '../support.mjs';
import { ExtractException, HttpException } from '../errors.mjs';
import { Source, phpUrlComponent, parseStr } from './source.mjs';
import { BaseExtractor } from './baseExtractor.mjs';

/**
 * Port of lib/Extractor/CloudfamExtractor.php: cloudfam.io.
 *
 * Three hops and no js to decode. The short link redirects to prestream.php, which
 * hands out a token when the page-load ping is posted back, and stream.php then
 * renders a plain <video><source> with the file on their cdn. The token is tied to
 * the session cookie, so all three hops have to share one jar, which the client
 * already does. The countdown on their page is decoration; the server answers
 * immediately - so a page that will not hand over the file is refused, not chased.
 *
 * firstSourceTag() is public and differential-tested against php in parity/test-hosts.mjs.
 */

const S = '\\x09\\x0A\\x0B\\x0C\\x0D\\x20';
const QUOTE = '[\\x22\\x27]';

/** php routes this to vd_log; the filesystem sink is not part of this port (see baseExtractor.mjs). */
function vdLog() { /* no visitor-facing effect */ }

export class CloudfamExtractor extends BaseExtractor {
  static phpClass = 'CloudfamExtractor';

  hosts() {
    return ['cloudfam.io', 'files.cloudfam.io'];
  }

  priority() {
    return 20;
  }

  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    const b = this.newBundle(pageUrl, 'cloudfam');

    const gate = await http.get(pageUrl, { headers: { Referer: pageUrl } });
    this.fillMeta(b, gate);
    const prestream = gate.finalUrl;
    const q = parseStr(phpUrlComponent(prestream, 'query') ? String(phpUrlComponent(prestream, 'query')) : '');
    let slug = q.has('slug') ? String(q.get('slug')) : '';
    if (slug === '') {
      const m = new RegExp('/(?:cf|)([a-f0-9]{12,20})$', 'i').exec(pageUrl);
      if (m !== null) {
        slug = m[1];
      }
    }
    if (slug === '') {
      throw new ExtractException('That does not look like a Cloudfam file link.', 'Use the short address, the one like cloudfam.io/cf3b9cf55ec3.', 'bad_url');
    }

    let token = '';
    try {
      const ping = await http.post(prestream, '', {
        form: { action: 'log_first_page', adblock_detected: '0' },
        headers: { Referer: prestream, Origin: (phpUrlComponent(prestream, 'scheme') ?? '') + '://' + (phpUrlComponent(prestream, 'host') ?? '') },
        timeout: 15,
      });
      const data = ping.json();
      token = (data !== null && typeof data === 'object')
        ? toPhpString(present(data, 'token') ? data.token : '')
        : '';
    } catch (e) {
      if (!isHttp(e)) {
        throw e;
      }
      vdLog('cloudfam ping failed', { err: e.message });
    }

    // The stream origin is built from the pasted page url, exactly as php does - not the redirect target.
    const origin = (phpUrlComponent(pageUrl, 'scheme') ?? '') + '://' + (phpUrlComponent(pageUrl, 'host') ?? '');
    let stream = null;
    const tries = token !== '' ? [origin + '/stream.php?slug=' + rawurlencode(slug) + '&token=' + rawurlencode(token)] : [];
    for (const url of tries) {
      const res = await http.get(url, { headers: { Referer: prestream } });
      if (!res.ok()) {
        continue;
      }
      const media = CloudfamExtractor.firstSourceTag(res.body, res.finalUrl);
      if (media !== '') {
        stream = media;
        break;
      }
    }
    if (stream === null) {
      throw new ExtractException('Cloudfam would not open the file.', 'Their page counts down before it serves the video. Open it in your browser, wait it out, then paste the same address again.', 'no_media');
    }

    const s = Source.make(stream, stream.includes('.m3u8') ? Source.HLS : Source.MP4);
    s.label = 'Original file';
    s.headers = [];
    s.tokenExpiryFromQuery();
    b.addSource(s);

    b.sources = await this.verifyAll(b.sources, http, b);
    if (b.sources.length === 0) {
      throw new ExtractException('The Cloudfam file address did not answer.', 'Their link is minted per session. Paste the page address again.', 'token_expired');
    }
    b.confidence = 0.9;
    return b;
  }

  /** The src of the first <source> or <video src> in the markup, percent decoded. */
  static firstSourceTag(html, baseUrl) {
    const source = new RegExp('<source[^>]+src=' + QUOTE + '([^\\x22\\x27]+)' + QUOTE, 'i').exec(html);
    if (source !== null) {
      return urlAbsolutize(baseUrl, rawurldecode(phpTrimDefault(source[1])));
    }
    const video = new RegExp('<video[^>]+src=' + QUOTE + '([^\\x22\\x27]+)' + QUOTE, 'i').exec(html);
    if (video !== null) {
      return urlAbsolutize(baseUrl, rawurldecode(phpTrimDefault(video[1])));
    }
    return '';
  }
}

/** rawurldecode(): %XX becomes the byte, '+' is left alone (this is NOT urldecode). */
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

function rawurlencode(str) {
  let out = '';
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57)
      || c === '-' || c === '.' || c === '_' || c === '~') {
      out += c;
    } else {
      for (const byte of Buffer.from(c, 'latin1')) {
        out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

function toPhpString(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v) || typeof v === 'object') return 'Array';
  if (typeof v === 'boolean') return v ? '1' : '';
  return String(v);
}

function present(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== null;
}

function phpTrimDefault(s) {
  const chars = ' \t\n\r\x0B\u0000';
  const str = String(s);
  let start = 0;
  let end = str.length;
  while (start < end && chars.includes(str[start])) start++;
  while (end > start && chars.includes(str[end - 1])) end--;
  return str.slice(start, end);
}

function isHttp(e) {
  return e instanceof HttpException || String(e && e.name) === 'HttpException';
}

export default CloudfamExtractor;
