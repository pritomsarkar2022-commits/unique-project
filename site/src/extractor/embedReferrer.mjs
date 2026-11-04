import { parseUrl, phpTrim } from '../support.mjs';

/**
 * The site that embedded the player the visitor pasted.
 *
 * An embed address often carries its parent in the query (`?parent_ref=https%3A%2F%2F
 * site.example%2F`, `?ref=`, `?referer=`), because the player is supposed to know who
 * put it on a page. Hosts that gate their embeds read that as the visitor's Referer,
 * so a request that presents the pasted address as its own referrer is refused while
 * the browser inside the parent page is served. This returns the parent, or null.
 *
 * Only an absolute http(s) address is accepted: `ref` on these pages is sometimes a
 * bare host, a number or a campaign tag, and pasting that into a header would be a
 * header-injection risk rather than a referrer.
 */

/** The query names these hosts use for the page that holds the embed. */
const PARENT_KEYS = ['parent_ref', 'parentref', 'embed_ref', 'embedref', 'referer', 'referrer', 'ref'];

/**
 * @param {string} pageUrl the address the visitor pasted
 * @returns {string|null} the parent page, or null when the address names none
 */
export function embedReferrerOf(pageUrl) {
  const parts = parseUrl(String(pageUrl ?? ''));
  if (!parts || !parts.query) {
    return null;
  }
  for (const piece of String(parts.query).split('&')) {
    const eq = piece.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const key = decodePiece(piece.slice(0, eq)).toLowerCase();
    if (!PARENT_KEYS.includes(key)) {
      continue;
    }
    const value = phpTrim(decodePiece(piece.slice(eq + 1)));
    if (isHttpAddress(value)) {
      return value;
    }
  }
  return null;
}

/** An address we are willing to put in a Referer: http(s), a host, no credentials. */
function isHttpAddress(value) {
  if (value === '' || /[\r\n\t\x00-\x1F\x7F]/.test(value)) {
    return false;
  }
  const parts = parseUrl(value);
  if (parts === false || !parts.scheme || !parts.host) {
    return false;
  }
  return parts.scheme === 'http' || parts.scheme === 'https' ? parts.user === undefined : false;
}

/** urldecode(): '+' is a space, %XX is a byte; an invalid escape is kept literally. */
function decodePiece(piece) {
  let out = '';
  const text = String(piece ?? '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '+') {
      out += ' ';
    } else if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      out += Buffer.from(text.slice(i + 1, i + 3), 'hex').toString('latin1');
      i += 2;
    } else {
      out += ch;
    }
  }
  return Buffer.from(out, 'latin1').toString('utf8');
}
