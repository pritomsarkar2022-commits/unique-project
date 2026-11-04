import { ExtractException, HttpException } from '../errors.mjs';
import { Source, phpUrlComponent } from './source.mjs';
import { BaseExtractor } from './baseExtractor.mjs';
import { JsUnpacker } from './jsUnpacker.mjs';

/**
 * Port of lib/Extractor/StreamfileExtractor.php: streamfile.net
 * (same t=/s=/e= scheme as the LuluStream backend).
 *
 * The master playlist sits in the page markup literally, inside a path that
 * contains commas, so the url pattern must not stop at a comma. The `[^"']+` stop
 * class is exactly that: it keeps every byte but the two quotes, so a comma-laden
 * signed path survives the match.
 *
 * It is not always there. On the pages that only show a poster, the playlist arrives
 * with the player, from POST /dl op=play - see playScript().
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
    // streamfiles.net is the plural the marketing pages link to; it 301s to
    // streamfile.net, so both names have to be claimed here or the redirect lands on
    // this host with the generic reader in charge.
    return ['streamfile.net', 'streamfile.io', 'streamfile.to', 'streamfiles.net', 'streamfiles.site'];
  }

  priority() {
    return 20;
  }

  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    const b = this.newBundle(pageUrl, 'streamfile');
    const res = await http.get(pageUrl, { headers: this.pageHeaders(pageUrl) });
    this.fillMeta(b, res);
    if (!res.ok()) {
      throw new ExtractException('Streamfile answered HTTP ' + res.status + '.', 'The video was probably removed.', 'http_' + res.status);
    }

    let candidates = StreamfileExtractor.playlistCandidates(res.body);

    if (candidates.length === 0) {
      const played = await this.playScript(res, http);
      if (played !== null) {
        candidates = StreamfileExtractor.playlistCandidates(played);
      }
    }

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

  /**
   * The master playlist is not in the page: the player is handed to a click, by a
   * POST to /dl whose json reply carries the packed script. Reading it is the same
   * request a browser makes when the visitor presses play, so it stays inside the
   * page's own session and asks nothing of a browser check.
   *
   * @returns {Promise<string|null>} the script with its packing opened, or null
   */
  async playScript(res, http) {
    const code = fileCodeOf(res.finalUrl);
    if (code === null) {
      return null;
    }
    const origin = (phpUrlComponent(res.finalUrl, 'scheme') ?? '') + '://' + (phpUrlComponent(res.finalUrl, 'host') ?? '');
    const form = 'op=play&file_code=' + rawurlencode(code)
      + '&embed=0&u=' + rawurlencode(res.finalUrl) + '&ref=';
    let reply;
    try {
      reply = await http.post(origin + '/dl', form, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: origin,
          Referer: res.finalUrl,
        },
        timeout: 20,
      });
    } catch (e) {
      if (e instanceof HttpException || String(e && e.name) === 'HttpException') {
        return null;
      }
      throw e;
    }
    if (!reply.ok()) {
      return null;
    }
    const data = reply.json();
    const script = data !== null && typeof data === 'object' && typeof data.js === 'string' ? data.js : reply.body;
    if (typeof script !== 'string' || script === '') {
      return null;
    }
    return JsUnpacker.flatten(script);
  }

  /**
   * The two shapes Streamfile writes its playlist in. `[^"']+` rather than `\S+`
   * because their signed paths are full of commas.
   *
   * @returns {string[]}
   */
  static playlistCandidates(text) {
    const source = new RegExp('<source[' + S + ']+src=' + QUOTE + '(https?://' + NOTQ + '+master\\.m3u8\\?' + NOTQ + '+)' + QUOTE, 'i');
    const bare = new RegExp('(https?://[a-z0-9.\\-]+/(?:hls2?|e|fs)/' + NOTQ + '+master\\.m3u8\\?' + NOTQ + '+)', 'i');
    return matchAllGroup(source, text, 1).concat(matchAllGroup(bare, text, 1));
  }
}

/** The file id a streamfile page is named after: /5fiez7fe88ld.html. */
function fileCodeOf(url) {
  const m = /\/([a-z0-9]{8,32})\.html(?:[?#]|$)/i.exec(String(url ?? ''));
  return m === null ? null : m[1];
}

/** rawurlencode(): unreserved stays, every other byte becomes %XX. */
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
