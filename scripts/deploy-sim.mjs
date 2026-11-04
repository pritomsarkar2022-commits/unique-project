/**
 * A deploy you can run without a deploy.
 *
 * Netlify builds a function with esbuild: one file, and the only imports that survive
 * are the ones the bundler can read as strings. The source tree passes its tests while
 * a bundle silently loses whatever it could not trace - which is exactly how a site
 * went live with no video hosts in it at all. So this script bundles the entry point
 * the way the platform does, runs the artifact in isolation, and asks the questions a
 * broken bundle answers differently: is the extractor list full, does the router still
 * route, and does a missing store say so.
 *
 *   npm run deploy-sim
 *
 * No network, no blob store, no php. Exits non-zero with the reason.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = createRequire(import.meta.url);

// The bundle runs with the environment a netlify invoke has, minus the store. NETLIFY is
// what picks the blobs driver; the storage root goes to a temp directory so the fallback
// never touches the real tree.
const simRoot = path.join(os.tmpdir(), 'vd-deploy-sim-storage');
process.env.NETLIFY = '1';
process.env.VD_STORE = 'fs';
process.env.VD_STORAGE_DIR = simRoot;

async function main() {
  const esbuild = load('esbuild');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-deploy-sim-'));
  const bundle = path.join(dir, 'router.mjs');
  try {
    // The three flags netlify.toml's [functions] section implies.
    await esbuild.build({
      entryPoints: [path.join(ROOT, 'netlify', 'functions', 'router.mjs')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['@netlify/blobs'],
      logLevel: 'silent',
    });

    const { default: router } = await import(toUrl(bundle));
    const call = (url, init = {}) =>
      router(new Request(url, init), { event: { path: new URL(url).pathname } });

    // 1. the whole site has to be inside the one file the platform runs
    const health = (await body(call('https://grably.example/health'), 'json')).json;
    if (health.storage_writable !== true) {
      fail('/health says the store is not writable: ' + JSON.stringify(health.storage_reason ?? health));
    }
    if (!(health.extractors >= 13)) {
      fail('the bundle registered ' + health.extractors + ' extractors and the source registry has 13. '
        + 'Every path HOST_EXTRACTORS names needs its literal importer in extractorRegistry.mjs, '
        + 'because a bundler only follows an import() it can read as a string.');
    }
    if (!(health.hosts >= 40)) {
      fail('the bundle knows ' + health.hosts + ' hosts; the static build lists more than that');
    }

    // 2. the routes answer out of the bundle, not only out of the source tree
    const home = await call('https://grably.example/index.php');
    const homeBody = await home.text();
    if (home.status !== 200 || !homeBody.includes('streamtape')) {
      fail('the bundled front controller did not render the home page with its hosts (status '
        + home.status + ', ' + homeBody.length + ' bytes)');
    }
    const robots = await call('https://grably.example/robots.txt');
    if (robots.status !== 200) {
      fail('robots.txt answered ' + robots.status + ' from the bundle');
    }
    const shortLink = (await body(
      call('https://grably.example/index.php?r=analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'not a link' }),
      }), 'json')).json;
    if (shortLink.ok !== false || !['empty', 'bad_url'].includes(shortLink.code)) {
      fail('an analyse with no link answered ' + JSON.stringify(shortLink).slice(0, 160));
    }

    // 3. a deploy with no usable store says so. Blobs is unreachable from a bundle in a
    //    temp directory and the fallback root sits under a plain file, so no store works.
    const notADirectory = path.join(dir, 'not-a-directory');
    await writeFile(notADirectory, 'x');
    process.env.VD_STORE = 'blobs';
    process.env.VD_STORAGE_DIR = path.join(notADirectory, 'storage');
    const noStore = await body(
      call('https://grably.example/index.php?r=build', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': '203.0.113.9' },
        body: JSON.stringify({ job: 'deadbeefdeadbeefdead' }),
      }), 'json');
    process.env.VD_STORE = 'fs';
    process.env.VD_STORAGE_DIR = simRoot;
    if (noStore.status !== 503 || noStore.json.code !== 'storage') {
      fail('with no store a build answered ' + noStore.status + ' '
        + JSON.stringify(noStore.json).slice(0, 200) + ' instead of a 503 that names storage');
    }

    process.stdout.write('deploy-sim: bundle carries ' + health.extractors + ' extractors and '
      + health.hosts + ' hosts, the routes answer, and no store answers 503\n');
  } finally {
    delete process.env.VD_STORE;
    delete process.env.VD_STORAGE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
}

async function body(sent, kind) {
  const res = await sent;
  const text = await res.text();
  if (kind !== 'json') {
    return { status: res.status, text };
  }
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    fail('a json route answered ' + res.status + ' with: ' + text.slice(0, 200));
  }
}

function fail(message) {
  throw new Error(message);
}

function toUrl(file) {
  return 'file:///' + String(file).replace(/\\/g, '/');
}

main().then(() => process.exit(0), (err) => {
  process.stderr.write('deploy-sim FAILED: ' + (err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
