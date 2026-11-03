# Grably, a video page link to MP4 downloader

Paste the address of a page that shows a video and the app finds the file behind
it, previews it, and gives a download. PHP 8.1 or newer, no Composer packages, no
database, no ffmpeg, so it runs on shared hosting.

## What it does

- Reads the page the visitor pasted and walks what that page delegates to:
  iframes, embeds, object tags, meta refreshes, `location` assignments in the
  page script, and the `.json` or `/api/video/...` sidecars a player loads. Three
  levels deep, up to eight documents, inside an eighteen second budget.
- Finds media by structure before strings: `<video>`, `<source>`, `<embed>`,
  `og:video`, `twitter:player:stream`, JSON-LD `contentUrl`, `data-*` attributes
  and the `file:` / `sources:` keys of player configs. A raw URL is accepted only
  after the host confirms it by answering a range request with a media content
  type, so a guessed address never reaches the visitor.
- Gives an MP4 in this order: the host's original MP4, another original the host
  serves, then a real remux of an HLS or MPEG-TS stream into MP4 with no
  re-encoding, done in `lib/Build`. An unconvertible stream is offered as itself
  and labelled as such. Nothing is renamed to `.mp4` and claimed as a conversion.
- Catches expired signed links, keeps the size and duration the host reported,
  and says so plainly when a site puts a captcha, a browser check or a sign-in in
  front of the file. YouTube is refused on purpose: its streams are signed for the
  browser that asked, and reaching them means going around that check.

## Layout

```
index.php          the whole app: one front controller, ?r=... routes
.htaccess          blocks internals, adds compression and security headers
assets/            css, js and the svg icon set
config/app.php     brand text, timeouts, discovery and build budgets
lib/               Net, Extractor, Build, Job, Storage, Support
views/             home, error and the shared parts
tests/             offline suites, live scripts, fixtures that are not committed
storage/           runtime only: jobs, builds, rate buckets, cached issuers
```

## Running it

Point a PHP 8.1+ host at this folder. `storage/` must be writable by PHP; the
app creates its subdirectories on first use. No other setup, no build step.

Locally:

```
php -S 127.0.0.1:8085 tests/serve.php
```

Before going live, set `app.base_url` in `config/app.php` to the real origin. It
feeds the canonical tag, `robots.txt` and `sitemap.xml`, and while it is empty
those fall back to the requested host.

## Tests

Offline, no network:

```
php tests/test_deep.php            discovery, ranking, the walk, the refusal
php tests/test_security.php        ssrf wall, seal, relay, rate limit
php tests/test_streamtape_eval.php
php tests/test_ts.php              need tests/fixtures, exit 3 when absent
php tests/test_es.php              same
php tests/test_mp4.php             same
php tests/test_unpacker.php        same
```

Live, against a running instance. These make real requests to real hosts, so run
them deliberately:

```
php tests/smoke.php <base>            26 sample links over 16 hosts
php tests/deep_matrix.php             arbitrary hosts and embed levels
php tests/integrity.php <base> <url>  full file, box table, mid-file range
php tests/perf.php <base>             page cost, asset weight, latency
```

## Notes and limits

- Requests to a host are made as an ordinary browser request with the page as
  referer. No captcha is solved, no token loop is replayed, no DRM is stripped,
  no paywall is bypassed. Where a site restricts access the app refuses and says
  which rule it met.
- Every media url is kept server side. The visitor gets a same-origin, signed
  relay link, so a host's signed address is never shown or logged in the browser.
- `.htaccess` protects `lib`, `config`, `views`, `tests` and `storage` when the
  folder is the docroot. Confirm `https://yourdomain/lib/support.php` returns
  403 after deploying. To serve the app from `public_html` itself, move its
  contents up one level and keep this file with them.
- TLS verification is never disabled. When a host presents an incomplete chain,
  `lib/Net/CertChain.php` fetches the missing issuer from its AIA pointer and
  re-checks against the machine's trust store; a self-signed root is never added.
- The MP4 builder runs one slice of a stream per request, so a long stream stays
  inside the shared-plan execution quota. The `moov` box is written last, which
  means a saved file must be complete before it plays or seeks.
