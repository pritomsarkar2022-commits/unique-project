import { errorTpl, errorFatalTpl } from './pages.gen.mjs';

const NOT_FOUND = {
  title: 'Page not found',
  heading: 'No page here',
  message: 'The address you opened is not part of this site. The downloader is on the home page.',
};
const BROKEN = {
  title: 'Something broke',
  heading: 'That page fell over',
  message: 'The server hit an unexpected error. Try the link again in a moment.',
};

/**
 * views/error.php, which answers both a 404 and the generic failure page.
 *
 * `fatal` is the debug-only line the original shows when app.debug is on; the template
 * reserves the exact spot php's inline if-block sits, so an empty one leaves the byte
 * stream untouched.
 *
 * @param {{notFound?: boolean, fatal?: string, assetVer?: string|number, baseHref?: string}} [options]
 */
export function renderError(options = {}) {
  const words = options.notFound ? NOT_FOUND : BROKEN;
  const fatal = String(options.fatal ?? '');
  let html = errorTpl
    .split('{{BASE}}').join(options.baseHref ?? '/')
    .split('{{TITLE}}').join(words.title)
    .split('{{HEADING}}').join(words.heading)
    .split('{{MESSAGE}}').join(words.message)
    .replace('{{FATAL}}', fatal === '' ? '' : fatalLine(entQuotes(fatal)) + '\n');
  if (options.assetVer !== undefined && options.assetVer !== null && options.assetVer !== '') {
    html = html.replace(/([?&]v)\d{6,}/g, '$1' + options.assetVer);
  }
  return html;
}

/** The <pre> the php emits verbatim, built from the fragment so the indentation is the
 *  capture's and not a guess. */
function fatalLine(escaped) {
  return errorFatalTpl.replace('{{FATAL_TEXT}}', escaped);
}

/**
 * htmlspecialchars($fatal, ENT_QUOTES) -- which is not the app's e(), and the
 * difference is observable. Without ENT_SUBSTITUTE, php returns an empty string for the
 * whole input as soon as one byte is not valid utf-8, so a debug line that has swallowed
 * a raw media byte shows nothing at all rather than a substituted glyph.
 */
function entQuotes(s) {
  const bytes = Buffer.from(String(s), 'binary');
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    return '';
  }
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[ch]);
}
