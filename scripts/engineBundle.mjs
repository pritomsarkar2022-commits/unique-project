import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one description of what the device-side bundle is.
 *
 * scripts/generate-engine.mjs writes the file the page loads and site/tests/muxWorker.test.mjs
 * builds the same graph into memory to run it. Two copies of those options would drift, and
 * the drift would look like a test that passes against a file the browser never got.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const repoRoot = root;
export const workerEntry = path.join(root, 'site', 'src', 'engine', 'muxWorker.mjs');
export const workerInject = path.join(root, 'site', 'src', 'engine', 'browserGlobals.mjs');
export const workerOutfile = path.join(root, 'site', 'assets', 'js', 'mux-worker.js');

/** @returns {object} esbuild options, before the caller adds outfile or write:false */
export function workerBundleOptions(extra = {}) {
  return {
    entryPoints: [workerEntry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    inject: [workerInject],
    legalComments: 'none',
    logLevel: 'silent',
    metafile: true,
    ...extra,
  };
}
