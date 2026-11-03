import { ExtractException, HttpException } from '../errors.mjs';
import { Source, phpUrlComponent } from './source.mjs';
import { BaseExtractor } from './baseExtractor.mjs';

/**
 * Port of lib/Extractor/PlaymateExtractor.php: playmate.to.
 *
 * A Vite single page app: the html holds no media at all. The player posts the
 * filecode to /api/s and gets back obfuscated keys, where sx is the stream url.
 * The stream files are disguised as .txt and .css, so nothing may be judged by
 * extension here: the source is always HLS, whatever the filename claims.
 *
 * Note there is deliberately NO tokenExpiryFromQuery() call - php makes none here,
 * and their url is minted per request.
 */

const W = 'A-Za-z0-9';

export class PlaymateExtractor extends BaseExtractor {
  static phpClass = 'PlaymateExtractor';

  hosts() {
    return ['playmate.to', 'playmate.net', 'plauymito.live'];
  }

  priority() {
    return 20;
  }

  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    const b = this.newBundle(pageUrl, 'playmate');
    let filecode = null;
    const m = new RegExp('/(?:watch|embed|v|f)/([' + W + ']+)').exec(pageUrl);
    if (m !== null) {
      filecode = m[1];
    } else {
      const pth = phpUrlComponent(pageUrl, 'path') ? String(phpUrlComponent(pageUrl, 'path')) : '';
      const m2 = new RegExp('^([' + W + ']{8,20})$').exec(phpTrimDefault(pth));
      if (m2 !== null) {
        filecode = m2[1];
      }
    }
    if (filecode === null) {
      throw new ExtractException('That does not look like a Playmate video link.', 'Use the address of the watch page.', 'bad_url');
    }

    const origin = (phpUrlComponent(pageUrl, 'scheme') ?? '') + '://' + (phpUrlComponent(pageUrl, 'host') ?? '');
    // json_encode(['c' => $filecode, 'd' => 'web']); a fixed shape the api reads by key.
    const body = JSON.stringify({ c: filecode, d: 'web' });
    let res;
    try {
      res = await http.post(origin + '/api/s', body, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: origin, Referer: origin + '/' },
        timeout: 15,
      });
    } catch (e) {
      if (e instanceof HttpException || String(e && e.name) === 'HttpException') {
        throw new ExtractException('Playmate did not answer.', 'Their service was unreachable or is rate limiting us.', 'api_down');
      }
      throw e;
    }
    if (res.status === 404) {
      throw new ExtractException('Playmate has no video with that code.', 'The file was deleted.', 'not_found');
    }
    const data = res.json();
    // $data['sx'] ?? $data['streaming_url'] ?? null: the first that is set (not null, present).
    const stream = present(data, 'sx') ? data.sx : (present(data, 'streaming_url') ? data.streaming_url : null);
    if (typeof stream !== 'string' || stream === '') {
      throw new ExtractException('Playmate refused to give a stream for that video.', 'The owner may have disabled playback, or the file is gone.', 'no_media');
    }
    if (b.title === null || b.title === undefined) {
      b.title = present(data, 'tx') ? data.tx : null;
    }
    if (!phpEmpty(data.ix)) {
      if (b.thumbnail === null || b.thumbnail === undefined) {
        b.thumbnail = String(data.ix);
      }
    }

    // Their master.txt is a playlist no matter what the filename claims.
    const s = Source.make(stream, Source.HLS);
    s.label = 'Video stream';
    s.headers = { Origin: origin, Referer: origin + '/' };
    b.addSource(s);

    b.sources = await this.verifyAll(b.sources, http, b);
    if (b.sources.length === 0) {
      throw new ExtractException('The stream Playmate handed out is not answering.', 'Call the link again; their url is minted per request.', 'token_expired');
    }
    if (!phpEmpty(data.kx) && isPhpArray(data.kx)) {
      b.notice('This video has subtitle tracks available.');
    }
    b.confidence = 0.88;
    return b;
  }
}

/** isset(): the key exists and is not null. */
function present(obj, key) {
  return obj !== null && obj !== undefined && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== null;
}

/** php's is_array() over a json_decode(..., true) value: objects and lists alike. */
function isPhpArray(v) {
  return v !== null && typeof v === 'object';
}

function phpTrimDefault(s) {
  const chars = ' \t\n\r\x0B\u0000';
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start++;
  while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
}

function phpEmpty(v) {
  if (v === null || v === undefined || v === false || v === '' || v === 0 || v === '0') {
    return true;
  }
  if (Array.isArray(v)) {
    return v.length === 0;
  }
  return false;
}

export default PlaymateExtractor;
