import { ExtractException, HttpException } from '../errors.mjs';
import { Source, phpUrlComponent } from './source.mjs';
import { BaseExtractor } from './baseExtractor.mjs';

/**
 * Port of lib/Extractor/VidaraExtractor.php: vidara.to.
 *
 * The watch page is a wrapper: the player lives on a rotating embed domain, and
 * that domain's /api/stream mints a token bound to the ip that asked for it.
 * Because our server both mints the token and relays the bytes, the ip stays
 * consistent. Handing this url to the browser directly would break - which is why
 * the source sets needsProxy = true and carries that note.
 *
 * The embed "warm" GET is a real outbound request php makes to seed the embed's
 * session cookie before the api/stream post; its body is discarded but the request
 * (and its budget) is not, so the port fires it and ignores the result exactly so.
 */

const W = 'A-Za-z0-9';
const S = '\\x09\\x0A\\x0B\\x0C\\x0D\\x20';
const QUOTE = '[\\x22\\x27]';
/** php `[^"/]`: neither a double quote byte nor a forward slash. */
const NOTSLASHQ = '[^\\x22\\x2F]';

export class VidaraExtractor extends BaseExtractor {
  static phpClass = 'VidaraExtractor';

  hosts() {
    return ['vidara.to', 'vidara.sx', 'dstyladsg.com'];
  }

  priority() {
    return 20;
  }

  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    const b = this.newBundle(pageUrl, 'vidara');

    let res = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      const target = pageUrl;
      try {
        res = await http.get(target, { headers: { Referer: target } });
        break;
      } catch (e) {
        if (!isHttp(e)) {
          throw e;
        }
        if (attempt === 1) {
          throw new ExtractException('Vidara is not answering right now.', 'Their server throws occasional connection errors. Try again in a minute.', 'host_down');
        }
        await sleep(1000);
      }
    }
    if (res === null) {
      throw new ExtractException('Vidara is not answering right now.', 'Try again in a minute.', 'host_down');
    }
    this.fillMeta(b, res);
    // 525 is Cloudflare failing to reach their origin, which happens in bursts.
    if (res.status === 525 || res.status === 521 || res.status === 523) {
      throw new ExtractException('Vidara origin is down at the moment (HTTP ' + res.status + ').', 'This clears on its own. Try again shortly.', 'host_down');
    }
    if (!res.ok()) {
      throw new ExtractException('Vidara answered HTTP ' + res.status + '.', 'The video may have been removed.', 'http_' + res.status);
    }

    let embed = null;
    const mi = new RegExp('<iframe[' + S + ']+src=' + QUOTE + '(https?://' + NOTSLASHQ + '+/(?:e|embed)/[' + W + ']+)' + QUOTE, 'i').exec(res.body);
    if (mi !== null) {
      embed = mi[1];
    } else {
      const m2 = new RegExp('https?://[a-z0-9.\\-]+/(?:e|embed)/[' + W + ']+', 'i').exec(res.body);
      if (m2 !== null) {
        embed = m2[0];
      }
    }
    if (embed === null) {
      const found = await this.verifyAll(this.sniff(res, this.htmlHeaders(res)), http, b);
      if (found.length > 0) {
        b.sources = found;
        return b;
      }
      throw new ExtractException('No Vidara player found inside that page.', 'Paste the watch link, not the share text.', 'no_media');
    }

    const filecode = basenamePhp((phpUrlComponent(embed, 'path') ? String(phpUrlComponent(embed, 'path')) : ''));
    const embedOrigin = (phpUrlComponent(embed, 'scheme') ?? '') + '://' + (phpUrlComponent(embed, 'host') ?? '');

    if (http.remaining() > 0 && !embed.startsWith(res.finalUrl)) {
      try {
        await http.get(embed, { headers: { Referer: res.finalUrl } });
      } catch (e) {
        if (!isHttp(e)) {
          throw e;
        }
      }
    }

    const body = JSON.stringify({ filecode, device: 'web', codecs: ['avc1.42E01E', 'mp4a.40.2'] });
    let api;
    try {
      api = await http.post(embedOrigin + '/api/stream', body, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: embedOrigin, Referer: embed },
        timeout: 15,
      });
    } catch (e) {
      if (isHttp(e)) {
        throw new ExtractException('The Vidara player server refused us.', 'Their embed host was unreachable. Try again shortly.', 'api_down');
      }
      throw e;
    }
    const data = api.json();
    const stream = present(data, 'streaming_url') ? data.streaming_url : (present(data, 'sx') ? data.sx : null);
    if (typeof stream !== 'string' || stream === '') {
      throw new ExtractException('Vidara returned no stream for that file.', 'The video is gone or playback is disabled.', 'no_media');
    }
    if (b.title === null || b.title === undefined) {
      b.title = present(data, 'title') ? data.title : null;
    }
    if (!phpEmpty(data.thumbnail)) {
      if (b.thumbnail === null || b.thumbnail === undefined) {
        b.thumbnail = String(data.thumbnail);
      }
    }

    const s = Source.make(stream, Source.HLS);
    s.label = 'Video stream';
    s.headers = { Referer: embed, Origin: embedOrigin };
    s.tokenExpiryFromQuery();
    s.needsProxy = true;
    s.note = 'Vidara binds its stream token to the server ip, so this one only works through our relay.';
    b.addSource(s);

    b.sources = await this.verifyAll(b.sources, http, b);
    if (b.sources.length === 0) {
      throw new ExtractException('Vidara refused the stream it just issued.', 'Try the link once more.', 'token_expired');
    }
    b.confidence = 0.85;
    return b;
  }
}

function present(obj, key) {
  return obj !== null && obj !== undefined && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== null;
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

function isHttp(e) {
  return e instanceof HttpException || String(e && e.name) === 'HttpException';
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default VidaraExtractor;
