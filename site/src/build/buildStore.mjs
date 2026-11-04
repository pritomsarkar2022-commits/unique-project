import crypto from 'node:crypto';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cfg } from '../config.mjs';
import { ExtractException } from '../errors.mjs';
import { appUrl as defaultAppUrl, phpInt, phpTrim } from '../support.mjs';
import { hashEquals } from '../job/jobStore.mjs';
import { kvRoot, openKv } from '../storage/kv.mjs';

/**
 * Port of lib/Build/BuildStore.php: the state of one "save as one MP4" build.
 *
 * php kept three files per build under storage/builds (state json, log, lock) and
 * one under storage/files (the mp4). Here the state, log and lock live in the kv
 * namespace 'builds', the mp4 bytes in 'files', and the only real file left is a
 * scratch path inside one invocation, because Mp4Builder writes as it muxes.
 */

/** /^[a-f0-9]{20}$/ as php wrote it. */
export function validBuildId(id) {
  return typeof id === 'string' && /^[a-f0-9]{20}$/.test(id);
}

/** substr(hash_hmac('sha256', $src->url . $secret, 'vd-build'), 0, 20) */
export function buildId(sourceUrl, secret) {
  return hmacHex(Buffer.from(String(sourceUrl) + String(secret), 'latin1'), 'vd-build').slice(0, 20);
}

/** substr(hash_hmac('sha256', 'file:' . $record['id'], $record['secret']), 0, 32) */
export function buildSign(secret, id) {
  return hmacHex(Buffer.from('file:' + String(id), 'latin1'), String(secret)).slice(0, 32);
}

function hmacHex(data, key) {
  return crypto.createHmac('sha256', Buffer.from(String(key), 'latin1')).update(data).digest('hex');
}

/**
 * round($value, $precision).
 *
 * php does not simply multiply and add 0.5: round() re-formats the multiplied value
 * with "%.14G" first (EG(precision) is 14), which is why round(0.145, 2) is 0.15 even
 * though 0.145 * 100 is 14.499999999999998 in binary. toPrecision(14) is the same
 * decimal re-format, so scale, re-format, then round half away from zero.
 *
 * php also stops rounding once the scaled value is that big: measured against the
 * reference, round(9.999999999999995e14, 0) still moves to 1e15 while
 * round(1125899906842623.5, 0), round(9007199254740991, 2) and round(1e21, 2) all
 * hand back the value they were given. Scaling, rounding and dividing a number that
 * large instead invents digits — the port returned 9007199254741000 for
 * 9007199254740991 — so it returns the value too. A duration is never this long, but
 * the probe suite reaches it, and the guard is three lines.
 */
export function roundTo(value, precision) {
  const v = Number(value);
  if (!Number.isFinite(v)) {
    return v;
  }
  const factor = Math.pow(10, precision);
  const scaled = Math.abs(v) * factor;
  if (scaled > 1e15) {
    return v;
  }
  const head = Number((v * factor).toPrecision(14));
  const whole = head >= 0 ? Math.floor(head + 0.5) : -Math.floor(-head + 0.5);
  return whole / factor;
}

/** urlencode($s) over a latin1 byte string: alnum and -_. stay, everything else is %XX. */
export function urlencodePhp(s) {
  const buf = Buffer.from(String(s), 'latin1');
  let out = '';
  for (const byte of buf) {
    const ch = byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '';
    if (/^[A-Za-z0-9\-_.]$/.test(ch)) {
      out += ch;
    } else if (byte === 0x20) {
      out += '+'; // php's urlencode spells a space "+", rawurlencode does not
    } else {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/** Where the per-invocation scratch files go. Blobs cannot be written to, so the
 * muxer needs a real path; /tmp is private to one invocation, which is exactly the
 * lifetime php's storage/files had per build. */
export function scratchRoot(env = process.env) {
  const fromEnv = env.VD_SCRATCH_DIR;
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return path.resolve(fromEnv);
  }
  if (env.VD_STORE === 'blobs' || env.NETLIFY !== undefined) {
    return path.join(os.tmpdir(), 'vd');
  }
  return path.join(kvRoot(env), 'scratch');
}

export class BuildStore {
  /**
   * @param {{kv?: object|Promise<object>, files?: object|Promise<object>,
   *          appUrl?: (q: string) => string|Promise<string>, scratchDir?: string,
   *          now?: () => number, random?: () => number, lockTtl?: number}} [deps]
   *        kv is the 'builds' namespace, files the 'files' namespace. appUrl is
   *        injected because the relay module owns url building; the default is
   *        support.appUrl with the configured base url. now/random make the ttl,
   *        the rounding and the gc probability testable without sleeping.
   */
  constructor({kv, files, appUrl, scratchDir, now, random, lockTtl} = {}) {
    this._kv = kv ?? null;
    this._files = files ?? null;
    this.appUrl = appUrl ?? ((query) => defaultAppUrl(query));
    this.scratchDir = scratchDir ?? scratchRoot();
    this.now = now ?? (() => Math.floor(Date.now() / 1000));
    this.random = random ?? Math.random;
    // php's lock was an flock: it died with the process. A lock that survives its
    // holder would wedge a build forever on a stateless runtime, so it expires.
    this.lockTtl = lockTtl ?? 120;
  }

  async builds() {
    if (this._kv === null) {
      this._kv = openKv('builds');
    }
    return this._kv;
  }

  async filesStore() {
    if (this._files === null) {
      this._files = openKv('files');
    }
    return this._files;
  }

  /** @returns {Promise<object>} the record, in the php array's key order */
  async create(job, src, segments, key, duration) {
    await this.maybeGc();
    const secret = crypto.randomBytes(16).toString('hex'); // bin2hex(random_bytes(16))
    const ttl = phpInt(cfg('build.ttl', 3600));
    const now = this.now();
    const jobTitle = job && job.title !== undefined && job.title !== null ? String(job.title) : '';
    const jobProvider = job && job.provider !== undefined && job.provider !== null ? String(job.provider) : '';
    const record = {
      id: buildId(src.url, secret),
      secret,
      job: job && job.id !== undefined && job.id !== null ? String(job.id) : '',
      provider: jobProvider,
      title: jobTitle,
      headers: src.headers,
      playlist: src.url,
      key: key === undefined ? null : key,
      segments,
      duration: roundTo(duration, 2),
      cursor: 0,
      bytes: 0,
      video_samples: 0,
      audio_samples: 0,
      params: null,
      ts_offset: 0,
      last_dts: null,
      last_delta: null,
      status: 'running',
      error: null,
      hint: null,
      note: null,
      // ($job['provider'] ?? 'video'): a provider that is present but "" stays "",
      // and fileName() is the one that falls back to the literal 'video'.
      filename: BuildStore.fileName(jobTitle, job && job.provider !== undefined && job.provider !== null ? String(job.provider) : 'video'),
      created: now,
      updated: now,
      expires: now + ttl,
    };
    await this.save(record);
    return record;
  }

  async find(id) {
    if (!validBuildId(id)) {
      return null;
    }
    const rec = await this.read(id);
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec) || phpInt(rec.expires ?? 0) < this.now()) {
      await this.discard(id);
      return null;
    }
    return rec;
  }

  async read(id) {
    const kv = await this.builds();
    const raw = await kv.get(id + '.json').catch(() => null);
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw.toString('latin1'));
    } catch {
      return null;
    }
  }

  async save(record) {
    const kv = await this.builds();
    record.updated = this.now(); // the key already exists, so the order is untouched
    let json;
    try {
      // json_encode($record, JSON_UNESCAPED_SLASHES): JSON.stringify leaves "/"
      // alone on its own, so the flags need no replacer here.
      json = JSON.stringify(record);
      if (json === undefined) {
        throw new TypeError('nothing to encode');
      }
    } catch {
      throw new ExtractException('Could not save the build state.', 'Storage is full or not writable.', 'io');
    }
    await kv.put(record.id + '.json', json);
  }

  /**
   * The four names php built from $this->fileDir / $this->buildDir, now as kv keys,
   * plus one real local path the muxer can append to inside a single invocation.
   * mp4/log/state are keys inside the namespaces paths() was configured with:
   * state, log and lock in 'builds', mp4 in 'files'.
   */
  paths(id) {
    return {
      mp4: `${id}.mp4`,
      log: `${id}.log`,
      state: `${id}.json`,
      scratch: path.join(this.scratchDir, 'files', `${id}.mp4`),
    };
  }

  /**
   * The partial file plus its sample log, for a tick that resumes an earlier one.
   *
   * php needed neither of these: Mp4Mux had a disk every request could see and
   * reopened the same two paths. Here the bytes live in storage between invocations,
   * so a resume reads both, and null means the first slice never got as far as
   * writing them.
   *
   * @returns {Promise<{mp4: Buffer, log: Buffer}|null>}
   */
  async readOutput(id) {
    if (!validBuildId(id)) {
      return null;
    }
    const p = this.paths(id);
    const kv = await this.builds();
    const files = await this.filesStore();
    const mp4 = await files.get(p.mp4).catch(() => null);
    if (mp4 === null) {
      return null;
    }
    const log = await kv.get(p.log).catch(() => null);
    return { mp4, log: log ?? Buffer.alloc(0) };
  }

  /**
   * One byte span of the finished file, for the route that hands it to a player.
   *
   * php opened the mp4 on disk with fopen() and fseek(); a blob has no seek, but the
   * storage API has a ranged read, so this is the same thing without the whole file
   * ever being held. null is a key that is not there, and `total` is the size the
   * route puts in Content-Range.
   *
   * @returns {Promise<{data: Buffer, total: number}|null>}
   */
  async readRange(id, start, endInclusive) {
    if (!validBuildId(id)) {
      return null;
    }
    const files = await this.filesStore();
    if (typeof files.getRange !== 'function') {
      return null;
    }
    return files.getRange(this.paths(id).mp4, start, endInclusive);
  }

  /** Both halves of the partial file travel together, or a resume rebuilds half a movie. */
  async writeOutput(id, mp4, log) {    if (!validBuildId(id)) {
      return;
    }
    const p = this.paths(id);
    const kv = await this.builds();
    const files = await this.filesStore();
    await files.put(p.mp4, mp4);
    await kv.put(p.log, log);
  }

  /**
   * php: fopen('<id>.lock', 'c+') + flock(LOCK_EX | LOCK_NB), or null when another
   * tick owns the build. Here the exclusive create is the guard — Blobs'
   * allowIfNotExists when the blobs driver is in play, an O_CREAT|O_EXCL lock file
   * on the filesystem driver — and a lock older than lockTtl is broken, because a
   * function invocation that timed out leaves no process behind to drop a flock.
   *
   * The lock is therefore ADVISORY across invocations: two workers can both hold it
   * for up to one round trip, which php's flock could not do.
   *
   * @returns {Promise<{key: string, token: string, kv: object}|null>}
   */
  async lock(id) {
    if (!validBuildId(id)) {
      return null;
    }
    const kv = await this.builds();
    const key = `${id}.lock`;
    const token = crypto.randomBytes(12).toString('hex');
    const take = () => (typeof kv.putIfNotExists === 'function'
      ? kv.putIfNotExists(key, token, { taken: this.now(), token })
      : takeWithoutGuard(kv, key, token, this.now()));
    if (await take()) {
      return { key, token, kv };
    }
    const held = await kv.getWithMeta(key).catch(() => null);
    if (held === null) {
      return await take() ? { key, token, kv } : null;
    }
    const takenAt = held.meta && Number.isFinite(Number(held.meta.taken))
      ? Number(held.meta.taken)
      : held.createdAt;
    if (this.now() - takenAt <= this.lockTtl) {
      return null; // another tick owns it, exactly like a busy flock
    }
    await kv.del(key).catch(() => {});
    if (await take()) {
      return { key, token, kv };
    }
    return null;
  }

  /**
   * php: flock(LOCK_UN) + fclose. Never throws: a tick that could not clean up its
   * lock must not fail the build it just finished. The token check is what keeps a
   * late release from deleting a lock another worker has since taken.
   */
  async release(lock) {
    if (!lock || !lock.kv || typeof lock.key !== 'string') {
      return;
    }
    try {
      const held = await lock.kv.getWithMeta(lock.key).catch(() => null);
      if (held !== null) {
        const ours = (held.data !== null && held.data !== undefined && held.data.toString('latin1') === lock.token)
          || (held.meta && held.meta.token === lock.token);
        if (ours) {
          await lock.kv.del(lock.key);
        }
      }
    } catch {
      // best effort, like the @ on the php unlink
    }
  }

  sign(record) {
    return buildSign(record.secret ?? '', record.id ?? '');
  }

  verify(record, sig) {
    return hashEquals(this.sign(record), sig);
  }

  /** Relay::appUrl() is injected; it may be async in the relay port, so this is too. */
  async fileUrl(record) {
    const query = 'r=file&build=' + record.id + '&s=' + this.sign(record)
      + '&name=' + urlencodePhp(String(record.filename ?? ''));
    return await this.appUrl(query);
  }

  async discard(id) {
    if (!validBuildId(id)) {
      return;
    }
    const p = this.paths(id);
    const kv = await this.builds();
    const files = await this.filesStore();
    await kv.del(p.state).catch(() => {});
    await kv.del(p.log).catch(() => {});
    await kv.del(`${id}.lock`).catch(() => {});
    await files.del(p.mp4).catch(() => {});
    // The scratch file only exists inside the invocation that made it; removing it
    // is tidy-up, not a correctness step. php unlinked the real file here.
    await fsp.rm(p.scratch, { force: true }).catch(() => {});
  }

  /** Same roll as JobStore's gc, over the build's own two directories. */
  async maybeGc() {
    if (this.randInt(1, 100) > phpInt(cfg('jobs.gc_probability', 0.05) * 100)) {
      return false;
    }
    const age = phpInt(cfg('build.max_age', 7200));
    const now = this.now();
    const builds = await this.builds();
    for (const entry of await builds.list('')) {
      if (now - ageOf(entry) > age) {
        await builds.del(entry.key).catch(() => {});
      }
    }
    const files = await this.filesStore();
    for (const entry of await files.list('')) {
      // glob($fileDir . '/*.mp4') — only finished media aged out here.
      if (entry.key.endsWith('.mp4') && now - ageOf(entry) > age) {
        await files.del(entry.key).catch(() => {});
      }
    }
    return true;
  }

  randInt(min, max) {
    const span = max - min + 1;
    const r = Number(this.random());
    const unit = Number.isFinite(r) ? Math.min(0.999999999999, Math.max(0, Math.abs(r))) : 0;
    return min + Math.floor(unit * span);
  }

  /**
   * File names travel to the browser in a header, so keep them to plain characters.
   *
   * Every step is a byte operation on a latin1 string. The first class strips the
   * non-ascii bytes a UTF-8 title brings with it, which is why "café" is "cf" here
   * and in php. preg_replace('/\s+/') without /u only knows the six ascii
   * whitespace bytes, so the class is spelled out rather than using javascript's
   * unicode \s; strlen()/substr() are byte counts, which a latin1 string gives.
   */
  static fileName(title, provider) {
    const base0 = phpTrim(String(title ?? '').replace(/[^A-Za-z0-9 ._-]+/g, ''));
    let base = base0.replace(/[ \t\n\r\x0B\x0C]+/g, '-');
    base = phpTrim(base, '-.');
    if (base === '' || base.length > 80) {
      base = provider !== '' ? provider : 'video';
    }
    return base.slice(0, 80) + '.mp4';
  }
}

/** Fallback when a driver exposes no atomic guard: still correct on one process. */
async function takeWithoutGuard(kv, key, token, now) {
  const existing = await kv.get(key).catch(() => null);
  if (existing !== null) {
    return false;
  }
  await kv.put(key, token, { taken: now, token });
  return true;
}

function ageOf(entry) {
  const touched = entry.meta && Number.isFinite(Number(entry.meta.touched)) ? Number(entry.meta.touched) : null;
  return touched === null ? entry.createdAt : touched;
}
