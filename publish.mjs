// publish.mjs — wrap auditable's built wuffle.html into the deployed PWA.
// This repo is the release surface: the PWA shell (manifest.webmanifest, sw.js, icon.svg) is owned
// here; the app itself is built in the auditable monorepo (`node build.js --target=wuffle`) and lands
// here as wuffle.html — the committed SEED, refreshed by hand (as moncad's is).
//
// Produces index.html (wuffle.html + PWA injection), served at gentropic.org/wuffle/.
//
// The injection sits between <!--wuffle-pwa--> markers: wuffle's "Save as page" copies the page it was
// loaded from, and strips what's between them, so a page someone saves and sends is a standalone file,
// not a half-install of this site.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] ? path.resolve(process.argv[2]) : null;

function findWuffle() {
  for (const dir of [src, here]) {
    if (!dir) continue;
    const p = path.join(dir, 'wuffle.html');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const PWA_INJECT = '<!--wuffle-pwa-->'
  + '<link rel="manifest" href="manifest.webmanifest">\n'
  + '<meta name="theme-color" content="#161616">\n'
  + '<script>if("serviceWorker" in navigator)addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));</script>'
  + '<!--/wuffle-pwa-->\n';

const injectPwa = (html) => (/<!--wuffle-pwa-->/.test(html) ? html : html.replace(/<\/head>/i, PWA_INJECT + '</head>'));

const app = findWuffle();
if (!app) {
  console.error('publish: no wuffle.html found.\n  build it: (in ../auditable) node build.js --target=wuffle, then copy it here.');
  process.exit(1);
}
const html = fs.readFileSync(app, 'utf8');
if (!/id="wuffle-rt"/.test(html)) { console.error('publish: wuffle.html is not a built page (no gzipped runtime block)'); process.exit(1); }
fs.writeFileSync(path.join(here, 'index.html'), injectPwa(html));
console.log(`published index.html from ${path.relative(here, app) || 'wuffle.html'} (${(fs.statSync(app).size / 1024).toFixed(0)} KB)`);
