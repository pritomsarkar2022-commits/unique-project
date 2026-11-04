/**
 * Port of lib/Net/Relay.php: the same-origin relay the browser talks to while the
 * file host gets the Referer/Cookie it demands.
 *
 * php echoed bytes from curl's write callback and exited; a function returns one
 * response object, so this hands back the upstream stream instead of holding it. One
 * rule the php could ignore and this one cannot: a netlify function response may carry
 * 20 MB streamed (6 MB buffered), while these hosts serve videos of several hundred.
 * The response is therefore cut to limits.function_stream_bytes, and only in the two
 * cases where cutting is honest:
 *
 *   - the client asked for a range, so a smaller piece is what it requested anyway;
 *   - the whole file is already known to be small enough, in which case nothing is cut.
 *
 * A request for a file bigger than the ceiling with no range in it is refused with 413
 * rather than served half, because a silently truncated video is the one outcome a
 * visitor cannot tell apart from success. The site's own player and saver ask for
 * ranges, so they stay inside the ceiling and a 700 MB file still comes through, in
 * pieces, exactly as the php streamed it.
 */

import { PassThrough } from 'node:stream';

import { cfg } from '../config.mjs';
import { HttpException } from '../errors.mjs';
import { textOut, VdResponse } from '../http/respond.mjs';
import { MediaSniffer } from '../extractor/mediaSniffer.mjs';
import { Source } from '../extractor/source.mjs';
import { Playlist } from '../hls/playlist.mjs';
import { appUrl, linkSeal, parseUrl } from '../support.mjs';
import { assertSafeAsync, UrlGuardException } from './urlGuard.mjs';
import { HttpClient } from './httpClient.mjs';

/** bytes(a.b.c) for the php `array_slice(explode('.', $h), -2)`. */
function lastTwoLabels(host) {
  const parts = String(host).split('.');
  return parts.slice(-2).join('.');
}

function hostOf(url) {
  const parts = parseUrl(url);
  return parts && parts.host ? String(parts.host).toLowerCase() : '';
}

/**
 * @param {object} store   JobStore-shaped: verify(record, url, sig), sign(record, url)
 * @param {object} record  the stored job
 * @param {string} url     the address sealed in the link
 * @param {string} sig     the signature the browser sent back
 * @param {{download?: boolean, filename?: string, isPlaylist?: boolean, range?: string,
 *   http?: HttpClient, resolve?: (host: string) => Promise<string>}} opts
 *        resolve is the dns answer the ssrf wall reads; production leaves it alone and
 *        gets resolveDns, which is how a test keeps the wall out of the network.
 * @returns {Promise<VdResponse>}
 */
export async function relayRun(store, record, url, sig, opts = {}) {
  if (!store.verify(record, url, sig)) {
    return textOut('This download link is not valid.', 403);
  }
  // Only hosts this job already saw are reachable through the relay.
  if (!hostAllowed(record, url)) {
    return textOut('That file host is not part of this analysis.', 403);
  }
  try {
    await assertSafeAsync(url, opts.resolve);
  } catch (err) {
    if (!(err instanceof UrlGuardException)) {
      throw err;
    }
    // The link was signed, so this is a second wall rather than the first: a stored
    // job whose file address has since become an internal one.
    return textOut('That file address is not reachable.', 403);
  }

  const headers = headersFor(record, url);
  const isPlaylist = opts.isPlaylist === true;
  const asDownload = opts.download === true;
  // These hosts name playlists .txt and segments .css, so the flag travels in the
  // signed link instead of being guessed from the filename.
  if (isPlaylist && !asDownload) {
    return serveRewrittenPlaylist(record, url, headers, store, opts.http ?? null);
  }
  return stream(url, headers, {
    asDownload,
    filename: String(opts.filename ?? ''),
    isPlaylist,
    range: String(opts.range ?? ''),
    http: opts.http ?? null,
  });
}

function hostAllowed(record, url) {
  const host = hostOf(url);
  if (host === '') {
    return false;
  }
  const allowed = new Set();
  for (const s of (record.sources ?? [])) {
    const h = hostOf(String(s?.url ?? ''));
    if (h !== '') {
      allowed.add(h);
      // cdn1.host.tld and host.tld are the same publisher.
      allowed.add(lastTwoLabels(h));
    }
  }
  const regisable = lastTwoLabels(host);
  for (const key of ['pageHost', 'thumbHost']) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '' && String(value) === regisable) {
      return true;
    }
  }
  return allowed.has(host) || allowed.has(regisable);
}

/** @returns {Record<string,string>} */
function headersFor(record, url) {
  const out = {};
  for (const s of (record.sources ?? [])) {
    if (String(s?.url ?? '') === url) {
      Object.assign(out, s.headers ?? {});
    }
  }
  if (out.Referer === undefined && record.finalUrl !== undefined && record.finalUrl !== null && record.finalUrl !== '') {
    out.Referer = String(record.finalUrl);
  }
  const cookies = {};
  for (const s of (record.sources ?? [])) {
    Object.assign(cookies, s.cookies ?? {});
  }
  if (Object.keys(cookies).length > 0) {
    out.Cookie = Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ');
  }
  return out;
}

async function serveRewrittenPlaylist(record, url, headers, store, http) {
  const client = http ?? new HttpClient(1);
  let res;
  try {
    res = await client.get(url, {
      headers,
      accept: 'application/x-mpegURL,application/vnd.apple.mpegurl,*/*;q=0.8',
      max_bytes: 4000000,
    });
  } catch (err) {
    if (!(err instanceof HttpException)) {
      throw err;
    }
    return textOut('The video host refused to send its playlist.', 502);
  }
  if (!res.ok() || !String(res.body).includes('#EXTM3U')) {
    return textOut('That playlist could not be read.', 502);
  }
  const base = res.finalUrl;
  const job = String(record.id ?? '');
  const parsed = Playlist.parse(res.body, base);
  // In a master playlist the bare lines are themselves playlists; in a media playlist
  // they are segments, and key/init uris never are.
  const lineIsPlaylist = parsed.isMaster === true;
  const link = (target, forceNotPlaylist = false) => {
    const params = new URLSearchParams();
    params.set('r', 'relay');
    params.set('job', job);
    params.set('u', linkSeal(target, String(record.secret ?? '')));
    params.set('s', store.sign(record, target));
    if (lineIsPlaylist && forceNotPlaylist !== true) {
      params.set('p', '1');
    }
    return appUrl(params.toString());
  };
  const body = Playlist.rewrite(res.body, base, link);

  const out = new VdResponse(200, {}, body);
  out.header('Content-Type', 'application/vnd.apple.mpegurl');
  out.header('Cache-Control', 'private, no-store');
  out.header('Access-Control-Allow-Origin', '*');
  return out;
}

/** @returns {Promise<VdResponse>} */
async function stream(url, headers, o) {
  const client = o.http ?? new HttpClient(1);
  // A manifest is a few hundred bytes of text, and some hosts 403 a ranged one.
  const range = o.isPlaylist ? '' : o.range;
  const asked = range === '' ? null : parseClientRange(range);
  const cap = streamCap();
  const attempt = {
    headers,
    stream: true,
    accept: o.isPlaylist ? 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8' : '*/*',
  };
  // One response may carry cap bytes, so an open-ended or oversized ask is narrowed
  // before it goes upstream. A host that ranges answers exactly the piece asked for,
  // and the whole file never has to be pulled through the function.
  const bounded = asked === null ? '' : narrowRange(asked, cap);
  if (bounded !== '') {
    attempt.range = bounded;
  }

  let res;
  try {
    res = await client.get(url, attempt);
  } catch (err) {
    if (!(err instanceof HttpException)) {
      throw err;
    }
    // php could only say so after the fact, because it had already flushed; here the
    // refusal still fits in a status line, so the visitor gets one.
    return textOut('The video host would not send this file.', 502);
  }

  const declared = intOrNull(res.header('content-length'));
  const relay = { asDownload: o.asDownload, filename: o.filename, isPlaylist: o.isPlaylist, url, cap };

  if (asked === null) {
    // Whole file, no range: only a body known to fit may be relayed as one answer.
    if (declared !== null && declared > cap) {
      return tooBig(declared);
    }
    return relayed(res, { ...relay, ranged: false });
  }

  const ranged = res.status === 206;
  if (!ranged) {
    // The host ignored the range and is sending the whole file. php relayed that
    // answer anyway, so this does too, under the same size rule.
    if (declared !== null && declared > cap) {
      return tooBig(declared);
    }
    return relayed(res, { ...relay, ranged: false });
  }

  // A piece was asked for and a piece came back. Its headers travel verbatim unless
  // the host gave more than one response can carry, which only happens to a host that
  // answers a narrow ask with a wide piece.
  if (declared !== null && declared > cap) {
    const whole = totalFromContentRange(res.header('content-range')) ?? (cap + 0);
    const start = startOf(bounded, whole, declared);
    relay.span = { start, end: start + cap - 1, whole: Math.max(whole, start + cap) };
  }
  return relayed(res, { ...relay, ranged: true });
}

/** The byte span to ask the host for, given what the visitor asked for. */
function narrowRange(asked, cap) {
  if (asked.suffix !== null) {
    return 'bytes=-' + Math.min(asked.suffix, cap);
  }
  if (asked.openEnd) {
    return `bytes=${asked.start}-${asked.start + cap - 1}`;
  }
  if (asked.end - asked.start + 1 > cap) {
    return `bytes=${asked.start}-${asked.start + cap - 1}`;
  }
  return `bytes=${asked.start}-${asked.end}`;
}

/** The first byte of the piece that came back, read from the range we sent. */
function startOf(bounded, whole, declared) {
  const m = /^bytes=(\d+)-/.exec(bounded);
  if (m !== null) {
    return Math.trunc(Number(m[1]));
  }
  return Math.max(0, whole - declared);
}

/**
 * Turn the upstream answer into the response the visitor gets, with the same header
 * rules passHeaders() had and a byte ceiling that ends the stream instead of lying
 * about its length.
 */
function relayed(res, o) {
  const status = res.status;
  const h = res.headers;
  // php's rule: a partial answer only travels as partial when the visitor asked with
  // a Range in it, and an error status always travels as the host sent it.
  const out = new VdResponse(status === 206 && o.ranged ? 206 : (status >= 400 ? status : 200));

  let type = h['content-type'] ?? (o.isPlaylist ? 'application/vnd.apple.mpegurl' : 'application/octet-stream');
  if (String(type).toLowerCase().includes('octet-stream') && !o.isPlaylist) {
    type = {
      [Source.MP4]: 'video/mp4',
      [Source.WEBM]: 'video/webm',
      [Source.HLS]: 'application/vnd.apple.mpegurl',
    }[MediaSniffer.kindOf(o.url)] ?? 'application/octet-stream';
  }
  out.header('Content-Type', type);

  if (o.span !== undefined) {
    out.header('Content-Length', String(o.span.end - o.span.start + 1));
    out.header('Content-Range', `bytes ${o.span.start}-${o.span.end}/${o.span.whole}`);
  } else {
    const length = h['content-length'];
    if (length !== undefined && length !== '') {
      out.header('Content-Length', String(length));
    }
    if (o.ranged && h['content-range'] !== undefined && h['content-range'] !== '') {
      out.header('Content-Range', String(h['content-range']));
    }
  }
  if (h['accept-ranges'] !== undefined && h['accept-ranges'] !== '') {
    out.header('Accept-Ranges', String(h['accept-ranges']));
  } else if (o.ranged) {
    out.header('Accept-Ranges', 'bytes');
  }
  out.header('Cache-Control', 'no-store');
  out.header('X-Content-Type-Options', 'nosniff');
  out.header('Referrer-Policy', 'no-referrer');

  if (o.asDownload) {
    const name = o.filename !== '' ? o.filename : defaultName(o.url);
    out.header('Content-Disposition', 'attachment; filename="' + addslashes(name) + '"');
  }

  const source = res.stream;
  if (source === null || source === undefined) {
    out.body = res.body;
    return out;
  }
  const wanted = o.span !== undefined ? o.span.end - o.span.start + 1 : o.cap;
  out.stream = capBytes(source, wanted);
  return out;
}

/** Stop after `max` bytes and drop the upstream connection, the way curl's abort did. */
function capBytes(source, max) {
  const sink = new PassThrough();
  let seen = 0;
  source.on('data', (chunk) => {
    if (seen >= max) {
      return;
    }
    if (seen + chunk.length > max) {
      sink.write(chunk.subarray(0, max - seen));
      seen = max;
      source.destroy();
      sink.end();
      return;
    }
    seen += chunk.length;
    sink.write(chunk);
  });
  source.on('end', () => {
    if (!sink.writableEnded) {
      sink.end();
    }
  });
  source.on('error', (err) => sink.destroy(err));
  sink.on('close', () => source.destroy());
  return sink;
}

function tooBig(total) {
  const out = textOut('This file is too large for one response from this host ('
    + Math.ceil(total / 1048576) + ' MB). The player on the page and Save as one MP4 both take it in pieces.', 413);
  out.header('Accept-Ranges', 'bytes');
  out.header('X-File-Size', String(total));
  return out;
}

function streamCap() {
  const cap = Math.trunc(Number(cfg('limits.function_stream_bytes', 18874368)));
  return cap > 0 ? cap : 18874368;
}

/** php's `#^bytes=(\d*)-(\d*)$#`, with the two empty-edge forms told apart. */
function parseClientRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (m === null || (m[1] === '' && m[2] === '')) {
    return null;
  }
  if (m[1] === '') {
    return { suffix: Math.trunc(Number(m[2])), openEnd: false, start: null, end: null };
  }
  const start = Math.trunc(Number(m[1]));
  if (m[2] === '') {
    return { start, openEnd: true, end: null, suffix: null };
  }
  return { start, end: Math.trunc(Number(m[2])), openEnd: false, suffix: null };
}

function totalFromContentRange(value) {
  const m = /\/(\d+)$/.exec(String(value ?? '').trim());
  return m === null ? null : Math.trunc(Number(m[1]));
}

function intOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : null;
}

/** addslashes(), which is what php put inside the double quotes of the header. */
function addslashes(name) {
  return String(name).replace(/(['"\\])/g, '\\$1');
}

export function defaultName(url) {
  const parts = parseUrl(url);
  const path = parts && parts.path ? String(parts.path) : '';
  const leaf = path.split('/').pop() ?? '';
  let base = leaf.replace(/[^\w.\- ]+/g, '');
  if (base === '') {
    base = 'video';
  }
  if (!base.includes('.')) {
    base += '.' + ({
      [Source.HLS]: 'ts',
      [Source.TS]: 'ts',
      [Source.WEBM]: 'webm',
    }[MediaSniffer.kindOf(url)] ?? 'mp4');
  }
  return base.slice(0, 120);
}

export const __testing = { hostAllowed, headersFor, parseClientRange, relayed, capBytes, streamCap, lastTwoLabels };
