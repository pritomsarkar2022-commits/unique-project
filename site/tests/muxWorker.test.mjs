import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import esbuild from 'esbuild';
import { fixtures } from '../../parity/tsGen.mjs';
import { muxPlaylistToMp4 } from '../src/engine/localMux.mjs';
import { workerBundleOptions, workerOutfile } from '../../scripts/engineBundle.mjs';

/**
 * The file the visitor's browser actually loads.
 *
 * localMux.test.mjs proves the muxer writes the right mp4. This proves two things the
 * page depends on and no node test would otherwise catch: that the committed bundle is
 * a build of the sources under test rather than of last week's copy, and that the whole
 * graph still runs where there is no node, no require and no Buffer -- so a node
 * builtin reaching it, or a chunk that structured clone refuses, fails here instead of
 * on someone's phone.
 */

const NOW = 1735689600;
const HOST = 'https://cdn.example.test/';
const PARTS = fixtures().find((f) => f.name === 'baseline').segments;

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=320x176',
  HOST + 'media.m3u8',
].join('\n');

const MEDIA = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:4',
  '#EXT-X-MEDIA-SEQUENCE:0',
  ...PARTS.flatMap((_part, i) => ['#EXTINF:4.000,', HOST + 'seg' + i + '.ts']),
  '#EXT-X-ENDLIST',
].join('\n');

/**
 * @param {{fail?: string}} [opts] `fail` makes that url answer 404 instead of its body
 * @returns {{fetch: (url:string)=>Promise<object>, asked: string[]}}
 */
function fakeSite(opts = {}) {
  const asked = [];
  return {
    asked,
    async fetch(url) {
      const u = String(url);
      asked.push(u);
      if (opts.fail === u) {
        return {
          ok: false,
          status: 404,
          async text() { return ''; },
          async arrayBuffer() { return new Uint8Array(0); },
        };
      }
      const body = u.endsWith('master.m3u8') ? MASTER : u.endsWith('media.m3u8') ? MEDIA : null;
      if (body !== null) {
        const bytes = Buffer.from(body);
        return {
          ok: true,
          status: 200,
          async text() { return body; },
          async arrayBuffer() { return new Uint8Array(bytes); },
        };
      }
      const part = PARTS[Number(/seg(\d+)\.ts$/.exec(u)[1])];
      return {
        ok: true,
        status: 200,
        async text() { return ''; },
        async arrayBuffer() { return new Uint8Array(part); },
      };
    },
  };
}

/**
 * Load the bundle the way a worker would and drive one message through it.
 *
 * The sandbox is deliberately bare: only what a worker really has. `Date.now` is frozen
 * because the moov takes its creation time from the clock the page never pins, and two
 * builds of the same stream have to be comparable for the test to say anything.
 */
async function runWorker(source, site, msg, opts = {}) {
  const messages = [];
  const chunks = [];
  const state = { closed: false, aborted: null };
  const stream = {
    getWriter: () => ({
      async write(chunk) { chunks.push(chunk); },
      async close() { state.closed = true; },
      async abort(reason) { state.aborted = reason; },
    }),
  };
  const sandbox = {
    self: { onmessage: null, postMessage: (m) => { messages.push(m); } },
    fetch: (url) => site.fetch(url),
    AbortController,
    TextEncoder,
    TextDecoder,
    setTimeout: (fn) => { fn(); return 0; },
    Date: { now: () => NOW * 1000 },
  };
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  // The page transfers the WritableStream as a property of the message; a MessagePort is
  // the only thing that ever arrives in event.ports, and the page has none.
  const data = { ...msg };
  if (opts.noStream !== true) {
    data.stream = stream;
  }
  await sandbox.self.onmessage({ data, ports: [] });
  return { messages, chunks, ...state };
}

const bundle = await esbuild.build({ ...workerBundleOptions(), write: false });
const source = bundle.outputFiles[0].text;

const concat = (list) => Buffer.concat(list.map((chunk) => Buffer.from(chunk)));

test('the committed mux-worker.js is a build of the sources these tests run', () => {
  assert.ok(fs.existsSync(workerOutfile), 'site/assets/js/mux-worker.js is missing: npm run engine');
  assert.equal(source, fs.readFileSync(workerOutfile, 'utf8'),
    'the engine changed but the file the browser loads did not: npm run engine');
  assert.equal(/(^|[^A-Za-z0-9_.])require\s*\(/.test(source), false, 'a require() throws on load in a worker');
  assert.equal(source.includes('node:'), false, 'a node builtin leaked into the browser bundle');
});

test('the bundle writes the file the module writes, over the same relay', async () => {
  const site = fakeSite();
  const run = await runWorker(source, site, { cmd: 'mux', manifestUrl: HOST + 'master.m3u8', height: null });

  const inProcess = [];
  const built = await muxPlaylistToMp4({
    manifestUrl: HOST + 'master.m3u8',
    height: null,
    now: NOW,
    fetchText: async (url) => (await site.fetch(url)).text(),
    fetchBytes: async (url) => new Uint8Array(await (await site.fetch(url)).arrayBuffer()),
    write: async (bytes) => inProcess.push(bytes),
  });

  assert.ok(concat(inProcess).equals(concat(run.chunks)),
    'the worker wrote a different file than the module it bundles');
  const done = run.messages[run.messages.length - 1];
  assert.equal(done.ev, 'done', JSON.stringify(run.messages));
  assert.equal(done.parts, PARTS.length);
  assert.equal(done.bytes, built.bytes);
  assert.equal(done.bytes, concat(run.chunks).length, 'the size the page reports is the size of the file');
  assert.equal(run.closed, true, 'the file was left open');
  assert.ok(run.messages.some((m) => m.ev === 'progress'), 'the progress bar never got a tick to draw');
});

test('every chunk the worker posts is clonable, because a Buffer subclass is not', async () => {
  const { chunks } = await runWorker(source, fakeSite(), { cmd: 'mux', manifestUrl: HOST + 'master.m3u8' });
  assert.ok(chunks.length > 1, 'the file was expected to arrive in pieces');
  for (const chunk of chunks) {
    assert.equal(chunk.length > 0, true, 'an empty write wastes a postMessage');
    // Cross-realm, so a prototype-identity test would fail on a correct chunk: the
    // constructor name is what separates the shim Buffer from the plain array.
    assert.equal(chunk.constructor.name, 'Uint8Array',
      'structured clone refuses a Uint8Array subclass, and the worker would die on the first write');
  }
});

test('a part that does not arrive ends the save and says why', async () => {
  const run = await runWorker(source, fakeSite({ fail: HOST + 'seg0.ts' }), {
    cmd: 'mux',
    manifestUrl: HOST + 'master.m3u8',
  });
  assert.equal(run.closed, false, 'a half written file is not offered to the user as a video');
  assert.notEqual(run.aborted, null, 'the writer was never aborted');
  const last = run.messages[run.messages.length - 1];
  assert.equal(last.ev, 'error');
  assert.match(last.message, /did not arrive|HTTP/);
  assert.equal(typeof last.hint, 'string', 'the page prints the hint line, so it has to be a string');
});

test('a message that is not a save does nothing, and a save with no file says so', async () => {
  const idle = fakeSite();
  const ignored = await runWorker(source, idle, { cmd: 'ping', manifestUrl: HOST + 'master.m3u8' });
  assert.deepEqual(ignored.messages, [], 'a stray message started a save');
  assert.deepEqual(idle.asked, [], 'the unknown command fetched the playlist anyway');

  const noStream = await runWorker(source, fakeSite(), { cmd: 'mux', manifestUrl: HOST + 'master.m3u8' }, { noStream: true });
  assert.equal(noStream.messages.length, 1);
  assert.equal(noStream.messages[0].ev, 'error');
  assert.match(noStream.messages[0].message, /never handed over/);
});
