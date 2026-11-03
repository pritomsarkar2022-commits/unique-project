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
 *     put-on-blobs) and BuildStore's lock is an advisory create-if-absent put
 *     with a ttl, see kv.putIfNotExists().
 *   - Blobs' createdAt names the first write and does not move when a key is
 *     overwritten, while php's filemtime was "last touched". Anything that ages
 *     entries therefore reads meta.touched first and falls back to createdAt.
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
 * Which driver this environment asks for. Netlify sets NETLIFY in every function
 * build and invoke; VD_STORE lets a deploy pin or override the choice, and the
 * tests force 'fs'.
 */
export function selectDriver(env = process.env) {
  const forced = typeof env.VD_STORE === 'string' ? env.VD_STORE : '';
  if (forced === 'fs' || forced === 'filesystem') {
    return 'fs';
  }
  if (forced === 'blobs') {
    return 'blobs';
  }
  return env.NETLIFY !== undefined ? 'blobs' : 'fs';
}

/**
 * True when the selected driver gives a real atomic "create this key only if it
 * does not exist yet" put, which is what BuildStore's lock wants. The filesystem
 * driver also has one (an exclusive O_CREAT|O_EXCL create), so callers should
 * prefer kv.putIfNotExists(); this hook is here for the case where code wants to
 * know whether the platform, rather than a lock file, is holding the lock.
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
 * Opens one namespace. Never throws at import time and never throws when the
 * blobs driver cannot be used: an uninstalled package, a missing store or a
 * dead network falls back to the filesystem, because failing the request would
 * turn a storage hiccup into a site outage.
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
      warn(`kv: blobs driver unavailable for "${namespace}" (${err && err.message ? err.message : err}); using the filesystem`);
    }
  }
  return makeFsKv(namespace, root);
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
 */
async function makeBlobsKv(namespace, env) {
  const mod = await import('@netlify/blobs');
  const getStore = mod.getStore ?? (mod.default && mod.default.getStore);
  if (typeof getStore !== 'function') {
    throw new Error('@netlify/blobs exposes no getStore');
  }
  // getStore() picks up SITE_ID / token from the runtime environment itself.
  const store = getStore({ name: safeNamespace(namespace) });

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
      const meta = metaOf(res && res.metadata ? res.metadata : null);
      return {
        data,
        meta: meta && (meta.custom !== undefined ? metaOf(meta.custom) : meta),
        createdAt: seconds(meta && (meta.createdAt ?? meta.created)),
      };
    },

    async getRange(key, start, endInclusive) {
      assertKey(key);
      const from = Math.max(0, Math.trunc(Number(start) || 0));
      const opts = { type: 'arrayBuffer' };
      if (Number.isFinite(from)) {
        opts.start = from;
      }
      if (endInclusive !== null && endInclusive !== undefined && Number.isFinite(Number(endInclusive))) {
        opts.end = Math.trunc(Number(endInclusive));
      }
      let data = null;
      try {
        data = await read(await store.getRange(key, opts));
      } catch {
        data = null;
      }
      let total = null;
      if (typeof store.getMetadata === 'function') {
        try {
          const md = await store.getMetadata(key, { type: 'arrayBuffer' });
          if (md && Number.isFinite(Number(md.size))) {
            total = Number(md.size);
          }
        } catch {
          total = null;
        }
      }
      if (total === null) {
        // No usable size for the object: read the whole key so the total the
        // caller puts in Content-Range is still the truth, not a guess.
        const whole = await kv.get(key);
        if (whole === null) {
          return null;
        }
        return { data: whole.subarray(from, opts.end === undefined ? undefined : opts.end + 1), total: whole.length };
      }
      if (data === null) {
        return null;
      }
      return { data, total };
    },

    async put(key, value, meta = null) {
      assertKey(key);
      await store.set(key, toBuffer(value), meta === null || meta === undefined ? undefined : { metadata: meta });
    },

    /** Blobs' allowIfNotExists is the atomic guard. A rejected put means either a
     *  conflict or a store fault; both answer "someone else holds it", and the ttl
     *  on the lock keeps a store fault from wedging a build forever. */
    async putIfNotExists(key, value, meta = null) {
      assertKey(key);
      try {
        await store.set(key, toBuffer(value), {
          allowIfNotExists: true,
          ...(meta === null || meta === undefined ? {} : { metadata: meta }),
        });
        return true;
      } catch {
        return false;
      }
    },

    async del(key) {
      assertKey(key);
      await store.delete(key);
    },

    async list(prefix = '') {
      const res = await store.list({ prefix });
      const entries = res ? (res.keys ?? res.blobs ?? []) : [];
      const out = [];
      for (const entry of entries) {
        const key = typeof entry === 'string' ? entry : entry.key;
        if (typeof key !== 'string') {
          continue;
        }
        let meta = metaOf(entry && (entry.custom ?? entry.metadata));
        let createdAt = entry ? seconds(entry.lastModified ?? entry.createdAt) : 0;
        if (meta === null && typeof store.getWithMetadata === 'function') {
          try {
            const withMeta = await store.getWithMetadata(key, { type: 'arrayBuffer' });
            meta = metaOf(withMeta && withMeta.metadata ? withMeta.metadata.custom ?? withMeta.metadata : null);
          } catch {
            meta = null;
          }
        }
        out.push({ key, meta, createdAt });
      }
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

export const __testing = { assertKey, toBuffer, safeNamespace };
