/**
 * Ports of the helpers in lib/support.php, in two files:
 *
 *   supportPure.mjs   byte-string, rounding and url helpers, safe for the browser
 *   supportNode.mjs   the sealed relay link and the per-request host, which need node
 *
 * Server code imports this one module and gets both. The hls engine imports
 * supportPure.mjs by name, because a bundler resolves a re-exported module even when
 * none of its exports are used, and that would put node:crypto inside the worker the
 * page runs. Every helper is fuzz-diffed against php in parity/test-support.mjs.
 */
export * from './supportPure.mjs';
export * from './supportNode.mjs';
