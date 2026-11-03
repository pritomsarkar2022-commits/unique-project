import { Source } from './source.mjs';

/**
 * Port of lib/Extractor/MediaBundle.php: everything the analysis of one page url
 * produced. Strings arrive here as php byte strings, one javascript char per byte.
 */
export class MediaBundle {
  provider = 'generic';
  title = null;
  thumbnail = null;
  pageUrl = '';
  finalUrl = '';

  /** @var Source[] */
  sources = [];

  /** @var string[] things the user should be told (expired file, DRM, slow host ...). */
  notices = [];

  /** 0..1, how much we trust the result. Below 0.4 the UI asks for a manual check. */
  confidence = 0.5;

  /** Populated when the site is reachable but deliberately unsolvable. */
  blockedReason = null;

  addSource(s) {
    for (const existing of this.sources) {
      if (existing.url === s.url) {
        return;
      }
    }
    this.sources.push(s);
  }

  best() {
    const video = this.sources.filter((s) => s.isVideo());
    if (video.length === 0) {
      return null;
    }
    const rank = (s) => (s.kind === Source.MP4 ? 3 : s.kind === Source.HLS ? 2 : 1);
    // ($rank($b) <=> $rank($a)) ?: ($b->height <=> $a->height); a sort that is equal
    // in both keeps the php insertion order (php 8's usort is stable, node's is too).
    video.sort((a, b) => {
      const c = phpSpaceship(rank(b), rank(a));
      return c !== 0 ? c : phpSpaceship(b.height, a.height);
    });
    return video[0];
  }

  notice(message) {
    if (!this.notices.includes(message)) {
      this.notices.push(message);
    }
  }
}

/** php's <=>: null is smaller than every number and equal to null; numbers compare normally. */
function phpSpaceship(a, b) {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return -1;
  }
  if (b === null) {
    return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
