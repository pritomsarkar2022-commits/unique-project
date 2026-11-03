import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PHP = process.env.PHP_BIN || path.join(here, '..', 'tools', 'php', 'php.exe');
const ORACLE = path.join(here, 'oracle.php');

/** True when a usable PHP exists, so suites can skip loudly instead of passing quietly. */
export function phpAvailable() {
  try {
    execFileSync(PHP, ['-v'], { encoding: 'utf8', timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run probes through the php oracle. Each probe is {id, fn, args}.
 * Returns a map of id -> {ok, res, err}.
 *
 * A suite can name its own oracle file, so new probes never have to share the
 * one switch the engine tests use.
 */
export function oracleRun(probes, oracle = ORACLE) {
  const script = path.isAbsolute(oracle) ? oracle : path.join(here, oracle);
  const out = execFileSync(PHP, [script], {
    input: JSON.stringify(probes),
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout: 120000,
  });
  const map = new Map();
  for (const line of out.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const rec = JSON.parse(line);
    map.set(rec.id, rec);
  }
  return map;
}

export class Diff {
  constructor() {
    this.pass = 0;
    this.failures = [];
  }

  ok(label, cond, detail = '') {
    if (cond) {
      this.pass++;
      return true;
    }
    this.failures.push(label + (detail ? ' -- ' + detail : ''));
    return false;
  }

  /** Deep equality of JSON values; buffers compare as bytes, and a failure names the path. */
  same(label, jsValue, phpValue) {
    const a = JSON.stringify(normalise(jsValue));
    const b = JSON.stringify(normalise(phpValue));
    if (a === b) {
      return this.ok(label, true);
    }
    const where = firstDiff(normalise(jsValue), normalise(phpValue));
    return this.ok(label, false, `at ${where.path}: js=${trunc(where.js, 120)} php=${trunc(where.php, 120)}`);
  }

  report(title) {
    console.log(`\n${title}`);
    for (const f of this.failures) {
      console.log('  [FAIL] ' + f);
    }
    console.log(`  ${this.pass} matched, ${this.failures.length} diverged`);
    return this.failures.length === 0;
  }
}

function normalise(v) {
  if (Buffer.isBuffer(v)) {
    return v.toString('base64');
  }
  if (v instanceof Uint8Array) {
    return Buffer.from(v).toString('base64');
  }
  if (Array.isArray(v)) {
    return v.map(normalise);
  }
  if (v && typeof v === 'object') {
    const out = {};
    // Sorted so that two objects with the same keys but a different insertion
    // order compare equal; PHP and this port do not build their arrays in the
    // same order, and only the key set and values matter.
    for (const k of Object.keys(v).sort()) {
      out[k] = normalise(v[k]);
    }
    return out;
  }
  return v;
}

/** Where two already normalised values first stop agreeing, as a readable path. */
function firstDiff(a, b, path = '$') {
  if (a === b) {
    return { path, js: a, php: b };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { path: `${path}.length`, js: a.length, php: b.length };
    }
    for (let i = 0; i < a.length; i++) {
      const sub = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (sub.js !== sub.php) {
        return sub;
      }
    }
    return { path, js: a, php: b };
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
      if (!(k in a) || !(k in b)) {
        return { path: `${path}.${k}`, js: a[k], php: b[k] };
      }
      const sub = firstDiff(a[k], b[k], `${path}.${k}`);
      if (sub.js !== sub.php) {
        return sub;
      }
    }
  }
  return { path, js: a, php: b };
}

function trunc(s, max = 400) {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > max ? str.slice(0, max) + '...' : str;
}

/** A small deterministic PRNG so a fuzz run can be reproduced from its seed. */
export function rng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function makeRng(seed = 20261103) {
  const r = rng(seed);
  const api = {
    r,
    int: (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(r() * list.length)],
    bytes: (n) => {
      const b = Buffer.alloc(n);
      for (let i = 0; i < n; i++) {
        b[i] = api.int(0, 255);
      }
      return b;
    },
  };
  return api;
}
