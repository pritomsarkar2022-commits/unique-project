import crypto from 'node:crypto';
import net from 'node:net';
import { cfg } from '../config.mjs';
import { phpInt, phpTrim } from '../support.mjs';
import { openKv } from '../storage/kv.mjs';

/**
 * Port of lib/Net/Throttle.php: the flat-file rate limit.
 *
 * One bucket per sha1(key), stored as the json the php wrote — {start, hits} — under
 * the kv namespace 'rate' instead of storage/rate. The arithmetic is untouched: the
 * bucket is reused while start + window > now, hits is counted before the decision,
 * so a caller is allowed exactly `limit` hits, and retryAfter is the end of the
 * window clamped to at least one second.
 */

/** sha1($key) over a latin1 byte string. */
export function bucketKey(key) {
  return crypto.createHash('sha1').update(Buffer.from(String(key), 'latin1')).digest('hex');
}

/**
 * The whole of hit()'s arithmetic, with the storage already read: the bucket as it
 * stands plus this request. Exported so the differential oracle can drive it with
 * the same start/hits/now/limit/window grid php was run through.
 *
 * @returns {{allowed: boolean, retryAfter: number, bucket: {start: number, hits: number}}}
 */
export function bucketDecision(prev, now, limit, window) {
  let bucket = { start: now, hits: 0 };
  if (prev !== null && prev !== undefined && typeof prev === 'object' && !Array.isArray(prev)
    && phpInt(prev.start ?? 0) + window > now) {
    bucket = { start: prev.start, hits: prev.hits };
  }
  bucket.hits = phpInt(bucket.hits) + 1;
  const allowed = bucket.hits <= limit;
  const retryAfter = Math.max(1, phpInt(bucket.start) + window - now);
  return { allowed, retryAfter, bucket };
}

export class Throttle {
  /**
   * @param {{kv?: object|Promise<object>, now?: () => number, random?: () => number}} [deps]
   *        now and random are injectable so a test can walk a whole window without
   *        sleeping and can force the 1-in-50 gc roll.
   */
  constructor({kv, now, random} = {}) {
    this._kv = kv ?? null;
    this.now = now ?? (() => Math.floor(Date.now() / 1000));
    this.random = random ?? Math.random;
  }

  async store() {
    if (this._kv === null) {
      this._kv = openKv('rate');
    }
    return this._kv;
  }

  /** @returns {Promise<{allowed: boolean, retryAfter: number}>} */
  async hit(key, limit = 12, window = 60) {
    const kv = await this.store();
    const k = bucketKey(key) + '.json';
    const now = this.now();
    let prev = null;
    const raw = await kv.get(k).catch(() => null);
    if (raw !== null) {
      try {
        prev = JSON.parse(raw.toString('latin1'));
      } catch {
        prev = null; // json_decode() of a broken bucket is null, and !is_array() starts a new one
      }
    }
    const { allowed, retryAfter, bucket } = bucketDecision(prev, now, limit, window);
    // is_writable($dir) guarded the php write; a store that refuses to take the
    // bucket must not turn into a 500, so the decision still stands when this fails.
    await kv.put(k, JSON.stringify(bucket), { touched: now }).catch(() => {});
    await this.maybeGc();
    return { allowed, retryAfter };
  }

  /** mt_rand(1, 50) !== 1 -> skip. Shared plans count inodes; every visitor leaves one entry. */
  async maybeGc() {
    if (this.randInt(1, 50) !== 1) {
      return false;
    }
    const kv = await this.store();
    const now = this.now();
    for (const entry of await kv.list('')) {
      // filemtime was "last written"; blobs' createdAt is not, so meta.touched
      // carries the same meaning on both drivers.
      const touched = entry.meta && Number.isFinite(Number(entry.meta.touched)) ? Number(entry.meta.touched) : entry.createdAt;
      if (now - touched > 3600) {
        await kv.del(entry.key).catch(() => {});
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
   * Who a bucket belongs to. The socket address is the only key a caller cannot
   * choose, so the forwarded headers are read only when the operator says this
   * install really does sit behind a proxy: a forgeable key is no limit at all.
   *
   * php read one flat $_SERVER; a Netlify Function hands the request to you as a
   * header map, so this port looks each name up in either container: the php-style
   * HTTP_* key, the lower-cased header name and the camelCase one the same event
   * object uses. A port that read only one spelling would silently fall back to a
   * shared NAT address for every visitor.
   *
   * x-nf-client-connection-ip is Netlify's own record of the socket address. It is
   * honoured only under the same trust_proxy_ip switch as the two php headers: on
   * any other host the name means nothing and a client can put it in a request,
   * which is precisely the forgery the switch exists to refuse. It is tried first,
   * because on Netlify it is the value the platform stamped itself.
   */
  static clientKey(server = {}, headers = {}) {
    const ip = String(field(server, 'REMOTE_ADDR') ?? 'cli');
    if (!asBool(cfg('security.trust_proxy_ip', false))) {
      return ip;
    }
    for (const name of ['HTTP_X_NF_CLIENT_CONNECTION_IP', 'HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR']) {
      const raw = field(server, name) ?? field(headers, name);
      const candidate = phpTrim(String(raw === undefined ? '' : raw).split(',')[0]);
      if (validateIp(candidate) !== false) {
        return candidate;
      }
    }
    return ip;
  }
}

/**
 * One $_SERVER / event.headers lookup. An entry is only ever read under its own
 * name — there is no loose substring match — so a REMOTE_ADDR-shaped value can never
 * stand in for a forwarding header the request did not send.
 */
function field(container, name) {
  if (container === null || container === undefined || typeof container !== 'object') {
    return undefined;
  }
  const aliases = [name, name.toLowerCase(), ...phpHeaderAlias(name)];
  for (const key of Object.keys(container)) {
    if (aliases.includes(key)) {
      return container[key];
    }
  }
  return undefined;
}

/**
 * The spellings one php name takes outside $_SERVER: REMOTE_ADDR becomes
 * remoteAddr on a hand-built server object, and HTTP_CF_CONNECTING_IP arrives as
 * cf-connecting-ip on event.headers or cfConnectingIp on an sdk event.
 */
function phpHeaderAlias(name) {
  if (name === 'REMOTE_ADDR') {
    return ['remoteAddr'];
  }
  if (!name.startsWith('HTTP_')) {
    return [];
  }
  const underscored = name.slice(5).toLowerCase();
  return [underscored.replace(/_/g, '-'), underscored.replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase())];
}

/** (bool) $v for a config flag: "", "0", 0, null and false are all off. */
function asBool(v) {
  if (v === null || v === undefined || v === false) {
    return false;
  }
  if (typeof v === 'number') {
    return v !== 0;
  }
  const s = String(v);
  return s !== '' && s !== '0';
}

/**
 * filter_var($candidate, FILTER_VALIDATE_IP).
 *
 * net.isIP agrees with php on every shape probed in parity/test-stores.mjs — it
 * refuses leading-zero octets, trailing dots, whitespace and an ipv4 tail after
 * seven groups — except that it accepts a link-local scope id ("fe80::1%eth0"),
 * which php refuses. The '%' test closes that gap.
 */
export function validateIp(candidate) {
  if (typeof candidate !== 'string' || candidate.includes('%')) {
    return false;
  }
  return net.isIP(candidate) !== 0 ? candidate : false;
}
