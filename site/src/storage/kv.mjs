import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Key-value door for everything the php original kept as flat files under
 * storage/. Each flat-file directory (jobs, builds, files, rate) becomes one
 * namespace, and a namespace is backed by either
 *
 *   - the real filesystem, rooted at site/storage/<namespace>/<key>, which is
 *     what a local run and every test uses, or
 *   - Netlify Blobs, which is the only durable store a stateless function has.
 *
 * Keys are plain strings and values are Buffer or latin1 strings, one javascript
 * char per php byte, exactly like the rest of this port.
 *
 * Divergences from the flat files, all forced by the platform and each noted
 * where it is used:
 *   - There is no flock()/LOCK_EX. Writes are atomic per key (rename on fs,
 *     put-on-blobs) and BuildStore's lock is a create-if-absent put with a ttl,
 *     see kv.putIfNotExists(): blobs answers a lost race with {modified:false},
 *     which a held flock does far better than an expired lock does, because a
 *     function invocation that times out leaves no process behind to release it.
 *   - filemtime was "last touched". Blobs exposes no clock at all, so the blobs
 *     driver writes the time of its own put into the entry's metadata and hands
 *     that back as createdAt; on both drivers createdAt means the last write.
 *     Anything that ages entries reads meta.touched first anyway.
 */

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Safe characters for a key. The php directories only ever held "<20 hex>.json",
 *  "<40 hex>.json", "<20 hex>.mp4" and "<20 hex>.log"; anything that would climb out
 *  of the namespace directory is refused instead of quietly normalised. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function assertKey(key) {
  if (typeof key !== 'string' || !SAFE_KEY.test(key) || key.includes('..')) {
    throw new TypeError('unsafe kv key: ' + JSON.stringify(String(key).slice(0, 80)));
  }
  return key;
}

/** Directory the filesystem driver roots its namespaces in. */
export function kvRoot(env = process.env) {
  const fromEnv = env.VD_STORAGE_DIR ?? env.VD_STORAGE ?? env.VD_ROOT;
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return path.resolve(fromEnv);
  }
  return path.join(SITE_ROOT, 'storage');
}

/**
 * Which driver this environment asks for. VD_STORE lets a deploy pin or override the
 * choice, and the tests force 'fs'. On the platform the two signals are the NETLIFY flag
 * and a blobs context that has already been adopted from the invoke event - a function
 * runtime is free to deliver one and not the other.
 */
export function selectDriver(env = process.env) {
  const forced = typeof env.VD_STORE === 'string' ? env.VD_STORE : '';
  if (forced === 'fs' || forced === 'filesystem') {
    return 'fs';
  }
  if (forced === 'blobs') {
    return 'blobs';
  }
  return env.NETLIFY !== undefined || globalThis.netlifyBlobsContext !== undefined ? 'blobs' : 'fs';
}

/**
 * True when the selected driver gives a real atomic "create this key only if it
 * does not exist yet" put, which is what BuildStore's lock wants. The filesystem
 * driver also has one (an exclusive O_CREAT|O_EXCL create), so callers should
 * prefer kv.putIfNotExists(); this hook is here for the case where code wants to
 * know whether the platform, rather than a lock file, is holding the lock.
 * Blobs has it from sdk 10 up, where set() takes onlyIfNew; an older sdk ignores
 * the option and silently overwrites, which is why putIfNotExists probes for the
 * answer shape instead of trusting the option.
 */
export function atomicPutGuardAvailable(env = process.env) {
  return selectDriver(env) === 'blobs';
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  return Buffer.from(String(value), 'latin1');
}

/**
 * The blobs client takes its credentials from `NETLIFY_BLOBS_CONTEXT`, which the
 * platform does not always hand a function at invoke time - it can also deliver them
 * on the event, base64 in `event.blobs` with the site id in the event headers. The
 * sdk turns that into the same global with connectLambda(), so the adapter calls this
 * with its context before it asks for a store. Without it a deploy on the platform
 * finds no credentials anywhere and the store cannot be reached.
 *
 * Silent by design: no event, no sdk or a context that will not parse leaves the
 * environment alone, and the next openKv() reports what actually went wrong.
 */
export async function adoptBlobsContext(context, loadSdk = () => import('@netlify/blobs')) {
  const event = context?.event;
  if (!event || typeof event.blobs !== 'string' || event.blobs === '') {
    return false;
  }
  try {
    const mod = await loadSdk();
    const connect = mod.connectLambda ?? (mod.default && mod.default.connectLambda);
    if (typeof connect !== 'function') {
      return false;
    }
    connect(event);
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens one namespace. Never throws at import time.
 *
 * When the blobs driver cannot be used, the fallback is the filesystem - but only
 * where the filesystem can actually be written. On Netlify a function's own directory
 * is read-only, so a silent fallback there produces a site that renders and then
 * fails every analyse with an opaque write error; that is worse than one clear
 * failure, so the fallback is checked and a StorageUnavailable names the real reason
 * when it will not work. The reason is also kept in storageFault() for /health.
 *
 * @param {string} namespace 'jobs' | 'builds' | 'files' | 'rate' | ...
 * @param {{driver?: string, root?: string, env?: object, warn?: (m: string) => void}} [opts]
 *        opts is only ever used by tests; production callers pass the namespace alone.
 */
export async function openKv(namespace, opts = {}) {
  const env = opts.env ?? process.env;
  const driver = opts.driver ?? selectDriver(env);
  const root = opts.root ?? kvRoot(env);
  const warn = opts.warn ?? ((m) => console.warn(m));

  if (driver === 'blobs') {
    try {
      return await makeBlobsKv(namespace, env);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      warn(`kv: blobs driver unavailable for "${namespace}" (${message}); using the filesystem`);
      if (await fsWritable(root)) {
        storageFaults.set(namespace, message);
      } else {
        // Both halves are missing, which is the state worth naming: the reason the
        // platform store failed, and the reason the fallback cannot take its place.
        const why = 'netlify blobs is not usable here (' + message + ') and the function '
          + 'filesystem is read-only, so nothing can be stored. See the Netlify Blobs step in README.md.';
        storageFaults.set(namespace, why);
        throw new StorageUnavailable(why);
      }
    }
  }
  return makeFsKv(namespace, root);
}

/**
 * The last blobs failure per namespace, or null while none has happened. /health
 * reads it: on a platform deploy this is the difference between 'the store works' and
 * 'the site is falling back to a filesystem it cannot write'.
 */
const storageFaults = new Map();

export function storageFault() {
  return storageFaults.size === 0 ? null : Object.fromEntries(storageFaults);
}

/** A store this deployment cannot use at all. */
export class StorageUnavailable extends Error {}

/** Whether the namespace root can be created and written, asked once per root. */
const writableCache = new Map();

async function fsWritable(root) {
  const cached = writableCache.get(root);
  if (cached !== undefined) {
    return cached;
  }
  let ok = false;
  try {
    const dir = path.join(root, '.probe');
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, 'writable');
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe, { force: true });
    await fsp.rm(dir, { recursive: true, force: true });
    ok = true;
  } catch {
    ok = false;
  }
  writableCache.set(root, ok);
  return ok;
}

/* ------------------------------------------------------------------ filesystem */

function makeFsKv(namespace, root) {
  const dir = path.join(root, safeNamespace(namespace));
  let ensured = false;

  async function ensure() {
    if (!ensured) {
      await fsp.mkdir(dir, { recursive: true });
      ensured = true;
    }
  }

  const dataPath = (key) => path.join(dir, key);
  const metaPath = (key) => path.join(dir, key + '.meta.json');

  async function readMeta(key) {
    try {
      const raw = await fsp.readFile(metaPath(key), 'latin1');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null; // no sidecar, unreadable or half-written: same as php's missing file
    }
  }

  async function writeMeta(key, meta) {
    if (meta === null || meta === undefined) {
      await fsp.rm(metaPath(key), { force: true }).catch(() => {});
      return;
    }
    await fsp.writeFile(metaPath(key), JSON.stringify(meta), 'latin1').catch(() => {});
  }

  return {
    driver: 'fs',
    namespace,
    atomicGuard: true,

    async get(key) {
      assertKey(key);
      try {
        return await fsp.readFile(dataPath(key));
      } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'EISDIR')) {
          return null;
        }
        throw err;
      }
    },

    async getWithMeta(key) {
      assertKey(key);
      let stat;
      let data;
      try {
        stat = await fsp.stat(dataPath(key));
        data = await fsp.readFile(dataPath(key));
      } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'EISDIR')) {
          return null;
        }
        throw err;
      }
      return { data, meta: await readMeta(key), createdAt: Math.floor(stat.mtimeMs / 1000) };
    },

    async getRange(key, start, endInclusive) {
      assertKey(key);
      let stat;
      try {
        stat = await fsp.stat(dataPath(key));
      } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'EISDIR')) {
          return null;
        }
        throw err;
      }
      const total = stat.size;
      const from = Math.max(0, Math.trunc(Number(start) || 0));
      let to = endInclusive === null || endInclusive === undefined || !Number.isFinite(Number(endInclusive))
        ? total - 1
        : Math.trunc(Number(endInclusive));
      if (to > total - 1) {
        to = total - 1;
      }
      if (from > to || from >= total) {
        return { data: Buffer.alloc(0), total };
      }
      const handle = await fsp.open(dataPath(key), 'r');
      try {
        const buf = Buffer.alloc(to - from + 1);
        await handle.read(buf, 0, buf.length, from);
        return { data: buf, total };
      } finally {
        await handle.close();
      }
    },

    async put(key, value, meta = null) {
      assertKey(key);
      await ensure();
      const buf = toBuffer(value);
      // A unique temporary name, then rename: the reader never sees a half object.
      // php wrote "<id>.json.tmp" and renamed it; two concurrent writers can race
      // on one fixed name, so the suffix is per-write here.
      const tmp = dataPath(key) + '.tmp' + Math.random().toString(36).slice(2, 8);
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, dataPath(key));
      await writeMeta(key, meta);
    },

    /** Exclusive create: the lock file. Returns false when the key already exists. */
    async putIfNotExists(key, value, meta = null) {
      assertKey(key);
      await ensure();
      let handle;
      try {
        handle = await fsp.open(dataPath(key), 'wx');
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          return false;
        }
        throw err;
      }
      try {
        await handle.write(toBuffer(value));
      } finally {
        await handle.close();
      }
      await writeMeta(key, meta);
      return true;
    },

    async del(key) {
      assertKey(key);
      await fsp.rm(dataPath(key), { force: true }).catch(() => {});
      await fsp.rm(metaPath(key), { force: true }).catch(() => {});
    },

    async list(prefix = '') {
      let names;
      try {
        names = await fsp.readdir(dir);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          return []; // the php constructor created the dir lazily; glob() on a
        }
        throw err;        // missing one answered an empty list, so this does too
      }
      names.sort(); // glob() returns names in ascending order and the gc walks in that order
      const out = [];
      for (const name of names) {
        // Sidecars and half-written temporaries are not entries. No key this app
        // stores ends in ".meta.json" or ".tmp", which is why the suffix test is safe.
        if (name.endsWith('.meta.json') || /\.tmp[a-z0-9]*$/.test(name)) {
          continue;
        }
        if (prefix !== '' && !name.startsWith(prefix)) {
          continue;
        }
        let stat;
        try {
          stat = await fsp.stat(path.join(dir, name));
        } catch {
          continue; // raced away, like a file php's glob found and unlink beat
        }
        if (!stat.isFile()) {
          continue;
        }
        out.push({ key: name, meta: await readMeta(name), createdAt: Math.floor(stat.mtimeMs / 1000) });
      }
      return out;
    },
  };
}

function safeNamespace(namespace) {
  const n = String(namespace).replace(/[^A-Za-z0-9._-]/g, '_');
  return n === '' ? 'default' : n.slice(0, 64);
}

/* ------------------------------------------------------------------ netlify blobs */

/**
 * The blobs driver. '@netlify/blobs' is imported dynamically and only here, so a
 * repository checkout without the package (every local run and every test) still
 * loads this module; openKv() turns the failed import into a filesystem fallback.
 * loadSdk exists for the tests, which hand in a fake getStore.
 */
async function makeBlobsKv(namespace, env, loadSdk = () => import('@netlify/blobs')) {
  const mod = await loadSdk();
  const getStore = mod.getStore ?? (mod.default && mod.default.getStore);
  if (typeof getStore !== 'function') {
    throw new Error('@netlify/blobs exposes no getStore');
  }
  // getStore() picks up SITE_ID / token from the runtime environment itself, from the
  // context adoptBlobsContext() put there, or from the two variables an operator sets
  // when the platform has not handed the function any credentials of its own.
  const siteID = typeof env.BLOBS_SITE_ID === 'string' ? env.BLOBS_SITE_ID : '';
  const token = typeof env.BLOBS_TOKEN === 'string' ? env.BLOBS_TOKEN : '';
  const name = safeNamespace(namespace);
  const store = siteID !== '' && token !== ''
    ? getStore({ name, siteID, token })
    : getStore({ name });

  const metaOf = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? m : null);
  const seconds = (v) => {
    if (v === undefined || v === null) {
      return 0;
    }
    const d = v instanceof Date ? v : new Date(v);
    const t = d.getTime();
    return Number.isFinite(t) ? Math.floor(t / 1000) : Math.trunc(Number(v));
  };
  const read = async (result) => {
    if (result === null || result === undefined) {
      return null;
    }
    if (typeof result === 'string') {
      return Buffer.from(result, 'latin1');
    }
    const raw = result.data !== undefined ? result.data : result;
    if (raw === null || raw === undefined) {
      return null;
    }
    if (typeof raw === 'string') {
      return Buffer.from(raw, 'latin1');
    }
    return Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw);
  };

  /**
   * The write clock. getMetadata() returns {etag, metadata} and list() returns
   * {key, etag} per entry: neither carries a timestamp, so without this every
   * blobs entry would age from 1970 and the gc sweeps would delete fresh jobs,
   * fresh build records and finished mp4s on their first tick.
   */
  const STAMP = '_kv_written_at';
  const customOf = (m) => {
    const outer = metaOf(m);
    if (!outer) {
      return null;
    }
    return outer.custom !== undefined ? metaOf(outer.custom) : outer;
  };
  const stampIn = (meta) => {
    const out = {};
    for (const [k, v] of Object.entries(metaOf(meta) ?? {})) {
      if (k !== STAMP) {
        out[k] = v;
      }
    }
    out[STAMP] = Math.floor(Date.now() / 1000);
    return out;
  };
  /** Splits the stored metadata back into what the caller wrote and when. */
  const unstamp = (stored) => {
    const m = customOf(stored);
    const at = Number(m && m[STAMP]);
    const meta = {};
    for (const [k, v] of Object.entries(m ?? {})) {
      if (k !== STAMP) {
        meta[k] = v;
      }
    }
    return {
      meta: Object.keys(meta).length > 0 ? meta : null,
      createdAt: Number.isFinite(at) ? Math.trunc(at) : 0,
    };
  };

  const kv = {
    driver: 'blobs',
    namespace,
    atomicGuard: true,

    async get(key) {
      assertKey(key);
      return read(await store.get(key, { type: 'arrayBuffer' }));
    },

    async getWithMeta(key) {
      assertKey(key);
      const res = await store.getWithMetadata(key, { type: 'arrayBuffer' });
      const data = await read(res);
      if (data === null) {
        return null;
      }
      const { meta, createdAt } = unstamp(res && res.metadata ? res.metadata : null);
      return { data, meta, createdAt };
    },

    /**
     * The blobs api has no ranged read at any sdk version: get() sends no Range
     * header and there is no getRange, so the slice is cut from the whole object
     * here. The 20 MB output ceiling is what keeps one of these readable.
     * The answers match the filesystem driver one for one: null for an absent
     * key, an empty slice with the true total for an unsatisfiable range.
     */
    async getRange(key, start, endInclusive) {
      assertKey(key);
      const whole = await kv.get(key);
      if (whole === null) {
        return null;
      }
      const total = whole.length;
      const from = Math.max(0, Math.trunc(Number(start) || 0));
      let to = endInclusive === null || endInclusive === undefined || !Number.isFinite(Number(endInclusive))
        ? total - 1
        : Math.trunc(Number(endInclusive));
      if (to > total - 1) {
        to = total - 1;
      }
      if (from > to || from >= total) {
        return { data: Buffer.alloc(0), total };
      }
      return { data: whole.subarray(from, to + 1), total };
    },

    async put(key, value, meta = null) {
      assertKey(key);
      await store.set(key, toBuffer(value), { metadata: stampIn(meta) });
    },

    /**
     * Create-if-absent, which is what the build lock wants. onlyIfNew is the
     * atomic version and the sdk answers a lost race with {modified: false}.
     * The read in front of it is not decoration: an sdk older than 10 takes only
     * {metadata} out of these options, so onlyIfNew is ignored and the put lands
     * anyway — the read keeps that build from taking a lock someone else holds,
     * and leaves one round trip of race between two first writers, which is what
     * the ttl and the README cover.
     */
    async putIfNotExists(key, value, meta = null) {
      assertKey(key);
      const buf = toBuffer(value);
      const options = { metadata: stampIn(meta) };
      if (await store.get(key, { type: 'arrayBuffer' }) !== null) {
        return false;
      }
      let res;
      try {
        res = await store.set(key, buf, { ...options, onlyIfNew: true });
      } catch {
        return false; // a store fault answers "someone else holds it"; the ttl clears it
      }
      if (res && typeof res.modified === 'boolean') {
        return res.modified;
      }
      // No conditional support: the set above wrote the value, and the read said
      // the key was free, so this side of the race is the one that won.
      return true;
    },

    async del(key) {
      assertKey(key);
      await store.delete(key);
    },

    /**
     * {key, meta, createdAt} for every key, sorted, the whole store in one page.
     * The metadata comes from a HEAD per key, never from a get: the sweep that
     * ages entries out runs over the files namespace, where the bodies are video.
     */
    async list(prefix = '') {
      const res = await store.list(prefix === '' ? {} : { prefix });
      const entries = (res ? (res.blobs ?? res.keys ?? []) : [])
        .map((entry) => (typeof entry === 'string' ? { key: entry } : entry))
        .filter((entry) => entry && typeof entry.key === 'string');
      const out = await Promise.all(entries.map(async (entry) => {
        let stamp = unstamp(entry.metadata !== undefined ? entry.metadata : null);
        if (stamp.meta === null && stamp.createdAt === 0 && typeof store.getMetadata === 'function') {
          try {
            const md = await store.getMetadata(entry.key);
            stamp = unstamp(md && md.metadata ? md.metadata : null);
          } catch {
            stamp = { meta: null, createdAt: 0 };
          }
        }
        return {
          key: entry.key,
          meta: stamp.meta,
          createdAt: stamp.createdAt || seconds(entry.lastModified ?? entry.last_modified),
        };
      }));
      out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return out;
    },
  };

  // A store that cannot answer a trivial probe is not usable; force the fallback.
  await store.list({ prefix: '' }).catch(() => {
    throw new Error('blob store is not reachable');
  });
  return kv;
}

export const __testing = { assertKey, toBuffer, safeNamespace, makeBlobsKv };
