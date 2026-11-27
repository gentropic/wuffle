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
  // the service worker + the @gcu/sw update protocol: the SW serves the cached page at once and refetches it
  // behind; when the bytes changed it says so, and this toast offers the reload (without it, a reload served
  // the old copy and the NEXT one the new, silently). Talks to the SW by postMessage only; inert on a
  // downloaded file:// copy (no SW there). Same toast as micro's.
  + '<script>(function(){'
  + 'if(!("serviceWorker" in navigator))return;'
  + 'var sw=navigator.serviceWorker,shown=false;'
  + 'addEventListener("load",function(){sw.register("sw.js").catch(function(){});});'
  + 'function apply(){try{sw.controller&&sw.controller.postMessage({type:"gcu-sw:apply-update"});}catch(e){}}'
  + 'function toast(){'
  + 'if(shown||!document.body)return;shown=true;'
  + 'var t=document.createElement("div");t.setAttribute("role","status");'
  + 't.style.cssText="position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:12px;align-items:center;background:#1c1c1c;color:#e8e8e8;border:1px solid #3a3a3a;border-radius:8px;padding:10px 14px;font:13px/1.4 ui-monospace,Menlo,Consolas,monospace;box-shadow:0 4px 20px rgba(0,0,0,.5);max-width:calc(100vw - 32px)";'
  + 'var s=document.createElement("span");s.textContent="A new version of wuffle is available.";'
  + 'var b=document.createElement("button");b.textContent="Reload";b.style.cssText="background:#c8781e;color:#fff;border:0;border-radius:5px;padding:5px 12px;font:inherit;cursor:pointer";b.onclick=apply;'
  + 'var x=document.createElement("button");x.textContent="×";x.setAttribute("aria-label","dismiss");x.style.cssText="background:transparent;color:#999;border:0;font:inherit;cursor:pointer;font-size:16px;line-height:1";x.onclick=function(){t.remove();shown=false;};'
  + 't.appendChild(s);t.appendChild(b);t.appendChild(x);document.body.appendChild(t);'
  + '}'
  + 'sw.addEventListener("message",function(e){var d=e.data||{};if(d.type==="gcu-sw:reload"){location.reload();}else if(d.type==="gcu-sw:update-available"){toast();}});'
  + '})();</script>'
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
