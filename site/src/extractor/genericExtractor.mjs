import { cfg } from '../config.mjs';
import { ExtractException } from '../errors.mjs';
import { phpInt } from '../support.mjs';
import { BaseExtractor, strtolowerBytes } from './baseExtractor.mjs';
import { MediaSniffer } from './mediaSniffer.mjs';
import { Source } from './source.mjs';

/**
 * Port of lib/Extractor/GenericExtractor.php.
 *
 * Everything that is not a known special case. This is where the general formula
 * lives: read the page, read the players it delegates to, read the config files
 * those players fetch, then prove the candidates by asking the file host for bytes.
 *
 * The deep walk itself belongs to DeepFinder in php (frames/embeds, sidecar config
 * endpoints, cfg('extract.depth'), cfg('extract.max_pages'), the
 * cfg('extract.deadline_ms') clock and the url + host/path dedupe). That module is
 * not part of this file's ownership, so it is imported lazily from
 * './deepFinder.mjs' - see findSources() - and its absence degrades to the depth-0
 * scan DeepFinder performs on the page it was handed. The drop-in needs no edit here.
 */
export class GenericExtractor extends BaseExtractor {
  static phpClass = 'GenericExtractor';

  #providerName = 'generic';

  setProvider(host) {
    this.#providerName = String(host);
  }

  /** php answers with the provider here, not with the derived class name. */
  name() {
    return this.#providerName;
  }

  priority() {
    return 1;
  }

  /**
   * @param {string} pageUrl
   * @param {object} http
   * @param {string[]} visited guards against redirect loops between players. php's
   *   GenericExtractor never reads it (the host extractors do, with in_array over
   *   values and insertion order), and the port keeps that.
   * @returns {Promise<import('./mediaBundle.mjs').MediaBundle>}
   */
  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    const b = this.newBundle(pageUrl);

    let res = await http.get(pageUrl, {
      headers: { Referer: pageUrl },
      // A pasted address that ends in a file extension is worth one small read: a
      // copied m3u8 from a network tab is a file, while a page called something.webm
      // is a page. What the host answers is the only proof.
      max_bytes: MediaSniffer.kindOf(pageUrl) === null
        ? phpInt(cfg('http.page_max_bytes', 2000000))
        : 65536,
      accept: '*/*',
    });

    if (MediaSniffer.kindOf(res.finalUrl) !== null && !res.isHtml()) {
      const s = Source.make(res.finalUrl, String(MediaSniffer.kindOf(res.finalUrl)));
      s.headers = { Referer: pageUrl };
      s.tokenExpiryFromQuery();
      b.finalUrl = res.finalUrl;
      if (await this.verify(s, http)) {
        b.sources = [s];
        b.confidence = 0.8;
        this.#labelSources(b);
        return b;
      }
      throw new ExtractException(
        'That file address did not answer.',
        'Its link may have expired. Paste the address of the page that shows the player.',
        'file_refused',
      );
    }

    // It was a page after all, so read the whole of it.
    if (MediaSniffer.kindOf(pageUrl) !== null) {
      res = await http.get(pageUrl, { headers: { Referer: pageUrl }, accept: 'text/html,*/*;q=0.8' });
    }

    this.fillMeta(b, res);

    if (res.status === 401) {
      throw new ExtractException(
        'That page needs a sign in.',
        'This tool does not use accounts, so it stops there. Paste a page that is open to visitors.',
        'gated',
      );
    }
    if (res.status === 403) {
      throw new ExtractException(
        'That site only answers its own visitors.',
        'A browser check sits between this server and the page, and this tool does not go around one. Open the link in your own browser, then paste the address of the page that shows the player.',
        'gated',
      );
    }
    if (res.status === 404 || res.status === 410) {
      throw new ExtractException(
        'That page is not there.',
        'Check the link, or paste the address of the page that shows the player.',
        'not_found',
      );
    }

    if (GenericExtractor.#deadPageSignal(res.body)) {
      throw new ExtractException(
        'That file is no longer on the video host.',
        'The page exists but says the video was removed or is not available in your country.',
        'file_gone',
      );
    }

    const sources = await this.#findSources(res, http, b);
    res.free();

    if (sources.length === 0) {
      throw new ExtractException(
        'No video file was found on that page.',
        'The page loads its player with javascript after the fact, or the link is not a video page. Paste the address of the page that shows the player.',
        'no_media',
      );
    }

    const probe = sources.slice(0, Math.max(2, phpInt(cfg('extract.verify_limit', 6))));
    b.sources = await this.verifyAll(probe, http, b);
    if (b.sources.length === 0) {
      // A candidate that will not answer is not a result. Showing one only moves the
      // failure to the moment somebody presses download.
      throw new ExtractException(
        'That page names a video, but the host will not serve the file.',
        'Its player works with its own session only. Paste the address of the player page, or try again in a minute.',
        'file_refused',
      );
    }
    this.#labelSources(b);
    return b;
  }

  /**
   * A quality written into the file address is the only label the host itself
   * offers, so it is worth showing next to the verified size.
   */
  #labelSources(b) {
    for (const s of b.sources) {
      if (s.label !== null) {
        continue;
      }
      const base = labelForKind(s.kind);
      s.label = s.height !== null ? s.height + 'p ' + strtolowerBytes(base) : base;
    }
  }

  static #deadPageSignal(body) {
    const needle = [
      'video not found', 'file does not exist', 'file not found',
      'this video has been removed', 'video has been deleted',
      'not available in your country', 'account has been suspended',
      'file is temporarily unavailable',
    ];
    const hay = strtolowerBytes(String(body).slice(0, 200000));
    for (const n of needle) {
      if (hay.includes(n)) {
        return true;
      }
    }
    return false;
  }

  /**
   * DeepFinder when the port has it; the depth-0 read of this document while it
   * does not. Both paths feed the same verifyAll() at the end, which is the step
   * that proves a candidate is a real file.
   *
   * @returns {Promise<Source[]>}
   */
  async #findSources(res, http, b) {
    if (deepFinderFactory !== null) {
      return deepFinderFactory(http, b, res, this);
    }
    const mod = await loadDeepFinder();
    if (mod !== null && typeof mod.DeepFinder === 'function') {
      return new mod.DeepFinder(http, b).withPage(res);
    }
    const found = new Map();
    for (const s of MediaSniffer.candidates(this.readable(res), res.finalUrl, this.htmlHeaders(res))) {
      if (!found.has(s.url)) {
        found.set(s.url, s);
      }
    }
    return [...found.values()];
  }

  /**
   * Test seam (and the hook an injected finder would use): pass a function
   * (http, bundle, res, extractor) => Source[], or null to go back to the default.
   */
  static setDeepFinderFactory(fn) {
    deepFinderFactory = typeof fn === 'function' ? fn : null;
  }
}

let deepFinderFactory = null;
let deepFinderPromise = null;

function loadDeepFinder() {
  if (deepFinderPromise === null) {
    deepFinderPromise = import('./deepFinder.mjs').catch((err) => {
      // A missing file is the expected state until DeepFinder is ported; anything
      // else means the port exists and is broken, which must not be swallowed.
      if (err && err.code === 'ERR_MODULE_NOT_FOUND' && /deepFinder\.mjs/.test(String(err.message))) {
        return null;
      }
      throw err;
    });
  }
  return deepFinderPromise;
}

function labelForKind(kind) {
  switch (kind) {
    case Source.HLS: return 'Video stream';
    case Source.WEBM: return 'WebM video';
    case Source.TS: return 'Raw stream';
    case Source.MKV: return 'MKV video';
    default: return 'MP4 video';
  }
}
