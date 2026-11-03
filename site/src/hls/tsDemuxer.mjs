/**
 * MPEG-TS packet reader. Feeds whole 188-byte packets, rebuilds PES packets from the
 * payload units, and reports which pid carries which codec.
 *
 * Port of lib/Hls/TsDemuxer.php. One instance is reused across every segment of a
 * stream, so a PES packet cut in half by a segment boundary still comes out whole.
 * Pid-keyed maps are Maps, not objects: php iterates them in arrival order and
 * Mp4Builder reads the first complaint out of that order, while javascript sorts
 * integer-like object keys numerically.
 */
const PKT = 188;

const VIDEO_TYPES = new Map([[0x01, 'mpeg2'], [0x02, 'mpeg2'], [0x1B, 'h264'], [0x24, 'hevc']]);
const AUDIO_TYPES = new Map([[0x03, 'mp1'], [0x04, 'mp2'], [0x0F, 'aac2'], [0x11, 'aac1'], [0x1F, 'aac4']]);

export class TsDemuxer {
  /** @type {Map<number,Buffer[]>} pid => payload chunks under construction */
  pending = new Map();
  /** @type {Map<number,{pts:?number,dts:?number}>} */
  pendingMeta = new Map();
  /** @type {Map<number,number>} pid => last continuity counter */
  lastCc = new Map();

  /** @type {Map<number,number>} pid => stream_type from the PMT */
  streamType = new Map();
  /** @type {Map<number,string>} pid => 'video'|'audio' */
  pidKind = new Map();
  videoPid = null;
  audioPid = null;
  pcrPid = null;
  pmtPid = null;
  /** @type {Map<number,string>} pid => why it was ignored */
  skipped = new Map();

  pesCount = 0;
  badPackets = 0;

  /**
   * @param {Buffer} bytes
   * @param {(pid:number, kind:string, pts:number|null, dts:number|null, pesBody:Buffer) => void} onPes
   */
  demux(bytes, onPes) {
    const len = bytes.length;
    let pos = findSync(bytes, 0, len);
    pos = pos === null ? len : pos;
    while (pos + PKT <= len) {
      if (bytes[pos] !== 0x47) {
        const next = findSync(bytes, pos, len);
        if (next === null) {
          break;
        }
        this.badPackets++;
        pos = next;
        continue;
      }
      this.packet(bytes, pos, len, onPes);
      pos += PKT;
    }
  }

  /** Emit any PES packet left open when the stream ends. */
  flush(onPes) {
    for (const [pid, chunks] of this.pending) {
      if (chunks.length !== 0) {
        this.emit(pid, Buffer.concat(chunks), this.pendingMeta.get(pid) ?? {}, onPes);
      }
    }
    this.pending = new Map();
    this.pendingMeta = new Map();
  }

  /** True when the buffer starts with four packet sync bytes 188 bytes apart. */
  static looksLikeTs(b) {
    return b.length >= 4 * PKT && findSync(b, 0, b.length) !== null;
  }

  packet(b, o, len, onPes) {
    const b1 = b[o + 1];
    if ((b1 & 0x80) !== 0) {
      return; // transport error
    }
    const pusi = (b1 & 0x40) !== 0;
    if (((b1 >> 4) & 0x03) === 0x03) {
      return; // reserved scrambling value
    }
    const pid = ((b1 & 0x1F) << 8) | b[o + 2];
    const b4 = b[o + 3];
    const afc = (b4 >> 4) & 0x03;
    if (afc === 0x00) {
      return; // reserved
    }
    const cc = b4 & 0x0F;
    const prevCc = this.lastCc.get(pid);
    if (prevCc !== undefined && prevCc !== cc && ((prevCc + 1) & 0x0F) !== cc) {
      this.badPackets++;
    }
    this.lastCc.set(pid, cc);

    const end = Math.min(o + PKT, len);
    let payloadAt = o + 4;
    if (afc === 0x02 || afc === 0x03) {
      const afLen = b[o + 4];
      if (payloadAt + 1 + afLen > end) {
        return;
      }
      if (afLen > 0 && afc === 0x03 && (b[o + 5] & 0x10) !== 0 && afLen >= 8) {
        if (this.pcrPid === null) {
          this.pcrPid = pid;
        }
      }
      payloadAt += 1 + afLen;
      if (afc === 0x02) {
        return; // adaptation only, no payload
      }
    }
    if (payloadAt >= end || pid === 0x1FFF || pid === 0x1FFE) {
      return;
    }
    const payload = b.subarray(payloadAt, end);

    if (pusi) {
      const open = this.pending.get(pid);
      if (open !== undefined && open.length !== 0) {
        this.emit(pid, Buffer.concat(open), this.pendingMeta.get(pid), onPes);
      }
      this.pending.set(pid, []);
      this.pendingMeta.set(pid, { pts: null, dts: null });
      if (pid === 0) {
        this.readPat(payload);
        return;
      }
      if (pid === this.pmtPid) {
        this.readPmt(payload);
        return;
      }
    }
    const bucket = this.pending.get(pid);
    if (bucket !== undefined) {
      bucket.push(payload);
    } else {
      this.pending.set(pid, [payload]);
    }
  }

  readPat(p) {
    const i = tableStart(p);
    if (i === null || p[i] !== 0x00 || i + 5 > p.length) {
      return;
    }
    const sectionLen = ((p[i + 1] & 0x0F) << 8) | p[i + 2];
    const from = i + 5;
    const to = Math.min(p.length - 4, from + sectionLen - 3 - 4);
    for (let j = from; j + 3 < to; j += 4) {
      const program = (p[j] << 8) | p[j + 1];
      const pmt = ((p[j + 2] & 0x1F) << 8) | p[j + 3];
      if (program !== 0 && pmt !== 0x1FFF) {
        this.pmtPid = pmt;
        return; // first real program is the one we play
      }
    }
  }

  readPmt(p) {
    const i = tableStart(p);
    if (i === null || p[i] !== 0x02 || i + 12 > p.length) {
      return;
    }
    const sectionLen = ((p[i + 1] & 0x0F) << 8) | p[i + 2];
    this.pcrPid = ((p[i + 8] & 0x1F) << 8) | p[i + 9];
    const progInfoLen = ((p[i + 10] & 0x0F) << 8) | p[i + 11];
    let j = i + 12 + progInfoLen;
    const to = Math.min(p.length - 4, i + 3 + sectionLen - 4);
    while (j + 4 < to) {
      const type = p[j];
      const esPid = ((p[j + 1] & 0x1F) << 8) | p[j + 2];
      const esInfoLen = ((p[j + 3] & 0x0F) << 8) | p[j + 4];
      j += 5 + esInfoLen;
      if (esPid === 0x1FFF || this.streamType.has(esPid)) {
        continue;
      }
      this.streamType.set(esPid, type);
      const isVideo = VIDEO_TYPES.has(type);
      const kind = isVideo ? VIDEO_TYPES.get(type)
        : (AUDIO_TYPES.get(type) ?? (type === 0x06 ? 'private' : null));
      if (kind === null) {
        this.skipped.set(esPid, 'stream type 0x' + type.toString(16));
        continue;
      }
      if (isVideo) {
        if (this.videoPid === null) {
          this.videoPid = esPid;
          this.pidKind.set(esPid, 'video');
        } else {
          this.skipped.set(esPid, 'a second video track');
        }
        continue;
      }
      if (this.audioPid === null) {
        this.audioPid = esPid;
        this.pidKind.set(esPid, 'audio');
      } else {
        this.skipped.set(esPid, 'another audio language');
      }
    }
  }

  emit(pid, pes, meta, onPes) {
    if (pes.length < 14 || pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) {
      return;
    }
    const streamId = pes[3];
    if (streamId === 0xBE || streamId === 0xBF || streamId === 0xFF) {
      return; // padding, end-of-stream, program stream map
    }
    const flags = pes[7];
    if ((flags & 0xC0) !== 0x80 && (flags & 0xC0) !== 0xC0) {
      return;
    }
    const pts = TsDemuxer.readTimestamp(pes, 9);
    const dts = (flags & 0xC0) === 0xC0 ? TsDemuxer.readTimestamp(pes, 14) : null;
    if (pts === null) {
      return;
    }
    const start = 9 + pes[8];
    if (start >= pes.length) {
      return;
    }
    let kind = this.pidKind.get(pid);
    if (kind === undefined) {
      kind = (streamId >= 0xE0 && streamId <= 0xEF) ? 'video'
        : ((streamId >= 0xC0 && streamId <= 0xDF) || streamId === 0xBD ? 'audio' : null);
      if (kind === null) {
        return; // teletext, ids3, metadata
      }
      this.pidKind.set(pid, kind);
    }
    if (this.videoPid === null && kind === 'video') {
      this.videoPid = pid;
    }
    if (this.audioPid === null && kind === 'audio') {
      this.audioPid = pid;
    }
    this.pesCount++;
    onPes(pid, kind, pts, dts, pes.subarray(start));
  }

  /**
   * 33-bit PTS/DTS field, marker bits skipped. Built with multiplication because the
   * value does not fit in javascript's 32-bit bitwise result.
   */
  static readTimestamp(b, o) {
    if (o + 4 >= b.length) {
      return null;
    }
    return (((b[o] & 0x0E) >> 1) * 0x40000000)
      + ((((b[o + 1] << 7) | (b[o + 2] >> 1)) * 0x8000))
      + ((b[o + 3] << 7) | (b[o + 4] >> 1));
  }
}

/** Absolute index of the first packet start at or after `from`, or null. */
function findSync(b, from, len) {
  for (let i = from; i + 3 * PKT < len; i++) {
    if (b[i] === 0x47 && b[i + PKT] === 0x47 && b[i + 2 * PKT] === 0x47 && b[i + 3 * PKT] === 0x47) {
      return i;
    }
  }
  return (from < len && b[from] === 0x47) ? from : null;
}

function tableStart(p) {
  if (p.length === 0) {
    return null;
  }
  const i = 1 + p[0];
  return i < p.length ? i : null;
}
