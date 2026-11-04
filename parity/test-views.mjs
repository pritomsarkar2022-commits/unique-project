import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diff, oracleRun, phpAvailable } from './harness.mjs';
import { renderHome } from '../site/src/views/home.mjs';
import { renderError } from '../site/src/views/error.mjs';
import { ExtractorRegistry } from '../site/src/extractor/extractorRegistry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Differential parity for the two pages a visitor actually looks at.
 *
 * The engine suites prove the mp4 is the same file; this proves the parts of the html
 * that are computed are the same bytes, including the whitespace php leaves behind its
 * inline if-blocks, which is the part a hand-written template always gets wrong.
 *
 * The reference renders come from `parity/oracle-views.php`, which requires the
 * untouched `source/views/*.php` and captures the output buffer. ASSET_VER is pinned
 * there (it is a filemtime the two checkouts cannot agree on) and passed to the port as
 * `assetVer`, so the version digits line up without either side faking the other.
 *
 * Home is compared as four fragments, not as one document, because the page itself is
 * the owner's design: the prose was cut and the sections re-arranged, so a whole-file
 * comparison would only ever report where the copy was removed. What is left is what a
 * change to the php would have to agree about, and each of those is still byte-exact:
 * the <head> (title, canonical, og:url, base_href asset paths, ASSET_VER), the chip per
 * host, the table row per reader group, and the footer year. The error page is a whole
 * document still, because nothing about it was restyled.
 */

const diff = new Diff();
if (!phpAvailable()) {
  console.error('SKIPPED: no php binary (set PHP_BIN). The views are NOT verified.');
  process.exit(2);
}

const PINNED_ASSET_VER = '1735689600';
const b64 = (s) => Buffer.from(s, 'binary').toString('base64');
const enc = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [b64(k), b64(v)]));

/** Home page probes: the real registry plus shapes the sort logic has to survive. */
const homeMaps = {
  empty: {},
  single: { 'streamtape.com': 'streamtape' },
  twoReaders: { 'b.example': 'bravo', 'a.example': 'alpha' },
  // One reader, many suffixes: the tld rank decides the chip, and strcmp breaks ties.
  tldLadder: Object.fromEntries(
    ['pro', 'info', 'pe', 'sx', 'ps', 'co', 'ch', 'click', 'live', 'site', 'org', 'me', 'gs', 'io', 'to', 'net', 'com']
      .map((tld) => ['same.' + tld, 'same']),
  ),
  // A cdn-shaped sibling must lose to the bare domain even though "cdn" sorts first.
  cdn: { 'cdn.example.com': 'example', 'example.com': 'example', 'm.example.net': 'example' },
  // Unknown tlds all rank 99, so only strcmp decides.
  unknownTlds: { 'z.example.xyz': 'x', 'a.example.xyz': 'x', 'm.example.xyz': 'x' },
  upper: { 'STREAMTAPE.COM': 'streamtape', 'Up.Example.Com': 'up', 'mix.Example.com': 'up' },
  // A reader name that looks like a number hits ksort's SORT_REGULAR branch.
  numericReaders: { 'a.host': '10', 'b.host': '9', 'c.host': '100' },
  // Core-of-two rule: a one-label host has no registrable core.
  shortHosts: { 'localhost': 'local', 'x': 'local', 'a.b': 'ab' },
  // Bytes that are not valid utf-8, the way php hands a punycode or idn host over.
  oddBytes: { 'caf\xe9.example': 'cafe', 'xn--80ak6aa92e.com': 'cyrl', '\xc3\xa9xample.com': 'cafe' },
};

const registryHosts = await new ExtractorRegistry().knownHosts();
assert.ok(Object.keys(registryHosts).length > 10, 'the port registry returned no hosts');

const probes = [];
const want = [];
for (const [name, hosts] of Object.entries(homeMaps)) {
  probes.push({ id: 'home-' + name, fn: 'home', hosts: enc(hosts) });
  want.push({ id: 'home-' + name, kind: 'home', hosts });
}
probes.push({ id: 'home-registry', fn: 'home', hosts: enc(registryHosts) });
want.push({ id: 'home-registry', kind: 'home', hosts: registryHosts });

// The same content reached through a different url: the canonical tag and the og:url
// follow site_url(), and base_href() moves the asset paths, so both are pinned.
for (const [id, server] of [
  ['srv-plain', { SCRIPT_NAME: '/index.php', HTTP_HOST: 'grably.example', HTTPS: true }],
  ['srv-subdir', { SCRIPT_NAME: '/tools/index.php', HTTP_HOST: 'grably.example', HTTPS: true }],
  ['srv-port', { SCRIPT_NAME: '/index.php', HTTP_HOST: 'grably.example:8080', HTTPS: false }],
  ['srv-badhost', { SCRIPT_NAME: '/index.php', HTTP_HOST: 'ev il.example', HTTPS: true }],
]) {
  probes.push({ id, fn: 'home', hosts: enc(homeMaps.cdn), server, solo: true });
  want.push({ id, kind: 'home-url', server });
}
probes.push({ id: 'cfg-baseurl', fn: 'home', hosts: enc(homeMaps.cdn), config: { 'app.base_url': 'https://fixed.example/' } });
want.push({ id: 'cfg-baseurl', kind: 'home-url', baseUrl: 'https://fixed.example' });

const errorCases = [
  { id: 'err-404', notFound: true, fatal: '' },
  { id: 'err-500', notFound: false, fatal: '' },
  { id: 'err-fatal', notFound: false, fatal: 'Uncaught TypeError: bad() at TsDemuxer.php:137' },
  { id: 'err-fatal-chars', notFound: true, fatal: 'quote " & <tag> and a stray \xc3 byte' },
  { id: 'err-fatal-quotes', notFound: false, fatal: 'she said \'hi\' & <b>meant</b> it -- caf\xc3\xa9 is valid utf-8' },
];
for (const c of errorCases) {
  probes.push({ id: c.id, fn: 'error', notFound: c.notFound, fatal: b64(c.fatal) });
  want.push({ id: c.id, kind: 'error', notFound: c.notFound, fatal: c.fatal });
}

// base_href() memoises its answer in a php static, so a probe that asks a different
// SCRIPT_NAME has to be the only probe in its php process. Everything else can share
// one run.
const batch = probes.filter((p) => !p.solo);
const out = oracleRun(batch, 'oracle-views.php');
for (const p of probes.filter((pr) => pr.solo)) {
  for (const [id, res] of oracleRun([p], 'oracle-views.php')) {
    out.set(id, res);
  }
}

// The reference renders a year from the clock; so does the port. Comparing them at the
// same instant is honest, and a test that ran across midnight on 31 December would only
// ever disagree in those four characters.
const year = new Date().getFullYear();

const homeFragments = {
  head: (s) => s.slice(0, s.indexOf('</head>') + 7),
  chips: (s) => (s.match(/<span class="chip">[\s\S]*?<\/span>/g) ?? []).join('\n'),
  rows: (s) => (s.match(/<tr>[\s\S]*?<\/tr>/g) ?? []).join('\n'),
  year: (s) => {
    const m = /&copy; \d{4} [^<]*</.exec(s);
    return m === null ? '' : m[0];
  },
};

for (const w of want) {
  const php = out.get(w.id);
  if (!diff.ok(`${w.id}: oracle answered`, php && php.ok, php ? String(php.err) : 'no line')) {
    continue;
  }
  const expected = Buffer.from(php.res.html, 'base64').toString('binary');
  let actual;
  if (w.kind === 'home') {
    actual = renderHome({ hosts: w.hosts, siteUrl: 'https://grably.example', year, assetVer: PINNED_ASSET_VER });
  } else if (w.kind === 'home-url') {
    actual = renderHome({
      hosts: homeMaps.cdn,
      siteUrl: siteUrlFor(w.server, w.baseUrl),
      baseHref: baseHrefFor(w.server),
      year,
      assetVer: PINNED_ASSET_VER,
    });
  } else {
    actual = renderError({ notFound: w.notFound, fatal: w.fatal, baseHref: '/', assetVer: PINNED_ASSET_VER });
  }
  if (w.kind === 'error') {
    if (!diff.ok(`${w.id}: html identical (${expected.length} bytes)`, actual === expected, firstByteDiff(actual, expected))) {
      writeFail(w.id, expected, actual);
    }
    continue;
  }
  diff.ok(`${w.id}: the oracle produced a home page`, expected.length > 6000, expected.length + ' bytes');
  for (const [name, pick] of Object.entries(homeFragments)) {
    const wantText = pick(expected);
    const gotText = pick(actual);
    if (!diff.ok(`${w.id}: ${name} fragment identical (${wantText.length} bytes)`, gotText === wantText, firstByteDiff(gotText, wantText))) {
      writeFail(w.id, expected, actual);
    }
  }
}

function writeFail(id, phpHtml, jsHtml) {
  fs.mkdirSync(path.join(here, '..', 'capture', 'views', 'fail'), { recursive: true });
  fs.writeFileSync(path.join(here, '..', 'capture', 'views', 'fail', id + '.php.html'), phpHtml, 'binary');
  fs.writeFileSync(path.join(here, '..', 'capture', 'views', 'fail', id + '.js.html'), jsHtml, 'binary');
}

/** base_href(): the front controller's own directory, with a trailing slash. */
function baseHrefFor(server) {
  const script = String(server?.SCRIPT_NAME ?? '/index.php').replace(/\\/g, '/');
  const dir = script.slice(0, script.lastIndexOf('/')).replace(/\/+$/, '');
  return dir + '/';
}

/** site_url() as the reference computed it: filtered host, scheme, then base_href. */
function siteUrlFor(server, baseUrl) {
  if (baseUrl !== undefined) {
    return baseUrl;
  }
  const https = server.HTTPS !== false;
  let host = String(server.HTTP_HOST ?? '');
  if (!/^[A-Za-z0-9.\-]{1,100}(:\d{2,5})?$/.test(host)) {
    host = 'localhost';
  }
  const script = String(server.SCRIPT_NAME ?? '/index.php').replace(/\\/g, '/');
  const dir = script.slice(0, script.lastIndexOf('/')).replace(/\/+$/, '');
  return (https ? 'https' : 'http') + '://' + host + dir;
}

function firstByteDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  if (i === a.length && i === b.length) {
    return '';
  }
  return 'at ' + i + ': js=' + JSON.stringify(a.slice(Math.max(0, i - 30), i + 30))
    + ' php=' + JSON.stringify(b.slice(Math.max(0, i - 30), i + 30));
}

process.exit(diff.report('views differential parity') ? 0 : 1);
