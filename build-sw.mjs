// Regenerate sw.js from @gcu/sw (../auditable/ext/sw) — run after engine/config changes:
// `node build-sw.mjs`. The generated sw.js is COMMITTED (vendor-as-copy): the Pages workflow runs
// without an auditable checkout, so the worker must already be here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSw } from '../auditable/ext/sw/make.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// wuffle is one self-contained page: precache the shell, serve it offline (in the field, with no
// signal, is where the compass gets used), SWR for byte-diff updates.
const sw = makeSw({
  app: 'wuffle',
  cache: 'wuffle-shell-v1',
  precache: ['./', './index.html', './manifest.webmanifest', './icon.svg'],
  routes: [],
  navFallback: './index.html',
});

fs.writeFileSync(path.join(here, 'sw.js'), sw);
console.log(`Generated sw.js (${(sw.length / 1024).toFixed(1)} KB) from @gcu/sw`);
