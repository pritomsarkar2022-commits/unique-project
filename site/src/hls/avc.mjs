import { BitReader } from './bitReader.mjs';

/**
 * H.264 Annex-B -> MP4 sample builder.
 *
 * Port of lib/Hls/Avc.php. Splits the start-code stream into NAL units, finds
 * access-unit boundaries (a slice whose first_mb_in_slice is 0, or parameter sets in
 * front of a new picture), rewrites start codes into 4-byte lengths and keeps the
 * SPS/PPS for avcC.
 */
const SLICE_TYPES = [1, 2, 3, 4, 5, 19, 20, 21];
const HIGH_PROFILES = [100, 110, 120, 144, 44, 83, 86, 118, 128, 138, 139, 134, 135];

export class Avc {
  /** @type {Buffer[]} NAL units of the access unit being collected */
  current = [];
  currentPts = null;
  currentDts = null;
  hasSlice = false;
  hasIdr = false;

  /** @type {Map<number,Buffer>} nal type => bytes of the first SPS and PPS seen */
  paramSets = new Map();
  /**
   * A PES packet may end in the middle of a NAL unit, so the bytes before the next
   * start code continue the last unit of the access unit still open.
   */
  carry = Buffer.alloc(0);
  /** @type {{profile:number,constraints:number,level:number,chroma:number,depth_luma:number,depth_chroma:number}|null} */
  spsInfo = null;
  width = 0;
  height = 0;
  samples = 0;
  keyframes = 0;

  /**
   * Feed one video PES packet; get back the access units it completed.
   *
   * @returns {Array<{nalus:Buffer[],pts:number,dts:number,key:boolean}>}
   */
  push(annexB, pts, dts) {
    this.stealCarry(annexB);
    const done = [];
    for (const [type, nalu] of Avc.split(annexB)) {
      if ((type === 7 || type === 8) && !this.paramSets.has(type)) {
        this.paramSets.set(type, nalu);
        if (type === 7) {
          this.readSps(nalu);
        }
      }
      const isSlice = SLICE_TYPES.includes(type);
      const newPicture = (isSlice && Avc.firstMbIsZero(nalu)) || ([7, 8, 9].includes(type) && this.hasSlice);
      if (newPicture && this.hasSlice) {
        done.push(this.close());
      }
      if (type !== 0) {
        this.current.push(nalu);
      }
      if (isSlice) {
        if (!this.hasSlice) {
          this.currentPts = pts;
          this.currentDts = dts ?? pts;
        }
        this.hasSlice = true;
      }
      if (type === 5) {
        this.hasIdr = true;
      }
    }
    return done;
  }

  /**
   * Move the bytes that sit before this chunk's first start code back into the
   * NAL unit they were cut out of.
   */
  stealCarry(annexB) {
    const first = Avc.firstStart(annexB);
    if (first === null) {
      this.carry = Buffer.concat([this.carry, annexB]);
      return;
    }
    if (first > 0) {
      this.carry = Buffer.concat([this.carry, annexB.subarray(0, first)]);
    }
    if (this.carry.length === 0) {
      return;
    }
    if (this.current.length !== 0) {
      const last = this.current.length - 1;
      this.current[last] = Buffer.concat([this.current[last], this.carry]);
    }
    this.carry = Buffer.alloc(0);
  }

  /** Close the access unit left open at the end of the stream. */
  finish() {
    if (this.carry.length !== 0 && this.current.length !== 0) {
      const last = this.current.length - 1;
      this.current[last] = Buffer.concat([this.current[last], this.carry]);
      this.carry = Buffer.alloc(0);
    }
    if (!this.hasSlice) {
      return [];
    }
    return [this.close()];
  }

  close() {
    this.samples++;
    if (this.hasIdr) {
      this.keyframes++;
    }
    const unit = {
      nalus: this.current,
      pts: this.currentPts ?? 0,
      dts: this.currentDts ?? this.currentPts ?? 0,
      key: this.hasIdr,
    };
    this.current = [];
    this.currentPts = null;
    this.currentDts = null;
    this.hasSlice = false;
    this.hasIdr = false;
    return unit;
  }

  /** Index of the first start code in the chunk, or null when there is none. */
  static firstStart(b) {
    const len = b.length;
    for (let i = 0; i < len - 2; i++) {
      if (b[i] === 0x00 && b[i + 1] === 0x00
        && (b[i + 2] === 0x01 || (b[i + 2] === 0x00 && i + 3 < len && b[i + 3] === 0x01))) {
        return i;
      }
    }
    return null;
  }

  /** @returns {Array<[number, Buffer]>} [nal type, nalu bytes without the start code] */
  static split(b) {
    const out = [];
    const len = b.length;
    let i = 0;
    let start = -1;
    while (i < len - 2) {
      if (b[i] === 0x00 && b[i + 1] === 0x00) {
        let newLen = 0;
        if (b[i + 2] === 0x01) {
          newLen = 3;
        } else if (b[i + 2] === 0x00 && i + 3 < len && b[i + 3] === 0x01) {
          newLen = 4;
        }
        if (newLen !== 0) {
          if (start >= 0) {
            Avc.collect(out, b.subarray(start, i));
          }
          start = i + newLen;
          i = start;
          continue;
        }
      }
      i++;
    }
    if (start >= 0) {
      Avc.collect(out, b.subarray(start));
    }
    return out;
  }

  static collect(out, unit) {
    let end = unit.length;
    while (end > 0 && unit[end - 1] === 0x00) {
      end--;
    }
    if (end > 0) {
      out.push([unit[0] & 0x1F, unit.subarray(0, end)]);
    }
  }

  /** slice_header opens with first_mb_in_slice ue(v): zero means a new picture. */
  static firstMbIsZero(nalu) {
    const br = new BitReader(Avc.unescape(nalu.subarray(1)));
    const v = br.ue();
    return v === null || v === 0;
  }

  /**
   * Drop the 0x03 emulation-prevention bytes.
   *
   * Written as a scan rather than a replacement so it consumes exactly what
   * preg_replace('/\x00\x00\x03([\x00\x01\x02\x03])/') consumes: a match is four
   * bytes long, so the "\x00\x00\x03" that could start inside the byte it captured is
   * not matched again. A loop that only looked for the three-byte prefix would delete
   * a 0x03 that php keeps, and the decoder would then read the wrong slice header.
   */
  static unescape(b) {
    const out = Buffer.allocUnsafe(b.length);
    let w = 0;
    for (let i = 0; i < b.length; i++) {
      if (b[i] === 0x00 && i + 3 < b.length && b[i + 1] === 0x00 && b[i + 2] === 0x03 && b[i + 3] <= 0x03) {
        out[w++] = 0x00;
        out[w++] = 0x00;
        out[w++] = b[i + 3];
        i += 3;
        continue;
      }
      out[w++] = b[i];
    }
    return out.subarray(0, w);
  }

  readSps(nalu) {
    const br = new BitReader(Avc.unescape(nalu.subarray(1)));
    const profile = br.u(8);
    const constraints = br.u(8);
    const level = br.u(8);
    if (profile === null || constraints === null || level === null) {
      return;
    }
    br.ue(); // sps_id
    let chroma = 1;
    let depthLuma = 8;
    let depthChroma = 8;
    if (HIGH_PROFILES.includes(profile)) {
      const got = br.ue();
      if (got === null) {
        return;
      }
      chroma = got;
      if (chroma === 3) {
        br.u(1);
      }
      const dl = br.ue();
      const dc = br.ue();
      if (dl === null || dc === null) {
        return;
      }
      depthLuma = dl + 8;
      depthChroma = dc + 8;
      br.u(1); // qpprime_y_zero_transform_bypass_flag
      if (br.u(1) === 1) {
        for (let i = 0, n = chroma === 3 ? 12 : 8; i < n; i++) {
          if (br.u(1) === 1) {
            Avc.skipScalingList(br, i < 6 ? 16 : 64);
          }
        }
      }
    }
    br.ue(); // log2_max_frame_num_minus4
    const pocType = br.ue();
    if (pocType === 0) {
      br.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      br.u(1);
      br.se();
      br.se();
      for (let i = 0, n = br.ue() ?? 0; i < n; i++) {
        br.se();
      }
    }
    br.ue(); // max_num_ref_frames
    br.u(1); // gaps_in_frame_num_value_allowed_flag
    const wMbs = br.ue();
    const hUnits = br.ue();
    const mbsOnly = br.u(1);
    if (wMbs === null || hUnits === null || mbsOnly === null) {
      return;
    }
    if (mbsOnly === 0) {
      br.u(1); // mb_adaptive_frame_field_flag
    }
    br.u(1); // direct_8x8_inference_flag
    let width = (wMbs + 1) * 16;
    let height = (hUnits + 1) * 16 * (2 - mbsOnly);
    const frameCropping = br.u(1);
    if (frameCropping === 1) {
      const cropX = (chroma === 0 ? 1 : (chroma === 3 ? 1 : 2));
      const cropY = (chroma === 0 ? 1 : (chroma === 1 ? 2 : 1)) * (2 - mbsOnly);
      width -= ((br.ue() ?? 0) + (br.ue() ?? 0)) * cropX;
      height -= ((br.ue() ?? 0) + (br.ue() ?? 0)) * cropY;
    }
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    this.spsInfo = {
      profile,
      constraints,
      level,
      chroma,
      depth_luma: depthLuma,
      depth_chroma: depthChroma,
    };
  }

  static skipScalingList(br, size) {
    let last = 8;
    let next = 8;
    for (let i = 0; i < size; i++) {
      if (i !== 0) {
        const d = br.se();
        if (d === null) {
          return;
        }
        next = (last + d + 256) % 256;
      }
      if (next !== 0) {
        last = next;
      }
    }
  }

  /** avcC box contents, or null until both parameter sets have been seen. */
  avcC() {
    const sps = this.paramSets.get(7);
    const pps = this.paramSets.get(8);
    if (sps === undefined || pps === undefined || this.spsInfo === null) {
      return null;
    }
    const parts = [
      Uint8Array.from([1, this.spsInfo.profile, this.spsInfo.constraints, this.spsInfo.level,
        0xFC | 3,   // 4-byte nal length field
        0xE0 | 1]), // one sps
      u16be(sps.length), sps,
      Uint8Array.from([1]),            // one pps
      u16be(pps.length), pps,
    ];
    if (HIGH_PROFILES.includes(this.spsInfo.profile)) {
      parts.push(Uint8Array.from([
        0xF8 | this.spsInfo.chroma,
        0xF8 | (this.spsInfo.depth_luma - 8),
        0xF8 | (this.spsInfo.depth_chroma - 8),
        0xFC | 0,
      ]));
    }
    return Buffer.concat(parts);
  }

  /** @param {Buffer[]} nalus */
  static toAvcc(nalus) {
    const parts = [];
    for (const n of nalus) {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(n.length, 0);
      parts.push(head, n);
    }
    return Buffer.concat(parts);
  }
}

function u16be(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value & 0xFFFF, 0);
  return b;
}
