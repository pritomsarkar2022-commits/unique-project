/**
 * The two clock and format helpers a build runs between segments.
 *
 * Port of the private statics of the same names in lib/Build/Mp4Builder.php. They are
 * split out because a build that restarts its timestamps between parts, or switches
 * quality mid-stream, is decided here rather than in the muxer.
 */

/**
 * Keep the clock moving forward when a host restarts its timestamps between parts,
 * because the muxer reads one continuous timeline out of the sample log.
 *
 * @param {object} rec build record, mutated
 * @param {Array<{pts:number,dts:number}>} video samples, mutated in place
 * @param {Array<{pts:number}>} audio samples, mutated in place
 */
export function stampTimes(rec, video, audio) {
  if (video.length === 0) {
    return;
  }
  let offset = Math.trunc(rec.ts_offset ?? 0);
  const first = Math.trunc(video[0].dts);
  const last = rec.last_dts === null || rec.last_dts === undefined ? null : Math.trunc(rec.last_dts);
  if (last !== null) {
    const gap = first + offset - last;
    if (gap <= 0 || gap > 90000 * 120) {
      offset = last + Math.trunc(rec.last_delta ?? 3600) - first;
    }
  }
  let previous = null;
  video.forEach((u, i) => {
    video[i].dts = Math.trunc(u.dts) + offset;
    video[i].pts = Math.trunc(u.pts) + offset;
    if (previous !== null && video[i].dts > previous) {
      rec.last_delta = video[i].dts - previous;
    }
    previous = video[i].dts;
  });
  audio.forEach((u, i) => {
    audio[i].pts = Math.trunc(u.pts) + offset;
  });
  rec.ts_offset = offset;
  rec.last_dts = previous;
}

/**
 * Remember the first format the stream announced, and notice when it changes.
 *
 * @param {object} rec build record, mutated
 * @param {import('../hls/avc.mjs').Avc} avc
 * @param {import('../hls/aac.mjs').Aac} aac
 */
export function captureParams(rec, avc, aac) {
  const avcC = avc.avcC();
  if (avcC === null || avc.width < 2 || avc.height < 2) {
    return;
  }
  const hex = avcC.toString('hex');
  if (rec.params !== null && rec.params !== undefined) {
    if (rec.params.avcC !== hex && (rec.note === null || rec.note === undefined)) {
      rec.note = 'The stream switched quality partway, so the MP4 holds the part before the switch.';
    }
    return;
  }
  rec.params = {
    width: avc.width,
    height: avc.height,
    avcC: hex,
    asc: Buffer.isBuffer(aac.asc) ? aac.asc.toString('hex') : '',
    sampleRate: Math.trunc(aac.sampleRate ?? 0),
    channels: Math.trunc(aac.channels ?? 0),
  };
}
