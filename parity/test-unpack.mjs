import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { oracleRun, phpAvailable, Diff, makeRng } from './harness.mjs';
import { JsUnpacker, stripcslashes } from '../site/src/extractor/jsUnpacker.mjs';
import { CertChain, validatesUrl } from '../site/src/net/certChain.mjs';

/**
 * Differential suite for the two modules this port owns: the packer reader
 * (site/src/extractor/jsUnpacker.mjs) and the certificate chain completer
 * (site/src/net/certChain.mjs). Everything that can be compared is compared
 * against the php original through parity/oracle-unpack.php.
 *
 * The two halves are split the same way: pure decoding is diff-tested hard, the
 * sockets are mirrored line for line and only ever probed against a host that is
 * really there (VD_LIVE_TLS=1), because there is no php tls on this machine to
 * diff them against and a fake one would say more than it proves.
 */

if (!phpAvailable()) {
  console.log('SKIPPED: no PHP binary, so nothing was compared. Set PHP_BIN to the reference build.');
  process.exit(3);
}

// CertChain::cachePath() creates its directory under the storage root, and the
// parity run must never write inside the repo.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vdunpack-'));
process.env.VD_ROOT = work;

const d = new Diff();
const probes = [];
const checks = [];
const seenIds = new Set();

function probe(id, fn, args, check) {
  if (seenIds.has(id)) {
    throw new Error('duplicate probe id ' + id);
  }
  seenIds.add(id);
  probes.push({ id, fn, args });
  checks.push({ id, fn, args, check });
}

/**
 * php answers with bytes, this port answers with text. A valid utf-8 run comes
 * back as the characters it encodes; a byte php left on its own (a \xNN escape
 * over 0x7f is an invalid sequence there and has no text form here) becomes its
 * code point, which is exactly what the port emits for it.
 *
 * The one reading this cannot serve is two \xNN escapes whose bytes happen to form
 * a valid sequence, since php then holds one accidental character; the fixtures
 * keep those escapes apart, and %XX never injects one at all (it only ever keeps
 * an ascii character or leaves the text alone).
 */
function mirror(text) {
  if (typeof text !== 'string') {
    return '\u0000php-refused:' + JSON.stringify(text);
  }
  const b = Buffer.from(text, 'base64');
  let s = '';
  for (let i = 0; i < b.length;) {
    const c = b[i];
    const need = c < 0x80 ? 1 : c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
    let whole = need;
    if (need > 1) {
      for (let k = 1; k < need; k++) {
        if (i + k >= b.length || (b[i + k] & 0xc0) !== 0x80) {
          whole = 0;
          break;
        }
      }
    }
    if (whole === 2) {
      s += String.fromCodePoint(((c & 0x1f) << 6) | (b[i + 1] & 0x3f));
      i += 2;
    } else if (whole === 3) {
      s += String.fromCodePoint(((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f));
      i += 3;
    } else if (whole === 4) {
      s += String.fromCodePoint(((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f));
      i += 4;
    } else {
      // one byte, exactly as the port reads a lone chr() value
      s += String.fromCharCode(c);
      i += 1;
    }
  }
  return s;
}

const toB64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/**
 * Per-section counts. Assertions that run while the file is being read are
 * attributed by mark(); the ones inside a probe run after the oracle answers and
 * are attributed by the prefix of the probe id.
 */
const inlineCounts = [];
let markPass = 0;
let markFail = 0;
function mark(section) {
  inlineCounts.push([section, d.pass - markPass, d.failures.length - markFail]);
  markPass = d.pass;
  markFail = d.failures.length;
}

/** The bytes a character costs php, so the fixtures can stay on the safe side of it. */
function utf8Width(ch) {
  const cp = ch.codePointAt(0);
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/**
 * True when some backslash is followed by a character of three bytes or more: the
 * single place php's "the byte after a backslash" and a javascript string cannot
 * describe the same text (joinConcatenations() keeps php's first and last byte and
 * loses the middle one, which is a mojibake no string can hold). The fuzz avoids
 * that shape rather than pretending it agrees.
 */
function halfCharEscapes(s) {
  for (let i = 0; i + 1 < s.length; i++) {
    if (s[i] === '\\' && utf8Width(s[i + 1]) > 2) {
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ JsUnpacker::base
{
  // radix 1 with a number above zero is an endless walk in php (intdiv(5, 1) stays
  // 5 forever), so it is never probed; base(0, 1) returns before the loop.
  const cases = [[0, 36], [0, 1], [0, 62], [1, 2], [35, 36], [36, 36], [61, 62], [62, 62], [1000, 36],
    [12345678, 62], [42, 3], [7, 8], [255, 16], [63, 64], [61, 63], [1, 62], [0, 10], [-1, 10], [9, 2], [10, 2],
    [62, 2], [100, 62], [4095, 62], [61, 61], [62, 61], [3, 62], [61, 3]];
  for (const [num, radix] of cases) {
    probe(`base|${num}|${radix}`, 'base', [num, radix], (js, php) => {
      let mine = null;
      let failure = null;
      try {
        mine = JsUnpacker.base(num, radix);
      } catch (e) {
        failure = `${e.name}:${e.message}`;
      }
      if (php.ok) {
        return d.same(`base(${num}, ${radix})`, mine, php.res);
      }
      // a radix past the alphabet walks off the end, where php warns and the digit
      // simply disappears, so the port's empty answer is the matching one.
      return d.ok(`base(${num}, ${radix}) mirrors php's failure`, mine === '' || failure !== null,
        `js=${JSON.stringify(mine)} err=${failure} php=${php.err}`);
    });
  }
  probe('base|62|63', 'base', [62, 63], (js, php) => d.ok('base(62, 63) is php\'s warned-away digit',
    php.err === 'ErrorException:Uninitialized string offset 62' && JsUnpacker.base(62, 63) === '', php.err));
  probe('base|5|0', 'base', [5, 0], (js, php) => {
    let failure = '';
    try {
      JsUnpacker.base(5, 0);
    } catch (e) {
      failure = `${e.name}:${e.message}`;
    }
    d.same('base(5, 0) throws like php', failure, php.err);
  });
  probe('base|-1|0', 'base', [-1, 0], (js, php) => d.same('base(-1, 0) stops before the modulo like php',
    JsUnpacker.base(-1, 0), php.res));
  d.ok('base(0, 1) is "0", and base(5, 1) is left unprobed because php walks forever',
    JsUnpacker.base(0, 1) === '0', JsUnpacker.base(0, 1));
  mark('JsUnpacker::base');
}

// ------------------------------------------------------------------ stripcslashes
{
  const cases = [String.raw`a\x41b`, String.raw`a\x4zb`, String.raw`a\xZZb`, String.raw`a\xb`,
    String.raw`A\101B`, String.raw`\777`, String.raw`\400`, String.raw`\01777`, String.raw`\08`,
    String.raw`a\nb`, String.raw`a\rb`, String.raw`a\tb`, String.raw`a\vb`, String.raw`a\fb`,
    String.raw`a\ab`, String.raw`a\bb`, String.raw`a\eb`, String.raw`a\lb`, String.raw`a\Zb`,
    String.raw`a\\b`, String.raw`a\\\nb`, String.raw`a\'b`, String.raw`a\"b`, String.raw`a\/b`,
    String.raw`a\$b`, String.raw`a\ b`, String.raw`\8`, String.raw`\9`, 'tail\\',
    String.raw`a\xaBb`, String.raw`a\xffb`, String.raw`a\X41b`, String.raw`a\u0041b`, '', '\\',
    'plain text, no escapes', String.raw`0123456789\128\999`, String.raw`é\x41é`, String.raw`a\é`,
    String.raw`a\xa`, String.raw`\x80`, String.raw`\xff\xff`, String.raw`\x0a\x09\x0d`, String.raw`a\\x41b`];
  for (const s of cases) {
    probe('sc|' + toB64(s), 'stripcslashes', [s], (js, php) => d.same('stripcslashes(' + JSON.stringify(s) + ')',
      stripcslashes(s), mirror(php.res)));
  }
  // chr() escapes are bytes, so two of them whose bytes happen to make a valid
  // utf-8 sequence are one character in php and two here. That is the one shape no
  // text can carry across, so it is asserted on its own side instead of compared.
  d.ok('a high \\x pair stays two code points here, which is all a string can hold',
    stripcslashes(String.raw`\xc3\xa9`) === 'Ã©', JSON.stringify(stripcslashes(String.raw`\xc3\xa9`)));
  mark('stripcslashes (local)');
  const rng = makeRng(7781);
  const letters = [...String.raw`abZ09 \/$'"xnrtveq\[]{}()`, 'é', String.raw`\x`, String.raw`\u`, String.raw`\0`];
  for (let i = 0; i < 150; i++) {
    let s = '';
    for (let k = rng.int(1, 12); k > 0; k--) {
      s += rng.pick(letters);
    }
    probe('scf|' + i, 'stripcslashes', [s], (js, php) => {
      if (!php.ok) {
        return d.ok('stripcslashes fuzz ' + i + ' refused by php', php.err !== null, php.err);
      }
      return d.same('stripcslashes fuzz ' + i + ' ' + JSON.stringify(s), stripcslashes(s), mirror(php.res));
    });
  }
}

// ------------------------------------------------------------------ JsUnpacker::unpack
/** The packer this decoder is built for, written out so the fixtures are real. */
function packScript(source, radix, words, opts = {}) {
  const quote = opts.quote ?? "'";
  const splitQuote = opts.splitQuote ?? "'";
  let body = source;
  for (let i = 0; i < words.length; i++) {
    if (!words[i]) {
      continue;
    }
    body = body.replace(new RegExp('(?<![A-Za-z0-9_])' + words[i].replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
      + '(?![A-Za-z0-9_])', 'g'), JsUnpacker.base(i, radix));
  }
  body = body.split('\\').join(String.raw`\\`).split(quote).join('\\' + quote);
  return 'eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace('
    + String.raw`new RegExp('\b' + e(c) + '\b', 'g'), k[c]); return p}`
    .replace(String.raw`\b`, String.raw`\\b`)
    .replace(String.raw`\b`, String.raw`\\b`)
    + '}(' + quote + body + quote + ',' + radix + ',' + (opts.count ?? words.length) + ','
    + (opts.spacing ?? '') + quote + words.join('|') + quote + '.split(' + splitQuote + '|' + splitQuote + ')'
    + (opts.tail ?? ',0,{}))');
}

{
  const fixtures = [
    {
      label: 'plain 36',
      source: 'function greet(name){ hello(name + "world"); } greet("bob");',
      radix: 36, words: ['hello', 'greet', 'name', 'world', 'bob'], recovers: true,
    },
    {
      label: 'radix 62',
      source: 'alpha + beta + gamma + delta + epsilon + zeta;',
      radix: 62, words: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'], recovers: true,
    },
    {
      label: 'alphabet edge radix 35',
      source: 'one + two + three;',
      radix: 35, words: ['one', 'two', 'three'], recovers: true,
    },
    {
      label: 'dollar and underscore words',
      source: '$foo + a_b + _x$ + x_y + $;',
      radix: 36, words: ['$foo', 'a_b', '_x$', '$', 'x_y'], recovers: true,
    },
    {
      label: 'count over words',
      source: 'one + two + three;',
      radix: 36, words: ['one', 'two', 'three'], opts: { count: 90 }, recovers: true,
    },
    {
      label: 'count under words',
      source: 'one + two + three + four;',
      radix: 36, words: ['one', 'two', 'three', 'four'], opts: { count: 2 }, recovers: false,
    },
    {
      label: 'empty words in list',
      source: 'window.log(data);',
      radix: 36, words: ['', 'log', '', 'window'], recovers: true,
    },
    {
      label: 'double quotes',
      source: 'window.log(data);',
      radix: 36, words: ['log', 'window'], opts: { quote: '"', splitQuote: '"' }, recovers: true,
    },
    {
      // php's pattern only ever accepts a single or a double quote, so a backtick
      // script is not recognised as packed at all and comes back untouched.
      label: 'backticks',
      source: 'window.log(data);',
      radix: 36, words: ['log', 'window'], opts: { quote: '`', splitQuote: '`' }, recovers: false,
    },
    {
      label: 'spread spacing',
      source: 'window.log(data);',
      radix: 36, words: ['log', 'window'], opts: { spacing: '  ' }, recovers: true,
    },
    {
      label: 'no trailing tail',
      source: 'window.log(data);',
      radix: 36, words: ['log', 'window'], opts: { tail: ')' }, recovers: false,
    },
    {
      label: 'braces in body',
      source: 'if (window.log) { log(data); }',
      radix: 36, words: ['log', 'window'], recovers: true,
    },
    {
      label: 'two digit tokens',
      source: 'a0 + b1 + c2 + d3 + e4;',
      radix: 36, words: ['a0', 'b1', 'c2', 'd3', 'e4', 'zz10'], opts: { count: 40 }, recovers: false,
    },
  ];
  for (const f of fixtures) {
    const packed = packScript(f.source, f.radix, f.words, f.opts ?? {});
    probe('unpack|' + f.label, 'unpack', [packed], (js, php) => {
      const mine = JsUnpacker.unpack(packed);
      const theirs = mirror(php.res);
      d.same('unpack(' + f.label + ') of ' + JSON.stringify(packed.slice(0, 60)), mine, theirs);
      if (f.recovers) {
        d.ok('unpack(' + f.label + ') recovers the source in php', theirs === f.source, 'php gave ' + JSON.stringify(theirs));
        d.ok('unpack(' + f.label + ') recovers it here too', mine === f.source, 'js gave ' + JSON.stringify(mine));
      }
    });
  }

  const hard = [
    ['not packed at all', 'var a = 1; // nothing to see'],
    ['bare word', 'p,a,c,k,e,d'],
    ['radix 0', "}('0.1();',0,2,'a|b'.split('|'))"],
    ['radix 1', "}('0.1();',1,2,'a|b'.split('|'))"],
    ['radix 62', "}('z.1();',62,2,'a|b'.split('|'))"],
    ['radix 63', "}('0.1();',63,2,'a|b'.split('|'))"],
    ['radix 1000', "}('0.1();',1000,2,'a|b'.split('|'))"],
    ['count 0', "}('0.1();',36,0,'a|b'.split('|'))"],
    ['one word', "}('0.1();',36,5,'single'.split('|'))"],
    ['no words', "}('0.1();',36,5,''.split('|'))"],
    ['unpadded tail', "}('0.1();',36,2,'a|b'.split('|')"],
    ['cut inside the words', "}('0.1();',36,2,'a|b"],
    ['closer far away', "}('0.1();',36,2,'a|b'.split('|') , someLongerArgumentHere)"],
    ['closer just inside eight', "}('0.1();',36,2,'a|b'.split('|'),0,'xx'))"],
    ['closer at eight', "}('0.1();',36,2,'a|b'.split('|'),0,'xxxx'))"],
    ['two byte gap', "}('0.1();',36,2,'a|b'.split('|'),0,'é'))"],
    ['gap past eight in bytes', "}('0.1();',36,2,'a|b'.split('|'),0,'éé'))"],
    ['closer inside body', "}('f(g(h(0)));',36,2,'a|b'.split('|'),0,{}))"],
    ['escaped quote', String.raw`}('say(\'hi\');',36,2,'a|b'.split('|'),0,{}))`],
    ['backslash in body', String.raw`}('a\\b 0',36,2,'x|y'.split('|'),0,{}))`],
    ['multi line', "}(\n  '0.1(2);',\n  36,\n  3,\n  'a|b|c'.split('|')\n,0,{}))"],
    ['token inside word', "}('00 0 10 1',36,2,'aa|bb'.split('|'),0,{}))"],
    ['dollar in packed', "}('1$ 1_ $1',36,2,'a|b'.split('|'),0,{}))"],
    ['no split call', "}('0',36,2,'a|b'.explode('|'))"],
    ['three quotes', '}("0",36,2,\'a|b\'.split("|"))'],
    ['split on another quote', "}('0',36,2,'a|b'.split(\"|\"))"],
    ['words with escapes', String.raw`}('0',36,2,'a\'b|c\\nd'.split('|'),0,{}))`],
    ['eval in front', "eval(function(p,a,c,k,e,d){}('0.1();',36,2,'a|b'.split('|'),0,{}))"],
    ['two packed on one line', "}('0.1();',36,2,'a|b'.split('|'),0,{})) }('2.3();',36,2,'c|d'.split('|'),0,{}))"],
    ['huge count', "}('0.1();',36,999999999999,'a|b'.split('|'),0,{}))"],
    ['count with a plus', "}('0.1();',36,+3,'a|b|c|d'.split('|'),0,{}))"],
    ['count with spaces', "}('0.1();',36, 3 , 'a|b|c|d'.split('|'),0,{}))"],
  ];
  for (const [label, js] of hard) {
    probe('hard|' + label, 'unpack', [js], (ignored, php) => {
      if (!php.ok) {
        return d.ok('unpack(' + label + ') refused by php', php.err !== null, php.err);
      }
      return d.same('unpack(' + label + ')', JsUnpacker.unpack(js), mirror(php.res));
    });
  }

  // Nested packing, and the guard that stops after six rounds.
  const inner = packScript('alpha bravo;', 36, ['alpha', 'bravo'], {});
  const level2 = packScript(inner, 36, ['function', 'return'], {});
  probe('unpack|nested2', 'unpack', [level2], (js, php) => d.same('nested packer',
    JsUnpacker.unpack(level2), mirror(php.res)));
  let seven = 'window.log(data);';
  for (let i = 0; i < 7; i++) {
    seven = packScript(seven, 36, ['window', 'log', 'data', 'w' + i], { count: 4 });
  }
  probe('unpack|seven deep', 'unpack', [seven], (js, php) => d.same('seven nested packers stop at six',
    JsUnpacker.unpack(seven), mirror(php.res)));
}

// ------------------------------------------------------------------ JsUnpacker::unpackArgs
{
  const cases = [
    ['0.1("2 3");', 4, ['console', 'log', 'hello', 'world'], 4],
    ['0.1("2 3");', 36, ['console', 'log', 'hello', 'world'], 4],
    ['a a a', 36, ['zz'], 1],
    ['0_1', 36, ['x', 'y'], 2],
    ['$0 $1', 36, ['$', '_'], 2],
    ['10_11 10', 36, ['aa', 'bb'], 2],
    ['no tokens here', 36, ['zz', 'yy'], 2],
    ['0 1 2 3', 36, ['a', '', 'c', 'd'], 4],
    ['0 1 2 3', 36, ['a', 'b', 'c'], 5],
    ['0 1', 36, ['x\\y', '$z'], 2],
    ['\\\\0 \\\\1', 36, ['x\\y', '$z'], 2],
    ['0', 62, ['A', 'b'], 2],
    ['ZZ Zz', 62, ['one', 'two'], 62],
    ['9 8 7', 10, ['nine', 'eight', 'seven'], 10],
    ['', 36, ['a', 'b'], 2],
    ['az a z 60 1z', 36, ['az', 'a', 'z', '60', '1z'], 5],
    ['10 11 1z 60', 62, ['one', 'two', 'three', 'four', 'five'], 5],
    ['0 1 2 3 4 5 6 7 8 9 10', 36, ['zero', 'one', 'two', 'three', 'four'], 11],
    ['zz z', 62, ['double', 'single'], 62],
    ['0 00 000', 36, ['a', 'b'], 3],
  ];
  cases.forEach(([packed, radix, words, count], i) => {
    probe('ua|' + i, 'unpack_args', [packed, radix, words, count], (js, php) => d.same(
      `unpackArgs(${JSON.stringify(packed)}, ${radix}, ${JSON.stringify(words)}, ${count})`,
      JsUnpacker.unpackArgs(packed, radix, words, count), mirror(php.res)));
  });
}

// ------------------------------------------------------------------ JsUnpacker::unescape
{
  const cases = [
    String.raw`\x41 \x4a \xzz \x4 \xg1 \\x41 \X41`,
    String.raw`a\xffb \x80c \x00d`,
    String.raw`\u0041 \u00e9 \u4e2d \uD83D \uDEAD \u0000 \u0041z \uzzzz \u123`,
    String.raw`\uD7FF \uE000 \uFFFF \u0080 \u07FF \u0800 \uFFFFF`,
    String.raw`\/ \" \? \\ \" \\\\`,
    String.raw`json: {\"url\":\"https:\/\/host/a\"}`,
    '%3A %41 %2F %25 %zz % %2 %% %7B %7D %5B %5D',
    '%2D %2E %5F %3D %26 %3F %3A %61 %4A',
    '%C3%A9 %e2%82%ac %c3a9 %E2%82%AC',
    String.raw`both \x41 and \u0042 and %3A together`,
    String.raw`cascade: \x5cu0041 here`,
    String.raw`cascade back: \u005cx41 here`,
    String.raw`nothing to do, plain url https://host/f.m3u8?x=1&y=2`,
    '',
    String.raw`%%41 %4%41 \\\x41`,
    String.raw`\x25\x33\x41`,
    String.raw`%u0041 %uD83D`,
    String.raw`lone \x and lone \u and lone %`,
    String.raw`\u0000\u000a\u0009`,
    String.raw`\x0a\x0d`,
  ];
  for (const s of cases) {
    probe('ue|' + toB64(s), 'unescape', [s], (js, php) => d.same('unescape(' + JSON.stringify(s) + ')',
      JsUnpacker.unescape(s), mirror(php.res)));
  }
  // %u is not a thing this decoder does: only \u is, so %u stays on the page.
  probe('ue|%u', 'unescape', [String.raw`%u0041 %u00e9`], (js, php) =>
    d.same('unescape(%u..) leaves it alone like php', JsUnpacker.unescape(String.raw`%u0041 %u00e9`), mirror(php.res)));
}

// ------------------------------------------------------------------ joinConcatenations and flatten
{
  const cases = [
    String.raw`var u = "https://host/" + tok + "/file" + ".mp4";`,
    String.raw`var u = "https://host/" + "tok" + "/file" + ".mp4";`,
    'var u = "https://host/" + "tok" +\n  "/file.mp4";',
    String.raw`var u = 'a' + "b" + 'c' + "d";`,
    String.raw`var u = ` + '`' + String.raw`\/x` + '`' + ' + ' + "'y';",
    'var u = "a"   +   "b";',
    'var u = "a"\t+\t"b";',
    'var u = "a" + ;',
    'var u = "unterminated',
    "var u = 'escaped \\' quote' + 'tail';",
    String.raw`var u = "a" + 'b' + "c" + 'd' + "e" + 'f';`,
    '<script>var u = "https://cdn.host/" + "seg" + "/index.m3u8";</script>',
    '<script type="text/javascript"><!--\nvar a = "x" + "y";\n//--></script>',
    '<script src="a.js"></script><script>var u="h"+"i";</script>',
    String.raw`var u = "a" + "b" + c + "d";`,
    String.raw`var q = "''" + "x";`,
    String.raw`var w = "" + "a";`,
    String.raw`url = "https://h/" + "a\/b" + ".mp4";`,
    'no quotes at all',
    '',
    String.raw`x = "a" + "b" + "c"; y = "d" + "e";`,
    String.raw`var u = "a" + "b" + "c" +` + '\n' + String.raw`"d";`,
    String.raw`var u = "back \ slash" + "tail";`,
    String.raw`var u = "quote "" inside" + "x";`,
    'var u = "a" + "b" + "c" ; var v = "d" + "e";',
    String.raw`<script>/* <!-- */ var u = "https:\x2f\x2fhost\x2f" + "1.ts";</script>`,
    '<script>\n\n</script><script></script>',
    '<SCRIPT>var u = "a" + "b";</SCRIPT>',
    String.raw`var u = "a" + "b` + '\u00e9' + String.raw`" + "c";`,
    String.raw`var u = "a\é" + "b";`,
    String.raw`var u = "a" + "é` + 'b' + String.raw`" + "c";`,
  ];
  for (const s of cases) {
    probe('jc|' + toB64(s), 'join_concatenations', [s], (js, php) => d.same(
      'joinConcatenations(' + JSON.stringify(s.slice(0, 40)) + ')', JsUnpacker.joinConcatenations(s), mirror(php.res)));
    probe('fl|' + toB64(s), 'flatten', [s], (js, php) => d.same(
      'flatten(' + JSON.stringify(s.slice(0, 40)) + ')', JsUnpacker.flatten(s), mirror(php.res)));
  }
  const tricky = [
    String.raw`<script>var u = "https:\x2f\x2fhost\x2f" + "tok" + "\x2ffile.mp4";</script>`,
    String.raw`<script>var u = "https:\\u002f\\u002fhost" + "\\u002f1.ts";</script>`,
    "}('0.1(\\'https://h/\\');',36,2,'a|b'.split('|'),0,{}))",
    String.raw`var cfg = "{\"url\":\"https:\/\/host\/v.mp4\"}";`,
    '<!-- var u = "a" + "b"; -->',
    String.raw`<script>var u = "\u0068\u0074\u0074\u0070\u003a\u002f\u002fhost" + "\x2f1.ts";</script>`,
    String.raw`eval(function(p,a,c,k,e,d){}("h\u0074tps://host/" + "\u0061",36,2,'a|b'.split('|'),0,{}))`,
    String.raw`<script>var u = "https:" + "\u002f\u002fhost" + "/1.ts";</script>`,
  ];
  tricky.forEach((s, i) => {
    probe('flt|' + i, 'flatten', [s], (js, php) => d.same('flatten(' + JSON.stringify(s.slice(0, 40)) + ')',
      JsUnpacker.flatten(s), mirror(php.res)));
    probe('jct|' + i, 'join_concatenations', [s], (js, php) => d.same('joinConcatenations(' + JSON.stringify(s.slice(0, 40)) + ')',
      JsUnpacker.joinConcatenations(s), mirror(php.res)));
  });
}

// ------------------------------------------------------------------ JsUnpacker fuzz
{
  const rng = makeRng(20261103);
  // Every fragment stays at one byte per character once decoded, so the byte view
  // and the string view of the fuzz cannot drift apart for the wrong reason.
  const fragments = [
    "}('", String.raw`\'`, String.raw`\\`, "'", '"', '`', '+', ' + ', '0', '1', '2', '36', '3,3,',
    String.raw`\x41`, String.raw`\x2f`, String.raw`\x7f`, String.raw`\u0041`, String.raw`\u007f`, '%3A', '%41', '%', '|',
    '.split(', ')', '))', 'eval(', 'function(p,a,c,k,e,d){', '}', ',', ' ', '\n', '\t',
    'console|log|window', 'https://host/', '.mp4', 'String.fromCharCode(65)', '$', '_', '$1',
    '<script>', '</script>', '<!--', '-->', ';', '{}', 'k[c]', 'p=p.replace(new RegExp(', '/', '\\/',
    'é', String.raw`\<`, String.raw`\>`, String.raw`\0`, String.raw`\xg`, '.split("|")', '",36,2,',
  ];
  const blobs = [];
  for (let i = 0; i < 300; i++) {
    let s = '';
    for (let k = rng.int(2, 16); k > 0; k--) {
      s += rng.pick(fragments);
    }
    if (halfCharEscapes(s)) {
      continue;
    }
    blobs.push(s);
  }
  d.ok('the fuzz stayed on the byte-safe side of the backslash rule', blobs.length > 200,
    `${blobs.length} blobs`);
  mark('unpacker fuzz (local)');
  for (let i = 0; i < blobs.length; i++) {
    const s = blobs[i];
    for (const [tag, fn, phpFn] of [['un', JsUnpacker.unpack, 'unpack'], ['ue', JsUnpacker.unescape, 'unescape'],
      ['jc', JsUnpacker.joinConcatenations, 'join_concatenations'], ['fl', JsUnpacker.flatten, 'flatten']]) {
      probe(`fz|${tag}|${i}`, phpFn, [s], (js, php) => {
        if (!php.ok) {
          return d.ok(`${tag} fuzz ${i} refused by php`, php.err !== null, php.err);
        }
        return d.same(`${tag} fuzz ${i} ${JSON.stringify(s.slice(0, 48))}`, fn(s), mirror(php.res));
      });
    }
  }
}

// ------------------------------------------------------------------ certificate fixtures
const ca = path.join(work, 'ca');
fs.mkdirSync(ca, { recursive: true });
const openSsl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
const haveOpenssl = openSsl.status === 0;
const certs = {};

function sh(args) {
  const r = spawnSync('openssl', args, { cwd: ca, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('openssl failed: ' + (r.stderr || r.stdout));
  }
}

if (haveOpenssl) {
  try {
    fs.writeFileSync(path.join(ca, 'mid.csr.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n');
    sh(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'root.key', '-out', 'root.pem',
      '-days', '3650', '-nodes', '-subj', '/CN=Parity Root/C=US',
      '-addext', 'basicConstraints=critical,CA:TRUE']);
    sh(['req', '-newkey', 'rsa:2048', '-keyout', 'mid.key', '-out', 'mid.csr', '-nodes',
      '-subj', '/CN=Parity Intermediate/C=US', '-config', 'mid.csr.cnf']);
    fs.writeFileSync(path.join(ca, 'mid.ext'),
      'basicConstraints=critical,CA:TRUE\nauthorityInfoAccess=caIssuers;URI:http://ca.example.com/root.cer\n');
    sh(['x509', '-req', '-in', 'mid.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-out', 'mid.pem',
      '-days', '3650', '-set_serial', '1', '-extfile', 'mid.ext']);
    sh(['req', '-newkey', 'rsa:2048', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-nodes',
      '-subj', '/CN=short.example.com/C=US', '-config', 'mid.csr.cnf']);
    fs.writeFileSync(path.join(ca, 'leaf.ext'),
      'basicConstraints=CA:FALSE\nsubjectAltName=DNS:short.example.com\n'
      + 'authorityInfoAccess=caIssuers;URI:http://ca.example.com/mid.cer,'
      + 'caIssuers;URI:https://other.example.com/mid.cer\n');
    sh(['x509', '-req', '-in', 'leaf.csr', '-CA', 'mid.pem', '-CAkey', 'mid.key', '-out', 'leaf.pem',
      '-days', '3650', '-set_serial', '2', '-extfile', 'leaf.ext']);
    for (const name of ['root', 'mid', 'leaf']) {
      certs[name] = fs.readFileSync(path.join(ca, name + '.pem'), 'utf8');
    }
  } catch (e) {
    console.log('note: openssl fixtures failed: ' + e.message);
  }
}
d.ok('certificate fixtures available for the parse-side probes', Object.keys(certs).length === 3,
  haveOpenssl ? 'openssl ran but produced nothing' : 'no openssl on this machine');
mark('openssl fixtures (local)');

/** A DER writer just long enough to put an AIA block where the scan has to find it. */
const NEEDLE_BYTES = [0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x02, 0x86];

function derLengthBytes(n) {
  if (n < 0x80) {
    return [n];
  }
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return [0x80 | bytes.length, ...bytes];
}

/**
 * One AIA GeneralName block with the length bytes chosen by the caller, so every
 * branch of php's scan can be aimed at on purpose.
 */
function aiaBlock(uri, lengthBytes) {
  const body = Buffer.from(String(uri), 'latin1');
  return Buffer.concat([Buffer.from(NEEDLE_BYTES), Buffer.from(lengthBytes ?? []), body]);
}

function aiaDer(uri, opts = {}) {
  return Buffer.concat([
    Buffer.from(opts.prefix ?? [0x30, 0x0a, 0x06, 0x03, 0x55, 0x04, 0x03]),
    aiaBlock(uri, opts.lengthBytes ?? derLengthBytes(opts.declared ?? Buffer.from(String(uri), 'latin1').length)),
    Buffer.from(opts.suffix ?? [0x36, 0x00]),
  ]);
}

const pemOf = (buf) => '-----BEGIN CERTIFICATE-----\n' + buf.toString('base64') + '\n-----END CERTIFICATE-----\n';
const phpUris = (php) => php.res.map((b) => Buffer.from(b, 'base64').toString('latin1'));

{
  const uris = [
    'http://ca.example.com/root.cer',
    'https://example.com/aia/x509-ca-ca.crt',
    'http://a.b/' + 'x'.repeat(300 - 11),
    'http://a.b/' + 'x'.repeat(300 - 10),
    'http://a.b/' + 'x'.repeat(300 - 9),
    'ftp://a.b/c',
    'http://a.b/c d',
    'http://a.b/c\nd',
    'http://a.b/c\n',
    'http://a.b/c\n\n',
    'http://a.b/c\t',
    'http://a.b',
    'https://a.b/c?d=1&e=2',
    'http://a.b/\u0001x',
    'http://a.b/\u00e9x',
    '',
    'http:/a.b/c',
    'HTTP://a.b/c',
    'http://a.b/' + 'x'.repeat(299) + '\n',
  ];
  uris.forEach((uri, i) => {
    const pem = pemOf(aiaDer(uri));
    probe('aia|plain|' + i, 'aia_uris', [pem], (js, php) => d.same(
      'aiaUris plain ' + i + ' ' + JSON.stringify(uri.slice(0, 40)), CertChain.aiaUris(pem), phpUris(php)));
  });

  // The length branches, one at a time: short form, the four long forms, the two
  // values outside the window, and the missing-byte reads.
  const pad = (n) => 'a'.repeat(n);
  const lengthCases = [
    ['short form 0x7f', 'http://' + pad(116) + '.b', [0x7f]],
    ['zero length', '', [0x00]],
    ['0x80 is not a long form', 'http://' + pad(119) + '.b', [0x80]],
    ['0x81 one length byte', 'http://' + pad(124) + '.b', [0x81, 0x82]],
    ['0x82 two length bytes', 'http://' + pad(291) + '.b', [0x82, 0x01, 0x28]],
    ['0x83 three length bytes', 'http://' + pad(291) + '.b', [0x83, 0x00, 0x01, 0x28]],
    ['0x84 four length bytes', 'http://' + pad(291) + '.b', [0x84, 0x00, 0x00, 0x01, 0x28]],
    ['0x85 past the window', 'http://' + pad(291) + '.b', [0x85, 0x00, 0x00, 0x01, 0x28]],
    ['0xfe past the window', 'http://' + pad(291) + '.b', [0xfe]],
    ['0xff read as short 255', 'http://' + pad(244) + '.b', [0xff]],
    ['long form past the buffer', 'http://a.b/c', [0x82, 0x03, 0x50]],
    ['long form with bytes missing', 'http://a.b/c', [0x83, 0x01, 0x00]],
    ['length byte missing entirely', 'http://a.b/c', []],
    ['301 chars is too long', 'http://a.b/' + 'x'.repeat(290), [0x82, 0x01, 0x2d]],
    ['300 chars fits', 'http://a.b/' + 'x'.repeat(289), [0x82, 0x01, 0x2c]],
    ['299 chars fits', 'http://a.b/' + 'x'.repeat(288), [0x82, 0x01, 0x2b]],
    ['huge long form', 'http://a.b/c', [0x84, 0x7f, 0xff, 0xff, 0xff]],
  ];
  for (const [label, uri, lengthBytes] of lengthCases) {
    const pem = pemOf(aiaDer(uri, { lengthBytes }));
    probe('aia|len|' + label, 'aia_uris', [pem], (js, php) => {
      if (!php.ok) {
        return d.ok('aiaUris ' + label + ' refused by php', php.err !== null, php.err);
      }
      return d.same('aiaUris ' + label, CertChain.aiaUris(pem), phpUris(php));
    });
  }

  // The needle itself, cut short in every way a corrupt certificate can cut it.
  for (let cut = 1; cut <= 12; cut++) {
    const der = Buffer.concat([aiaDer('http://a.b/c'), Buffer.from([0x06, 0x08, 0x2b])]);
    const pem = pemOf(der.subarray(0, der.length - cut));
    probe('aia|cut|' + cut, 'aia_uris', [pem], (js, php) => d.same('aiaUris truncated by ' + cut,
      CertChain.aiaUris(pem), phpUris(php)));
  }

  // Duplicates, order, and more than one block in one certificate.
  const one = (u) => aiaBlock(u, derLengthBytes(Buffer.from(u, 'latin1').length));
  const many = Buffer.concat([one('http://dup.a/b'), one('http://dup.a/b'), one('https://second.c/d'), one('ftp://skip.me')]);
  const manyPem = pemOf(Buffer.concat([Buffer.from([0x30, 0x00]), many]));
  probe('aia|many', 'aia_uris', [manyPem], (js, php) => d.same('aiaUris dedupes and keeps order',
    CertChain.aiaUris(manyPem), phpUris(php)));
  d.same('aiaUris dedupes to exactly the two http blocks', CertChain.aiaUris(manyPem),
    ['http://dup.a/b', 'https://second.c/d']);

  // Real certificates, including the short-form length a real AIA always uses.
  for (const [name, pem] of Object.entries(certs)) {
    probe('aia|real|' + name, 'aia_uris', [pem], (js, php) => d.same('aiaUris ' + name,
      CertChain.aiaUris(pem), phpUris(php)));
  }
  if (certs.leaf) {
    d.same('aiaUris finds both issuers on the fixture leaf', CertChain.aiaUris(certs.leaf),
      ['http://ca.example.com/mid.cer', 'https://other.example.com/mid.cer']);
  }
  if (certs.mid) {
    d.same('aiaUris finds the one issuer on the fixture intermediate', CertChain.aiaUris(certs.mid),
      ['http://ca.example.com/root.cer']);
  }

  const rng = makeRng(31337);
  for (let i = 0; i < 240; i++) {
    const parts = [];
    for (let k = rng.int(1, 6); k > 0; k--) {
      const kind = rng.int(0, 4);
      if (kind === 0) {
        const len = rng.int(0, 40);
        const scheme = rng.pick(['http://', 'https://', 'ftp://', '']);
        const body = [];
        for (let c = 0; c < len; c++) {
          body.push(rng.pick([0x61 + rng.int(0, 20), 0x2e, 0x2f, 0x3a, 0x20, 0x09, 0x0a, 0x0d, 0x00, 0x7f, 0x80, 0xff, 0x41]));
        }
        const uri = Buffer.concat([Buffer.from(scheme, 'latin1'), Buffer.from(body)]).toString('latin1');
        parts.push(aiaBlock(uri, rng.pick([derLengthBytes(uri.length), [rng.int(0, 255)],
          [0x81, rng.int(0, 255)], [0x82, rng.int(0, 255), rng.int(0, 255)], [0x85, 0x01, 0x00]])));
      } else if (kind === 1) {
        parts.push(rng.bytes(rng.int(1, 60)));
      } else if (kind === 2) {
        parts.push(Buffer.from(NEEDLE_BYTES));
      } else if (kind === 3) {
        parts.push(Buffer.from([0x86, 0x81, 0x10, 0x41, 0x41]));
      } else {
        parts.push(aiaDer('http://f' + i + '.example.com/a.cer'));
      }
    }
    const pem = pemOf(Buffer.concat(parts));
    probe('aia|fz|' + i, 'aia_uris', [pem], (js, php) => {
      if (!php.ok) {
        return d.ok('aiaUris fuzz ' + i + ' refused by php', php.err !== null, php.err);
      }
      return d.same('aiaUris fuzz ' + i, CertChain.aiaUris(pem), phpUris(php));
    });
  }
  mark('aiaUris (local)');
}

// ------------------------------------------------------------------ der, fingerprint, self-signed
{
  const texts = [
    '-----BEGIN CERTIFICATE-----\nQQ==QQ\n-----END CERTIFICATE-----',
    '-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----',
    'no markers at all',
    '-----BEGIN CERTIFICATE-----abc-----END CERTIFICATE-----extra-----BEGIN CERTIFICATE-----def-----END CERTIFICATE-----',
    '-----BEGIN CERTIFICATE-----\r\nQQ Q\r\n\t-----END CERTIFICATE-----',
    '-----BEGIN CERTIFICATE-----AB==CD-----END CERTIFICATE-----',
    '-----BEGIN CERTIFICATE------_8-----END CERTIFICATE-----',
    '-----BEGIN CERTIFICATE-----a=B-----END CERTIFICATE-----',
    '-----BEGIN PUBLIC KEY-----QQ==-----END CERTIFICATE-----',
    '-----BEGIN CERTIFICATE-----QQ==-----END PRIVATE KEY-----',
    '-----BEGIN CERTIFICATE-----QQ==\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----AA==\n-----END CERTIFICATE-----',
    '-----BEGIN CERTIFICATE-----\u00a0QQ==\u00a0-----END CERTIFICATE-----',
    '',
    '-----BEGIN CERTIFICATE-----',
    '-----END CERTIFICATE-----',
    String.raw`-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----`,
    '-----BEGIN CERTIFICATE-----QQ==-----END CERTIFICATE-----QQ==-----END CERTIFICATE-----',
  ];
  const rng = makeRng(4242);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/= \n\t_-\r';
  for (let i = 0; i < 60; i++) {
    let s = '';
    for (let k = rng.int(0, 40); k > 0; k--) {
      s += alphabet[rng.int(0, alphabet.length - 1)];
    }
    texts.push('-----BEGIN CERTIFICATE-----' + s + '-----END CERTIFICATE-----');
    texts.push(s);
  }
  for (const [name, pem] of Object.entries(certs)) {
    texts.push(pem);
    texts.push(pem.replace('-----END CERTIFICATE-----', ''));
    texts.push(pem.replace(/\n/g, '\r\n'));
  }
  texts.forEach((pem, i) => {
    probe('der|' + i, 'der', [pem], (js, php) => {
      if (!php.ok) {
        return d.ok('der ' + i + ' refused by php', php.err !== null, php.err);
      }
      return d.same('der ' + i + ' ' + JSON.stringify(pem.slice(0, 30)),
        CertChain.der(pem).toString('base64'), php.res);
    });
    probe('fp|' + i, 'fingerprint', [pem], (js, php) => {
      if (!php.ok) {
        return d.ok('fingerprint ' + i + ' refused by php', php.err !== null, php.err);
      }
      return d.same('fingerprint ' + i, CertChain.fingerprint(pem), php.res);
    });
  });
  for (const [name, pem] of Object.entries(certs)) {
    probe('self|' + name, 'is_self_signed', [pem], (js, php) => d.same('isSelfSigned ' + name,
      CertChain.isSelfSigned(pem), php.res));
    probe('self|garbage|' + name, 'is_self_signed', [pem.slice(0, 40) + 'ZZ'], (js, php) => d.same(
      'isSelfSigned of a broken ' + name, CertChain.isSelfSigned(pem.slice(0, 40) + 'ZZ'), php.res));
  }
  const broken = '-----BEGIN CERTIFICATE-----ZZ\n-----END CERTIFICATE-----';
  probe('self|notpem', 'is_self_signed', [broken], (js, php) => d.same('isSelfSigned of unreadable pem',
    CertChain.isSelfSigned(broken), php.res));

  // base64_decode() itself, since der() leans on its non-strict skip-everything rule.
  const b64cases = ['QQ==', 'QQ==QQ', 'a=B', '', 'A', 'AB', 'ABC', 'ABCD', 'AB==CD', '=', 'AA=A', 'A=AA',
    '-_8', '+/8', '0+/=', 'aa==aa', 'AB=C=D=E', 'QQ QQ', '\tQ\nQ', 'AAAAAAAA', 'ABCDABCDABCD',
    'QQ==\n', '=QQ==', 'A===', '====', '/+/+/+/+', 'AAAA====', 'A A A A', 'zzzz', '8/+9', 'AGU=',
    'AGU', 'AG', 'A=', '\u00a0QQ'];
  const rng2 = makeRng(99);
  for (let i = 0; i < 80; i++) {
    let s = '';
    for (let k = rng2.int(0, 24); k > 0; k--) {
      s += alphabet[rng2.int(0, alphabet.length - 1)];
    }
    b64cases.push(s);
  }
  b64cases.forEach((s, i) => probe('b64|' + i, 'base64_decode', [s], (js, php) => {
    if (!php.ok) {
      return d.ok('base64 ' + i + ' refused by php', php.err !== null, php.err);
    }
    // der() strips php's \s set before decoding, so this is the same rule.
    return d.same('base64 through der ' + i + ' ' + JSON.stringify(s),
      CertChain.der('-----BEGIN CERTIFICATE-----' + s + '-----END CERTIFICATE-----').toString('base64'), php.res);
  }));
}

// ------------------------------------------------------------------ filter_var port
{
  const hosts = ['a.b', 'a_b.com', '-a.b', 'a-.b', 'a..b', '.a.b', 'a.b.', 'a!b.com', 'a;b.com', 'a,b.com',
    "a'b.com", 'a(b).com', 'a*b.com', 'a=b.com', 'a+b.com', 'a~b.com', 'a%2eb.com', 'a?b.com', 'a&b.com',
    'a#b.com', 'a@b.com', 'a/b.com', 'xn--80ak6aa92e.com', '1.2.3.4', '[::1]', 'a.b:1', 'a.b:65535',
    'a.b:65536', 'a.b:0', 'a.b:', 'a.b:80x', 'a.b:0x8', 'a.b:+8', 'user:pa@a.b', 'x', '_a.b', 'a._b',
    'a.b:0000000080', 'a.b:123456', 'a.b:99999', 'a.b:100000', 'a.b:1_0', 'a.b:80:90', '[::1]x', '[::1]:80:90'];
  const urls = hosts.map((h) => 'http://' + h);
  for (const tail of ['', '/', '/x', '/x#f', '//x', '/(y)', '/%', '/%zz', '/a?b=c', String.raw`/a\b`, '/x:y', '/:123456']) {
    urls.push('https://a.b' + tail);
  }
  urls.push('http://', 'ftp://a.b', 'http:foo', 'a.b', 'https://a.b/' + 'x'.repeat(400), 'HTTP://A.B',
    'http://a.b/x\ty', 'http://a.b/x y', 'http://a.b/\u0001', 'http://a.b/\u007f', 'http://ä.b',
    'http://a.b/c?d=1&e=2#f', 'https://a.b:443/x.cer', 'http://:80', 'http://a.b@x', 'http://a.b#f');
  const rng = makeRng(5150);
  const bits = ['a', '1', '-', '.', '_', '@', ':', '/', '?', '#', '%', 'b', '9', '+', ' ', '\n', '[', ']', 'ä'];
  for (let i = 0; i < 220; i++) {
    let s = '';
    for (let k = rng.int(1, 7); k > 0; k--) {
      s += rng.pick(bits);
    }
    urls.push(rng.pick(['http://', 'https://', '']) + s + rng.pick(['', '.com', '/x', ':80', ':123456']));
  }
  urls.forEach((u, i) => probe('fu|' + i, 'filter_url', [u], (js, php) => {
    const mine = validatesUrl(u);
    if (!php.ok) {
      return d.ok('filter_url ' + i + ' refused outright by php', php.err !== null, php.err);
    }
    // The port mirrors the filter for the shapes aiaUris emits; a scan can never
    // hand over whitespace, so those agree as much as they have to.
    if (/[\s\x00-\x1f\x7f]/.test(u)) {
      return d.ok('filter_url ' + i + ' ' + JSON.stringify(u) + ' is outside the aia shape',
        mine === php.res || (php.res === false && /\s/.test(u)), `js=${mine} php=${php.res}`);
    }
    return d.same('filter_url(' + JSON.stringify(u) + ')', mine, php.res);
  }));
}

// ------------------------------------------------------------------ store and cache paths
{
  const cacert = path.join(import.meta.dirname, '..', 'tools', 'cacert.pem');
  const big = fs.existsSync(cacert) ? fs.readFileSync(cacert, 'utf8') : certs.root + certs.mid + certs.root;
  const fixtures = {
    'big.pem': big.slice(0, 9000),
    'small.pem': big.slice(0, 900),
    'bignotpem.txt': 'x'.repeat(9000),
    'shortnotpem.txt': 'x'.repeat(100),
    'pemtoolate.txt': 'y'.repeat(5000) + '-----BEGIN CERTIFICATE-----',
  };
  for (const [name, text] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(work, name), text, 'utf8');
  }
  const files = Object.keys(fixtures).map((n) => path.join(work, n).replace(/\\/g, '/'));
  const unixPaths = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem'];

  // php's own chain, with node reading the two ini slots through its env slots.
  const iniRun = oracleRun([{ id: 'ini', fn: 'ini', args: [] }], 'oracle-unpack.php');
  const phpIni = iniRun.get('ini').res;
  probe('ss|real', 'system_store', [], (js, php) => {
    if (phpIni['curl.cainfo']) {
      process.env.VD_CURL_CAINFO = phpIni['curl.cainfo'];
    }
    if (phpIni['openssl.cafile']) {
      process.env.VD_OPENSSL_CAFILE = phpIni['openssl.cafile'];
    }
    const mine = CertChain.systemStore();
    delete process.env.VD_CURL_CAINFO;
    delete process.env.VD_OPENSSL_CAFILE;
    d.same('systemStore() over the same slots php reads', mine === null ? null : String(mine).replace(/\\/g, '/'),
      php.res === null ? null : String(php.res).replace(/\\/g, '/'));
  });

  // The order of the chain, diff-tested over injected candidates: ini_set() can
  // retarget openssl.cafile but never curl.cainfo (it is PHP_INI_SYSTEM), so the
  // oracle runs the body of systemStore() verbatim on the same list node gets.
  const chains = [
    [phpIni['curl.cainfo'], phpIni['openssl.cafile'], ...unixPaths],
    [phpIni['curl.cainfo'], '', ...unixPaths],
    ['', phpIni['curl.cainfo'], ...unixPaths],
    ['', '', ...unixPaths],
    [files[0], files[1], ...unixPaths],
    [files[1], files[0], ''],
    [files[2], files[0]],
    ['', files[2], '', files[3], files[0]],
    [work.replace(/\\/g, '/'), files[0]],
    [path.join(work, 'missing.pem').replace(/\\/g, '/'), files[3]],
    [],
    [''],
    [files[4], files[0]],
  ];
  chains.forEach((list, i) => {
    probe('sw|' + i, 'store_walk', [list], (js, php) => {
      const mine = CertChain.systemStore(list);
      d.same('store chain ' + i, mine === null ? null : String(mine).replace(/\\/g, '/'),
        php.res === null || php.res === false ? null : String(php.res).replace(/\\/g, '/'));
    });
  });
  // The acceptance expression on its own, candidate by candidate.
  for (const file of [...files, path.join(work, 'missing.pem').replace(/\\/g, '/'), work.replace(/\\/g, '/'), '', '.']) {
    probe('acc|' + file, 'store_accepts', [file], (js, php) => d.same('store accepts ' + JSON.stringify(file),
      CertChain.systemStore([file]) !== null, php.res));
  }
  d.ok('machineStore() has roots even where no cafile exists',
    CertChain.machineStore() !== null && CertChain.machineStore().includes('BEGIN CERTIFICATE'),
    String(CertChain.machineStore()).slice(0, 30));

  const hosts = ['Example.COM', 'a.b', '', '0', 'xn--bcher-kva.de', 'CA.EXAMPLE.COM', 'host.example.com',
    'ünïcode.example.com', 'a'.repeat(70) + '.com', 'à.b'];
  hosts.forEach((h, i) => probe('cp|' + i, 'cache_path', [h], (js, php) => {
    const mine = CertChain.cachePath(h);
    d.same('cachePath ' + JSON.stringify(h), { dir: path.basename(path.dirname(mine)), name: path.basename(mine) }, php.res);
  }));
  const cached = CertChain.cachePath('Example.COM');
  d.ok('cachePath created its directory', fs.existsSync(path.dirname(cached)));
  d.ok('cachePath hashes the lowercased host',
    path.basename(cached) === crypto.createHash('sha256').update('example.com').digest('hex').slice(0, 24) + '.pem',
    path.basename(cached));
  mark('store + cachePath (local)');
}

// ------------------------------------------------------------------ the async surface php cannot be compared to here
{
  // These paths leave the machine, so the only assertions possible offline are
  // that they refuse cleanly rather than throw.
  const dead = await CertChain.peerChain('no-such-host.invalid');
  d.ok('peerChain gives an empty chain when the host is unreachable', Array.isArray(dead) && dead.length === 0,
    JSON.stringify(dead));
  const refused = await CertChain.peerChain('');
  d.ok('peerChain refuses a host it cannot name', refused.length === 0);
  const none = await CertChain.fetchIssuer('http://127.0.0.1/x.cer');
  d.ok('fetchIssuer refuses a private address before any socket opens', none === null);
  const junk = await CertChain.fetchIssuer('http://a_b.example/x.cer');
  d.ok('fetchIssuer refuses a url php refused', junk === null);
  const badScheme = await CertChain.fetchIssuer('ftp://pub.example/x.cer');
  d.ok('fetchIssuer only ever fetches http', badScheme === null);
  const bundle = await CertChain.bundleFor('no-such-host.invalid');
  d.ok('bundleFor answers null for a host it cannot read', bundle === null);
  d.ok('bundleFor remembers the refusal', CertChain.done.get('no-such-host.invalid') === null);

  // The trust test node can run: a fixture leaf is signed by the fixture
  // intermediate, and by nothing else in a store made of the root alone.
  if (certs.root && certs.mid && certs.leaf) {
    d.ok('trustedByStore accepts a certificate the store signed',
      CertChain.trustedByStore(certs.mid, certs.root), 'root signed mid');
    d.ok('trustedByStore rejects one the store did not sign',
      !CertChain.trustedByStore(certs.leaf, certs.root), 'root did not sign the leaf directly');
    d.ok('trustedByStore says no to garbage', !CertChain.trustedByStore('not a pem', certs.root));
    d.ok('isSelfSigned reads the fixture root as self signed', CertChain.isSelfSigned(certs.root));
    d.ok('isSelfSigned reads the fixture leaf as issued', !CertChain.isSelfSigned(certs.leaf));
    d.ok('a fetched issuer is only ever used after the store check, so a leaf-only chain stops here',
      CertChain.aiaUris(certs.leaf).length === 2);
  }

  if (process.env.VD_LIVE_TLS === '1') {
    const host = process.env.VD_LIVE_HOST || 'example.com';
    const chain = await CertChain.peerChain(host);
    d.ok('live peerChain read ' + host, chain.length > 0, `${chain.length} certificates`);
    const live = await CertChain.bundleFor(host);
    d.ok('live bundleFor for ' + host + ' answered without throwing', live === null || typeof live === 'string',
      typeof live);
    const again = await CertChain.bundleFor(host);
    d.ok('live bundleFor is memoised', again === live);
  } else {
    console.log('note: live tls probes skipped (set VD_LIVE_TLS=1, optionally VD_LIVE_HOST).');
  }
  mark('tls surface (local)');
}

const results = oracleRun(probes, 'oracle-unpack.php');
const SECTION_NAMES = {
  base: 'JsUnpacker::base',
  sc: 'stripcslashes', scf: 'stripcslashes fuzz',
  unpack: 'JsUnpacker::unpack', hard: 'JsUnpacker::unpack edges',
  ua: 'JsUnpacker::unpackArgs',
  ue: 'JsUnpacker::unescape',
  jc: 'joinConcatenations', jct: 'joinConcatenations',
  fl: 'flatten', flt: 'flatten',
  fz: 'packer fuzz',
  aia: 'CertChain::aiaUris',
  der: 'CertChain::der', der2: 'CertChain::der', fp: 'CertChain::fingerprint',
  self: 'CertChain::isSelfSigned',
  b64: 'php base64_decode',
  fu: 'filter_var(FILTER_VALIDATE_URL)',
  ss: 'CertChain::systemStore', sw: 'CertChain::systemStore order', acc: 'store acceptance test',
  cp: 'CertChain::cachePath',
};
const sectionOf = (id) => {
  const parts = id.split('|');
  const head = parts[0];
  if (head === 'fz') {
    return { un: 'packer fuzz unpack', ue: 'packer fuzz unescape', jc: 'packer fuzz concatenations', fl: 'packer fuzz flatten' }[parts[1]] ?? 'packer fuzz';
  }
  return SECTION_NAMES[head] ?? head;
};

const bySection = new Map();
let passBefore = d.pass;
let failBefore = d.failures.length;
for (const c of checks) {
  const rec = results.get(c.id);
  if (!rec) {
    d.ok('oracle answered ' + c.id, false, 'no line for this probe');
  } else {
    try {
      c.check(null, rec);
    } catch (e) {
      d.ok('check ' + c.id + ' threw', false, `${e.name}: ${e.message}`);
    }
  }
  const key = sectionOf(c.id);
  const tally = bySection.get(key) ?? { pass: 0, fail: 0 };
  tally.pass += d.pass - passBefore;
  tally.fail += d.failures.length - failBefore;
  passBefore = d.pass;
  failBefore = d.failures.length;
  bySection.set(key, tally);
}

console.log('\nassertions per section');
for (const [name, passed, failed] of inlineCounts) {
  console.log(`  ${name}: ${passed} matched, ${failed} diverged`);
}
for (const [name, t] of bySection) {
  console.log(`  ${name}: ${t.pass} matched, ${t.fail} diverged`);
}

d.report('jsUnpacker + certChain differential parity');
try {
  fs.rmSync(work, { recursive: true, force: true });
} catch {
  /* the temp tree is ours and the os will take it anyway */
}
process.exit(d.failures.length === 0 ? 0 : 1);
