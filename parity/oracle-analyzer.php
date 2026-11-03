<?php
declare(strict_types=1);

/**
 * Differential oracle for the Analyzer and DeepFinder ports. Reads a JSON array of
 * probes from stdin, runs each against the ORIGINAL php classes, and prints one JSON
 * line per probe; the node port must agree with every line, byte for byte.
 *
 *   tools/php/php.exe parity/oracle-analyzer.php < probes.json > oracle-out.jsonl
 *
 * It only ever calls code that touches no socket: Analyzer's url-shape helpers, its
 * title/filename wording, and DeepFinder's pure document reading, ranking, keying
 * and queue rules (with an HttpClient that is never asked for a page). Anything that
 * would fetch is covered by the scripted-http tests instead.
 *
 * Every text/byte value travels as {_b64: "..."} in and {~b: "..."} out, because a
 * title or a url can hold bytes that are not valid utf-8 and the port treats strings
 * as latin1 byte strings.
 */

chdir(dirname(__DIR__) . '/source');
require dirname(__DIR__) . '/source/lib/support.php';

// A warning printed to stdout would corrupt the json lines, so diagnostics go to
// stderr and any notice the reference emits becomes a probe failure.
ini_set('display_errors', 'stderr');
set_error_handler(static function (int $no, string $msg): bool {
    throw new ErrorException($msg, 0, $no);
});

/** {_b64: "..."} becomes the bytes it names; anything else passes through. */
function raw(mixed $v): mixed
{
    if (is_array($v)) {
        if (array_key_exists('_b64', $v) && count($v) === 1) {
            return base64_decode((string) $v['_b64'], true);
        }
        $o = [];
        foreach ($v as $k => $x) {
            $o[$k] = raw($x);
        }
        return $o;
    }
    return $v;
}

/** Every string that leaves the oracle is tagged and base64'd, so bytes survive. */
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

/** A private/protected static method of a php class, callable from this script. */
function privStatic(string $class, string $method): Closure
{
    $r = new ReflectionMethod($class, $method);
    $r->setAccessible(true);
    return static fn(mixed ...$a) => $r->invoke(null, ...$a);
}

/** The same for a private method on one object. */
function privOn(object $obj, string $method): Closure
{
    $r = new ReflectionMethod($obj, $method);
    $r->setAccessible(true);
    return static fn(mixed ...$a) => $r->invoke($obj, ...$a);
}

$fileName = privStatic('Analyzer', 'fileName');
$titleFor = privStatic('Analyzer', 'titleFor');
$label = privStatic('Analyzer', 'label');

/** A finder whose http client is never used, for the queue/key/rank probes. */
function freshFinder(int $budget = 26): DeepFinder
{
    return new DeepFinder(new HttpClient($budget), new MediaBundle());
}

function fillCollected(DeepFinder $finder, array $rows): void
{
    $p = new ReflectionProperty('DeepFinder', 'collected');
    $p->setAccessible(true);
    $map = [];
    foreach ($rows as $row) {
        $s = new Source();
        $s->url = (string) raw($row['url']);
        $s->kind = (string) ($row['kind'] ?? '');
        $s->score = (int) ($row['score'] ?? 0);
        $s->height = array_key_exists('height', $row) ? $row['height'] : null;
        $s->note = $row['note'] ?? null;
        $map[$s->url] = $s;
    }
    $p->setValue($finder, $map);
}

function summary(Source $s): array
{
    return [
        'url' => $s->url,
        'kind' => $s->kind,
        'score' => $s->score,
        'height' => $s->height,
        'note' => $s->note,
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
            // ------------------------------------------------------------ Analyzer
            case 'word_clean':
                // The raw preg behind fileName()'s title cleanup, null and all.
                $res = preg_replace('/[^\w\-. ]+/u', '', (string) raw($args['t']));
                break;
            case 'file_name':
                $rec = ['title' => array_key_exists('title', $args) ? raw($args['title']) : null];
                $s = new Source();
                $s->url = (string) raw($args['url']);
                $s->kind = (string) ($args['kind'] ?? Source::MP4);
                $res = $fileName($rec, $s);
                break;
            case 'md5_slice':
                $res = substr(md5((string) raw($args['url'])), 0, 10);
                break;
            case 'title_for':
                $res = $titleFor((string) raw($args['title']), (string) raw($args['page_url']));
                break;
            case 'label':
                $res = $label((string) raw($args['host']));
                break;
            case 'registrable':
                $res = ExtractorRegistry::registrable((string) raw($args['host']));
                break;
            case 'normalize':
                // Only inputs that decide before any dns lookup matters; a refusal is
                // part of the result, so the exception comes back as data.
                try {
                    $res = ['url' => Analyzer::normalize((string) raw($args['url']))];
                } catch (ExtractException $e) {
                    $res = ['error' => [
                        'class' => get_class($e),
                        'message' => $e->getMessage(),
                        'hint' => $e->hint,
                        'codeName' => $e->codeName,
                    ]];
                } catch (UrlGuardException $e) {
                    $res = ['error' => [
                        'class' => get_class($e),
                        'message' => $e->getMessage(),
                        'hint' => '',
                        'codeName' => '',
                    ]];
                }
                break;
            case 'filter_var':
                $res = filter_var((string) raw($args['url']), FILTER_VALIDATE_URL) !== false;
                break;
            case 'relay_query':
                // The query the browser is handed, without the randomised seal.
                $q = ['r' => 'relay', 'job' => (string) raw($args['job']), 'u' => (string) raw($args['u']), 's' => (string) raw($args['s'])];
                if (!empty($args['download'])) {
                    $q['dl'] = '1';
                    $q['name'] = (string) raw($args['name']);
                }
                if (!empty($args['playlist'])) {
                    $q['p'] = '1';
                }
                $res = http_build_query($q);
                break;
            // ------------------------------------------------------------ DeepFinder
            case 'skipped':
                $res = DeepFinder::skipped((string) raw($args['url']));
                break;
            case 'height_hint':
                $res = DeepFinder::heightHint((string) raw($args['url']));
                break;
            case 'key':
                $res = privOn(freshFinder(), 'key')((string) raw($args['url']), (bool) ($args['path_only'] ?? false));
                break;
            case 'push_queue':
                $finder = freshFinder();
                $push = privOn($finder, 'push');
                foreach ($args['urls'] as $row) {
                    $push((string) raw($row[0]), (int) ($row[1] ?? 0), (string) raw($row[2] ?? ''));
                }
                $res = $finder->queued();
                break;
            case 'ranked':
                $finder = freshFinder();
                fillCollected($finder, $args['rows'] ?? []);
                $res = array_map('summary', $finder->ranked());
                break;
            case 'read_document_walk':
                $finder = freshFinder((int) ($args['budget'] ?? 26));
                $body = (string) raw($args['body']);
                $http_res = new HttpResponse(
                    (int) ($args['status'] ?? 200),
                    $body,
                    [],
                    (string) ($args['content_type'] ?? 'text/html'),
                    (string) raw($args['final_url']),
                    strlen($body),
                );
                $finder->readDocument($http_res, (int) ($args['depth'] ?? 0));
                $bundleProp = new ReflectionProperty('DeepFinder', 'bundle');
                $bundleProp->setAccessible(true);
                /** @var MediaBundle $bundle */
                $bundle = $bundleProp->getValue($finder);
                $res = [
                    'sources' => array_map('summary', $finder->ranked()),
                    'queue' => $finder->queued(),
                    'notices' => $bundle->notices,
                ];
                break;
            default:
                $err = 'unknown probe ' . $fn;
        }
    } catch (Throwable $e) {
        $err = get_class($e) . ':' . $e->getMessage();
    }
    echo json_encode(['id' => $probe['id'] ?? $fn, 'ok' => $err === null, 'res' => enc($res), 'err' => $err], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
}
