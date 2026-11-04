import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBuffer } from '../src/engine/browserBuffer.mjs';

/**
 * The Buffer stand-in the device worker installs over the hls engine.
 *
 * Every method it claims is diffed against node's real Buffer on the same inputs, over
 * odd lengths, reads and writes at the very end of a buffer, values at and above 2^31
 * and a 64-bit quantity above 2^32, because those are the edges a hand-rolled shim gets
 * wrong. A disagreement here would mean the file a phone builds is not the file the
 * server builds, which is the whole reason the engine was reused instead of rewritten.
 */

test('from decodes hex, latin1 and utf8 byte for byte, including short and invalid hex', () => {
  for (const s of ['48656c6c6f', '486', 'a', '', '4', 'zz', '4g6', '00112233445566ff7f80', 'ABcd']) {
    assert.deepEqual([...BrowserBuffer.from(s, 'hex')], [...Buffer.from(s, 'hex')], 'hex "' + s + '"');
  }
  for (const s of ['abc', '\u0000\u0001\u0080\u00ff', 'caf\u00e9', '']) {
    assert.deepEqual([...BrowserBuffer.from(s, 'latin1')], [...Buffer.from(s, 'latin1')], 'latin1 length ' + s.length);
  }
  assert.deepEqual([...BrowserBuffer.from('h\u00e9llo \u2713')], [...Buffer.from('h\u00e9llo \u2713')], 'utf8 default');
  assert.equal(BrowserBuffer.from('plain').toString(), 'plain');
  assert.deepEqual([...BrowserBuffer.from([0, 200, 255, 1])], [...Buffer.from([0, 200, 255, 1])], 'byte array');
  const view = Buffer.from('0102030405', 'hex').subarray(1, 4);
  assert.deepEqual([...BrowserBuffer.from(view)], [...Buffer.from(view)], 'a subarray view is copied');
});

test('alloc zeroes and fills, allocUnsafe sizes, isBuffer knows its own', () => {
  assert.deepEqual([...BrowserBuffer.alloc(4)], [...Buffer.alloc(4)]);
  assert.deepEqual([...BrowserBuffer.alloc(3, 7)], [...Buffer.alloc(3, 7)]);
  assert.deepEqual([...BrowserBuffer.alloc(0, 9)], [...Buffer.alloc(0, 9)]);
  assert.equal(BrowserBuffer.allocUnsafe(5).length, 5);
  assert.ok(BrowserBuffer.isBuffer(BrowserBuffer.alloc(1)));
  assert.ok(BrowserBuffer.isBuffer(BrowserBuffer.from('x')));
  assert.ok(!BrowserBuffer.isBuffer(new Uint8Array(1)));
  assert.ok(!BrowserBuffer.isBuffer(Buffer.alloc(1)));
  assert.ok(!BrowserBuffer.isBuffer(null));
});

test('writeUInt32BE, writeUInt16BE and writeBigUInt64LE land on the same bytes and errors', () => {
  for (const value of [0, 1, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) {
    for (const offset of [0, 1, 4]) {
      const b = Buffer.alloc(8);
      const s = BrowserBuffer.alloc(8);
      assert.equal(s.writeUInt32BE(value, offset), b.writeUInt32BE(value, offset), 'writeUInt32BE return ' + value);
      assert.deepEqual([...s], [...b], 'writeUInt32BE ' + value + ' at ' + offset);
    }
  }
  for (const value of [0, 0x7fff, 0x8000, 0xffff]) {
    const b = Buffer.alloc(6);
    const s = BrowserBuffer.alloc(6);
    assert.equal(s.writeUInt16BE(value, 3), b.writeUInt16BE(value, 3), 'writeUInt16BE return');
    assert.deepEqual([...s], [...b], 'writeUInt16BE ' + value);
  }
  for (const value of [0n, 4294967295n, 4294967296n, 0xdeadbeefcafebaben, 2n ** 64n - 1n]) {
    const b = Buffer.alloc(12);
    const s = BrowserBuffer.alloc(12);
    assert.equal(s.writeBigUInt64LE(value, 4), b.writeBigUInt64LE(value, 4), 'writeBigUInt64LE return');
    assert.deepEqual([...s], [...b], 'writeBigUInt64LE ' + value);
  }
  for (const [offset, size] of [[5, 4], [6, 4], [1, 8]]) {
    const b = Buffer.alloc(8);
    const s = BrowserBuffer.alloc(8);
    const fn = size === 4 ? 'writeUInt32BE' : 'writeBigUInt64LE';
    const val = size === 4 ? 1 : 1n;
    assert.throws(() => b[fn](val, offset), RangeError, 'node refuses ' + fn + ' past the end');
    assert.throws(() => s[fn](val, offset), RangeError, 'the shim refuses ' + fn + ' past the end');
  }
});

test('readUInt32BE and readBigUInt64LE read the same numbers and fail at the same edges', () => {
  const bytes = [0x00, 0x00, 0x00, 0x01, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x80, 0x00, 0x00];
  const b = Buffer.from(bytes);
  const s = BrowserBuffer.from(bytes);
  assert.equal(s.readUInt32BE(0), b.readUInt32BE(0));
  assert.equal(s.readUInt32BE(4), b.readUInt32BE(4), 'a value above 2^31 reads unsigned');
  assert.equal(s.readBigUInt64LE(0), b.readBigUInt64LE(0), 'a 64 bit value above 2^32');
  assert.equal(s.readBigUInt64LE(4), b.readBigUInt64LE(4));
  assert.throws(() => b.readUInt32BE(9), RangeError);
  assert.throws(() => s.readUInt32BE(9), RangeError, 'readUInt32BE at the last byte is out of range');
  assert.throws(() => b.readBigUInt64LE(5), RangeError);
  assert.throws(() => s.readBigUInt64LE(5), RangeError, 'readBigUInt64LE a byte short of the end is out of range');
});

test('concat matches node with and without a target length, over odd pieces', () => {
  const list = [Buffer.from('ab', 'latin1'), Buffer.from('cde', 'latin1'), Buffer.from('fghij', 'latin1')];
  for (const total of [undefined, 0, 3, 10, 13]) {
    const got = total === undefined ? BrowserBuffer.concat(list) : BrowserBuffer.concat(list, total);
    const want = total === undefined ? Buffer.concat(list) : Buffer.concat(list, total);
    assert.deepEqual([...got], [...want], 'concat total ' + total);
  }
  assert.deepEqual([...BrowserBuffer.concat([])], [...Buffer.concat([])]);
  assert.deepEqual([...BrowserBuffer.concat([], 4)], [0, 0, 0, 0]);
});

test('slice and subarray are views onto the same bytes, as node Buffer.slice is', () => {
  const b = Buffer.from('0123456789abcdef', 'hex');
  const s = BrowserBuffer.from('0123456789abcdef', 'hex');
  for (const [begin, end] of [[2, 5], [0, 0], [4], [1, 1], [12, 16], [0]]) {
    assert.deepEqual([...s.slice(begin, end)], [...b.slice(begin, end)], 'slice ' + begin + ':' + end);
    assert.deepEqual([...s.subarray(begin, end)], [...b.subarray(begin, end)], 'subarray ' + begin + ':' + end);
  }
  assert.ok(s.slice(2, 5) instanceof BrowserBuffer, 'slice hands back the shim, not a plain array');
  assert.ok(s.subarray(2, 5) instanceof BrowserBuffer, 'subarray hands back the shim');
  s.slice(3, 6)[0] = 0x99;
  b.slice(3, 6)[0] = 0x99;
  assert.equal(s[3], b[3], 'a write through a slice reaches the parent buffer');
});

test('indexOf and equals find and compare the way node does', () => {
  const bytes = [1, 2, 3, 4, 5, 4, 3, 2, 1];
  const b = Buffer.from(bytes);
  const s = BrowserBuffer.from(bytes);
  for (const [needle, from] of [[4, 0], [4, 4], [9, 0], [1, 8], [1, 0]]) {
    assert.equal(s.indexOf(needle, from), b.indexOf(needle, from), 'indexOf byte ' + needle + ' from ' + from);
  }
  const hay = 'hello world';
  assert.equal(
    BrowserBuffer.from(hay, 'latin1').indexOf('world'),
    Buffer.from(hay, 'latin1').indexOf('world'),
  );
  assert.equal(
    BrowserBuffer.from(hay, 'latin1').indexOf('lo', 4),
    Buffer.from(hay, 'latin1').indexOf('lo', 4),
  );
  assert.equal(BrowserBuffer.from(hay, 'latin1').indexOf('z'), -1);
  assert.ok(BrowserBuffer.from('abc').equals(BrowserBuffer.from('abc')));
  assert.ok(!BrowserBuffer.from('abc').equals(BrowserBuffer.from('abd')));
  assert.ok(!BrowserBuffer.from('ab').equals(BrowserBuffer.from('abc')));
});

test('toString renders latin1 and hex for bytes above 0x7f and refuses the rest', () => {
  const bytes = [0x00, 0x41, 0x80, 0xff, 0x7f];
  const b = Buffer.from(bytes);
  const s = BrowserBuffer.from(bytes);
  assert.equal(s.toString('latin1'), b.toString('latin1'));
  assert.equal(s.toString('hex'), b.toString('hex'));
  assert.equal(BrowserBuffer.from(bytes.slice(0, 2)).toString('utf8'), Buffer.from([0x00, 0x41]).toString('utf8'));
  assert.equal(BrowserBuffer.from('h\u00e9llo \u2713').toString('utf8'), 'h\u00e9llo \u2713');
  assert.throws(() => s.toString('base64'), TypeError, 'an unimplemented encoding throws instead of guessing');
  assert.throws(() => BrowserBuffer.from('zz', 'ascii'), TypeError, 'an unimplemented input encoding throws');
});
