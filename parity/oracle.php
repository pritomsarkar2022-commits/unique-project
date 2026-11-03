<?php
declare(strict_types=1);

/**
 * Differential-testing oracle. Reads a JSON array of probes from stdin, runs each
 * against the ORIGINAL php implementation and prints one JSON line per probe.
 * The node port must agree with every line, byte for byte.
 *
 *   php oracle.php < probes.json > oracle-out.jsonl
 */

chdir(dirname(__DIR__) . '/source');
require dirname(__DIR__) . '/source/lib/support.php';

// A warning printed to stdout would corrupt the json lines, so diagnostics go to
// stderr and any notice the reference emits becomes a probe failure.
ini_set('display_errors', 'stderr');
set_error_handler(static function (int $no, string $msg, string $file = ''): bool {
    // One exception, and it is not a difference: when a resume tick starts inside a
    // frame, the demuxer appends to a PES buffer for a pid it has not seen a packet
    // start for. php's $this->pending[$pid] .= warns about the missing key and still
    // appends; the port's Map creates the bucket and appends, so the bytes agree and
    // only the log line differs. Everything else stays a failure.
    if ($no === E_WARNING && $file !== '' && basename($file) === 'TsDemuxer.php'
        && preg_match('/^Undefined array key /', $msg) === 1) {
        fwrite(STDERR, "php: {$file}: silent in the port, same bytes\n");
        return true;
    }
    throw new ErrorException($msg, 0, $no);
}, E_ALL);

function b64(string $s): string { return base64_encode($s); }

/** Ordered [key, value] pairs, because an empty php array is [] and an empty object is {}. */
function pairs(array $m): array
{
    $out = [];
    foreach ($m as $k => $v) {
        $out[] = [$k, $v];
    }
    return $out;
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
            case 'e':
                $res = e($args[0]);
                break;
            case 'human_bytes':
                $res = human_bytes($args[0]);
                break;
            case 'url_absolutize':
                $res = url_absolutize($args[0], $args[1]);
                break;
            case 'parse_url':
                // Exact array PHP produced, including the keys it chose to omit.
                $res = ['value' => parse_url($args[0])];
                break;
            case 'link_seal':
                $res = link_seal($args[0], $args[1]);
                break;
            case 'link_open':
                $res = link_open($args[0], $args[1]);
                break;
            case 'seal_roundtrip':
                // Encrypting is randomised, so the probe only checks the other side
                // can open what this side sealed, plus determinism of the key.
                $sealed = link_seal($args[0], $args[1]);
                $res = ['opened' => link_open($sealed, $args[1]), 'key' => b64(hash_hmac('sha256', 'relay-link', $args[1], true))];
                break;
            case 'json_encode_flags':
                $res = json_encode($args[0], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                break;
            case 'readtimestamp':
                $res = TsDemuxer::readTimestamp(b64_decode((string) $args[0]), (int) $args[1]);
                break;
            case 'unescape':
                $res = b64(Avc::unescape(b64_decode((string) $args[0])));
                break;
            case 'avc_split':
                $out = [];
                foreach (Avc::split(b64_decode((string) $args[0])) as $pair) {
                    $out[] = [$pair[0], b64($pair[1])];
                }
                $res = $out;
                break;
            case 'bitreader':
                $br = new BitReader(b64_decode((string) $args[0]));
                $ops = $args[1] ?? [];
                $out = [];
                foreach ($ops as $op) {
                    if ($op === 'left') { $out[] = $br->bitsLeft(); continue; }
                    if ($op === 'ue') { $v = $br->ue(); $out[] = $v; continue; }
                    if ($op === 'se') { $v = $br->se(); $out[] = $v; continue; }
                    $out[] = $br->u((int) substr($op, 1));
                }
                $res = $out;
                break;
            case 'playlist_parse':
                $p = Playlist::parse($args[0], $args[1]);
                $res = [
                    'isMaster' => $p->isMaster,
                    'duration' => $p->duration,
                    'segments' => $p->segments,
                    'variants' => $p->variants,
                    'key' => $p->key,
                    'initSegment' => $p->initSegment,
                ];
                break;
            case 'md5_sha1':
                $res = [md5($args[0]), sha1($args[0]), substr(sha1($args[0]), 0, 12), bin2hex(hash_hmac('sha256', $args[0], 'k'))];
                break;
            case 'urlguard':
                // The security contract: does the server agree to fetch this, and
                // what exactly does it tell the visitor when it refuses.
                try {
                    $res = ['allow' => UrlGuard::assertSafe($args[0])];
                } catch (UrlGuardException $e) {
                    $res = ['refuse' => $e->getMessage()];
                }
                break;
            case 'dns':
                // Reported so the node side can be fed the very same answer and the
                // comparison tests the decision logic rather than the resolver.
                $res = array_map(static fn(string $h): string => (string) gethostbyname($h), $args[0]);
                break;
            case 'normalize':
                $res = Analyzer::normalize($args[0]);
                break;
            case 'pes':
                // One demuxer across every segment, exactly like TsStream: the point is
                // to see a PES packet that a segment boundary cut in half come out whole.
                $d = new TsDemuxer();
                $res = [];
                foreach ($args[0] as $seg) {
                    $events = [];
                    $d->demux((string) base64_decode((string) $seg), static function (int $pid, string $kind, ?int $pts, ?int $dts, string $body) use (&$events): void {
                        $events[] = [$pid, $kind, $pts, $dts, b64($body)];
                    });
                    $res[] = ['events' => $events, 'videoPid' => $d->videoPid, 'audioPid' => $d->audioPid,
                              'pcrPid' => $d->pcrPid, 'pidKind' => pairs($d->pidKind), 'skipped' => pairs($d->skipped),
                              'badPackets' => $d->badPackets, 'pesCount' => $d->pesCount];
                }
                $d->flush(static function (int $pid, string $kind, ?int $pts, ?int $dts, string $body) use (&$res): void {
                    $last = count($res) - 1;
                    $res[$last]['flushed'][] = [$pid, $kind, $pts, $dts, b64($body)];
                });
                break;
            case 'engine':
                // The whole pipeline the app runs: one TsStream across the segments, one
                // Mp4Mux writing to disk, the builder's own clock and parameter helpers
                // called through their real (private) entry points.
                $dir = (string) sys_get_temp_dir() . '/vdparity-' . bin2hex(random_bytes(4));
                mkdir($dir, 0775, true);
                $mp4Path = $dir . '/out.mp4';
                $logPath = $dir . '/out.log';
                $stream = new TsStream();
                $mux = Mp4Mux::open($mp4Path, $logPath);
                $rec = ['ts_offset' => 0, 'last_dts' => null, 'last_delta' => null, 'params' => null, 'note' => null];
                $stampTimes = Closure::bind(static function (array &$r, array &$video, array &$audio): void {
                    Mp4Builder::stampTimes($r, $video, $audio);
                }, null, 'Mp4Builder');
                $captureParams = Closure::bind(static function (array &$r, Avc $avc, Aac $aac): void {
                    Mp4Builder::captureParams($r, $avc, $aac);
                }, null, 'Mp4Builder');
                $trace = [];
                $videoTotal = 0;
                $audioTotal = 0;
                // resume_after cuts the run into two ticks, exactly like the app: the
                // slice ends with a drain, the mux closes and reopens in append mode,
                // and the next tick starts from a fresh demuxer because each request
                // builds its own. The port has to reproduce all of that from the bytes
                // it carried through storage, so the reference needs the same shape.
                $resumeAfter = isset($args[0]['resume_after']) ? (int) $args[0]['resume_after'] : -1;
                $ticks = 1;
                $flushTail = static function (TsStream $s, Mp4Mux $m) use ($stampTimes, &$rec, &$trace, &$videoTotal, &$audioTotal): void {
                    $tail = $s->drain();
                    $video = $tail['video'];
                    $audio = $tail['audio'];
                    if ($video !== [] || $audio !== []) {
                        $stampTimes($rec, $video, $audio);
                        $m->addSegment($video, $audio);
                        $videoTotal += count($video);
                        $audioTotal += count($audio);
                        $trace[] = ['tail' => true,
                                    'video' => array_map(static fn(array $u): array => [strlen($u['data']), $u['pts'], $u['dts'], $u['key'] ? 1 : 0], $video),
                                    'audio' => array_map(static fn(array $u): array => [strlen($u['data']), $u['pts']], $audio)];
                    }
                };
                $segments = $args[0]['segments'];
                for ($i = 0; $i < count($segments); $i++) {
                    $seg = $segments[$i];
                    if ($i === $resumeAfter) {
                        $flushTail($stream, $mux);
                        $mux->close();
                        $mux = Mp4Mux::open($mp4Path, $logPath, true);
                        $stream = new TsStream();
                        $ticks++;
                    }
                    $stream->push((string) base64_decode((string) $seg));
                    $taken = $stream->take();
                    $video = $taken['video'];
                    $audio = $taken['audio'];
                    $stampTimes($rec, $video, $audio);
                    if ($video !== [] || $audio !== []) {
                        $mux->addSegment($video, $audio);
                    }
                    $captureParams($rec, $stream->avc(), $stream->aac());
                    $videoTotal += count($video);
                    $audioTotal += count($audio);
                    $trace[] = ['video' => array_map(static fn(array $u): array => [strlen($u['data']), $u['pts'], $u['dts'], $u['key'] ? 1 : 0], $video),
                                'audio' => array_map(static fn(array $u): array => [strlen($u['data']), $u['pts']], $audio)];
                }
                $flushTail($stream, $mux);
                $moovError = null;
                if (is_array($rec['params'])) {
                    $p = $rec['params'];
                    $p['avcC'] = (string) hex2bin((string) $p['avcC']);
                    $p['asc'] = (string) hex2bin((string) $p['asc']);
                    try {
                        $mux->writeMoov($logPath, $p);
                    } catch (Throwable $e) {
                        $moovError = get_class($e) . ':' . $e->getMessage() . ':' . $e->hint;
                    }
                }
                $mux->close();
                $res = [
                    'mp4' => is_file($mp4Path) ? b64((string) file_get_contents($mp4Path)) : null,
                    'log' => is_file($logPath) ? b64((string) file_get_contents($logPath)) : null,
                    'params' => $rec['params'],
                    'note' => $rec['note'],
                    'clock' => ['ts_offset' => $rec['ts_offset'], 'last_dts' => $rec['last_dts'], 'last_delta' => $rec['last_delta']],
                    'trace' => $trace,
                    'videoSamples' => $videoTotal,
                    'audioSamples' => $audioTotal,
                    'bytes' => $mux->bytesWritten(),
                    'ticks' => $ticks,
                    'moovError' => $moovError,
                    'avc' => ['width' => $stream->avc()->width, 'height' => $stream->avc()->height,
                              'samples' => $stream->avc()->samples, 'keyframes' => $stream->avc()->keyframes,
                              'spsInfo' => $stream->avc()->spsInfo],
                    'aac' => ['sampleRate' => $stream->aac()->sampleRate, 'channels' => $stream->aac()->channels,
                              'objectType' => $stream->aac()->objectType, 'frames' => $stream->aac()->frames,
                              'skippedBytes' => $stream->aac()->skippedBytes, 'asc' => $stream->aac()->asc === null ? null : b64((string) $stream->aac()->asc),
                              'mp4Friendly' => $stream->aac()->isMp4Friendly()],
                    'demux' => ['videoPid' => $stream->demuxer()->videoPid, 'audioPid' => $stream->demuxer()->audioPid,
                                'pcrPid' => $stream->demuxer()->pcrPid, 'pidKind' => pairs($stream->demuxer()->pidKind),
                                'skipped' => pairs($stream->demuxer()->skipped), 'streamType' => pairs($stream->demuxer()->streamType),
                                'badPackets' => $stream->demuxer()->badPackets, 'pesCount' => $stream->demuxer()->pesCount],
                ];
                @unlink($mp4Path);
                @unlink($logPath);
                @rmdir($dir);
                break;
            case 'stamp':
                // The clock repair on its own, because a wrapped 32-bit dts is where a
                // port that guesses at php's int behaviour starts sliding. stampTimes is
                // private, so it is reached through a closure bound to its own class.
                $stampTimes = Closure::bind(static function (array &$r, array &$video, array &$audio): void {
                    Mp4Builder::stampTimes($r, $video, $audio);
                }, null, 'Mp4Builder');
                $rec = ['ts_offset' => (int) $args[1], 'last_dts' => $args[2] === null ? null : (int) $args[2], 'last_delta' => $args[3] === null ? null : (int) $args[3]];
                $video = $args[0]['video'];
                $audio = $args[0]['audio'];
                $stampTimes($rec, $video, $audio);
                $res = ['video' => array_map(static fn(array $u): array => [$u['pts'], $u['dts']], $video),
                        'audio' => array_map(static fn(array $u): int => $u['pts'], $audio),
                        'rec' => ['ts_offset' => $rec['ts_offset'], 'last_dts' => $rec['last_dts'], 'last_delta' => $rec['last_delta']]];
                break;
            case 'muxsamples':
                // The muxer on its own, with clocks no real fixture can reach: wrapped,
                // duplicated and single-sample timelines.
                $dir = (string) sys_get_temp_dir() . '/vdparity-' . bin2hex(random_bytes(4));
                mkdir($dir, 0775, true);
                $mp4Path = $dir . '/out.mp4';
                $logPath = $dir . '/out.log';
                $mux = Mp4Mux::open($mp4Path, $logPath);
                $video = [];
                foreach ($args[0]['video'] as $s) {
                    $video[] = ['data' => str_repeat('A', (int) $s['size']), 'pts' => (int) $s['pts'],
                                'dts' => (int) $s['dts'], 'key' => (bool) $s['key']];
                }
                $audio = [];
                foreach ($args[0]['audio'] as $s) {
                    $audio[] = ['data' => str_repeat('A', (int) $s['size']), 'pts' => (int) $s['pts']];
                }
                $mux->addSegment($video, $audio);
                $p = $args[1];
                $p['avcC'] = (string) hex2bin((string) $p['avcC']);
                $p['asc'] = (string) hex2bin((string) $p['asc']);
                $moovError = null;
                try {
                    $mux->writeMoov($logPath, $p);
                } catch (Throwable $e) {
                    $moovError = get_class($e) . ':' . $e->getMessage() . ':' . $e->hint;
                }
                $bytes = $mux->bytesWritten();
                $mux->close();
                $res = [
                    'mp4' => is_file($mp4Path) ? b64((string) file_get_contents($mp4Path)) : null,
                    'log' => is_file($logPath) ? b64((string) file_get_contents($logPath)) : null,
                    'moovError' => $moovError,
                    'bytes' => $bytes,
                ];
                @unlink($mp4Path);
                @unlink($logPath);
                @rmdir($dir);
                break;
            default:
                $err = 'unknown probe ' . $fn;
        }
    } catch (Throwable $e) {
        // The file and line are the reference's own, which is how a divergence that
        // starts in php rather than in the port tells you so.
        $err = get_class($e) . ':' . $e->getMessage() . '@' . $e->getFile() . ':' . $e->getLine();
    }
    echo json_encode(['id' => $probe['id'] ?? $fn, 'ok' => $err === null, 'res' => $res, 'err' => $err], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
}
