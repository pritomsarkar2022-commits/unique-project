import crypto from 'node:crypto';
import { oracleRun, phpAvailable, Diff, makeRng } from './harness.mjs';
import { BuildStore, buildId, buildSign, roundTo, urlencodePhp } from '../site/src/build/buildStore.mjs';
import { JobStore, encodeSource, decodeSource, jobId, jobSign, registrable } from '../site/src/job/jobStore.mjs';
import { Throttle, bucketDecision, bucketKey, validateIp } from '../site/src/net/throttle.mjs';

/**
 * Differential probes for the persistence layer: every pure piece of JobStore,
 * BuildStore and Throttle, run against the php original.
 *
 * Byte strings travel as base64 in both directions. The probe file is utf-8 json,
 * so a bare \xC3 would be re-encoded on the way in, and this port models a php
 * string as one javascript char per byte: base64 is the only lossless carrier.
 */

if (!phpAvailable()) {
  console.log('SKIPPED: no PHP binary, so nothing was compared. Set PHP_BIN to the reference build.');
  process.exit(3);
}

const toB64 = (s) => Buffer.from(String(s), 'latin1').toString('base64');
const fromB64 = (s) => Buffer.from(String(s), 'base64').toString('latin1');
/** A readable utf-8 literal written the way the port holds it: one char per byte. */
const bytes = (utf8) => Buffer.from(utf8, 'utf8').toString('latin1');

const d = new Diff();
const probes = [];
const checks = [];

function probe(id, fn, args, check) {
  probes.push({ id, fn, args });
  checks.push({ id, fn, args, check });
}

/* ------------------------------------------------------------------ fileName */

const titles = [
  '', ' ', '   ', 'My  Video: Part 2', 'Big Buck Bunny 4K', 'a', '0', '0.0',
  '!!!***???', '???', '---', '--- ---', '-.-.-', '...', '.mp4', 'x.mp4',
  '  spaced  ', 'tab\there', 'new\nline', 'feed\fhere', 'vtab\u000Bhere', 'cr\there',
  'null\u0000byte', 'a.b_c-d 1', 'a  b   c', 'Episode 12: "The Sequel"', "it's / done",
  '100% real', '50% off - new!', 'a\tb c\nd', 'M&M\'s', '[]{}()<>', 'email@site.com',
  'file??a=1&b=2', 'one  two  three  four  five  six  seven  eight  nine  ten',
  'x'.repeat(79), 'x'.repeat(80), 'x'.repeat(81), 'x'.repeat(82), 'x'.repeat(200),
  ' '.repeat(90), 'x'.repeat(100) + '   ', 'a'.repeat(40) + ' ' + 'b'.repeat(41),
  bytes('café'), bytes('café ✓ 日本'), bytes('日本語'), bytes('Ünïcödé Tëst'),
  bytes('emoji 🍿 popcorn'), bytes('¾ cup'), bytes('»quote«'),
  'a\xC3\xA9 b', '\xC3', '\x80\x81\xFF', 'plain \x7F del',
  bytes('Кринж 2026'), bytes('تحميل'), bytes('video — part 2'),
];
const providers = ['', 'video', 'generic', 'cloudfam', 'mxdrop', 'a'.repeat(90), bytes('café'), 'p q', 'p-q_r.s', '0', '!bad!'];
for (const [ti, t] of titles.entries()) {
  for (const [pi, p] of providers.entries()) {
    probe(`fn|${ti}|${pi}`, 'file_name', [toB64(t), toB64(p)], (js, php) => d.same(
      `fileName(${JSON.stringify(t.slice(0, 28))}, ${JSON.stringify(p.slice(0, 18))})`, js, fromB64(php)));
  }
}
// Every single ascii byte in the middle of an otherwise clean title.
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  probe('fnc|' + c, 'file_name', [toB64('a' + ch + 'b'), toB64('p')], (js, php) => d.same(
    `fileName(a${c}b)`, js, fromB64(php)));
}
// A random byte soup, to catch a class the fixtures did not think of.
const rnd = makeRng(20261103);
for (let i = 0; i < 300; i++) {
  const len = rnd.int(0, 40);
  let title = '';
  for (let j = 0; j < len; j++) {
    title += String.fromCharCode(rnd.pick([rnd.int(32, 126), rnd.int(0, 31), rnd.int(127, 255)]));
  }
  const provider = rnd.pick(['', 'video', 'site', 'a'.repeat(90), 'spaced name']);
  probe('fnr|' + i, 'file_name', [toB64(title), toB64(provider)], (js, php) => d.same(
    `fileName(${JSON.stringify(title)})`, js, fromB64(php)));
}

/* ------------------------------------------------------------------ ids and signatures */

const secrets = [
  '0123456789abcdef0123456789abcdef',
  'deadbeefdeadbeefdeadbeefdeadbeef',
  '', 'a', 'short', bytes('éééé'), '0',
];
const pages = [
  'https://cloudfam.io/v/abc123', 'https://x/', '', 'https://x/v/a?b=1&c=2#frag',
  bytes('https://x/ünïcode/p'), 'https://x/a b', 'http://[::1]:8080/v', 'x'.repeat(300),
];
// The secret is a key, not a url: an é in it has to reach php as the one byte 0xE9
// the javascript string holds, so it travels base64 like every other byte string.
for (const [pi, page] of pages.entries()) {
  for (const [si, sec] of secrets.entries()) {
    probe(`ji|${pi}|${si}`, 'job_id', [toB64(page), toB64(sec)], (js, php) => d.same(`jobId(${page}, ${si})`, js, php));
    probe(`js|${pi}|${si}`, 'job_sign', [toB64(page), toB64(sec)], (js, php) => d.same(`jobSign(${page}, ${si})`, js, php));
    probe(`bi|${pi}|${si}`, 'build_id', [toB64(page), toB64(sec)], (js, php) => d.same(`buildId(${page}, ${si})`, js, php));
  }
}
const ids = ['abcdef0123456789abcd', '', 'A'.repeat(20), bytes('éé'), 'x'.repeat(200)];
for (const [ii, id] of ids.entries()) {
  for (const [si, sec] of secrets.entries()) {
    probe(`bs|${ii}|${si}`, 'build_sign', [toB64(id), toB64(sec)], (js, php) => d.same(`buildSign(${id}, ${si})`, js, php));
  }
}

/* ------------------------------------------------------------------ throttle bucket */

const prevs = [null, {}, { start: 5000, hits: 0 }, { start: 5000, hits: 11 }, { start: 5000, hits: 12 },
  { start: 5000, hits: 99 }, { start: 5060, hits: 3 }, { start: 5061, hits: 3 }, { hits: 4 }, { start: 0, hits: 0 }];
const times = [4999, 5000, 5001, 5030, 5059, 5060, 5061, 9000, 1_000_000];
const limits = [0, 1, 2, 12, 100];
const windows = [0, 1, 2, 60, 3600];
/** The oracle carries the stored bucket out base64, so it has to be opened before the compare. */
const openBucket = (php) => ({ ...php, stored: fromB64(php.stored) });
for (const [vi, prev] of prevs.entries()) {
  for (const [ti, now] of times.entries()) {
    for (const [li, limit] of limits.entries()) {
      const wi = (vi + ti + li) % windows.length;
      probe(`bk|${vi}|${ti}|${li}|${wi}`, 'bucket', [prev, now, limit, windows[wi]], (js, php) => d.same(
        `bucket(${JSON.stringify(prev)}, ${now}, ${limit}, ${windows[wi]})`, js, openBucket(php)));
    }
  }
}
for (const [wi, window] of windows.entries()) {
  for (const [li, limit] of limits.entries()) {
    probe(`bk2|${wi}|${li}`, 'bucket', [{ start: 5000, hits: limit }, 5000, limit, window], (js, php) => d.same(
      `bucket(full ${window}s window, limit ${limit})`, js, openBucket(php)));
  }
}

/* ------------------------------------------------------------------ sha1 keys, ips, urlencode */

const keys = ['analyze:1.2.3.4', 'file:abcdef0123456789abcd', '', 'x', bytes('é\u0000'), 'a,b,c', 'ip:5.6.7.8'];
for (const [ki, k] of keys.entries()) {
  probe(`sh|${ki}`, 'sha1', [toB64(k)], (js, php) => d.same(`sha1(${JSON.stringify(k)})`, js, php));
}

const ips = ['127.0.0.1', '203.0.113.9', '0.0.0.0', '255.255.255.255', '1.2.3.4', '01.2.3.4', '1.2.3.04',
  '1.2.3', '1.2.3.4.', '1.2.3.4.5', '999.1.1.1', '1.2.3.256', '1.2.3.4 ', ' 1.2.3.4', '1.2.3.4\n', '1.2.3.4\t',
  '', ' ', '+1.2.3.4', '-1.2.3.4', '0x7f000001', '2130706433', '1.2.3.4:80', '::1', '::', '::0', '1::',
  'fe80::', '2001:db8::1', '2001:DB8::1', 'g::1', '1:2', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9',
  '1:2:3:4:5:6:1.2.3.4', '1:2:3:4:5:6:7:1.2.3.4', '::ffff:1.2.3.4', '::ffff:0102:0304', '::ffff:999.1.1.1',
  '0:0:0:0:0:0:0:0', '0:0:0:0:0:0:0:0:0', 'fe80::1%eth0', 'fe80::1%', '%', '::1 ', '  ::1', '2001:db8::1::2',
  bytes('é'), 'unix:socket', 'localhost'];
for (const [i, ip] of ips.entries()) {
  probe(`ip|${i}`, 'ip', [toB64(ip)], (js, php) => d.same(`filter_var(${JSON.stringify(ip)})`, js, php));
}
for (let i = 0; i < 80; i++) {
  const junk = rnd.bytes(rnd.int(0, 12)).toString('latin1');
  probe('ipf|' + i, 'ip', [toB64(junk)], (js, php) => d.same('filter_var(fuzz ' + i + ')', js, php));
}

const names = ['My-Title.mp4', 'a b~c_d.e%f/g.mp4', '', 'é', '100%', 'a+b', '&x=1', '\n\t', 'x'.repeat(90),
  bytes('emoji 🍿.mp4'), 'q?#[]@!$&\'()*+,;='];
for (const [i, n] of names.entries()) {
  probe(`ue|${i}`, 'urlencode', [toB64(n)], (js, php) => d.same(`urlencode(${JSON.stringify(n)})`, js, fromB64(php)));
}
for (let c = 0; c < 256; c++) {
  probe('uec|' + c, 'urlencode', [toB64('a' + String.fromCharCode(c) + 'b')], (js, php) => d.same(
    'urlencode(byte ' + c + ')', js, fromB64(php)));
}

/* ------------------------------------------------------------------ round($duration, 2) */

const durations = [0, -0, 0.1, 0.145, 0.155, 1.005, 2.675, -2.675, -0.145, 61.239999999999995, 883.555,
  12.344999, 12.345001, 0.5, 1.5, 2.5, -0.5, -1.5, 1 / 3, 1e-9, 0.0149999, 1234567890.1234, 9007199254740991,
  1e21, 3600, 59.94, 0.25, 0.75, 1.0000000001, 2.9999999999, -0.000001,
  // php gives up rounding above about 1e15 and hands the value back. These are the
  // measurements that found the cut, kept as probes so the port cannot drift past it.
  562949953421312.5, 999999999999999.5, 1125899906842623.5, 1125899906842624.5, 1200000000000000.5,
  4503599627370495.5, 90071992547409.9, 450359962737049.5625, -1e21, 1e14];
for (const [i, v] of durations.entries()) {
  probe(`r2|${i}`, 'round2', [v], (js, php) => d.same(`round(${v}, 2)`, js, php));
}
for (let i = 0; i < 200; i++) {
  const v = (rnd.int(-1_000_000, 1_000_000) * 1000 + rnd.int(0, 999)) / 100000;
  probe('r2f|' + i, 'round2', [v], (js, php) => d.same('round(' + v + ', 2)', js, php));
}

/* ------------------------------------------------------------------ registrable(host) */

const hosts = ['', '.', '..', 'example.com', 'www.example.com', 'a.b.c.d.e.com', 'x.co.uk', 'site.co.uk',
  'sub.site.co.uk', 'com.uk', 'co.com', 'a.ac.uk', 'mil.co', 'ne.jp', 'or.kr', 'go.id', 'lg.jp',
  'EXAMPLE.COM', 'Example.Com.', '.example.com.', 'localhost', 'a', 'a.b', 'xn--bcher-kva.de', 'a-b.site.com',
  '1.2.3.4', 'a.b.c', 'too.many.tails.co.uk', 'zz.com', 'z.uk', 'qq2.co', 'a.hi.b'];
for (const [i, h] of hosts.entries()) {
  probe(`rg|${i}`, 'registrable', [toB64(h)], (js, php) => d.same(`registrable(${JSON.stringify(h)})`, js, fromB64(php)));
}
for (let i = 0; i < 60; i++) {
  const parts = [];
  const n = rnd.int(1, 5);
  for (let j = 0; j < n; j++) {
    parts.push(rnd.pick(['a', 'co', 'com', 'net', 'org', 'xx', 'ab', 'gov', 'ac', '1', 'mxdrop']));
  }
  const h = parts.join('.');
  probe('rgf|' + i, 'registrable', [toB64(h)], (js, php) => d.same(`registrable(${h})`, js, fromB64(php)));
}

/* ------------------------------------------------------------------ Source encode/decode */

/** Property sets are ascii: a non-ascii value would make php's json_decode reject the probe. */
const sourceProps = [
  {},
  { label: 'MP4 file', height: 2160, bitrate: 8000, sizeBytes: 123456789, mime: 'video/mp4' },
  { headers: { Referer: 'https://x/', Cookie: 'sess=abc; pl=1' } },
  { headers: {} },
  { tokenExpiresAt: 1893456000, needsProxy: false },
  { variants: [{ height: 1080, bandwidth: 4000000, codecs: 'avc1.640028', url: 'https://cdn/v.m3u8' }, { height: null }] },
  { duration: 61.24, note: 'slow host' },
  { keyUri: 'https://cdn/key.bin', keyMethod: 'AES-128' },
  { score: 0, id: '' },
  { label: null, height: null, bitrate: null, sizeBytes: null, mime: null, note: null },
  { duration: 0, needsProxy: true, score: 99 },
];
const kinds = ['mp4', 'hls', 'ts', 'webm', 'mkv', '', 'unknown'];
/**
 * The source probes return a json string from node and base64 json from php, because
 * the property order encode() emits is part of the contract: a job record this port
 * writes has to read like one php wrote. So compare the two serialisations as text —
 * Diff::same would sort the keys and lose exactly that.
 *
 * One deliberate fold, applied to both sides: php's json_encode spells an empty map
 * [] where JSON.stringify spells {}, and a source with no request headers carries
 * exactly one empty map. Nothing reads the shape back (this port decodes its own
 * records, and app.js never looks at headers), so the harness folds that one spelling
 * instead of teaching the port to emit a javascript array it would then have to
 * convert again on the way in.
 */
const show = (s) => {
  const t = String(s);
  return t.length > 160 ? t.slice(0, 160) + '...' : t;
};
const foldEmptyMap = (s) => s.replaceAll('"headers":[]', '"headers":{}');
const sameJson = (label, js, php) => d.ok(label, foldEmptyMap(js) === foldEmptyMap(fromB64(php)),
  `js=${show(foldEmptyMap(js))} php=${show(foldEmptyMap(fromB64(php)))}`);
for (const [pi, props] of sourceProps.entries()) {
  for (const [ki, kind] of kinds.entries()) {
    const url = 'https://cdn.x.test/f/' + pi + '-' + ki + '.bin?a=1&b=2';
    const rec = { url, kind, ...props };
    probe(`se|${pi}|${ki}`, 'source_encode', [toB64(url), toB64(kind), toB64(JSON.stringify(rec))], (js, php) => sameJson(
      `encode(source ${pi}/${ki})`, js, php));
    // decode(): the same record read back, and a record carrying a key the class does not declare.
    probe(`sd|${pi}|${ki}`, 'source_decode', [toB64(JSON.stringify(rec))], (js, php) => sameJson(
      `decode(record ${pi}/${ki})`, js, php));
    const smuggled = { ...rec, evil: 'x', proto: 1 };
    probe(`sx|${pi}|${ki}`, 'source_decode', [toB64(JSON.stringify(smuggled))], (js, php) => sameJson(
      `decode(record with unknown keys ${pi}/${ki})`, js, php));
    const noKind = { ...rec };
    delete noKind.kind;
    probe(`sk|${pi}|${ki}`, 'source_decode', [toB64(JSON.stringify(noKind))], (js, php) => sameJson(
      `decode(record without kind ${pi}/${ki})`, js, php));
  }
}

/* ------------------------------------------------------------------ record json shape */

// json_encode($record, JSON_UNESCAPED_SLASHES) against JSON.stringify: unescaped
// slashes, and php's \u escapes for the one non-ascii value that survives the trip.
const records = [
  { u: 'https://cdn.x.test/a/b?c=1&d=2', s: 'plain', n: 12.5 },
  { 'id': 'abcdef0123456789abcd', 'secret': 'x', 'title': 'a "quoted" \\ back' },
  { empty: '', zero: 0, false: false, null: null },
  { list: [1, 'two', { three: 3 }], nested: { a: [1, 2] } },
  { tabs: 'a\tb\nc', del: 'ab' },
  { slash: 'a/b/c', quote: 'it\'s' },
];
for (const [i, rec] of records.entries()) {
  probe(`rj|${i}`, 'record_json', [toB64(JSON.stringify(rec))], (js, php) => d.same(
    `json_encode(record ${i})`, JSON.stringify(rec), fromB64(php)));
}

/* ------------------------------------------------------------------ run and compare */

const results = oracleRun(probes, 'oracle-stores.php');

function callJs(fn, args) {
  switch (fn) {
    case 'file_name': return BuildStore.fileName(fromB64(args[0]), fromB64(args[1]));
    case 'job_id': return jobId(fromB64(args[0]), fromB64(args[1]));
    case 'job_sign': return jobSign(fromB64(args[1]), fromB64(args[0]));
    case 'build_id': return buildId(fromB64(args[0]), fromB64(args[1]));
    case 'build_sign': return buildSign(fromB64(args[1]), fromB64(args[0]));
    case 'bucket': {
      const r = bucketDecision(args[0], args[1], args[2], args[3]);
      return {
        allowed: r.allowed,
        retryAfter: r.retryAfter,
        start: r.bucket.start,
        hits: r.bucket.hits,
        stored: JSON.stringify(r.bucket),
      };
    }
    case 'sha1': return bucketKey(fromB64(args[0]));
    case 'ip': return validateIp(fromB64(args[0])) !== false;
    case 'urlencode': return urlencodePhp(fromB64(args[0]));
    case 'round2': return roundTo(args[0], 2);
    case 'registrable': return registrable(fromB64(args[0]));
    case 'record_json': return null; // checked straight against JSON.stringify above
    case 'source_encode': {
      const url = fromB64(args[0]);
      const kind = fromB64(args[1]);
      const props = JSON.parse(fromB64(args[2]));
      return JSON.stringify(encodeSource(decodeSource({ url, kind, ...props })));
    }
    case 'source_decode': return JSON.stringify({ ...decodeSource(JSON.parse(fromB64(args[0]))) });
    default: throw new Error('no js impl for ' + fn);
  }
}

for (const c of checks) {
  const rec = results.get(c.id);
  if (!rec) {
    d.ok('the oracle answered probe ' + c.id, false, 'no line for this id');
    continue;
  }
  let jsValue;
  try {
    jsValue = callJs(c.fn, c.args);
  } catch (err) {
    d.ok('node did not throw for ' + c.fn + ' ' + c.id, false, String(err.message));
    continue;
  }
  if (!rec.ok) {
    d.ok('php failure acknowledged for ' + c.id, false, 'php err=' + rec.err);
    continue;
  }
  c.check(jsValue, rec.res);
}

// The store itself, end to end, on the same secret: node's JobStore must produce
// the id and the signature php's expressions produce for the same page url.
const pinned = { pageUrl: 'https://cloudfam.io/v/abc123', secret: '0123456789abcdef0123456789abcdef' };
const store = new JobStore({});
const rec = { secret: pinned.secret };
d.same('JobStore.sign over a real record', store.sign(rec, pinned.pageUrl),
  results.get(`js|${pages.indexOf(pinned.pageUrl)}|${secrets.indexOf(pinned.secret)}`).res);
const bstore = new BuildStore({});
d.same('BuildStore.sign over a real record', bstore.sign({ id: ids[0], secret: pinned.secret }),
  results.get(`bs|0|${secrets.indexOf(pinned.secret)}`).res);

// Throttle.clientKey is the same lookup with the same validation, so the ip probes
// above are its decision table; the switch itself is covered in stores.test.mjs.

process.exit(d.report('persistence stores differential parity') ? 0 : 1);
