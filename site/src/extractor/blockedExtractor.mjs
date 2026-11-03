import { ExtractException } from '../errors.mjs';
import { phpUrlComponent } from './source.mjs';
import { ExtractorRegistry } from './extractorRegistry.mjs';

/**
 * Port of lib/Extractor/BlockedExtractor.php.
 *
 * Hosts people keep asking for that cannot be served from a server. Each entry is
 * a gate we will not try to defeat: a captcha, a browser challenge, a login, or a
 * redirect loop that only a js engine can walk. Answering with the reason is better
 * than letting the general reader come back empty and look broken.
 *
 * php declares `implements ExtractorInterface` rather than `extends BaseExtractor`,
 * so this port stands on its own: no base class, just the four interface methods.
 */
export class BlockedExtractor {
  static REASONS = {
    'frdl.by': ['a captcha check and a 60 second timer', 'Freedl'],
    'freedl.ink': ['a captcha check and a 60 second timer', 'Freedl'],
    'flash-files.com': ['a browser security check', 'Flash Files'],
    'torupload.com': ['a browser security check', 'TorUpload'],
    'torlock.com': ['a browser security check', 'TorUpload'],
    'upfilesgo.com': ['a login style token loop', 'UpFiles'],
    'upfiles.com': ['a login style token loop', 'UpFiles'],
    'file-upload.org': ['a captcha check', 'File-Upload'],
    'uptobox.com': ['an account and a payment plan', 'Uptobox'],
    'mixdrop.ac': ['an account', 'MixDrop'],
  };

  hosts() {
    return Object.keys(BlockedExtractor.REASONS);
  }

  priority() {
    return 60;
  }

  name() {
    return 'blocked';
  }

  /**
   * @param {string} pageUrl
   * @param {object} _http (unused; php never reaches the network here)
   * @param {string[]} _visited
   */
  extract(pageUrl, _http, _visited = []) {
    const host = ExtractorRegistry.registrable(phpUrlComponent(pageUrl, 'host') ? String(phpUrlComponent(pageUrl, 'host')) : '');
    const entry = Object.prototype.hasOwnProperty.call(BlockedExtractor.REASONS, host)
      ? BlockedExtractor.REASONS[host]
      : ['a check this tool does not attempt', 'That site'];
    const gate = entry[0];
    const brand = entry[1];
    throw new ExtractException(
      brand + ' puts ' + gate + ' between the visitor and the file.',
      'That is their rule, and this tool does not try to get around it. Open the link in your own browser and pass their check, then the file is theirs to give.',
      'gated',
    );
  }
}

export default BlockedExtractor;
