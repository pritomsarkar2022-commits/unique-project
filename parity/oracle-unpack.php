<?php
declare(strict_types=1);

/**
 * Differential oracle for the JsUnpacker and CertChain ports. Reads a JSON array
 * of probes from stdin, runs each against the ORIGINAL php classes and prints one
 * JSON line per probe; the node port must agree with every line, byte for byte.
 *
 *   php oracle-unpack.php < probes.json > oracle-out.jsonl
 *
 * Anything that is not plain text (decoded sources, raw DER) travels as base64 so
 * a stray byte can never corrupt the json lines.
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

/**
 * Private statics of the reference classes, reached the way the engine oracle
 * reaches Mp4Builder: a closure bound to their own class.
 */
function member(string $class, string $method): Closure
{
    return Closure::bind(static fn(mixed ...$a) => $class::{$method}(...$a), null, $class);
}

$der = member('CertChain', 'der');
$fingerprint = member('CertChain', 'fingerprint');
$isSelfSigned = member('CertChain', 'isSelfSigned');
$systemStore = member('CertChain', 'systemStore');
$cachePath = member('CertChain', 'cachePath');
$unpackArgs = member('JsUnpacker', 'unpackArgs');
$base = member('JsUnpacker', 'base');

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
            // ---------------------------------------------------------------- JsUnpacker
            case 'unpack':
                $res = b64(JsUnpacker::unpack($args[0]));
                break;
            case 'unpack_args':
                $res = b64($unpackArgs($args[0], (int) $args[1], $args[2], (int) $args[3]));
                break;
            case 'base':
                $res = $base((int) $args[0], (int) $args[1]);
                break;
            case 'unescape':
                $res = b64(JsUnpacker::unescape($args[0]));
                break;
            case 'flatten':
                $res = b64(JsUnpacker::flatten($args[0]));
                break;
            case 'join_concatenations':
                $res = b64(JsUnpacker::joinConcatenations($args[0]));
                break;
            case 'stripcslashes':
                // Not a class method: the php escape semantics the class leans on,
                // pinned so the port cannot drift from a guess.
                $res = b64(stripcslashes($args[0]));
                break;
            // ---------------------------------------------------------------- CertChain
            case 'aia_uris':
                // Each uri is base64 because a DER scan can slice out a non-utf8 run.
                $res = array_map('b64', CertChain::aiaUris($args[0]));
                break;
            case 'der':
                $res = b64((string) $der($args[0]));
                break;
            case 'fingerprint':
                $res = $fingerprint($args[0]);
                break;
            case 'is_self_signed':
                $res = $isSelfSigned($args[0]);
                break;
            case 'system_store':
                // The chain php really walks: curl.cainfo is PHP_INI_SYSTEM so it can
                // only be read, while openssl.cafile can be aimed at a fixture here.
                if (array_key_exists(0, $args)) {
                    ini_set('openssl.cafile', (string) $args[0]);
                }
                $res = $systemStore();
                break;
            case 'ini':
                $res = ['curl.cainfo' => (string) ini_get('curl.cainfo'), 'openssl.cafile' => (string) ini_get('openssl.cafile')];
                break;
            case 'store_accepts':
                // The acceptance test from the body of systemStore(), verbatim.
                $file = (string) $args[0];
                $res = is_readable($file) && (int) (@filesize($file) ?: 0) > 4096
                    && str_contains((string) @file_get_contents($file, false, null, 0, 4096), 'BEGIN CERTIFICATE');
                break;
            case 'store_walk':
                // The body of systemStore() verbatim over an injected candidate list.
                // ini_set() cannot retarget curl.cainfo (it is PHP_INI_SYSTEM), so this
                // is how the order of the chain gets diff-tested.
                $list = array_values(array_filter(array_map(static fn($v): string => (string) $v, (array) $args[0])));
                $res = null;
                foreach ($list as $file) {
                    if (is_readable($file) && (int) (@filesize($file) ?: 0) > 4096
                        && str_contains((string) @file_get_contents($file, false, null, 0, 4096), 'BEGIN CERTIFICATE')) {
                        $res = $file;
                        break;
                    }
                }
                break;
            case 'cache_path':
                $path = $cachePath($args[0]);
                // It mkdirs inside VD_ROOT, which is the untouched source tree, so the
                // probe reports the name it chose and removes the directory again.
                $made = VD_ROOT . '/storage/cert';
                $entries = @scandir($made);
                if (is_array($entries) && count($entries) === 2) {
                    @rmdir($made);
                }
                $res = ['dir' => basename(dirname($path)), 'name' => basename($path)];
                break;
            case 'filter_url':
                $res = filter_var($args[0], FILTER_VALIDATE_URL) !== false;
                break;
            case 'base64_decode':
                $res = b64((string) base64_decode($args[0]));
                break;
            default:
                $err = 'unknown probe ' . $fn;
        }
    } catch (Throwable $e) {
        $err = get_class($e) . ':' . $e->getMessage();
    }
    echo json_encode(['id' => $probe['id'] ?? $fn, 'ok' => $err === null, 'res' => $res, 'err' => $err], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
}
