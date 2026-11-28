// StarStereo 93's page: a GCU workbench around one or more DOS machines running it.
//   the drives (left)    every machine's C: and D:, and E: — the workspace every machine shares
//   the machines         each a DOSBox in its own pane (tabs, splits, floats: @gcu/rails)
//   the editors          a text file from any drive, saved back onto it (the machine sees it at once)
// Everything but a mounted folder is kept in this browser (IndexedDB, through @gcu/vfs): the machines,
// their disks, the workspace, the arrangement. File > Reset everything starts over.
//
// The host key is Right Ctrl, as on the emulators of the day's descendants: held, it is the page's (1–9 a
// pane, ← → the next, M the menus, N a new PC, F full screen); DOS never sees it. Any other key goes to the
// pane that has focus — a machine takes all of them, Alt and F10 included.
import { createRails, findTab, isSplit } from '@gcu/rails';
import { MenuBar, show as showMenu } from '@gcu/menu';
import { alert, confirm, prompt, Dialog } from '@gcu/dialog';
import { VFS } from '@gcu/vfs';
import { Machine, CPUS, cpuName, keyCode } from './machine.js';

const $ = (id) => document.getElementById(id);
const MAX_PCS = 4;
const ROM_FILES = ['STARSTER.EXE', 'MORE.COM', 'README.TXT'];   // StarStereo's own: always the published ones, never kept
const SEED_C = ['FIELD94.DAT'];                                  // a new machine's disk starts with these
const WORK_README = ['WORKSPAC.TXT', 'THE WORKSPACE - DRIVE E:\r\n\r\nE: is the same disk on every StarStereo machine on this page.\r\nA file saved here on one PC is on all of them a moment later,\r\nand it is kept in this browser between visits.\r\n'];
const TEXT = /\.(dat|csv|txt|cfg|bat|ini|log|lst|prn|asc|me|doc|sav)$/i;
const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);     // DOS text: one byte a character
const dec = (b) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
const size = (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB');
const status = (s) => { $('msg').textContent = s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a name as DOS would have it: 8.3, upper case, no spaces; and not one already there
function dosName(name, taken) {
  const dot = name.lastIndexOf('.');
  const clean = (s) => s.toUpperCase().replace(/[^A-Z0-9_\-~!#$%&]/g, '');
  let base = clean(dot > 0 ? name.slice(0, dot) : name) || 'FILE', ext = dot > 0 ? clean(name.slice(dot + 1)).slice(0, 3) : '';
  const make = (b) => b + (ext ? '.' + ext : '');
  let out = make(base.slice(0, 8));
  for (let k = 1; taken.has(out) && k < 1000; k++) { const t = '~' + k; out = make(base.slice(0, 8 - t.length) + t); }
  return out;
}

emulators.pathPrefix = new URL('emulators/', location.href).href;   // DOSBox's wasm, beside the page

// ---------------------------------------------------------------- the store: @gcu/vfs over IndexedDB
const vfs = await VFS.create({ type: 'idb', name: 'starstereo-93' });
const machines = new Map();          // id → Machine
const store = {
  rom: new Map(), WORK_README,
  async list(dir) {
    try { return (await vfs.readdir(dir, { stat: true })).filter((x) => x.type === 'file').map((x) => ({ name: x.name, size: x.size })); }
    catch { return []; }
  },
  async read(p) { const b = await vfs.readFile(p); return b instanceof Uint8Array ? b : enc(String(b)); },
  async write(p, bytes, from = null) {
    await vfs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true }).catch(() => {});
    await vfs.writeFile(p, bytes);
    if (p.startsWith('/work/')) for (const m of machines.values()) if (m !== from) await m.put('E', p.slice(6), bytes);   // E: is on every machine
    editors.reloaded(p);
    drives.refresh();
  },
  async remove(p, from = null) {
    await vfs.unlink(p).catch(() => {});
    if (p.startsWith('/work/')) for (const m of machines.values()) if (m !== from) await m.remove('E', p.slice(6));
    drives.refresh();
  },
};
async function loadRom() {
  const get = async (n) => { const r = await fetch('dos/' + n); if (!r.ok) throw new Error(`dos/${n}: ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
  for (const n of [...ROM_FILES, ...SEED_C]) store.rom.set(n, await get(n));
  for (const n of SEED_C) store.rom.delete(n), store.seed = { ...(store.seed || {}), [n]: await get(n) };
}
// a drive's files, wherever they live: [{ name, size }]
async function filesOf(m, d) {
  if (d === 'E') return store.list('/work');
  if (d === 'C') return [...[...store.rom].map(([name, b]) => ({ name, size: b.length, rom: true })), ...(await store.list(m.cPath)).filter((x) => !store.rom.has(x.name))];
  return [...m.folderFiles].map(([name, b]) => ({ name, size: b.length }));
}
// a file's place: { m (null for E:), d, name } ↔ its store path (D: has none: it lives on the machine)
const where = (m, d, name) => ({ m: d === 'E' ? null : m, d, name });
const storePath = (f) => (f.d === 'E' ? '/work/' + f.name : f.d === 'C' ? f.m.cPath + '/' + f.name : null);
const dosPath = (f) => `${f.d}:\\${f.name.replace(/\//g, '\\')}`;
const label = (f) => (f.d === 'E' ? 'E:' : `${f.m.name} ${f.d}:`) + '\\' + f.name.replace(/\//g, '\\');
async function readOf(f) {
  if (f.d === 'C' && store.rom.has(f.name)) return store.rom.get(f.name);
  if (f.d === 'D') return f.m.folderFiles.get(f.name);
  return store.read(storePath(f));
}
async function writeOf(f, bytes) {
  if (f.d === 'D') { await f.m.put('D', f.name, bytes); drives.refresh(); return; }
  await store.write(storePath(f), bytes);
  if (f.d === 'C') await f.m.put('C', f.name, bytes);
}
async function removeOf(f) {
  if (f.d === 'D') { await f.m.remove('D', f.name); drives.refresh(); return; }
  await store.remove(storePath(f));
  if (f.d === 'C') await f.m.remove('C', f.name);
}

// ---------------------------------------------------------------- the machines
let nextId = 1;
function hooksFor() {
  return {
    status,
    focus: (m) => noteFocus('pc:' + m.id),
    insert: (m, d, files) => insert(m, d, files),
    changed: (m, what) => { if (what === 'meta' || what === 'power') saveMachines(); drives.refresh(); },
  };
}
async function saveMachines() {
  await vfs.writeFile('/machines.json', JSON.stringify({ next: nextId, list: [...machines.values()].map((m) => m.meta()) }));
}
async function newMachine(meta = null, { show = true } = {}) {
  if (!meta && machines.size >= MAX_PCS) { await alert(`${MAX_PCS} PCs is all this page runs at once (each is a whole DOSBox).`, { title: 'StarStereo 93' }); return null; }
  const fresh = !meta;
  if (fresh) {
    const id = nextId++;
    meta = { id, name: 'PC ' + id, cpu: '4500' };
    for (const [n, b] of Object.entries(store.seed)) await vfs.mkdir(`/machines/${id}/C`, { recursive: true }).then(() => vfs.writeFile(`/machines/${id}/C/${n}`, b)).catch(() => {});
  }
  const m = new Machine(meta, store, hooksFor());
  machines.set(m.id, m);
  if (fresh) await saveMachines();
  if (show) layout.addPc(m);
  drives.refresh();
  return m;
}
async function closeMachine(m) {
  if (!(await confirm(`Close ${m.name}? Its C: goes with it (the workspace, E:, stays).`, { title: 'Close a PC', okLabel: 'Close it', danger: true }))) return;
  await m.stop();
  machines.delete(m.id);
  layout.close('pc:' + m.id);
  await vfs.rm(`/machines/${m.id}`, { recursive: true }).catch(() => {});
  for (const id of editors.openIds()) if (id.startsWith(`edit:${m.id}:`)) layout.close(id);
  await saveMachines();
  drives.refresh();
}
// DOS's writes come back every couple of seconds, from every running machine
setInterval(async () => { if (document.hidden) return; for (const m of machines.values()) if (m.running && m.visible) await m.sync(); }, 2000);

// ---------------------------------------------------------------- files onto a drive
async function insert(m, d, fileList) {
  const taken = new Set((await filesOf(m, d)).map((x) => x.name));
  let last = null;
  for (const file of fileList) {
    if (file.size > 16e6) { status(`${file.name}: bigger than this PC's disk would like (16 MB)`); continue; }
    const name = dosName(file.name, taken); taken.add(name);
    last = where(m, d, name);
    await writeOf(last, new Uint8Array(await file.arrayBuffer()));
    status(`${file.name} → ${label(last)}${name !== file.name.toUpperCase() ? ` (DOS calls it ${name})` : ''} — StarStereo's File › Open (F2) lists it`);
  }
  return last;
}
let pickTarget = null;
function pick(m, d) { pickTarget = [m, d]; $('pickfile').click(); }
$('pickfile').onchange = async (e) => { if (pickTarget) await insert(...pickTarget, e.target.files); e.target.value = ''; };
let mountTarget = null;
async function mount(m) {
  const r = await m.mountFolder();
  if (r === null) { mountTarget = m; $('pickdir').click(); }
}
$('pickdir').onchange = async (e) => { if (mountTarget) await mountTarget.mountFiles(e.target.files); e.target.value = ''; };
async function writeBack(m) {
  if (!m.folder) { await alert('D: on this PC isn\'t a folder this browser can write to.', { title: 'Write D: back' }); return; }
  const n = await m.writeBack();
  status(n ? `${n} file${n === 1 ? '' : 's'} written into ${m.folderName}` : `nothing on ${m.name}'s D: differs from ${m.folderName}`);
}
async function copyTo(f, target) {         // target: { m, d }
  const bytes = await readOf(f);
  const taken = new Set((await filesOf(target.m, target.d)).map((x) => x.name));
  const name = taken.has(f.name) && !(await confirm(`${f.name} is already there. Replace it?`, { title: 'Copy', okLabel: 'Replace' })) ? dosName(f.name, taken) : f.name;
  const to = where(target.m, target.d, name);
  await writeOf(to, bytes);
  status(`${label(f)} → ${label(to)}`);
  return to;
}
async function openIn(f, m) {
  let at = f;
  if (f.d !== 'E' && f.m !== m) at = await copyTo(f, { m, d: 'C' });    // another PC's disk: a copy onto this one's C: first
  layout.show('pc:' + m.id);
  status(`${m.name}: opening ${dosPath(at)}…`);
  await m.open(dosPath(at));
  status(`${m.name}: ${dosPath(at)} typed into StarStereo's File › Open — if its data had changed, it asks first`);
}
function download(name, bytes) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes])); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------- the zip (stored, no compression: DOS-era PKZIP 1.0 would recognise it)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zip(files) {                      // [[name, bytes]] → a Blob
  const parts = [], dir = []; let off = 0;
  const d = new Date(), dt = ((d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate()) << 16 | (d.getHours() << 11 | d.getMinutes() << 5 | (d.getSeconds() >> 1));
  for (const [name, b] of files) {
    const n = enc(name), crc = crc32(b), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 10, true); h.setUint32(10, dt, true); h.setUint32(14, crc, true);
    h.setUint32(18, b.length, true); h.setUint32(22, b.length, true); h.setUint16(26, n.length, true);
    parts.push(h, n, b);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 10, true); c.setUint16(6, 10, true); c.setUint32(12, dt, true); c.setUint32(16, crc, true);
    c.setUint32(20, b.length, true); c.setUint32(24, b.length, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true);
    dir.push(c, n);
    off += 30 + n.length + b.length;
  }
  const dsize = dir.reduce((a, x) => a + (x.byteLength ?? x.length), 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, dsize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...dir, e], { type: 'application/zip' });
}
async function downloadDrive(m, d) {
  const out = [];
  for (const x of await filesOf(m, d)) if (!x.rom) out.push([x.name, await readOf(where(m, d, x.name))]);
  if (!out.length) { status('nothing on that drive to download'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip(out)); a.download = d === 'E' ? 'WORKSPAC.ZIP' : `${m.name.replace(/\W+/g, '')}_${d}.ZIP`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------- the editors
const editors = (() => {
  const open = new Map();                  // tab id → { f, el, ta, clean, dirty() }
  const idOf = (f) => `edit:${f.d === 'E' ? 'E' : f.m.id}:${f.d}:${f.name}`;
  function fromId(id) {
    const [, mid, d, ...rest] = id.split(':');
    const m = mid === 'E' ? null : machines.get(+mid);
    if (mid !== 'E' && !m) return null;
    return where(m, d, rest.join(':'));
  }
  function render(id) {
    const f = fromId(id);
    const el = document.createElement('div'); el.className = 'ed';
    el.innerHTML = `<div class="strip"><span class="grow"></span><span class="pos"></span><span class="dirty" hidden>modified</span>
      <button class="b-revert" disabled>revert</button><button class="b-save" disabled title="Ctrl+S">save</button></div><textarea spellcheck="false"></textarea>`;
    const ta = el.querySelector('textarea'), q = (s) => el.querySelector(s);
    const ro = !f || (f.d === 'C' && store.rom.has(f.name));
    q('.grow').textContent = f ? label(f) + (ro ? '  (StarStereo\'s own: read only)' : '') : 'gone';
    ta.readOnly = ro;
    const e = { f, el, ta, clean: '' };
    const mark = () => { const d = ta.value !== e.clean; q('.dirty').hidden = !d; q('.b-save').disabled = !d || ro; q('.b-revert').disabled = !d; layout.title(id, (d ? '● ' : '') + (f ? f.name : '?')); };
    const pos = () => { const s = ta.value.slice(0, ta.selectionStart).split('\n'); q('.pos').textContent = `${s.length}:${s.at(-1).length + 1}`; };
    e.load = async () => { if (!f) return; try { e.clean = dec(await readOf(f)).replace(/\r\n/g, '\n'); } catch { e.clean = ''; } ta.value = e.clean; mark(); pos(); };
    e.save = async () => {
      if (ro || !f) return;
      e.clean = ta.value;
      await writeOf(f, enc(ta.value.replace(/\n/g, '\r\n')));   // DOS line ends, as its programs expect
      mark(); status(`saved ${label(f)}${f.m && f.m.running ? ' — ' + f.m.name + ' has it now' : f.d === 'E' ? ' — every PC has it now' : ''}`);
    };
    e.dirty = () => ta.value !== e.clean;
    ta.addEventListener('input', () => { mark(); pos(); });
    ta.addEventListener('keyup', pos); ta.addEventListener('click', pos);
    ta.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); e.save(); }
      if (ev.key === 'Tab' && !ev.ctrlKey) { ev.preventDefault(); ta.setRangeText('\t', ta.selectionStart, ta.selectionEnd, 'end'); mark(); }
    });
    ta.addEventListener('focus', () => { el.classList.add('focused'); noteFocus(id); });
    ta.addEventListener('blur', () => el.classList.remove('focused'));
    q('.b-save').onclick = () => e.save();
    q('.b-revert').onclick = () => e.load();
    open.set(id, e);
    e.load();
    return el;
  }
  return {
    idOf, fromId, render, openIds: () => [...open.keys()],
    get: (id) => open.get(id),
    destroy(id) { open.delete(id); },
    edit(f) { const id = idOf(f); layout.openEditor(id, f.name); setTimeout(() => open.get(id)?.ta.focus(), 50); },
    /** the store changed under an open editor: reload it, unless it has edits of its own */
    reloaded(p) { for (const e of open.values()) if (e.f && storePath(e.f) === p && !e.dirty()) e.load(); },
  };
})();

// ---------------------------------------------------------------- the drives panel
const drives = (() => {
  const el = document.createElement('div');
  el.className = 'drives'; el.tabIndex = 0;
  let rows = [], sel = -1, pending = null;
  async function draw() {
    const out = [];
    const row = (cls, html, item) => { const r = document.createElement('div'); r.className = 'row ' + cls; r.innerHTML = html; r._item = item; out.push(r); return r; };
    const grp = (text, on) => { const g = document.createElement('div'); g.className = 'grp'; g.innerHTML = `<span class="dot${on ? ' on' : ''}"></span><span></span>`; g.lastChild.textContent = text; out.push(g); };
    const files = async (m, d) => {
      const fs = (await filesOf(m, d)).sort((a, b) => a.name.localeCompare(b.name));
      if (!fs.length) row('empty', d === 'D' ? 'no folder mounted' : 'empty', { kind: 'empty', m, d });
      for (const x of fs) {
        const r = row('file', '<span class="n"></span><span class="s"></span>', { kind: 'file', f: where(m, d, x.name), rom: !!x.rom });
        r.firstChild.textContent = x.name.replace(/\//g, '\\'); r.lastChild.textContent = size(x.size);
        r.title = x.rom ? 'StarStereo\'s own file (from the page; read only)' : TEXT.test(x.name) ? 'double-click to edit' : '';
      }
    };
    grp('workspace — on every PC', true);
    row('drive', 'E: <i>workspace</i>', { kind: 'drive', m: null, d: 'E' });
    await files(null, 'E');
    for (const m of machines.values()) {
      grp(`${m.name} · ${cpuName(m.cpu)}`, m.running);
      row('drive', 'C: <i>its disk</i>', { kind: 'drive', m, d: 'C' });
      await files(m, 'C');
      const r = row('drive', 'D: <i></i>', { kind: 'drive', m, d: 'D' });
      r.querySelector('i').textContent = m.folderName ? `${m.folderName}${m.folder ? '' : ' (read only)'}` : 'a folder of yours';
      if (m.folderName) await files(m, 'D');
    }
    const keep = rows[sel]?._item;
    el.replaceChildren(...out);
    rows = out.filter((r) => r.classList.contains('row'));
    sel = keep ? rows.findIndex((r) => sameItem(r._item, keep)) : -1;
    mark();
  }
  const sameItem = (a, b) => a.kind === b.kind && (a.f ? b.f && a.f.d === b.f.d && a.f.m === b.f.m && a.f.name === b.f.name : a.m === b.m && a.d === b.d);
  const mark = () => rows.forEach((r, i) => r.classList.toggle('sel', i === sel));
  function refresh() { if (pending) return; pending = setTimeout(() => { pending = null; draw(); }, 60); }
  const rowOf = (t) => t.closest?.('.row');
  el.addEventListener('pointerdown', (e) => { const r = rowOf(e.target); if (r) { sel = rows.indexOf(r); mark(); } });
  el.addEventListener('dblclick', (e) => { const r = rowOf(e.target); if (r) activate(r._item); });
  el.addEventListener('contextmenu', async (e) => {
    const r = rowOf(e.target); if (!r) return;
    e.preventDefault(); sel = rows.indexOf(r); mark();
    const a = await showMenu(menuFor(r._item), { x: e.clientX, y: e.clientY });
    if (a) await act(a, r._item);
  });
  el.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, Math.min(rows.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1))); mark(); rows[sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter' && rows[sel]) { e.preventDefault(); activate(rows[sel]._item); }
    else if (e.key === 'Delete' && rows[sel]?._item.kind === 'file' && !rows[sel]._item.rom) { e.preventDefault(); act('del', rows[sel]._item); }
    else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && rows[sel]) {
      e.preventDefault(); const b = rows[sel].getBoundingClientRect();
      const a = await showMenu(menuFor(rows[sel]._item), { x: b.left + 30, y: b.bottom }); if (a) await act(a, rows[sel]._item);
    }
  });
  el.addEventListener('focus', () => noteFocus('drives'));
  // files dropped onto a drive row (or a file row: its drive)
  el.addEventListener('dragover', (e) => { const r = rowOf(e.target); if (r && e.dataTransfer.types.includes('Files')) { e.preventDefault(); rows.forEach((x) => x.classList.toggle('dropping', x === r)); } });
  el.addEventListener('dragleave', () => rows.forEach((x) => x.classList.remove('dropping')));
  el.addEventListener('drop', async (e) => {
    rows.forEach((x) => x.classList.remove('dropping'));
    const r = rowOf(e.target); if (!r || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const it = r._item, m = it.f ? it.f.m : it.m, d = it.f ? it.f.d : it.d;
    if (d === 'D' && !m.folderName) { status('mount a folder as D: first'); return; }
    await insert(m, d, e.dataTransfer.files);
  });

  function activate(it) {
    if (it.kind === 'file') { if (TEXT.test(it.f.name) || it.rom && /\.TXT$/i.test(it.f.name)) editors.edit(it.f); else status(`${label(it.f)} isn't text: right-click for what can be done with it`); }
    else if (it.kind === 'drive' && it.d === 'D' && it.m && !it.m.folderName) mount(it.m);
  }
  const pcs = () => [...machines.values()];
  function menuFor(it) {
    if (it.kind === 'file') {
      const f = it.f, text = TEXT.test(f.name);
      const targets = [{ label: 'the workspace (E:)', action: 'copy:E', disabled: f.d === 'E' },
        ...pcs().flatMap((m) => [{ label: `${m.name} C:`, action: `copy:C:${m.id}`, disabled: f.d === 'C' && f.m === m },
          ...(m.folderName ? [{ label: `${m.name} D: (${m.folderName})`, action: `copy:D:${m.id}`, disabled: f.d === 'D' && f.m === m }] : [])])];
      const data = /\.(dat|csv|txt)$/i.test(f.name) && !it.rom;
      return [
        { label: 'Open in StarStereo', disabled: !data || !pcs().length, children: pcs().map((m) => ({ label: `on ${m.name}${m.running ? '' : ' (powers it on)'}${f.d !== 'E' && f.m !== m ? ' — copied to its C:' : ''}`, action: 'open:' + m.id })) },
        { label: it.rom ? 'View' : 'Edit', action: 'edit', disabled: !text },
        '---',
        { label: 'Copy to', children: targets },
        { label: 'Download', action: 'download' },
        '---',
        { label: 'Rename…', action: 'rename', disabled: it.rom },
        { label: 'Delete', action: 'del', disabled: it.rom, danger: true },
      ];
    }
    const m = it.m, d = it.d;
    if (d === 'D') return [
      { label: m.folderName ? 'Mount another folder as D:…' : 'Mount a folder as D:…', action: 'mount' },
      { label: 'Write D: back into the folder', action: 'writeback', disabled: !m.folder },
      { label: 'Insert a file…', action: 'insert', disabled: !m.folderName },
      { label: 'Download D: (.zip)', action: 'zip', disabled: !m.folderName },
    ];
    return [
      { label: 'Insert a file…', action: 'insert' },
      { label: 'New text file…', action: 'newfile' },
      { label: `Download ${d}: (.zip)`, action: 'zip' },
      ...(m ? ['---', { label: `Show ${m.name}`, action: 'show' }] : []),
    ];
  }
  async function act(a, it) {
    const f = it.f, m = f ? f.m : it.m, d = f ? f.d : it.d;
    if (a.startsWith('open:')) return openIn(f, machines.get(+a.slice(5)));
    if (a.startsWith('copy:')) { const [, dd, id] = a.split(':'); return copyTo(f, { m: dd === 'E' ? null : machines.get(+id), d: dd }); }
    switch (a) {
      case 'edit': return editors.edit(f);
      case 'download': return download(f.name, await readOf(f));
      case 'rename': {
        const n = await prompt(`A new name for ${label(f)} (DOS: 8.3)`, { title: 'Rename', defaultValue: f.name });
        if (!n || n.toUpperCase() === f.name) return;
        const taken = new Set((await filesOf(m, d)).map((x) => x.name)), to = where(m, d, dosName(n, taken));
        await writeOf(to, await readOf(f)); await removeOf(f);
        return status(`${label(f)} → ${to.name}`);
      }
      case 'del':
        if (!(await confirm(`Delete ${label(f)}?${d === 'E' ? ' It goes from every PC.' : ''}`, { title: 'Delete', okLabel: 'Delete', danger: true }))) return;
        await removeOf(f); return status(`${label(f)} deleted`);
      case 'mount': return mount(m);
      case 'writeback': return writeBack(m);
      case 'insert': return pick(m, d);
      case 'zip': return downloadDrive(m, d);
      case 'show': return layout.show('pc:' + m.id);
      case 'newfile': {
        const n = await prompt('A name for the new file (DOS: 8.3)', { title: 'New text file', defaultValue: 'NEW.DAT' });
        if (!n) return;
        const taken = new Set((await filesOf(m, d)).map((x) => x.name)), to = where(m, d, dosName(n, taken));
        await writeOf(to, enc('# dip direction, dip\r\n'));
        return editors.edit(to);
      }
    }
  }
  return { el, refresh, draw };
})();

// ---------------------------------------------------------------- the layout
const layout = (() => {
  const host = $('work');
  const pcTab = (m) => ({ id: 'pc:' + m.id, title: m.name, closeable: true });
  const drivesStack = { id: 'sDrives', tabs: [{ id: 'drives', title: 'drives', closeable: false }], active: 'drives' };
  const defaultState = () => (machines.size ? { root: { id: 'root', dir: 'row', children: [
    { ...drivesStack, size: 250 },
    { id: 'sPcs', tabs: [...machines.values()].map(pcTab), active: 'pc:' + [...machines.keys()][0], flex: 1 },
  ] }, floats: [] } : { root: { ...drivesStack }, floats: [] });
  let saving = null, applying = false;
  const rails = createRails(host, {
    initialState: defaultState(),
    renderPanel(tab) {
      if (tab.id === 'drives') return drives.el;
      if (tab.id.startsWith('pc:')) { const m = machines.get(+tab.id.slice(3)); return m ? m.el : document.createElement('div'); }
      if (tab.id.startsWith('edit:')) return editors.render(tab.id);
      return document.createElement('div');
    },
    onPanelDestroy(tab) { if (tab.id.startsWith('edit:')) editors.destroy(tab.id); },
  });
  // closing a PC's tab hides it (it keeps running, paused): View › the PC brings it back. Closing it for good is Machine › Close
  rails.on('layout:change', () => { if (applying) return; clearTimeout(saving); saving = setTimeout(save, 400); });
  rails.on('tab:activate', ({ tab }) => { if (tab.id.startsWith('pc:')) setTimeout(() => machines.get(+tab.id.slice(3))?.fit(), 0); });
  const stackOf = (id) => { const hit = findTab(rails.state, id); return hit && hit.container === 'dock' ? hit.stack.id : null; };
  const anyPc = () => { for (const m of machines.values()) { const s = stackOf('pc:' + m.id); if (s) return s; } return null; };
  const anyEditor = () => { for (const id of editors.openIds()) { const s = stackOf(id); if (s) return s; } return null; };
  function addPc(m) {
    if (findTab(rails.state, 'pc:' + m.id)) { rails.activateTab('pc:' + m.id); return; }
    const s = anyPc();
    rails.addTab(pcTab(m), s ? { to: 'stack', stackId: s } : stackOf('drives') ? { to: 'split', nodeId: stackOf('drives'), side: 'right' } : undefined);
  }
  function openEditor(id, title) {
    if (findTab(rails.state, id)) { rails.activateTab(id); return; }
    const e = anyEditor(), p = anyPc();
    rails.addTab({ id, title, closeable: true }, e ? { to: 'stack', stackId: e } : p ? { to: 'split', nodeId: p, side: 'right' } : undefined);
  }
  function save() { vfs.writeFile('/layout.json', rails.serialize()).catch(() => {}); }
  // a kept arrangement: tabs whose PC or file is gone dropped, the tree mended; else the default
  function restore(str) {
    let st;
    try { st = JSON.parse(str); } catch { return false; }
    const ok = (t) => t.id === 'drives' || (t.id.startsWith('pc:') && machines.has(+t.id.slice(3))) || (t.id.startsWith('edit:') && editors.fromId(t.id));
    const stack = (s) => { const tabs = (s.tabs || []).filter(ok); if (!tabs.length) return null; return { ...s, tabs, active: tabs.some((t) => t.id === s.active) ? s.active : tabs[0].id }; };
    const node = (n) => {
      if (!n) return null;
      if (isSplit(n)) { const c = n.children.map(node).filter(Boolean); if (!c.length) return null; if (c.length === 1) { const x = c[0]; x.flex = n.flex; x.size = n.size; return x; } return { ...n, children: c }; }
      return stack(n);
    };
    const root = node(st.root), floats = (st.floats || []).map((f) => { const s = stack(f.stack); return s ? { ...f, stack: s } : null; }).filter(Boolean);
    if (!root) return false;
    applying = true;
    try { rails.deserialize(JSON.stringify({ root, floats })); } catch { return false; } finally { applying = false; }
    if (!findTab(rails.state, 'drives')) rails.addTab({ id: 'drives', title: 'drives', closeable: false });
    for (const m of machines.values()) if (!findTab(rails.state, 'pc:' + m.id)) addPc(m);
    return true;
  }
  function reset() { applying = true; try { rails.deserialize(JSON.stringify(defaultState())); } finally { applying = false; } save(); }
  return {
    rails, addPc, openEditor, restore, reset, save,
    show(id) { const m = id.startsWith('pc:') && machines.get(+id.slice(3)); if (m && !findTab(rails.state, id)) addPc(m); rails.activateTab(id); setTimeout(() => focusPane(id), 30); },
    close(id) { const hit = findTab(rails.state, id); if (hit) { hit.tab.closeable = true; rails.closeTab(id); } },
    title(id, t) { if (findTab(rails.state, id)) rails.updateTab(id, { title: t }); },
    has: (id) => !!findTab(rails.state, id),
    /** the panes, in reading order (left to right, top to bottom), the ones in front */
    panes() {
      const out = [];
      const walk = (n) => { if (!n) return; if (isSplit(n)) n.children.forEach(walk); else if (n.active) out.push(n.active); };
      walk(rails.state.root);
      for (const f of rails.state.floats || []) if (f.stack?.active) out.push(f.stack.active);
      return out;
    },
  };
})();

// ---------------------------------------------------------------- focus: which pane has the keys
let focused = null;
function noteFocus(id) {
  focused = id;
  const m = id?.startsWith('pc:') ? machines.get(+id.slice(3)) : null;
  $('focusname').textContent = id === 'drives' ? 'keys: the drives' : m ? `keys: ${m.name} (DOS)` : id?.startsWith('edit:') ? 'keys: the editor' : '';
}
function focusPane(id) {
  if (id === 'drives') drives.el.focus();
  else if (id.startsWith('pc:')) machines.get(+id.slice(3))?.focus();
  else if (id.startsWith('edit:')) editors.get(id)?.ta.focus();
}
const focusedMachine = () => (document.activeElement?.closest?.('.pc') && [...machines.values()].find((m) => m.cv === document.activeElement)) || null;
let hint = null;
function showHint() {
  const panes = layout.panes();
  hint?.remove();
  hint = document.createElement('div'); hint.className = 'hosthint';
  hint.innerHTML = panes.map((id, i) => `<span><b>${i + 1}</b> ${id === 'drives' ? 'drives' : id.startsWith('pc:') ? machines.get(+id.slice(3))?.name : editors.fromId(id)?.name || id}</span>`).join('') + '<span><b>←→</b> next</span><span><b>M</b> menus</span><span><b>N</b> new PC</span><span><b>F</b> full screen</span>';
  document.body.append(hint);
}
const hideHint = () => { hint?.remove(); hint = null; };

// keys: the host key first; then a machine with focus takes everything (before the menu bar sees Alt or F10)
let hostDown = false;
addEventListener('keydown', (e) => {
  if (e.code === 'ControlRight') { e.preventDefault(); e.stopPropagation(); if (!hostDown) { hostDown = true; focusedMachine()?.release(); showHint(); } return; }
  if (hostDown) {
    e.preventDefault(); e.stopPropagation();
    const panes = layout.panes(), cur = panes.indexOf(focused);
    if (/^Digit[1-9]$/.test(e.code)) { const id = panes[+e.code.slice(5) - 1]; if (id) focusPane(id); }
    else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') { const id = panes[(Math.max(0, cur) + (e.code === 'ArrowRight' ? 1 : panes.length - 1)) % panes.length]; if (id) focusPane(id); }
    else if (e.code === 'KeyM') { hideHint(); hostDown = false; document.activeElement?.blur?.(); bar._barActive = true; bar._focusTrigger(0); }
    else if (e.code === 'KeyN') newMachine();
    else if (e.code === 'KeyF') { const m = focusedMachine() || [...machines.values()].find((x) => layout.panes().includes('pc:' + x.id)); m?.fullscreen(); }
    showHint();
    return;
  }
  const m = focusedMachine();
  if (!m) return;
  const k = keyCode(e); if (k == null) return;
  e.preventDefault(); e.stopPropagation();
  m.key(k, true);
}, true);
addEventListener('keyup', (e) => {
  if (e.code === 'ControlRight') { e.preventDefault(); e.stopPropagation(); hostDown = false; hideHint(); return; }
  if (hostDown) { e.preventDefault(); e.stopPropagation(); return; }
  const m = focusedMachine(); if (!m) return;
  const k = keyCode(e); if (k == null) return;
  e.preventDefault(); e.stopPropagation(); m.key(k, false);
}, true);
addEventListener('blur', () => { hostDown = false; hideHint(); for (const m of machines.values()) m.release(); });

// ---------------------------------------------------------------- the menus
const activePc = () => focusedMachine() || machines.get(+(focused?.startsWith('pc:') ? focused.slice(3) : NaN)) || [...machines.values()].find((m) => layout.panes().includes('pc:' + m.id)) || [...machines.values()][0] || null;
const ABOUT = `StarStereo 93 — stereographic projection for structural geology.

It comes in two editions. This is the DOS edition, the Professional DOS Engine 3.0: for speed, on any PC with a VGA card — equal-area and equal-angle nets, great circles, Kamb and 1% contours, eigenvectors and the beta axis, all in integer arithmetic, no maths coprocessor needed. Its sibling is StarStereo 93 for Windows: a 32-bit program for Windows 3.1, by way of Win32s.

Before it, StarStereo 1.x and 2.x, for DOS. After it, a long way after, wuffle.

This page runs the DOS edition in DOSBox (js-dos's emulators, GPL-2.0). Nothing leaves your browser.`;
const look = () => document.documentElement.dataset.look || '1993';
function setLook(v) {
  document.documentElement.dataset.look = v;
  try { localStorage.setItem('starstereo-93.look', v); } catch { /* a private window: this visit only */ }
  for (const m of machines.values()) m.fit();
}
const HOST_KEYS = [['Right Ctrl', 'the host key: held, the keys below are the page\'s, not DOS\'s'], ['Right Ctrl + 1 … 9', 'the pane with that number (shown while it is held)'],
  ['Right Ctrl + ← / →', 'the next pane / the one before'], ['Right Ctrl + M', 'the page\'s menus'], ['Right Ctrl + N', 'a new PC'], ['Right Ctrl + F', 'full screen (the PC)'],
  ['click a screen', 'that PC has the keys (an orange frame)'], ['in the drives', '↑ ↓ choose, Enter edit, Del delete, Shift+F10 the menu'], ['in an editor', 'Ctrl+S saves onto the drive'],
  ['in StarStereo', 'F10 its menus, F1 its keys, F2 open, Tab the table']];
const bar = new MenuBar($('menus'), () => [
  { label: 'File', items: () => [
    { label: 'New PC', action: 'newpc', shortcut: 'RCtrl+N', disabled: machines.size >= MAX_PCS },
    '---',
    { label: 'Insert a file into the workspace (E:)…', action: 'insertE' },
    { label: 'New text file in the workspace…', action: 'newE' },
    { label: 'Download the workspace (.zip)', action: 'zipE' },
    '---',
    { label: 'Reset everything…', action: 'wipe', danger: true },
  ] },
  { label: 'Machine', items: () => { const m = activePc(); return m ? [
    { label: m.running ? `Power off ${m.name}` : `Power on ${m.name}`, action: 'power' },
    { label: 'Reset (Ctrl+Alt+Del)', action: 'reset', disabled: !m.running },
    { label: 'CPU', children: CPUS.map(([v, n]) => ({ label: (m.cpu === v ? '● ' : '   ') + n, action: 'cpu:' + v })) },
    '---',
    { label: 'Insert a file onto C:…', action: 'insertC' },
    { label: m.folderName ? 'Mount another folder as D:…' : 'Mount a folder as D:…', action: 'mount' },
    { label: 'Write D: back into the folder', action: 'writeback', disabled: !m.folder },
    '---',
    { label: 'Rename…', action: 'renamepc' },
    { label: `Close ${m.name}…`, action: 'closepc', danger: true },
  ] : [{ label: 'no PC yet: File › New PC', disabled: true }]; } },
  { label: 'View', items: () => [
    ...[...machines.values()].map((m) => ({ label: `${m.name}${m.running ? '' : ' (off)'}`, action: 'show:pc:' + m.id })),
    { label: 'The drives', action: 'show:drives' },
    '---',
    { label: 'Full screen (the PC)', action: 'full', shortcut: 'RCtrl+F', disabled: !machines.size },
    { label: 'Look', children: [['1993', '1993'], ['gcu', 'GCU (today)']].map(([v, n]) => ({ label: (look() === v ? '● ' : '   ') + n, action: 'look:' + v })) },
    { label: 'Reset the layout', action: 'resetlayout' },
  ] },
  { label: 'Help', items: () => [
    { label: 'Keys', action: 'keys' },
    { label: 'StarStereo\'s manual (README.TXT)', action: 'readme' },
    { label: 'About StarStereo 93', action: 'about' },
    '---',
    { label: 'wuffle, its descendant', action: 'wuffle' },
  ] },
]);
bar.on('action', async (a) => {
  const m = activePc();
  if (a.startsWith('show:')) return layout.show(a.slice(5));
  if (a.startsWith('cpu:')) return m?.setCpu(a.slice(4));
  if (a.startsWith('look:')) { setLook(a.slice(5)); return; }
  switch (a) {
    case 'newpc': return newMachine();
    case 'insertE': return pick(null, 'E');
    case 'newE': {
      const n = await prompt('A name for the new file (DOS: 8.3)', { title: 'New text file', defaultValue: 'NEW.DAT' }); if (!n) return;
      const to = where(null, 'E', dosName(n, new Set((await store.list('/work')).map((x) => x.name))));
      await writeOf(to, enc('# dip direction, dip\r\n')); return editors.edit(to);
    }
    case 'zipE': return downloadDrive(null, 'E');
    case 'wipe':
      if (!(await confirm('Every PC, every file on C: and E:, the arrangement — all gone from this browser, and the page starts as it did the first time. A mounted folder isn\'t touched.', { title: 'Reset everything', okLabel: 'Reset everything', danger: true }))) return;
      for (const x of machines.values()) await x.stop();
      await vfs.rm('/machines', { recursive: true }).catch(() => {}); await vfs.rm('/work', { recursive: true }).catch(() => {});
      await vfs.unlink('/machines.json').catch(() => {}); await vfs.unlink('/layout.json').catch(() => {});
      location.reload(); return;
    case 'power': return m && (m.running ? m.powerOff() : m.boot());
    case 'reset': return m?.reset();
    case 'insertC': return m && pick(m, 'C');
    case 'mount': return m && mount(m);
    case 'writeback': return m && writeBack(m);
    case 'renamepc': {
      if (!m) return;
      const n = await prompt('A name for this PC', { title: 'Rename', defaultValue: m.name });
      if (!n) return;
      m.name = n.slice(0, 24); layout.title('pc:' + m.id, m.name); await saveMachines(); drives.refresh(); return;
    }
    case 'closepc': return m && closeMachine(m);
    case 'full': return m?.fullscreen();
    case 'resetlayout': layout.reset(); return;
    case 'keys': return helpKeys();
    case 'readme': return editors.edit(where([...machines.values()][0] || null, 'C', 'README.TXT'));
    case 'about': return alert(ABOUT, { title: 'About StarStereo 93' });
    case 'wuffle': window.open('../', '_blank'); return;
  }
});
function helpKeys() {
  new Dialog({ title: 'Keys', closable: true, width: 560, render(body) {
    const t = document.createElement('table'); t.className = 'help-table';
    for (const [k, v] of HOST_KEYS) { const r = t.insertRow(); r.insertCell().textContent = k; r.insertCell().textContent = v; }
    body.append(t);
  } }).show();
}

// ---------------------------------------------------------------- start
status('loading StarStereo…');
try { await loadRom(); } catch (e) { status('could not load StarStereo\'s files: ' + e.message); throw e; }
await vfs.mkdir('/work', { recursive: true }).catch(() => {});
let first = false;
try {
  const kept = JSON.parse(await vfs.readFile('/machines.json', 'utf8'));
  nextId = kept.next || 1;
  for (const meta of kept.list || []) await newMachine(meta, { show: false });
} catch { first = true; }
if (first) {                                // the first visit: one PC, and the workspace's readme
  await vfs.writeFile('/work/' + WORK_README[0], enc(WORK_README[1]));
  await newMachine(null, { show: false });
}
let restored = false;
try { restored = layout.restore(await vfs.readFile('/layout.json', 'utf8')); } catch { /* none */ }
if (!restored) layout.reset();
await drives.draw();
const pcs = [...machines.values()];
status(first ? 'your PC is ready: power it on (the button, or Machine › Power on). Right Ctrl is the page\'s key — hold it for the panes' : `${pcs.length} PC${pcs.length === 1 ? '' : 's'} here, as you left them — off until you power them on`);
// persistent storage, asked once: the browser may otherwise clear IndexedDB under pressure
navigator.storage?.persist?.().catch(() => {});
window.__starster = { machines, vfs, store, layout, drives, editors, newMachine, insert, copyTo, openIn, where };
