import { BrowserBuffer } from './browserBuffer.mjs';

/**
 * esbuild injects this module into the worker bundle, so every bare `Buffer` the hls
 * engine names resolves to the shim above instead of a global node never shipped to a
 * browser, and every `process.env` read finds an empty object, because config.mjs stamps
 * base_url from the environment the server runs in and a worker has none. On the server
 * and in the node tests the real globals answer and nothing here is loaded.
 */
globalThis.Buffer = BrowserBuffer;

export const process = { env: {} };

export { BrowserBuffer as Buffer };
