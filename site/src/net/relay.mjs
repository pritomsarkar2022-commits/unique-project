import { appUrl, linkSeal } from '../support.mjs';

/**
 * Link building for the same-origin relay, ported from Relay.php / Analyzer.php.
 *
 * The browser only ever addresses this site; the sealed `u` parameter carries the
 * real file host and the `s` signature says this job really saw that url. Together
 * they are what keeps the relay from becoming an open proxy for arbitrary hosts.
 */

/**
 * @param {object} store   JobStore-shaped: sign(record, url) -> string
 * @param {object} record  a stored job record
 * @param {string} url     the file host address to reach
 * @param {{download?: boolean, name?: string, isPlaylist?: boolean, segment?: boolean, host?: string, https?: boolean}} opts
 */
export function relayLink(store, record, url, opts = {}) {
  const download = opts.download === true;
  const isPlaylist = opts.isPlaylist === true;
  const params = new URLSearchParams();
  params.set('r', 'relay');
  params.set('job', String(record.id ?? ''));
  params.set('u', linkSeal(url, String(record.secret ?? '')));
  params.set('s', store.sign(record, url));
  if (download) {
    params.set('dl', '1');
    params.set('name', String(opts.name ?? ''));
  }
  if (isPlaylist) {
    params.set('p', '1');
  }
  // A media segment has to come back through this server: hls.js fetches it with
  // xhr, and a cross-origin reply it cannot read is a broken preview. Playlists and
  // segments are therefore never redirected to the file host.
  if (opts.segment === true) {
    params.set('seg', '1');
  }
  return appUrl(params.toString(), opts.host ?? '', opts.https !== false);
}
