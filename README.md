# Grably video link tool — Netlify port

Paste a video page link, get the underlying file: progressive download or HLS stream,
played in the page and saved as one MP4. This is the php app in `source/` ported to
Node so it can run on Netlify's static + functions platform. The UI, the wording, the
features and the failure messages are the original's; nothing in `site/assets` or
`site/templates` was redesigned.

## Status: not deployable yet

Read this before pointing Netlify at the repo.

| Layer | State |
| --- | --- |
| HLS/TS → MP4 engine (`site/src/hls`, `site/src/build`) | ported, byte-compared against the original |
| Outbound HTTP, SSRF wall, certificate handling (`site/src/net`) | ported, tested |
| Job/build storage, Netlify Blobs + filesystem drivers (`site/src/storage`) | ported, tested |
| Extractors for every supported host (`site/src/extractor`) | ported, tested against the original |
| Static page and front-end script (`site/public` via `npm run build`) | generated from the captured php markup, unchanged |
| **HTTP entry point: `netlify/functions/router.mjs`** | **missing** |
| **Relay's byte-serving half (`r=relay`, `r=file`)** | **missing** — only link building is ported |
| **Dynamic views (`site/src/views`)** | **missing** |

`netlify.toml` already routes `/index.php`, `/api/*`, `/relay`, `/health` and
`/sitemap.xml` to `/.netlify/functions/router`. That function does not exist, so a
deploy today serves the static page and every analyse, preview and download click
dies. Do not publish this until those three rows are filled in.

## Running what is here

```
npm run build      # site/public from site/templates + site/assets
npm test           # unit tests, node >= 22
npm run parity     # differential tests; needs a php binary, see PHP_BIN below
```

`npm run parity` runs the same fixtures through the untouched php classes in `source/`
and through the port, and compares the output. Every check must report zero diverged.

```
PHP_BIN=/path/to/php npm run parity     # php >= 8.1, used only by the tests
```

`source/` is not in this repo. The oracle is the original app, so the parity run needs
it on disk:

```
git clone https://github.com/pritomsarkar2022-commits/downloader-website-.git source
```

## Two things the port does differently, on purpose

1. **Storage.** The php app kept flat files under `storage/`. Here the same records go
   through `site/src/storage/kv.mjs`, which is the filesystem on a machine that has one
   and Netlify Blobs on a function. The build lock, which php held with `flock`, is an
   advisory create-if-absent with a ttl, because a function invocation that times out
   leaves no process behind to release it. Two workers can therefore both hold a build
   for one round trip; php's `flock` could not do that.
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
