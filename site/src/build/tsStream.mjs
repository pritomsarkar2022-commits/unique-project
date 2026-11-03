/**
 * Elementary stream reader that survives segment and request boundaries.
 *
 * Port of lib/Build/TsStream.php. Holds one TsDemuxer, one Avc and one Aac for the
 * whole build, so a PES packet or a picture that a part cuts in half is finished by
 * the next part instead of being thrown away. Throwing it away shortens the track and
 * slides the audio out of step with the picture for every second that follows.
 */
import { TsDemuxer } from '../hls/tsDemuxer.mjs';
import { Avc } from '../hls/avc.mjs';
import { Aac } from '../hls/aac.mjs';
import { phpRound } from '../support.mjs';

export class TsStream {
  #demux = new TsDemuxer();
  #avc = new Avc();
  #aac = new Aac();

  /** @type {Array<{data:Buffer,pts:number,dts:number,key:boolean}>} */
  #video = [];
  /** @type {Array<{data:Buffer,pts:number}>} */
  #audio = [];
  #audioClock = null;

  demuxer() {
    return this.#demux;
  }

  avc() {
    return this.#avc;
  }

  aac() {
    return this.#aac;
  }

  /** Read one MPEG-TS buffer and queue the frames it completed. */
  push(ts) {
    this.#demux.demux(ts, this.sink());
  }

  /**
   * Close off everything still open at the end of the stream. This is the last chance
   * to keep the loose ends.
   */
  drain() {
    this.#demux.flush(this.sink());
    for (const u of this.#avc.finish()) {
      this.#video.push({
        data: Avc.toAvcc(u.nalus),
        pts: u.pts,
        dts: u.dts,
        key: u.key === true,
      });
    }
    return this.take();
  }

  take() {
    const out = { video: this.#video, audio: this.#audio };
    this.#video = [];
    this.#audio = [];
    return out;
  }

  sink() {
    return (pid, kind, pts, dts, body) => {
      if (kind === 'video' && pid === this.#demux.videoPid) {
        for (const u of this.#avc.push(body, pts, dts)) {
          this.#video.push({
            data: Avc.toAvcc(u.nalus),
            pts: u.pts,
            dts: u.dts,
            key: u.key === true,
          });
        }
        return;
      }
      if (pid !== this.#demux.audioPid) {
        return;
      }
      const rate = Math.max(1, this.#aac.sampleRate ?? 44100);
      const step = 1024 * 90000 / rate;
      if (pts !== null && (this.#audioClock === null || Math.abs(pts - this.#audioClock) > step * 2)) {
        this.#audioClock = pts;
      }
      for (const frame of this.#aac.push(body)) {
        this.#audio.push({ data: frame.data, pts: phpRound(this.#audioClock ?? 0) });
        this.#audioClock = (this.#audioClock ?? 0) + step;
      }
    };
  }
}
