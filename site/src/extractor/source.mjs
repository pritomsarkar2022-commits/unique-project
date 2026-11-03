import crypto from 'node:crypto';
import { humanBytes, parseUrl, phpInt } from '../support.mjs';

/**
 * Port of lib/Extractor/Source.php: one file an extractor managed to resolve.
 *
 * Every string this class handles is a php *byte* string, so text arrives here with
 * one javascript char per byte (latin1); strlen()/substr()/sha1() then agree with
 * php byte for byte.
 */
const TOKEN_KEYS = ['expires', 'exp', 'ttl', 'e', 'timeout'];

/**
 * parse_url($url, PHP_URL_*). php answers null for a part that is absent and false
 * for a url it cannot parse at all; every consumer in this file tests falseness or
 * compares against a host string, so both collapse to null without a decision
 * changing. The scheme-less legacy branch of php's parser is not cloned, matching
 * the note on parseUrl() in support.mjs.
 */
export function phpUrlComponent(url, component) {
  const p = parseUrl(url);
  if (!p || typeof p !== 'object') {
    return null;
  }
  const v = p[component];
  return v === undefined ? null : v;
}

/** php's parse_str(): '&'-separated pairs, url-decoded, '.' and ' ' munged to '_'. */
export function parseStr(query) {
  const out = new Map();
  for (const pair of String(query).split('&')) {
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    let key = urlDecode(rawKey).replace(/^[ \t]+/, '').replace(/[. ]/g, '_');
    if (key === '') {
      continue; // php drops an argument with an empty name
    }
    const value = urlDecode(rawVal);
    const bracket = key.indexOf('[');
    if (bracket === -1) {
      out.set(key, value);
      continue;
    }
    const name = key.slice(0, bracket);
    const tail = key.slice(bracket);
    if (!tail.endsWith(']')) {
      out.set(name.replace(/[[\]]/g, '_') + '_', value);
      continue;
    }
    const keys = [];
    for (const part of tail.slice(1, -1).split(/(?<=\])\[/)) {
      keys.push(part.replace(/\]$/, '').replace(/^[[]/, ''));
    }
    let target = out.get(name);
    if (!(target instanceof Map)) {
      target = new Map();
      out.set(name, target);
    }
    let node = target;
    for (let i = 0; i < keys.length - 1; i++) {
      let next = node.get(keys[i]);
      if (!(next instanceof Map)) {
        next = new Map();
        node.set(keys[i], next);
      }
      node = next;
    }
    const last = keys[keys.length - 1];
    if (last === '') {
      let i = 0;
      for (const k of node.keys()) {
        if (/^\d+$/.test(k)) {
          i = Math.max(i, Number(k) + 1);
        }
      }
      node.set(String(i), value);
    } else {
      node.set(last, value);
    }
  }
  return out;
}

/** rawurldecode(): '+' stays, %XX becomes the byte. */
function urlDecode(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%' && /^[0-9a-fA-F]{2}/.test(text.slice(i + 1, i + 3))) {
      out += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out += text[i];
    }
  }
  return out;
}

/** (string) cast of a parse_str value; an array stringifies to 'Array' in php. */
function scalarToString(v) {
  if (v instanceof Map) {
    return 'Array';
  }
  return String(v);
}

export class Source {
  static MP4 = 'mp4';
  static HLS = 'hls';
  static TS = 'ts';
  static WEBM = 'webm';
  static MKV = 'mkv';

  url = '';
  kind = '';
  label = null;
  height = null;
  bitrate = null;
  sizeBytes = null;
  mime = null;

  /** Outbound headers the file host demands (Referer, Cookie, Range, ...). */
  headers = [];

  tokenExpiresAt = null;
  needsProxy = true;

  /** For HLS: variant list, filled by Hls\Playlist. */
  variants = [];

  duration = null;
  note = null;
  keyUri = null;
  keyMethod = null;
  id = '';

  /** Discovery confidence, set by MediaSniffer::candidates. Never shown to visitors. */
  score = 0;

  static make(url, kind = Source.MP4) {
    const s = new Source();
    s.url = url;
    s.kind = kind;
    s.id = crypto.createHash('sha1').update(Buffer.from(url, 'latin1')).digest('hex').slice(0, 12);
    return s;
  }

  isVideo() {
    return [Source.MP4, Source.HLS, Source.WEBM, Source.MKV, Source.TS].includes(this.kind);
  }

  tokenExpiryFromQuery() {
    const q = phpUrlComponent(this.url, 'query');
    if (!q) {
      return;
    }
    const p = parseStr(q);
    for (const k of TOKEN_KEYS) {
      if (p.has(k)
        // php's $ allows one trailing newline, so the port spells the anchor out.
        && /^\d{9,11}(?=\n?$)/.test(scalarToString(p.get(k)))) {
        const v = phpInt(p.get(k));
        // Some hosts use a duration (seconds) instead of a timestamp.
        this.tokenExpiresAt = v > 1000000000 ? v : Math.floor(Date.now() / 1000) + Math.min(v, 86400);
        return;
      }
    }
  }

  toArray() {
    return {
      id: this.id,
      kind: this.kind,
      label: this.label ?? labelForKind(this.kind),
      height: this.height,
      bitrate: this.bitrate,
      size: this.sizeBytes,
      sizeHuman: humanBytes(this.sizeBytes),
      mime: this.mime ?? mimeForKind(this.kind),
      tokenExpiresAt: this.tokenExpiresAt,
      needsProxy: this.needsProxy,
      duration: this.duration !== null ? phpRoundTo(this.duration, 1) : null,
      note: this.note,
      variants: this.variants.map((v) => ({
        height: v.height ?? null,
        bandwidth: v.bandwidth ?? null,
        codecs: v.codecs ?? null,
        segments: v.segments ?? null,
        duration: v.duration ?? null,
        encrypted: !phpEmpty(v.encrypted),
        // The variant's own signed url stays on the server.
      })),
      // Never leak the signed url to the UI as anything it can copy straight
      // into a new tab: the relay is the only thing that uses it.
      url: null,
    };
  }
}

function labelForKind(kind) {
  switch (kind) {
    case Source.HLS: return 'Video stream';
    case Source.TS: return 'Raw stream';
    default: return asciiUpper(kind) + ' file';
  }
}

function mimeForKind(kind) {
  switch (kind) {
    case Source.HLS: return 'application/vnd.apple.mpegurl';
    case Source.WEBM: return 'video/webm';
    case Source.MKV: return 'video/x-matroska';
    case Source.TS: return 'video/mp2t';
    default: return 'video/mp4';
  }
}

/** strtoupper(): php's is ascii-only, javascript's is not. */
function asciiUpper(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
}

/** round($v, 1): half away from zero at the requested precision. */
function phpRoundTo(value, precision) {
  const factor = Math.pow(10, precision);
  return Math.round(Math.abs(value) * factor) / factor * Math.sign(value || 1);
}

/** empty(): '', '0', 0, null, false and [] are all empty in php. */
function phpEmpty(v) {
  if (v === null || v === undefined || v === false || v === '' || v === 0 || v === '0') {
    return true;
  }
  if (Array.isArray(v)) {
    return v.length === 0;
  }
  if (v instanceof Map) {
    return v.size === 0;
  }
  return false;
}
