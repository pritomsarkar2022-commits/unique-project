/**
 * Elementary streams -> one progressive MP4, byte for byte like Mp4Mux.php.
 *
 * The php original streams to disk because a shared host kills a script after 30
 * seconds. A Netlify function keeps the whole build inside one invocation, so the
 * media and the sample log live in memory; the bytes it produces are identical, and
 * the log records are packed exactly as php packs them so a test can diff them too.
 *
 * Muxes H.264 + AAC-LC, which is what these hosts serve. Anything else is refused
 * with a message rather than producing a file that will not play.
 */
import { phpRound, intDiv } from '../supportPure.mjs';
import { ExtractException } from '../errors.mjs';

const VIDEO = 1;
const AUDIO = 2;
const REC_SAMPLE = 1;
const REC_CHUNK = 2;
const REC_BYTES = 16;
const TS = 90000;      // timestamps arrive on the 90 kHz TS clock
const MOVIE_TS = 1000; // mvhd timescale, so edit lists are in milliseconds

const ZERO = (n) => Buffer.alloc(n);
/** pack('N',...): php writes the low 32 bits, so anything wider wraps. */
const u32 = (n) => {
  const b = Buffer.alloc(4);
  let w = Math.trunc(n) % 4294967296;
  if (w < 0) {
    w += 4294967296;
  }
  b.writeUInt32BE(w, 0);
  return b;
};
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(Math.trunc(n) & 0xFFFF);
  return b;
};
const cat = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));

export class Mp4Mux {
  static VIDEO = VIDEO;
  static AUDIO = AUDIO;

  #out = [];
  #log = [];
  #written = 0;

  /** A fresh file always opens with ftyp; there is nothing to resume in memory. */
  static open() {
    const m = new Mp4Mux();
    m.#append(box('ftyp', cat('isom', u32(0x200), 'isomiso2avc1mp42')));
    return m;
  }

  /**
   * Take up a file an earlier request already wrote.
   *
   * Netlify gives one invocation no disk the next one can see, so the partial mp4 and
   * its sample log travel through blob storage between slices and come back here.
   * Appending to those bytes is what php's fopen($path, 'a') did, and the offsets in
   * the log stay true because they are absolute from the first ftyp.
   *
   * The log comes back as one block and #readLog walks a record at a time, so it is
   * cut here exactly like php's fread($fh, 16) loop: whole records only, and a short
   * tail — a write that never finished — ends the log rather than guessing at it.
   */
  static adopt(mp4, log) {
    const m = new Mp4Mux();
    m.#out = [Buffer.from(mp4)];
    m.#written = m.#out[0].length;
    if (log !== null && log !== undefined && log.length > 0) {
      const whole = Buffer.from(log);
      for (let at = 0; at + REC_BYTES <= whole.length; at += REC_BYTES) {
        m.#log.push(whole.subarray(at, at + REC_BYTES));
      }
    }
    return m;
  }

  bytesWritten() {
    return this.#written;
  }

  /** The finished file: ftyp, every mdat, then the moov. */
  toBuffer() {
    return Buffer.concat(this.#out);
  }

  /**
   * Hand back the bytes buffered since the last call and forget them.
   *
   * A build on a device does not have to hold the file it is writing, so the writer
   * drains after each part. The order is the order the file is in, and #written keeps
   * counting from the first ftyp, so the offsets packed into the log do not move.
   */
  takeOutput() {
    const out = Buffer.concat(this.#out);
    this.#out = [];
    return out;
  }

  /** The sidecar log bytes php would have written, for the parity test. */
  logBytes() {
    return Buffer.concat(this.#log);
  }

  /**
   * Append one segment.
   *
   * @param {Array<{data:Buffer,pts:number,dts:number,key:boolean}>} video
   * @param {Array<{data:Buffer,pts:number}>} audio
   */
  addSegment(video, audio) {
    const videoBytes = Buffer.concat(video.map((s) => s.data));
    const audioBytes = Buffer.concat(audio.map((s) => s.data));
    if (videoBytes.length === 0 && audioBytes.length === 0) {
      return;
    }
    const payload = Buffer.concat([videoBytes, audioBytes]);
    const mediaAt = this.#written + 8;
    this.#append(cat(u32(payload.length + 8), 'mdat', payload));

    for (const s of video) {
      this.#sample(VIDEO, s.data.length, s.dts, s.pts, s.key === true);
    }
    for (const s of audio) {
      const pts = s.pts ?? 0;
      this.#sample(AUDIO, s.data.length, pts, pts, false);
    }
    if (video.length !== 0) {
      this.#chunk(VIDEO, video.length, mediaAt);
    }
    if (audio.length !== 0) {
      this.#chunk(AUDIO, audio.length, mediaAt + videoBytes.length);
    }
  }

  #sample(track, size, dts, pts, key) {
    // 1 type + 1 track|flags + 4 size + 4 dts + 4 pts + 2 pad = 16
    const rec = Buffer.alloc(REC_BYTES);
    rec[0] = REC_SAMPLE;
    rec[1] = track | (key ? 0x80 : 0);
    rec.writeUInt32BE(size & 0xFFFFFFFF, 2);
    rec.writeUInt32BE(clampClock(dts), 6);
    rec.writeUInt32BE(clampClock(pts), 10);
    this.#log.push(rec);
  }

  #chunk(track, count, offset) {
    // 1 type + 1 track + 4 count + 8 offset + 2 pad = 16
    const rec = Buffer.alloc(REC_BYTES);
    rec[0] = REC_CHUNK;
    rec[1] = track;
    rec.writeUInt32BE(count >>> 0, 2);
    rec.writeBigUInt64LE(BigInt(offset), 6);
    this.#log.push(rec);
  }

  /**
   * Build and append moov from the sample log.
   *
   * @param {{width:number,height:number,avcC:Buffer,sampleRate?:number,channels?:number,asc?:Buffer}} p
   * @param {number} now creation time, fixed by the caller so the bytes are comparable
   */
  writeMoov(p, now = Math.floor(Date.now() / 1000)) {
    const video = this.#readLog(VIDEO);
    const audio = this.#readLog(AUDIO);
    if (video.samples === 0) {
      throw new ExtractException('That stream carried no video frames.', 'The stream file can still be saved.', 'no_video');
    }
    if (!Buffer.isBuffer(p.avcC) || p.avcC.length === 0) {
      throw new ExtractException('That stream never announced its H.264 parameters.', 'The stream file can still be saved.', 'no_sps');
    }
    if (this.#written > 0xFFFFFFF0) {
      throw new ExtractException('This file grew past 4 GB.', 'Pick a shorter clip or a lower quality.', 'too_big');
    }

    let base = video.dts[0];
    if (audio.samples > 0) {
      base = Math.min(base, audio.dts[0]);
    }
    const hasAudio = audio.samples > 0
      && Buffer.isBuffer(p.asc) && p.asc.length > 0
      && Number(p.sampleRate) > 0;

    const tracks = [videoTrack(video, base, p, now)];
    if (hasAudio) {
      tracks.push(audioTrack(audio, base, p, now));
    }

    let movieDur = 0;
    let body = Buffer.alloc(0);
    for (const t of tracks) {
      body = Buffer.concat([body, t.trak]);
      movieDur = Math.max(movieDur, t.movie_duration);
    }
    const mvhd = fullBox('mvhd', 0, cat(
      u32(now), u32(now), u32(MOVIE_TS), u32(movieDur), u32(0x00010000), u16(0x0100), u16(0),
      ZERO(8), matrix(), ZERO(24), u32(tracks.length + 1),
    ));
    this.#append(box('moov', cat(mvhd, body)));
  }

  #readLog(track) {
    const out = { samples: 0, sizes: [], dts: [], pts: [], key: [], chunk_counts: [], chunk_offsets: [] };
    for (const rec of this.#log) {
      if (rec[0] === REC_CHUNK) {
        if (rec[1] === track) {
          out.chunk_counts.push(rec.readUInt32BE(2));
          out.chunk_offsets.push(Number(rec.readBigUInt64LE(6)));
        }
        continue;
      }
      if (rec[0] !== REC_SAMPLE) {
        continue;
      }
      if ((rec[1] & 0x7F) !== track) {
        continue;
      }
      out.samples++;
      out.sizes.push(rec.readUInt32BE(2));
      out.dts.push(rec.readUInt32BE(6));
      out.pts.push(rec.readUInt32BE(10));
      out.key.push((rec[1] & 0x80) !== 0 ? 1 : 0);
    }
    return out;
  }

  #append(bytes) {
    this.#out.push(bytes);
    this.#written += bytes.length;
  }
}

function videoTrack(v, base, p, now) {
  const n = v.samples;
  const deltas = [];
  for (let i = 0; i < n - 1; i++) {
    const d = diff(v.dts[i + 1], v.dts[i]);
    deltas.push(d > 0 ? d : 1);
  }
  deltas.push(n > 1 ? deltas[n - 2] : intDiv(TS, 25));
  const mediaDur = deltas.reduce((a, b) => a + b, 0);

  const cts = [];
  for (let i = 0; i < n; i++) {
    cts.push(Math.max(0, diff(v.pts[i], v.dts[i])));
  }
  const sync = [];
  v.key.forEach((k, i) => {
    if (k === 1) {
      sync.push(i + 1);
    }
  });

  const width = Math.max(2, Math.trunc(Number(p.width) || 0));
  const height = Math.max(2, Math.trunc(Number(p.height) || 0));
  // SampleEntry boxes are plain boxes: stsd is the only full box in this path.
  const avc1 = box('avc1', cat(
    ZERO(6), u16(1), u16(0), u16(0), ZERO(12),
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), u32(0),
    u16(1), ZERO(32), u16(24), u16(0xFFFF),
    box('avcC', p.avcC),
  ));
  const stbl = cat(
    stsd(avc1),
    stts(deltas),
    ctts(cts),
    (sync.length === n || sync.length === 0 ? Buffer.alloc(0) : stss(sync)),
    stsc(v.chunk_counts),
    stsz(v.sizes),
    stco(v.chunk_offsets),
  );

  const delayMs = Math.max(0, phpRound(diff(v.pts[0], base) / TS * MOVIE_TS));
  const movieDurMs = delayMs + phpRound(mediaDur / TS * MOVIE_TS);
  const trak = box('trak', cat(
    tkhd(1, movieDurMs, width, height, false, now),
    edts(delayMs, mediaDur, TS),
    box('mdia', cat(
      mdhd(TS, mediaDur, now),
      hdlr('vide', 'VideoHandler'),
      box('minf', cat(
        fullBox('vmhd', 1, cat(u16(0), ZERO(6))),
        dinf(),
        box('stbl', stbl),
      )),
    )),
  ));
  return { trak, movie_duration: movieDurMs };
}

function audioTrack(a, base, p, now) {
  const rate = Math.max(1, Math.trunc(Number(p.sampleRate)));
  const ch = Math.max(1, Math.trunc(Number(p.channels)));
  const n = a.samples;
  // AAC frames are 1024 samples each, but a stream that loses a frame at a segment
  // boundary must show that gap in stts or the rest of the audio slides ahead of the
  // picture.
  const deltas = [];
  for (let i = 0; i < n - 1; i++) {
    const d = phpRound(diff(a.pts[i + 1], a.pts[i]) / TS * rate);
    deltas.push(d > 0 ? d : 1024);
  }
  deltas.push(1024);
  const mediaDur = deltas.reduce((x, y) => x + y, 0);

  const mp4a = box('mp4a', cat(
    ZERO(6), u16(1), u16(0), u16(0), u32(0),
    u16(ch), u16(16), u16(0), u16(0),
    // php packs (int)($rate << 16) into 4 bytes, so 96 kHz wraps past 32 bits.
    u32(rate * 65536),
    fullBox('esds', 0, esDescriptor(p.asc, rate, a.sizes)),
  ));
  const stbl = cat(
    stsd(mp4a),
    stts(deltas),
    stsc(a.chunk_counts),
    stsz(a.sizes),
    stco(a.chunk_offsets),
  );

  const delayMs = Math.max(0, phpRound(diff(a.pts[0], base) / TS * MOVIE_TS));
  const movieDurMs = delayMs + phpRound(mediaDur / rate * MOVIE_TS);
  const trak = box('trak', cat(
    tkhd(2, movieDurMs, 0, 0, true, now),
    edts(delayMs, mediaDur, rate),
    box('mdia', cat(
      mdhd(rate, mediaDur, now),
      hdlr('soun', 'SoundHandler'),
      box('minf', cat(
        fullBox('smhd', 0, cat(u16(0), u16(0))),
        dinf(),
        box('stbl', stbl),
      )),
    )),
  ));
  return { trak, movie_duration: movieDurMs };
}

function esDescriptor(asc, rate, sizes) {
  const frames = Math.max(1, sizes.length);
  const sum = sizes.reduce((x, y) => x + y, 0);
  const avg = sizes.length > 0 ? Math.trunc(sum / frames * 8 * rate / 1024) : 128000;
  const spec = cat(Buffer.from([0x05, asc.length]), asc);
  // streamType 5 (audio) lives in the low 6 bits after two reserved bits, so the byte
  // is 0x05; the three bytes after it carry upStream, a reserved bit and the 22-bit
  // bufferSizeDB. The SL config descriptor is a sibling of this descriptor, not part
  // of it, so its bytes must not count toward the length below.
  const decCfg = cat(
    Buffer.from([0x04, 13 + spec.length, 0x40, 0x05]),
    u32(2048).subarray(1),
    u32(avg * 2),
    u32(Math.max(1, avg)),
    spec,
  );
  const sl = Buffer.from([0x06, 0x01, 0x02]);
  const body = cat(u16(1), Buffer.from([0]), decCfg, sl);
  return cat(Buffer.from([0x03, body.length]), body);
}

/** @param {number[]} deltas */
function stts(deltas) {
  return sttsRun(runs(deltas));
}

/** @param {Array<[number,number]>} runs [value, count] */
function sttsRun(list) {
  let body = u32(list.length);
  for (const [value, count] of list) {
    body = Buffer.concat([body, u32(count), u32(value)]);
  }
  return fullBox('stts', 0, body);
}

/** @param {number[]} values @returns {Array<[number,number]>} */
function runs(values) {
  const out = [];
  for (const v of values) {
    const last = out.length === 0 ? null : out.length - 1;
    if (last !== null && out[last][0] === v) {
      out[last][1]++;
      continue;
    }
    out.push([v, 1]);
  }
  return out;
}

/** @param {number[]} offsets */
function ctts(offsets) {
  if (offsets.length === 0 || Math.max(...offsets) === 0) {
    return Buffer.alloc(0);
  }
  const list = runs(offsets);
  // entry_count is the number of runs, not the number of samples.
  let body = u32(list.length);
  for (const [offset, count] of list) {
    body = Buffer.concat([body, u32(count), u32(offset)]);
  }
  return fullBox('ctts', 0, body);
}

/** @param {number[]} indexes */
function stss(indexes) {
  let body = u32(indexes.length);
  for (const i of indexes) {
    body = Buffer.concat([body, u32(i)]);
  }
  return fullBox('stss', 0, body);
}

/** @param {number[]} sizes */
function stsz(sizes) {
  let body = Buffer.concat([u32(0), u32(sizes.length)]);
  for (const s of sizes) {
    body = Buffer.concat([body, u32(s)]);
  }
  return fullBox('stsz', 0, body);
}

/** @param {number[]} counts samples per chunk, in chunk order */
function stsc(counts) {
  const entries = [];
  let prev = null;
  counts.forEach((c, i) => {
    if (c !== prev) {
      entries.push([i + 1, c]);
      prev = c;
    }
  });
  let body = u32(entries.length);
  for (const [chunkNo, per] of entries) {
    body = Buffer.concat([body, u32(chunkNo), u32(per), u32(1)]);
  }
  return fullBox('stsc', 0, body);
}

/** @param {number[]} offsets */
function stco(offsets) {
  let body = u32(offsets.length);
  for (const o of offsets) {
    body = Buffer.concat([body, u32(o)]);
  }
  return fullBox('stco', 0, body);
}

function stsd(entry) {
  return fullBox('stsd', 0, Buffer.concat([u32(1), entry]));
}

function tkhd(id, movieDur, w, h, audio, now) {
  return fullBox('tkhd', 3, cat(
    u32(now), u32(now), u32(id), u32(0), u32(Math.max(0, movieDur)),
    ZERO(8), u16(0), u16(0),
    u16(audio ? 0x0100 : 0), u16(0),
    matrix(),
    u32(w * 65536), u32(h * 65536),
  ));
}

function mdhd(timescale, dur, now) {
  return fullBox('mdhd', 0, cat(
    u32(now), u32(now), u32(Math.max(1, timescale)), u32(Math.max(0, dur)),
    u16(0x55C4), u16(0),
  ));
}

function hdlr(type, name) {
  return fullBox('hdlr', 0, cat(u32(0), type, ZERO(12), name, Buffer.from([0])));
}

function dinf() {
  return box('dinf', fullBox('dref', 0, Buffer.concat([u32(1), fullBox('url ', 1, Buffer.alloc(0))])));
}

function edts(delayMs, mediaDur, trackTs) {
  if (delayMs <= 0) {
    return Buffer.alloc(0);
  }
  const entries = cat(
    u32(delayMs), u32(0xFFFFFFFF), u16(1), u16(0),
    u32(phpRound(mediaDur / Math.max(1, trackTs) * MOVIE_TS)), u32(0), u16(1), u16(0),
  );
  return box('edts', fullBox('elst', 0, Buffer.concat([u32(2), entries])));
}

function matrix() {
  return cat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));
}

/** Signed difference between two wrapped 32-bit clock readings. */
function diff(a, b) {
  let d = a - b;
  if (d >= 0x80000000) {
    d -= 0x100000000;
  } else if (d < -0x80000000) {
    d += 0x100000000;
  }
  return d;
}

/** Media is minutes long, so a wrapped 32-bit clock value stays monotonic enough. */
function clampClock(t) {
  const w = Math.trunc(t) % 4294967296;
  return w < 0 ? w + 4294967296 : w;
}

function box(type, payload) {
  return cat(u32(payload.length + 8), type, payload);
}

function fullBox(type, flags, payload) {
  return box(type, Buffer.concat([u32(flags), payload]));
}
