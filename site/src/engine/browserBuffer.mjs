/**
 * The slice of node's Buffer that the hls engine actually calls, over a Uint8Array.
 *
 * The engine modules were written against node's Buffer, and the point of running them
 * in the page is that a browser has no 20 MB ceiling on the file it builds. So the
 * worker sets globalThis.Buffer to this before it calls the engine, instead of teaching
 * a dozen parity-proven modules a second byte type. Only the three encodings the engine
 * asks for exist here; anything else throws rather than guessing.
 */

const HEX_VALUE = new Map();
for (let i = 0; i < 16; i++) {
  HEX_VALUE.set('0123456789abcdef'.charCodeAt(i), i);
  HEX_VALUE.set('0123456789ABCDEF'.charCodeAt(i), i);
}
const HEX_PAIR = [];
for (let i = 0; i < 256; i++) {
  HEX_PAIR.push(i.toString(16).padStart(2, '0'));
}
const UTF8_TEXT = new TextDecoder('utf-8');
const UTF8_BYTES = new TextEncoder();

/**
 * The bytes of a string, a byte array or any view over an ArrayBuffer. latin1 and utf8
 * are one-way; hex reads two nibbles at a time and stops at the first pair node's
 * Buffer.from would stop at, so a short string is short bytes.
 */
function bytesOf(value, encoding = 'utf8') {
  if (typeof value === 'string') {
    if (encoding === 'latin1' || encoding === 'binary') {
      const out = new Uint8Array(value.length);
      for (let i = 0; i < value.length; i++) {
        out[i] = value.charCodeAt(i) & 0xFF;
      }
      return out;
    }
    if (encoding === 'utf8' || encoding === 'utf-8') {
      return UTF8_BYTES.encode(value);
    }
    if (encoding !== 'hex') {
      throw new TypeError('browserBuffer only reads latin1, utf8 and hex, not ' + encoding);
    }
    const out = new Uint8Array(Math.floor(value.length / 2));
    for (let i = 0; i < out.length; i++) {
      const hi = HEX_VALUE.get(value.charCodeAt(i * 2));
      const lo = HEX_VALUE.get(value.charCodeAt(i * 2 + 1));
      if (hi === undefined || lo === undefined) {
        return out.subarray(0, i);
      }
      out[i] = hi * 16 + lo;
    }
    return out;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return Uint8Array.from(value);
}

export class BrowserBuffer extends Uint8Array {
  static alloc(size, fill = 0) {
    const b = new BrowserBuffer(size);
    if (fill !== 0) {
      b.fill(fill);
    }
    return b;
  }

  static allocUnsafe(size) {
    return new BrowserBuffer(size);
  }

  static isBuffer(value) {
    return value instanceof BrowserBuffer;
  }

  static from(value, encoding = 'utf8') {
    return new BrowserBuffer(bytesOf(value, typeof value === 'string' ? encoding : 'utf8'));
  }

  static concat(list, totalLength) {
    const parts = [];
    let size = 0;
    for (const part of list) {
      const b = bytesOf(part);
      parts.push(b);
      size += b.length;
    }
    const out = new BrowserBuffer(totalLength === undefined ? size : totalLength);
    let at = 0;
    for (const b of parts) {
      out.set(b.subarray(0, out.length - at), at);
      at = Math.min(at + b.length, out.length);
    }
    return out;
  }

  /** node's Buffer.slice is a window on the same bytes, not a copy like Uint8Array's. */
  slice(begin, end) {
    return this.subarray(begin, end);
  }

  indexOf(value, fromIndex = 0) {
    if (typeof value === 'number') {
      return Uint8Array.prototype.indexOf.call(this, value, fromIndex);
    }
    const needle = bytesOf(value, 'latin1');
    for (let i = Math.max(0, fromIndex); i + needle.length <= this.length; i++) {
      let at = 0;
      while (at < needle.length && this[i + at] === needle[at]) {
        at++;
      }
      if (at === needle.length) {
        return i;
      }
    }
    return -1;
  }

  equals(other) {
    if (this.length !== other.length) {
      return false;
    }
    for (let i = 0; i < this.length; i++) {
      if (this[i] !== other[i]) {
        return false;
      }
    }
    return true;
  }

  /** The reads and writes go through a DataView, which refuses the same ranges node does. */
  #window() {
    return new DataView(this.buffer, this.byteOffset, this.byteLength);
  }

  writeUInt32BE(value, offset = 0) {
    this.#window().setUint32(offset, value);
    return offset + 4;
  }

  writeUInt16BE(value, offset = 0) {
    this.#window().setUint16(offset, value);
    return offset + 2;
  }

  writeBigUInt64LE(value, offset = 0) {
    this.#window().setBigUint64(offset, value, true);
    return offset + 8;
  }

  readUInt32BE(offset = 0) {
    return this.#window().getUint32(offset);
  }

  readBigUInt64LE(offset = 0) {
    return this.#window().getBigUint64(offset, true);
  }

  toString(encoding = 'utf8') {
    if (encoding === 'latin1' || encoding === 'binary') {
      let text = '';
      for (let at = 0; at < this.length; at += 2048) {
        text += String.fromCharCode.apply(null, this.subarray(at, Math.min(at + 2048, this.length)));
      }
      return text;
    }
    if (encoding === 'hex') {
      let text = '';
      for (let at = 0; at < this.length; at++) {
        text += HEX_PAIR[this[at]];
      }
      return text;
    }
    if (encoding === 'utf8' || encoding === 'utf-8') {
      return UTF8_TEXT.decode(this);
    }
    throw new TypeError('browserBuffer only writes latin1, utf8 and hex, not ' + encoding);
  }
}
