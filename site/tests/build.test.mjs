import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mp4Mux } from '../src/hls/mp4Mux.mjs';

/**
 * The resume contract of the in-memory mux.
 *
 * php appended to two files on disk and opened them again in 'ab' mode, so a build
 * that survived several requests produced one file by construction. Here the partial
 * bytes and their sample log travel through storage between invocations and come back
 * through Mp4Mux.adopt(), so "the same file either way" is a property the port has to
 * earn and a test has to hold.
 */

const NOW = 1735689600; // a fixed creation time, so two moovs are byte-comparable

const params = {
  width: 320,
  height: 180,
  avcC: Buffer.from([1, 100, 0, 0, 3, 0xff, 0xe1]),
  sampleRate: 44100,
  channels: 2,
  asc: Buffer.from([0x12, 0x10]),
};

/** @returns {Array<{data:Buffer,pts:number,dts:number,key:boolean}>} n pictures on a 30 fps clock */
function video(n, at) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const dts = at.dts + i * 3000;
    out.push({
      data: Buffer.alloc(40 + i * 7, (at.seed + i) & 0xff),
      dts,
      pts: dts + 1500,
      key: i === 0,
    });
  }
  return out;
}

/** @returns {Array<{data:Buffer,pts:number}>} n audio frames on a 44.1 kHz clock */
function audio(n, at) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ data: Buffer.alloc(12 + i, (at.seed + i * 3) & 0xff), pts: at.pts + i * 1024 });
  }
  return out;
}

const slices = [
  { video: video(4, { dts: 90000, pts: 91500, seed: 1 }), audio: audio(5, { pts: 88200, seed: 2 }) },
  { video: video(3, { dts: 102000, pts: 103500, seed: 3 }), audio: audio(4, { pts: 93344, seed: 4 }) },
  { video: video(5, { dts: 111000, pts: 112500, seed: 5 }), audio: audio(6, { pts: 97472, seed: 6 }) },
];

test('a build resumed through storage is byte-identical to one that never stopped', () => {
  const oneShot = Mp4Mux.open();
  for (const s of slices) {
    oneShot.addSegment(s.video, s.audio);
  }
  oneShot.writeMoov(params, NOW);

  const firstTick = Mp4Mux.open();
  firstTick.addSegment(slices[0].video, slices[0].audio);
  const secondTick = Mp4Mux.adopt(firstTick.toBuffer(), firstTick.logBytes());
  secondTick.addSegment(slices[1].video, slices[1].audio);
  const thirdTick = Mp4Mux.adopt(secondTick.toBuffer(), secondTick.logBytes());
  thirdTick.addSegment(slices[2].video, slices[2].audio);
  thirdTick.writeMoov(params, NOW);

  assert.equal(thirdTick.bytesWritten(), oneShot.bytesWritten());
  assert.deepEqual(
    [...thirdTick.logBytes()],
    [...oneShot.logBytes()],
    'every sample and chunk record of all three ticks is in the log, not one per tick',
  );
  const got = thirdTick.toBuffer();
  const want = oneShot.toBuffer();
  assert.equal(got.length, want.length, 'the resumed file is the same length');
  assert.ok(got.equals(want), `first differing byte at ${firstByteDiff(got, want)}`);
});

test('adopt keeps every sample of the adopted slice in the moov', () => {
  // The regression this whole file exists for: a log that comes back as one block
  // walked as a single record writes a moov with one sample per track, and the file
  // plays as a fraction of a second instead of failing.
  const first = Mp4Mux.open();
  first.addSegment(slices[0].video, slices[0].audio);
  const resumed = Mp4Mux.adopt(first.toBuffer(), first.logBytes());
  resumed.writeMoov(params, NOW);

  const whole = Mp4Mux.open();
  whole.addSegment(slices[0].video, slices[0].audio);
  whole.writeMoov(params, NOW);

  const sampleCount = (buf) => {
    const at = buf.indexOf(Buffer.from('stsz', 'latin1'));
    // fourcc, then version+flags and sample_size, before the count the probe wants.
    return at === -1 ? null : buf.readUInt32BE(at + 12);
  };
  assert.equal(sampleCount(resumed.toBuffer()), 4, 'four pictures in the video stsz');
  assert.ok(resumed.toBuffer().equals(whole.toBuffer()));
});

test('an empty or missing log resumes an audio-less track, and a torn tail is no record', () => {
  const first = Mp4Mux.open();
  first.addSegment(slices[0].video, slices[0].audio);
  const good = first.logBytes();

  assert.equal(Mp4Mux.adopt(first.toBuffer(), Buffer.alloc(0)).logBytes().length, 0);
  assert.equal(Mp4Mux.adopt(first.toBuffer(), null).logBytes().length, 0);

  const torn = Mp4Mux.adopt(first.toBuffer(), Buffer.concat([good, Buffer.from([1, 1, 9])]));
  torn.addSegment(slices[1].video, slices[1].audio);
  const clean = Mp4Mux.adopt(first.toBuffer(), good);
  clean.addSegment(slices[1].video, slices[1].audio);
  assert.ok(torn.logBytes().equals(clean.logBytes()), 'the three stray bytes are dropped, not parsed');
  assert.ok(torn.toBuffer().equals(clean.toBuffer()));
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
