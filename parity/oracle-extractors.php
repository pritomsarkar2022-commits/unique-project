<?php
declare(strict_types=1);

/**
 * Differential oracle for the extractor layer port: BaseExtractor, ExtractorRegistry
 * and GenericExtractor. Reads a JSON array of probes from stdin, runs each against
 * the ORIGINAL php classes and prints one JSON line per probe; the node port must
 * agree with every line, byte for byte.
 *
 *   php oracle-extractors.php < probes.json > oracle-out.jsonl
 *
 * The probes are the string-level decisions the port cannot cheat on: the
 * registrable-domain table, the name() derivation that php reads off static::class
 * (and that javascript has to be told), and the case-insensitive #EXTM3U test that
 * decides whether a response is a playlist at all.
 */

chdir(dirname(__DIR__) . '/source');
require dirname(__DIR__) . '/source/lib/support.php';
require dirname(__DIR__) . '/source/lib/Extractor/ExtractorInterface.php';
require dirname(__DIR__) . '/source/lib/Extractor/MediaBundle.php';
require dirname(__DIR__) . '/source/lib/Extractor/Source.php';
require dirname(__DIR__) . '/source/lib/Extractor/BaseExtractor.php';
require dirname(__DIR__) . '/source/lib/Extractor/ExtractorRegistry.php';

// A warning printed to stdout would corrupt the json lines, so diagnostics go to
// stderr and any notice the reference emits becomes a probe failure.
ini_set('display_errors', 'stderr');
set_error_handler(static function (int $no, string $msg): bool {
    throw new ErrorException($msg, 0, $no);
});

/**
 * The fourteen class names the real tree carries. Each gets a stub with exactly
 * that name so name() reads it off static::class the way php does; only the
 * abstract extract() has to exist, and it is never called.
 */
abstract class NameProbeExtractor extends BaseExtractor
{
    public function extract(string $pageUrl, HttpClient $http, array $visited = []): MediaBundle
    {
        return new MediaBundle();
    }
}

class BlockedExtractor extends NameProbeExtractor {}
class YouTubeExtractor extends NameProbeExtractor {}
class StreamtapeExtractor extends NameProbeExtractor {}
class StreamfileExtractor extends NameProbeExtractor {}
class LuluvidoExtractor extends NameProbeExtractor {}
class FirestreamExtractor extends NameProbeExtractor {}
class PlaymateExtractor extends NameProbeExtractor {}
class VidaraExtractor extends NameProbeExtractor {}
class VixeoExtractor extends NameProbeExtractor {}
class CloudfamExtractor extends NameProbeExtractor {}
class MxdropExtractor extends NameProbeExtractor {}
class XfsExtractor extends NameProbeExtractor {}
class GenericExtractor extends NameProbeExtractor {}
class BaseExtractorProbe extends NameProbeExtractor {}

$in = stream_get_contents(STDIN);
$probes = json_decode((string) $in, true);
if (!is_array($probes)) {
    fwrite(STDERR, "bad input\n");
    exit(1);
}

foreach ($probes as $probe) {
    $fn = (string) ($probe['fn'] ?? '');
    $args = $probe['args'] ?? [];
    $res = null;
    $err = null;
    try {
        switch ($fn) {
            case 'registrable':
                $res = ExtractorRegistry::registrable((string) $args[0]);
                break;

            case 'name_of':
                // the real derivation: strtolower(preg_replace('/extractor$/i','', the short class name))
                $class = (string) $args[0];
                if (!class_exists($class)) {
                    throw new RuntimeException('no such probe class: ' . $class);
                }
                $res = strtolower((string) preg_replace('/extractor$/i', '', (string) (new ReflectionClass($class))->getShortName()));
                break;

            case 'name_instance':
                // name() as the php class itself answers it, through static::class
                $class = (string) $args[0];
                $res = (new $class())->name();
                break;

            case 'stripos_extm3u':
                // exactly what BaseExtractor asks of a response body
                $found = stripos((string) $args[0], '#EXTM3U');
                $res = $found === false ? false : $found;
                break;

            case 'stripos_needle':
                $found = stripos((string) $args[0], (string) $args[1]);
                $res = $found === false ? false : $found;
                break;

            default:
                throw new RuntimeException('unknown probe: ' . $fn);
        }
    } catch (Throwable $e) {
        $err = get_class($e) . ': ' . $e->getMessage();
    }
    echo json_encode(['id' => $probe['id'] ?? '', 'res' => $res, 'err' => $err]), "\n";
}
