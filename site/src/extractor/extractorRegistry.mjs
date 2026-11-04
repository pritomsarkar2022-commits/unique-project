import { phpUrlComponent } from './source.mjs';
import { GenericExtractor } from './genericExtractor.mjs';
import { strtolowerBytes } from './baseExtractor.mjs';

/**
 * Port of lib/Extractor/ExtractorRegistry.php: pick the extractor for a url, or the
 * generic one.
 *
 * ## ASYNC - read this before calling it
 *
 * php builds the extractor list in its constructor, where every class is already
 * loaded. ES modules have to be awaited, so the list is built in `await init()`,
 * which both `forUrl()` and `knownHosts()` call on first use. `forUrl` is therefore
 * **`async forUrl(url)`** and `knownHosts` is **`async knownHosts()`**: the router and
 * the analysers must `await` them.
 *
 * ## How the twelve host extractors plus generic plug in
 *
 * HOST_EXTRACTORS below is the php constructor list, in the same order, naming the
 * module and the class a ported extractor must export. LOADERS below it names the
 * same module again as a literal `import()` specifier, and both lines are needed:
 * Netlify builds a function with esbuild, which only follows a dynamic import it can
 * read as a string constant. `await import(variable)` survives type-checking but
 * resolves against the single bundled file at runtime, where no extractor module
 * exists on disk - so every extractor looks "missing", and a deploy serves a site
 * with no hosts and no analysers. An entry whose module is not there is still
 * skipped (recorded in `registry.missingModules`) rather than crashing the site.
 */

/** Registration order is loadable: forUrl() scores with strict `>`, so ties go to the
 * extractor that appears first here. Keep it byte-identical to the php constructor. */
export const HOST_EXTRACTORS = [
  ['./blockedExtractor.mjs', 'BlockedExtractor'],
  ['./youtubeExtractor.mjs', 'YouTubeExtractor'],
  ['./streamtapeExtractor.mjs', 'StreamtapeExtractor'],
  ['./streamfileExtractor.mjs', 'StreamfileExtractor'],
  ['./luluvidoExtractor.mjs', 'LuluvidoExtractor'],
  ['./firestreamExtractor.mjs', 'FirestreamExtractor'],
  ['./playmateExtractor.mjs', 'PlaymateExtractor'],
  ['./vidaraExtractor.mjs', 'VidaraExtractor'],
  ['./vixeoExtractor.mjs', 'VixeoExtractor'],
  ['./cloudfamExtractor.mjs', 'CloudfamExtractor'],
  ['./mxdropExtractor.mjs', 'MxdropExtractor'],
  ['./xfsExtractor.mjs', 'XfsExtractor'],
  // Hosts without a reader still work when they expose a plain .mp4/.m3u8, including
  // ones that hide it inside packed player js.
  ['./genericExtractor.mjs', 'GenericExtractor'],
];

/**
 * The literal importers, one per module the plan can name. `() => import('./x.mjs')`
 * is what esbuild reads; the specifier has to be a string written in this file, so
 * this object is the price the port pays for running on a bundled platform.
 */
const importers = {
  './blockedExtractor.mjs': () => import('./blockedExtractor.mjs'),
  './youtubeExtractor.mjs': () => import('./youtubeExtractor.mjs'),
  './streamtapeExtractor.mjs': () => import('./streamtapeExtractor.mjs'),
  './streamfileExtractor.mjs': () => import('./streamfileExtractor.mjs'),
  './luluvidoExtractor.mjs': () => import('./luluvidoExtractor.mjs'),
  './firestreamExtractor.mjs': () => import('./firestreamExtractor.mjs'),
  './playmateExtractor.mjs': () => import('./playmateExtractor.mjs'),
  './vidaraExtractor.mjs': () => import('./vidaraExtractor.mjs'),
  './vixeoExtractor.mjs': () => import('./vixeoExtractor.mjs'),
  './cloudfamExtractor.mjs': () => import('./cloudfamExtractor.mjs'),
  './mxdropExtractor.mjs': () => import('./mxdropExtractor.mjs'),
  './xfsExtractor.mjs': () => import('./xfsExtractor.mjs'),
  './genericExtractor.mjs': () => import('./genericExtractor.mjs'),
};

/** The plan's module path -> its importer. A path with no importer reads as unwritten. */
const LOADERS = new Map(HOST_EXTRACTORS.map(([modulePath]) => [modulePath, importers[modulePath]]));

/** php's two-letter ccTLD tail table: a "co.uk" suffix belongs to the registrable name. */
const CC_TAILS = ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'mil', 'ne', 'or', 'go', 'lg'];

/** Classes this file already imports, so the fallback can never be unresolvable. */
const STATIC_CLASSES = new Map([['GenericExtractor', GenericExtractor]]);

export class ExtractorRegistry {
  /** @type {object[]} the registered extractors, in registration order */
  #extractors = [];

  /** @type {string[]} host extractor modules that were not there when the list was built */
  missingModules = [];

  #ready;
  #plan;
  #initPromise = null;

  /**
   * @param {{extractors?: object[], skipDefaults?: boolean}} options
   *   `extractors` registers exactly these and loads nothing else (the test seam);
   *   `skipDefaults` starts from an empty list and still registers nothing lazily.
   *   With neither, this is the php registry: the twelve host extractors plus generic
   *   are imported the first time forUrl()/knownHosts() is awaited.
   */
  constructor(options = {}) {
    const list = options.extractors ?? null;
    if (list !== null) {
      for (const e of list) {
        this.register(e);
      }
      this.#ready = true;
      this.#plan = null;
    } else {
      this.#ready = options.skipDefaults === true;
      this.#plan = options.skipDefaults === true ? null : HOST_EXTRACTORS;
    }
  }

  /** Builds, once, then returns the registry. `await ExtractorRegistry.create()`. */
  static async create(options = {}) {
    const r = new ExtractorRegistry(options);
    await r.init();
    return r;
  }

  register(e) {
    this.#extractors.push(e);
  }

  /** @returns {Promise<this>} the extractor list, imported if it is not built yet */
  async init() {
    if (this.#ready) {
      return this;
    }
    if (this.#initPromise === null) {
      this.#initPromise = this.#buildPlan().then((r) => {
        this.#ready = true;
        return r;
      });
    }
    return this.#initPromise;
  }

  async #buildPlan() {
    for (const [modulePath, className] of this.#plan) {
      const Klass = STATIC_CLASSES.get(className) ?? await loadClass(modulePath, className, this.missingModules);
      if (Klass !== null) {
        this.register(new Klass());
      }
    }
    return this;
  }

  /**
   * @returns {Promise<object>} the extractor that owns this url, or a fresh generic one
   */
  async forUrl(url) {
    await this.init();
    const host = ExtractorRegistry.registrable(hostForMatch(url));
    let best = null;
    let bestScore = -1;
    for (const e of this.#extractors) {
      for (const pattern of e.hosts()) {
        if (host === pattern || host.endsWith('.' + pattern)) {
          const score = pattern.length * 100 + e.priority();
          if (score > bestScore) {
            bestScore = score;
            best = e;
          }
        }
      }
    }
    if (best !== null) {
      return best;
    }
    const g = new GenericExtractor();
    g.setProvider(host !== '' ? host : 'generic');
    return g;
  }

  /**
   * Names shown on the homepage so users know what to expect.
   *
   * @returns {Promise<Record<string,string>>} host => provider name, ksort order
   *   (php ksort over byte strings, which is plain code-unit order here)
   */
  async knownHosts() {
    await this.init();
    const out = new Map();
    for (const e of this.#extractors) {
      if (e.name() === 'blocked' || e.name() === 'youtube') {
        continue;
      }
      for (const h of e.hosts()) {
        out.set(h, e.name());
      }
    }
    const keys = [...out.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted = {};
    for (const k of keys) {
      sorted[k] = out.get(k);
    }
    return sorted;
  }

  /** The registrable domain of a host: example.co.uk, not co.uk. */
  static registrable(host) {
    const trimmed = trimDots(strtolowerBytes(String(host ?? '')));
    const parts = trimmed.split('.');
    if (parts.length < 2) {
      return trimmed;
    }
    // co.uk / com.bd / gov.in style second-level public suffixes.
    const last = parts[parts.length - 1];
    const second = parts[parts.length - 2];
    if (last.length === 2 && CC_TAILS.includes(second)) {
      return parts.slice(-3).join('.');
    }
    return second + '.' + last;
  }

  /** The registered list, for diagnostics and tests. */
  get extractors() {
    return [...this.#extractors];
  }
}

/**
 * parse_url($url, PHP_URL_HOST) ?: '' cast to string. php's `?:` is truthiness, so
 * the host "0" counts as no host at all and registrable() sees '' - javascript's
 * `||` would keep "0", which is why the check is spelled out.
 */
function hostForMatch(url) {
  const h = phpUrlComponent(url, 'host');
  return h === null || h === '' || h === '0' ? '' : String(h);
}

/** trim($host, '.') with the byte rule: one character per php byte. */
function trimDots(s) {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === '.') {
    start++;
  }
  while (end > start && s[end - 1] === '.') {
    end--;
  }
  return s.slice(start, end);
}

async function loadClass(modulePath, className, missing) {
  const load = LOADERS.get(modulePath);
  if (typeof load !== 'function') {
    missing.push(modulePath);
    return null;
  }
  let mod;
  try {
    mod = await load();
  } catch (err) {
    // The extractor file itself is absent, so nothing was written for that host yet.
    // A missing dependency further down has a different name in the message and is
    // a real fault, so it still throws.
    const basename = String(modulePath).split('/').pop();
    const absent = err && err.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(basename);
    if (!absent) {
      throw err;
    }
    missing.push(modulePath);
    return null;
  }
  if (typeof mod[className] !== 'function') {
    missing.push(modulePath + '#' + className);
    return null;
  }
  return mod[className];
}
