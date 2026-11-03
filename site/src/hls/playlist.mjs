import { cfg } from '../config.mjs';
import { urlAbsolutize, phpTrim, phpInt, phpFloat } from '../support.mjs';

/**
 * Reads HLS playlists and rewrites them so a browser can play a cross-origin
 * stream through our relay without CORS or hotlink problems.
 *
 * Port of lib/Hls/Playlist.php.
 */
const TAGS = {
  streamInf: '#ext-x-stream-inf',
  extinf: '#extinf',
  targetDuration: '#ext-x-targetduration',
  mediaSequence: '#ext-x-media-sequence',
  key: '#ext-x-key',
  map: '#ext-x-map',
  endList: '#ext-x-endlist',
  byteRange: '#ext-x-byterange',
};

export class Playlist {
  isMaster = false;
  /** @type {Array<{url?:string,bandwidth:number|null,width:number|null,height:number|null,codecs:string|null,name:string|null}>} */
  variants = [];
  /** @type {Array<{url:string,duration:number,seq:number,byterange:string|null,map:string|null}>} */
  segments = [];
  key = null;      // {method, uri, iv}
  map = null;      // init segment url (fmp4 input)
  targetDuration = null;
  mediaSequence = 0;
  endList = false;
  live = false;
  sampleAes = false;
  totalDuration = 0;
  codecs = null;

  static parse(text, baseUrl) {
    const p = new Playlist();
    // Every line without a tag would otherwise become a segment, so an error
    // page or a truncated response has to be refused here rather than built
    // into a video made of html.
    if (!hasTag(text, '#EXTM3U')) {
      return p;
    }
    const lines = text.split(/\r\n|\r|\n/);
    let seq = 0;
    let pendingInfo = null;
    let pendingDuration = null;
    let mapLocal = null;

    for (const line of lines) {
      const t = phpTrim(line);
      if (t === '') {
        continue;
      }
      if (t[0] !== '#') {
        const url = urlAbsolutize(baseUrl, t);
        if (p.isMaster) {
          p.variants.push({ ...(pendingInfo ?? {}), url });
          pendingInfo = null;
        } else {
          const dur = pendingDuration ?? (p.targetDuration ?? 10);
          p.segments.push({
            url,
            duration: dur,
            seq,
            byterange: null,
            map: mapLocal,
          });
          seq++;
          p.totalDuration += dur;
          pendingDuration = null;
        }
        continue;
      }
      const lower = t.toLowerCase();
      if (lower.includes(TAGS.streamInf)) {
        p.isMaster = true;
        const attrs = attributes(t.slice(t.indexOf(':') + 1));
        const res = attrs.resolution ?? null;
        let w = null;
        let h = null;
        if (typeof res === 'string') {
          const mm = /^(\d+)x(\d+)$/.exec(res);
          if (mm) {
            w = Number(mm[1]);
            h = Number(mm[2]);
          }
        }
        let codecs = attrs.codecs !== undefined ? phpTrim(String(attrs.codecs), ' \t\n\r\x0B\u0000"') : null;
        if (codecs === '') {
          codecs = null;
        }
        pendingInfo = {
          bandwidth: attrs.bandwidth !== undefined ? phpInt(attrs.bandwidth) : null,
          width: w,
          height: h,
          codecs,
          name: attrs.name !== undefined ? phpTrim(String(attrs.name), '"') : null,
        };
        continue;
      }
      if (lower.includes(TAGS.extinf)) {
        const mm = /:\s*([\d.]+)\s*,?/.exec(t);
        if (mm) {
          pendingDuration = phpFloat(mm[1]);
        }
        continue;
      }
      if (lower.includes(TAGS.targetDuration)) {
        const mm = /:(\d+)/.exec(t);
        if (mm) {
          p.targetDuration = phpFloat(mm[1]);
        }
        continue;
      }
      if (lower.includes(TAGS.mediaSequence)) {
        const mm = /:(\d+)/.exec(t);
        if (mm) {
          p.mediaSequence = phpInt(mm[1]);
          seq = p.mediaSequence;
        }
        continue;
      }
      if (lower.includes(TAGS.key)) {
        const attrs = attributes(t.slice(t.indexOf(':') + 1));
        const method = String(attrs.method ?? 'NONE').toUpperCase();
        if (method === 'SAMPLE-AES' || method.includes('SAMPLE')) {
          p.sampleAes = true;
        }
        const uri = attrs.uri !== undefined ? phpTrim(String(attrs.uri), '"') : null;
        p.key = (method === 'NONE' || uri === null)
          ? null
          : { method, uri: urlAbsolutize(baseUrl, uri), iv: attrs.iv ?? null };
        continue;
      }
      if (lower.includes(TAGS.map)) {
        const attrs = attributes(t.slice(t.indexOf(':') + 1));
        if (attrs.uri !== undefined) {
          mapLocal = urlAbsolutize(baseUrl, phpTrim(String(attrs.uri), '"'));
          p.map = mapLocal;
        }
        continue;
      }
      if (lower.includes(TAGS.endList)) {
        p.endList = true;
        continue;
      }
      if (lower.includes(TAGS.byteRange) && p.segments.length !== 0) {
        const i = p.segments.length - 1;
        p.segments[i].byterange = phpTrim(t.replace(/^#EXT-X-BYTERANGE\s*:\s*/i, ''));
      }
    }

    p.live = !p.endList && !p.isMaster && p.segments.length !== 0;
    if (p.isMaster) {
      p.variants.sort((a, b) => phpInt(b.bandwidth) - phpInt(a.bandwidth));
    }
    return p;
  }

  /** Pick the variant closest to a target height, preferring the higher one. */
  selectVariant(targetHeight = null) {
    if (this.variants.length === 0) {
      return null;
    }
    const target = targetHeight ?? phpInt(cfg('hls.default_height', 1080));
    let best = null;
    let bestPenalty = Number.MAX_VALUE;
    for (const v of this.variants) {
      const h = v.height ?? Math.trunc(Math.sqrt(Math.max(1, phpInt(v.bandwidth) / 1.5)));
      const penalty = Math.abs(h - target) + (h > target ? 5 : 0);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = v;
      }
    }
    return best;
  }

  /**
   * Rewrite every uri in a playlist through link(target, isAttributeURI).
   * Key and init segment uris are flagged so they are never treated as playlists.
   */
  static rewrite(text, baseUrl, link) {
    const lines = text.split(/\r\n|\r|\n/);
    const out = [];
    for (const line of lines) {
      let t = phpTrimEndLine(line);
      if (t === '') {
        out.push('');
        continue;
      }
      if (t[0] === '#') {
        const m = /URI="([^"]+)"/.exec(t);
        if (m) {
          const needle = '"' + m[1] + '"';
          const replacement = '"' + link(urlAbsolutize(baseUrl, m[1]), true) + '"';
          t = t.split(needle).join(replacement);
        }
        out.push(t);
        continue;
      }
      out.push(link(urlAbsolutize(baseUrl, t), false));
    }
    return out.join('\n');
  }
}

/** stripos($text, $tag) !== false, i.e. an ascii case-insensitive substring test. */
function hasTag(text, tag) {
  return String(text).toLowerCase().includes(tag.toLowerCase());
}

/** rtrim($line) with php's default character list. */
function phpTrimEndLine(s) {
  return phpTrim(s, ' \t\n\r\x0B\u0000');
}

/** lower-cased attribute map, quoted values kept as-is */
function attributes(s) {
  const out = {};
  const re = /([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out[m[1].toLowerCase()] = phpTrim(m[2]);
  }
  return out;
}
