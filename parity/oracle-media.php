<?php
declare(strict_types=1);

/**
 * Differential oracle for the MediaSniffer, Source and MediaBundle ports. Reads a
 * JSON array of probes from stdin, runs each against the ORIGINAL php classes and
 * prints one JSON line per probe; the node port must agree with every line.
 *
 *   php oracle-media.php < probes.json > oracle-out.jsonl
 *
 * Every text/byte value is transported as-is (the port treats strings as latin1 byte
 * strings), and keyed php arrays are emitted as ordered [key, value] pairs so an
 * empty array never collapses to an object and the browser-visible order is checked.
 */

chdir(dirname(__DIR__) . '/source');
require dirname(__DIR__) . '/source/lib/support.php';

// A warning printed to stdout would corrupt the json lines, so diagnostics go to
// stderr and any notice the reference emits becomes a probe failure.
ini_set('display_errors', 'stderr');
set_error_handler(static function (int $no, string $msg): bool {
    throw new ErrorException($msg, 0, $no);
});

function pairs(array $m): array
{
    $out = [];
    foreach ($m as $k => $v) {
        $out[] = [(string) $k, $v];
    }
    return $out;
}

/**
 * Byte payloads travel as {_b64: "..."} so invalid-utf8 test data survives the json
 * round trip; anything else (ascii scalars, ints) passes through untouched.
 */
function raw(mixed $v): mixed
{
    return (is_array($v) && array_key_exists('_b64', $v)) ? base64_decode((string) $v['_b64'], true) : $v;
}

/**
 * Every string that leaves the oracle is tagged and base64'd, because a sniffed url
 * can carry the very bytes the page did. The node side decodes each {~b: ...}.
 */
function enc(mixed $v): mixed
{
    if (is_string($v)) {
        return ['~b' => base64_encode($v)];
    }
    if (is_array($v)) {
        $o = [];
        foreach ($v as $k => $x) {
            $o[$k] = enc($x);
        }
        return $o;
    }
    return $v;
}

/** Private statics of MediaSniffer, reached the way the engine oracle reaches them. */
function member(string $class, string $method): Closure
{
    return Closure::bind(static fn(mixed ...$a) => $class::{$method}(...$a), null, $class);
}

$clean = member('MediaSniffer', 'clean');
$tidy = member('MediaSniffer', 'tidy');
$jsonLdValues = member('MediaSniffer', 'jsonLdValues');
$adPenalty = member('MediaSniffer', 'adPenalty');

function srcSummary(Source $s): array
{
    return [
        'url' => $s->url,
        'kind' => $s->kind,
        'id' => $s->id,
        'score' => $s->score,
    ];
}

$in = stream_get_contents(STDIN);
$probes = json_decode((string) $in, true);
if (!is_array($probes)) {
    fwrite(STDERR, "bad input\n");
    exit(1);
}

foreach ($probes as $probe) {
    $fn = $probe['fn'] ?? '';
    $args = $probe['args'] ?? [];
    $res = null;
    $err = null;
    try {
        switch ($fn) {
            case 'media_urls':
                $res = MediaSniffer::mediaUrls(raw($args['text']));
                break;
            case 'clean':
                $res = $clean(raw($args['u']));
                break;
            case 'sources_from_text':
                $res = array_map('srcSummary', MediaSniffer::sourcesFromText(raw($args['text']), raw($args['base']), $args['headers'] ?? []));
                break;
            case 'kind_of':
                $res = MediaSniffer::kindOf(raw($args['url']));
                break;
            case 'meta':
                $res = MediaSniffer::meta(raw($args['html']), raw($args['base']));
                break;
            case 'tidy':
                $res = $tidy(raw($args['t']));
                break;
            case 'candidates':
                $res = array_map('srcSummary', MediaSniffer::candidates(raw($args['text']), raw($args['base']), $args['headers'] ?? []));
                break;
            case 'base_href':
                $res = MediaSniffer::baseHref(raw($args['html']));
                break;
            case 'tag_urls':
                $res = MediaSniffer::tagUrls(raw($args['html']));
                break;
            case 'data_attribute_urls':
                $res = MediaSniffer::dataAttributeUrls(raw($args['html']));
                break;
            case 'jsonld_urls':
                $res = MediaSniffer::jsonLdUrls(raw($args['html']));
                break;
            case 'jsonld_embed_pages':
                $res = MediaSniffer::jsonLdEmbedPages(raw($args['html']));
                break;
            case 'jsonld_values':
                $res = $jsonLdValues(raw($args['html']), $args['wanted']);
                break;
            case 'config_key_urls':
                $res = pairs(MediaSniffer::configKeyUrls(raw($args['text'])));
                break;
            case 'looks_like_endpoint':
                $res = MediaSniffer::looksLikeEndpoint(raw($args['url']));
                break;
            case 'ad_penalty':
                $res = $adPenalty(raw($args['url']));
                break;
            case 'player_pages':
                $res = MediaSniffer::playerPages(raw($args['html']), raw($args['base']));
                break;
            case 'config_endpoints':
                $res = MediaSniffer::configEndpoints(raw($args['html']), raw($args['base']), (int) ($args['limit'] ?? 3));
                break;
            // ---------------------------------------------------------------- Source
            case 'source_make':
                $res = srcSummary(Source::make(raw($args['url']), $args['kind'] ?? Source::MP4));
                break;
            case 'source_is_video':
                $s = new Source();
                $s->kind = $args['kind'];
                $res = $s->isVideo();
                break;
            case 'source_token_expiry':
                $s = Source::make(raw($args['url']), Source::MP4);
                $s->tokenExpiryFromQuery();
                $res = $s->tokenExpiresAt;
                break;
            case 'source_to_array':
                $s = Source::make(raw($args['url']), $args['kind'] ?? Source::MP4);
                foreach (['label', 'height', 'bitrate', 'sizeBytes', 'mime', 'tokenExpiresAt',
                          'needsProxy', 'duration', 'note', 'variants'] as $f) {
                    if (array_key_exists($f, $args)) {
                        $s->{$f} = $args[$f];
                    }
                }
                $res = $s->toArray();
                break;
            // ---------------------------------------------------------------- MediaBundle
            case 'bundle_add_source':
                $b = new MediaBundle();
                foreach ($args['urls'] as $u) {
                    $b->addSource(Source::make(raw($u['url']), $u['kind'] ?? Source::MP4));
                }
                $res = array_map(static fn(Source $s) => $s->url, $b->sources);
                break;
            case 'bundle_best':
                $b = new MediaBundle();
                foreach ($args['sources'] as $row) {
                    $s = Source::make(raw($row['url']), $row['kind'] ?? Source::MP4);
                    $s->height = $row['height'] ?? null;
                    $b->addSource($s);
                }
                $best = $b->best();
                $res = $best === null ? null : $best->url;
                break;
            case 'bundle_notice':
                $b = new MediaBundle();
                foreach ($args['msgs'] as $m) {
                    $b->notice($m);
                }
                $res = $b->notices;
                break;
            default:
                $err = 'unknown probe ' . $fn;
        }
    } catch (Throwable $e) {
        $err = get_class($e) . ':' . $e->getMessage();
    }
    echo json_encode(['id' => $probe['id'] ?? $fn, 'ok' => $err === null, 'res' => enc($res), 'err' => $err], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
}
