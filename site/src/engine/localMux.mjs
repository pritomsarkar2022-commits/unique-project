import { Playlist } from '../hls/playlist.mjs';
import { Mp4Mux } from '../hls/mp4Mux.mjs';
import { TsStream } from '../build/tsStream.mjs';
import { ExtractException } from '../errors.mjs';
import { urlAbsolutize } from '../supportPure.mjs';
import { aes128CbcDecrypt, segmentIv } from './aesCbc.mjs';
import { stampTimes, captureParams } from '../build/mp4Builder.mjs';

/**
 * The MP4 build, run by the device that asked for the file.
 *
 * `Mp4Builder` has to hand the finished file back through one function response, and
 * a function response is capped at a few tens of megabytes, so a long stream simply
 * cannot be joined there. Here the same playlist, the same demuxer and the same muxer
 * run in a worker instead: the parts arrive one at a time over the relay route the
 * page already signs, and each finished piece is written straight to the file the user
 * chose. Nothing is capped, because nothing passes through the site.
 *
 * The transport is injected, so this module runs unchanged in a node test and in a
 * browser worker.
 */

/** @returns {Promise<Uint8Array>} the 16 byte key file, trimmed the way the server trims it */
async function keyBytes(fetchBytes, uri) {
  const raw = await fetchBytes(uri);
  let key = raw.length === 16 ? raw : decodeTrimmed(raw);
  if (key.length !== 16) {
    throw new ExtractException(
      'The key for this stream is not a plain 16 byte one.',
      'Use Save stream file instead.',
      'drm',
    );
  }
  return key;
}

/** Some hosts answer a key request with the same bytes plus a newline or two. */
function decodeTrimmed(raw) {
  let text = '';
  for (let i = 0; i < raw.length; i++) {
    text += String.fromCharCode(raw[i]);
  }
  const trimmed = text.replace(/^[\r\n \t]+|[\r\n \t]+$/g, '');
  if (trimmed.length !== 16) {
    return raw;
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = trimmed.charCodeAt(i) & 0xFF;
  }
  return out;
}

/** The playlist a media list is read from: the master's chosen variant, else itself. */
async function mediaPlaylist(o, text, base) {
  const parsed = Playlist.parse(text, base);
  if (!parsed.isMaster) {
    return [parsed, base];
  }
  const variant = parsed.selectVariant(o.height ?? null);
  if (variant === null) {
    throw new ExtractException(
      'The stream list has no video quality in it.',
      'Try Save stream file instead.',
      'no_variant',
    );
  }
  const url = String(variant.url);
  return [Playlist.parse(await o.fetchText(url), url), url];
}

/** A part that will not arrive on the first ask is asked for again before it is lost. */
async function readPart(o, url, attempt) {
  try {
    return await o.fetchBytes(url);
  } catch (e) {
    if (e instanceof ExtractException || attempt >= 3) {
      throw e;
    }
    await new Promise((r) => setTimeout(r, 400 * attempt));
    return await readPart(o, url, attempt + 1);
  }
}

/**
 * @param {object} o
 * @param {string} o.manifestUrl   a same origin relay url for the master or media list
 * @param {number|null} [o.height] preferred variant height
 * @param {(url:string)=>Promise<string>} o.fetchText
 * @param {(url:string)=>Promise<Uint8Array>} o.fetchBytes
 * @param {(bytes:Uint8Array)=>Promise<void>} o.write   called in file order, may await
 * @param {(done:number,total:number,bytes:number)=>void} [o.onPart]
 * @param {number} [o.maxParts]
 * @param {number} [o.now] creation time stamped into the moov; a test pins it so two
 *   builds of the same stream are byte comparable, the page leaves it out
 * @returns {Promise<{parts:number,bytes:number,note:string|null}>}
 */
export async function muxPlaylistToMp4(o) {
  const first = await o.fetchText(o.manifestUrl);
  if (!String(first).includes('#EXTM3U')) {
    throw new ExtractException('That playlist could not be read.', 'Paste the address of the .m3u8 file.', 'playlist_read');
  }
  const [playlist, base] = await mediaPlaylist(o, first, o.manifestUrl);
  if (playlist.live) {
    throw new ExtractException('This stream has no end yet.', 'Save it once the broadcast is over.', 'live');
  }
  if (playlist.sampleAes) {
    throw new ExtractException(
      'This stream is protected with SAMPLE-AES.',
      'A stream that needs its own decrypting player cannot be joined into a file here.',
      'drm',
    );
  }
  if (playlist.map !== null) {
    throw new ExtractException(
      'This stream is already cut as MP4 segments.',
      'Use Save stream file to keep it as it is.',
      'fmp4',
    );
  }
  if (playlist.key !== null && String(playlist.key.method ?? '').toUpperCase() !== 'AES-128') {
    throw new ExtractException(
      'This stream uses ' + playlist.key.method + '.',
      'Only a stream with a plain key file can be joined here.',
      'drm',
    );
  }
  if (playlist.segments.length === 0) {
    throw new ExtractException('The stream list came back empty.', 'Run the same link again.', 'no_segments');
  }
  const maxParts = Math.trunc(Number(o.maxParts ?? 6000));
  if (playlist.segments.length > maxParts) {
    throw new ExtractException(
      'This stream is longer than ' + maxParts + ' parts.',
      'Pick a lower quality if the page offers one.',
      'too_long',
    );
  }

  const declaredIv = playlist.key === null ? null : String(playlist.key.iv ?? '');
  const key = playlist.key === null ? null : await keyBytes(o.fetchBytes, urlAbsolutize(base, String(playlist.key.uri)));

  const rec = { ts_offset: 0, last_dts: null, last_delta: 3600, params: null, note: null };
  const mux = Mp4Mux.open();
  const stream = new TsStream();
  const segments = playlist.segments;
  let empties = 0;

  await o.write(mux.takeOutput());
  // Parts are pulled a few at a time and handed over in order: the network is the slow
  // half of a local save, and the demuxer must still see one continuous stream.
  const ahead = Math.max(1, Math.trunc(Number(o.prefetch ?? 6)));
  const pending = new Map();
  const start = (i) => {
    const asked = readPart(o, String(segments[i].url), 1);
    // A read that fails after the loop left would have no listener of its own.
    asked.catch(() => { });
    return asked;
  };
  let next = 0;
  for (let i = 0; i < segments.length; i++) {
    while (next < segments.length && next - i < ahead) {
      pending.set(next, start(next));
      next++;
    }
    let bytes;
    try {
      bytes = await pending.get(i);
    } catch {
      throw new ExtractException(
        'Part ' + (i + 1) + ' of ' + segments.length + ' did not arrive.',
        'The host dropped the connection. Run the save again to pick it up from here.',
        'segment_failed',
      );
    }
    pending.delete(i);
    if (key !== null) {
      bytes = aes128CbcDecrypt(key, segmentIv(declaredIv, Number(segments[i].seq)), bytes);
    }
    stream.push(bytes);
    const taken = stream.take();
    if (taken.video.length === 0 && taken.audio.length === 0) {
      for (const why of stream.demuxer().skipped.values()) {
        if (String(why).includes('0x24')) {
          throw new ExtractException(
            'This stream is HEVC (H.265).',
            'HEVC video needs a full converter. Use Save stream file to keep it as it is.',
            'hevc',
          );
        }
      }
      empties += 1;
      if (empties >= 2) {
        throw new ExtractException(
          'Part ' + (i + 1) + ' held no readable frames.',
          'The stream is cut in a way this tool cannot join. Use Save stream file instead.',
          'no_frames',
        );
      }
    } else {
      empties = 0;
      stampTimes(rec, taken.video, taken.audio);
      mux.addSegment(taken.video, taken.audio);
      captureParams(rec, stream.avc(), stream.aac());
    }
    await o.write(mux.takeOutput());
    if (o.onPart !== null && o.onPart !== undefined) {
      o.onPart(i + 1, segments.length, mux.bytesWritten());
    }
  }

  const tail = stream.drain();
  if (tail.video.length !== 0 || tail.audio.length !== 0) {
    stampTimes(rec, tail.video, tail.audio);
    mux.addSegment(tail.video, tail.audio);
  }
  if (rec.params === null || rec.params === undefined) {
    throw new ExtractException(
      'The stream never announced its video format.',
      'Use Save stream file to keep it as it is.',
      'no_sps',
    );
  }
  mux.writeMoov({
    width: rec.params.width,
    height: rec.params.height,
    avcC: Buffer.from(String(rec.params.avcC), 'hex'),
    asc: Buffer.from(String(rec.params.asc), 'hex'),
    sampleRate: rec.params.sampleRate,
    channels: rec.params.channels,
  }, o.now);
  await o.write(mux.takeOutput());
  return { parts: segments.length, bytes: mux.bytesWritten(), note: rec.note ?? null };
}
