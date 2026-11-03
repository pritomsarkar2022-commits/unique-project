import { phpInt, intDiv } from '../support.mjs';

/**
 * Port of lib/Extractor/JsUnpacker.php.
 *
 * The three hiding tricks these hosts use: a packed script, escaped string
 * literals, and a url chopped into concatenated pieces.
 *
 * PHP indexes these strings by byte; this port indexes by code unit, which is the
 * same thing whenever the text it chews on is ASCII, which packed js is. Where the
 * two views are compared as numbers (the eight byte window in unpack()) the port
 * counts bytes too, so the decision is php's. The one thing that cannot cross over
 * is joinConcatenations() taking the byte after a backslash: for a character of
 * three bytes or more php keeps the first and the last and loses the middle, which
 * is a mojibake no javascript string can hold, so the port keeps the whole
 * character there. Everything else, \xNN escapes over 0x7F included, agrees.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** php's DivisionByZeroError for `% 0`, which javascript answers with NaN. */
function moduloByZero() {
  const e = new Error('Modulo by zero');
  e.name = 'DivisionByZeroError';
  return e;
}

/**
 * stripcslashes(): php drops the backslash in front of every character it does
 * not recognise, so "\Z" is "Z" and "\\" is a single backslash, and only \a \b
 * \f \n \r \t \v, \x.. and \0..\-digits decode. \e and \l are documented but
 * not implemented, so they are not implemented here either. Exported because
 * parity/oracle-unpack.php pins these escape semantics directly.
 */
export function stripcslashes(s) {
  if (!s.includes('\\')) {
    return s;
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i + 1 >= s.length) {
      out += s[i];
      continue;
    }
    const c = s[i + 1];
    const named = { a: '\x07', b: '\x08', f: '\x0C', n: '\n', r: '\r', t: '\t', v: '\v' }[c];
    if (named !== undefined) {
      out += named;
      i++;
      continue;
    }
    if (c === 'x') {
      let digits = '';
      let j = i + 2;
      while (j < s.length && digits.length < 2 && /[0-9a-fA-F]/.test(s[j])) {
        digits += s[j];
        j++;
      }
      if (digits === '') {
        out += 'x';
        i++;
        continue;
      }
      out += String.fromCharCode(parseInt(digits, 16));
      i = j - 1;
      continue;
    }
    if (c >= '0' && c <= '7') {
      let digits = '';
      let j = i + 1;
      while (j < s.length && digits.length < 3 && s[j] >= '0' && s[j] <= '7') {
        digits += s[j];
        j++;
      }
      // php packs the octal into a byte, so \777 lands on \xff.
      out += String.fromCharCode(parseInt(digits, 8) % 256);
      i = j - 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const PACKED_PATTERN = /\}\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])((?:\\.|(?!\5).)*)\5\s*\.\s*split\s*\(\s*(['"])\|\7\s*\)/s;

export class JsUnpacker {
  static ALPHABET = ALPHABET;

  /**
   * Decode the Dean Edwards p,a,c,k,e,d packer.
   *   eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(...)}(
   *       '<packed>',36,299,'|||a|b|c'.split('|')))
   * Returns the original source when the input is not packed.
   */
  static unpack(js) {
    let out = js;
    let guard = 0;
    let m;
    while (guard++ < 6 && (m = PACKED_PATTERN.exec(out)) !== null) {
      const packed = stripcslashes(m[2]);
      const radix = phpInt(m[3]);
      const count = phpInt(m[4]);
      const words = stripcslashes(m[6]).split('|');
      if (radix < 2 || radix > 62 || count < 1 || words.length < 2) {
        break;
      }
      const decoded = JsUnpacker.unpackArgs(packed, radix, words, Math.min(count, words.length));
      const needleAt = out.indexOf(m[0]);
      const evalAt = out.slice(0, needleAt).lastIndexOf('eval(');
      const from = evalAt === -1 ? needleAt : evalAt;
      let to = needleAt + m[0].length;
      // Swallow the rest of the eval(...) call, including the trailing ))
      const closer = out.indexOf('))', needleAt);
      // php measures this gap in bytes, so the window is measured in bytes here too;
      // a gap of non-ascii text is therefore judged the same length it is there.
      if (closer !== -1 && utf8Length(out.slice(to, closer)) < 8) {
        to = closer + 2;
      }
      out = out.slice(0, from) + decoded + out.slice(to);
    }
    return out;
  }

  static unpackArgs(packed, radix, words, count) {
    let out = packed;
    for (let i = count - 1; i >= 0; i--) {
      if (words[i] === undefined || words[i] === '') {
        continue;
      }
      const token = JsUnpacker.base(i, radix);
      // php escapes \ and $ for its own replacement grammar, which is exactly a
      // literal insert, and a function replacement is literal without them.
      const pattern = new RegExp('(?<![A-Za-z0-9_])' + token + '(?![A-Za-z0-9_])', 'g');
      // Mirrors the packer's \b..\b: a token only stands alone between word chars.
      out = out.replace(pattern, () => words[i]);
    }
    return out;
  }

  static base(num, radix) {
    const n0 = phpInt(num);
    const r = phpInt(radix);
    if (n0 === 0) {
      return '0';
    }
    let s = '';
    let n = n0;
    while (n > 0) {
      if (r === 0) {
        throw moduloByZero();
      }
      // a radix above the alphabet's length walks off the end, where php warns and
      // yields nothing, so the digit simply disappears.
      s = (ALPHABET[n % r] ?? '') + s;
      n = intDiv(n, r);
    }
    return s;
  }

  /** \x41, \u0041, %41 and json escaped string literals. */
  static unescape(js) {
    let out = js.replace(/\\x([0-9a-fA-F]{2})/g, (all, h) => String.fromCharCode(parseInt(h, 16)));
    // mb_chr() answers false for a surrogate pair, and php's ?? turns that into ''.
    out = out.replace(/\\u([0-9a-fA-F]{4})/g, (all, h) => mbChr(parseInt(h, 16)));
    // A config handed over as a json string carries \/ and \" that the url
    // regexes would otherwise read as a truncated address.
    out = out.replace(/\\(\/|"|\?)/g, (all, ch) => ch);
    return out.replace(/%([0-9a-fA-F]{2})/g, (all, h) => {
      const c = String.fromCharCode(parseInt(h, 16));
      return ['/', ':', '?', '&', '=', '.', '-', '_'].includes(c) ? c : all;
    });
  }

  /** All three hiding tricks at once, the shape a reader wants before it looks for urls. */
  static flatten(html) {
    return JsUnpacker.joinConcatenations(JsUnpacker.unpack(JsUnpacker.unescape(html)));
  }

  /**
   * Reassemble urls built by string concatenation, e.g.
   *   "https://host/" + tok + "/file" + ".mp4"
   * Each candidate run is emitted on its own line so url regexes see it whole.
   */
  static joinConcatenations(js) {
    const extra = [];
    const len = js.length;
    let i = 0;
    while (i < len) {
      const quote = js[i];
      if (quote !== "'" && quote !== '"' && quote !== '`') {
        i++;
        continue;
      }
      let j = i + 1;
      let run = '';
      const pieces = [];
      while (j < len && js[j] !== quote) {
        if (js[j] === '\\') {
          // php appends one byte here; a two byte character arrives whole either way
          // and a wider one is where the byte view and a string view part company.
          run += js[j + 1] ?? '';
          j += 2;
          continue;
        }
        run += js[j];
        j++;
      }
      pieces.push(run);
      // Keep eating ` + <ident-or-literal> ` while it stays on one line.
      let k = j + 1;
      while (k < len) {
        while (k < len && (js[k] === ' ' || js[k] === '\t')) {
          k++;
        }
        if ((js[k] ?? '') !== '+') {
          break;
        }
        k++;
        while (k < len && (js[k] === ' ' || js[k] === '\t')) {
          k++;
        }
        const q2 = js[k] ?? '';
        if (q2 !== "'" && q2 !== '"' && q2 !== '`') {
          // Non-literal tail (a variable): stop the run, emit what we have.
          break;
        }
        const m2 = js.indexOf(q2, k + 1);
        if (m2 === -1) {
          break;
        }
        const piece = js.slice(k + 1, m2);
        if (piece.includes('\n')) {
          break;  // the run left the line, so it is not one expression
        }
        pieces.push(stripcslashes(piece));
        k = m2 + 1;
      }
      if (pieces.length > 1) {
        extra.push(pieces.join(''));
      }
      i = j + 1;
    }
    return (extra.length ? extra.join('\n') + '\n' : '') + js;
  }
}

/** mb_chr($cp, 'UTF-8') for the code points a \u.... escape can reach. */
function mbChr(cp) {
  return cp >= 0xD800 && cp <= 0xDFFF ? '' : String.fromCodePoint(cp);
}

/** strlen() of the utf-8 encoding php would be holding at that point. */
function utf8Length(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}
