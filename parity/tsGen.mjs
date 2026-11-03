/**
 * Deterministic MPEG-TS fixtures for the engine parity test.
 *
 * The repository ships no captured .ts files, so the differential test between the
 * php engine and its node port has to invent its own transport streams. Everything
 * here is reproducible from a seed: no clock reads, no randomness except through
 * makeRng, so php and node are handed byte-identical segments.
 */
import { makeRng } from './harness.mjs';

const PKT = 188;
const START4 = Buffer.from([0, 0, 0, 1]);
const HIGH_PROFILES = [100, 110, 120, 144, 44, 83, 86, 118, 128, 138, 139, 134, 135];

/** MSB-first bit writer, the inverse of BitReader. */
class BitWriter {
  bits = [];

  u(value, n) {
    for (let i = n - 1; i >= 0; i--) {
      this.bits.push(Math.floor(value / Math.pow(2, i)) & 1);
    }
    return this;
  }

  ue(value) {
    const v = value + 1;
    let n = 0;
    while (Math.pow(2, n + 1) <= v) {
      n++;
    }
    for (let i = 0; i < n; i++) {
      this.bits.push(0);
    }
    return this.u(v, n + 1);
  }

  se(value) {
    return value > 0 ? this.ue(2 * value - 1) : this.ue(-2 * value);
  }

  /** rbsp_trailing_bits: a one bit, then zeros to the byte boundary. */
  align() {
    this.bits.push(1);
    while (this.bits.length % 8 !== 0) {
      this.bits.push(0);
    }
    return this;
  }

  bytes() {
    const out = Buffer.alloc(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      if (b) {
        out[i >> 3] |= 0x80 >> (i & 7);
      }
    });
    return out;
  }
}

/** Insert the 0x03 emulation-prevention bytes H.264 requires after any 00 00 pair. */
export function escapeRbsp(b) {
  const out = [];
  let zeros = 0;
  for (const byte of b) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

/** Annex-B unit: start code, nal header, escaped payload. */
function nal(nalRefIdc, type, payload, startLen = 4) {
  const header = (nalRefIdc << 5) | type;
  const body = escapeRbsp(Buffer.concat([Buffer.from([header]), payload]));
  return Buffer.concat([Buffer.from(startLen === 3 ? [0, 0, 1] : [0, 0, 0, 1]), body]);
}

/**
 * A parseable SPS. The php reader walks profile, size and crop fields, so the values
 * here decide the width and height the muxer writes into avc1.
 */
export function spsPayload({ width = 320, height = 176, profile = 66, level = 30, crop = null, chroma = null } = {}) {
  const bw = new BitWriter();
  bw.u(profile, 8).u(0, 8).u(level, 8);
  bw.ue(0);                                  // seq_parameter_set_id
  if (HIGH_PROFILES.includes(profile)) {
    const c = chroma ?? 1;
    bw.ue(c);
    if (c === 3) {
      bw.u(0, 1);
    }
    bw.ue(0).ue(0);                          // bit depth luma/chroma minus 8
    bw.u(0, 1);                              // qpprime_y_zero_transform_bypass
    bw.u(0, 1);                              // seq_scaling_matrix_present
  }
  bw.ue(0);                                  // log2_max_frame_num_minus4
  bw.ue(0);                                  // pic_order_cnt_type
  bw.ue(0);                                  // log2_max_pic_order_cnt_lsb_minus4
  bw.ue(1);                                  // max_num_ref_frames
  bw.u(0, 1);                                // gaps_in_frame_num_value_allowed
  bw.ue(Math.max(0, Math.ceil(width / 16) - 1));
  bw.ue(Math.max(0, Math.ceil(height / 16) - 1));
  bw.u(1, 1);                                // frame_mbs_only_flag
  bw.u(1, 1);                                // direct_8x8_inference_flag
  if (crop === null) {
    bw.u(0, 1);
  } else {
    bw.u(1, 1);
    bw.ue(crop[0]).ue(crop[1]).ue(crop[2]).ue(crop[3]);
  }
  bw.u(0, 1);                                // vui_parameters_present_flag
  return bw.align().bytes();
}

export function ppsPayload({ sliceGroups = 0 } = {}) {
  const bw = new BitWriter();
  bw.ue(0).ue(0);                            // pps_id, sps_id
  bw.u(0, 1);                                // entropy_coding_mode (cabac)
  bw.u(0, 1);                                // bottom_field_pic_order_present
  bw.ue(sliceGroups);                        // num_slice_groups_minus1
  bw.ue(0).ue(0);                            // num_ref_idx_l0/l1_default_active_minus1
  bw.u(0, 1);                                // weighted_pred_flag
  bw.u(0, 2);                                // weighted_bipred_idc
  bw.se(0).se(0);                            // pic_init_qp / pic_init_qs minus 26
  bw.u(0, 1);                                // redundant_pic_cnt_present
  bw.u(1, 1);                                // deblocking_filter_control_present
  bw.u(0, 1);                                // constrained_intra_pred_flag
  bw.u(0, 1);                                // deblocking_filter_override_enabled
  return bw.align().bytes();
}

/**
 * A slice NAL. first_mb_in_slice is what the reader uses to spot a new picture, so
 * that one value decides whether this unit opens a frame or continues one.
 */
export function slicePayload(sliceType, firstMb, size, rng, { keepZeros = false } = {}) {
  const bw = new BitWriter();
  bw.ue(firstMb);
  bw.ue(sliceType);
  bw.ue(0);                                  // pic_parameter_set_id
  bw.u(0, 8);                                // frame_num
  if (sliceType === 7) {
    bw.ue(0);                                // idr_pic_id
  }
  bw.align();
  const filler = rng.bytes(size);
  if (!keepZeros) {
    for (let i = 0; i < filler.length; i++) {
      filler[i] |= 1;                        // no accidental start codes unless asked
    }
  }
  return Buffer.concat([bw.bytes(), filler]);
}

/** ADTS frame the php Aac reader accepts. */
export function adtsFrame(freqIdx, channels, raw, { mpeg2 = false, protection = true } = {}) {
  const frameLen = (protection ? 7 : 9) + raw.length;
  const b2 = (0 << 6) | (freqIdx << 2) | ((channels >> 1) & 1);
  const b3 = ((channels & 1) << 6) | ((frameLen >> 11) & 0x03);
  const head = Buffer.from([
    0xFF,
    (mpeg2 ? 0x08 : 0x00) | 0xF0 | (protection ? 0x01 : 0x00),
    b2,
    b3,
    (frameLen >> 3) & 0xFF,
    ((frameLen & 0x07) << 5) | 0x04,
    0xFC,
  ]);
  const crc = protection ? Buffer.alloc(0) : Buffer.from([0x00, 0x00]);
  return Buffer.concat([head, crc, raw]);
}

/** PTS/DTS field: 4 marker bits, 33 clock bits, two one-bit separators. */
function timestamp(prefix, value) {
  const v = ((Math.trunc(value) % 0x200000000) + 0x200000000) % 0x200000000;
  const high = Math.floor(v / 0x40000000);
  const mid = Math.floor(v / 0x8000) & 0x7FFF;
  const low = v & 0x7FFF;
  return Buffer.from([
    (prefix << 4) | (high << 1) | 1,
    (mid >> 7) & 0xFF,
    ((mid & 0x7F) << 1) | 1,
    (low >> 7) & 0xFF,
    ((low & 0x7F) << 1) | 1,
  ]);
}

function pesHeader(streamId, pts, dts, flags) {
  const both = dts !== null && dts !== undefined;
  const body = both
    ? Buffer.concat([timestamp(0x3, pts), timestamp(0x1, dts)])
    : timestamp(0x2, pts);
  return Buffer.concat([
    // 00 00 01, stream id, packet length, the '10' marker byte, then pts/dts flags
    // and the header length: the reader looks for the flags at byte 7, not byte 6.
    Buffer.from([0, 0, 1, streamId, 0, 0, 0x80, flags, body.length]),
    body,
  ]);
}

/** PCR adaptation field: pcr flag set, then 48 bits of base and extension. */
function pcrAf(base, ext = 0) {
  const bw = new BitWriter();
  bw.u(3, 2).u(base, 33).u(1, 1).u(ext, 9).u(0, 3);
  return Buffer.concat([Buffer.from([0x10]), bw.bytes()]);
}

/** One 188-byte packet. The adaptation field is grown to absorb any leftover space. */
function packet(pid, { pusi = false, scrambling = 0, af = null, payload = Buffer.alloc(0), cc = 0 }) {
  const b = Buffer.alloc(PKT);
  b[0] = 0x47;
  b[1] = (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1F);
  b[2] = pid & 0xFF;
  const afc = af === null ? 0x01 : (payload.length === 0 ? 0x02 : 0x03);
  b[3] = (scrambling << 6) | (afc << 4) | (cc & 0x0F);
  let at = 4;
  if (af !== null) {
    const room = PKT - at - payload.length;
    if (room < 1) {
      throw new Error('adaptation field has no room');
    }
    b[at] = room - 1;
    at += 1;
    // room counts the length byte, so the field body itself is room - 1 bytes wide
    const use = Math.min(af.length, room - 1);
    af.copy(b, at, 0, use);
    b.fill(0xFF, at + use, at + room - 1);
    at += room - 1;
  }
  payload.copy(b, at, 0, Math.min(payload.length, PKT - at));
  return b;
}

/**
 * Writes packets for one transport stream and hands them back as segments.
 *
 * Packets append in order, so a PES can straddle a segment boundary on purpose; the
 * reader instance lives across the whole fixture exactly like it does in Mp4Builder.
 */
export class TsBuilder {
  constructor({ videoPid = 256, audioPid = 257, pmtPid = 4096, pcrPid = 256, patLayout = 'spec' } = {}) {
    this.videoPid = videoPid;
    this.audioPid = audioPid;
    this.pmtPid = pmtPid;
    this.pcrPid = pcrPid;
    this.patLayout = patLayout;
    this.cc = new Map();
    this.packets = [];
  }

  nextCc(pid) {
    const n = (this.cc.get(pid) ?? 0) & 0x0F;
    this.cc.set(pid, (n + 1) & 0x0F);
    return n;
  }

  raw(p) {
    this.packets.push(p);
    return this;
  }

  pat(pmtPid = this.pmtPid, program = 1) {
    const entry = Buffer.from([(program >> 8) & 0xFF, program & 0xFF, 0xE0 | ((pmtPid >> 8) & 0x1F), pmtPid & 0xFF]);
    const head = Buffer.from([0x00, 0x00, 0xB0, 0x0D, 0x00, 0x01]);
    const crc = Buffer.from([0, 0, 0, 0]);
    if (this.patLayout === 'php') {
      // readPat walks a pat from its sixth byte rather than its eighth, so the entry
      // has to sit there for the pmt branch to be reachable at all.
      return Buffer.concat([head, entry, Buffer.from([0x00]), crc]);
    }
    return Buffer.concat([head, Buffer.from([0xC1, 0x00, 0x00]), entry, crc]);
  }

  pmt(entries, { pcrPid = this.pcrPid, progInfo = 0 } = {}) {
    const es = [];
    for (const e of entries) {
      const info = e.esInfo ?? 0;
      es.push(Buffer.from([e.type, (e.pid >> 8) & 0x1F, e.pid & 0xFF, (info >> 8) & 0x0F, info & 0xFF]));
      if (info > 0) {
        es.push(Buffer.alloc(info).fill(0x0F));
      }
    }
    const body = Buffer.concat([
      Buffer.from([0x00, 0x01]),
      Buffer.from([0xC1, 0x00, 0x00]),
      Buffer.from([(pcrPid >> 8) & 0x1F, pcrPid & 0xFF]),
      Buffer.from([0xF0 | ((progInfo >> 8) & 0x0F), progInfo & 0xFF]),
      ...es,
      Buffer.from([0, 0, 0, 0]),
    ]);
    const sectionLen = body.length;
    return Buffer.concat([
      Buffer.from([0x00, 0x02, 0xB0 | ((sectionLen >> 8) & 0x0F), sectionLen & 0xFF]),
      body,
    ]);
  }

  /** Write one section to its own packet. */
  section(pid, bytes, { pcrBase = null } = {}) {
    return this.raw(packet(pid, {
      pusi: true,
      af: pcrBase === null ? Buffer.from([0x00]) : pcrAf(pcrBase),
      payload: bytes.subarray(0, PKT - 4 - (pcrBase === null ? 1 : 7)),
      cc: this.nextCc(pid),
    }));
  }

  /**
   * Chunk a PES across packets; the first packet carries pusi and, when asked, a PCR.
   *
   * `flags` follows the header byte: 0x80 is pts only, 0xC0 adds dts.
   */
  pes(pid, streamId, pts, dts, body, { pcrBase = null, pusi = true, flags = null, ccOffset = 0, truncate = 0 } = {}) {
    const useFlags = flags === null ? (dts === null || dts === undefined ? 0x80 : 0xC0) : flags;
    const head = pesHeader(streamId, pts, dts, useFlags);
    const bytes = Buffer.concat([head, body]).subarray(0, truncate > 0 ? Math.max(0, head.length + body.length - truncate) : undefined);
    let at = 0;
    let first = true;
    while (at < bytes.length) {
      const af = first && pcrBase !== null ? pcrAf(pcrBase) : null;
      const capacity = PKT - 4 - (af === null ? 0 : af.length + 1);
      const take = Math.min(capacity, bytes.length - at);
      const payload = bytes.subarray(at, at + take);
      this.raw(packet(pid, {
        pusi: first && pusi,
        af: af ?? (PKT - 4 - payload.length > 0 ? Buffer.from([0x00]) : null),
        payload,
        cc: (this.nextCc(pid) + ccOffset) & 0x0F,
      }));
      at += take;
      first = false;
    }
    return this;
  }

  /** @returns {Buffer[]} segments of `per` packets each */
  segments(per) {
    const out = [];
    for (let i = 0; i < this.packets.length; i += per) {
      out.push(Buffer.concat(this.packets.slice(i, i + per)));
    }
    return out;
  }
}

/** One byte of a packet changed in place, without mutating the original. */
function poke(buf, at, fn) {
  const copy = Buffer.from(buf);
  copy[at] = fn(copy[at]) & 0xFF;
  return copy;
}

/** The fixture set: name, segments, and the hazard each one exists to cover. */
export function fixtures() {
  const out = [];

  // 1. the plain case: eight pictures, twelve audio frames, spec pat, stream-id fallback
  {
    const t = new TsBuilder({ patLayout: 'spec' });
    const rng = makeRng(1);
    t.section(0, t.pat());
    let clock = 90000;
    for (let i = 0; i < 8; i++) {
      const key = i % 4 === 0;
      const units = [];
      if (key) {
        units.push(nal(3, 7, spsPayload({ width: 320, height: 176 })));
        units.push(nal(3, 8, ppsPayload()));
      }
      units.push(nal(key ? 3 : 0, key ? 5 : 1, slicePayload(key ? 7 : 2, 0, 24 + (i % 3) * 7, rng)));
      t.pes(t.videoPid, 0xE0, clock + 3600, clock, Buffer.concat(units), { pcrBase: clock });
      clock += 3600;
    }
    for (let a = 0; a < 12; a++) {
      t.pes(t.audioPid, 0xC0, Math.round(90000 + a * 1024 * 90000 / 44100), null, adtsFrame(4, 2, rng.bytes(97)));
    }
    out.push({ name: 'baseline', segments: t.segments(40) });
  }

  // 2. b-frames: pts and dts disagree, and one picture carries no dts at all
  {
    const t = new TsBuilder();
    const rng = makeRng(2);
    const dts = [0, 3000, 6000, 9000, 12000, 15000];
    const pts = [6000, 0, 12000, 3000, 15000, 9000];
    t.section(0, t.pat());
    t.section(t.pmtPid, t.pmt([{ type: 0x1B, pid: t.videoPid }, { type: 0x0F, pid: t.audioPid }], { pcrPid: t.audioPid }));
    for (let i = 0; i < dts.length; i++) {
      const key = i === 0;
      const units = key
        ? [nal(3, 7, spsPayload({ width: 640, height: 360, profile: 77 })), nal(3, 8, ppsPayload()), nal(3, 5, slicePayload(7, 0, 40, rng))]
        : [nal(0, 1, slicePayload(2, 0, 30, rng))];
      t.pes(t.videoPid, 0xE0, pts[i], i === 4 ? null : dts[i], Buffer.concat(units), { pcrBase: dts[i], flags: i === 4 ? 0x80 : 0xC0 });
    }
    out.push({ name: 'bframes', segments: t.segments(33) });
  }

  // 3. nal units split across packets, and a pes left open at a segment edge
  {
    const t = new TsBuilder();
    const rng = makeRng(3);
    t.section(0, t.pat());
    for (let i = 0; i < 6; i++) {
      // a three-byte start code on the later units exercises the other split branch
      t.pes(t.videoPid, 0xE0, i * 3600, i * 3600, Buffer.concat([
        nal(3, i === 0 ? 7 : 1, i === 0 ? spsPayload({ width: 320, height: 176 }) : slicePayload(2, 0, 300 + i * 13, rng), i === 0 ? 4 : 3),
      ]), { pcrBase: i * 3600 });
    }
    for (let a = 0; a < 30; a++) {
      t.pes(t.audioPid, 0xC0, a * 2088, null, adtsFrame(4, 2, rng.bytes(200)));
    }
    out.push({ name: 'splits', segments: t.segments(25) });
  }

  // 4. clocks that walk over the 33-bit wrap
  {
    const t = new TsBuilder();
    const rng = makeRng(4);
    t.section(0, t.pat());
    let c = 0x1FFFFFE00;
    for (let i = 0; i < 6; i++) {
      t.pes(t.videoPid, 0xE0, c, c, Buffer.concat([
        i === 0 ? nal(3, 7, spsPayload({ width: 320, height: 176 })) : Buffer.alloc(0),
        nal(i === 0 ? 3 : 0, i === 0 ? 5 : 1, slicePayload(2, 0, 20, rng)),
      ]), { pcrBase: c });
      c = (c + 3000) % 0x200000000;
    }
    for (let a = 0; a < 6; a++) {
      t.pes(t.audioPid, 0xC0, (a * 2088) % 0x200000000, null, adtsFrame(4, 2, rng.bytes(120)));
    }
    out.push({ name: 'clockwrap', segments: t.segments(20) });
  }

  // 5. emulation prevention: 00 00 00, 00 00 01 and 00 00 03 inside slice data
  {
    const t = new TsBuilder();
    const nasty = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 3, 0, 0, 0, 0, 0]);
    t.section(0, t.pat());
    for (let i = 0; i < 5; i++) {
      const rbsp = Buffer.concat([
        new BitWriter().ue(0).ue(i === 0 ? 7 : 2).ue(0).u(0, 8).align().bytes(),
        nasty,
        Buffer.from([i, 0, 0, 1, 0, 0, 3, 7, 0, 0, 0, 0]),
      ]);
      const header = Buffer.from([((i === 0 ? 3 : 0) << 5) | (i === 0 ? 5 : 1)]);
      t.pes(t.videoPid, 0xE0, i * 3000, i * 3000, Buffer.concat([
        i === 0 ? nal(3, 7, spsPayload({ width: 320, height: 240 })) : Buffer.alloc(0),
        Buffer.concat([START4, escapeRbsp(Buffer.concat([header, rbsp]))]),
      ]), { pcrBase: i * 3000 });
    }
    out.push({ name: 'escaping', segments: t.segments(30) });
  }

  // 6. a pmt with hevc, a second video, a second audio and a private stream
  {
    const t = new TsBuilder({ patLayout: 'php' });
    const rng = makeRng(6);
    t.section(0, t.pat());
    t.section(t.pmtPid, t.pmt([
      { type: 0x1B, pid: t.videoPid },
      { type: 0x24, pid: 300 },
      { type: 0x1B, pid: 301 },
      { type: 0x0F, pid: t.audioPid },
      { type: 0x11, pid: 302 },
      { type: 0x06, pid: 303 },
      { type: 0x81, pid: 304, esInfo: 6 },
    ]));
    for (let i = 0; i < 4; i++) {
      t.pes(t.videoPid, 0xE0, i * 3000, i * 3000, Buffer.concat([
        i === 0 ? nal(3, 7, spsPayload({ width: 320, height: 176, crop: [1, 1, 2, 2] })) : Buffer.alloc(0),
        nal(3, 8, ppsPayload()),
        nal(i === 0 ? 3 : 0, i === 0 ? 5 : 1, slicePayload(2, 0, 25, rng)),
      ]), { pcrBase: i * 3000 });
    }
    for (let a = 0; a < 4; a++) {
      t.pes(t.audioPid, 0xC0, a * 1800, null, adtsFrame(3, 1, rng.bytes(80)));
    }
    // the pids the pmt rejected still arrive on the wire
    t.pes(300, 0xE1, 0, 0, Buffer.from([0x00, 0x00, 0x01, 0x60, 1, 2, 3, 4]));
    t.pes(301, 0xE2, 0, 0, Buffer.from([0x00, 0x00, 0x01, 0x61, 5, 6, 7, 8]));
    out.push({ name: 'pmt-kinds', segments: t.segments(24) });
  }

  // 7. 96 kHz audio: mp4a writes sampleRate<<16, which overflows 32 bits
  {
    const t = new TsBuilder();
    const rng = makeRng(7);
    t.section(0, t.pat());
    t.pes(t.videoPid, 0xE0, 0, 0, Buffer.concat([
      nal(3, 7, spsPayload({ width: 1920, height: 1088, profile: 100 })),
      nal(3, 8, ppsPayload()),
      nal(3, 5, slicePayload(7, 0, 60, rng)),
    ]), { pcrBase: 0 });
    for (let a = 0; a < 5; a++) {
      t.pes(t.audioPid, 0xC0, Math.round(a * 1024 * 90000 / 96000), null, adtsFrame(0, 6, rng.bytes(150)));
    }
    out.push({ name: 'rate96k', segments: t.segments(28) });
  }

  // 8. mpeg-2 adts first (no asc yet), then aac-lc, then a 9-byte header frame
  {
    const t = new TsBuilder();
    const rng = makeRng(8);
    t.section(0, t.pat());
    t.pes(t.videoPid, 0xE0, 0, 0, Buffer.concat([
      nal(3, 7, spsPayload({ width: 320, height: 176 })),
      nal(3, 5, slicePayload(7, 0, 30, rng)),
    ]), { pcrBase: 0 });
    t.pes(t.audioPid, 0xC0, 0, null, adtsFrame(4, 2, rng.bytes(100), { mpeg2: true }));
    t.pes(t.audioPid, 0xC0, 2088, null, adtsFrame(5, 2, rng.bytes(100)));
    t.pes(t.audioPid, 0xC0, 4176, null, adtsFrame(5, 2, rng.bytes(100), { protection: false }));
    out.push({ name: 'adts-variants', segments: t.segments(22) });
  }

  // 9. audio only, and video only: the muxer drops the audio track without an asc
  {
    const rng = makeRng(9);
    const audioOnly = new TsBuilder();
    audioOnly.section(0, audioOnly.pat());
    for (let a = 0; a < 4; a++) {
      audioOnly.pes(audioOnly.audioPid, 0xC0, a * 2088, null, adtsFrame(4, 2, rng.bytes(90)));
    }
    out.push({ name: 'audio-only', segments: audioOnly.segments(20) });

    const noAudio = new TsBuilder();
    noAudio.section(0, noAudio.pat());
    for (let i = 0; i < 3; i++) {
      noAudio.pes(noAudio.videoPid, 0xE0, i * 3600, i * 3600, Buffer.concat([
        i === 0 ? nal(3, 7, spsPayload({ width: 320, height: 176 })) : Buffer.alloc(0),
        nal(i === 0 ? 3 : 0, i === 0 ? 5 : 1, slicePayload(2, 0, 16, rng)),
      ]), { pcrBase: i * 3600 });
    }
    out.push({ name: 'video-only', segments: noAudio.segments(20) });
  }

  // 10. broken transport: garbage before the first sync byte, continuity jumps, a
  //     transport error, scrambled payload, a truncated pes, a teletext stream id,
  //     a null packet and an adaptation-only packet
  {
    const t = new TsBuilder();
    const rng = makeRng(10);
    t.section(0, t.pat());
    t.section(t.pmtPid, t.pmt([{ type: 0x1B, pid: t.videoPid }, { type: 0x0F, pid: t.audioPid }]));
    t.pes(t.videoPid, 0xE0, 0, 0, Buffer.concat([
      nal(3, 7, spsPayload({ width: 320, height: 176 })),
      nal(3, 5, slicePayload(7, 0, 20, rng)),
    ]), { pcrBase: 0 });
    // continuity jumps forward by five on the next packet
    t.pes(t.videoPid, 0xE0, 3000, 3000, slicePayload(2, 0, 20, rng), { ccOffset: 5 });
    // transport error flag set on a whole pes
    {
      const before = t.packets.length;
      t.pes(t.audioPid, 0xC0, 0, null, adtsFrame(4, 2, rng.bytes(60)));
      t.packets[before] = poke(t.packets[before], 1, (b) => b | 0x80);
    }
    // scrambling value 0x03 is reserved, so the reader drops this packet outright
    t.pes(t.audioPid, 0xC0, 2088, null, adtsFrame(4, 2, rng.bytes(60)));
    t.packets[t.packets.length - 1] = poke(t.packets[t.packets.length - 1], 3, (b) => (b & 0x3F) | 0xC0);
    // a pes truncated at the end: the reader sees a short header
    t.pes(t.audioPid, 0xC0, 4176, null, adtsFrame(4, 2, rng.bytes(60)), { truncate: 62 });
    // teletext stream id is ignored but must not confuse the pids
    t.pes(305, 0xBD, 0, null, Buffer.from([1, 2, 3, 4, 5, 6]));
    // null packet and an adaptation-only packet
    t.raw(packet(0x1FFF, { payload: Buffer.alloc(PKT - 4, 0xFF), cc: 0 }));
    t.raw(packet(t.audioPid, { pusi: false, af: Buffer.from([0x10]), cc: t.nextCc(t.audioPid) }));
    for (let a = 0; a < 3; a++) {
      t.pes(t.audioPid, 0xC0, (a + 3) * 2088, null, adtsFrame(4, 2, rng.bytes(70)));
    }
    const segs = t.segments(21);
    // the demuxer has to resync its way into a buffer that starts mid-packet
    segs[0] = Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6, 7]), segs[0]]);
    out.push({ name: 'broken', segments: segs });
  }

  // 11. a segment that carries nothing the muxer can use
  {
    const t = new TsBuilder();
    t.section(0, t.pat());
    t.raw(packet(0x1FFF, { payload: Buffer.alloc(PKT - 4, 0xFF), cc: 0 }));
    out.push({ name: 'empty', segments: t.segments(20) });
  }

  return out;
}
