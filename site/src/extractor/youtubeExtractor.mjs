import { ExtractException } from '../errors.mjs';

/**
 * Port of lib/Extractor/YouTubeExtractor.php.
 *
 * The one host this tool answers about on purpose. YouTube's player does not hand
 * out a file: it runs a check inside the browser and signs every stream against
 * that session. Reaching the file from a server means going around that check,
 * which both their terms and this tool's rules say no to, so the honest answer is
 * better than an empty result that looks like a bug. There is no signature
 * decryption here, and there must never be.
 *
 * php declares `implements ExtractorInterface` rather than extending BaseExtractor,
 * so this port is a standalone class with the four interface methods only.
 */
export class YouTubeExtractor {
  hosts() {
    return ['youtube.com', 'youtu.be', 'youtube-nocookie.com'];
  }

  priority() {
    return 60;
  }

  name() {
    return 'youtube';
  }

  /**
   * @param {string} _pageUrl
   * @param {object} _http
   * @param {string[]} _visited
   */
  extract(_pageUrl, _http, _visited = []) {
    throw new ExtractException(
      'YouTube keeps its videos inside its own player.',
      'That site signs every stream for the browser that asked for it, and taking the file from a server would mean going around their check. Paste a video page from any other host instead.',
      'gated',
    );
  }
}

export default YouTubeExtractor;
