<?php
declare(strict_types=1);

/**
 * Differential oracle for the two pages the front controller renders: views/home.php
 * and views/error.php.
 *
 * The rest of this repo proves that bytes of video come out the same; this proves the
 * html does, because the port is only faithful if a visitor cannot tell the two apps
 * apart. The host chips and the supported-sites table are the only markup home.php
 * builds from data, and the sorting that groups them is php-specific (usort with a
 * spaceship chain, ksort on string keys), so it is worth pinning rather than eyeballing.
 *
 * Reads a JSON array of probes from stdin, one json line out per probe:
 *   {"id":..,"ok":true,"res":{"html":"<base64 of the rendered page>"}}
 *
 * Probes:
 *   {"fn":"home","hosts":{"a.com":"areader",...},"server":{...},"config":{"app.base_url":"..."}}
 *   {"fn":"error","notFound":true,"fatal":""}
 *
 * Nothing under source/ may be written, and these views only read, so the require is
 * direct. ASSET_VER is pinned before support.php loads: it is a filemtime of the css,
 * which differs between this checkout and the reference, and it is not the port's job
 * to guess a timestamp — only to splice whatever version string it was given.
 */

chdir(dirname(__DIR__) . '/source');
define('ASSET_VER', '1735689600');
require dirname(__DIR__) . '/source/lib/support.php';

ini_set('display_errors', 'stderr');
set_error_handler(static function (int $no, string $msg): bool {
    throw new ErrorException($msg, 0, $no);
});

function b64(string $s): string
{
    return base64_encode($s);
}

function unb64(mixed $s): string
{
    return is_string($s) ? (string) base64_decode($s, true) : '';
}

$probes = json_decode((string) stream_get_contents(STDIN), true);
if (!is_array($probes)) {
    fwrite(STDERR, "oracle-views: no probes on stdin\n");
    exit(1);
}

// A probe may set app.base_url, and php globals have no per-probe scope. Snapshot the
// config exactly as config/app.php left it and put it back before every render, so one
// probe cannot answer a later one out of its own settings.
$BASE_CONFIG = $GLOBALS['vd_config'];

foreach ($probes as $probe) {
    $id = (string) ($probe['id'] ?? '');
    try {
        $GLOBALS['vd_config'] = $BASE_CONFIG;
        $html = renderView($probe);
        echo json_encode(['id' => $id, 'ok' => true, 'res' => ['html' => b64($html)]], JSON_UNESCAPED_SLASHES) . "\n";
    } catch (Throwable $e) {
        echo json_encode([
            'id' => $id,
            'ok' => false,
            'err' => get_class($e) . ': ' . $e->getMessage() . ' @' . $e->getFile() . ':' . $e->getLine(),
        ]) . "\n";
    }
}

function renderView(array $probe): string
{
    // The front controller's own scope: these are the globals a view may see.
    $_SERVER['SCRIPT_NAME'] = (string) ($probe['server']['SCRIPT_NAME'] ?? '/index.php');
    $_SERVER['HTTP_HOST'] = (string) ($probe['server']['HTTP_HOST'] ?? 'grably.example');
    $_SERVER['HTTPS'] = ($probe['server']['HTTPS'] ?? true) ? 'on' : '';

    foreach ((array) ($probe['config'] ?? []) as $key => $value) {
        $set =& $GLOBALS['vd_config'];
        foreach (explode('.', (string) $key) as $i => $part) {
            if (!is_array($set[$part] ?? null)) {
                $set[$part] = [];
            }
            $set =& $set[$part];
            unset($i);
        }
        $set = $value;
        unset($set);
    }

    ob_start();
    switch ((string) ($probe['fn'] ?? 'home')) {
        case 'home':
            // handle_page() builds this list from the registry, and home.php is
            // required from inside a function, so $route is never in scope there.
            $view = ['hosts' => decodeHosts($probe['hosts'] ?? [])];
            require dirname(__DIR__) . '/source/views/home.php';
            break;
        case 'error':
            $notFound = !empty($probe['notFound']);
            $fatal = unb64($probe['fatal'] ?? '');
            require dirname(__DIR__) . '/source/views/error.php';
            break;
        default:
            throw new RuntimeException('unknown view fn');
    }
    return (string) ob_get_clean();
}

/** Host names arrive base64-encoded, one per entry, so a probe can carry an idn or a
 *  host with a byte that is not valid utf-8 without the json re-encoding it on the way. */
function decodeHosts(mixed $raw): array
{
    $out = [];
    foreach ((array) $raw as $host => $reader) {
        $out[unb64((string) $host)] = unb64((string) $reader);
    }
    return $out;
}
