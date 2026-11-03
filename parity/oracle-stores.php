<?php
declare(strict_types=1);

/**
 * Differential oracle for the persistence layer (JobStore, BuildStore, Throttle).
 * Reads a JSON array of probes from stdin, runs each against the ORIGINAL php
 * classes and prints one JSON line per probe; the node port must agree with every
 * line, byte for byte.
 *
 *   php oracle-stores.php < probes.json > oracle-out.jsonl
 *
 * Everything that could carry a non-ascii BYTE (a title, a url, a host) travels in
 * and out as base64, because the probe json itself is utf-8 and a bare \xC3 would
 * be re-encoded on the way in. The node side models a php string as one javascript
 * char per byte, so base64 is the only lossless carrier.
 *
 * Two groups of probes do not call the reference directly, and say so:
 *   - the hmac/id/sign probes are one expression each of JobStore.php /
 *     BuildStore.php, transcribed line for line below with the original line
 *     quoted, because creating a JobStore would mkdir() inside source/, and
 *     nothing under source/ may be written.
 *   - the bucket probe is Throttle.php:23-38 without its file IO, for the same
 *     reason: its directory is VD_ROOT . '/storage/rate'.
 */

chdir(dirname(__DIR__) . '/source');
require dirname(__DIR__) . '/source/lib/support.php';

// A warning printed to stdout would corrupt the json lines, so diagnostics go to
// stderr and any notice the reference emits becomes a probe failure.
ini_set('display_errors', 'stderr');
set_error_handler(static function (int $no, string $msg): bool {
    throw new ErrorException($msg, 0, $no);
});

function b64(string $s): string { return base64_encode($s); }
function unb64(mixed $s): string { return is_string($s) ? (string) base64_decode($s, true) : ''; }

/** JobStore::encode/decode are private statics; reach them the way the engine oracle does. */
$encode = Closure::bind(static fn(Source $s): array => JobStore::encode($s), null, 'JobStore');
$decode = Closure::bind(static fn(array $r): Source => JobStore::decode($r), null, 'JobStore');

/**
 * Rebuilds a Source from a json object of property values, setting only the
 * properties the class declares — the same rule decode() applies, and the only way
 * to avoid php 8.2's dynamic-property warning.
 */
function sourceFrom(string $url, string $kind, array $props): Source
{
    // kind goes through verbatim, including the empty string: Source::make() only
    // substitutes MP4 when the argument is omitted, and a probe that rewrites '' into
    // 'mp4' here would compare the harness instead of the reference.
    $s = Source::make($url, $kind);
    foreach ($props as $k => $v) {
        if ($k === 'url' || $k === 'kind' || !property_exists($s, $k)) {
            continue;
        }
        $s->$k = $v;
    }
    return $s;
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
            // ---------------------------------------------------------------- BuildStore::fileName
            // A real public static of the reference, called straight through.
            case 'file_name':
                $res = b64(BuildStore::fileName(unb64($args[0]), unb64($args[1])));
                break;

            // ---------------------------------------------------------------- JobStore.php:25-26
            //   $secret = bin2hex(random_bytes(16));
            //   $id = substr(hash_hmac('sha256', $b->pageUrl . $secret, 'vd-job'), 0, 20);
            // Both a url and a secret can carry a non-ascii byte, and a secret is a key
            // rather than text: an é has to arrive as the single byte 0xE9, so both
            // arguments travel base64.
            case 'job_id':
                $res = substr(hash_hmac('sha256', unb64($args[0]) . unb64($args[1]), 'vd-job'), 0, 20);
                break;

            // ---------------------------------------------------------------- JobStore.php:81
            //   return substr(hash_hmac('sha256', $url, (string) $record['secret']), 0, 32);
            case 'job_sign':
                $res = substr(hash_hmac('sha256', unb64($args[0]), unb64($args[1])), 0, 32);
                break;

            // ---------------------------------------------------------------- BuildStore.php:32
            //   $id = substr(hash_hmac('sha256', $src->url . $secret, 'vd-build'), 0, 20);
            case 'build_id':
                $res = substr(hash_hmac('sha256', unb64($args[0]) . unb64($args[1]), 'vd-build'), 0, 20);
                break;

            // ---------------------------------------------------------------- BuildStore.php:127
            //   return substr(hash_hmac('sha256', 'file:' . $record['id'], (string) $record['secret']), 0, 32);
            case 'build_sign':
                $res = substr(hash_hmac('sha256', 'file:' . unb64($args[0]), unb64($args[1])), 0, 32);
                break;

            // ---------------------------------------------------------------- Throttle.php:23-38
            // The bucket arithmetic, verbatim, with only the file IO lifted out:
            //   $bucket = ['start' => $now, 'hits' => 0];
            //   if (is_array($prev) && ($prev['start'] ?? 0) + $window > $now) $bucket = $prev;
            //   $bucket['hits']++;  $allowed = $bucket['hits'] <= $limit;
            //   return [...'retryAfter' => max(1, ($bucket['start'] + $window) - $now)];
            case 'bucket':
                [$prev, $now, $limit, $window] = [$args[0], $args[1], $args[2], $args[3]];
                $bucket = ['start' => $now, 'hits' => 0];
                if (is_array($prev) && ($prev['start'] ?? 0) + $window > $now) {
                    $bucket = $prev;
                }
                $bucket['hits']++;
                $res = [
                    'allowed' => $bucket['hits'] <= $limit,
                    'retryAfter' => max(1, ($bucket['start'] + $window) - $now),
                    'start' => $bucket['start'],
                    'hits' => $bucket['hits'],
                    'stored' => b64(json_encode($bucket)),
                ];
                break;

            // ---------------------------------------------------------------- Throttle.php:23
            //   $file = $this->dir . '/' . sha1($key) . '.json';
            case 'sha1':
                $res = sha1(unb64($args[0]));
                break;

            // ---------------------------------------------------------------- Throttle.php:65
            //   if (filter_var($candidate, FILTER_VALIDATE_IP)) ...
            case 'ip':
                $res = filter_var(unb64($args[0]), FILTER_VALIDATE_IP) !== false;
                break;

            // ---------------------------------------------------------------- BuildStore.php:137
            //   '&name=' . urlencode((string) $record['filename'])
            case 'urlencode':
                $res = b64(urlencode(unb64($args[0])));
                break;

            // ---------------------------------------------------------------- BuildStore.php:44
            //   'duration' => round($duration, 2),
            case 'round2':
                $res = round((float) $args[0], 2);
                break;

            // ---------------------------------------------------------------- ExtractorRegistry.php:76-91
            case 'registrable':
                $res = b64(ExtractorRegistry::registrable(unb64($args[0])));
                break;

            // ---------------------------------------------------------------- JobStore.php:55 / 96
            // The json the reference would have written for this record, key order
            // included: json_encode($record, JSON_UNESCAPED_SLASHES).
            case 'record_json':
                $rec = json_decode(unb64($args[0]), true);
                $res = b64(json_encode($rec, JSON_UNESCAPED_SLASHES));
                break;

            // ---------------------------------------------------------------- JobStore.php:122-127
            case 'source_encode':
                $s = sourceFrom(unb64($args[0]), unb64($args[1]), json_decode(unb64($args[2]), true) ?: []);
                $res = b64(json_encode($encode($s), JSON_UNESCAPED_SLASHES));
                break;

            // ---------------------------------------------------------------- JobStore.php:129-139
            // decode() and then a fresh get_object_vars(), so a property the record
            // does not carry, or a property the class does not declare, shows up here.
            case 'source_decode':
                $rec = json_decode(unb64($args[0]), true) ?: [];
                $res = b64(json_encode(get_object_vars($decode($rec)), JSON_UNESCAPED_SLASHES));
                break;

            default:
                $err = 'unknown probe fn: ' . $fn;
        }
    } catch (Throwable $e) {
        $err = get_class($e) . ': ' . $e->getMessage();
    }
    echo json_encode(['id' => $probe['id'], 'ok' => $err === null, 'res' => $res, 'err' => $err],
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
}
