import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixtures } from '../../parity/tsGen.mjs';
import { muxPlaylistToMp4 } from '../src/engine/localMux.mjs';
import { aes128CbcDecrypt, segmentIv } from '../src/engine/aesCbc.mjs';
import { Mp4Mux } from '../src/hls/mp4Mux.mjs';
import { TsStream } from '../src/build/tsStream.mjs';
import { stampTimes, captureParams } from '../src/build/mp4Builder.mjs';

/**
 * The save that runs on the user's device.
 *
 * Two things have to hold. The block cipher written for a browser, which cannot ask
 * for an unpadded CBC decrypt, must answer exactly what node's createDecipheriv answers
 * on the server; and the file a device builds must be the same file the server build
 * would have produced, byte for byte, or the port would have quietly grown a second
 * engine. The streams here are the same deterministic fixtures the engine parity test
 * feeds the php original.
 */

const NOW = 1735689600;
const HOST = 'https://cdn.example.test/';

/** @returns {Buffer} the same ciphertext php's openssl_encrypt of the aligned block run gives */
function encrypt(data, key, iv) {
  const aligned = data.length % 16 === 0 ? data : data.subarray(0, data.length - (data.length % 16));
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(aligned), c.final()]);
}

/** PKCS#7, the padding a stream encrypter puts on a part before it signs the key. */
function pkcs7(bytes) {
  const pad = 16 - (bytes.length % 16);
  return Buffer.concat([bytes, Buffer.alloc(pad, pad)]);
}

/** @returns {[object, Array<{url:string,body:Uint8Array}>]} the build input and what it fetched */
function transport(segments, { key = null, iv = null } = {}) {
  const media = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:0',
    ...(key === null ? [] : ['#EXT-X-KEY:METHOD=AES-128,URI="' + HOST + 'k.bin"' + (iv === null ? '' : ',IV=0x' + iv.toString('hex'))]),
    ...segments.flatMap((_s, i) => ['#EXTINF:4.000,', HOST + 'seg' + i + '.ts']),
    '#EXT-X-ENDLIST',
  ].join('\n');
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=320x176',
    HOST + 'media.m3u8',
  ].join('\n');

  const asked = [];
  const o = {
    manifestUrl: HOST + 'master.m3u8',
    height: null,
    now: NOW,
    async fetchText(url) {
      asked.push(url);
      if (String(url).endsWith('master.m3u8')) {
        return master;
      }
      if (String(url).endsWith('media.m3u8')) {
        return media;
      }
      throw new Error('unexpected text url ' + url);
    },
    async fetchBytes(url) {
      asked.push(url);
      if (String(url) === HOST + 'k.bin') {
        return key;
      }
      const i = Number(/seg(\d+)\.ts$/.exec(String(url))[1]);
      return segments[i];
    },
    write: async () => { },
  };
  return [o, asked];
}

/** node's own unpadded CBC open of the whole blocks of one part. */
function cbcOpen(cipher, key, iv) {
  const aligned = cipher.length % 16 === 0 ? cipher : cipher.subarray(0, cipher.length - (cipher.length % 16));
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(aligned), d.final()]);
}

/** The build the server does: one pass over the same parts, then the moov. */
function serverBuild(segments) {
  const rec = { ts_offset: 0, last_dts: null, last_delta: 3600, params: null, note: null };
  const mux = Mp4Mux.open();
  const stream = new TsStream();
  segments.forEach((bytes) => {
    stream.push(bytes);
    const taken = stream.take();
    stampTimes(rec, taken.video, taken.audio);
    mux.addSegment(taken.video, taken.audio);
    captureParams(rec, stream.avc(), stream.aac());
  });
  const tail = stream.drain();
  stampTimes(rec, tail.video, tail.audio);
  mux.addSegment(tail.video, tail.audio);
  mux.writeMoov({
    width: rec.params.width,
    height: rec.params.height,
    avcC: Buffer.from(String(rec.params.avcC), 'hex'),
    asc: Buffer.from(String(rec.params.asc), 'hex'),
    sampleRate: rec.params.sampleRate,
    channels: rec.params.channels,
  }, NOW);
  return mux.toBuffer();
}

test('the browser block cipher answers exactly what the server one answers', () => {
  const key = Buffer.from('0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex');
  for (const size of [16, 1600, 4704, 6000, 7520]) {
    const data = Buffer.alloc(size);
    crypto.randomFillSync(data);
    for (const iv of [Buffer.alloc(16), Buffer.from('00000000000000000000000000000001', 'hex')]) {
      const cipher = encrypt(data, key, iv);
      assert.deepEqual(
        [...aes128CbcDecrypt(key, iv, cipher)],
        [...cbcOpen(cipher, key, iv)],
        'a ' + size + ' byte run with iv ' + iv.toString('hex'),
      );
    }
  }
});

test('a part that ends mid-block loses that tail, on both engines', () => {
  const key = Buffer.from('0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex');
  const iv = Buffer.alloc(16);
  const cipher = Buffer.concat([encrypt(Buffer.alloc(64, 7), key, iv), Buffer.from([1, 2, 3, 4, 5])]);
  assert.equal(aes128CbcDecrypt(key, iv, cipher).length, 64, 'the five stray bytes are dropped');
  assert.equal(cbcOpen(cipher, key, iv).length, 64);
});

test('the default iv is the media sequence number, the way the server builds it', () => {
  assert.equal(Buffer.from(segmentIv('', 0)).toString('hex'), '00000000000000000000000000000000');
  assert.equal(Buffer.from(segmentIv('', 1)).toString('hex'), '00000000000000000000000000000001');
  assert.equal(Buffer.from(segmentIv('', 4294967295)).toString('hex'), '000000000000000000000000ffffffff');
  assert.equal(Buffer.from(segmentIv('0x000102030405060708090a0b0c0d0e0f', 7)).toString('hex'), '000102030405060708090a0b0c0d0e0f');
});

test('a device build of a clear stream is the server build, byte for byte', async () => {
  const segments = fixtures().find((f) => f.name === 'baseline').segments;
  const [o] = transport(segments);
  const chunks = [];
  o.write = async (bytes) => { chunks.push(Buffer.from(bytes)); };
  const done = await muxPlaylistToMp4(o);
  const got = Buffer.concat(chunks);
  const want = serverBuild(segments);
  assert.equal(got.length, want.length, 'the same number of bytes reached the file');
  assert.ok(got.equals(want), 'the first difference is at byte ' + firstByteDiff(got, want));
  assert.equal(done.bytes, want.length);
  assert.equal(done.parts, segments.length);
});

test('a device build of an aes-128 stream matches the server decrypting the same parts', async () => {
  const segments = fixtures().find((f) => f.name === 'bframes').segments;
  const key = Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'hex');
  // A host that encrypts a part pads it to a whole number of blocks, which is why
  // neither engine has anything to drop here.
  const cipher = segments.map((s, i) => encrypt(pkcs7(s), key, segmentIv('', i)));
  const [o] = transport(cipher, { key });
  const chunks = [];
  o.write = async (bytes) => { chunks.push(Buffer.from(bytes)); };
  await muxPlaylistToMp4(o);
  const want = serverBuild(cipher.map((s, i) => cbcOpen(s, key, segmentIv('', i))));
  const got = Buffer.concat(chunks);
  assert.ok(got.equals(want), 'the file the device wrote differs at byte ' + firstByteDiff(got, want));
});

test('a declared iv is honoured part by part, not assumed to be the sequence', async () => {
  const segments = fixtures().find((f) => f.name === 'baseline').segments;
  const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  const iv = Buffer.from('ffffffff00000000ffffffff00000001', 'hex');
  const cipher = segments.map((s) => encrypt(s, key, iv));
  const [o, asked] = transport(cipher, { key, iv });
  const chunks = [];
  o.write = async (bytes) => { chunks.push(Buffer.from(bytes)); };
  await muxPlaylistToMp4(o);
  const want = serverBuild(cipher.map((s) => cbcOpen(s, key, iv)));
  assert.ok(Buffer.concat(chunks).equals(want));
  assert.ok(asked.includes(HOST + 'k.bin'), 'the key file was fetched through the same transport');
});

test('a stream with no end is refused before the first part is pulled', async () => {
  const segments = fixtures().find((f) => f.name === 'baseline').segments;
  const [o] = transport(segments);
  const asked = [];
  o.fetchText = async (url) => {
    asked.push(url);
    return String(url).endsWith('master.m3u8')
      ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=320x176\n' + HOST + 'media.m3u8'
      : '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.000,\n' + HOST + 'seg0.ts';
  };
  o.fetchBytes = async (url) => { asked.push(url); return segments[0]; };
  await assert.rejects(() => muxPlaylistToMp4(o), /no end yet/);
  assert.deepEqual(asked.filter((u) => String(u).includes('seg')), [], 'no part was downloaded');
});

function firstByteDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return a.length === b.length ? -1 : n;
}
