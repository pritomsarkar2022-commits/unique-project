import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Turns the rendered php templates into the static bundle Netlify publishes.
 *
 * home.html and 404.html were captured from the untouched php app, so the markup
 * is what views/home.php actually emits; app.js finds its ids in it unchanged. Only
 * two things are filled in here: the site origin in the seo tags, which netlify
 * knows at build time, and the asset version, which has to change when the files do.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const templates = path.join(root, 'site', 'templates');
const assets = path.join(root, 'site', 'assets');
const outDir = path.join(root, 'site', 'public');

const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/+$/, '');

function assetVersion() {
  const names = ['css/app.css', 'css/material.css', 'js/app.js'];
  const seen = [];
  for (const n of names) {
    const f = path.join(assets, ...n.split('/'));
    if (fs.existsSync(f)) {
      seen.push(crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 8));
    }
  }
  return seen.length ? crypto.createHash('sha1').update(seen.join('')).digest('hex').slice(0, 12) : 'dev';
}

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

const version = assetVersion();
for (const [name, target] of [['home.html', 'index.html'], ['404.html', '404.html'], ['robots.txt', 'robots.txt']]) {
  const src = path.join(templates, name);
  if (!fs.existsSync(src)) {
    throw new Error('missing template ' + src);
  }
  let text = fs.readFileSync(src, 'utf8');
  text = text.replace(/\{\{SITE_URL\}\}/g, base);
  text = text.replace(/([?&]v)\d{6,}/g, '$1' + version);
  fs.writeFileSync(path.join(outDir, target), text);
}

if (base === '') {
  const f = path.join(outDir, 'index.html');
  const still = fs.readFileSync(f, 'utf8').includes('rel="canonical" href="/"');
  if (still) {
    console.log('generate-static: no build url available, canonical left site-relative');
  }
}
console.log('generate-static: site/public built with asset version ' + version);
