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

/**
 * One part, asked for as many times as it takes.
 *
 * A part that fails here is a fetch to this same origin, and the origin is a function
 * the platform will only run one at a time: a preview playing in the tab, a second tab,
 * or a second visitor makes the answered link return the platform's own error page for a
 * few hundred milliseconds. The part is not missing, it is queued, and the save that
 * gives up on the first one is the failure people describe as "it never downloads".
 */
async function fetchPart(url, signal, attempts = 4) {
  let last = null;
  for (let tryNo = 0; tryNo < attempts; tryNo += 1) {
    const res = await fetch(url, { signal, redirect: 'follow', credentials: 'omit' });
    if (res.ok) {
      return res;
    }
    last = res;
    if (signal.aborted) {
      break;
    }
    // A 404 from the video host would answer the same way, so this waits it out rather
    // than trusting the status; the backoff only has to outlast one queued invocation.
    await new Promise((resolve) => setTimeout(resolve, 500 * (tryNo + 1)));
  }
  throw new Error('The video host answered HTTP ' + last.status + '.');
}

async function bytesOf(url, signal) {
  const res = await fetchPart(url, signal);
  return plain(new Uint8Array(await res.arrayBuffer()));
}

async function textOf(url, signal) {
  const res = await fetchPart(url, signal);
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
