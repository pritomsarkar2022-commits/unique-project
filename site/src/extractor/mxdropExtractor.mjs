import { urlAbsolutize } from '../support.mjs';
import { ExtractException } from '../errors.mjs';
import { Source, phpUrlComponent } from './source.mjs';
import { BaseExtractor } from './baseExtractor.mjs';
import { JsUnpacker } from './jsUnpacker.mjs';

/**
 * Port of lib/Extractor/MxdropExtractor.php: mxdrop.click and the MixDrop family.
 *
 * The /f/ page is only a frame around /e/, and /e/ keeps its player config in a
 * Dean Edwards packed script. Unpacked it is plain assignment:
 *   MDCore.wurl = "//ok2cl0c87o.mxcontent.net/v2/vngdxnpetkgneq.mp4?s=..&e=..";
 * The cdn host is different for every file, so nothing here may be hardcoded, and
 * their edge answers 403 to a request that carries a Referer it did not ask for.
 * That is why the fallback strips the Referer and asks once more.
 *
 * embedUrl() is public and differential-tested against php in parity/test-hosts.mjs.
 */

const S = '\\x09\\x0A\\x0B\\x0C\\x0D\\x20';
const QUOTE = '[\\x22\\x27]';
const NOTQ = '[^\\x22\\x27]';
const W = 'A-Za-z0-9';

export class MxdropExtractor extends BaseExtractor {
  static phpClass = 'MxdropExtractor';

  hosts() {
    return ['mxdrop.click', 'mxdrop.to', 'mxdrop.ch', 'mixdrop.to', 'mixdrop.co', 'mixdrop.ch', 'mixdrop.ps', 'mxcontent.net'];
  }

  priority() {
    return 20;
  }

  async extract(pageUrl, http, visited = []) { // eslint-disable-line no-unused-vars
    const b = this.newBundle(pageUrl, 'mxdrop');

    let res = await http.get(pageUrl, { headers: { Referer: pageUrl } });
    this.fillMeta(b, res);
    const embed = MxdropExtractor.embedUrl(res.body, res.finalUrl);
    if (embed !== '' && embed !== res.finalUrl) {
      res = await http.get(embed, { headers: { Referer: res.finalUrl } });
    }
    if (!res.ok()) {
      throw new ExtractException('MixDrop answered HTTP ' + res.status + '.', 'The file was probably removed.', 'http_' + res.status);
    }

    const flat = JsUnpacker.joinConcatenations(JsUnpacker.unescape(JsUnpacker.unpack(res.body)));
    const wm = new RegExp('MDCore\\.wurl[' + S + ']*=[' + S + ']*' + QUOTE + '(' + NOTQ + '+)' + QUOTE).exec(flat);
    if (wm === null) {
      throw new ExtractException('That MixDrop page never named a file.', 'The video may still be processing, or it needs their app.', 'no_media');
    }
    const media = urlAbsolutize(res.finalUrl, wm[1]);
    const t = new RegExp('MDCore\\.vtitle[' + S + ']*=[' + S + ']*' + QUOTE + '(' + NOTQ + '+)' + QUOTE).exec(flat);
    if (t !== null) {
      const trimmed = phpTrimDefault(t[1]);
      if (trimmed !== '') {
        b.title = trimmed;
      }
    }
    const p = new RegExp('MDCore\\.poster[' + S + ']*=[' + S + ']*' + QUOTE + '(' + NOTQ + '+)' + QUOTE).exec(flat);
    if (p !== null) {
      if (b.thumbnail === null || b.thumbnail === undefined) {
        b.thumbnail = urlAbsolutize(res.finalUrl, p[1]);
      }
    }

    const s = Source.make(media, media.includes('.m3u8') ? Source.HLS : Source.MP4);
    s.label = 'Original file';
    s.headers = { Referer: res.finalUrl };
    s.tokenExpiryFromQuery();
    b.addSource(s);

    let kept = await this.verifyAll(b.sources, http, b);
    if (kept.length === 0) {
      // Their edge is inconsistent about the Referer, so ask once without it.
      s.headers = [];
      kept = await this.verifyAll([s], http, b);
    }
    b.sources = kept;
    if (b.sources.length === 0) {
      throw new ExtractException('MixDrop refused the file request.', 'Their link is short lived. Paste the address again.', 'token_expired');
    }
    b.confidence = 0.9;
    return b;
  }

  /** The /e/ address the /f/ page frames, if the markup carries one. */
  static embedUrl(html, baseUrl) {
    const m = new RegExp('<iframe[^>]+src=' + QUOTE + '(' + NOTQ + '*?/e/[' + W + ']+)' + QUOTE, 'i').exec(html);
    if (m !== null) {
      return urlAbsolutize(baseUrl, m[1]);
    }
    const pth = phpUrlComponent(baseUrl, 'path') ? String(phpUrlComponent(baseUrl, 'path')) : '';
    const m2 = new RegExp('^(/f/)([' + W + ']+)$').exec(pth);
    if (m2 !== null) {
      return (phpUrlComponent(baseUrl, 'scheme') ?? '') + '://' + (phpUrlComponent(baseUrl, 'host') ?? '') + '/e/' + m2[2];
    }
    return '';
  }
}

function phpTrimDefault(s) {
  const chars = ' \t\n\r\x0B\u0000';
  const str = String(s);
  let start = 0;
  let end = str.length;
  while (start < end && chars.includes(str[start])) start++;
  while (end > start && chars.includes(str[end - 1])) end--;
  return str.slice(start, end);
}

export default MxdropExtractor;
