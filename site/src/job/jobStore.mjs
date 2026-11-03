import crypto from 'node:crypto';
import { cfg } from '../config.mjs';
import { ExtractException } from '../errors.mjs';
import { parseUrl, phpInt } from '../support.mjs';
import { Source } from '../extractor/source.mjs';
import { openKv } from '../storage/kv.mjs';

/**
 * Port of lib/Job/JobStore.php: the analysis of one page url, kept as one small
 * json object, plus the secret that signs every relay url built from it.
 *
 * The php store was a directory of "<id>.json" files under storage/jobs; here the
 * directory is the kv namespace 'jobs' and the file name is the key, so an id still
 * maps to exactly one record and the gc still ages by mtime.
 *
 * `$secret = bin2hex(random_bytes(16))` and
 * `$id = substr(hash_hmac('sha256', $b->pageUrl . $secret, 'vd-job'), 0, 20)`:
 * the page url is concatenated with the fresh secret before the hmac, so the id is
 * unguessable but stays a pure function of (pageUrl, secret), which is what the
 * differential oracle pins.
 */

/** /^[a-f0-9]{20}$/ as php wrote it. */
export function validJobId(id) {
  return typeof id === 'string' && /^[a-f0-9]{20}$/.test(id);
}

/** hash_hmac('sha256', $pageUrl . $secret, 'vd-job') truncated to 20 hex chars. */
export function jobId(pageUrl, secret) {
  return hmacHex(Buffer.from(String(pageUrl) + String(secret), 'latin1'), 'vd-job').slice(0, 20);
}

/** substr(hash_hmac('sha256', $url, $record['secret']), 0, 32) */
export function jobSign(secret, url) {
  return hmacHex(Buffer.from(String(url), 'latin1'), String(secret)).slice(0, 32);
}

function hmacHex(data, key) {
  return crypto.createHmac('sha256', Buffer.from(String(key), 'latin1')).update(data).digest('hex');
}

/** hash_equals(): same length or false, and a constant-time compare either way. */
export function hashEquals(known, user) {
  const a = Buffer.from(String(known), 'latin1');
  const b = Buffer.from(String(user), 'latin1');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * ExtractorRegistry::registrable(), copied here rather than imported because the
 * registry is another module's port and JobStore needs it to fill pageHost/thumbHost.
 * parity/test-stores.mjs diffs every line of it against the php original.
 */
export function registrable(host) {
  const h = asciiLower(phpTrimDots(host));
  const parts = h.split('.');
  if (parts.length < 2) {
    return h;
  }
  const tails = ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'mil', 'ne', 'or', 'go', 'lg'];
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  if (last.length === 2 && tails.includes(second)) {
    return parts.slice(-3).join('.');
  }
  return second + '.' + last;
}

/** trim($host, '.') */
function phpTrimDots(s) {
  return String(s).replace(/^\.+/, '').replace(/\.+$/, '');
}

/** strtolower(): byte-wise ascii folding, like php's on a latin1 byte string. */
function asciiLower(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/** parse_url($url, PHP_URL_HOST) ?: '' — a missing host, a false parse and the host
 * "0" all become the empty string, exactly like php's `?:`. */
function hostOf(url) {
  const p = parseUrl(String(url));
  if (!p || typeof p !== 'object') {
    return '';
  }
  const host = p.host === undefined ? '' : p.host;
  return host ? String(host) : '';
}

export class JobStore {
  /**
   * @param {{kv?: object|Promise<object>, files?: object|Promise<object>,
   *          now?: () => number, random?: () => number}} [deps]
   *        kv/files let a test inject a namespace; now and random make the ttl and
   *        the gc probability testable without sleeping or rolling dice.
   */
  constructor({kv, files, now, random} = {}) {
    this._kv = kv ?? null;
    this._files = files ?? null;
    this.now = now ?? (() => Math.floor(Date.now() / 1000));
    this.random = random ?? Math.random;
  }

  async jobs() {
    if (this._kv === null) {
      this._kv = openKv('jobs');
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
  async create(bundle) {
    const kv = await this.jobs();
    await this.maybeGc();
    const secret = crypto.randomBytes(16).toString('hex'); // bin2hex(random_bytes(16))
    const b = bundle;
    const now = this.now();
    const record = {
      id: jobId(b.pageUrl, secret),
      secret,
      created: now,
      expires: now + phpInt(cfg('jobs.ttl', 1800)),
      provider: b.provider,
      title: b.title,
      thumbnail: b.thumbnail,
      pageUrl: b.pageUrl,
      pageHost: registrable(hostOf(b.pageUrl)),
      finalUrl: b.finalUrl,
      thumbHost: registrable(hostOf(b.thumbnail === null || b.thumbnail === undefined ? '' : b.thumbnail)),
      notices: b.notices,
      confidence: b.confidence,
      sources: (b.sources ?? []).map((s) => encodeSource(s)),
    };
    await this.write(record.id, record);
    return record;
  }

  async find(id) {
    if (!validJobId(id)) {
      return null;
    }
    const kv = await this.jobs();
    const raw = await kv.get(id + '.json');
    if (raw === null) {
      return null;
    }
    let rec;
    try {
      rec = JSON.parse(raw.toString('latin1'));
    } catch {
      rec = null;
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec) || phpInt(rec.expires ?? 0) < this.now()) {
      await kv.del(id + '.json').catch(() => {});
      return null;
    }
    return rec;
  }

  async touch(id, record) {
    await this.write(id, record);
  }

  source(record, sourceId) {
    const list = record && record.sources ? record.sources : [];
    for (const data of list) {
      // ($data['id'] ?? '') === $sourceId: an existing key wins even when its value
      // is "" or 0, and a value of the wrong type fails the === just as php's does.
      const id = data && typeof data === 'object' && data.id !== undefined && data.id !== null ? data.id : '';
      if (id === sourceId) {
        return decodeSource(data);
      }
    }
    return null;
  }

  /** Sign a url the browser is allowed to pull through the relay. */
  sign(record, url) {
    return jobSign(record.secret ?? '', url);
  }

  verify(record, url, sig) {
    return hashEquals(this.sign(record, url), sig);
  }

  async write(id, record) {
    const kv = await this.jobs();
    let json;
    try {
      // json_encode($record, JSON_UNESCAPED_SLASHES). JSON.stringify leaves "/"
      // alone already, so no replacer is needed; it does escape non-ascii the same
      // way php's json_encode does, and the value round-trips back byte for byte.
      json = JSON.stringify(record);
      if (json === undefined) {
        throw new TypeError('nothing to encode');
      }
    } catch {
      throw new ExtractException('Could not save the analysis result.');
    }
    await kv.put(id + '.json', json);
  }

  /** mt_rand(1, 100) > (int) (cfg('jobs.gc_probability', 0.05) * 100) -> skip. */
  async maybeGc() {
    if (this.randInt(1, 100) > phpInt(cfg('jobs.gc_probability', 0.05) * 100)) {
      return false;
    }
    const maxAge = phpInt(cfg('jobs.max_age', 86400));
    const now = this.now();
    for (const store of [await this.jobs(), await this.filesStore()]) {
      const entries = await store.list('');
      for (const entry of entries) {
        if (now - ageOf(entry) > maxAge) {
          await store.del(entry.key).catch(() => {});
        }
      }
    }
    return true;
  }

  /** mt_rand(1, $max) over an injectable uniform source in [0, 1). */
  randInt(min, max) {
    const span = max - min + 1;
    const r = Number(this.random());
    const unit = Number.isFinite(r) ? Math.min(0.999999999999, Math.max(0, Math.abs(r))) : 0;
    return min + Math.floor(unit * span);
  }
}

/**
 * JobStore::encode(): get_object_vars($s) and then the headers re-assigned over
 * itself. The javascript class declares its fields in the same order as php, so the
 * spread lands in the same key order and the headers line is a no-op in both.
 */
export function encodeSource(s) {
  const rec = { ...s };
  rec.headers = s.headers;
  return rec;
}

/**
 * JobStore::decode(): Source::make() from url/kind, then every other key the class
 * actually declares. property_exists($s, $k) is Object.hasOwn here, because after
 * make() every declared property of the javascript class is an own property; a key
 * the class does not know is dropped, so a record written by an older build cannot
 * smuggle a method onto a Source.
 */
export function decodeSource(rec) {
  const s = Source.make(String(rec.url ?? ''), String(rec.kind === undefined || rec.kind === null ? Source.MP4 : rec.kind));
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'url' || k === 'kind' || !Object.hasOwn(s, k)) {
      continue;
    }
    s[k] = v;
  }
  return s;
}

/** meta.touched when the writer left one, else the platform's creation time. */
function ageOf(entry) {
  const touched = entry.meta && Number.isFinite(Number(entry.meta.touched)) ? Number(entry.meta.touched) : null;
  return touched === null ? entry.createdAt : touched;
}

export const __testing = { ageOf, hostOf };
