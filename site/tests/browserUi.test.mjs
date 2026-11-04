import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The page's own wiring, checked without a browser.
 *
 * The home page was cut down to one tool band, and every trim there is a chance to leave
 * app.js reaching for an element that no longer exists: querySelector answers null,
 * addEventListener throws, and the save button that worked a minute ago is quietly gone.
 * A deleted sprite symbol is the same failure in the other direction -- a blank square
 * inside a button that only the visitor notices. The page also caches its assets for a
 * month, so the worker url has to move with app.js or a bust of one leaves the other
 * stale on every phone.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const app = fs.readFileSync(path.join(root, 'assets/js/app.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'templates/home.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'assets/js/mux-worker.js'), 'utf8');

const idsIn = (text) => new Set((text.match(/id="([\w-]+)"/g) ?? []).map((m) => /id="([\w-]+)"/.exec(m)[1]));

/**
 * The three shapes app.js selects with, plus the quoted '#name' the sprite references
 * use. A colour literal never appears in one of these positions, so it is not read here.
 */
function selectorsUsed(text) {
  const out = new Set();
  const add = (re) => {
    for (const m of text.matchAll(re)) {
      out.add(m[1]);
    }
  };
  add(/\$\(\s*['"]#([\w-]+)['"]/g);
  add(/querySelector(?:All)?\(\s*['"]#([\w-]+)['"]/g);
  add(/getElementById\(\s*\\?['"]([\w-]+)\\?['"]\s*\)/g);
  // A sprite name is either written whole or built as '#ic-' + name; the concatenated
  // half is a prefix, so only the whole one is a reference this file can check.
  for (const m of text.matchAll(/['"](?:[^'"]*<use href=)?#(ic-[\w-]+)['"]/g)) {
    out.add(m[1]);
  }
  return out;
}

test('every id the script reaches for is in the page or in the html the script writes', () => {
  const defined = new Set([...idsIn(home), ...idsIn(app)]);
  const sprite = new Set((home.match(/symbol id="(ic-[\w-]+)"/g) ?? []).map((m) => /symbol id="([\w-]+)"/.exec(m)[1]));
  const missing = [...selectorsUsed(app)].filter((id) => !defined.has(id) && !sprite.has(id));
  assert.deepEqual(missing, [], 'app.js reaches for elements the trimmed page no longer has');
});

test('the save path the page offers is present in the markup', () => {
  const ids = idsIn(home);
  for (const id of ['url', 'analyze-form', 'results', 'busy-bar', 'direct-url', 'direct-btn', 'go-btn', 'sites']) {
    assert.equal(ids.has(id), true, 'the tool band lost #' + id + ', which app.js drives');
  }
  assert.equal(home.includes('mux-worker'), false, 'the worker is started by the script, not by the page');
});

test('the page hands the file to the worker the way the worker reads it', () => {
  const muxWorker = fs.readFileSync(path.join(root, 'src/engine/muxWorker.mjs'), 'utf8');
  // A transferred WritableStream stays a property of the message data; event.ports only
  // ever carries MessagePorts. Getting these two out of step is silent: the worker would
  // answer "never handed over" and the save would fall back to the capped server build.
  assert.match(app, /postMessage\(\{[\s\S]{0,120}stream: stream,[\s\S]{0,120}\}, \[stream\]\)/,
    'the page must carry the stream inside the message and list it for transfer');
  assert.match(muxWorker, /msg\.stream/, 'the worker reads the stream off the message');
  const code = muxWorker.replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm, '');
  assert.equal(code.includes('event.ports'), false,
    'event.ports is only ever a MessagePort, and the page has none to give');
});

test('the page starts the worker beside itself, so one version covers both', () => {
  assert.match(app, /new URL\('mux-worker\.js'/,
    'the worker url must follow app.js, or a bust of one leaves the other cached for a month');
  assert.match(app, /new Worker\(LOCAL\)/, 'the local save stopped going through the worker');
  assert.ok(worker.length > 1000, 'mux-worker.js is a stub: npm run engine');
});
