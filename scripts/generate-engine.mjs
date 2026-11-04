import esbuild from 'esbuild';
import { workerBundleOptions, workerOutfile } from './engineBundle.mjs';

/**
 * Bundles the device side saver into the file the page loads.
 *
 * The engine is written as es modules shared with the server, and a browser has no
 * node, no Buffer and no way to resolve a .mjs specifier inside a worker that was
 * copied verbatim into /assets. esbuild flattens the same sources the test suite runs
 * against, so the muxer that writes the user's file is the muxer that was tested.
 */

const out = await esbuild.build(workerBundleOptions({
  outfile: workerOutfile,
  logLevel: 'warning',
}));

// A node builtin reaching this graph is the whole failure mode: the file the page loads
// runs where there is no require and no node, so an import of node:crypto (or anything
// else named like one) would only surface at load time, on the visitor's device. esbuild
// with platform browser refuses to resolve one and throws, which already stops the build
// - this is the belt-and-braces check that none slipped through as an external or a
// dynamic require, and it names the importer so the fix is obvious.
const leaked = new Set();
for (const [file, node] of Object.entries(out.metafile.inputs)) {
  for (const imp of node.imports ?? []) {
    if (imp.path.startsWith('node:')) {
      leaked.add(imp.path + '  (imported by ' + file + ')');
    }
  }
}
if (leaked.size > 0) {
  throw new Error('the worker bundle reaches a node builtin:\n  ' + [...leaked].join('\n  '));
}

const bytes = Object.values(out.metafile.outputs)[0].bytes;
console.log('generate-engine: mux-worker.js built, ' + bytes + ' bytes, '
  + Object.keys(out.metafile.inputs).length + ' modules');
