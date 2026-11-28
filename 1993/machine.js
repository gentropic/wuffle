// One StarStereo machine: a DOSBox session (js-dos's emulators, in a worker), its pane (a strip with the
// CPU switch and the lights, the screen), and its drives:
//   C:  its own disk — StarStereo's files from the page (always the published ones) and whatever the
//       machine writes, kept in the browser's store under /machines/<id>/C
//   D:  a folder of yours, mounted from the page (read in; written back on request), not kept
//   E:  the shared workspace — the same files on every machine, kept under /work
// What DOS writes is read back every couple of seconds (DOSBox has no file events) and kept; what the
// page puts on a drive is written into the running machine at once. No restart for either.

export const CPUS = [
  ['2500', '386SX/16'], ['4500', '386DX/33'], ['15000', '486DX2/66'], ['max', 'Turbo'],
];
export const cpuName = (v) => (CPUS.find(([k]) => k === v) || CPUS[1])[1];

// the page's keys → js-dos's (GLFW) codes
const KEY = { Escape: 256, Enter: 257, NumpadEnter: 335, Tab: 258, Backspace: 259, Insert: 260, Delete: 261, ArrowRight: 262, ArrowLeft: 263,
  ArrowDown: 264, ArrowUp: 265, PageUp: 266, PageDown: 267, Home: 268, End: 269, Space: 32, Quote: 39, Comma: 44, Minus: 45, Period: 46,
  Slash: 47, Semicolon: 59, Equal: 61, BracketLeft: 91, Backslash: 92, BracketRight: 93, Backquote: 96, ShiftLeft: 340, ControlLeft: 341,
  AltLeft: 342, ShiftRight: 344, AltRight: 346, CapsLock: 280, NumpadAdd: 334, NumpadSubtract: 333, NumpadMultiply: 332, NumpadDivide: 331, NumpadDecimal: 330 };
export function keyCode(e) {
  if (KEY[e.code] != null) return KEY[e.code];
  let m = e.code.match(/^Key([A-Z])$/); if (m) return m[1].charCodeAt(0);
  m = e.code.match(/^Digit(\d)$/); if (m) return 48 + +m[1];
  m = e.code.match(/^Numpad(\d)$/); if (m) return 320 + +m[1];
  m = e.code.match(/^F(\d+)$/); if (m && +m[1] <= 12) return 289 + +m[1];
  return null;
}
// a character typed by the page (Open in StarStereo): its key, and whether Shift goes with it
function charKey(ch) {
  if (/[A-Za-z]/.test(ch)) return [ch.toUpperCase().charCodeAt(0), false];
  if (/[0-9]/.test(ch)) return [ch.charCodeAt(0), false];
  const plain = { ' ': 32, '.': 46, '\\': 92, '-': 45, '/': 47, ';': 59, ',': 44, '=': 61, "'": 39 };
  if (plain[ch] != null) return [plain[ch], false];
  const shifted = { ':': 59, '_': 45, '~': 96, '!': 49, '$': 52, '*': 56 };
  if (shifted[ch] != null) return [shifted[ch], true];
  return null;
}

const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Machine {
  /** store: the page's workspace (rom, read/write/remove/list under a VFS path); hooks: { changed(drive), status(s), focus(m) } */
  constructor(meta, store, hooks) {
    this.id = meta.id; this.name = meta.name; this.cpu = meta.cpu || '4500';
    this.store = store; this.hooks = hooks;
    this.ci = null; this.booting = false; this.image = null;
    this.known = { C: new Map(), D: new Map(), E: new Map() };   // drive → name → the bytes as last seen on both sides
    this.folder = null; this.folderName = ''; this.folderFiles = new Map();   // D:
    this.held = new Map();                                       // key code → when it went down (each is held ≥ 60 ms)
    this.syncing = false; this.visible = true;
    this.build();
  }

  get cPath() { return `/machines/${this.id}/C`; }
  get running() { return !!this.ci; }

  // ---- the pane
  build() {
    const el = this.el = document.createElement('div');
    el.className = 'pc';
    el.innerHTML = `<div class="strip">
        <span class="led power" title="power"></span><span class="led turbo" title="turbo"></span><span class="led disk" title="disk"></span>
        <label>CPU <select class="cpu"></select></label>
        <span class="state"></span><span class="grow"></span>
        <button class="b-reset" title="Ctrl+Alt+Del: restart DOS, the drives as they are">reset</button>
        <button class="b-power">power</button>
        <button class="b-full" title="the screen alone (Right Ctrl+F)">full screen</button>
      </div>
      <div class="screen"><canvas tabindex="0"></canvas>
        <div class="off"><div>${this.name} is off<br><button class="b-on">Power on</button></div></div>
        <span class="paused" hidden>paused (not in view)</span></div>`;
    const $ = (s) => el.querySelector(s);
    this.cv = $('canvas'); this.ctx = this.cv.getContext('2d'); this.screen = $('.screen');
    this.cv.width = 640; this.cv.height = 400;
    const sel = $('.cpu');
    for (const [v, n] of CPUS) sel.append(new Option(n, v));
    sel.value = this.cpu;
    sel.onchange = () => this.setCpu(sel.value);
    $('.b-on').onclick = () => this.boot();
    $('.b-power').onclick = () => (this.ci ? this.powerOff() : this.boot());
    $('.b-reset').onclick = () => this.reset();
    $('.b-full').onclick = () => this.fullscreen();
    this.cv.addEventListener('focus', () => { el.classList.add('focused'); this.hooks.focus?.(this); });
    this.cv.addEventListener('blur', () => { el.classList.remove('focused'); this.release(); });
    this.screen.addEventListener('pointerdown', () => this.cv.focus());
    // a file dropped on the screen lands on this machine's C:
    this.screen.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); this.screen.classList.add('drop'); } });
    this.screen.addEventListener('dragleave', () => this.screen.classList.remove('drop'));
    this.screen.addEventListener('drop', (e) => {
      e.preventDefault(); this.screen.classList.remove('drop');
      if (e.dataTransfer.files.length) this.hooks.insert?.(this, 'C', e.dataTransfer.files);
    });
    new ResizeObserver(() => this.fit()).observe(this.screen);
    // a machine nobody can see is paused (DOSBox spins its CPU otherwise): another tab in front, or scrolled off
    new IntersectionObserver((es) => { for (const x of es) this.setVisible(x.isIntersecting); }).observe(this.screen);
    this.lights();
  }
  fit() {
    const W = this.screen.clientWidth - 8, H = this.screen.clientHeight - 8, w = this.cv.width, h = this.cv.height;
    if (W <= 0 || H <= 0) return;
    const s = Math.min(Math.floor(W / w), Math.floor(H / h));   // whole multiples where they fit: crisp text
    const f = s >= 1 ? s : Math.min(W / w, H / h);
    this.cv.style.width = Math.round(w * f) + 'px'; this.cv.style.height = Math.round(h * f) + 'px';
  }
  lights() {
    const $ = (s) => this.el.querySelector(s);
    $('.power').classList.toggle('on', !!this.ci);
    $('.turbo').classList.toggle('on', this.cpu === 'max');
    $('.state').textContent = this.booting ? 'booting…' : this.ci ? (this.visible ? 'on' : 'paused') : 'off';
    $('.off').hidden = !!this.ci || this.booting;
    $('.b-power').textContent = this.ci ? 'power off' : 'power on';
    $('.b-reset').disabled = !this.ci;
    $('.paused').hidden = !this.ci || this.visible;
  }
  disk(on) { this.el.querySelector('.disk').classList.toggle('on', on); }
  focus() { this.cv.focus(); }
  fullscreen() { (document.fullscreenElement ? document.exitFullscreen() : this.screen.requestFullscreen()).catch(() => {}); this.cv.focus(); }
  setVisible(v) {
    if (v === this.visible) return;
    this.visible = v;
    if (this.ci) { try { v ? this.ci.resume() : this.ci.pause(); } catch { /* exiting */ } }
    this.lights();
  }

  // ---- the session
  /** what goes on the drives when it boots: the store's (C:, E:), the folder's (D:), StarStereo's own */
  async drives() {
    const out = [], put = (p, b) => out.push({ path: p, contents: b.slice() });   // copies: the buffers are TRANSFERRED to the worker
    const c = await this.store.list(this.cPath);
    for (const [n, b] of this.store.rom) put('C/' + n, b);
    for (const { name } of c) if (!this.store.rom.has(name)) put('C/' + name, await this.store.read(this.cPath + '/' + name));
    const e = await this.store.list('/work');
    for (const { name } of e) put('E/' + name, await this.store.read('/work/' + name));
    if (!e.length) put('E/' + this.store.WORK_README[0], this.store.WORK_README[1]);
    if (this.folderFiles.size) for (const [p, b] of this.folderFiles) put('D/' + p, b);
    else put('D/DRIVE_D.TXT', new TextEncoder().encode('Drive D: is a folder of yours: Machine > Mount a folder as D:.\r\n'));
    return out;
  }
  async boot() {
    if (this.booting) return;
    this.booting = true; this.lights();
    try {
      if (this.ci) await this.stop();
      const files = await this.drives();
      const cycles = this.cpu === 'max' ? 'max' : 'fixed ' + this.cpu;
      const conf = `[sdl]\nautolock=false\n[cpu]\ncore=normal\ncputype=386\ncycles=${cycles}\n[autoexec]\n@echo off\nmount c ./C > NUL\nmount d ./D > NUL\nmount e ./E > NUL\nc:\necho.\necho StarStereo 93 - Professional DOS Engine 3.0 on ${this.name}  (${cpuName(this.cpu)})\necho C: this PC   D: a folder of yours   E: the workspace (every PC)\necho.\nSTARSTER FIELD94.DAT /KAMB\necho.\necho MORE README.TXT reads the manual; STARSTER starts StarStereo again.\n`;
      // what is on the drives as booted IS what we know: only changes after this are news
      for (const k of 'CDE') this.known[k] = new Map();
      for (const f of files) {
        const [d, ...rest] = f.path.split('/');
        if (d === 'C' && this.store.rom.has(rest.join('/'))) continue;     // StarStereo's own files aren't the machine's to keep
        this.known[d].set(rest.join('/'), f.contents.slice());
      }
      this.known.E.delete(this.store.WORK_README[0]);                     // the placeholder isn't workspace
      this.known.D.delete('DRIVE_D.TXT');
      const ci = await emulators.dosboxWorker([...files, { dosboxConf: conf, jsdosConf: { version: '8' } }]);
      this.ci = ci;
      ci.mute();
      ci.events().onFrameSize((w, h) => { this.cv.width = w; this.cv.height = h; this.image = this.ctx.createImageData(w, h); this.fit(); });
      ci.events().onFrame((rgb, rgba) => {
        if (!this.image || this.image.width !== this.cv.width) { this.cv.width = ci.width(); this.cv.height = ci.height(); this.image = this.ctx.createImageData(this.cv.width, this.cv.height); this.fit(); }
        const d = this.image.data;
        if (rgba) d.set(rgba.subarray(0, d.length));
        else if (rgb) for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { d[j] = rgb[i]; d[j + 1] = rgb[i + 1]; d[j + 2] = rgb[i + 2]; d[j + 3] = 255; }
        this.ctx.putImageData(this.image, 0, 0);
      });
      ci.events().onExit(() => { if (this.ci === ci) { this.ci = null; this.lights(); this.hooks.changed?.(this, 'power'); } });
      if (!this.visible) ci.pause();
      this.hooks.status?.(`${this.name} on, ${cpuName(this.cpu)} · F10 for StarStereo's menus, F1 for its keys`);
      this.focus();
    } catch (e) {
      this.ci = null;
      this.hooks.status?.(`${this.name}: could not start DOSBox: ${e.message || e}`);
    } finally { this.booting = false; this.lights(); this.hooks.changed?.(this, 'power'); }
  }
  async stop() {
    if (!this.ci) return;
    await this.sync().catch(() => {});                    // what it wrote last, kept before it goes
    const old = this.ci; this.ci = null; this.image = null;
    await Promise.race([old.exit().catch(() => {}), sleep(1500)]);   // its exit can hang: don't wait long
  }
  async powerOff() { await this.stop(); this.lights(); this.hooks.changed?.(this, 'power'); this.hooks.status?.(`${this.name} off — its C: is kept`); }
  async reset() { if (!this.ci) return; this.hooks.status?.(`${this.name}: Ctrl+Alt+Del`); await this.stop(); await this.boot(); }
  async setCpu(v) {
    this.cpu = v; this.el.querySelector('.cpu').value = v; this.lights();
    this.hooks.changed?.(this, 'meta');
    if (this.ci) { this.hooks.status?.(`${this.name}: restarting at ${cpuName(v)} — the drives come along`); await this.stop(); await this.boot(); }
  }

  // ---- keys
  key(code, down) {
    if (!this.ci) return;
    if (down) { if (!this.held.has(code)) this.held.set(code, performance.now()); this.ci.sendKeyEvent(code, true); return; }
    const t = this.held.get(code); this.held.delete(code);
    const ci = this.ci, wait = Math.max(0, 60 - (performance.now() - (t ?? 0)));   // DOSBox misses a press shorter than a frame or so
    setTimeout(() => { try { ci.sendKeyEvent(code, false); } catch { /* gone */ } }, wait);
  }
  /** every key still down goes up (focus left: otherwise DOS sees it held forever) */
  release() { for (const k of [...this.held.keys()]) this.key(k, false); }
  async press(code, shift = false) {
    if (!this.ci) return;
    if (shift) this.ci.sendKeyEvent(340, true);
    this.ci.sendKeyEvent(code, true); await sleep(70); this.ci.sendKeyEvent(code, false);
    if (shift) this.ci.sendKeyEvent(340, false);
    await sleep(90);
  }
  async type(text) { for (const ch of text) { const k = charKey(ch); if (k) await this.press(k[0], k[1]); } }
  /** a DOS path opened in StarStereo: typed at the prompt, or into File > Open's name line */
  async open(dosPath) {
    if (!this.ci) { await this.boot(); await sleep(4000); }
    let prog = '';
    try { prog = String(await this.ci.getRunningProgram()); } catch { /* older emulators: assume StarStereo */ prog = 'STARSTER'; }
    this.focus();
    if (/STARSTER/i.test(prog)) {
      await this.press(256); await this.press(256);      // Esc, Esc: out of a menu, a box, the table
      await this.press(291);                              // F2: File > Open
      await sleep(this.cpu === 'max' ? 300 : 900);
      await this.press(258, true);                        // Shift+Tab: the name line
      await this.type(dosPath);
      await this.press(257);                              // Enter (if the data had changed, StarStereo asks now)
    } else {
      await this.type('STARSTER ' + dosPath); await this.press(257);
    }
  }

  // ---- the drives, both ways
  /** the page put a file on one of this machine's drives: into the running machine too */
  async put(drive, name, bytes) {
    this.known[drive].set(name, bytes.slice());
    if (drive === 'D') this.folderFiles.set(name, bytes.slice());
    if (this.ci) { this.disk(true); try { await this.ci.fsWriteFile(drive + '/' + name, bytes.slice()); } finally { setTimeout(() => this.disk(false), 200); } }
  }
  async remove(drive, name) {
    this.known[drive].delete(name);
    if (drive === 'D') this.folderFiles.delete(name);
    if (this.ci) { try { await this.ci.fsDeleteFile(drive + '/' + name); } catch { /* not there */ } }
  }
  /** what is on the running machine's drives: drive → [[name, size]] */
  async tree() {
    const out = { C: [], D: [], E: [] };
    if (!this.ci) return out;
    const t = await this.ci.fsTree();
    const walk = (node, at, d) => { for (const x of node.nodes || []) { const p = at + x.name; if (x.nodes) walk(x, p + '/', d); else out[d].push([p, x.size ?? 0]); } };
    for (const d of t.nodes || []) if (out[d.name]) walk(d, '', d.name);
    return out;
  }
  /** DOS's writes and deletions since we last looked → the store (C:, E:) or the folder's copy (D:). Returns the drives that changed */
  async sync() {
    if (!this.ci || this.syncing || this.booting) return [];
    this.syncing = true;
    const changed = new Set();
    try {
      const t = await this.tree(), ci = this.ci;
      for (const d of ['C', 'D', 'E']) {
        const seen = new Set();
        for (const [name, size] of t[d]) {
          if (d === 'C' && this.store.rom.has(name)) { const r = this.store.rom.get(name); if (r.length === size) continue; }
          if ((d === 'E' && name === this.store.WORK_README[0] && !this.known.E.has(name)) || (d === 'D' && name === 'DRIVE_D.TXT')) continue;
          seen.add(name);
          const was = this.known[d].get(name);
          if (was && was.length !== size) { /* changed: read below */ } else if (was && d === 'C' && size > 65536) continue;   // a big unchanged-size file: trust it
          const b = await ci.fsReadFile(d + '/' + name);
          if (same(b, was)) continue;
          this.known[d].set(name, b.slice());
          if (d === 'C') await this.store.write(this.cPath + '/' + name, b);
          else if (d === 'E') await this.store.write('/work/' + name, b, this);
          else this.folderFiles.set(name, b.slice());
          changed.add(d);
        }
        for (const name of [...this.known[d].keys()]) if (!seen.has(name)) {
          this.known[d].delete(name);
          if (d === 'C') await this.store.remove(this.cPath + '/' + name);
          else if (d === 'E') await this.store.remove('/work/' + name, this);
          else this.folderFiles.delete(name);
          changed.add(d);
        }
      }
    } catch { /* busy or gone: next time */ } finally { this.syncing = false; }
    for (const d of changed) this.hooks.changed?.(this, d);
    return [...changed];
  }

  // ---- D:, a folder of yours
  async mountFolder() {
    if (window.showDirectoryPicker) {
      let h;
      try { h = await showDirectoryPicker({ mode: 'readwrite' }); } catch { return false; }
      this.folder = h; this.folderName = h.name; this.folderFiles = new Map();
      const read = async (dir, at = '') => {
        for await (const [name, x] of dir.entries()) {
          if (x.kind === 'directory') await read(x, at + name + '/');
          else { const f = await x.getFile(); if (f.size <= 16e6) this.folderFiles.set(at + name, new Uint8Array(await f.arrayBuffer())); }
        }
      };
      await read(h);
      await this.mounted();
      return true;
    }
    return null;   // no File System Access: the page falls back to a read-only folder input
  }
  async mountFiles(fileList) {               // <input webkitdirectory>: read only; write-back isn't possible
    this.folder = null; this.folderFiles = new Map();
    for (const f of fileList) {
      const p = f.webkitRelativePath.split('/');
      this.folderName = p[0];
      if (f.size <= 16e6) this.folderFiles.set(p.slice(1).join('/'), new Uint8Array(await f.arrayBuffer()));
    }
    await this.mounted();
  }
  async mounted() {
    this.known.D = new Map([...this.folderFiles].map(([k, v]) => [k, v.slice()]));
    if (this.ci) {
      try { await this.ci.fsDeleteFile('D/DRIVE_D.TXT'); } catch { /* fine */ }
      for (const [p, b] of this.folderFiles) await this.ci.fsWriteFile('D/' + p, b.slice());
    }
    this.hooks.changed?.(this, 'D');
    this.hooks.status?.(`${this.folderName} is D: on ${this.name}${this.folder ? '' : ' (read only: this browser can\'t write a folder back)'}`);
  }
  /** D:'s files that are new or changed, into the real folder */
  async writeBack() {
    if (!this.folder) return 0;
    await this.sync();
    let n = 0;
    for (const [p, b] of this.folderFiles) {
      let dir = this.folder;
      const parts = p.split('/');
      let old = null;
      try {
        for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true });
        try { old = new Uint8Array(await (await (await dir.getFileHandle(parts.at(-1))).getFile()).arrayBuffer()); } catch { /* new */ }
        if (same(old, b)) continue;
        const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(b); await w.close(); n++;
      } catch (e) { this.hooks.status?.(`could not write ${p} into ${this.folderName}: ${e.message || e}`); }
    }
    return n;
  }
  meta() { return { id: this.id, name: this.name, cpu: this.cpu }; }
}
