import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHome } from '../site/src/views/home.mjs';
import { renderError } from '../site/src/views/error.mjs';
import { ASSET_VER, robotsTpl } from '../site/src/views/pages.gen.mjs';
import { ExtractorRegistry } from '../site/src/extractor/extractorRegistry.mjs';

/**
 * Builds the static bundle Netlify publishes.
 *
 * This is the same code path the function uses for `/index.php`: both call
 * `site/src/views/home.mjs`, so the page a crawler sees in the cache and the page a
 * visitor sees when the function answers cannot drift apart. The markup itself is a
 * capture of what the untouched php views emit, proven byte for byte by
 * `parity/test-views.mjs`; nothing here redesigns it.
 *
 * Two values only netlify knows: the origin, for the seo tags, and the asset version,
 * which has to change when the files do.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const assets = path.join(root, 'site', 'assets');
const outDir = path.join(root, 'site', 'public');

const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/+$/, '');

/** The php app stamped ASSET_VER from the newest mtime of its own css and js; this
 *  build hashes those files instead, in scripts/generate-views.mjs, and both the page
 *  written here and the route that answers /index.php read the one value back. */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(a, b);
    } else {
      fs.copyFileSync(a, b);
    }
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
copyTree(assets, path.join(outDir, 'assets'));

const version = ASSET_VER;
const hosts = await new ExtractorRegistry().knownHosts();

fs.writeFileSync(path.join(outDir, 'index.html'), renderHome({ hosts, siteUrl: base, assetVer: version }));
fs.writeFileSync(path.join(outDir, '404.html'), renderError({ notFound: true, assetVer: version }));
fs.writeFileSync(path.join(outDir, 'robots.txt'), robotsTpl.split('{{SITE_URL}}').join(base));

if (base === '') {
  console.log('generate-static: no build url available, canonical left site-relative');
}
console.log('generate-static: site/public built with asset version ' + version
  + ' and ' + Object.keys(hosts).length + ' hosts listed');
