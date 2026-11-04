import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openKv, atomicPutGuardAvailable, selectDriver, storageFault, adoptBlobsContext, StorageUnavailable, __testing } from '../src/storage/kv.mjs';
import { JobStore } from '../src/job/jobStore.mjs';
import { BuildStore } from '../src/build/buildStore.mjs';
import { Throttle, bucketDecision, validateIp, bucketKey } from '../src/net/throttle.mjs';
import { Source } from '../src/extractor/source.mjs';
import { MediaBundle } from '../src/extractor/mediaBundle.mjs';
import { config } from '../src/config.mjs';

/**
 * Behaviour tests for the persistence layer, on the filesystem driver and inside a
 * temp directory. No network and no sleeping: the clock and the dice are injected,
 * so a whole rate-limit window is two assignments, not a nap.
 */

let counter = 0;
function tempRoot(t) {
  const dir = path.join(os.tmpdir(), 'vd-stores-' + process.pid + '-' + ++counter);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function kvFor(t, namespace, root = tempRoot(t)) {
  return openKv(namespace, { driver: 'fs', root });
}

/**
 * The port's byte-string model: one javascript char per php byte. A title read off
 * a utf-8 page therefore arrives as the utf-8 BYTES, written here as latin1 chars.
 */
function bytes(utf8) {
  return Buffer.from(utf8, 'utf8').toString('latin1');
}

/** Ages a stored entry's mtime, which is what php's filemtime() reported to the gc. */
async function ageKey(root, namespace, key, atEpochSeconds) {
  const when = new Date(atEpochSeconds * 1000);
  await fs.promises.utimes(path.join(root, namespace, key), when, when);
}

function bundle() {
  const b = new MediaBundle();
  b.provider = 'cloudfam';
  b.title = 'Big Buck Bunny 4K';
  b.thumbnail = 'https://cdn.cloudfam.io/t/01.png';
  b.pageUrl = 'https://cloudfam.io/v/abc123';
  b.finalUrl = 'https://cloudfam.io/v/abc123';
  b.notices = ['The host throttles free downloads.'];
  b.confidence = 0.8;
  const s = Source.make('https://cdn.cloudfam.io/f/abc123.mp4?token=xyz', Source.MP4);
  s.label = 'MP4 file';
  s.height = 2160;
  s.bitrate = 8000;
  s.sizeBytes = 123456789;
  s.mime = 'video/mp4';
  s.headers = { Referer: 'https://cloudfam.io/v/abc123', Cookie: 'sess=abc; pl=1' };
  s.tokenExpiresAt = 1893456000;
  s.needsProxy = true;
  s.duration = 61.24;
  s.note = 'slow host';
  s.variants = [{ height: 1080, bandwidth: 4000000, codecs: 'avc1.640028', url: 'https://cdn/x.m3u8' }];
  s.score = 42;
  b.addSource(s);
  return b;
}

/* ------------------------------------------------------------------ kv driver */

test('the filesystem driver creates its namespace lazily and stores a value', async (t) => {
  const root = tempRoot(t);
  const kv = await openKv('jobs', { driver: 'fs', root });
  assert.equal(fs.existsSync(path.join(root, 'jobs')), false, 'no directory until the first write');
  await kv.put('a.json', '{"x":1}');
  assert.equal(fs.existsSync(path.join(root, 'jobs', 'a.json')), true);
  assert.equal((await kv.get('a.json')).toString('latin1'), '{"x":1}');
  assert.equal(await kv.get('missing.json'), null);
  await kv.del('a.json');
  await kv.del('a.json');
  assert.equal(await kv.get('a.json'), null);
  assert.equal(kv.driver, 'fs');
});

test('a buffer and a latin1 string are the same bytes to the store', async (t) => {
  const kv = await kvFor(t, 'files');
  await kv.put('v.mp4', Buffer.from([0x00, 0xff, 0x80, 0x41]));
  const data = await kv.get('v.mp4');
  assert.deepEqual([...data], [0x00, 0xff, 0x80, 0x41]);
  await kv.put('w.mp4', Buffer.from([0x00, 0xff, 0x80, 0x41]).toString('latin1'));
  assert.deepEqual([...await kv.get('w.mp4')], [...data], 'one javascript char per php byte');
});

test('meta travels with a value and getWithMeta reports the age', async (t) => {
  const kv = await kvFor(t, 'rate');
  assert.equal(await kv.getWithMeta('nope.json'), null);
  await kv.put('b.json', '{"start":1}', { touched: 1234 });
  const withMeta = await kv.getWithMeta('b.json');
  assert.equal(withMeta.data.toString('latin1'), '{"start":1}');
  assert.deepEqual(withMeta.meta, { touched: 1234 });
  assert.ok(Math.abs(withMeta.createdAt - Math.floor(Date.now() / 1000)) < 60, 'createdAt is the mtime');
  await kv.put('b.json', '{"start":2}');
  assert.equal((await kv.getWithMeta('b.json')).meta, null, 'a put without meta clears the sidecar');
});

test('getRange returns the requested slice and the true total', async (t) => {
  const kv = await kvFor(t, 'files');
  const body = Buffer.alloc(1000);
  for (let i = 0; i < body.length; i++) {
    body[i] = i % 251;
  }
  await kv.put('v.mp4', body);
  const first = await kv.getRange('v.mp4', 0, 99);
  assert.equal(first.total, 1000, 'total is the whole object, not the slice');
  assert.equal(first.data.length, 100);
  assert.deepEqual(first.data, body.subarray(0, 100));
  const middle = await kv.getRange('v.mp4', 400, 499);
  assert.deepEqual(middle.data, body.subarray(400, 500));
  assert.equal(middle.total, 1000);
  const clamped = await kv.getRange('v.mp4', 990, 5000);
  assert.deepEqual(clamped.data, body.subarray(990));
  assert.equal(clamped.total, 1000);
  assert.equal(await kv.getRange('gone.mp4', 0, 10), null, 'absent key is null, not an empty range');
  assert.equal((await kv.getRange('v.mp4', 2000, 3000)).data.length, 0);
  assert.equal((await kv.getRange('v.mp4', 0, null)).data.length, 1000, 'an open end reads to the bottom');
});

test('list walks the namespace in order, without sidecars or temporaries', async (t) => {
  const kv = await kvFor(t, 'builds');
  await kv.put('22.json', 'b', { touched: 2 });
  await kv.put('11.json', 'a', { touched: 1 });
  await kv.put('33.mp4', Buffer.from('c'));
  assert.deepEqual((await kv.list('')).map((e) => e.key), ['11.json', '22.json', '33.mp4']);
  assert.deepEqual((await kv.list('1')).map((e) => e.key), ['11.json']);
  assert.deepEqual((await kv.list('zz')).map((e) => e.key), []);
  assert.equal((await kv.list(''))[0].meta.touched, 1);
  assert.equal((await kv.list(''))[2].meta, null);
  const empty = await kvFor(t, 'never-written');
  assert.deepEqual(await empty.list(''), [], 'a namespace nobody wrote in lists as empty');
});

test('unsafe keys are refused instead of escaping the namespace', async (t) => {
  const kv = await kvFor(t, 'jobs');
  for (const bad of ['../escape.json', 'a/b.json', '..', '', '.hidden', 'a\\b']) {
    await assert.rejects(() => kv.get(bad), TypeError, JSON.stringify(bad) + ' must not be a key');
    await assert.rejects(() => kv.put(bad, 'x'), TypeError, JSON.stringify(bad));
    await assert.rejects(() => kv.del(bad), TypeError, JSON.stringify(bad));
    await assert.rejects(() => kv.getRange(bad, 0, 1), TypeError, JSON.stringify(bad));
  }
});

test('a blobs environment without the package still gets a working store', async (t) => {
  const warnings = [];
  const root = tempRoot(t);
  const kv = await openKv('jobs', {
    driver: 'blobs',
    root,
    env: { NETLIFY: '1', VD_STORE: 'blobs' },
    warn: (m) => warnings.push(m),
  });
  assert.equal(kv.driver, 'fs', 'a failed @netlify/blobs import falls back to the filesystem');
  assert.equal(warnings.length, 1, 'and says so once, into the function log');
  await kv.put('x.json', 'ok');
  assert.equal((await kv.get('x.json')).toString('latin1'), 'ok');
  assert.equal(selectDriver({ NETLIFY: '1' }), 'blobs');
  assert.equal(selectDriver({}), 'fs');
  assert.equal(selectDriver({ NETLIFY: '1', VD_STORE: 'fs' }), 'fs');
  assert.equal(selectDriver({ VD_STORE: 'blobs' }), 'blobs');
  assert.equal(atomicPutGuardAvailable({ NETLIFY: '1' }), true);
  assert.equal(atomicPutGuardAvailable({}), false);
});

test('a blobs environment with an unwritable filesystem refuses the fallback', async (t) => {
  // A function's own directory is read-only, so falling back to it does not give a
  // store: it gives a site that renders and then fails every write with an EROFS that
  // looks like a broken video page. The name has to say which half is missing.
  const block = path.join(tempRoot(t), 'unusable');
  fs.writeFileSync(block, 'a file where a directory should be');
  const root = path.join(block, 'storage');
  const warnings = [];
  await assert.rejects(
    openKv('jobs', { driver: 'blobs', root, env: {}, warn: (m) => warnings.push(m) }),
    (err) => {
      assert.ok(err instanceof StorageUnavailable, 'the storage error type, not a bare EROFS');
      assert.match(err.message, /blobs is not usable here/);
      assert.match(err.message, /read-only/, 'and the reason the fallback will not do');
      return true;
    },
  );
  assert.equal(warnings.length, 1, 'the fallback attempt is still logged');
  const faults = storageFault();
  assert.ok(faults !== null && typeof faults.jobs === 'string', '/health can read the same reason back');
});

test('a writable filesystem still falls back', async (t) => {
  // Off the platform this is the normal state: no blobs, a disk that works.
  const kv = await openKv('jobs', { driver: 'blobs', root: tempRoot(t), env: {}, warn: () => {} });
  assert.equal(kv.driver, 'fs');
});

test('adoptBlobsContext hands the invoke event to the sdk', async () => {
  const seen = [];
  const sdk = async () => ({ connectLambda: (event) => seen.push(event) });
  const event = { blobs: 'eyJ1cmwiOiJodHRwczovL2Jsb2JzLmV4YW1wbGUifQ==', headers: { 'x-nf-site-id': 'abc' } };
  assert.equal(await adoptBlobsContext({ event }, sdk), true, 'the credentials on the event are adopted');
  assert.deepEqual(seen, [event]);
  assert.equal(await adoptBlobsContext({}, sdk), false, 'an event with no blobs is left to the environment');
  assert.equal(await adoptBlobsContext({ event: { headers: {} } }, sdk), false);
  assert.equal(await adoptBlobsContext({ event }, async () => { throw new Error('no sdk'); }), false,
    'and a missing sdk is not this function\'s problem to raise');
});

test('an adopted blobs context selects the blobs driver', () => {
  // A function runtime can deliver the event credentials and no NETLIFY flag at all,
  // which is how a deploy ends up on the filesystem it cannot write.
  const key = 'netlifyBlobsContext';
  assert.equal(selectDriver({}), 'fs');
  globalThis[key] = { siteID: 'site-1', token: 'token-1' };
  try {
    assert.equal(selectDriver({}), 'blobs');
    assert.equal(selectDriver({ VD_STORE: 'fs' }), 'fs', 'an operator can still pin the driver');
  } finally {
    delete globalThis[key];
  }
});

test('explicit store credentials reach getStore when the platform gives none', async () => {
  const asked = [];
  const store = fakeBlobsStore();
  await __testing.makeBlobsKv('files', { BLOBS_SITE_ID: 'site-9', BLOBS_TOKEN: 'tok-9' },
    async () => ({ getStore: (options) => { asked.push(options); return store; } }));
  assert.deepEqual(asked[0], { name: 'files', siteID: 'site-9', token: 'tok-9' });
});

/* ------------------------------------------------------------------ blobs driver */

/**
 * A stand-in for the real BlobStore, with the surface @netlify/blobs 11 actually
 * has: get/getWithMetadata/getMetadata/set/list/delete, set() taking {metadata,
 * onlyIfNew} and answering a lost race with {modified:false}. getRange is
 * deliberately absent, because the sdk does not have it at any version, and
 * conditional is off for the pre-10 shape, where set() took only {metadata} and
 * returned undefined, overwriting whatever it was pointed at.
 */
function fakeBlobsStore({ conditional = true } = {}) {
  const data = new Map();
  const stats = { getCalls: 0, headCalls: 0, listCalls: 0 };
  let seq = 0;
  const asArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return {
    stats,
    data,
    async get(key, options) {
      stats.getCalls++;
      const hit = data.get(key);
      if (!hit) {
        return null;
      }
      return options && options.type === 'arrayBuffer' ? asArrayBuffer(hit.buf) : Buffer.from(hit.buf).toString('utf8');
    },
    async getWithMetadata(key, options) {
      const hit = data.get(key);
      if (!hit) {
        return null;
      }
      const payload = options && options.type === 'arrayBuffer' ? asArrayBuffer(hit.buf) : Buffer.from(hit.buf).toString('utf8');
      return { data: payload, metadata: hit.meta, etag: hit.etag };
    },
    async getMetadata(key) {
      stats.headCalls++;
      const hit = data.get(key);
      return hit ? { etag: hit.etag, metadata: hit.meta } : null;
    },
    async set(key, value, options = {}) {
      if (conditional && options.onlyIfNew && data.has(key)) {
        return { modified: false };
      }
      const etag = 'etag' + (++seq);
      data.set(key, {
        buf: value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value), 'latin1'),
        meta: options.metadata ?? null,
        etag,
      });
      return conditional ? { etag, modified: true } : undefined;
    },
    async list(options = {}) {
      stats.listCalls++;
      const prefix = (options && options.prefix) || '';
      return {
        blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: data.get(key).etag })),
        directories: [],
      };
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

function blobsKv(store) {
  return __testing.makeBlobsKv('files', {}, async () => ({ getStore: () => store }));
}

const everyByte = () => {
  const body = Buffer.alloc(512);
  for (let i = 0; i < body.length; i++) {
    body[i] = i % 256;
  }
  return body;
};

test('blobs: bytes round trip through the driver unchanged', async () => {
  const store = fakeBlobsStore();
  const kv = await blobsKv(store);
  assert.equal(kv.driver, 'blobs');
  const body = everyByte();
  await kv.put('v.mp4', body);
  assert.deepEqual(await kv.get('v.mp4'), body, '0x00 to 0xff survive the round trip');
  await kv.put('s.txt', Buffer.from('café', 'latin1'));
  assert.equal((await kv.get('s.txt')).toString('latin1'), 'café');
  assert.equal(await kv.get('gone'), null);
});

test('blobs: metadata round trips without the write stamp, and createdAt is real', async () => {
  const store = fakeBlobsStore();
  const kv = await blobsKv(store);
  await kv.put('b.json', '{"start":1}', { touched: 1234 });
  const withMeta = await kv.getWithMeta('b.json');
  assert.equal(withMeta.data.toString('latin1'), '{"start":1}');
  assert.deepEqual(withMeta.meta, { touched: 1234 }, 'the driver keeps its own clock out of the caller meta');
  assert.ok(Math.abs(withMeta.createdAt - Math.floor(Date.now() / 1000)) < 60,
    'createdAt is the write time: a zero there ages every entry to 1970 and the gc deletes it');
  await kv.put('b.json', '{"start":2}');
  assert.equal((await kv.getWithMeta('b.json')).meta, null, 'a put without meta clears the stored meta');
  assert.equal(await kv.getWithMeta('nope.json'), null);
});

test('blobs: getRange answers exactly what the filesystem driver answers', async (t) => {
  const store = fakeBlobsStore();
  const kv = await blobsKv(store);
  const fsKv = await kvFor(t, 'files-blobs-parity');
  const body = everyByte();
  await kv.put('v.mp4', body);
  await fsKv.put('v.mp4', body);
  for (const [start, end] of [[0, 99], [400, 499], [502, 5000], [900, null], [0, null], [4000, 5000]]) {
    const mine = await kv.getRange('v.mp4', start, end);
    const theirs = await fsKv.getRange('v.mp4', start, end);
    assert.deepEqual(mine.data, theirs.data, JSON.stringify([start, end]));
    assert.equal(mine.total, theirs.total, JSON.stringify([start, end]));
  }
  assert.equal(await kv.getRange('gone.mp4', 0, 10), null, 'absent key is null, not an empty range');
});

test('blobs: the lock is exclusive with conditional writes', async () => {
  const store = fakeBlobsStore();
  const kv = await blobsKv(store);
  assert.equal(await kv.putIfNotExists('lock.json', 'token-one', { taken: 100 }), true);
  assert.equal(await kv.putIfNotExists('lock.json', 'token-two', { taken: 200 }), false,
    'the second taker is told no, the way flock would');
  assert.equal((await kv.get('lock.json')).toString('latin1'), 'token-one', 'and the held value is not overwritten');
  assert.deepEqual((await kv.getWithMeta('lock.json')).meta, { taken: 100 });
});

test('blobs: the lock is still exclusive on an sdk that ignores onlyIfNew', async () => {
  const store = fakeBlobsStore({ conditional: false });
  const kv = await blobsKv(store);
  assert.equal(await kv.putIfNotExists('lock.json', 'token-one', { taken: 100 }), true);
  assert.equal(await kv.putIfNotExists('lock.json', 'token-two', { taken: 200 }), false,
    'the read in front of the put is what holds the line on @netlify/blobs 8');
  assert.equal((await kv.get('lock.json')).toString('latin1'), 'token-one');
});

test('blobs: list reads heads, not bodies, and reports meta and age', async () => {
  const store = fakeBlobsStore();
  const kv = await blobsKv(store);
  await kv.put('22.json', 'b', { touched: 2 });
  await kv.put('11.json', 'a', { touched: 1 });
  await kv.put('33.mp4', everyByte());
  store.stats.getCalls = 0;
  store.stats.headCalls = 0;
  const listed = await kv.list('');
  assert.deepEqual(listed.map((e) => e.key), ['11.json', '22.json', '33.mp4']);
  assert.equal(listed[0].meta.touched, 1);
  assert.equal(listed[2].meta, null, 'only the write stamp: nothing the caller stored');
  assert.ok(listed[2].createdAt > 0, 'a finished mp4 has a real age, or the sweep deletes it on the first tick');
  assert.equal(store.stats.getCalls, 0, 'a sweep over the files namespace must not download a single byte of video');
  assert.equal(store.stats.headCalls, 3);
  assert.deepEqual((await kv.list('1')).map((e) => e.key), ['11.json']);
  assert.deepEqual((await kv.list('zz')).map((e) => e.key), []);
  await kv.del('11.json');
  assert.deepEqual((await kv.list('')).map((e) => e.key), ['22.json', '33.mp4']);
});

/* ------------------------------------------------------------------ JobStore */

test('job create -> find -> sign -> verify round-trips the source', async (t) => {
  const root = tempRoot(t);
  const store = new JobStore({
    kv: kvFor(t, 'jobs', root),
    files: kvFor(t, 'files', root),
    random: () => 0.9,
  });
  const created = await store.create(bundle());
  assert.deepEqual(Object.keys(created), [
    'id', 'secret', 'created', 'expires', 'provider', 'title', 'thumbnail', 'pageUrl',
    'pageHost', 'finalUrl', 'thumbHost', 'notices', 'confidence', 'sources',
  ], 'the php array literal, key for key and in order');
  assert.match(created.id, /^[a-f0-9]{20}$/);
  assert.equal(created.secret.length, 32, 'bin2hex(random_bytes(16))');
  assert.match(created.secret, /^[0-9a-f]{32}$/);
  assert.equal(created.pageHost, 'cloudfam.io');
  assert.equal(created.thumbHost, 'cloudfam.io');
  assert.equal(created.expires, created.created + config.jobs.ttl);

  const found = await store.find(created.id);
  assert.deepEqual(found, created);
  const src = store.source(found, found.sources[0].id);
  assert.ok(src instanceof Source);
  assert.equal(src.url, 'https://cdn.cloudfam.io/f/abc123.mp4?token=xyz');
  assert.equal(src.kind, Source.MP4);
  assert.deepEqual(src.headers, { Referer: 'https://cloudfam.io/v/abc123', Cookie: 'sess=abc; pl=1' });
  assert.equal(src.height, 2160);
  assert.equal(src.sizeBytes, 123456789);
  assert.equal(src.tokenExpiresAt, 1893456000);
  assert.equal(src.needsProxy, true);
  assert.equal(src.duration, 61.24);
  assert.equal(src.score, 42);
  assert.equal(src.id.length, 12, 'sha1 of the url, first 12 hex chars');
  assert.equal(src.variants[0].url, 'https://cdn/x.m3u8', 'a variant keeps its signed url on the server');
  assert.equal(store.source(found, 'nope'), null);
  assert.deepEqual(Object.keys(found.sources[0]), Object.keys(src), 'encode/decode keeps every declared property');

  const url = src.url;
  const sig = store.sign(found, url);
  assert.equal(sig.length, 32);
  assert.equal(store.verify(found, url, sig), true);
  assert.equal(store.verify(found, url + '&x', sig), false);
  assert.equal(store.verify(found, url, sig.slice(0, 31)), false, 'a short signature is refused');
  assert.equal(store.verify(found, url, 'not-hex-at-all-long-enough-xxxx'), false);
  assert.equal(store.verify(found, url, sig.toUpperCase()), false, 'the compare is byte-exact');
  assert.equal(await store.find('f'.repeat(20)), null, 'an id that was never created');
});

test('sign is substr(hash_hmac(url, secret), 0, 32) over the bytes', () => {
  const store = new JobStore({});
  const known = crypto.createHmac('sha256', Buffer.from('cafebabe', 'latin1'))
    .update(Buffer.from('https://cdn/x.mp4?a=1', 'latin1')).digest('hex').slice(0, 32);
  assert.equal(store.sign({ secret: 'cafebabe' }, 'https://cdn/x.mp4?a=1'), known);
  assert.equal(store.verify({ secret: 'cafebabe' }, 'https://cdn/x.mp4?a=1', known), true);
  // a url held as a latin1 byte string signs on its bytes, not on its code points
  const bytes = Buffer.from('https://cdn/x.mp4?name=\u00e9\u00ff', 'latin1');
  const byteSig = crypto.createHmac('sha256', Buffer.from('cafebabe', 'latin1'))
    .update(bytes).digest('hex').slice(0, 32);
  assert.equal(store.sign({ secret: 'cafebabe' }, bytes.toString('latin1')), byteSig);
  assert.equal(store.verify({ secret: 'cafebabe' }, bytes.toString('latin1'), byteSig), true);
});

test('an expired job is dropped and answers null', async (t) => {
  const root = tempRoot(t);
  const kv = await kvFor(t, 'jobs', root);
  const store = new JobStore({ kv, files: kvFor(t, 'files', root), now: () => 1000, random: () => 0.9 });
  const rec = await store.create(bundle());
  assert.equal((await store.find(rec.id)).id, rec.id);
  store.now = () => rec.expires + 1;
  assert.equal(await store.find(rec.id), null);
  assert.equal(await kv.get(rec.id + '.json'), null, 'the expired record is gone from storage');
  assert.equal(store.sign(rec, 'x').length, 32, 'a record read before it died still verifies on its own');
});

test('a malformed id never touches storage', async (t) => {
  const touched = [];
  const proxy = new Proxy({}, {
    get(target, prop) {
      if (prop === 'then') {
        return undefined;
      }
      return (...args) => {
        touched.push(String(prop));
        return target[prop] ? target[prop](...args) : undefined;
      };
    },
  });
  const store = new JobStore({ kv: proxy });
  for (const bad of ['', 'zzzzzzzzzzzzzzzzzzzz', 'ABCDEF0123456789ABC', 'a'.repeat(19), 'a'.repeat(21),
    '../etc/passwd', 'a'.repeat(20) + '.json', '0123456789abcdefABCDEFx'.repeat(3)]) {
    assert.equal(await store.find(bad), null, JSON.stringify(bad));
  }
  const built = new BuildStore({ kv: proxy, files: proxy });
  assert.equal(await built.find('nope'), null);
  assert.equal(await built.lock('nope'), null);
  await built.discard('nope');
  assert.deepEqual(touched, [], 'no storage call at all: the id is refused on its shape');
});

test('the gc roll removes stale jobs and stale media, and keeps fresh ones', async (t) => {
  const root = tempRoot(t);
  const jobs = await kvFor(t, 'jobs', root);
  const files = await kvFor(t, 'files', root);
  const store = new JobStore({ kv: jobs, files, now: () => 100000, random: () => 0.0 });
  await jobs.put('a'.repeat(20) + '.json', '{}', { touched: 1 });
  await jobs.put('b'.repeat(20) + '.json', '{}', { touched: 99999 });
  await files.put('c'.repeat(20) + '.mp4', 'bytes', { touched: 1 });
  await files.put('d'.repeat(20) + '.mp4', 'bytes', { touched: 99990 });
  assert.equal(await store.maybeGc(), true, 'random 0.0 always rolls the 1-in-20 sweep');
  assert.deepEqual((await jobs.list('')).map((e) => e.key), ['b'.repeat(20) + '.json']);
  assert.deepEqual((await files.list('')).map((e) => e.key), ['d'.repeat(20) + '.mp4']);

  store.random = () => 0.99; // randInt(1,100) = 100 > 5 -> no sweep at all
  await jobs.put('e'.repeat(20) + '.json', '{}', { touched: 1 });
  assert.equal(await store.maybeGc(), false);
  assert.ok((await jobs.list('')).some((e) => e.key === 'e'.repeat(20) + '.json'), 'the stale entry survived');
});

test('create runs the sweep before it writes, and survives a store that keeps nothing', async (t) => {
  const root = tempRoot(t);
  const store = new JobStore({ kv: kvFor(t, 'jobs', root), files: kvFor(t, 'files', root), random: () => 0.0 });
  const rec = await store.create(bundle());
  assert.ok(await store.find(rec.id));
});

/* ------------------------------------------------------------------ BuildStore */

function buildStore(t, root = tempRoot(t), extra = {}) {
  return new BuildStore({
    kv: kvFor(t, 'builds', root),
    files: kvFor(t, 'files', root),
    now: () => 5000,
    random: () => 0.99,
    appUrl: (q) => 'https://grably.test/?' + q,
    ...extra,
  });
}

test('the build record keeps the php key order and rounds the duration', async (t) => {
  const store = buildStore(t);
  const src = Source.make('https://cdn/x/master.m3u8?a=1&b=2', Source.HLS);
  src.headers = { Referer: 'https://x/' };
  const record = await store.create(
    { id: 'a'.repeat(20), provider: 'mxdrop', title: 'My  Title!!' },
    src,
    [{ url: 'https://cdn/x/1.ts', bytes: 10 }],
    { uri: 'https://cdn/x/key', method: 'AES-128' },
    0.145,
  );
  assert.deepEqual(Object.keys(record), [
    'id', 'secret', 'job', 'provider', 'title', 'headers', 'playlist', 'key', 'segments',
    'duration', 'cursor', 'bytes', 'video_samples', 'audio_samples', 'params', 'ts_offset',
    'last_dts', 'last_delta', 'status', 'error', 'hint', 'note', 'filename', 'created',
    'updated', 'expires',
  ]);
  assert.equal(record.duration, 0.15, 'round(0.145, 2) is 0.15 in php, so it is 0.15 here');
  assert.equal(record.id.length, 20);
  assert.equal(record.id, crypto.createHmac('sha256', 'vd-build')
    .update(Buffer.from(src.url + record.secret, 'latin1')).digest('hex').slice(0, 20));
  assert.equal(record.job, 'a'.repeat(20));
  assert.equal(record.provider, 'mxdrop');
  assert.equal(record.playlist, src.url);
  assert.equal(record.status, 'running');
  assert.equal(record.created, 5000);
  assert.equal(record.expires, 5000 + config.build.ttl);
  assert.equal(record.filename, 'My-Title.mp4');
  assert.deepEqual(record.headers, { Referer: 'https://x/' });
  assert.deepEqual(record.key, { uri: 'https://cdn/x/key', method: 'AES-128' });
  assert.equal(record.last_dts, null);
  assert.equal(record.params, null);

  const again = await store.create({ id: 'j', provider: 'p', title: 't' }, src, [], null, 61.239999999999995);
  assert.equal(again.duration, 61.24);
  const negative = await store.create({ id: 'j', provider: 'p', title: 't' }, src, [], null, -2.675);
  assert.equal(negative.duration, -2.68, 'php rounds half away from zero');
  const zero = await store.create({ id: 'j', provider: 'p', title: 't' }, src, [], null, 0);
  assert.equal(zero.duration, 0);
  assert.equal((await store.create({ id: 'j', provider: '', title: '' }, src, [], null, 1)).filename, 'video.mp4');

  const found = await store.find(record.id);
  assert.deepEqual(Object.keys(found), Object.keys(record), 'the stored json keeps the order too');
  assert.equal(found.updated, 5000);

  const sig = store.sign(found);
  assert.equal(sig, crypto.createHmac('sha256', Buffer.from(found.secret, 'latin1'))
    .update(Buffer.from('file:' + found.id, 'latin1')).digest('hex').slice(0, 32));
  assert.equal(sig.length, 32);
  assert.equal(store.verify(found, sig), true);
  assert.equal(store.verify(found, sig + '0'), false);
  assert.equal(store.verify(found, sig.slice(0, 31)), false);
  assert.equal(await store.fileUrl(found),
    'https://grably.test/?r=file&build=' + found.id + '&s=' + sig + '&name=My-Title.mp4');

  found.cursor = 3;
  store.now = () => 5100;
  await store.save(found);
  const reRead = await store.find(found.id);
  assert.equal(reRead.cursor, 3);
  assert.equal(reRead.updated, 5100, 'save stamps the update time like php');
  assert.deepEqual(Object.keys(reRead), Object.keys(record), 'and does not move it in the record');
});

test('fileUrl urlencodes the filename the way php did', async (t) => {
  const store = buildStore(t, tempRoot(t), { appUrl: (q) => q });
  const src = Source.make('https://cdn/x/1.mp4', Source.MP4);
  const rec = await store.create({ id: 'j', provider: 'p', title: 'x' }, src, [], null, 1);
  rec.filename = 'a b~c_d.e%f/g.mp4';
  const q = await store.fileUrl(rec);
  assert.match(q, /&name=a\+b%7Ec_d\.e%25f%2Fg\.mp4$/);
});

test('paths() names the kv keys and one real scratch path', async (t) => {
  const scratch = path.join(tempRoot(t), 'scratch');
  const store = buildStore(t, tempRoot(t), { scratchDir: scratch });
  const p = store.paths('abcdef0123456789abcd');
  assert.equal(p.mp4, 'abcdef0123456789abcd.mp4');
  assert.equal(p.log, 'abcdef0123456789abcd.log');
  assert.equal(p.state, 'abcdef0123456789abcd.json');
  assert.match(p.scratch, /^.*[\\/]abcdef0123456789abcd\.mp4$/);
  assert.ok(path.isAbsolute(p.scratch));
  assert.ok(p.scratch.startsWith(scratch), 'the scratch path honours the injected directory');
});

test('a lock is exclusive, releasable and expires', async (t) => {
  const root = tempRoot(t);
  const store = buildStore(t, root);
  const id = 'abcdef0123456789abcd';
  const held = await store.lock(id);
  assert.ok(held, 'the first tick takes the lock');
  assert.equal(await store.lock(id), null, 'a second tick is told to come back later');
  await store.release(null);
  await store.release({ key: 'bogus', token: 'x', kv: { async getWithMeta() { throw new Error('boom'); }, async del() { throw new Error('boom'); } } });
  assert.equal(await store.lock(id), null, 'still held');
  await store.release(held);
  const again = await store.lock(id);
  assert.ok(again, 'released, so the next tick gets it');
  await store.release(again);
  assert.ok(await store.lock(id), 'and it is free again after that release');

  // An abandoned invocation must not wedge the build: past the ttl the lock breaks.
  const kv = await kvFor(t, 'builds', root);
  store.now = () => 20000;
  await kv.del(id + '.lock');
  const first = await store.lock(id);
  assert.ok(first);
  store.now = () => 20120;
  assert.equal(await store.lock(id), null, 'exactly at the ttl it is still held');
  store.now = () => 20121;
  const second = await store.lock(id);
  assert.ok(second, 'one second later the stale lock is broken instead of deadlocking forever');
  await store.release(first);
  assert.equal(await store.lock(id), null, "the stale holder's release did not steal the live lock");
  await store.release(second);
  assert.ok(await store.lock(id), 'and the real holder can let go');
});

test('discard clears state, log, lock and media', async (t) => {
  const root = tempRoot(t);
  const kv = await kvFor(t, 'builds', root);
  const files = await kvFor(t, 'files', root);
  const store = buildStore(t, root);
  const id = 'abcdef0123456789ab00';
  await kv.put(id + '.json', '{}');
  await kv.put(id + '.log', 'log');
  await files.put(id + '.mp4', 'bytes');
  assert.ok(await store.lock(id));
  await store.discard(id);
  assert.equal(await kv.get(id + '.json'), null);
  assert.equal(await kv.get(id + '.log'), null);
  assert.equal(await files.get(id + '.mp4'), null);
  assert.equal(await kv.get(id + '.lock'), null);
});

test('the partial file travels through storage with its log', async (t) => {
  const root = tempRoot(t);
  const kv = await kvFor(t, 'builds', root);
  const files = await kvFor(t, 'files', root);
  const store = buildStore(t, root);
  const id = 'abcdef0123456789ab01';
  assert.equal(await store.readOutput(id), null, 'the first slice has nothing to resume from');
  await store.writeOutput(id, Buffer.from([0, 1, 2, 253, 254]), Buffer.from([7, 7, 7]));
  const prior = await store.readOutput(id);
  assert.deepEqual([...prior.mp4], [0, 1, 2, 253, 254], 'the bytes come back unchanged, not as text');
  assert.deepEqual([...prior.log], [7, 7, 7]);
  assert.ok((await files.get(id + '.mp4')) !== null, 'the media lives in the files namespace');
  assert.ok((await kv.get(id + '.log')) !== null, 'the log lives in the builds namespace, like php wrote it');
  await kv.del(id + '.log');
  assert.deepEqual([...(await store.readOutput(id)).log], [], 'a missing log reads as an empty one');
  await store.writeOutput('not-a-build-id', Buffer.from('x'), Buffer.from('y'));
  assert.equal(await store.readOutput('not-a-build-id'), null, 'an id outside the grammar is refused');
});

test('an expired build is discarded with its media', async (t) => {
  const store = buildStore(t);
  const src = Source.make('https://cdn/x/1.mp4', Source.MP4);
  const rec = await store.create({ id: 'j', provider: 'p', title: 't' }, src, [], null, 1);
  const files = store.filesStore();
  await (await files).put(rec.id + '.mp4', 'half built');
  store.now = () => 5000 + config.build.ttl + 1;
  assert.equal(await store.find(rec.id), null);
  assert.equal(await (await files).get(rec.id + '.mp4'), null, 'the half-built media went with it');
});

test('the build gc sweeps old state and old locks, but only old mp4s', async (t) => {
  const root = tempRoot(t);
  const kv = await kvFor(t, 'builds', root);
  const files = await kvFor(t, 'files', root);
  const store = new BuildStore({ kv, files, now: () => 100000, random: () => 0.0 });
  await kv.put('a'.repeat(20) + '.json', '{}', { touched: 1 });
  await kv.put('a'.repeat(20) + '.lock', 'x', { taken: 1 });
  await ageKey(root, 'builds', 'a'.repeat(20) + '.lock', 1); // a lock with no meta ages on its mtime
  await files.put('b'.repeat(20) + '.mp4', 'x', { touched: 1 });
  await files.put('c'.repeat(20) + '.log', 'x', { touched: 1 });
  await files.put('d'.repeat(20) + '.mp4', 'x', { touched: 100000 - 7199 });
  assert.equal(await store.maybeGc(), true);
  assert.deepEqual((await kv.list('')).map((e) => e.key), [], 'glob(builds/*) reaped state and lock alike');
  assert.deepEqual((await files.list('')).map((e) => e.key), ['c'.repeat(20) + '.log', 'd'.repeat(20) + '.mp4'],
    'the files sweep only looked at *.mp4');
});

/* ------------------------------------------------------------------ fileName */

test('fileName matches the php pipeline', () => {
  assert.equal(BuildStore.fileName('', 'cloudfam'), 'cloudfam.mp4', 'empty title falls back to the provider');
  assert.equal(BuildStore.fileName('', ''), 'video.mp4', 'and to the literal video');
  assert.equal(BuildStore.fileName('   ', ''), 'video.mp4');
  assert.equal(BuildStore.fileName('!!!***???', 'site'), 'site.mp4', 'punctuation-only');
  assert.equal(BuildStore.fileName('My  Video: Part 2', 'p'), 'My-Video-Part-2.mp4');
  assert.equal(BuildStore.fileName('  spaced  ', 'p'), 'spaced.mp4');
  assert.equal(BuildStore.fileName('a.b_c-d 1', 'p'), 'a.b_c-d-1.mp4');
  assert.equal(BuildStore.fileName(bytes('café ✓ 日本'), 'p'), 'caf.mp4', 'the utf-8 bytes are stripped, so the title is');
  assert.equal(BuildStore.fileName(bytes('日'), 'p'), 'p.mp4', 'a title that is nothing but multibyte bytes');
  assert.equal(BuildStore.fileName('tab\there\nnewline', 'p'), 'tabherenewline.mp4', "tab and newline are stripped, not dashes");
  assert.equal(BuildStore.fileName('a\u000Bb\u000Cc', 'p'), 'abc.mp4', 'the two odd pcre whitespace bytes go the same way');
  assert.equal(BuildStore.fileName('end...of...it...', 'p'), 'end...of...it.mp4', 'dots inside survive, the ends are trimmed');
  assert.equal(BuildStore.fileName('--- ---', 'p'), 'p.mp4', 'nothing but separators is no name at all');
  assert.equal(BuildStore.fileName('0', 'p'), '0.mp4', 'php empty() would have refused "0"; trim() does not');
  assert.equal(BuildStore.fileName('x'.repeat(80), 'p'), 'x'.repeat(80) + '.mp4', '80 bytes is still a name');
  assert.equal(BuildStore.fileName('x'.repeat(81), 'p'), 'p.mp4', '81 bytes throws the whole name away for the provider');
  assert.equal(BuildStore.fileName('x'.repeat(100) + '  ', 'p'), 'p.mp4');
  assert.equal(BuildStore.fileName('a'.repeat(79) + ' b', 'p'), 'p.mp4', 'the dash join is counted before the length test');
  assert.equal(BuildStore.fileName('x'.repeat(81), ''), 'video.mp4', 'too long and no provider');
  assert.equal(BuildStore.fileName('x'.repeat(100), 'p'.repeat(90)), 'p'.repeat(80) + '.mp4', 'the fallback is cut to 80 too');
});

/* ------------------------------------------------------------------ Throttle */

test('a window allows exactly the limit and then refuses', async (t) => {
  const root = tempRoot(t);
  const kv = await kvFor(t, 'rate', root);
  let now = 1000;
  const th = new Throttle({ kv, now: () => now, random: () => 0.5 });
  for (let i = 1; i <= 12; i++) {
    const r = await th.hit('analyze:1.2.3.4', 12, 60);
    assert.equal(r.allowed, true, 'hit ' + i);
    assert.equal(r.retryAfter, 1060 - now, 'hit ' + i + ' counts the window down');
    now += 1;
  }
  const refused = await th.hit('analyze:1.2.3.4', 12, 60);
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfter, 1060 - now, 'the refusal names the real end of the window');
  now = 1060;
  assert.equal((await th.hit('analyze:1.2.3.4', 12, 60)).allowed, true, 'a new bucket when the window passed');
  assert.equal((await th.hit('analyze:1.2.3.4', 12, 60)).retryAfter, 60, 'the fresh bucket counts from now');
});

test('a limit of zero refuses the first hit, like php', async (t) => {
  const th = new Throttle({ kv: kvFor(t, 'rate'), now: () => 4000, random: () => 0.5 });
  const r = await th.hit('nope', 0, 60);
  assert.equal(r.allowed, false, 'hits is counted before the compare');
  assert.equal(r.retryAfter, 60);
});

test('retryAfter never drops below one second', async (t) => {
  const th = new Throttle({ kv: kvFor(t, 'rate'), now: () => 5000, random: () => 0.5 });
  for (let i = 0; i < 3; i++) {
    const r = await th.hit('ip:5.6.7.8', 2, 60);
    assert.ok(r.retryAfter >= 1);
    assert.equal(r.allowed, i < 2);
  }
  assert.equal(bucketDecision({ start: 5000, hits: 2 }, 5059, 2, 60).retryAfter, 1, 'the last second of a live window says 1');
  assert.equal(bucketDecision({ start: 5000, hits: 2 }, 5059, 2, 60).allowed, false, 'and the third hit is the one over the limit');
  assert.equal(bucketDecision({ start: 5000, hits: 2 }, 9000, 2, 0).retryAfter, 1, 'max(1, start + window - now) with a zero window');
  assert.equal(bucketDecision(null, 9000, 2, 60).bucket.start, 9000, 'no previous bucket starts a new one');
  assert.equal(bucketDecision({ start: 1, hits: 40 }, 9000, 2, 60).bucket.hits, 1, 'the stale bucket is thrown away');
});

test('buckets are keyed by sha1 and stay separate per key', async (t) => {
  const kv = await kvFor(t, 'rate');
  const th = new Throttle({ kv, now: () => 700, random: () => 0.5 });
  await th.hit('a', 1, 60);
  assert.equal((await th.hit('b', 1, 60)).allowed, true, 'a second visitor has its own bucket');
  assert.equal((await th.hit('a', 1, 60)).allowed, false);
  const keys = (await kv.list('')).map((e) => e.key).sort();
  assert.equal(keys.length, 2);
  for (const k of keys) {
    assert.match(k, /^[0-9a-f]{40}\.json$/);
  }
  assert.deepEqual(keys, [bucketKey('a') + '.json', bucketKey('b') + '.json'].sort());
  assert.equal(bucketKey('a'), crypto.createHash('sha1').update('a', 'latin1').digest('hex'));
  assert.equal((await kv.get(bucketKey('a') + '.json')).toString('latin1'), '{"start":700,"hits":2}');
});

test('a bucket that cannot be written still answers, and does not throw', async (t) => {
  const broken = {
    async get() { return null; },
    async put() { throw new Error('read-only store'); },
    async list() { return []; },
    async del() {},
  };
  const th = new Throttle({ kv: broken, now: () => 8000, random: () => 0.5 });
  assert.deepEqual(await th.hit('x', 3, 60), { allowed: true, retryAfter: 60 });
});

test('the throttle gc reaps hour-old buckets and keeps live ones', async (t) => {
  const kv = await kvFor(t, 'rate');
  let now = 20000;
  const th = new Throttle({ kv, now: () => now, random: () => 0.0 }); // every hit rolls the 1-in-50 sweep
  await th.hit('stale', 12, 60);
  await th.hit('live', 12, 60);
  const staleKey = bucketKey('stale') + '.json';
  const liveKey = bucketKey('live') + '.json';
  assert.ok(await kv.get(staleKey));
  assert.equal((await kv.getWithMeta(liveKey)).meta.touched, 20000, 'the bucket json says start/hits, the meta says when');
  now += 3601;
  await th.hit('live', 12, 60); // a visitor that is still here refreshes its own bucket
  await th.hit('fresh', 12, 60);
  const keys = (await kv.list('')).map((e) => e.key).sort();
  assert.ok(!keys.includes(staleKey), 'the hour-old bucket is gone');
  assert.ok(keys.includes(liveKey), 'meta.touched kept the live bucket alive over a long window');
  assert.deepEqual(keys, [liveKey, bucketKey('fresh') + '.json'].sort());
});

test('the throttle sweep is skipped on the other 49 rolls', async (t) => {
  const kv = await kvFor(t, 'rate');
  let now = 40000;
  const th = new Throttle({ kv, now: () => now, random: () => 0.5 });
  await th.hit('old', 12, 60);
  now += 7200;
  await th.hit('new', 12, 60);
  assert.equal((await kv.list('')).length, 2, 'no sweep, so the old bucket is still there');
});

test('clientKey only trusts forwarded ips when the operator says so', () => {
  const original = config.security.trust_proxy_ip;
  const server = { REMOTE_ADDR: '203.0.113.9' };
  const proxied = {
    ...server,
    HTTP_CF_CONNECTING_IP: '198.51.100.7',
    HTTP_X_FORWARDED_FOR: '192.0.2.10, 10.0.0.1',
  };
  const netlifyHeaders = { 'x-nf-client-connection-ip': '198.51.100.22' };
  try {
    config.security.trust_proxy_ip = false;
    assert.equal(Throttle.clientKey(proxied, {}), '203.0.113.9', 'a forgeable key is no limit at all');
    assert.equal(Throttle.clientKey(server, netlifyHeaders), '203.0.113.9', 'not even netflifies without the switch');
    assert.equal(Throttle.clientKey({}, {}), 'cli');

    config.security.trust_proxy_ip = true;
    assert.equal(Throttle.clientKey(proxied, {}), '198.51.100.7', 'cf-connecting-ip wins over x-forwarded-for');
    assert.equal(Throttle.clientKey({ REMOTE_ADDR: '203.0.113.9', HTTP_X_FORWARDED_FOR: '192.0.2.10, 10.0.0.1' }, {}),
      '192.0.2.10', 'the first hop of the chain');
    assert.equal(Throttle.clientKey(server, netlifyHeaders), '198.51.100.22',
      'x-nf-client-connection-ip is honoured, and only under the same switch');
    assert.equal(Throttle.clientKey(server, { 'x-nf-client-connection-ip': '198.51.100.22, 10.0.0.1' }), '198.51.100.22');
    assert.equal(Throttle.clientKey({ REMOTE_ADDR: '203.0.113.9', HTTP_CF_CONNECTING_IP: 'not-an-ip' },
      { 'x-forwarded-for': ' 192.0.2.5 , x' }), '192.0.2.5', 'an unusable header falls through to the next');
    assert.equal(Throttle.clientKey({ REMOTE_ADDR: '203.0.113.9' }, { 'x-forwarded-for': '01.02.03.04' }),
      '203.0.113.9', 'php refuses leading-zero octets');
    assert.equal(Throttle.clientKey({ REMOTE_ADDR: '203.0.113.9' }, { referer: 'https://x' }), '203.0.113.9',
      'a header map full of ordinary headers changes nothing');
  } finally {
    config.security.trust_proxy_ip = original;
  }
});

test('validateIp agrees with filter_var on the shapes this app sees', () => {
  const yes = ['127.0.0.1', '203.0.113.9', '::1', '1::', '2001:db8::1', '::ffff:1.2.3.4', '2001:DB8::1'];
  const no = ['', ' ', '01.2.3.4', '1.2.3.4.', '1.2.3', '999.1.1.1', '1.2.3.256', '1.2.3.4\n', ' 1.2.3.4 ',
    'fe80::1%eth0', 'g::1', '1:2:3:4:5:6:7:1.2.3.4', '12345::', '0x7f000001'];
  for (const c of yes) {
    assert.equal(validateIp(c), c, c);
  }
  for (const c of no) {
    assert.equal(validateIp(c), false, c);
  }
});
