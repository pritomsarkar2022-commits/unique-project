import { urlAbsolutize } from '../support.mjs';
import { ExtractException } from '../errors.mjs';
import { Source } from './source.mjs';
import { BaseExtractor } from './baseExtractor.mjs';
import { JsUnpacker } from './jsUnpacker.mjs';
import { MediaSniffer } from './mediaSniffer.mjs';

/**
 * Port of lib/Extractor/LuluvidoExtractor.php: luluvido.com (LuluStream backend).
 *
 * The player config is a jwplayer().setup({...}) hidden in a Dean Edwards packed
 * script. Unpacking is pure string substitution, so no js engine is needed.
 *
 * Note the unpack chain: php runs `joinConcatenations(unescape(unpack(body)))`,
 * which unescapes AFTER unpacking - the reverse of JsUnpacker.flatten(). Keeping
 * that order matters, so the three statics are called directly rather than flattening.
 */

/** php's non-unicode \s. */
const S = '\\x09\\x0A\\x0B\\x0C\\x0D\\x20';
const QUOTE = '[\\x22\\x27]';
const NOTQ = '[^\\x22\\x27]';

export class LuluvidoExtractor extends BaseExtractor {
  static phpClass = 'LuluvidoExtractor';

  hosts() {
    return ['luluvido.com', 'luluvid.com', 'lulustream.com', 'lulu.gs', 'tnmr.org'];
  }

  priority() {
    return 20;
  }

  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    const b = this.newBundle(pageUrl, 'luluvido');
    const res = await http.get(pageUrl, { headers: { Referer: pageUrl } });
    this.fillMeta(b, res);
    if (!res.ok()) {
      throw new ExtractException('That Luluvido page returned HTTP ' + res.status + '.', 'The video is likely removed.', 'http_' + res.status);
    }

    const flat = JsUnpacker.joinConcatenations(JsUnpacker.unescape(JsUnpacker.unpack(res.body)));

    let urls = matchAllGroup(new RegExp('file[' + S + '*:[' + S + ']*' + QUOTE + '(https?://' + NOTQ + '+\\.m3u8\\?' + NOTQ + '+)' + QUOTE, 'i'), flat, 1);
    if (urls.length === 0) {
      urls = MediaSniffer.mediaUrls(flat).filter((u) => u.includes('.m3u8'));
    }
    if (urls.length === 0) {
      throw new ExtractException('The player on that page never revealed a stream.', 'Their packing changed, or the video needs their app.', 'no_media');
    }

    for (const u of arrayUnique(urls)) {
      const s = Source.make(urlAbsolutize(res.finalUrl, u), Source.HLS);
      s.label = 'Video stream';
      s.headers = { Referer: res.finalUrl };
      s.tokenExpiryFromQuery();
      b.addSource(s);
    }
    b.sources = await this.verifyAll(b.sources, http, b);
    if (b.sources.length === 0) {
      throw new ExtractException('Luluvido refused the stream request.', 'Try the link again; their token is short lived.', 'token_expired');
    }
    let encrypted = false;
    for (const s of b.sources) {
      for (const v of s.variants) {
        if (!phpEmpty(v['encrypted'])) {
          encrypted = true;
        }
      }
    }
    if (encrypted) {
      b.notice('This stream is AES-128 encrypted in transit. Preview works, and the MP4 save decrypts it as it goes.');
    }
    b.confidence = 0.9;
    return b;
  }
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

/** empty(): '', '0', 0, null, false, undefined and an empty list are all empty in php. */
function phpEmpty(v) {
  if (v === null || v === undefined || v === false || v === '' || v === 0 || v === '0') {
    return true;
  }
  if (Array.isArray(v)) {
    return v.length === 0;
  }
  return false;
}

export default LuluvidoExtractor;
