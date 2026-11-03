import crypto from 'node:crypto';
import { oracleRun, phpAvailable, Diff, makeRng } from './harness.mjs';
import { e, humanBytes, urlAbsolutize, parseUrl, linkSeal, linkOpen } from '../site/src/support.mjs';
import { assertSafe } from '../site/src/net/urlGuard.mjs';

/** The relay key is agreed by two codebases that never share code; pin the derivation. */
function relayKey(secret) {
  return crypto.createHmac('sha256', String(secret)).update('relay-link').digest('base64');
}

if (!phpAvailable()) {
  console.log('SKIPPED: no PHP binary, so nothing was compared. Set PHP_BIN to the reference build.');
  process.exit(3);
}

const d = new Diff();
const probes = [];
const checks = [];

/** Queue one probe and say how the node result must line up with php's. */
function probe(id, fn, args, check) {
  probes.push({ id, fn, args });
  checks.push({ id, fn, args, check });
}

// ------------------------------------------------------------------ e()
for (const s of [
  '', 'plain', 'a & b', '<script>x</script>', 'quote " and apostrophe \'',
  'b<title>&amp;</title>', 'unicode: café ✓ 日本', '<b>"\'&</b>', '&amp;amp;',
  'back\\slash', 'tab\there', 'newline\nhere', '<a href="?url=x">y</a>', '"0"', 'a"<b>',
  '<em>a</em> & <strong>b</strong> "c"', "it's", '{{}}', '0',
]) {
  probe('e|' + s, 'e', [s], (js, php) => d.same('e(' + JSON.stringify(s) + ')', js, php));
}

// ------------------------------------------------------------------ human_bytes
for (const n of [0, 1, 2, 9, 9.5, 10, 512, 999, 1000, 1023, 1024, 1025, 1536, 9999, 10000,
  65536, 1048576, 1048577, 5242880, 1073741824, 1099511627776, 36610, 37748736,
  999999, 1048575, 1048577, 123456789, 9876543210, 10995116277760, 3, 7, 31, 33, 99, 101,
  999999999999, 1023 * 1024, 10 * 1024 ** 4]) {
  probe('hb|' + n, 'human_bytes', [n], (js, php) => d.same('human_bytes(' + n + ')', js, php));
}

// ------------------------------------------------------------------ url_absolutize
// The oracle runs on windows, where php's dirname() returns a backslash for a
// one-level path. Only the separator differs from the linux host this deploys to,
// so both sides are folded to forward slashes before comparing.
const fold = (s) => String(s).replace(/\\/g, '/');
for (const b of [
  'https://site.com/v/abc', 'https://site.com/', 'https://site.com', 'http://site.com/a/b/c.html',
  'https://site.com:8443/p/q', 'https://site.com/p/x?y=1', 'https://site.com/#frag',
  'http://site.com', 'https://cdn.site.com/hls/master.m3u8', 'not a url', 'https:///',
  'https://site.com/a/b/', 'https://user@site.com/a/b', 'https://site.com/a#b/c',
  'https://site.com/one', 'http://a.b.c/d/e/f.ts',
]) {
  for (const r of [
    'x.m3u8', './hls/master.m3u8', '/abs/one.ts', '//other.com/a.mp4', 'deep/er/file.ts',
    'data:text/plain,x', 'magnet:?xt=1', 'a\\b.mp4', '?q=1', '#f', '', '  spaced  ',
    '../../../etc/passwd', 'C:/x', 'http://other.com/z', 'https://other.com/z?a=b',
    'x?a=b#c', '/', './', '..', 'a//b', 'one.ts?token=abc',
  ]) {
    probe('ua|' + b + '|' + r, 'url_absolutize', [b, r], (js, php) => d.same(
      `url_absolutize(${JSON.stringify(b)},${JSON.stringify(r)})`, fold(js), fold(php)));
  }
}

// ------------------------------------------------------------------ parse_url, authority shapes: key for key
const hosts = ['example.com', 'sub.domain.cloudfam.io', 'cdn-mxdrop.click', 'xn--bcher-kva.de', 'a-b.site.com'];
for (const scheme of ['http', 'https', 'HTTP']) {
  for (const host of hosts) {
    for (const port of ['', ':80', ':443', ':8443']) {
      for (const path of ['', '/', '/v/abc', '/a/b/c.m3u8', '/x?y=1']) {
        const url = `${scheme}://${host}${port}${path}`;
        probe('pu|' + url, 'parse_url', [url], (js, php) => d.same('parse_url(' + url + ')', js.value, php.value));
      }
    }
  }
}
// The authority grammar's sharp edges, all of which php answers differently from a
// naive first-colon split.
for (const url of [
  'http://ok.com:80:/a/b', 'http://ok.com:80:8080/x', 'http://a.b:1:2:3/x', 'http://:80/x', 'http://:80',
  'http://ok.com:65535/x', 'http://ok.com:65536/x', 'http://ok.com:0/x', 'http://ok.com:00080/x',
  'http://ok.com: 80/x', 'http://[::1]:80/x', 'http://[::1]:99999/x', 'http://[::1]x/y', 'http://[fe80::1%25eth0]/x',
  'http://ok.com:/x', 'http://ok.com:/', 'http://ok.com:80:', 'http://ok.com:99999', 'http://ok.com:1x/x',
  'http://user:pa:ss@ok.com:8443/a', 'http://user@ok.com:80/a', 'http://ok.com?x', 'http://ok.com#y',
  'http://ok.com/a#b/c', 'http://ok.com:80#f', '//ok.com:80/a', 'http:///a', 'http://', 'http://: ',
  'http://ok.com:8000000/x', 'http://ok.com:065536/x', 'http://ok.com:80:90:100/x', 'http://[::1]:+80/x',
  'http://[::1]:1x/x', 'http://[::1]:x/y', 'http://[::1]:80:90/a', 'http://[]/x', 'http://[a]:80/a',
  'http://ok.com:080x/y', 'http://ok.com/a?q=b:c', 'http://ok.com/a?b#c:d', 'http://xn--a.com:65535',
  'https://user:pass@host.com:8443/a/b?c=d#e', 'HTTPS://HOST.COM/Path', 'https://host.com./x',
  'http://ok.com/a/b:c', 'http://ok.com%23:80', 'http://sub.ok.com:99999', 'https://exa mple.com/x',
]) {
  probe('pu3|' + url, 'parse_url', [url], (js, php) => d.same('parse_url(' + JSON.stringify(url) + ')', js.value, php.value));
}
// Everything without "//" lands in php's legacy branch, which sometimes invents a
// host for "a.b.c:80/x". No consumer can act on those: scheme and host never appear
// together, which is what UrlGuard and url_absolutize both require. So the contract
// asserted here is the one the app can see.
const target = (v) => (v && v.scheme && v.host ? v.scheme + '://' + v.host : 'no-target');
for (const url of ['a.b.c:80/x', 'a.b:80', '1abc:80/x', 'x:80//y', 'a:b:80', 'a@b:80', 'u@h:80/a',
  'a b:80', 'a?b:80', 'a#b:80', 'a/b:80', 'a:80?b', 'a:80#b', '1.2.3.4:80', '[::1]:80',
  'file:///etc/passwd', 'mailto:a@b.com', 'data:text/html,x', 'hello world', '', '   ', 'ok.com',
  'http:', 'https:/', 'C:/x', 'http:..a', '+abc/x', 'a.b:x', 'a.b:/x', 'ht.tp://h/a', 'abc:/80',
  'a.b:1x', 'a.b:+80', 'a.b: 80', 'x-y+z://h/a', 'a_b:80', 'ftp://ok.com:99999/x',
]) {
  probe('pu4|' + url, 'parse_url', [url], (js, php) => d.same(
    'parse_url target ' + JSON.stringify(url), target(js.value), target(php.value)));
}

// ------------------------------------------------------------------ parse_url, authority grammar fuzz
const gp = makeRng(90210);
const authorityUrls = [];
while (authorityUrls.length < 400) {
  const scheme = gp.pick(['http://', 'https://', 'HTTP://', '//']);
  const userinfo = gp.r() < 0.2 ? gp.pick(['u@', 'u:p@', ':p@', 'a@b@', '@']) : '';
  const host = gp.pick(['ok.com', 'a.b.c', 'xn--a.de', '[::1]', '[fe80::1]', '[]', '', 'h', '1.2.3.4', 'h Host', 'h:p']);
  const port = gp.pick(['', '', ':', ':80', ':0', ':65535', ':65536', ':99999', ':1x', ': 8', ':+8', ':80:', ':abc', ':0080']);
  const path = gp.pick(['', '/', '/a/b', '/a/b:c', '/', '/x?y=1']);
  const tail = gp.r() < 0.2 ? gp.pick(['?q=1', '#f', '?q=1#f', '#f?g']) : '';
  authorityUrls.push(scheme + userinfo + host + port + path + tail);
}
for (const url of new Set(authorityUrls)) {
  probe('puf|' + url, 'parse_url', [url], (js, php) => d.same('parse_url fuzz ' + JSON.stringify(url), js.value, php.value));
}


// ------------------------------------------------------------------ UrlGuard, the real security contract
const adversarial = [
  'http://127.0.0.1/video.mp4', 'http://127.0.0.1:8080/x.mp4', 'http://localhost/x.mp4',
  'http://10.0.0.7/x.mp4', 'http://192.168.0.1/x.mp4', 'http://172.16.5.5/x.mp4',
  'http://100.64.0.1/x.mp4', 'http://169.254.169.254/latest/meta-data/iam',
  'http://[fe80::1]/x.mp4', 'http://[::1]/x.mp4', 'http://2130706433/x.mp4',
  'http://0x7f000001/x.mp4', 'file:///etc/passwd', 'gopher://127.0.0.1:6379/_GET%20x',
  'ftp://example.com/etc/passwd', 'http://example.com:6379/x', 'http://example.com:22/x',
  'http://ok.com@127.0.0.1/x.mp4', 'http://example.com\\@127.0.0.1/x.mp4',
  'http://builder.internal/x.mp4', 'http://host.local/x.mp4', 'https://', 'hello world', '',
  'http://127.0.0.1:8085/x', 'http://localhost:8085/x',
  'https://streamtape.com/v/abc123', 'http://example.com/a.mp4', 'https://cdn.mxdrop.click:443/x.m3u8',
  'https://sub.domain.cloudfam.io/a/b?token=1', 'https://example.com:8080/x', 'https://example.com:8443/x',
  'http://example.com:80/x', 'https://example.com:80/x', 'http://example.com:443/x',
  'https://EXAMPLE.COM/x', 'https://example.com./x', 'https://exa mple.com/x',
  'https://exa+mple.com/x', 'https://exa_mple.com/x', 'https://-example.com/x',
  'https://example-.com/x', 'https://a.b/x', 'https://a.b.c.d/x', 'http://xn--bcher-kva.de/x',
  'https://example.com:0/x', 'https://example.com:99999/x', 'https://example.com:@80/x',
  'http://192.168.1.1.example.com/x', 'http://example.com#@127.0.0.1/x',
  'http://example.com:80@127.0.0.1/x', 'https://[::1]:443/x', 'http://0177.0.0.1/x',
  'http://0x7f.1/x', 'http://2130706434/x', 'http://0/x', 'http://255.255.255.255/x',
  'http://198.18.0.1/x', 'http://198.51.100.1/x', 'http://203.0.113.1/x', 'http://224.0.0.1/x',
  'http://240.0.0.1/x', 'http://0.0.0.0/x', 'http://169.254.0.1/x', 'http://172.31.255.255/x',
];
const rg = makeRng(4242);
while (adversarial.length < 400) {
  const scheme = rg.r() < 0.1 ? rg.pick(['ftp', 'file', 'gopher', 'redis', 'HTTP', 'https']) : 'http';
  const sep = rg.r() < 0.05 ? ':' : '://';
  const hostPart = rg.pick([
    'example.com', '127.0.0.1', 'localhost', '10.1.2.3', '[::1]', 'a', 'a.b', '-a.b', '0x7f000001',
    '169.254.169.254', 'sub.ok.com', 'ok.com@127.0.0.1', 'ok.com:80', 'xn--80ak6aa92e.com',
    'host.local', 'host.internal', '192.168.0.1', 'cloud.example.com', '%31%32%37.0.0.1',
  ]);
  const port = rg.r() < 0.3 ? rg.pick([':80', ':443', ':22', ':6379', ':8080', ':8443', ':0', ':99999', ':']) : '';
  adversarial.push(`${scheme}${sep}${hostPart}${port}${rg.pick(['/x.mp4', '/', '/a/b?c=1', ''])}`);
}

// Ask php what its resolver returned for every host involved, then hand those very
// same answers to the node guard. That way a disagreement can only be the guard's
// logic, never a difference between two machines' dns.
const hostSet = new Set();
for (const u of adversarial) {
  const p = parseUrl(u);
  if (p && p.host) {
    hostSet.add(String(p.host).toLowerCase().replace(/\.+$/, ''));
  }
}
const dnsProbe = oracleRun([{ id: 'dns', fn: 'dns', args: [[...hostSet]] }]).get('dns');
const dnsAnswers = dnsProbe.res || {};
const stubResolve = async (host) => dnsAnswers[host] ?? host;

const guardRuns = oracleRun(adversarial.map((u, i) => ({ id: 'g' + i, fn: 'urlguard', args: [u] })));
for (let i = 0; i < adversarial.length; i++) {
  const u = adversarial[i];
  const rec = guardRuns.get('g' + i);
  if (!rec || !rec.ok) {
    d.ok('php answered UrlGuard ' + JSON.stringify(u), false, rec ? rec.err : 'no record');
    continue;
  }
  let jsOut;
  try {
    jsOut = { allow: await assertSafe(u, stubResolve) };
  } catch (err) {
    jsOut = { refuse: err.message };
  }
  d.same('UrlGuard ' + JSON.stringify(u), jsOut, rec.res);
}

// ------------------------------------------------------------------ seal / open
const secrets = ['0123456789abcdef0123456789abcdef', 'deadbeef', 'x'.repeat(64)];
const mediaUrls = [
  'https://host.com/f.mp4?token=abc', 'https://host.com/a b/c?x=1&y=2', 'x',
  'https://host.com/' + 'q'.repeat(500), 'unicode-ключ.mp4', 'https://host.com/#', 'a=b&c=d',
];
for (const sec of secrets) {
  for (const u of mediaUrls) {
    probe('sr|' + sec + '|' + u, 'seal_roundtrip', [u, sec], (js, php) => {
      d.same('hmac key for ' + sec.slice(0, 8), js.key, php.key);
      d.same('php roundtrip ' + JSON.stringify(u.slice(0, 30)), js.opened, php.opened);
    });
    probe('ls|' + sec + '|' + u, 'link_seal', [u, sec], () => {});
  }
}

const results = oracleRun(probes);
for (const c of checks) {
  const rec = results.get(c.id);
  if (!rec) {
    d.ok('oracle answered ' + c.id, false);
    continue;
  }
  let jsValue;
  try {
    jsValue = callJs(c.fn, c.args);
  } catch (err) {
    d.ok('node did not throw for ' + c.fn + ' ' + JSON.stringify(c.args[0]), false, String(err.message));
    continue;
  }
  if (!rec.ok) {
    d.ok('php failure acknowledged for ' + c.fn + ' ' + JSON.stringify(c.args[0]).slice(0, 40), false, 'php err=' + rec.err);
    continue;
  }
  c.check(jsValue, rec.res);
}

// php sealed -> node opens, and node sealed -> php opens.
const sealed = [];
for (const sec of secrets) {
  for (const u of mediaUrls) {
    sealed.push({ sec, u, fromPhp: results.get('ls|' + sec + '|' + u).res, fromNode: linkSeal(u, sec) });
  }
}
const reopened = oracleRun(sealed.map((s, i) => ({ id: 'ro' + i, fn: 'link_open', args: [s.fromNode, s.sec] })));
for (let i = 0; i < sealed.length; i++) {
  const s = sealed[i];
  d.ok('php seal opens in node: ' + JSON.stringify(s.u.slice(0, 24)), linkOpen(s.fromPhp, s.sec) === s.u,
    'got ' + JSON.stringify(linkOpen(s.fromPhp, s.sec)));
  d.ok('node seal opens in php: ' + JSON.stringify(s.u.slice(0, 24)), reopened.get('ro' + i).res === s.u,
    'got ' + JSON.stringify(reopened.get('ro' + i).res));
}

// Garbage must be refused the same way on both sides.
const junkList = ['', 'a', 'ab', '!!!', 'AAAA', '=', 'A', 'QQ', 'AAAAA', base64urlJunk(), '----', '🍿🍿🍿', 'a=b'];
const junkRuns = oracleRun(junkList.map((j, i) => ({ id: 'lo' + i, fn: 'link_open', args: [j, secrets[0]] })));
junkList.forEach((junk, i) => {
  d.same('link_open rejects junk ' + JSON.stringify(junk), linkOpen(junk, secrets[0]), junkRuns.get('lo' + i).res);
});

function base64urlJunk() {
  return Buffer.from('x'.repeat(40)).toString('base64').replace(/=+$/, '');
}

function callJs(fn, args) {
  switch (fn) {
    case 'e': return e(args[0]);
    case 'human_bytes': return humanBytes(args[0]);
    case 'url_absolutize': return urlAbsolutize(args[0], args[1]);
    case 'parse_url': return { value: parseUrl(args[0]) };
    case 'seal_roundtrip': return { opened: linkOpen(linkSeal(args[0], args[1]), args[1]), key: relayKey(args[1]) };
    case 'link_seal': return null;
    default: throw new Error('no js impl for ' + fn);
  }
}

process.exit(d.report('support.php differential parity') ? 0 : 1);
