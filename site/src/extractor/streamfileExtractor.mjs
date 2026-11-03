import { ExtractException } from '../errors.mjs';
import { Source } from './source.mjs';
import { BaseExtractor } from './baseExtractor.mjs';

/**
 * Port of lib/Extractor/StreamfileExtractor.php: streamfile.net
 * (same t=/s=/e= scheme as the LuluStream backend).
 *
 * The master playlist sits in the page markup literally, inside a path that
 * contains commas, so the url pattern must not stop at a comma. The `[^"']+` stop
 * class is exactly that: it keeps every byte but the two quotes, so a comma-laden
 * signed path survives the match.
 *
 * Byte-string rule: every regex spells out php's non-unicode classes as ASCII bytes.
 */

/** php's non-unicode \s. */
const S = '\\x09\\x0A\\x0B\\x0C\\x0D\\x20';
/** the php `["\']` (double or single quote). */
const QUOTE = '[\\x22\\x27]';
/** the php `[^"\']` stop class (neither quote byte). */
const NOTQ = '[^\\x22\\x27]';

export class StreamfileExtractor extends BaseExtractor {
  static phpClass = 'StreamfileExtractor';

  hosts() {
    return ['streamfile.net', 'streamfile.io', 'streamfile.to', 'streamfiles.site'];
  }

  priority() {
    return 20;
  }

  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    const b = this.newBundle(pageUrl, 'streamfile');
    const res = await http.get(pageUrl, { headers: { Referer: pageUrl } });
    this.fillMeta(b, res);
    if (!res.ok()) {
      throw new ExtractException('Streamfile answered HTTP ' + res.status + '.', 'The video was probably removed.', 'http_' + res.status);
    }

    let candidates = [];
    const m = matchAllGroup(new RegExp('<source[' + S + ']+src=' + QUOTE + '(https?://' + NOTQ + '+master\\.m3u8\\?' + NOTQ + '+)' + QUOTE, 'i'), res.body, 1);
    candidates = candidates.concat(m);
    const m2 = matchAllGroup(new RegExp('(https?://[a-z0-9.\\-]+/(?:hls2?|e|fs)/' + NOTQ + '+master\\.m3u8\\?' + NOTQ + '+)', 'i'), res.body, 1);
    candidates = candidates.concat(m2);

    if (candidates.length === 0) {
      const found = this.sniff(res, this.htmlHeaders(res));
      if (found.length === 0) {
        throw new ExtractException('Streamfile shows no stream on that page.', 'The file is gone, or the link is not a video page.', 'no_media');
      }
      b.sources = await this.verifyAll(found, http, b);
      return b;
    }

    for (const u of arrayUnique(candidates)) {
      const s = Source.make(u, Source.HLS);
      s.label = 'Video stream';
      s.headers = { Referer: res.finalUrl };
      s.tokenExpiryFromQuery();
      b.addSource(s);
    }
    b.sources = await this.verifyAll(b.sources, http, b);
    if (b.sources.length === 0) {
      throw new ExtractException('Streamfile refused the stream.', 'Their token expired. Run the same link again.', 'token_expired');
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

export default StreamfileExtractor;
