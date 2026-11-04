import { muxPlaylistToMp4 } from './localMux.mjs';

/**
 * The worker the page starts for a save that runs on the device.
 *
 * It is given one thing: a writable stream, transferred from the main thread, that
 * stands for the file the user chose. Everything else it does it does over the relay
 * addresses the page already holds a signature for, so the site never sees a byte of
 * the video and the video host never sees a cross origin request.
 */

/** A Uint8Array subclass is not clonable, and the shim Buffer is one. */
function plain(bytes) {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

async function bytesOf(url, signal) {
  const res = await fetch(url, { signal, redirect: 'follow', credentials: 'omit' });
  if (!res.ok) {
    throw new Error('The video host answered HTTP ' + res.status + '.');
  }
  return plain(new Uint8Array(await res.arrayBuffer()));
}

async function textOf(url, signal) {
  const res = await fetch(url, { signal, redirect: 'follow', credentials: 'omit' });
  if (!res.ok) {
    throw new Error('The video host answered HTTP ' + res.status + '.');
  }
  return await res.text();
}

self.onmessage = async (event) => {
  const msg = event.data ?? {};
  if (msg.cmd !== 'mux') {
    return;
  }
  // A transferred WritableStream is a property of the message, not an event port: only
  // MessagePorts arrive in event.ports, and the page has no port to hand over.
  const stream = msg.stream;
  if (stream === null || stream === undefined || typeof stream.getWriter !== 'function') {
    self.postMessage({ ev: 'error', message: 'The file to write was never handed over.' });
    return;
  }
  const writer = stream.getWriter();
  const controller = new AbortController();
  let last = 0;
  const send = (body) => {
    if (Date.now() - last < 220 && body.ev === 'progress') {
      return;
    }
    last = Date.now();
    self.postMessage(body);
  };

  try {
    const done = await muxPlaylistToMp4({
      manifestUrl: String(msg.manifestUrl ?? ''),
      height: msg.height ?? null,
      fetchText: (url) => textOf(url, controller.signal),
      fetchBytes: (url) => bytesOf(url, controller.signal),
      write: async (bytes) => {
        if (bytes.length > 0) {
          await writer.write(plain(bytes));
        }
      },
      onPart: (parts, total, bytes) => send({ ev: 'progress', done: parts, total, bytes }),
    });
    await writer.close();
    self.postMessage({ ev: 'done', bytes: done.bytes, parts: done.parts, note: done.note });
  } catch (e) {
    controller.abort();
    const message = e && typeof e.message === 'string' && e.message !== '' ? e.message : 'The local saver stopped.';
    try {
      await writer.abort(e instanceof Error ? e : new Error(message));
    } catch {
      // The file was already closed or never opened; the message below is what matters.
    }
    self.postMessage({ ev: 'error', message, hint: e instanceof Error && e.hint ? e.hint : '' });
  }
};
