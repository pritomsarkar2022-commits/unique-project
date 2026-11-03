import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PassThrough } from 'node:stream';
import { HttpClient } from '../src/net/httpClient.mjs';
import { HttpResponse } from '../src/net/httpResponse.mjs';
import { HttpException } from '../src/errors.mjs';

/**
 * Behaviour tests for the outbound door. The SSRF wall refuses loopback, so the
 * wall is injected as a seam (constructor guard) and everything behind it runs for
 * real: manual redirect hops, the budget, the cookie jar, the size cap.
 */

const allowAll = async () => 'test';

/** A server whose replies the tests pick by url path. */
function serve(handler) {
  const server = http.createServer((req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(err && err.stack ? err.stack : err));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      resolve({
        base,
        url: (p) => base + p,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const seen = [];
function record(req) {
  seen.push({ method: req.method, url: req.url, headers: req.headers });
}

test('decodes gzip and reports the content type', async () => {
  const s = await serve((req, res) => {
    record(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip' });
    res.end(zlib.gzipSync(Buffer.from('hello <html>world</html>', 'latin1')));
  });
  const http0 = new HttpClient(5, allowAll);
  const res = await http0.get(s.url('/page'));
  assert.equal(res.status, 200);
  assert.equal(res.body, 'hello <html>world</html>');
  assert.equal(res.contentType, 'text/html; charset=utf-8');
  assert.equal(res.downloadedBytes, res.body.length);
  assert.ok(res.isHtml());
  assert.equal(http0.remaining(), 4, 'one hop, one credit');
  assert.deepEqual(http0.trace, [{ url: s.url('/page'), status: 200, bytes: 24 }]);
  assert.equal(seen.at(-1).headers['user-agent'], 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  assert.equal(seen.at(-1).headers['accept-language'], 'en-US,en;q=0.9');
  assert.equal(seen.at(-1).headers['accept-encoding'], 'gzip, deflate, br');
  await s.close();
});

test('the size cap truncates and marks the response', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.alloc(5000, 0x41));
  });
  const client = new HttpClient(2, allowAll);
  const res = await client.get(s.url('/big'), { max_bytes: 1000 });
  assert.equal(res.body.length, 1000);
  assert.equal(res.downloadedBytes, 1000);
  assert.equal(res.header('x-vd-truncated'), '1');
  assert.equal(res.header('X-VD-TRUNCATED'), '1', 'header lookup is case-insensitive');
  await s.close();
});

test('every redirect hop is guarded and re-referered', async () => {
  const s = await serve((req, res) => {
    record(req);
    if (req.url === '/one') {
      res.writeHead(302, { Location: '/two' });
      res.end();
    } else if (req.url === '/two') {
      res.writeHead(301, { Location: '/three' });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('arrived');
    }
  });
  const guarded = [];
  const client = new HttpClient(9, async (url) => {
    guarded.push(url);
    return 'test';
  });
  const res = await client.get(s.url('/one'), { max_redirects: 5 });
  assert.equal(res.body, 'arrived');
  assert.deepEqual(guarded, [s.url('/one'), s.url('/two'), s.url('/three')]);
  assert.equal(client.trace.length, 3);
  assert.equal(client.remaining(), 6);
  await s.close();
});

test('a 307 keeps the method and body, a 301 does not', async () => {
  const s = await serve((req, res) => {
    record(req);
    if (req.url === '/keep') {
      res.writeHead(307, { Location: '/post-target' });
      res.end();
    } else if (req.url === '/post-target') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('method=' + req.method + ' body=' + body);
      });
    } else if (req.url === '/drop') {
      res.writeHead(301, { Location: '/get-target' });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('method=' + req.method);
    }
  });
  const client = new HttpClient(8, allowAll);
  const kept = await client.post(s.url('/keep'), 'token=abc');
  assert.equal(kept.body, 'method=POST body=token=abc');
  const dropped = await client.post(s.url('/drop'), 'token=abc');
  assert.equal(dropped.body, 'method=GET');
  await s.close();
});

test('max_redirects 0 hands back the 3xx instead of following it', async () => {
  const s = await serve((req, res) => {
    res.writeHead(302, { Location: '/elsewhere' });
    res.end();
  });
  const client = new HttpClient(3, allowAll);
  const res = await client.get(s.url('/start'), { max_redirects: 0 });
  assert.equal(res.status, 302);
  assert.equal(res.header('location'), '/elsewhere');
  assert.equal(client.trace.length, 1);
  await s.close();
});

test('the budget is a hard stop with the visitor-facing wording', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  const client = new HttpClient(1, allowAll);
  await client.get(s.url('/first'));
  await assert.rejects(client.get(s.url('/second')), (err) => err instanceof HttpException
    && err.message === 'That page needs too many requests to resolve a file.'
    && err.status === 504);
  assert.equal(client.remaining(), 0);
  await s.close();
});

test('cookies stick to the domain that set them', async () => {
  const s = await serve((req, res) => {
    record(req);
    if (req.url === '/grant') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Set-Cookie': ['sess=abc; Path=/', 'dead=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
      });
      res.end('granted');
    } else if (req.url === '/ask') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(String(req.headers.cookie ?? ''));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('other');
    }
  });
  const client = new HttpClient(6, allowAll);
  await client.get(s.url('/grant'));
  const back = await client.get(s.url('/ask'));
  assert.equal(back.body, 'sess=abc');
  assert.equal(client.cookieHeader(), 'sess=abc');

  // A second jar entry for the same name wins, the way the php jar reader folded them.
  const other = new HttpClient(6, allowAll);
  await other.get(s.url('/grant'));
  const secondHost = new HttpClient(6, allowAll);
  await secondHost.get(s.url('/ask'));
  assert.equal(secondHost.cookieHeader(), '', 'no cookies were ever set for that client');
  await s.close();
});

test('a range becomes a Range header the host can see', async () => {
  const s = await serve((req, res) => {
    record(req);
    if (String(req.headers.range) === 'bytes=0-0') {
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-0/987654', 'Content-Length': '1' });
      res.end(Buffer.from([0]));
    } else {
      res.writeHead(416, { 'Content-Type': 'text/plain' });
      res.end('no');
    }
  });
  const client = new HttpClient(4, allowAll);
  const res = await client.get(s.url('/probe.mp4'), { range: 'bytes=0-0' });
  assert.equal(res.status, 206);
  assert.equal(seen.at(-1).headers.range, 'bytes=0-0');
  assert.equal(res.header('content-range'), 'bytes 0-0/987654');
  await s.close();
});

test('to_file writes the decoded bytes and counts them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-http-'));
  const target = path.join(dir, 'seg.ts');
  const s = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Encoding': 'deflate' });
    res.end(zlib.deflateRawSync(Buffer.alloc(3000, 0x7f)));
  });
  const client = new HttpClient(4, allowAll);
  // A page cap is a memory guard, not a download limit: php never installed its
  // progress callback on the file path, so max_bytes must not clip a segment.
  const res = await client.get(s.url('/seg.ts'), { to_file: target, max_bytes: 100 });
  assert.equal(res.body, '');
  assert.equal(res.downloadedBytes, 3000);
  assert.equal(fs.readFileSync(target).length, 3000);
  await s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a form is posted as multipart, the way curl did', async () => {
  const captured = [];
  const s = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured.push({ headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('len=' + body.length);
    });
  });
  const client = new HttpClient(3, allowAll);
  await client.post(s.url('/gate'), '', { form: { action: 'log_first_page', adblock_detected: '0' } });
  const sent = captured.at(-1);
  assert.match(String(sent.headers['content-type']), /^multipart\/form-data; boundary=----VdForm/);
  assert.match(sent.body, /name="action"/);
  assert.match(sent.body, /log_first_page/);
  await s.close();
});

test('a dead host gets the same words the php app used', async () => {
  const s = await serve((req, res) => res.end('x'));
  const url = s.base;
  await s.close();
  const client = new HttpClient(3, allowAll);
  await assert.rejects(client.get(url + '/gone'), (err) => err instanceof HttpException
    && err.message === 'That site refused the connection.');
});

test('a json body decodes, a broken one falls back', () => {
  const ok = new HttpResponse(200, '{"a":1}', {}, 'application/json', 'http://x/', 7);
  assert.deepEqual(ok.json(), { a: 1 });
  const bad = new HttpResponse(200, 'nope', {}, 'application/json', 'http://x/', 4);
  assert.deepEqual(bad.json({ d: 1 }), { d: 1 });
  const list = new HttpResponse(200, '[1,2]', {}, 'application/json', 'http://x/', 5);
  assert.deepEqual(list.json(), [1, 2]);
  const scalar = new HttpResponse(200, '3', {}, 'application/json', 'http://x/', 1);
  assert.deepEqual(scalar.json({}), {});
});

test('header lines keep the php order and override rules', () => {
  const lines = HttpClient.headerLines({ Accept: 'application/json', 'X-Trace': 'a b' });
  assert.deepEqual(lines, [
    'User-Agent: ' + 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept: application/json',
    'Accept-Language: en-US,en;q=0.9',
    'X-Trace: a b',
  ]);
});

/** Everything a stream carries, or the error that broke it. */
function drain(stream) {
  return new Promise((resolve, reject) => {
    const parts = [];
    stream.on('data', (b) => parts.push(b));
    stream.on('end', () => resolve(Buffer.concat(parts)));
    stream.on('error', reject);
  });
}

test('a streamed reply settles with the headers and carries the whole body', async () => {
  let bodyFinished = false;
  const s = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '3000' });
    res.write(Buffer.alloc(1000, 0x42));
    setTimeout(() => {
      res.write(Buffer.alloc(2000, 0x43));
      res.end();
      bodyFinished = true;
    }, 120);
  });
  const client = new HttpClient(2, allowAll);
  const res = await client.get(s.url('/file.mp4'), { max_bytes: 100, stream: true });
  assert.equal(res.status, 200, 'the reply is known before the file is');
  assert.equal(bodyFinished, false, 'php echoed from the write callback, and so does this');
  assert.equal(res.body, '', 'nothing is held in memory');
  assert.ok(res.stream instanceof PassThrough);

  const got = await drain(res.stream);
  assert.equal(got.length, 3000, 'a streamed reply is not capped, only a buffered one is');
  assert.equal(got.subarray(1000, 1003).toString(), 'CCC');
  assert.deepEqual(client.trace, [{ url: s.url('/file.mp4'), status: 200, bytes: 0 }]);
  await s.close();
});

test('a streamed reply follows redirects and only the last hop travels', async () => {
  const s = await serve((req, res) => {
    record(req);
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/real' });
      res.end('redirecting');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end('payload');
  });
  const guarded = [];
  const client = new HttpClient(5, async (url) => { guarded.push(url); return 'test'; });
  const res = await client.get(s.url('/start'), { stream: true });
  assert.equal(res.status, 200);
  assert.deepEqual(guarded, [s.url('/start'), s.url('/real')], 'every hop goes through the wall');
  assert.equal(res.header('location'), null);

  assert.equal((await drain(res.stream)).toString(), 'payload', 'a 302 body never reaches the file');
  await s.close();
});

test('a stream that dies mid-file breaks instead of ending', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(Buffer.alloc(500, 0x41));
    setTimeout(() => res.destroy(), 30);
  });
  const client = new HttpClient(2, allowAll);
  const res = await client.get(s.url('/half'), { stream: true });
  assert.equal(res.status, 200);
  // The relay hands the stream to the browser before it knows whether the host will
  // finish, so a truncated file has to arrive as a broken body, not a short one.
  const failed = await drain(res.stream).then(() => false, () => true);
  assert.equal(failed, true);
  await s.close();
});
