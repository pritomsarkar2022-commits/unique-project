import { ExtractException } from '../errors.mjs';
import { Source } from './source.mjs';
import { BaseExtractor } from './baseExtractor.mjs';

/**
 * Port of lib/Extractor/VixeoExtractor.php: vixeo.io (VidSonic / StreamSonic white label).
 *
 * The watch page carries its player config as a base64 json blob on
 * <div id="streamsonic-player-root" data-config="...">. Inside it the source is
 * stored as hex chunks separated by |, and each chunk has to be hex decoded,
 * joined and then reversed end to end before it reads as a url. The result is a
 * signed HLS playlist on their cdn, so the source headers stay empty: the cdn
 * answers on the token in the query alone, and a Referer of ours only risks
 * tripping their hotlink check.
 *
 * decodeSource() is public and differential-tested against php in parity/test-hosts.mjs.
 */

export class VixeoExtractor extends BaseExtractor {
  static phpClass = 'VixeoExtractor';

  hosts() {
    return ['vixeo.io', 'vidsonic.net', 'streamsonic.net'];
  }

  priority() {
    return 20;
  }

  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    const b = this.newBundle(pageUrl, 'vixeo');
    const res = await http.get(pageUrl, { headers: { Referer: pageUrl } });
    if (!res.ok()) {
      throw new ExtractException('Vixeo answered HTTP ' + res.status + '.', 'The file may be gone, or the link is wrong.', 'http_' + res.status);
    }
    this.fillMeta(b, res);

    const m = /data-config="([^"]+)"/.exec(res.body);
    if (m === null) {
      throw new ExtractException('That Vixeo page has no player on it.', 'Use the address of the watch page, the one with /e/ in it.', 'no_config');
    }
    const cfg = decodePlayerConfig(m[1]);
    if (cfg === null) {
      throw new ExtractException('The Vixeo player config did not read.', 'Their page changed shape.', 'bad_config');
    }

    const media = VixeoExtractor.decodeSource(toPhpString(present(cfg, 'source') ? cfg.source : ''));
    if (media === '') {
      throw new ExtractException('Vixeo gave no stream address.', 'The video is likely removed or still processing.', 'no_media');
    }
    if (!phpEmpty(cfg.title) && typeof cfg.title === 'string') {
      b.title = cfg.title;
    }
    if (!phpEmpty(cfg.poster) && typeof cfg.poster === 'string') {
      if (b.thumbnail === null || b.thumbnail === undefined) {
        b.thumbnail = cfg.poster;
      }
    }

    const isHls = media.includes('.m3u8');
    const s = Source.make(media, isHls ? Source.HLS : Source.MP4);
    s.label = isHls ? 'Video stream' : 'Original file';
    // The cdn answers on the token in the query alone; a Referer of ours only
    // risks tripping their hotlink check.
    s.headers = [];
    s.tokenExpiryFromQuery();
    b.addSource(s);

    b.sources = await this.verifyAll(b.sources, http, b);
    if (b.sources.length === 0) {
      throw new ExtractException('The stream Vixeo handed out is not answering.', 'Their link is minted per request. Paste the address again.', 'token_expired');
    }
    b.confidence = 0.9;
    return b;
  }

  /** Hex chunks split by |, decoded, joined, then the whole string reversed. */
  static decodeSource(blob) {
    blob = phpTrimDefault(blob);
    if (blob === '') {
      return '';
    }
    if (/^https?:\/\//i.test(blob)) {
      return blob;
    }
    let out = '';
    for (const chunk of blob.split('|')) {
      const mm = /^([0-9a-f]{2,})$/i.exec(phpTrimDefault(chunk));
      out += mm !== null ? hex2binStrict(mm[1]) : '';
    }
    return out === '' ? '' : strrevLatin(out);
  }
}

// ------------------------------------------------------------------ decode chain

/**
 * base64_decode(html_entity_decode($attr, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'), true)
 * then json_decode(..., true). Returns the parsed object/array, or null for anything
 * php would not hand back as an array (invalid base64, invalid json, a json scalar).
 */
function decodePlayerConfig(attr) {
  const decoded = htmlEntityDecode(attr);
  const bytes = base64DecodeStrict(decoded);
  if (bytes === null) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' ? parsed : null;
}

/**
 * html_entity_decode($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8').
 * ENT_QUOTES folds both quote styles; numeric entities decode; an unknown `&name;`
 * stays as php leaves it. Base64 attributes are ASCII, so this is a no-op there,
 * and the only entity worth worrying about inside an html attribute is `&amp;`.
 */
function htmlEntityDecode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: '\u00A0' };
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (all, inner) => {
    if (inner[0] === '#') {
      const hex = inner[1] === 'x' || inner[1] === 'X';
      const cp = parseInt(hex ? inner.slice(2) : inner.slice(1), hex ? 16 : 10);
      if (Number.isNaN(cp)) {
        return all;
      }
      try {
        return String.fromCodePoint(cp);
      } catch {
        return all;
      }
    }
    return Object.prototype.hasOwnProperty.call(named, inner) ? named[inner] : all;
  });
}

/**
 * base64_decode($s, true): php returns false when the input holds a byte outside
 * the base64 alphabet. Whitespace is not tolerated either, so a clean attribute
 * round-trips and anything else yields null, exactly as the strict flag decides.
 */
function base64DecodeStrict(s) {
  const str = String(s);
  if (str.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(str)) {
    return null;
  }
  const buf = Buffer.from(str, 'base64');
  return buf.toString('latin1');
}

/**
 * (string) cast of a json value, the way php would render it inside a byte string.
 * An array becomes 'Array', booleans '1'/''; numbers and strings are used as-is.
 */
function toPhpString(v) {
  if (v === null || v === undefined) {
    return '';
  }
  if (Array.isArray(v) || (typeof v === 'object')) {
    return 'Array';
  }
  if (typeof v === 'boolean') {
    return v ? '1' : '';
  }
  return String(v);
}

/** hex2bin($s): false for odd length, else the raw bytes as a latin1 string. */
function hex2binStrict(hex) {
  if (hex.length % 2 !== 0) {
    return ''; // php returns false; (string) false is ''
  }
  return Buffer.from(hex, 'hex').toString('latin1');
}

/** strrev() over php byte strings: one javascript char per byte, so reverse the units. */
function strrevLatin(s) {
  let out = '';
  for (let i = s.length - 1; i >= 0; i--) {
    out += s[i];
  }
  return out;
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

function present(obj, key) {
  return obj !== null && obj !== undefined && typeof obj === 'object'
    && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== null;
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

export default VixeoExtractor;
