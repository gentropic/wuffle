# wuffle

**A stereonet workbench and a geological compass, in one HTML file.** On a phone it measures planes and
lines and throws them onto an equal-area net as you take them; on a computer it is a workbench for
orientation data: nets, roses and fabric plots, selections on the sphere, statistics, a shell, figures.
Offline, single file, MIT.

Home: **https://gentropic.org/wuffle**.

## What this repo is

The **deploy surface** only: the PWA shell (`manifest.webmanifest`, `sw.js`, `icon.svg`) lives here. The
app itself is built in the [auditable](https://github.com/gentropic/auditable) monorepo
(`tools/wuffle`, on `@gcu/bearing` + `@gcu/stereonet`); its single-file build (`node build.js
--target=wuffle`) lands here as `wuffle.html`, the committed seed.

`publish.mjs` wraps `wuffle.html` into `index.html` (the PWA tags, between `<!--wuffle-pwa-->` markers so
wuffle's *Save as page* leaves them out of the pages people save and send). The GitHub Pages workflow
(`.github/workflows/publish.yml`) assembles and deploys it on every push to main.

## Updating

- **Refresh the app:** in `../auditable`, `node build.js --target=wuffle`, copy `wuffle.html` here,
  `node publish.mjs` to check it, commit, push.
- **Service worker:** `node build-sw.mjs` regenerates `sw.js` from `@gcu/sw` (needs `../auditable`
  checked out); the result is committed.
