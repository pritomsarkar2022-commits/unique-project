import { cfg } from '../config.mjs';
import { groupHosts, renderChips, renderRows } from './hosts.mjs';
import { homeTpl } from './pages.gen.mjs';

/**
 * The home page, as the php app renders it for `handle_page()`.
 *
 * Everything except four values is fixed markup that a capture of the original proved
 * byte for byte: the four are the origin (canonical + og:url), the year in the footer,
 * the asset version, and the two lists the registry feeds. `parity/test-views.mjs`
 * compares this against `views/home.php` running, host list and all.
 *
 * @param {{hosts?: Record<string,string>|Map<string,string>, siteUrl?: string,
 *   year?: number|string, assetVer?: string|number, baseHref?: string}} [options]
 */
export function renderHome(options = {}) {
  const { chipHosts, groups } = groupHosts(options.hosts ?? {});
  let html = homeTpl
    .replace('{{HOST_CHIPS}}', renderChips(chipHosts))
    .replace('{{HOST_ROWS}}', renderRows(groups));
  // base_href(): the directory the front controller lives in, trailing slash included,
  // so the asset paths keep working when the app is not installed at the domain root.
  html = html.split('{{BASE}}').join(options.baseHref ?? '/');
  // site_url() is only two places in the document, but both are indexed, so they are
  // filled from the same rule the php used: config app.base_url wins, the request host
  // is the filtered fallback.
  html = html.split('{{SITE_URL}}').join(options.siteUrl ?? cfg('app.base_url', ''));
  html = html.split('{{YEAR}}').join(String(options.year ?? new Date().getFullYear()));
  if (options.assetVer !== undefined && options.assetVer !== null && options.assetVer !== '') {
    html = html.replace(/([?&]v)\d{6,}/g, '$1' + options.assetVer);
  }
  return html;
}
