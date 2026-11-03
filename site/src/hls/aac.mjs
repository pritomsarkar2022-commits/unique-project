/**
 * AAC in MPEG-TS: ADTS frames in, MP4 payloads out.
 *
 * Port of lib/Hls/Aac.php. TS carries AAC as ADTS, which repeats a header in front of
 * every 1024-sample frame. MP4 wants bare frames plus one AudioSpecificConfig in esds,
 * so headers are stripped and the first one is converted into that config.
 */
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 16000, 12000, 11025, 8000, 7350, 0, 0];

export class Aac {
  static RATES = RATES;

  sampleRate = null;
  channels = null;
  objectType = null;
  asc = null;
  frames = 0;
  skippedBytes = 0;
  /** A frame can be cut in half by a PES packet boundary, so keep the loose end. */
  carry = Buffer.alloc(0);

  /**
   * Feed one audio PES packet.
   *
   * @returns {Array<{data:Buffer,samples:number}>} raw AAC frames
   */
  push(pes) {
    if (this.carry.length !== 0) {
      pes = Buffer.concat([this.carry, pes]);
      this.carry = Buffer.alloc(0);
    }
    const out = [];
    let i = 0;
    const len = pes.length;
    while (i + 7 <= len) {
      if (pes[i] !== 0xFF || ((pes[i + 1] & 0xF6) !== 0xF0)) {
        i++;
        this.skippedBytes++;
        continue;
      }
      const b1 = pes[i + 1];
      const b2 = pes[i + 2];
      const b3 = pes[i + 3];
      const b4 = pes[i + 4];
      const b5 = pes[i + 5];
      // byte1 bit3 is the mpeg *version*: 0 means MPEG-4, 1 means MPEG-2.
      const mpeg4 = (b1 & 0x08) === 0;
      const headerLen = (b1 & 0x01) === 1 ? 7 : 9;
      const frameLen = ((b3 & 0x03) << 11) | (b4 << 3) | ((b5 >> 5) & 0x07);
      if (frameLen < headerLen) {
        i++;
        this.skippedBytes++;
        continue;
      }
      if (i + frameLen > len) {
        if (frameLen <= 8192) {
          this.carry = pes.subarray(i);
        }
        break;
      }
      const profile = b2 >> 6;
      const freqIdx = (b2 >> 2) & 0x0F;
      const chan = ((b2 & 0x01) << 2) | ((b3 >> 6) & 0x03);
      const objectType = mpeg4 ? profile + 1 : profile;
      if (this.asc === null && mpeg4 && freqIdx < RATES.length && RATES[freqIdx] > 0 && chan > 0) {
        this.objectType = objectType;
        this.sampleRate = RATES[freqIdx];
        this.channels = chan;
        this.asc = Aac.audioSpecificConfig(objectType, freqIdx, chan);
      }
      out.push({
        data: pes.subarray(i + headerLen, i + frameLen),
        samples: 1024,
      });
      this.frames++;
      i += frameLen;
    }
    return out;
  }

  /**
   * Two-byte AudioSpecificConfig: 5 bits object type, 4 bits rate index, then
   * 4 bits channel configuration starting at bit 9, which is byte1 bit 3.
   */
  static audioSpecificConfig(objectType, freqIdx, channels) {
    return Buffer.from([(objectType << 3) | (freqIdx >> 1), ((freqIdx & 1) << 7) | (channels << 3)]);
  }

  /** MP4 plays AAC-LC/Main/SSR; anything else should stay a stream file. */
  isMp4Friendly() {
    return this.asc !== null && [1, 2, 3, 4, 6].includes(this.objectType);
  }
}
