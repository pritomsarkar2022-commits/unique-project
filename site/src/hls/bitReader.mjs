import { intDiv } from '../supportPure.mjs';

/**
 * MSB-first bit reader with the Exp-Golomb codes H.264 headers use.
 *
 * Port of lib/Hls/BitReader.php. Every accumulator here is built with * and + rather
 * than << and |: php's integers are 64 bit, so (1 << 31) - 1 + rest is a positive
 * number there, while javascript's bitwise operators would fold the same expression
 * to a negative int32 and silently corrupt the parsed picture size.
 */
export class BitReader {
  #data;
  #bit = 0;

  /** @param {Buffer|Uint8Array} data */
  constructor(data) {
    this.#data = data;
  }

  bitsLeft() {
    return this.#data.length * 8 - this.#bit;
  }

  /** Read $n bits as an unsigned integer, or null past the end. */
  u(n) {
    if (n < 0 || this.bitsLeft() < n) {
      return null;
    }
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.#data[Math.floor((this.#bit + i) / 8)];
      value = value * 2 + (((byte >> (7 - ((this.#bit + i) % 8))) & 1));
    }
    this.#bit += n;
    return value;
  }

  /** unsigned Exp-Golomb. */
  ue() {
    let zeros = 0;
    for (;;) {
      const b = this.u(1);
      if (b === null) {
        return null;
      }
      if (b === 1) {
        break;
      }
      zeros++;
      if (zeros > 31) {
        return null; // corrupt stream
      }
    }
    if (zeros === 0) {
      return 0;
    }
    const rest = this.u(zeros);
    return rest === null ? null : Math.pow(2, zeros) - 1 + rest;
  }

  /** signed Exp-Golomb. */
  se() {
    const k = this.ue();
    if (k === null) {
      return null;
    }
    const half = intDiv(k + 1, 2);
    return k % 2 === 0 ? -half : half;
  }
}
