# Grably video link tool — Netlify port

Paste a video page link, get the underlying file: progressive download or HLS stream,
played in the page and saved as one MP4. This is the php app in `source/` ported to
Node so it can run on Netlify's static + functions platform. Every string the app
*computes* — the refusal wordings, the notices, the host table, the head tags — is the
original's and is diffed against it. Two things are deliberately not the original's:
the page's own prose and layout, which are cut to one full-width tool band for phones,
and where the MP4 gets built, which is now the visitor's own device instead of a
function response (see *What the platform forces* below), because a function response
cannot hold a movie.

## Status: every layer is ported

| Layer | State |
| --- | --- |
| HLS/TS → MP4 engine (`site/src/hls`, `site/src/build`) | ported, byte-compared against the original |
| Outbound HTTP, SSRF wall, certificate handling (`site/src/net`) | ported, byte-compared against the original |
| Job/build storage, Netlify Blobs + filesystem drivers (`site/src/storage`) | ported, tested |
| Extractors for every supported host (`site/src/extractor`) | ported, tested against the original |
| Static page and front-end script (`site/public` via `npm run build`) | the owner's design; every computed string still the original's |
| Device-side join (`site/src/engine` → `site/assets/js/mux-worker.js`) | same engine, second runner; output byte-identical to the server build |
| HTTP entry point (`netlify/functions/router.mjs`, `site/src/http/router.mjs`) | ported, tested route by route |
| Relay's byte-serving half (`r=relay`, `r=file`) | ported, tested against a live 60 MB file |
| Dynamic views (`site/src/views`) | ported; head, chips, rows and year fragment-compared, error page byte-compared (106 checks) |

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

**The platform also runs only one of these functions at a time, and it does not say so
politely.** Measured on the live deploy: 18 parts of one stream asked for one at a time
answer 18 × 200; asked for three at a time, 15 of 18 answer `404` with Netlify's *own*
"This site is hosted on Netlify" page — the request never reached `handle()`. So a save
that overlaps with the tab's own preview, a second tab, or a second visitor is told the
video is missing when it is only queued. Nothing in this repo can raise that ceiling, so
the two browser-side savers wait it out: `fetchPart()` in `site/src/engine/muxWorker.mjs`
re-asks a refused part up to four times with a 0.5/1/1.5 s backoff, `ask()` in
`site/assets/js/app.js` does the same for a ranged piece, and `quietPlayer()` pauses the
preview before a save starts so the page stops competing with itself. The engine itself
was already sequential — one part, then the next — which is why this is a retry and not a
concurrency limit in the code.

**`Save as MP4` runs on the visitor's device, not in the function.** The join is the part
that could not fit a response, so it does not happen in one: `site/src/engine/localMux.mjs`
is the same `Playlist` → `TsStream` → `Mp4Mux` chain the server runs, bundled into
`site/assets/js/mux-worker.js` by `scripts/generate-engine.mjs` and started by
`runLocal()` (`site/assets/js/app.js:670`). The page hands it one thing — a `WritableStream`
for the file the visitor picked (or, where the browser has no picker, a blob sink that ends
in a download) — and the worker pulls the parts one at a time over the relay links the page
already holds signatures for. Nothing is capped, because no finished file ever passes
through Netlify: only the part bytes do, each in its own small response.

Two properties hold that up, and both are tested rather than asserted:

- The rewritten playlist is *walkable from the browser alone*. `site/tests/router.test.mjs`
  follows master → variant → key → segment and requires that not one host address survives
  the rewrite, that every link is this origin's and carries this job's signature, and that a
  key link is not flagged `&p=1`. The device therefore needs no cookies for the video host
  and no CORS from it.
- The device file *is* the server file. `site/tests/localMux.test.mjs` builds the same
  fixtures on both paths and compares bytes, clear and AES-128; `site/tests/muxWorker.test.mjs`
  runs the committed bundle in a bare sandbox with no node and no `Buffer` and compares it
  against the module; and the pure-JS block cipher in `site/src/engine/aesCbc.mjs` — needed
  because Web Crypto refuses an unpadded CBC open — is compared with node's
  `createDecipheriv(…, setAutoPadding(false))`.

Verified live: `https://luluvido.com/ielty32jjdm9`, an AES-128 HLS stream of 26 parts,
muxed by the browser worker into 69,881,386 bytes in 39 s and sha256
`1a83ec9ddc904c702cb23fae47e699f0854ecf41aac210199ebd2ca27fbd630d`; the node engine over the
same relay links produced the same hash, differing only in the five `mvhd`/`tkhd`/`mdhd`
clock fields.

The server join stays as the fallback the page reaches when a device cannot write a file at
all, and it keeps the ceilings it was written with: `build.output_max_bytes` is 20 MB against
the original's `build.max_bytes` of 1.5 GB, because each build tick reads and rewrites the
whole partial file through blob storage. A master playlist whose bandwidth and duration are
both known is refused before the first part is fetched — `"That quality joins to about 23.1 MB,
and this site saves one MP4 up to 20 MB."` (`site/src/build/buildRunner.mjs:65`) — and one that
grows past the cap mid-build stops with `"This file grew past 20 MB."`
(`site/src/build/buildRunner.mjs:176`), both with `"Pick a lower quality if the page offers
one."`. **Save stream file** has never had that limit — a raw `.ts` is relayed, not joined, and
comes down in pieces.

The function's 60-second synchronous limit is why `build.tick_seconds` is 10 and the
saver polls `r=progress` until the build finishes: the work is one slice per request, not
one request per file.

## Running what is here

```
npm run build      # engine bundle, then site/public from site/templates + site/assets
npm run engine     # site/assets/js/mux-worker.js only (esbuild over site/src/engine)
npm test           # 146 unit, route, view and bundle tests, node >= 22
npm run parity     # differential tests; needs a php binary, see PHP_BIN below
npm run deploy-sim # bundles the function the way netlify does, then runs it
node scripts/serve.mjs 8099   # the whole site locally, router included
```

`npm run build` runs the engine step first because `generate-views.mjs` hashes
`app.css`, `material.css`, `app.js` and `mux-worker.js` into one `ASSET_VER`, and
`netlify.toml` caches `/assets/*` for 30 days: an engine change that did not move the hash
would leave every visitor's phone running the old muxer out of the edge cache. A build
also fails loudly if the worker's import graph reaches a `node:` builtin
(`scripts/generate-engine.mjs`), which is the one thing that would only surface as a dead
save button on a device.

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
| `hosts` | `46` — the hosts the homepage advertises |

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

## Five things the port does differently, on purpose

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
3. **Two readers go one step further than php did.** Both were added after a live host
   moved its stream out of the page markup, and each asks only for what a visitor's own
   browser already asks for:
   - `StreamfileExtractor::playScript()` posts `op=play&file_code=…` to the host's own
     `/dl` endpoint — the request the play button makes — and reads the playlist out of
     the packed script in the reply. The php reader stopped at the page markup, where
     that host no longer writes it.
   - `embedReferrerOf()` reads the parent page out of the pasted link (`parent_ref`,
     `ref`, `referer`, …) and uses it as the `Referer` of the request for the embed,
     which is what the embedding browser sends and what a host that gates its embeds
     checks. An address that is not http(s), or that carries credentials, is refused
     rather than used, and a link naming no parent behaves exactly as it did before.

   Neither of them goes around a browser check. A host that answers Cloudflare's
   challenge to this server is reported as `gated`, and always will be.

4. **The join moved to the device.** The php app built the mp4 inside the request and had
   no response ceiling to respect; a Netlify function does, so `Save as MP4` now means a
   worker on the visitor's own machine writing the file the visitor picked. The engine is
   the same code, not a re-implementation — see
   [What the platform forces](#what-the-platform-forces-and-where-it-shows) above for the
   two properties that prove it and the live 66 MB AES-128 comparison. The server build
   survives only as the page's fallback (`buildMp4` in `site/assets/js/app.js`), which is
   why its old limits are still there and still byte-identical to php's.
5. **The page copy is the owner's design, so the views suite compares fragments.** The home
   page was cut to one tool band: 4,563 characters of visible prose and 844 words became
   997 and 164, and the document itself went from 28,040 to 15,153 bytes at the same host
   list. `parity/test-views.mjs` therefore no longer compares the whole home document — it
   would only ever report where prose was removed — and compares instead the four things
   the php *computes*: the `<head>` (title, canonical, `og:url`, `base_href` asset paths,
   `ASSET_VER`), the `<span class="chip">` per host, the `<tr>` per reader group, and the
   footer year. Every other suite is still whole-output byte equality, including the error
   page, which was not restyled.

## Cost, if you are on a free host

This design moves video bytes through the server: the relay re-serves playlists and
segments, and saving as MP4 pulls every part and joins it. On Netlify's free plan that
is metered at 20 credits per GB against 300 credits a month, so roughly 15 GB for the
whole site — about 150 MB per download leaves no room for anything else. Hosting this
faithfully means either a paid plan or a host with unmetered egress.

Moving the join to the device does not change the byte count: every part still leaves the
function once, so a 26-part save is 26 relay responses plus one signed manifest fetch. What
it removes is the other half of the cost — the build ticks, each of which read and rewrote
the whole partial file through blob storage, and the response size that had to stay under
18 MiB. A device save costs the function no write at all, and no storage.
