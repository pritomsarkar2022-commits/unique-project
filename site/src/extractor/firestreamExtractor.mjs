import { phpInt } from '../support.mjs';
import { ExtractException, HttpException } from '../errors.mjs';
import { Source, phpUrlComponent } from './source.mjs';
import { BaseExtractor } from './baseExtractor.mjs';
import { MediaSniffer } from './mediaSniffer.mjs';

/**
 * Port of lib/Extractor/FirestreamExtractor.php: firestream.to -> firestream.site.
 *
 * The page carries a single-use base64 blob; posting it to /api/videos/<slug>/resolve
 * returns the signed playlist. The blob dies on reuse (502) and on age (403), so this
 * must happen inside one analysis request and must never be cached. The Origin header
 * php sends with the POST is what makes the resolve answer; it is kept here too.
 */

const S = '\\x09\\x0A\\x0B\\x0C\\x0D\\x20';
const W = 'A-Za-z0-9';

export class FirestreamExtractor extends BaseExtractor {
  static phpClass = 'FirestreamExtractor';

  hosts() {
    return ['firestream.to', 'firestream.site', 'firestream.net', 'firestrm.com'];
  }

  priority() {
    return 20;
  }

  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    const b = this.newBundle(pageUrl, 'firestream');
    const res = await http.get(pageUrl, { headers: { Referer: pageUrl } });
    this.fillMeta(b, res);
    if (!res.ok()) {
      throw new ExtractException('Firestream answered HTTP ' + res.status + '.', 'The video may be private or removed.', 'http_' + res.status);
    }

    let slug = null;
    const s1 = new RegExp('/(?:e|v|embed|f)/([' + W + ']+)').exec(res.finalUrl);
    if (s1 !== null) {
      slug = s1[1];
    } else {
      const s2 = new RegExp('[\\x22\\x27]slug[\\x22\\x27][' + S + ']*:[' + S + ']*[\\x22\\x27]([' + W + ']+)').exec(res.body);
      if (s2 !== null) {
        slug = s2[1];
      }
    }
    if (slug === null) {
      throw new ExtractException('Could not read the video id from that Firestream link.', '', 'bad_url');
    }

    const m = new RegExp('<script[' + S + ']+id="token-blob"[' + S + ']+type="text/plain">[' + S + ']*([^<]+?)[' + S + ']*</script>', 'is').exec(res.body);
    if (m === null) {
      // Fall back to the general reader in case they inline the url again.
      const found = await this.verifyAll(this.sniff(res, this.htmlHeaders(res)), http, b);
      if (found.length > 0) {
        b.sources = found;
        return b;
      }
      throw new ExtractException('Firestream no longer puts a resolve token in the page.', 'Their player changed; this host needs an update.', 'no_token');
    }
    const blob = phpTrimLocal(m[1]);

    const origin = (phpUrlComponent(res.finalUrl, 'scheme') ?? '') + '://' + (phpUrlComponent(res.finalUrl, 'host') ?? '');
    const api = origin + '/api/videos/' + rawurlencode(slug) + '/resolve';
    let json;
    try {
      json = await http.post(api, JSON.stringify({ blob }), {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: origin, Referer: res.finalUrl },
        timeout: 15,
      });
    } catch (e) {
      if (e instanceof HttpException || String(e && e.name) === 'HttpException') {
        throw new ExtractException('Firestream refused to hand out the stream.', 'Their token is single use, so this is usually a retry away.', 'resolve_failed');
      }
      throw e;
    }
    if (json.status === 403 || json.body.includes('Token expired')) {
      throw new ExtractException('Firestream said that token was stale.', 'Try the link again in a few seconds.', 'token_expired');
    }
    if (json.status === 502) {
      throw new ExtractException('Firestream counted that token as already used.', 'Reload the video page and paste it again.', 'blob_used');
    }
    const data = json.json();
    const signed = [];
    const quality = [['signedVideoUrl', 'Best quality'], ['signedVideoSdUrl', 'Standard quality']];
    for (const [k, label] of quality) {
      const value = data[k];
      if (typeof value === 'string' && !phpEmpty(value)) {
        const s = Source.make(value, MediaSniffer.kindOf(value) ?? Source.HLS);
        s.kind = value.includes('.m3u8') ? Source.HLS : s.kind;
        s.label = label;
        s.headers = { Referer: res.finalUrl, Origin: origin };
        s.tokenExpiryFromQuery();
        if (!phpEmpty(data['fileSize'])) {
          s.sizeBytes = phpInt(data['fileSize']);
        }
        signed.push(s);
      }
    }
    if (signed.length === 0) {
      throw new ExtractException('Firestream returned a resolve reply with no url in it.', '', 'no_media');
    }
    if (b.title === null || b.title === undefined) {
      b.title = data['title'] !== null && data['title'] !== undefined ? data['title'] : null;
    }
    if (!phpEmpty(data['thumbnail'])) {
      if (b.thumbnail === null || b.thumbnail === undefined) {
        b.thumbnail = String(data['thumbnail']);
      }
    }

    b.sources = await this.verifyAll(signed, http, b);
    if (b.sources.length === 0) {
      throw new ExtractException('The stream link Firestream gave is no longer live.', 'Run it again right away; those links expire in about two hours.', 'token_expired');
    }
    b.confidence = 0.9;
    return b;
  }
}

/** trim($s) with php's default byte list; the blob is a latin1 run. */
function phpTrimLocal(s) {
  let start = 0;
  let end = s.length;
  const chars = ' \t\n\r\x0B\u0000';
  while (start < end && chars.includes(s[start])) start++;
  while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
}

/** rawurlencode(): unreserved = A-Za-z0-9-._~, everything else %XX of the byte. */
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
      // a latin1 char is one byte; a wider code unit cannot appear in these byte strings,
      // but if one does, encode its utf-8 octets the way mb-less php would over the byte.
      const buf = Buffer.from(c, 'latin1');
      for (const byte of buf) {
        out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
      }
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

export default FirestreamExtractor;
