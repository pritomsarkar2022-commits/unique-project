# Grably video link tool — Netlify port

Paste a video page link, get the underlying file: progressive download or HLS stream,
played in the page and saved as one MP4. This is the php app in `source/` ported to
Node so it can run on Netlify's static + functions platform. The UI, the wording, the
features and the failure messages are the original's; nothing in `site/assets` or
`site/templates` was redesigned. The only front-end change is invisible until a file is
big: the save button now asks for the file in ranged pieces instead of in one response
(see *What the platform forces* below), because a function response cannot hold a movie.

## Status: every layer is ported

| Layer | State |
| --- | --- |
| HLS/TS → MP4 engine (`site/src/hls`, `site/src/build`) | ported, byte-compared against the original |
| Outbound HTTP, SSRF wall, certificate handling (`site/src/net`) | ported, byte-compared against the original |
| Job/build storage, Netlify Blobs + filesystem drivers (`site/src/storage`) | ported, tested |
| Extractors for every supported host (`site/src/extractor`) | ported, tested against the original |
| Static page and front-end script (`site/public` via `npm run build`) | generated from the captured php markup, unchanged |
| HTTP entry point (`netlify/functions/router.mjs`, `site/src/http/router.mjs`) | ported, tested route by route |
| Relay's byte-serving half (`r=relay`, `r=file`) | ported, tested against a live 60 MB file |
| Dynamic views (`site/src/views`) | ported, byte-compared against the original (42 probes) |

`netlify.toml` routes `/index.php`, `/api/*`, `/relay`, `/health` and `/sitemap.xml` to
`/.netlify/functions/router`, which imports `site/src/http/router.mjs` — the same
`handle()` the local harness (`scripts/serve.mjs`) calls, so a route that works here has
no platform-specific code left to fail on.

## What the platform forces, and where it shows

A netlify function response carries 20 MB streamed (6 MB buffered), so
`limits.function_stream_bytes` is 18 MiB and two rules follow from it:

- A request that asks for a **range** gets that range: the relay narrows the upstream
  `Range` before it leaves the function, and `r=file` slices the stored mp4, so a 700 MB
  file still arrives — in pieces.
- A request for a **whole file bigger than the ceiling** is refused with `413` and an
  `X-File-Size` header, because a silently truncated video is the one outcome a visitor
  cannot tell apart from success.

`site/assets/js/app.js` is the other half of that: every save first asks for one byte to
learn the size. A file that fits one response is still the browser's own download; a
larger one is fetched in 8 MB ranged pieces and written to disk as it comes (above 256 MB
the page asks for a file handle rather than holding the pieces in memory). Verified
end-to-end: a 61,878,609-byte file from `archive.org` came through the relay in 8 pieces
and hashed `46f62396c755e1ed0ab856a1521378d54196e125ef1a1643a199af087a15046b` — the same
sha256 as the bytes pulled straight from the file host.

The join (`Save as one MP4`) has its own ceiling: `build.output_max_bytes`, 20 MB,
against the original's `build.max_bytes` of 1.5 GB. Each build tick reads and rewrites the
whole partial file through blob storage, so the output size is the working-set size. A
master playlist whose bandwidth and duration are both known is refused before the first
part is fetched — `"That quality joins to about 23.1 MB, and this site saves one MP4 up to
20 MB."` (`site/src/build/buildRunner.mjs:63`) — and one that grows past the cap mid-build
stops with `"This file grew past 20 MB."` (`site/src/build/buildRunner.mjs:174`), both with
`"Pick a lower quality if the page offers one."`.
**Save stream file** has no such limit — a raw `.ts` is relayed, not joined, and comes
down in pieces.

The function's 60-second synchronous limit is why `build.tick_seconds` is 10 and the
saver polls `r=progress` until the build finishes: the work is one slice per request, not
one request per file.

## Running what is here

```
npm run build      # site/public from site/templates + site/assets
npm test           # 112 unit and route tests, node >= 22
npm run parity     # differential tests; needs a php binary, see PHP_BIN below
npm run deploy-sim # bundles the function the way netlify does, then runs it
node scripts/serve.mjs 8099   # the whole site locally, router included
```

`scripts/serve.mjs` mirrors `netlify.toml` on plain node: the same paths go to the same
`handle()`, the rest comes out of `site/public` with the same cache headers, and storage
uses the filesystem driver under `site/storage/` (git-ignored). The scheme of the links it
returns follows the connection that asked for them, so an `http://localhost` run hands out
`http://` relay urls and every route is clickable.

`npm run parity` runs the same fixtures through the untouched php classes in `source/`
and through the port, and compares the output. Every check must report zero diverged.

```
PHP_BIN=/path/to/php npm run parity     # php >= 8.1, used only by the tests
```

`npm run deploy-sim` is the check that the tests cannot be: netlify builds a function with
esbuild, which turns the whole import graph into **one file** and only follows a dynamic
`import()` it can read as a string. A source tree passes every test while a bundle silently
loses whatever it could not trace. The script bundles `netlify/functions/router.mjs` with the
same flags `netlify.toml` implies, runs that artifact in isolation, and asks the questions a
broken bundle answers differently — is the extractor list full, do the routes still answer,
and does a missing store say so. It needs no network, no php and no blob store.

## Storage on a deploy: read `/health` first

A function has one durable store, and this app uses it for the job records, the build
records, the finished mp4s and the rate-limit buckets. `GET /health` reports the state of
all of it as json:

| field | what a good value looks like |
| --- | --- |
| `storage_driver` | `blobs` on netlify, `fs` on a machine with a disk |
| `storage_writable` | `true` — the probe key was written, read back and deleted |
| `storage_reason` | `null`; otherwise the namespaces that failed, with the platform's own message |
| `extractors` | `13` — every module `HOST_EXTRACTORS` names |
| `hosts` | `44` — the hosts the homepage advertises |

If `extractors` is below 13 the bundle lost an extractor, and `npm run deploy-sim` reproduces
it without a deploy. If `storage_writable` is false, the analyse route answers `503` with
`code: "storage"` rather than pretending the video page is broken.

The blobs client finds its credentials from the platform, and on the older function runtimes
from the invoke event, which `netlify/functions/router.mjs` hands to
`adoptBlobsContext()` before it asks for a store. If `/health` still reports that the
environment was not configured for Blobs, give the client the two values itself, in the
site's environment variables (Netlify dashboard → Site configuration → Environment variables,
then redeploy):

```
BLOBS_SITE_ID  <the id on the site's General information page>
BLOBS_TOKEN    <a personal access token with "Config files and deploy hooks" write>
```

`getStore()` prefers whatever the platform injected and uses these only when there is none,
so a site that later starts receiving the context needs no change. Blobs is a paid-metered
product on the free plan; the store itself is created on the first write, so there is nothing
to provision in advance.

`source/` is not in this repo. The oracle is the original app, so the parity run needs
it on disk:

```
git clone https://github.com/pritomsarkar2022-commits/downloader-website-.git source
```

## Two things the port does differently, on purpose

1. **Storage.** The php app kept flat files under `storage/`. Here the same records go
   through `site/src/storage/kv.mjs`, which is the filesystem on a machine that has one
   and Netlify Blobs on a function. Three things about the blobs driver are worth
   knowing before you trust it with a deploy:
   - The build lock, which php held with `flock`, is a create-if-absent put with a ttl,
     because a function invocation that times out leaves no process behind to release
     it. `@netlify/blobs` 10 and up make that atomic (`set(..., {onlyIfNew: true})`
     answers a lost race with `{modified: false}`); on an older client, which ignores
     the option and overwrites, the driver reads first and keeps the lock, leaving one
     round trip of race between two simultaneous first writers.
   - Blobs exposes no clock: `getMetadata` returns `{etag, metadata}` and `list`
     returns `{key, etag}`, and there is no `createdAt` anywhere. The driver therefore
     stamps its own write time into the entry's metadata and reports it back as
     `createdAt`, because the gc sweeps age jobs, build records and finished mp4s off
     `createdAt` and would delete everything on the first tick if it were 0.
   - Blobs has no ranged read at any client version — `get()` sends no `Range` header
     and there is no `getRange` — so `r=file` slices the stored mp4 after reading it
     whole. The 20 MB output ceiling is what keeps one of those inside a function.
   `site/tests/stores.test.mjs` runs the driver against a stand-in with exactly that
   surface, including the pre-10 client, and compares every range answer with the
   filesystem driver's.
2. **One crash the original has is not reproduced.** `TsDemuxer::packet()` passes
   `$this->pendingMeta[$pid]` to `emit()` with no `?? []` guard, while `flush()` has one.
   A resumed MP4 build whose next part starts inside a frame reaches it, and because
   `emit()` declares `array $meta` under `strict_types`, php throws a fatal TypeError —
   over an argument `emit()` never reads. The port drops those continuation bytes, which
   is what `emit()` does for any buffer without a PES header, and finishes the file.
   The differential harness reports the cuts where php dies instead of comparing them
   (`PHP_RESUME_CRASH` in `parity/test-engine.mjs`).

## Cost, if you are on a free host

This design moves video bytes through the server: the relay re-serves playlists and
segments, and saving as MP4 pulls every part and joins it. On Netlify's free plan that
is metered at 20 credits per GB against 300 credits a month, so roughly 15 GB for the
whole site — about 150 MB per download leaves no room for anything else. Hosting this
faithfully means either a paid plan or a host with unmetered egress.

Assembling the file in the browser does not change that arithmetic: the same bytes still
pass through the function, and a save in eight pieces costs eight requests' worth of
function duration plus a few hundred bytes of headers per piece. What it does change is
what one request can be — 18 MiB — so a large file no longer needs a larger response.
