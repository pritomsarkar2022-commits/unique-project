import { cfg } from '../config.mjs';
import { ExtractException, HttpException } from '../errors.mjs';
import { phpRound, urlAbsolutize, humanBytes } from '../support.mjs';
import { Playlist } from '../hls/playlist.mjs';
import { Mp4Mux } from '../hls/mp4Mux.mjs';
import { TsDemuxer } from '../hls/tsDemuxer.mjs';
import { TsStream } from './tsStream.mjs';
import { Source } from '../extractor/source.mjs';
import { HttpClient } from '../net/httpClient.mjs';
import { stampTimes, captureParams } from './mp4Builder.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Port of lib/Build/Mp4Builder.php: turn an HLS stream into one progressive MP4,
 * a few segments per request.
 *
 * The php original ticked because shared hosting cut a script off at 30 seconds.
 * Netlify cuts a function off at 60, so the same slice-and-resume design carries
 * over. Two things differ, both forced by the platform: the partial file lives in
 * blob storage between ticks instead of on a disk every tick can see, and the joined
 * file is capped at 20 MB because a function may not hold or serve more than that.
 */

export class Mp4Builder {
  /**
   * @param {object} job   stored job record
   * @param {Source} src   an hls Source from that job
   * @param {object} http  HttpClient for the file host
   * @param {import('./buildStore.mjs').BuildStore} store
   */
  static async begin(job, src, http, store) {
    if (src.kind !== Source.HLS) {
      throw new ExtractException('That file is already a single video.', 'Use the plain download button.', 'not_hls');
    }

    const [playlist, base] = await this.#mediaPlaylist(src, http);
    if (playlist.live) {
      throw new ExtractException('This stream has no end yet.', 'Save it once the broadcast is over.', 'live');
    }
    if (playlist.sampleAes) {
      throw new ExtractException('This stream is protected with SAMPLE-AES.', 'A stream that needs its own decrypting player cannot be joined into a file here.', 'drm');
    }
    if (playlist.map !== null) {
      throw new ExtractException('This stream is already cut as MP4 segments.', 'Use Save stream file to keep it as it is.', 'fmp4');
    }
    if (playlist.key !== null && String(playlist.key.method ?? '').toUpperCase() !== 'AES-128') {
      throw new ExtractException('This stream uses ' + playlist.key.method + '.', 'Only a stream with a plain key file can be joined here.', 'drm');
    }
    if (playlist.segments.length === 0) {
      throw new ExtractException('The stream list came back empty.', 'Run the same link again.', 'no_segments');
    }
    const max = Math.trunc(Number(cfg('build.max_segments', 1500)));
    if (playlist.segments.length > max) {
      throw new ExtractException('This stream is longer than ' + max + ' parts.', 'Pick a lower quality if the page offers one.', 'too_long');
    }
    // 20 MB of joined file is what one function may hold and hand back. Saying so
    // before the first byte is pulled is kinder than failing three minutes in.
    const cap = this.#hardCap();
    const estimate = this.#estimate(playlist);
    if (estimate !== null && estimate > cap) {
      throw new ExtractException(
        'That quality joins to about ' + humanBytes(estimate) + ', and this site saves one MP4 up to ' + humanBytes(cap) + '.',
        'Pick a lower quality if the page offers one, or use Save stream file to keep it as it is.',
        'too_big',
      );
    }

    const segments = playlist.segments.map((s) => ({
      u: s.url,
      s: Math.trunc(s.seq),
      d: phpRound(Number(s.duration), 3),
    }));

    let key = null;
    if (playlist.key !== null) {
      key = { uri: urlAbsolutize(base, String(playlist.key.uri)), iv: playlist.key.iv };
    }
    const resolved = Source.make(base, Source.HLS);
    resolved.headers = src.headers;

    return await store.create(job, resolved, segments, key, Number(playlist.totalDuration));
  }

  /**
   * Do as much of the remaining work as this request can afford, then report.
   *
   * @param {object} rec
   * @param {import('./buildStore.mjs').BuildStore} store
   * @param {object} http
   */
  /**
   * php made its own client inside tick(), so a poll that arrives without one is not
   * a smaller budget: it gets the same request limit handle_build() passes.
   */
  static async tick(rec, store, http = new HttpClient(Math.trunc(Number(cfg('build.request_limit', 900))))) {
    if (rec.status === 'done' || rec.status === 'error') {
      return rec;
    }
    const lock = await store.lock(String(rec.id));
    if (lock === null) {
      return rec; // another poll owns this build right now
    }
    const fresh = await store.find(String(rec.id));
    rec = fresh ?? rec;
    let mux = null;
    try {
      const key = rec.key === null || rec.key === undefined ? null : await this.#keyBytes(http, rec);
      const resume = Math.trunc(rec.cursor) > 0;
      const prior = resume ? await store.readOutput(String(rec.id)) : null;
      if (resume && prior === null) {
        throw new ExtractException('This save lost the work it had done.', 'Run the same link again.', 'lost');
      }
      mux = resume ? Mp4Mux.adopt(prior.mp4, prior.log) : Mp4Mux.open();
      const deadline = Date.now() + Math.trunc(Number(cfg('build.tick_seconds', 10))) * 1000;
      // The php tick read build.tick_segments (three parts), because on shared hosting a
      // part only cost one curl. Here a tick also carries the whole partial file in and
      // out of blob storage, so one longer slice is fewer function calls for the same
      // save; the ten-second deadline still decides when the request stops.
      const slice = Math.trunc(Number(cfg('build.tick_segments_netlify', cfg('build.tick_segments', 3))));
      const segments = rec.segments;
      // One demuxer for the whole slice: a packet that a part cuts in half continues
      // in the next one, and dropping it would slide audio off the picture for the
      // rest of the file.
      const stream = new TsStream();
      let empties = 0;

      for (let n = 0; n < slice && Math.trunc(rec.cursor) < segments.length; n++) {
        if (n > 0 && Date.now() > deadline) {
          break;
        }
        const seg = segments[Math.trunc(rec.cursor)];
        let raw = await this.#readSegment(http, rec, seg.u, key);
        if (raw === null) {
          // One dropped part ruins the timing of everything after it. Edges that
          // cached a ranged reply keep replaying it for that exact url, so the
          // second read asks for the same file under a path they have not stored.
          await sleep(400000 / 1000);
          raw = await this.#readSegment(http, rec, this.#otherPath(seg.u), key);
        }
        if (raw === null) {
          throw new ExtractException(
            'Part ' + (Math.trunc(rec.cursor) + 1) + ' of ' + segments.length + ' did not arrive.',
            'The host dropped the connection. Run the save again to pick it up from here.',
            'segment_failed',
          );
        }
        stream.push(raw);
        const taken = stream.take();
        const video = taken.video;
        const audio = taken.audio;
        if (video.length === 0 && audio.length === 0) {
          this.#firstComplaint(stream.demuxer(), rec);
          empties += 1;
          if (empties >= 2) {
            throw new ExtractException(
              'Part ' + (Math.trunc(rec.cursor) + 1) + ' held no readable frames.',
              'The stream is cut in a way this site cannot join. Use Save stream file instead.',
              'no_frames',
            );
          }
        } else {
          empties = 0;
          stampTimes(rec, video, audio);
          mux.addSegment(video, audio);
          rec.bytes = mux.bytesWritten();
        }
        captureParams(rec, stream.avc(), stream.aac());
        rec.cursor = Math.trunc(rec.cursor) + 1;
        rec.video_samples = Math.trunc(rec.video_samples) + video.length;
        rec.audio_samples = Math.trunc(rec.audio_samples) + audio.length;
        if (rec.bytes > this.#hardCap()) {
          throw new ExtractException(
            'This file grew past ' + humanBytes(this.#hardCap()) + '.',
            'Pick a lower quality if the page offers one.',
            'too_big',
          );
        }
        await this.#flush(store, rec, mux);
      }

      const tail = stream.drain();
      if (tail.video.length !== 0 || tail.audio.length !== 0) {
        stampTimes(rec, tail.video, tail.audio);
        mux.addSegment(tail.video, tail.audio);
        rec.video_samples = Math.trunc(rec.video_samples) + tail.video.length;
        rec.audio_samples = Math.trunc(rec.audio_samples) + tail.audio.length;
        rec.bytes = mux.bytesWritten();
        if (rec.bytes > this.#hardCap()) {
          throw new ExtractException(
            'This file grew past ' + humanBytes(this.#hardCap()) + '.',
            'Pick a lower quality if the page offers one.',
            'too_big',
          );
        }
      }

      if (Math.trunc(rec.cursor) >= segments.length) {
        if (rec.params === null || rec.params === undefined) {
          throw new ExtractException('The stream never announced its video format.', 'Use Save stream file to keep it as it is.', 'no_sps');
        }
        mux.writeMoov(this.#binary(rec.params));
        rec.status = 'done';
        rec.bytes = mux.bytesWritten();
      }
      await this.#flush(store, rec, mux);
    } catch (e) {
      rec.status = 'error';
      rec.error = e instanceof Error ? e.message : String(e);
      rec.hint = e instanceof ExtractException ? e.hint : '';
      await store.save(rec);
    } finally {
      await store.release(lock);
    }
    return rec;
  }

  /** @param {object} rec @param {import('./buildStore.mjs').BuildStore} store */
  static async progress(rec, store) {
    const segments = rec.segments ?? [];
    const total = Math.max(1, segments.length);
    const done = rec.status === 'done';
    return {
      ok: rec.status !== 'error',
      build: rec.id,
      status: rec.status,
      percent: done ? 100 : Math.floor(100 * Math.trunc(rec.cursor) / total),
      segments: total,
      parts: Math.trunc(rec.cursor),
      duration: rec.duration,
      size: Math.trunc(rec.bytes),
      sizeHuman: humanBytes(Math.trunc(rec.bytes)),
      videoSamples: Math.trunc(rec.video_samples),
      filename: rec.filename,
      done,
      fileUrl: done ? await store.fileUrl(rec) : null,
      error: rec.status === 'error' ? rec.error : null,
      hint: rec.status === 'error' ? rec.hint : null,
      note: rec.note,
    };
  }

  /** The partial file and its log travel through storage with the record. */
  static async #flush(store, rec, mux) {
    await store.save(rec);
    await store.writeOutput(String(rec.id), mux.toBuffer(), mux.logBytes());
  }

  /** bandwidth x duration when the playlist says both, else null. */
  static #estimate(playlist) {
    let bits = 0;
    for (const v of playlist.variants) {
      if (Number(v.bandwidth) > bits) {
        bits = Number(v.bandwidth);
      }
    }
    if (bits <= 0 || !(playlist.totalDuration > 0)) {
      return null;
    }
    return Math.floor((bits / 8) * playlist.totalDuration);
  }

  /** The php 1.5 GB ceiling and the netlify 20 MB ceiling, whichever bites first. */
  static #hardCap() {
    return Math.min(
      Math.trunc(Number(cfg('build.max_bytes', 1610612736))),
      Math.trunc(Number(cfg('build.output_max_bytes', 20971520))),
    );
  }

  /** The same file under a second cache key: most edges keep the object, only the key changes. */
  static #otherPath(url) {
    const q = url.indexOf('?');
    return q === -1
      ? String(url).replace(/\/+$/, '') + '/'
      : url.slice(0, q) + '/' + url.slice(q);
  }

  /**
   * Pull one transport stream part and hand back its (decrypted) bytes.
   *
   * @returns {Promise<Buffer|null>}
   */
  static async #readSegment(http, rec, url, key) {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vdseg-')), 'part.ts');
    let raw;
    try {
      try {
        await http.get(url, {
          headers: rec.headers,
          timeout: Math.trunc(Number(cfg('build.segment_timeout', 25))),
          to_file: tmp,
          accept: 'video/mp2t,*/*;q=0.8',
        });
      } catch (e) {
        if (!(e instanceof HttpException)) {
          throw e;
        }
        return null;
      }
      const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
      if (size < 188 || size > Math.trunc(Number(cfg('build.segment_max_bytes', 67108864)))) {
        return null;
      }
      raw = fs.readFileSync(tmp);
      if (key !== null && key !== undefined) {
        const seq = Math.trunc(rec.segments[Math.trunc(rec.cursor)].s);
        raw = this.#decrypt(raw, key, this.#iv(rec.key.iv ?? '', seq));
      }
      if (!TsDemuxer.looksLikeTs(raw)) {
        return null;
      }
      return raw;
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  }

  /** @returns {Promise<Buffer>} the 16 byte key file */
  static async #keyBytes(http, rec) {
    const uri = String(rec.key?.uri ?? '');
    if (uri === '') {
      throw new ExtractException('This stream has no key url.', 'Only AES-128 with a plain key file can be opened.', 'drm');
    }
    const body = await this.#fetchText(http, uri, rec.headers);
    let key = Buffer.from(body, 'latin1');
    if (key.length !== 16) {
      const trimmed = key.toString('latin1').replace(/^[\r\n \t]+|[\r\n \t]+$/g, '');
      const tb = Buffer.from(trimmed, 'latin1');
      key = tb.length === 16 ? tb : key.subarray(0, Math.min(16, key.length));
    }
    if (key.length !== 16) {
      throw new ExtractException('The key for this stream is not a plain 16 byte one.', 'Use Save stream file instead.', 'drm');
    }
    return key;
  }

  /** HLS default: the IV is the media sequence number as a 128 bit big-endian value. */
  static #iv(declared, sequence) {
    if (typeof declared === 'string' && declared !== '') {
      const hex = declared.toLowerCase().replace(/0x|x| /g, '');
      if (hex.length === 32 && /^[0-9a-f]+$/.test(hex)) {
        return Buffer.from(hex, 'hex');
      }
    }
    const b = Buffer.alloc(4);
    b.writeUInt32BE(Math.trunc(sequence) >>> 0, 0);
    return Buffer.concat([Buffer.alloc(12, 0), b]);
  }

  /** php's openssl_decrypt of the whole aligned block run, raw, no padding check. */
  static #decrypt(raw, key, iv) {
    const aligned = raw.length % 16 === 0 ? raw : raw.subarray(0, raw.length - (raw.length % 16));
    try {
      const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
      d.setAutoPadding(false);
      return Buffer.concat([d.update(aligned), d.final()]);
    } catch {
      return Buffer.alloc(0);
    }
  }

  /** @returns {Promise<string>} the playlist text */
  static async #fetchText(http, url, headers) {
    const res = await http.get(url, {
      headers,
      max_bytes: Math.trunc(Number(cfg('build.playlist_max_bytes', 4194304))),
      accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8',
    });
    if (!res.ok()) {
      throw new ExtractException('The stream list came back as HTTP ' + res.status + '.', 'The host link has probably expired. Run the same link again.', 'playlist_http');
    }
    return res.body;
  }

  /** @returns {Promise<[Playlist, string]>} the media playlist plus the url it was read from */
  static async #mediaPlaylist(src, http) {
    const text = await this.#fetchText(http, src.url, src.headers);
    const playlist = Playlist.parse(text, src.url);
    if (!playlist.isMaster) {
      return [playlist, src.url];
    }
    const variant = playlist.selectVariant(src.height);
    if (variant === null) {
      throw new ExtractException('The stream list has no video quality in it.', 'Try Save stream file instead.', 'no_variant');
    }
    const again = await this.#fetchText(http, variant.url, src.headers);
    return [Playlist.parse(again, String(variant.url)), String(variant.url)];
  }

  /** avcC/asc travel in json as hex, and the muxer wants bytes. */
  static #binary(p) {
    return { ...p, avcC: Buffer.from(String(p.avcC), 'hex'), asc: Buffer.from(String(p.asc), 'hex') };
  }

  /**
   * A segment with no frames is usually a codec this muxer will not touch, so say
   * which one instead of writing an empty file.
   */
  static #firstComplaint(demux, rec) {
    for (const why of demux.skipped.values()) {
      if (String(why).includes('0x24')) {
        throw new ExtractException('This stream is HEVC (H.265).', 'HEVC video needs a full converter, and a shared server cannot run one.', 'hevc');
      }
    }
    void rec;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
