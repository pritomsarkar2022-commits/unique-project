/**
 * Differential test for the media engine: run the same transport stream through the
 * untouched php classes and through the node port, then compare what came out.
 *
 *   node parity/test-engine.mjs
 *
 * php stamps time() into mvhd, tkhd and mdhd, and a port cannot reproduce the second
 * the reference ran, so those eight-byte pairs are masked on both sides. Everything
 * else, including the whole sidecar sample log, has to match exactly.
 */
import { phpAvailable, oracleRun, Diff, makeRng } from './harness.mjs';
import { fixtures } from './tsGen.mjs';
import { TsDemuxer } from '../site/src/hls/tsDemuxer.mjs';
import { TsStream } from '../site/src/build/tsStream.mjs';
import { Mp4Mux } from '../site/src/hls/mp4Mux.mjs';
import { stampTimes, captureParams } from '../site/src/build/mp4Builder.mjs';

if (!phpAvailable()) {
  console.error('SKIPPED: no php binary, so nothing was compared against the reference. Set PHP_BIN.');
  process.exit(3);
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'mvex']);
const TIME_BOXES = new Set(['mvhd', 'tkhd', 'mdhd']);

/** Every box in the file, depth first, with its payload window. */
function walk(data, from, to, out = []) {
  let pos = from;
  while (pos + 8 <= to) {
    const size = data.readUInt32BE(pos);
    const type = data.subarray(pos + 4, pos + 8).toString('latin1');
    if (size < 8 || pos + size > to) {
      break;
    }
    out.push({ type, at: pos, size, payloadAt: pos + 8 });
    if (CONTAINERS.has(type)) {
      walk(data, pos + 8, pos + size, out);
    }
    pos += size;
  }
  return out;
}

/** Zero the creation and modification stamps so the two files can be compared. */
function maskTimes(buf) {
  const copy = Buffer.from(buf);
  for (const box of walk(copy, 0, copy.length)) {
    if (TIME_BOXES.has(box.type)) {
      copy.fill(0, box.payloadAt + 4, box.payloadAt + 12);
    }
  }
  return copy;
}

function firstByteDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `at ${i}: js=${a.subarray(i, i + 12).toString('hex')} php=${b.subarray(i, i + 12).toString('hex')}`;
    }
  }
  return a.length === b.length ? 'identical' : `same prefix, js ${a.length} bytes vs php ${b.length} bytes`;
}

/** php inserts into pid-keyed arrays, so insertion order survives; a javascript object
 *  would sort integer keys and lose it. Compare the oracle's ordered pair lists. */
function mapPairs(m) {
  return [...m].map(([k, v]) => [k, v]);
}

const now = 1700000000;
const diff = new Diff();
const set = fixtures();

// --- the demuxer alone, segment by segment -----------------------------------------
const pesProbes = set.map((f) => ({
  id: 'pes-' + f.name,
  fn: 'pes',
  args: [f.segments.map((s) => s.toString('base64'))],
}));
const pesOut = oracleRun(pesProbes);

for (const f of set) {
  const php = pesOut.get('pes-' + f.name);
  if (!diff.ok(`pes ${f.name}: oracle answered`, php && php.ok, php ? String(php.err) : 'no line')) {
    continue;
  }
  const d = new TsDemuxer();
  const js = [];
  for (const seg of f.segments) {
    const events = [];
    d.demux(seg, (pid, kind, pts, dts, body) => events.push([pid, kind, pts, dts, body.toString('base64')]));
    js.push({
      events,
      videoPid: d.videoPid,
      audioPid: d.audioPid,
      pcrPid: d.pcrPid,
      pidKind: mapPairs(d.pidKind),
      skipped: mapPairs(d.skipped),
      badPackets: d.badPackets,
      pesCount: d.pesCount,
    });
  }
  // php only appends the key when flush() actually emitted, so an empty tail has none.
  const flushed = [];
  d.flush((pid, kind, pts, dts, body) => flushed.push([pid, kind, pts, dts, body.toString('base64')]));
  if (flushed.length > 0 && js.length > 0) {
    js[js.length - 1].flushed = flushed;
  }
  diff.same(`pes ${f.name}`, js, php.res);
}

// --- the whole pipeline ------------------------------------------------------------
// Every fixture is built twice over: once in one go, and once cut into ticks at every
// boundary. A tick is what the app really is on a stateless host — the mux closes, its
// bytes and its sample log go through storage, the next request adopts them and starts
// from a fresh demuxer — and php reaches the same file by reopening the same path in
// append mode. Only the cut can show whether the port kept the log across it.
const PKT = 188;

/** Re-cut the same packets into `parts` segments: the media is unchanged, only where a
 *  part ends moves, which is exactly the variable a resume has to survive. */
function resplit(segments, parts) {
  const packets = [];
  for (const s of segments) {
    for (let i = 0; i + PKT <= s.length; i += PKT) {
      packets.push(s.subarray(i, i + PKT));
    }
  }
  if (packets.length < 2) {
    return segments;
  }
  const per = Math.max(1, Math.ceil(packets.length / Math.min(parts, packets.length)));
  const out = [];
  for (let i = 0; i < packets.length; i += per) {
    out.push(Buffer.concat(packets.slice(i, i + per)));
  }
  return out;
}

const engineProbes = [];
for (const f of set) {
  const b64 = f.segments.map((s) => s.toString('base64'));
  engineProbes.push({ id: 'engine-' + f.name, fn: 'engine', args: [{ segments: b64 }], fixture: f });
  const many = resplit(f.segments, 5);
  if (many.length > 1) {
    const parts = many.map((s) => s.toString('base64'));
    const label = `engine-${f.name}x${many.length}`;
    engineProbes.push({ id: label, fn: 'engine', args: [{ segments: parts }], fixture: { segments: many } });
    for (let cut = 1; cut < many.length; cut++) {
      engineProbes.push({
        id: `${label}@${cut}`,
        fn: 'engine',
        args: [{ segments: parts, resume_after: cut }],
        fixture: { segments: many },
      });
    }
  }
}
const engineOut = oracleRun(engineProbes.map(({ fixture, ...probe }) => probe));

/**
 * The one thing the reference cannot do, found by cutting at every boundary:
 * TsDemuxer::packet() hands emit() `$this->pendingMeta[$pid]` with no `?? []` (its
 * flush() has one), so when a tick begins inside a frame the orphan buffer reaches a
 * `array $meta` parameter as null and strict_types throws before emit() runs — a call
 * site whose argument emit() never reads, verified by grep: pendingMeta has exactly two
 * readers, both of them that argument. php's save therefore dies on a resumed build
 * whose next part starts mid-PES, which is most part boundaries. The port drops the
 * continuation bytes, the same thing emit() does for a buffer without a PES header, and
 * carries on; site/tests/build.test.mjs pins that behaviour from the port's side, and
 * the probe it costs us here is reported rather than quietly dropped.
 */
const PHP_RESUME_CRASH = 'TsDemuxer::emit(): Argument #3 ($meta) must be of type array, null given';
const limited = [];

/** The port's own build: one TsStream per tick, one Mp4Mux carried across the cut. */
function runEngine(segments, resumeAfter = -1) {
  let stream = new TsStream();
  let mux = Mp4Mux.open();
  const rec = { ts_offset: 0, last_dts: null, last_delta: null, params: null, note: null };
  const trace = [];
  let videoTotal = 0;
  let audioTotal = 0;
  let ticks = 1;

  /** What the end of every request does: flush the packets the demuxer still holds. */
  const flushTail = () => {
    const tail = stream.drain();
    if (tail.video.length !== 0 || tail.audio.length !== 0) {
      stampTimes(rec, tail.video, tail.audio);
      mux.addSegment(tail.video, tail.audio);
      videoTotal += tail.video.length;
      audioTotal += tail.audio.length;
      trace.push({
        tail: true,
        video: tail.video.map((u) => [u.data.length, u.pts, u.dts, u.key ? 1 : 0]),
        audio: tail.audio.map((u) => [u.data.length, u.pts]),
      });
    }
  };

  for (let i = 0; i < segments.length; i++) {
    if (i === resumeAfter) {
      flushTail();
      mux = Mp4Mux.adopt(mux.toBuffer(), mux.logBytes());
      stream = new TsStream();
      ticks++;
    }
    stream.push(segments[i]);
    const { video, audio } = stream.take();
    stampTimes(rec, video, audio);
    if (video.length !== 0 || audio.length !== 0) {
      mux.addSegment(video, audio);
    }
    captureParams(rec, stream.avc(), stream.aac());
    videoTotal += video.length;
    audioTotal += audio.length;
    trace.push({
      video: video.map((u) => [u.data.length, u.pts, u.dts, u.key ? 1 : 0]),
      audio: audio.map((u) => [u.data.length, u.pts]),
    });
  }
  flushTail();

  let moovError = null;
  if (rec.params !== null && rec.params !== undefined) {
    try {
      mux.writeMoov({
        width: rec.params.width,
        height: rec.params.height,
        avcC: Buffer.from(rec.params.avcC, 'hex'),
        sampleRate: rec.params.sampleRate,
        channels: rec.params.channels,
        asc: Buffer.from(rec.params.asc, 'hex'),
      }, now);
    } catch (e) {
      moovError = `${e.name}:${e.message}:${e.hint}`;
    }
  }

  return {
    mp4: mux.toBuffer(),
    log: mux.logBytes(),
    moovError,
    params: rec.params,
    note: rec.note,
    clock: { ts_offset: rec.ts_offset, last_dts: rec.last_dts, last_delta: rec.last_delta },
    trace,
    videoTotal,
    audioTotal,
    bytes: mux.bytesWritten(),
    ticks,
    stream,
    mux,
  };
}

for (const probe of engineProbes) {
  const f = probe.fixture;
  const php = engineOut.get(probe.id);
  const cutAt = probe.args[0].resume_after === undefined ? -1 : probe.args[0].resume_after;
  const err = php ? String(php.err) : 'no line';
  if (cutAt > 0 && err.includes(PHP_RESUME_CRASH)) {
    // Nothing to compare: the reference stopped with a fatal on this cut. The port has
    // to do the one thing php cannot there, which is finish, so that is what is checked.
    const js = runEngine(f.segments, cutAt);
    limited.push(probe.id);
    diff.ok(`${probe.id}: the port finishes where php dies`,
      js.moovError === null && js.mp4.length > 0 && js.bytes > 0,
      `moov=${js.moovError} bytes=${js.bytes}`);
    continue;
  }
  if (!diff.ok(`${probe.id}: oracle answered`, php && php.ok, err)) {
    continue;
  }
  const js = runEngine(f.segments, cutAt);
  const jsMp4 = js.mp4;
  const phpMp4 = Buffer.from(php.res.mp4 ?? '', 'base64');
  if (php.res.mp4 === null || phpMp4.length === 0) {
    diff.ok(`${probe.id}: no mp4 either side`, jsMp4.length === 0, `js wrote ${jsMp4.length} bytes`);
  } else {
    const a = maskTimes(jsMp4);
    const b = maskTimes(phpMp4);
    diff.ok(`${probe.id}: mp4 identical (${a.length} bytes)`, a.equals(b), firstByteDiff(a, b));
  }
  diff.ok(`${probe.id}: sample log identical`,
    js.log.equals(Buffer.from(php.res.log ?? '', 'base64')),
    firstByteDiff(js.log, Buffer.from(php.res.log ?? '', 'base64')));

  const stream = js.stream;
  diff.same(`${probe.id}: moov error`, js.moovError ?? null, php.res.moovError);
  diff.same(`${probe.id}: ticks`, js.ticks, php.res.ticks);
  diff.same(`${probe.id}: bytes`, js.bytes, php.res.bytes);
  diff.same(`${probe.id}: params`, js.params, php.res.params);
  diff.same(`${probe.id}: note`, js.note ?? null, php.res.note);
  diff.same(`${probe.id}: clock`, js.clock, {
    ts_offset: php.res.clock.ts_offset, last_dts: php.res.clock.last_dts, last_delta: php.res.clock.last_delta,
  });
  diff.same(`${probe.id}: trace`, js.trace, php.res.trace);
  diff.same(`${probe.id}: sample counts`, [js.videoTotal, js.audioTotal], [php.res.videoSamples, php.res.audioSamples]);
  diff.same(`${probe.id}: avc state`, {
    width: stream.avc().width, height: stream.avc().height,
    samples: stream.avc().samples, keyframes: stream.avc().keyframes,
    spsInfo: stream.avc().spsInfo ?? null,
  }, { ...php.res.avc, spsInfo: php.res.avc.spsInfo ?? null });
  diff.same(`${probe.id}: aac state`, {
    sampleRate: stream.aac().sampleRate, channels: stream.aac().channels,
    objectType: stream.aac().objectType, frames: stream.aac().frames,
    skippedBytes: stream.aac().skippedBytes,
    asc: Buffer.isBuffer(stream.aac().asc) ? stream.aac().asc.toString('base64') : null,
    mp4Friendly: stream.aac().isMp4Friendly(),
  }, php.res.aac);
  diff.same(`${probe.id}: demux state`, {
    videoPid: stream.demuxer().videoPid, audioPid: stream.demuxer().audioPid,
    pcrPid: stream.demuxer().pcrPid, pidKind: mapPairs(stream.demuxer().pidKind),
    skipped: mapPairs(stream.demuxer().skipped), streamType: mapPairs(stream.demuxer().streamType),
    badPackets: stream.demuxer().badPackets, pesCount: stream.demuxer().pesCount,
  }, php.res.demux);
}

// --- the clock repair on its own ---------------------------------------------------
// php's own stamps arrive wrapped 32-bit values from the sample log, so the inputs
// here are the shapes Mp4Builder actually sees: a restart, a long gap and a wrap.
const stampCases = [];
const rng = makeRng(4242);
for (let i = 0; i < 200; i++) {
  const n = rng.int(1, 5);
  const start = rng.pick([0, 30000, 0x7FFFFFF0, 0xFFFFFFF0, 0x1FFFFFE00, 8589934590]);
  const step = rng.pick([1, 3000, 3600, 90000, 1530923]);
  const video = [];
  for (let k = 0; k < n; k++) {
    video.push({ pts: (start + k * step + 3000) % 0x200000000, dts: (start + k * step) % 0x200000000 });
  }
  const audio = [];
  for (let k = 0; k < rng.int(0, 3); k++) {
    audio.push({ pts: (start + k * 2088) % 0x200000000 });
  }
  stampCases.push({
    sample: { video, audio },
    offset: rng.pick([0, 0, 3600, -7200, 8589934592]),
    lastDts: rng.pick([null, (start - step + 0x200000000) % 0x200000000, start, (start + 90000 * 130) % 0x200000000]),
    lastDelta: rng.pick([null, 3600, 1, 90000]),
  });
}
const stampProbes = stampCases.map((c, i) => ({
  id: 'stamp-' + i,
  fn: 'stamp',
  args: [c.sample, c.offset, c.lastDts, c.lastDelta],
}));
const stampOut = oracleRun(stampProbes);
stampCases.forEach((c, i) => {
  const php = stampOut.get('stamp-' + i);
  if (!diff.ok(`stamp ${i}: oracle answered`, php && php.ok, php ? String(php.err) : 'no line')) {
    return;
  }
  const rec = { ts_offset: c.offset, last_dts: c.lastDts, last_delta: c.lastDelta };
  const video = c.sample.video.map((u) => ({ ...u }));
  const audio = c.sample.audio.map((u) => ({ ...u }));
  stampTimes(rec, video, audio);
  diff.same(`stamp ${i}`, {
    video: video.map((u) => [u.pts, u.dts]),
    audio: audio.map((u) => u.pts),
    rec: { ts_offset: rec.ts_offset, last_dts: rec.last_dts, last_delta: rec.last_delta ?? null },
  }, { ...php.res, rec: { ts_offset: php.res.rec.ts_offset, last_dts: php.res.rec.last_dts, last_delta: php.res.rec.last_delta } });
});

// --- mux primitives fed straight with wrapped clocks -------------------------------
// A fixture cannot reach some of these: they are the sample-log decoding and box
// packing paths that only a wrapped, duplicated or empty timeline exercises.
const PARAMS = { width: 128, height: 96, avcC: '0142001e', sampleRate: 44100, channels: 2, asc: '1210' };
const edgeCases = [
  { name: 'wrapped-dts', video: [[0xFFFFFFF8, 0x00000010], [0x00000100, 0x00000200], [0x00000200, 0x00000300]], audio: [] },
  { name: 'pts-before-dts', video: [[1000, 900], [2000, 1000]], audio: [] },
  { name: 'zero-gap', video: [[5000, 5000], [5000, 5000]], audio: [] },
  { name: 'single', video: [[0, 0]], audio: [[0]] },
  { name: 'audio-pts-run', video: [[0, 0], [3000, 3000]], audio: [[0], [2088], [4176], [6264]] },
  { name: 'no-sync-frames', video: [[0, 0, false], [3000, 3000, false]], audio: [] },
  { name: 'all-sync', video: [[0, 0, true], [3000, 3000, true]], audio: [] },
  { name: 'no-video', video: [], audio: [[0]] },
  { name: 'no-asc', video: [[0, 0]], audio: [[0]], params: { ...PARAMS, asc: '' } },
  { name: 'no-avcc', video: [[0, 0]], audio: [], params: { ...PARAMS, avcC: '' } },
  { name: 'nine-six-k', video: [[0, 0]], audio: [[0], [8437]], params: { ...PARAMS, sampleRate: 96000, channels: 6 } },
  { name: 'many-chunks', video: Array.from({ length: 40 }, (_, i) => [i * 3600, i * 3600 + 3000]), audio: [] },
];
const edgeProbes = edgeCases.map((c) => ({
  id: 'edge-' + c.name,
  fn: 'muxsamples',
  args: [
    {
      video: c.video.map(([dts, pts, key = true]) => ({ dts, pts, key, size: 6 })),
      audio: c.audio.map(([pts]) => ({ pts, size: 4 })),
    },
    { ...PARAMS, ...(c.params ?? {}) },
  ],
}));
const edgeOut = oracleRun(edgeProbes);

for (const c of edgeCases) {
  const php = edgeOut.get('edge-' + c.name);
  if (!diff.ok(`edge ${c.name}: oracle answered`, php && php.ok, php ? String(php.err) : 'no line')) {
    continue;
  }
  const p = { ...PARAMS, ...(c.params ?? {}) };
  const mux = Mp4Mux.open();
  mux.addSegment(
    c.video.map(([dts, pts, key = true]) => ({ data: Buffer.alloc(6, 0x41), dts, pts, key })),
    c.audio.map(([pts]) => ({ data: Buffer.alloc(4, 0x41), pts })),
  );
  let err = null;
  try {
    mux.writeMoov({
      width: p.width,
      height: p.height,
      avcC: Buffer.from(p.avcC, 'hex'),
      sampleRate: p.sampleRate,
      channels: p.channels,
      asc: Buffer.from(p.asc, 'hex'),
    }, now);
  } catch (e) {
    err = `${e.name}:${e.message}:${e.hint}`;
  }
  diff.same(`edge ${c.name}: moov error`, err, php.res.moovError);
  const js = maskTimes(mux.toBuffer());
  const ref = maskTimes(Buffer.from(php.res.mp4 ?? '', 'base64'));
  diff.ok(`edge ${c.name}: mp4 identical (${js.length}/${ref.length})`, js.equals(ref), firstByteDiff(js, ref));
  diff.ok(`edge ${c.name}: sample log identical`,
    mux.logBytes().equals(Buffer.from(php.res.log ?? '', 'base64')),
    firstByteDiff(mux.logBytes(), Buffer.from(php.res.log ?? '', 'base64')));
  diff.same(`edge ${c.name}: bytes written`, mux.bytesWritten(), php.res.bytes);
}

process.exit(diff.report('engine differential parity') ? 0 : 1);
