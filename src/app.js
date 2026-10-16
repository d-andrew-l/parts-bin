// Parts Bin renderer. State lives here; every change goes through commit(), which saves the data file
// (via window.bin), records an undo step and re-renders.
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);

const TYPES = ['CPU', 'Motherboard', 'RAM', 'GPU', 'Storage', 'Power', 'Cooling', 'Network', 'Case', 'System', 'Dev Board', 'SBC', 'Module', 'Other'];
const BOARD_TYPES = Model.BOARD_TYPES;
const ARCHES = ['AVR', 'ARM Cortex-M0', 'ARM Cortex-M0+', 'ARM Cortex-M3', 'ARM Cortex-M4', 'ARM Cortex-M7', 'ARM Cortex-M33', 'Xtensa', 'RISC-V', 'MSP430', '8051', 'STM8', 'MIPS', 'FPGA', 'ARM64', 'x86-64'];
const SOCKETS = ['LGA1155', 'LGA1150', 'LGA1151 (100/200)', 'LGA1151 (300)', 'LGA1200', 'LGA1700', 'LGA1851', 'AM3+', 'AM4', 'AM5', 'Other'];
// type-specific fields the optimizer reads (stored under part.attrs): [key, label, kind]
const ATTRS = {
  CPU: [['socket', 'Socket', 'socket'], ['cores', 'Cores', 'num'], ['threads', 'Threads', 'num'], ['boostGHz', 'Boost clock (GHz)', 'num'], ['tdpW', 'TDP (W)', 'num'], ['score', 'Parts Bin score (auto)', 'ro']],
  Motherboard: [['socket', 'Socket', 'socket'], ['memType', 'RAM type', ['', 'DDR3', 'DDR3L', 'DDR4', 'DDR5']]],
  RAM: [['memType', 'RAM type', ['', 'DDR3', 'DDR3L', 'DDR4', 'DDR5']], ['memForm', 'Form', ['UDIMM', 'SODIMM']], ['capacityGB', 'Capacity (GB, per stick)', 'num'], ['speed', 'Speed (MT/s)', 'num']],
  Storage: [['kind', 'Kind', ['', 'NVMe SSD', 'SATA SSD', 'HDD']], ['formFactor', 'Form factor', ['', 'M.2', '2.5"', '3.5"']], ['capacityGB', 'Capacity (GB)', 'num'], ['healthPct', 'Health (%)', 'num'], ['powerOnHours', 'Power-on hours', 'num']],
  GPU: [['vramGB', 'VRAM (GB)', 'num'], ['tdpW', 'Board power (W)', 'num'], ['lengthMm', 'Length (mm)', 'num'], ['lowProfile', 'Low profile', 'bool']],
  Power: [['watts', 'Watts', 'num']],
  Cooling: [['tdpW', 'Rated for (W, CPU coolers)', 'num']],
  Network: [['linkGbps', 'Link speed (Gbps)', 'num']],
  'Dev Board': [['vendor', 'Maker', 'text'], ['mcu', 'Chip', 'text'], ['arch', 'Architecture', 'arch'], ['mhz', 'Clock (MHz)', 'num'],
    ['flashKB', 'Flash (KB)', 'num'], ['ramKB', 'RAM (KB)', 'num'], ['wireless', 'Wireless', 'text'], ['voltage', 'Logic level', ['', '3.3V', '5V', '1.8V']]],
  SBC: [['vendor', 'Maker', 'text'], ['mcu', 'SoC', 'text'], ['arch', 'Architecture', 'arch'], ['cores', 'Cores', 'num'], ['ramGB', 'RAM (GB)', 'num'],
    ['mhz', 'Clock (MHz)', 'num'], ['wireless', 'Wireless / network', 'text']],
  Module: [['vendor', 'Maker', 'text'], ['mcu', 'Main chip / sensor', 'text'], ['moduleKind', 'What it is', 'text'], ['iface', 'Interface', ['', 'I2C', 'SPI', 'UART', 'GPIO', 'Analog', 'USB', 'I2S', 'CAN']],
    ['voltage', 'Logic level', ['', '3.3V', '5V', '1.8V', '3.3V–5V']]],
};

let db = Model.empty();
let info = {};
const ui = {view: 'inventory', q: '', type: 'All', status: 'all', verdict: '', tested: '', sort: 'added', bin: ''};
try { Object.assign(ui, JSON.parse(localStorage.getItem('ui') || '{}'), {q: ''}); } catch {}
const keepUi = () => { try { localStorage.setItem('ui', JSON.stringify(ui)); } catch {} };

/* ------------------------------------------------------------ helpers */
const parts = () => db.parts.filter((p) => !p.deleted);
const buildOf = (id) => db.builds.find((b) => b.id === id);
const partOf = (id) => db.parts.find((p) => p.id === id);
const inUse = (p) => !!p.use && p.use !== 'sold';
const isSold = (p) => p.use === 'sold';
const qty = (p) => Math.max(1, +p.qty || 1);
const cur = () => db.settings.currency || '$';
const today = () => new Date().toISOString().slice(0, 10);
const useLabel = (p) => (!p.use ? 'Available' : p.use === 'other' ? 'In use' : p.use === 'sold' ? 'Sold' : `In ${buildOf(p.use)?.name || '?'}`);
const $n = (v) => (v == null || v === '' ? null : +v);
const fmt = (v) => `${cur()}${Math.round(v).toLocaleString()}`;
const money = (p) => (p.valueLow == null && p.valueHigh == null ? '' : p.valueLow === p.valueHigh || p.valueHigh == null ? fmt(p.valueLow ?? p.valueHigh) : `${fmt(p.valueLow ?? 0)}–${Math.round(p.valueHigh).toLocaleString()}`);
const mid = (p) => (((+p.valueLow || 0) + (+p.valueHigh || +p.valueLow || 0)) / 2) * qty(p);
const sumRange = (list) => [list.reduce((s, p) => s + (+p.valueLow || 0) * qty(p), 0), list.reduce((s, p) => s + (+p.valueHigh || +p.valueLow || 0) * qty(p), 0)];
const rangeText = ([lo, hi]) => `${fmt(lo)}<small>–${Math.round(hi).toLocaleString()}</small>`;
const gbText = (n) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}<small>TB</small>` : `${n}<small>GB</small>`);
const ebay = (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1`;
function months(d) {
  if (!d) return null;
  const m = new Date(d + 'T12:00:00'), n = new Date();
  let mo = (n.getFullYear() - m.getFullYear()) * 12 + (n.getMonth() - m.getMonth());
  if (n.getDate() < m.getDate()) mo--;
  return mo;
}
const ageText = (d) => { const mo = months(d); if (mo == null) return ''; const y = Math.floor(mo / 12); return (y ? `${y}y ` : '') + `${mo % 12}m`; };
const dateText = (ts) => new Date(ts).toLocaleString([], {year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
const uid = (base) => { let id = slug(base), n = 2; const taken = new Set([...db.parts, ...db.builds].map((x) => x.id)); while (taken.has(id)) id = `${slug(base)}-${n++}`; return id; };
function highlight(text, q) {
  const s = esc(text);
  if (!q) return s;
  const terms = q.split(/\s+/).filter(Boolean).map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return terms.length ? s.replace(new RegExp(`(${terms.join('|')})`, 'gi'), '<mark>$1</mark>') : s;
}
const bins = () => [...new Set(parts().map((p) => p.bin).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));

// sprites from pixel.js, shown at a whole-number scale so pixels stay square
const spr = (src, px = 48, alt = '') => `<img class="spr" src="${src}" width="${px}" height="${px}" alt="${esc(alt)}">`;
const icon = (type, px = 48) => spr(Pixel.icon(TYPES.includes(type) ? type : 'Other'), px, type);
const tag = (type) => `<span class="tag tc-${esc(String(type).replace(/\s+/g, ''))}">${esc(type)}</span>`;
const theme = () => document.documentElement.dataset.theme || 'light';
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}
const open = (id) => { const d = $(id); if (!d.open) d.showModal(); return d; };

/* ------------------------------------------------------------ persistence, undo/redo, activity log */
let lastSnap = null, saveTimer;
const undoStack = [], redoStack = [];
function log(text, buildId = '', partId = '') {
  db.log.push({ts: Date.now(), text, buildId, partId});
  if (db.log.length > 2000) db.log.splice(0, db.log.length - 2000);
}
function commit(msg, {undoable = true} = {}) {
  db.updated = Date.now();
  const snap = JSON.stringify(db);
  if (undoable && lastSnap && snap !== lastSnap) {
    undoStack.push(lastSnap);
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
  }
  lastSnap = snap;
  render();
  if (msg) toast(msg);
  persist();
}
function persist() {
  const s = $('#saved');
  s.className = 'saved busy';
  s.lastChild.textContent = 'saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const r = await window.bin.save(db);
      s.className = 'saved ok';
      s.lastChild.textContent = `saved ${new Date(r.at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
    } catch (e) {
      s.className = 'saved err';
      s.lastChild.textContent = 'save failed: ' + e.message;
    }
  }, 250);
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(lastSnap);
  lastSnap = undoStack.pop();
  db = JSON.parse(lastSnap);
  render(); persist(); toast('Undone');
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(lastSnap);
  lastSnap = redoStack.pop();
  db = JSON.parse(lastSnap);
  render(); persist(); toast('Redone');
}

// every status change goes through here so build history stays accurate
function setUse(p, use) {
  const old = p.use || '';
  if (old === use) return;
  if (buildOf(old)) log(`Removed ${p.item}`, old, p.id);
  p.use = use;
  if (use !== 'other') p.useNote = '';
  if (buildOf(use)) log(`Added ${p.item}`, use, p.id);
  if (use === 'sold') {
    p.sale = {...p.sale};
    if (!p.sale.date) p.sale.date = today();
    log(`Sold ${p.item}${p.sale.price != null ? ` for ${fmt(p.sale.price)}` : ''}`, '', p.id);
  }
}

/* ------------------------------------------------------------ inventory */
function matches(p) {
  if (ui.type !== 'All' && p.type !== ui.type) return false;
  if (ui.status === 'sold') { if (!isSold(p)) return false; }
  else if (isSold(p)) return false;
  if (ui.status === 'available' && p.use) return false;
  if (ui.status === 'inuse' && !inUse(p)) return false;
  if (ui.bin === '(none)' ? p.bin : ui.bin && p.bin !== ui.bin) return false;
  if (ui.verdict && p.verdict !== ui.verdict) return false;
  if (ui.tested === 'yes' && !p.tested) return false;
  if (ui.tested === 'no' && p.tested) return false;
  if (ui.q) {
    const hay = [p.type, p.item, p.model, p.specs, p.notes, p.bin, p.useNote, useLabel(p), p.verdict, p.purchase.from, p.sale.to, ...Object.values(p.attrs || {})].join(' ').toLowerCase();
    return ui.q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
  }
  return true;
}
const SORTS = {
  added: (a, b) => (a.added || 0) - (b.added || 0),
  type: (a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || a.item.localeCompare(b.item),
  name: (a, b) => a.item.localeCompare(b.item),
  value: (a, b) => mid(b) - mid(a),
  age: (a, b) => (months(b.mfgDate) ?? -1) - (months(a.mfgDate) ?? -1),
  bin: (a, b) => (a.bin || '￿').localeCompare(b.bin || '￿', undefined, {numeric: true}) || SORTS.type(a, b),
};
function useSelect(p) {
  const opts = [['', 'Available'], ...db.builds.map((b) => [b.id, `In ${b.name}`]), ['other', 'In use (elsewhere)'], ['sold', 'Sold']];
  return `<select class="use-sel ${isSold(p) ? 'sold' : p.use ? 'inuse' : 'avail'}" data-use="${esc(p.id)}" aria-label="Status of ${esc(p.item)}">${opts
    .map(([v, l]) => `<option value="${esc(v)}" ${(p.use || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
function badges(p) {
  const b = [];
  if (qty(p) > 1) b.push(`<span class="badge">×${qty(p)}</span>`);
  if (p.photos.length) b.push(`<span class="badge">${p.photos.length} photo${p.photos.length > 1 ? 's' : ''}</span>`);
  const w = p.purchase.warrantyUntil;
  if (w) b.push(`<span class="badge ${w < today() ? 'dim' : 'ok'}">${w < today() ? 'warranty ended' : `warranty to ${w}`}</span>`);
  if (p.type === 'Storage' && (p.attrs.healthPct != null || p.attrs.powerOnHours != null)) b.push(`<span class="badge ${p.attrs.healthPct != null && p.attrs.healthPct < 80 ? 'warn' : ''}">${[p.attrs.healthPct != null && `health ${p.attrs.healthPct}%`, p.attrs.powerOnHours != null && `${(+p.attrs.powerOnHours).toLocaleString()} h`].filter(Boolean).join(' · ')}</span>`);
  const t = p.tests.at(-1);
  if (t) b.push(`<span class="badge ${t.result === 'pass' ? 'ok' : 'warn'}">${t.result === 'pass' ? 'passed' : 'failed'} ${esc(t.date)}</span>`);
  return b.length ? `<div class="badges">${b.join('')}</div>` : '';
}

function renderInventory() {
  const all = parts();
  const live = all.filter((p) => !isSold(p));
  const avail = live.filter((p) => !p.use);
  const sold = all.filter(isSold);
  const units = (l) => l.reduce((s, p) => s + qty(p), 0);
  const spent = all.reduce((s, p) => s + (+p.purchase.price || 0) * qty(p), 0);
  const revenue = sold.reduce((s, p) => s + (+p.sale.price || 0), 0);
  const soldCost = sold.reduce((s, p) => s + (+p.purchase.price || 0) * qty(p), 0);
  const profit = revenue - soldCost;
  $('#invTiles').innerHTML = [
    ['logo', 'Parts', units(live), `${live.length} entries · ${TYPES.filter((t) => live.some((p) => p.type === t)).length} types`],
    ['Case', 'Available', units(avail), `about ${fmt(avail.reduce((s, p) => s + mid(p), 0))} on the shelf`],
    ['System', 'In use', units(live) - units(avail), db.builds.map((b) => `${b.name} ${units(all.filter((p) => p.use === b.id))}`).join(' · ') || 'no builds yet'],
    ['search', 'Untested', units(live.filter((p) => !p.tested)), 'not yet verified working', live.some((p) => !p.tested && !p.use)],
    ['coin', 'Est. value', `~${fmt(live.reduce((s, p) => s + mid(p), 0))}`, `range ${rangeText(sumRange(live)).replace(/<[^>]+>/g, '')}, used-market`],
    ['tag', 'Flips', `${profit < 0 ? '-' : ''}${fmt(Math.abs(profit))}`, `${sold.length} sold for ${fmt(revenue)} · ${fmt(spent)} spent in total`, profit < 0],
  ].map(([ic, k, n, s, alert]) => `<div class="tile ${alert ? 'alert' : ''}">${spr(Pixel.icon(ic), 48)}<div><div class="k">${k}</div><div class="n">${n}</div><div class="s">${s}</div></div></div>`).join('');

  const counts = Object.fromEntries(TYPES.map((t) => [t, live.filter((p) => p.type === t).length]));
  $('#fType').innerHTML = ['All', ...TYPES.filter((t) => counts[t] || ui.type === t)].map((t) =>
    `<button class="chip" data-type="${t}" aria-pressed="${ui.type === t}">${spr(Pixel.icon(t === 'All' ? 'logo' : t), 24)}${t}<b>${t === 'All' ? live.length : counts[t]}</b></button>`).join('');
  $$('#fStatus button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === ui.status));
  const bl = bins();
  if (ui.bin && ui.bin !== '(none)' && !bl.includes(ui.bin)) ui.bin = '';
  $('#fBin').innerHTML = `<option value="">All locations</option>${bl.map((b) => `<option ${ui.bin === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}<option value="(none)" ${ui.bin === '(none)' ? 'selected' : ''}>No location set</option>`;
  $('#binList').innerHTML = bl.map((b) => `<option value="${esc(b)}">`).join('');
  $('#fVerdict').value = ui.verdict;
  $('#fTested').value = ui.tested;
  $('#fSort').value = ui.sort;

  const list = all.filter(matches).sort(SORTS[ui.sort] || SORTS.added);
  const q = ui.q;
  $('#invRows').innerHTML = list.length ? list.map((p) => `<tr data-id="${esc(p.id)}" tabindex="0">
      <td class="ic">${icon(p.type)}</td>
      <td>${tag(p.type)}<div class="pname">${highlight(p.item, q)}</div>
        ${p.model ? `<div class="pmodel">${highlight(p.model, q)}</div>` : ''}${p.specs ? `<div class="pspecs">${highlight(p.specs, q)}</div>` : ''}${badges(p)}</td>
      <td>${useSelect(p)}${p.use === 'other' && p.useNote ? `<span class="loc">${highlight(p.useNote, q)}</span>` : ''}${isSold(p) && p.sale.price != null ? `<span class="loc">for ${fmt(p.sale.price)}${p.sale.date ? ` · ${esc(p.sale.date)}` : ''}</span>` : ''}${p.bin ? `<span class="loc bin">${highlight(p.bin, q)}</span>` : ''}</td>
      <td><span class="pill ${esc(p.verdict)}">${esc(p.verdict || '')}</span></td>
      <td class="num">${ageText(p.mfgDate)}</td>
      <td class="num">${money(p)}${qty(p) > 1 ? `<span class="loc">each</span>` : ''}</td>
      <td><label class="tested"><input type="checkbox" data-tested="${esc(p.id)}" ${p.tested ? 'checked' : ''}> ${p.tested ? 'Yes' : 'No'}</label></td>
      <td class="notes">${highlight(p.notes, q)}</td></tr>`).join('')
    : `<tr><td colspan="8" class="empty">${spr(Pixel.icon('search'), 72)}${all.length ? 'No parts match these filters.' : 'No parts yet. Use “+ Add part”, or scan a PC on the Builds tab.'}</td></tr>`;
  $('#invFoot').textContent = `Showing ${list.length} of ${all.length}. Ages count from the manufacture date on each part's label; values are rough used-market estimates (each, for multiples). Click a row to edit.`;
}

/* ------------------------------------------------------------ builds */
function platLine(b) {
  const p = b.platform || {};
  const v = (x, label, f = (y) => y) => (x == null || x === '' ? `<span class="missing">${label} ?</span>` : `<span>${label} <b>${esc(f(x))}</b></span>`);
  return [v(p.socket, 'Socket'), v(p.memType, 'RAM', (t) => `${t} ${p.memForm || ''}`.trim()), v(p.ramSlots, 'Slots'), v(p.maxRamGB, 'Max', (n) => `${n}GB`),
    v(p.m2Slots, 'M.2'), v(p.sataPorts, 'SATA'), v(p.pcieFree, 'Free PCIe'), p.lowProfileOnly ? '<span><b>Low-profile only</b></span>' : ''].join('');
}
function renderBuilds() {
  $('#builds').innerHTML = db.builds.map((b) => {
    const bp = parts().filter((p) => p.use === b.id).sort(SORTS.type);
    const cpu = bp.find((p) => p.type === 'CPU');
    const ram = bp.filter((p) => p.type === 'RAM');
    const sticks = ram.reduce((s, p) => s + qty(p), 0);
    const ramGB = ram.reduce((s, p) => s + qty(p) * (+p.attrs?.capacityGB || 0), 0);
    const disk = bp.filter((p) => p.type === 'Storage');
    const diskGB = disk.reduce((s, p) => s + qty(p) * (+p.attrs?.capacityGB || 0), 0);
    const nSugg = Optimizer.suggest(b, db.parts).filter((s) => s.action && s.action !== 'buy').length;
    const slots = b.platform?.ramSlots;
    const watts = bp.find((p) => p.type === 'Power')?.attrs?.watts || b.platform?.psuW;
    const draw = Optimizer.powerEstimate(bp);
    const tileOf = (ic, k, n, s, cls = '') => `<div class="tile ${cls}">${spr(Pixel.icon(ic), 48)}<div><div class="k">${k}</div><div class="n">${n}</div><div class="s">${s}</div></div></div>`;
    return `<article class="build" data-build="${esc(b.id)}">
      <div class="hero"><img src="${Pixel.hero(b, theme())}" alt="">
        <div class="acts"><button class="btn" data-edit-build="${esc(b.id)}">Edit</button><button class="btn primary" data-add-to="${esc(b.id)}">+ Add part</button><button class="btn" data-history="${esc(b.id)}">History</button></div>
        <div class="plate"><h3>${esc(b.name)}</h3>${(() => { const w = Pixel.world(b); return w.named && w.what !== 'planet' ? `<span class="world">${esc(w.what)}</span>` : ''; })()}<span class="meta">${esc([b.ip, b.os].filter(Boolean).join(' · '))}</span></div>
      </div>
      ${b.role ? `<div class="brole">${esc(b.role)}</div>` : ''}
      ${b.kind === 'project' ? (() => {
        const brd = bp.filter((p) => p.type === 'Dev Board' || p.type === 'SBC'), mods = bp.filter((p) => p.type === 'Module');
        const n = (l) => l.reduce((s, p) => s + qty(p), 0);
        return `<div class="plat"><span><b>Electronics project</b></span></div><div class="tiles">
          ${tileOf('Dev Board', 'Boards', n(brd), esc(brd.map((p) => p.item).slice(0, 2).join(' · ') || 'none yet'))}
          ${tileOf('Module', 'Modules', n(mods), esc(mods.map((p) => p.item).slice(0, 2).join(' · ') || 'sensors, shields, displays'))}
          ${tileOf('Other', 'Other parts', n(bp) - n(brd) - n(mods), 'cables, power, cases')}
          ${tileOf('coin', 'Value', rangeText(sumRange(bp)), `${bp.length} parts`)}
        </div>`;
      })() : `<div class="plat">${platLine(b)}</div>
      <div class="tiles">
        ${tileOf('CPU', 'CPU', cpu?.attrs?.threads ? `${cpu.attrs.cores || '?'}<small>C</small> ${cpu.attrs.threads}<small>T</small>` : '–', `${esc(cpu?.item || 'none recorded')}${cpu?.attrs?.score ? ` · score ${cpu.attrs.score.toLocaleString()}` : ''}`)}
        ${tileOf('RAM', 'Memory', ramGB ? gbText(ramGB) : '–', `${sticks} stick${sticks === 1 ? '' : 's'}${slots ? ` of ${slots} slots` : ''}${sticks >= 2 && sticks % 2 === 0 ? ' · dual channel' : sticks === 1 ? ' · single channel' : ''}`)}
        ${tileOf('Storage', 'Storage', diskGB ? gbText(diskGB) : '–', `${disk.reduce((s, p) => s + qty(p), 0)} drive${disk.length === 1 && qty(disk[0]) === 1 ? '' : 's'}${disk.some((d) => /SSD/.test(d.attrs?.kind || '')) ? '' : disk.length ? ' · no SSD' : ''}`)}
        ${tileOf('coin', 'Value', rangeText(sumRange(bp)), `${bp.length} parts`)}
        ${tileOf('Power', 'Power', `~${draw}<small>W</small>`, watts ? `peak estimate on a ${watts} W supply (${Math.round((draw / watts) * 100)}%)` : 'peak estimate; add the PSU to check headroom', `wide ${watts && draw > watts * 0.8 ? 'alert' : ''}`)}
      </div>`}
      <table class="grid"><thead><tr><th><span class="sr">Icon</span></th><th>Part</th><th>Specs</th><th class="num">Value</th><th><span class="sr">Actions</span></th></tr></thead><tbody>
      ${bp.length ? bp.map((p) => `<tr>
          <td class="ic">${icon(p.type)}</td>
          <td>${tag(p.type)}<div class="pname">${esc(p.item)}${qty(p) > 1 ? ` <span class="badge">×${qty(p)}</span>` : ''}</div>${p.model ? `<div class="pmodel">${esc(p.model)}</div>` : ''}</td>
          <td class="pspecs">${esc(p.specs)}</td><td class="num">${money(p)}</td>
          <td class="num"><button class="btn small" data-edit-part="${esc(p.id)}">Edit</button> <button class="btn small" data-pull="${esc(p.id)}" title="Take out of this build and put it back on the shelf">Remove</button></td></tr>`).join('')
        : `<tr><td colspan="5" class="empty">No parts recorded for ${esc(b.name)} yet. Use “+ Add part”, or “Scan this PC” / “Paste a hardware report” above.</td></tr>`}
      </tbody></table>
      ${nSugg ? `<div class="bopt">${spr(Pixel.icon('rocket'), 36)}<span>${nSugg} upgrade${nSugg > 1 ? 's' : ''} possible from your spares</span><button class="btn small" data-goto="optimizer">See optimizer</button></div>` : ''}
      ${b.notes ? `<div class="bnotes">${esc(b.notes)}</div>` : ''}
    </article>`;
  }).join('') + `<button class="addbuild" id="addBuild"><span>${spr(Pixel.planet({id: 'new-build'}, 64), 128)}+ Add build</span></button>`;
}

/* ------------------------------------------------------------ optimizer */
function renderOptimizer() {
  let total = 0;
  const blocks = db.builds.filter((b) => b.kind !== 'project').map((b) => {
    const list = Optimizer.suggest(b, db.parts);
    total += list.filter((s) => s.action && s.action !== 'buy').length;
    const row = (s, i) => `<div class="sugg ${s.action === 'buy' ? 'buy' : ''}">
        ${s.partId ? icon(partOf(s.partId)?.type, 48) : spr(Pixel.icon(s.action === 'buy' ? 'coin' : 'search'), 48)}
        <div><h4><span class="pill ${s.priority}">${s.priority === 'info' ? 'needs info' : s.priority === 'buy' ? 'worth buying' : s.priority}</span>${esc(s.title)}</h4><p>${esc(s.reason)}</p>${s.caveats?.length ? `<ul>${s.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}</div>
        ${s.action === 'buy' ? `<button class="btn" data-link="${esc(ebay(s.query))}">Check prices ↗</button>` : s.action ? `<button class="btn go" data-apply="${esc(b.id)}:${i}">Apply</button>` : `<button class="btn" data-edit-build="${esc(b.id)}">Edit build</button>`}
      </div>`;
    const rows = list.length ? list.map(row).join('') : `<div class="sugg none">${spr(Pixel.icon('logo'), 48)}<span>Nothing in the spares would make ${esc(b.name)} objectively better right now.</span></div>`;
    return `<section class="optbuild"><h3>${spr(Pixel.planet(b, 48), 96)}${esc(b.name)} <span>${esc(b.role || '')}</span></h3>${rows}</section>`;
  });
  const orph = Optimizer.orphans(db.builds, db.parts);
  const orphBlock = orph.length ? `<section class="optbuild"><h3>${spr(Pixel.icon('Other'), 48)}Fits no build <span>candidates to sell or give away</span></h3>${orph.map((p) =>
    `<div class="sugg">${icon(p.type)}<div><h4><span class="pill info">spare</span>${esc(p.item)}${qty(p) > 1 ? ` (×${qty(p)})` : ''}</h4><p>${esc(p.specs || p.type)}. Doesn't match any build's ${p.type === 'RAM' ? 'RAM type' : 'socket'}.</p></div><span class="row-acts"><button class="btn" data-link="${esc(ebay(p.item))}">Prices ↗</button><button class="btn" data-edit-part="${esc(p.id)}">Edit</button></span></div>`).join('')}</section>` : '';
  $('#optimizer').innerHTML = (db.builds.length ? blocks.join('') : `<div class="panel empty">${spr(Pixel.planet({id: 'new-build'}, 64), 128)}Add a build (or scan this PC on the Builds tab) and the optimizer will check it against your spares.</div>`) + orphBlock;
  $('#optCount').textContent = total || '';
}
function applySuggestion(buildId, idx) {
  const b = buildOf(buildId);
  const s = Optimizer.suggest(b, db.parts)[idx];
  if (!s?.action || s.action === 'buy') return;
  const part = partOf(s.partId);
  if (s.replaceId) setUse(partOf(s.replaceId), '');
  setUse(part, buildId);
  commit(`${part.item} → ${b.name}${s.replaceId ? `, ${partOf(s.replaceId).item} back on the shelf` : ''}`);
}

/* ------------------------------------------------------------ part editor */
const partDlg = $('#partDlg'), partForm = $('#partForm');
let draft = null, editingPart = null, newPhotos = [];
function fillUseOptions(sel, val) {
  sel.innerHTML = [['', 'Available'], ...db.builds.map((b) => [b.id, `In ${b.name}`]), ['other', 'In use (elsewhere)'], ['sold', 'Sold']]
    .map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = val || '';
}
function renderAttrFields(type, attrs = {}) {
  const fields = ATTRS[type] || [];
  $('#pAttrs').hidden = !fields.length;
  $('#pAttrGrid').innerHTML = fields.map(([k, label, kind]) => {
    const v = attrs[k] ?? '';
    if (kind === 'num') return `<label>${label}<input type="number" min="0" step="any" data-attr="${k}" value="${esc(v)}"></label>`;
    if (kind === 'text') return `<label>${label}<input type="text" data-attr="${k}" value="${esc(v)}"></label>`;
    if (kind === 'arch') return `<label>${label}<input type="text" data-attr="${k}" value="${esc(v)}" list="archList"></label>`;
    if (kind === 'ro') return `<label>${label}<input type="text" readonly value="${esc(v === '' ? 'from cores, threads, boost' : (+v).toLocaleString())}" tabindex="-1"></label>`;
    if (kind === 'bool') return `<label>${label}<select data-attr="${k}" data-bool="1"><option value="">Unknown</option><option value="yes" ${v === true ? 'selected' : ''}>Yes</option><option value="no" ${v === false ? 'selected' : ''}>No</option></select></label>`;
    const opts = kind === 'socket' ? ['', ...SOCKETS] : kind;
    return `<label>${label}<select data-attr="${k}">${opts.map((o) => `<option value="${esc(o)}" ${String(v) === o ? 'selected' : ''}>${esc(o || 'Unknown')}</option>`).join('')}</select></label>`;
  }).join('');
}
function collectAttrs() {
  const a = {...(draft?.attrs || {})};
  for (const el of $$('[data-attr]', partDlg)) {
    const k = el.dataset.attr;
    if (el.value === '') { delete a[k]; continue; }
    a[k] = el.dataset.bool ? el.value === 'yes' : el.type === 'number' ? +el.value : el.value;
  }
  return a;
}
// name suggestions follow the part type: CPUs, GPUs, or the board list (built in + the user's own boards of that type)
let namesFor = '';
function fillNames(type) {
  if (namesFor === type) return;
  namesFor = type;
  const list = type === 'CPU' ? PartsDB.cpus : type === 'GPU' ? PartsDB.gpus
    : BOARD_TYPES.includes(type) ? PartsDB.boards.filter((b) => (b.custom ? (b.type || 'Dev Board') === type : type === 'Dev Board')) : [];
  $('#dbNames').innerHTML = list.map((x) => `<option value="${esc(x.name)}">${esc(x.custom ? 'my board' : x.mcu || '')}</option>`).join('');
  partForm.elements.itemName.placeholder = type === 'Dev Board' ? 'e.g. TI LaunchPad MSP-EXP430F5529LP, Arduino Uno, ESP32 Dev Module'
    : type === 'SBC' ? 'e.g. Raspberry Pi 5 8GB' : type === 'Module' ? 'e.g. BME280 sensor breakout' : 'e.g. Intel Core i5-9500';
}
function showDbHit() {
  const type = partForm.elements.type.value, name = partForm.elements.itemName.value.trim();
  fillNames(type);
  const board = BOARD_TYPES.includes(type);
  const hit = type === 'CPU' ? PartsDB.findCPU(name) : type === 'GPU' ? PartsDB.findGPU(name) : board ? PartsDB.findBoard(name) : null;
  const el = $('#dbHit');
  el.hidden = !hit && !(board && name);
  el.classList.toggle('miss', !hit);
  if (hit && board) el.innerHTML = `✓ ${hit.custom ? 'In your board list' : 'In the board list'}: <b>${esc(hit.name)}</b>${PartsDB.boardSpec(hit) ? `, ${esc(PartsDB.boardSpec(hit))}` : ''}. Details fill in when you save.`
    + (hit.custom ? ` <button type="button" class="btn small" id="saveBoard">Update my board</button>` : '');
  else if (hit) el.innerHTML = `✓ In the parts database: <b>${esc(hit.name)}</b>, ${esc(type === 'CPU' ? PartsDB.specLine(hit) : `${hit.vramGB}GB, ${hit.tdpW} W, ${hit.power} power`)}. Specs fill in when you save.`;
  else if (board && name) el.innerHTML = `Not in the board list. Fill in the details below, then <button type="button" class="btn small primary" id="saveBoard">Not here? Add it to my boards</button> so it's suggested next time.`;
}
// "Not here?": the name + details typed in this part become one of the user's own boards
$('#dbHit').addEventListener('click', (e) => {
  if (!e.target.closest('#saveBoard')) return;
  const name = partForm.elements.itemName.value.trim();
  const type = partForm.elements.type.value;
  if (!name) return;
  const a = collectAttrs();
  const entry = {name, type, vendor: a.vendor || '', mcu: a.mcu || '', arch: a.arch || '', mhz: a.mhz ?? null, flashKB: a.flashKB ?? null, ramKB: a.ramKB ?? null,
    ramGB: a.ramGB ?? null, cores: a.cores ?? null, wireless: a.wireless || '', voltage: a.voltage || '', moduleKind: a.moduleKind || '', iface: a.iface || '', added: Date.now()};
  const i = db.customBoards.findIndex((b) => b.name.toLowerCase() === name.toLowerCase());
  if (i >= 0) db.customBoards[i] = {...db.customBoards[i], ...entry}; else db.customBoards.push(entry);
  PartsDB.setCustomBoards(db.customBoards);
  namesFor = '';
  showDbHit();
  commit(`${name} ${i >= 0 ? 'updated in' : 'added to'} your boards`);
});
function renderPhotos() {
  $('#pPhotos').innerHTML = draft.photos.length ? draft.photos.map((f) => `<figure><button type="button" class="ph" data-photo-open="${esc(f)}" title="Open full size"><img src="pbin://photo/${encodeURIComponent(f)}" alt="Photo of ${esc(draft.item)}"></button><button type="button" class="x small" data-photo-del="${esc(f)}" aria-label="Remove photo">✕</button></figure>`).join('')
    : '<p class="sub">No photos yet. A shot of the label (model, serial, date code) is the most useful.</p>';
}
function renderTests() {
  $('#pTests').innerHTML = draft.tests.length ? draft.tests.map((t, i) => `<li><span class="pill ${t.result === 'pass' ? 'Keep' : 'Sell'}">${t.result === 'pass' ? 'passed' : 'failed'}</span> <b>${esc(t.date)}</b> ${esc(t.note)} <button type="button" class="x small" data-test-del="${i}" aria-label="Remove test entry">✕</button></li>`).join('')
    : '<li class="sub">No tests logged.</li>';
}
function openPart(p, preset = {}) {
  editingPart = p ? p.id : null;
  newPhotos = [];
  draft = structuredClone(p || Model.normalizePart({type: 'Other', verdict: 'Spare', ...preset}));
  $('#partTitle').textContent = p ? 'Edit part' : 'New part';
  $('#pType').innerHTML = TYPES.map((t) => `<option>${t}</option>`).join('');
  fillUseOptions($('#pUse'), draft.use);
  const f = partForm.elements;
  f.itemName.value = draft.item || '';
  for (const k of ['type', 'model', 'specs', 'qty', 'bin', 'mfgDate', 'verdict', 'useNote', 'valueLow', 'valueHigh', 'notes']) f[k].value = draft[k] ?? '';
  f.tested.checked = !!draft.tested;
  f.paid.value = draft.purchase.price ?? ''; f.boughtOn.value = draft.purchase.date || ''; f.boughtFrom.value = draft.purchase.from || ''; f.warrantyUntil.value = draft.purchase.warrantyUntil || '';
  f.soldFor.value = draft.sale.price ?? ''; f.soldOn.value = draft.sale.date || ''; f.soldTo.value = draft.sale.to || '';
  renderAttrFields(draft.type, draft.attrs);
  renderPhotos(); renderTests(); showDbHit();
  $('#tDate').value = today(); $('#tNote').value = '';
  $('#partIcon').src = Pixel.icon(draft.type);
  $('#pLocWrap').hidden = draft.use !== 'other';
  $('#pDelete').hidden = $('#pDup').hidden = $('#pLabel').hidden = !p;
  open('#partDlg');
  f.itemName.focus();
}
$('#pType').addEventListener('change', (e) => { draft.attrs = collectAttrs(); renderAttrFields(e.target.value, draft.attrs); $('#partIcon').src = Pixel.icon(e.target.value); showDbHit(); });
partForm.elements.itemName.addEventListener('input', showDbHit);
// picking a board from the list fills its details straight away (anything already typed is kept)
partForm.elements.itemName.addEventListener('change', () => {
  const type = partForm.elements.type.value;
  if (!BOARD_TYPES.includes(type)) return;
  const hit = PartsDB.findBoard(partForm.elements.itemName.value);
  if (!hit) return;
  draft.attrs = PartsDB.boardAttrs(hit, collectAttrs());
  renderAttrFields(type, draft.attrs);
  if (!partForm.elements.specs.value) partForm.elements.specs.value = PartsDB.boardSpec(hit);
});
$('#pUse').addEventListener('change', (e) => {
  $('#pLocWrap').hidden = e.target.value !== 'other';
  if (e.target.value === 'sold' && !partForm.elements.soldOn.value) partForm.elements.soldOn.value = today();
});
$('#ebayBtn').addEventListener('click', () => window.bin.openLink(ebay(partForm.elements.itemName.value || draft.item)));
$('#addPhotos').addEventListener('click', async () => {
  const added = await window.bin.addPhotos(editingPart || slug(partForm.elements.itemName.value || 'part'));
  draft.photos.push(...added); newPhotos.push(...added);
  renderPhotos();
});
$('#pPhotos').addEventListener('click', (e) => {
  const o = e.target.closest('[data-photo-open]'), d = e.target.closest('[data-photo-del]');
  if (o) window.bin.openPhoto(o.dataset.photoOpen);
  if (d) { draft.photos = draft.photos.filter((x) => x !== d.dataset.photoDel); renderPhotos(); }
});
$('#tAdd').addEventListener('click', () => {
  const result = $('#tResult').value;
  draft.tests.push({date: $('#tDate').value || today(), result, note: $('#tNote').value.trim()});
  partForm.elements.tested.checked = result === 'pass';
  $('#tNote').value = '';
  renderTests();
});
$('#pTests').addEventListener('click', (e) => { const d = e.target.closest('[data-test-del]'); if (d) { draft.tests.splice(+d.dataset.testDel, 1); renderTests(); } });
partDlg.addEventListener('close', () => {
  // photos copied in during an edit that was cancelled
  if (partDlg.returnValue !== 'saved' && newPhotos.length) window.bin.deletePhotos(newPhotos);
  newPhotos = [];
  partDlg.returnValue = '';
});
partForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = partForm.elements;
  if (!f.itemName.value.trim()) return;
  const data = {
    ...draft, type: f.type.value, item: f.itemName.value.trim(), model: f.model.value.trim(), specs: f.specs.value.trim(), qty: +f.qty.value || 1, bin: f.bin.value.trim(),
    mfgDate: f.mfgDate.value, valueLow: $n(f.valueLow.value), valueHigh: $n(f.valueHigh.value), verdict: f.verdict.value, tested: f.tested.checked,
    useNote: f.use.value === 'other' ? f.useNote.value.trim() : '', notes: f.notes.value.trim(), attrs: collectAttrs(),
    purchase: {price: $n(f.paid.value), date: f.boughtOn.value, from: f.boughtFrom.value.trim(), warrantyUntil: f.warrantyUntil.value},
    sale: {price: $n(f.soldFor.value), date: f.soldOn.value, to: f.soldTo.value.trim()},
  };
  // a type change makes the old type's details meaningless
  if (draft.type !== data.type) data.attrs = Object.fromEntries(Object.entries(data.attrs).filter(([k]) => (ATTRS[data.type] || []).some(([a]) => a === k)));
  const removedPhotos = (partOf(editingPart)?.photos || []).filter((x) => !data.photos.includes(x));
  const norm = Model.normalizePart(data);
  let p;
  if (editingPart) {
    p = partOf(editingPart);
    const use = f.use.value;
    Object.assign(p, {...norm, use: p.use});
    setUse(p, use);
  } else {
    p = {...norm, id: uid(`${data.type}-${data.item}`), added: Date.now(), use: ''};
    db.parts.push(p);
    setUse(p, f.use.value);
    if (!buildOf(p.use)) log(`Added ${p.item} to the inventory`, '', p.id);
  }
  if (removedPhotos.length) window.bin.deletePhotos(removedPhotos);
  partDlg.returnValue = 'saved';
  partDlg.close('saved');
  commit(editingPart ? 'Part saved' : `Added ${data.item}`);
});
$('#pDelete').addEventListener('click', () => {
  const p = partOf(editingPart);
  if (!p) return;
  if (buildOf(p.use)) log(`Removed ${p.item} (moved to trash)`, p.use, p.id);
  p.deleted = Date.now();
  partDlg.close();
  commit(`${p.item} moved to the trash (Ctrl+Z to undo)`);
});
$('#pDup').addEventListener('click', () => {
  const p = partOf(editingPart);
  partDlg.close();
  openPart(null, {...structuredClone(p), id: undefined, use: '', useNote: '', photos: [], tests: [], sale: {}});
});
$('#pLabel').addEventListener('click', () => { const p = partOf(editingPart); partDlg.close(); openLabels({part: p}); });

/* ------------------------------------------------------------ build editor */
const buildDlg = $('#buildDlg'), buildForm = $('#buildForm');
let editingBuild = null;
function openBuild(b) {
  editingBuild = b ? b.id : null;
  $('#buildTitle').textContent = b ? `Edit ${b.name}` : 'New build';
  $('#buildIcon').src = Pixel.planet(b || {id: 'new-build'}, 40);
  $('#bSocket').innerHTML = ['', ...SOCKETS].map((s) => `<option value="${esc(s)}">${esc(s || 'Unknown')}</option>`).join('');
  const d = b || {name: '', role: '', ip: '', os: '', notes: '', platform: {memForm: 'UDIMM'}};
  const flat = {...d, ...(d.platform || {})};
  for (const el of buildForm.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!flat[el.name];
    else el.value = flat[el.name] ?? (el.name === 'memForm' ? 'UDIMM' : el.name === 'kind' ? 'computer' : '');
  }
  showKind();
  $('#bDelete').hidden = !b;
  // planet / moon picker: the name decides the world; suggest worlds no other build uses yet
  const used = new Set(db.builds.filter((x) => x !== b).map((x) => Pixel.kind(x)));
  const free = Pixel.worlds.filter((w) => !used.has(w.key));
  $('#worldList').innerHTML = free.map((w) => `<option value="${esc(w.name)}">${esc(w.what)}</option>`).join('');
  const day = Math.floor(Date.now() / 864e5);
  const ideas = free.map((w, i) => [w, Math.sin(i * 12.9898 + day) * 43758.5453 % 1]).sort((x, y) => x[1] - y[1]).slice(0, 10).map(([w]) => w);
  $('#bIdeas').innerHTML = ideas.map((w) => `<button type="button" class="chip" data-world="${esc(w.name)}">${spr(Pixel.planet({id: w.key}, 24), 24)}${esc(w.name)}<b>${esc(w.what)}</b></button>`).join('');
  showWorld();
  open('#buildDlg');
  buildForm.elements.name.focus();
}
function showWorld() {
  const name = buildForm.elements.name.value.trim();
  const b = {id: name ? slug(name) : 'new-build', name};
  const w = Pixel.world(b);
  $('#bWorldImg').src = Pixel.planet(b, 48);
  $('#buildIcon').src = Pixel.planet(b, 40);
  $('#bWorld').innerHTML = !name ? 'Type a name to see its world.'
    : w.named ? `<b>${esc(name)}</b> gets ${esc(w.name)}'s look (${esc(w.what)}).`
    : `<b>${esc(name)}</b> isn't a planet or moon, so it gets a ${esc(w.name)}-style planet. Pick a name below to choose one.`;
}
buildForm.elements.name.addEventListener('input', showWorld);
// projects (a weather station, a robot) hold boards and modules and have no PC platform
function showKind() {
  const project = $('#bKind').value === 'project';
  $('#bPlatform').hidden = project;
  buildForm.elements.role.placeholder = project ? 'e.g. Garden soil-moisture sensor' : 'e.g. NAS / Jellyfin media server';
}
$('#bKind').addEventListener('change', showKind);
$('#bIdeas').addEventListener('click', (e) => {
  const c = e.target.closest('[data-world]');
  if (!c) return;
  buildForm.elements.name.value = c.dataset.world;
  showWorld();
});
buildForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = buildForm.elements;
  const data = {
    name: f.name.value.trim(), kind: f.kind.value, role: f.role.value.trim(), ip: f.ip.value.trim(), os: f.os.value.trim(), notes: f.notes.value.trim(),
    platform: {socket: f.socket.value, memType: f.memType.value, memForm: f.memForm.value, ramSlots: $n(f.ramSlots.value), maxRamGB: $n(f.maxRamGB.value),
      m2Slots: $n(f.m2Slots.value), sataPorts: $n(f.sataPorts.value), pcieFree: $n(f.pcieFree.value), maxGpuLengthMm: $n(f.maxGpuLengthMm.value), psuW: $n(f.psuW.value), lowProfileOnly: f.lowProfileOnly.checked},
  };
  if (!data.name) return;
  if (editingBuild) Object.assign(buildOf(editingBuild), data);
  else { const id = uid(data.name); db.builds.push({id, ...data}); log(`Created ${data.name}`, id); }
  buildDlg.close();
  commit(editingBuild ? `${data.name} saved` : `Added build ${data.name}`);
});
$('#bDelete').addEventListener('click', () => {
  const b = buildOf(editingBuild);
  const n = parts().filter((p) => p.use === b.id).length;
  if (!confirm(`Delete the build “${b.name}”? Its ${n} part${n === 1 ? '' : 's'} go back to the inventory as Available. (Ctrl+Z undoes this.)`)) return;
  for (const p of db.parts) if (p.use === b.id) p.use = '';
  db.builds = db.builds.filter((x) => x !== b);
  buildDlg.close();
  commit(`Deleted ${b.name}`);
});

/* ------------------------------------------------------------ add part to build */
let pickBuild = null;
function renderPick() {
  const b = buildOf(pickBuild);
  const q = $('#pickQ').value.toLowerCase().trim();
  const rank = (f) => (f === true ? 0 : f == null ? 1 : 2);
  const list = parts().filter((p) => !p.use && (!q || [p.type, p.item, p.model, p.specs, p.bin].join(' ').toLowerCase().includes(q)))
    .map((p) => ({p, fit: Optimizer.fits(p, b)})).sort((x, y) => rank(x.fit) - rank(y.fit) || SORTS.type(x.p, y.p));
  $('#pickList').innerHTML = list.length ? list.map(({p, fit}) => `<li>
      ${icon(p.type)}
      <div>${tag(p.type)}<div class="pname">${esc(p.item)}${qty(p) > 1 ? ` <span class="badge">×${qty(p)}</span>` : ''}</div><div class="pspecs">${esc(p.specs)}${p.bin ? ` · ${esc(p.bin)}` : ''}</div></div>
      <span class="fit ${fit === true ? 'yes' : fit === false ? 'no' : 'unk'}">${fit === true ? '✓ Fits' : fit === false ? "✗ Won't fit" : '? Unchecked'}</span>
      <button class="btn ${fit === false ? '' : 'go'}" data-pick="${esc(p.id)}">Add</button></li>`).join('')
    : `<li class="empty">No available parts${q ? ' match' : ''}.</li>`;
}
function openPick(buildId) {
  pickBuild = buildId;
  $('#pickTitle').textContent = `Add to ${buildOf(buildId).name}`;
  $('#pickIcon').src = Pixel.planet(buildOf(buildId), 40);
  $('#pickQ').value = '';
  renderPick();
  open('#pickDlg');
  $('#pickQ').focus();
}
$('#pickQ').addEventListener('input', renderPick);
$('#pickList').addEventListener('click', (e) => {
  const id = e.target.closest('[data-pick]')?.dataset.pick;
  if (!id) return;
  const p = partOf(id), b = buildOf(pickBuild);
  if (Optimizer.fits(p, b) === false && !confirm(`${p.item} doesn't match ${b.name}'s platform. Add it anyway?`)) return;
  setUse(p, pickBuild);
  renderPick();
  commit(`${p.item} → ${b.name}`);
});
$('#pickNew').addEventListener('click', () => { $('#pickDlg').close(); openPart(null, {use: pickBuild, verdict: 'Keep', tested: true}); });

/* ------------------------------------------------------------ history */
let histBuild = null;
function renderHistory() {
  const b = buildOf(histBuild);
  const items = db.log.filter((l) => l.buildId === histBuild).slice().reverse();
  $('#histTitle').textContent = `${b.name}: history`;
  $('#histList').innerHTML = items.length ? items.map((l) => `<li><time>${dateText(l.ts)}</time><span>${esc(l.text)}</span></li>`).join('') : '<li class="sub">Nothing yet. Adding, removing and swapping parts is recorded here automatically.</li>';
}
$('#histAdd').addEventListener('click', () => {
  const t = $('#histNote').value.trim();
  if (!t) return;
  log(t, histBuild);
  $('#histNote').value = '';
  commit('Note added');
  renderHistory();
});

/* ------------------------------------------------------------ scan / paste / import */
let proposal = null;
async function scanPC() {
  toast('Scanning this PC…');
  try {
    const raw = await window.bin.scan();
    openImport(Importers.toProposal(Importers.fromSystemInformation(raw)));
  } catch (e) {
    alert(`The scan didn't work: ${e.message}`);
  }
}
function readPasted(text) {
  const rep = Importers.detect(text);
  const prop = Importers.toProposal(rep);
  if (!prop.parts.length) return alert("Couldn't find any hardware in that text. Paste the full output of `inxi -Fxz` or a CPU-Z .txt report.");
  $('#pasteDlg').close();
  openImport(prop);
}
function openImport(prop) {
  proposal = prop;
  const same = db.builds.find((b) => b.name.toLowerCase() === prop.build.name.toLowerCase());
  $('#impTarget').innerHTML = `<option value="">A new build</option>${db.builds.map((b) => `<option value="${esc(b.id)}" ${same === b ? 'selected' : ''}>${esc(b.name)} (merge into it)</option>`).join('')}`;
  $('#impName').value = prop.build.name;
  proposal.checked = prop.parts.map(() => true);
  renderImport();
  open('#importDlg');
}
const similar = (a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x === y || x.includes(y) || y.includes(x); };
function renderImport() {
  const target = buildOf($('#impTarget').value);
  $('#impNameWrap').hidden = !!target;
  const existing = target ? parts().filter((p) => p.use === target.id) : [];
  proposal.parts.forEach((p, i) => { p.dupe = existing.some((e) => e.type === p.type && (similar(e.item, p.item) || (p.model && e.model === p.model))); if (p.dupe) proposal.checked[i] = false; });
  const n = proposal.checked.filter(Boolean).length;
  $('#impSummary').textContent = `${proposal.parts.length} parts found${proposal.build.os ? ` · ${proposal.build.os}` : ''}${proposal.build.platform.socket ? ` · ${proposal.build.platform.socket}` : ''}${proposal.build.platform.memType ? ` · ${proposal.build.platform.memType}` : ''}.`;
  $('#impList').innerHTML = proposal.parts.map((p, i) => `<li>
      ${icon(p.type)}
      <div>${tag(p.type)}<div class="pname">${esc(p.item)}</div><div class="pspecs">${esc(p.specs)}${p.dupe ? ' · <b>already in this build</b>' : ''}</div></div>
      <span></span>
      <label class="tested"><input type="checkbox" data-imp="${i}" ${proposal.checked[i] ? 'checked' : ''}> Add</label></li>`).join('');
  $('#impGo').textContent = `Add ${n} part${n === 1 ? '' : 's'}`;
}
$('#impTarget').addEventListener('change', () => { proposal.checked = proposal.parts.map(() => true); renderImport(); });
$('#impList').addEventListener('change', (e) => { const i = e.target.dataset.imp; if (i != null) { proposal.checked[+i] = e.target.checked; renderImport(); } });
$('#impGo').addEventListener('click', () => {
  let b = buildOf($('#impTarget').value);
  if (!b) {
    const name = $('#impName').value.trim() || proposal.build.name;
    b = {...proposal.build, name, id: uid(name)};
    db.builds.push(b);
    log(`Created ${name} from an import`, b.id);
  } else {
    // only fill platform details the build doesn't already have
    for (const [k, v] of Object.entries(proposal.build.platform)) if ((b.platform[k] == null || b.platform[k] === '') && v != null && v !== '') b.platform[k] = v;
    if (!b.os && proposal.build.os) b.os = proposal.build.os;
  }
  const now = Date.now();
  const chosen = proposal.parts.filter((_, i) => proposal.checked[i]);
  chosen.forEach((p, i) => {
    const {dupe, ...clean} = p;
    const np = {...Model.normalizePart(clean), id: uid(`${p.type}-${p.item}`), added: now + i, use: ''};
    db.parts.push(np);
    setUse(np, b.id);
  });
  db.settings.welcomed = true;
  $('#importDlg').close();
  ui.view = 'builds';
  commit(`Added ${chosen.length} parts to ${b.name}`);
});
$('#pasteRead').addEventListener('click', () => readPasted($('#pasteText').value));
$('#pasteFile').addEventListener('click', async () => { const t = await window.bin.openReport(); if (t) { $('#pasteText').value = t; readPasted(t); } });
$('#scanPC').addEventListener('click', scanPC);
$('#pasteReport').addEventListener('click', () => { $('#pasteText').value = ''; open('#pasteDlg'); $('#pasteText').focus(); });

/* ------------------------------------------------------------ welcome, sample, settings */
async function addSample() {
  const s = Model.migrate(await window.bin.sample());
  const remap = {};
  for (const b of s.builds) { const id = uid(b.id); remap[b.id] = id; db.builds.push({...b, id}); }
  const now = Date.now();
  s.parts.forEach((p, i) => db.parts.push({...p, id: uid(p.id), added: now + i, use: remap[p.use] || p.use}));
  db.customBoards = [...(db.customBoards || []), ...s.customBoards.filter((b) => !(db.customBoards || []).some((x) => x.name === b.name))];
  db.settings.welcomed = true;
  commit('Sample homelab added. Delete the builds whenever you like.');
}
$('#welcomeDlg').addEventListener('click', async (e) => {
  const c = e.target.closest('[data-start]')?.dataset.start;
  if (!c) return;
  $('#welcomeDlg').close();
  db.settings.welcomed = true;
  commit('', {undoable: false});
  if (c === 'scan') { setView('builds'); scanPC(); }
  if (c === 'paste') { setView('builds'); $('#pasteReport').click(); }
  if (c === 'sample') addSample();
  if (c === 'import') openData();
});
$('#welcomeDlg').addEventListener('cancel', () => { db.settings.welcomed = true; commit('', {undoable: false}); });

function applySettings() {
  const s = db.settings;
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.classList.toggle('calm', !!s.reduceMotion);
  window.bin.setTheme(s.theme);
  window.bin.setZoom(s.textScale || 1);
  paintChrome();
}
function openSettings() {
  const s = db.settings;
  $('#sTheme').value = s.theme; $('#sScale').value = String(s.textScale || 1); $('#sCurrency').value = s.currency || '$';
  $('#sMotion').checked = !!s.reduceMotion; $('#sUpdate').checked = s.autoUpdate !== false; $('#sUpdateMsg').textContent = '';
  $('#sAbout').innerHTML = `Parts Bin ${esc(info.version || '')}${info.packaged ? '' : ' (development build)'} · data in <code>${esc(info.dataDir || '')}</code>`;
  renderMyBoards();
  open('#setDlg');
}
for (const [id, key, conv] of [['#sTheme', 'theme', String], ['#sScale', 'textScale', Number], ['#sCurrency', 'currency', (v) => v.trim() || '$'], ['#sMotion', 'reduceMotion', null], ['#sUpdate', 'autoUpdate', null]]) {
  $(id).addEventListener('change', (e) => {
    db.settings[key] = conv ? conv(e.target.value) : e.target.checked;
    applySettings();
    commit('Settings saved', {undoable: false});
  });
}
function renderMyBoards() {
  $('#sBoardCount').textContent = PartsDB.boards.filter((b) => !b.custom).length.toLocaleString();
  const mine = db.customBoards || [];
  $('#sMyBoards').innerHTML = mine.length ? mine.map((b, i) => `<li>${icon(b.type || 'Dev Board', 24)}<span><b>${esc(b.name)}</b> <span class="sub">${esc(b.type || 'Dev Board')}${PartsDB.boardSpec(b) ? ' · ' + esc(PartsDB.boardSpec(b)) : ''}</span></span><button type="button" class="btn small" data-del-board="${i}">Remove</button></li>`).join('')
    : '<li class="sub">None yet. When a board isn\'t in the list, the part editor offers “Not here? Add it to my boards”.</li>';
}
$('#sMyBoards').addEventListener('click', (e) => {
  const i = e.target.closest('[data-del-board]')?.dataset.delBoard;
  if (i == null) return;
  const b = db.customBoards[+i];
  db.customBoards = db.customBoards.filter((_, j) => j !== +i);
  commit(`${b.name} removed from your boards (parts keep their details)`);
  renderMyBoards();
});
$('#sCheck').addEventListener('click', async () => { $('#sUpdateMsg').textContent = 'Checking…'; $('#sUpdateMsg').textContent = (await window.bin.checkUpdates()).message; });
$('#sWelcome').addEventListener('click', () => { $('#setDlg').close(); open('#welcomeDlg'); });

/* ------------------------------------------------------------ data, backups, trash */
async function openData() {
  open('#dataDlg');
  const list = await window.bin.backups();
  $('#backupList').innerHTML = list.length ? list.map((b) => `<li>
      ${spr(Pixel.icon('Storage'), 36)}
      <div><div class="pname">${esc(dateText(b.mtime))}</div><div class="pspecs">${b.parts ?? '?'} parts · ${b.builds ?? '?'} builds · ${(b.size / 1024).toFixed(0)} KB${/before-upgrade/.test(b.name) ? ' · before the v2 upgrade' : ''}</div></div>
      <span></span><button class="btn" data-restore="${esc(b.name)}">Restore</button></li>`).join('')
    : '<li class="empty">No snapshots yet. The first one is taken after ten minutes of editing.</li>';
}
$('#backupList').addEventListener('click', async (e) => {
  const n = e.target.closest('[data-restore]')?.dataset.restore;
  if (!n || !confirm('Replace everything with this snapshot? The current state is kept as a snapshot first, and Ctrl+Z also undoes it.')) return;
  db = Model.migrate(await window.bin.restoreBackup(n));
  $('#dataDlg').close();
  commit('Snapshot restored');
});
$('#dExportJSON').addEventListener('click', async () => { const r = await window.bin.exportData(db); if (r.ok) toast(`Saved ${r.filePath}`); });
$('#dImportJSON').addEventListener('click', async () => {
  const r = await window.bin.importData();
  if (r.error) alert(r.error);
  if (!r.ok) return;
  if ((db.parts.length || db.builds.length) && !confirm('Replace everything in the app with this file? (Ctrl+Z undoes it, and a snapshot is kept.)')) return;
  db = Model.migrate(r.data);
  db.settings.welcomed = true;
  $('#dataDlg').close();
  commit('Backup imported');
});
$('#dExportCSV').addEventListener('click', async () => { const r = await window.bin.exportCSV(Model.toCSV(db)); if (r.ok) toast(`Saved ${r.filePath}`); });
$('#dImportCSV').addEventListener('click', async () => {
  const text = await window.bin.importCSV();
  if (!text) return;
  const rows = Model.fromCSV(text, db.builds);
  if (!rows.length) return alert('No parts found. The first row needs column names (at least a Name or Item column).');
  let added = 0, updated = 0;
  const now = Date.now();
  rows.forEach((r, i) => {
    const ex = r.id && partOf(r.id);
    if (ex) { Object.assign(ex, Model.normalizePart({...ex, ...r, attrs: ex.attrs, photos: ex.photos, tests: ex.tests})); updated++; }
    else { db.parts.push({...Model.normalizePart(r), id: uid(r.id || `${r.type}-${r.item}`), added: now + i}); added++; }
  });
  db.settings.welcomed = true;
  $('#dataDlg').close();
  commit(`CSV imported: ${added} added, ${updated} updated`);
});
$('#dSample').addEventListener('click', () => { $('#dataDlg').close(); addSample(); });
$('#dFolder').addEventListener('click', () => window.bin.openFolder());

function renderTrash() {
  const t = db.parts.filter((p) => p.deleted).sort((a, b) => b.deleted - a.deleted);
  $('#trashCount').textContent = t.length ? `(${t.length})` : '';
  if (!$('#trashDlg').open) return;
  $('#trashList').innerHTML = t.length ? t.map((p) => `<li>${icon(p.type)}<div>${tag(p.type)}<div class="pname">${esc(p.item)}</div><div class="pspecs">deleted ${esc(dateText(p.deleted))}</div></div>
      <button class="btn" data-forever="${esc(p.id)}">Delete forever</button><button class="btn go" data-restore-part="${esc(p.id)}">Restore</button></li>`).join('')
    : '<li class="empty">The trash is empty.</li>';
  $('#trashEmpty').disabled = !t.length;
}
$('#trashList').addEventListener('click', (e) => {
  const r = e.target.closest('[data-restore-part]')?.dataset.restorePart, f = e.target.closest('[data-forever]')?.dataset.forever;
  if (r) { const p = partOf(r); delete p.deleted; if (buildOf(p.use)) log(`Restored ${p.item} from the trash`, p.use, p.id); commit(`${p.item} restored`); }
  if (f && confirm('Delete this part permanently? Its photos are removed too.')) { const p = partOf(f); window.bin.deletePhotos(p.photos); db.parts = db.parts.filter((x) => x !== p); commit('Deleted permanently'); }
});
$('#trashEmpty').addEventListener('click', () => {
  const t = db.parts.filter((p) => p.deleted);
  if (!confirm(`Permanently delete ${t.length} part${t.length === 1 ? '' : 's'} and their photos?`)) return;
  window.bin.deletePhotos(t.flatMap((p) => p.photos));
  db.parts = db.parts.filter((p) => !p.deleted);
  commit('Trash emptied');
});

/* ------------------------------------------------------------ labels, report, printing */
let labelOpts = {};
function labelSources() {
  const listed = parts().filter(matches);
  const src = [];
  if (labelOpts.part) src.push(['part', `This part: ${labelOpts.part.item}`, [labelOpts.part]]);
  src.push(['list', `Parts in the current inventory list (${listed.length})`, listed]);
  src.push(['bins', `Storage locations (${bins().length})`, bins().map((b) => ({bin: b}))]);
  for (const b of db.builds) src.push([`b:${b.id}`, `Everything in ${b.name} (${parts().filter((p) => p.use === b.id).length})`, parts().filter((p) => p.use === b.id)]);
  return src;
}
async function labelHTML(items) {
  const out = [];
  for (const it of items) {
    if (it.bin) {
      const n = parts().filter((p) => p.bin === it.bin && !isSold(p)).length;
      out.push(`<div class="label"><img src="${await window.bin.qr(`partsbin:bin:${it.bin}`)}" alt=""><div><small>STORAGE</small><b>${esc(it.bin)}</b><span>${n} part${n === 1 ? '' : 's'}</span></div></div>`);
    } else {
      out.push(`<div class="label"><img src="${await window.bin.qr(`partsbin:part:${it.id}`)}" alt=""><div><small>${esc(it.type)}${qty(it) > 1 ? ` ×${qty(it)}` : ''}</small><b>${esc(it.item)}</b><span>${esc(it.model || it.specs || '')}</span>${it.bin ? `<span>${esc(it.bin)}</span>` : ''}</div></div>`);
    }
  }
  return out;
}
async function renderLabelPreview() {
  const [, , items] = labelSources().find(([k]) => k === $('#lSource').value) || [];
  const html = await labelHTML((items || []).slice(0, 6));
  $('#lPreview').className = `label-preview s${$('#lSheet').value}`;
  $('#lPreview').innerHTML = html.join('') || '<p class="sub">Nothing to print in this selection.</p>';
  $('#lCount').textContent = `${(items || []).length} label${(items || []).length === 1 ? '' : 's'}${(items || []).length > 6 ? ' (first 6 shown)' : ''}`;
}
function openLabels(opts = {}) {
  labelOpts = opts;
  $('#lSource').innerHTML = labelSources().map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('');
  if (opts.part) $('#lSource').value = 'part';
  open('#labelDlg');
  renderLabelPreview();
}
$('#lSource').addEventListener('change', renderLabelPreview);
$('#lSheet').addEventListener('change', renderLabelPreview);
async function printWith(html, cls, pdfName) {
  const area = $('#print');
  area.className = cls;
  area.innerHTML = html;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  document.body.classList.add('printing');
  try {
    const r = pdfName ? await window.bin.printPDF(pdfName, cls.startsWith('labels') ? 'labels' : 'report') : await window.bin.printDialog(cls.startsWith('labels') ? 'labels' : 'report');
    if (r?.filePath) toast(`Saved ${r.filePath}`);
  } finally {
    document.body.classList.remove('printing');
    area.innerHTML = '';
  }
}
async function printLabels(pdf) {
  const [, , items] = labelSources().find(([k]) => k === $('#lSource').value) || [];
  if (!items?.length) return;
  const sheet = $('#lSheet').value, per = sheet === '5160' ? 30 : 10;
  const html = await labelHTML(items);
  const pages = [];
  for (let i = 0; i < html.length; i += per) pages.push(`<section class="sheet">${html.slice(i, i + per).join('')}</section>`);
  await printWith(pages.join(''), `labels s${sheet}`, pdf ? `parts-bin-labels-${today()}.pdf` : null);
}
$('#lPrint').addEventListener('click', () => printLabels(false));
$('#lPdf').addEventListener('click', () => printLabels(true));

function reportHTML() {
  const all = parts();
  const live = all.filter((p) => !isSold(p));
  const row = (p) => `<tr><td>${esc(p.type)}</td><td><b>${esc(p.item)}</b>${p.model ? `<br><small>${esc(p.model)}</small>` : ''}</td><td>${qty(p)}</td><td>${esc(p.verdict)}</td><td>${p.tested ? 'yes' : 'no'}</td><td class="num">${money(p)}</td></tr>`;
  const table = (list) => `<table><thead><tr><th>Type</th><th>Part</th><th>Qty</th><th>Verdict</th><th>Tested</th><th class="num">Value</th></tr></thead><tbody>${list.sort(SORTS.type).map(row).join('')}</tbody></table>`;
  const shelf = live.filter((p) => !p.use);
  const byBin = {};
  for (const p of shelf) (byBin[p.bin || 'No location set'] ||= []).push(p);
  const sold = all.filter(isSold);
  return `<header><img class="spr" src="${Pixel.icon('logo')}" width="48" height="48" alt=""><div><h1>Parts Bin inventory</h1><p>${new Date().toLocaleDateString([], {dateStyle: 'long'})} · ${live.length} entries · estimated value ${rangeText(sumRange(live)).replace(/<[^>]+>/g, '')}</p></div></header>
    ${db.builds.map((b) => { const bp = live.filter((p) => p.use === b.id); return `<h2>${esc(b.name)}</h2><p>${esc([b.role, b.ip, b.os].filter(Boolean).join(' · '))}</p>${bp.length ? table(bp) : '<p>No parts recorded.</p>'}`; }).join('')}
    ${Object.keys(byBin).length ? `<h2>On the shelf</h2>${Object.entries(byBin).sort(([a], [b]) => a.localeCompare(b, undefined, {numeric: true})).map(([bin, l]) => `<h3>${esc(bin)}</h3>${table(l)}`).join('')}` : ''}
    ${live.some((p) => p.use === 'other') ? `<h2>In use elsewhere</h2>${table(live.filter((p) => p.use === 'other'))}` : ''}
    ${sold.length ? `<h2>Sold</h2><table><thead><tr><th>Part</th><th>Sold on</th><th class="num">Paid</th><th class="num">Sold for</th></tr></thead><tbody>${sold.map((p) => `<tr><td><b>${esc(p.item)}</b></td><td>${esc(p.sale.date || '')}</td><td class="num">${p.purchase.price != null ? fmt(p.purchase.price) : ''}</td><td class="num">${p.sale.price != null ? fmt(p.sale.price) : ''}</td></tr>`).join('')}</tbody></table>` : ''}
    <footer>Generated by Parts Bin</footer>`;
}
$('#reportBtn').addEventListener('click', () => printWith(reportHTML(), 'report', `parts-bin-report-${today()}.pdf`));
$('#labelsBtn').addEventListener('click', () => openLabels());

/* ------------------------------------------------------------ camera label scanner */
let camStream = null, camRAF = 0;
async function openCamera() {
  open('#camDlg');
  $('#camMsg').textContent = 'Starting the camera…';
  try {
    camStream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment', width: {ideal: 1280}}});
  } catch (e) {
    $('#camMsg').textContent = `No camera available (${e.name}). Plug in a webcam and try again.`;
    return;
  }
  const v = $('#camVideo');
  v.srcObject = camStream;
  await v.play();
  $('#camMsg').textContent = 'Hold a Parts Bin label up to the camera.';
  const cv = document.createElement('canvas'), g = cv.getContext('2d', {willReadFrequently: true});
  const tick = () => {
    if (!camStream) return;
    if (v.videoWidth) {
      const w = 640, h = Math.round((v.videoHeight / v.videoWidth) * w);
      cv.width = w; cv.height = h;
      g.drawImage(v, 0, 0, w, h);
      const code = jsQR(g.getImageData(0, 0, w, h).data, w, h, {inversionAttempts: 'dontInvert'});
      if (code && handleScan(code.data)) return;
    }
    camRAF = requestAnimationFrame(tick);
  };
  tick();
}
function stopCamera() {
  cancelAnimationFrame(camRAF);
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
}
function handleScan(text) {
  const m = /^partsbin:(part|bin):(.+)$/.exec(text || '');
  if (!m) { $('#camMsg').textContent = "That QR code isn't a Parts Bin label."; return false; }
  $('#camDlg').close();
  if (m[1] === 'part') {
    const p = partOf(m[2]);
    if (!p) { toast('That part is no longer in the inventory.'); return true; }
    setView('inventory');
    openPart(p);
  } else {
    Object.assign(ui, {bin: m[2], status: 'all', type: 'All', q: ''});
    $('#q').value = '';
    keepUi();
    setView('inventory');
    toast(`Showing ${m[2]}`);
  }
  return true;
}
$('#camDlg').addEventListener('close', stopCamera);
$('#camBtn').addEventListener('click', openCamera);

/* ------------------------------------------------------------ wiring */
let boardsSynced = null;
function render() {
  // undo, restore and import can swap in a different list of the user's own boards
  if (boardsSynced !== db.customBoards) { PartsDB.setCustomBoards(db.customBoards || []); boardsSynced = db.customBoards; namesFor = ''; }
  $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === ui.view));
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${ui.view}`));
  $('#strap').textContent = db.builds.length ? db.builds.slice(0, 4).map((b) => b.name).join(' · ') + (db.builds.length > 4 ? ' …' : '') : 'Your hardware, organised';
  $('#undoBtn').disabled = !undoStack.length;
  $('#redoBtn').disabled = !redoStack.length;
  renderInventory();
  renderBuilds();
  renderOptimizer();
  renderTrash();
  if ($('#histDlg').open) renderHistory();
  paintChrome();
}
function setView(v) { ui.view = v; keepUi(); render(); scrollTo(0, 0); }

$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); });
let qTimer;
$('#q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { ui.q = e.target.value.trim(); renderInventory(); }, 80); });
$('#fType').addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (b) { ui.type = b.dataset.type; keepUi(); renderInventory(); } });
$('#fStatus').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { ui.status = b.dataset.v; keepUi(); renderInventory(); } });
for (const [id, key] of [['#fVerdict', 'verdict'], ['#fTested', 'tested'], ['#fSort', 'sort'], ['#fBin', 'bin']]) $(id).addEventListener('change', (e) => { ui[key] = e.target.value; keepUi(); renderInventory(); });
$('#addPart').addEventListener('click', () => openPart(null, {...(ui.type !== 'All' ? {type: ui.type} : {}), ...(ui.bin && ui.bin !== '(none)' ? {bin: ui.bin} : {})}));
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#settingsBtn').addEventListener('click', openSettings);
$('#dataBtn').addEventListener('click', openData);
$('#trashBtn').addEventListener('click', () => { open('#trashDlg'); renderTrash(); });

$('#invRows').addEventListener('click', (e) => {
  if (e.target.closest('select, input, label')) return;
  const id = e.target.closest('tr[data-id]')?.dataset.id;
  if (id) openPart(partOf(id));
});
$('#invRows').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.tagName !== 'TR') return;
  openPart(partOf(e.target.dataset.id));
});
$('#invRows').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.tested) { const p = partOf(t.dataset.tested); p.tested = t.checked; commit(`${p.item}: ${t.checked ? 'tested' : 'untested'}`); }
  if (t.dataset.use !== undefined) {
    const p = partOf(t.dataset.use);
    setUse(p, t.value);
    commit(`${p.item}: ${useLabel(p)}`);
    if (t.value === 'other' || t.value === 'sold') openPart(p); // ask where / for how much
  }
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.matches('[data-close]')) t.closest('dialog').close();
  else if (t.dataset.editBuild) openBuild(buildOf(t.dataset.editBuild));
  else if (t.dataset.addTo) openPick(t.dataset.addTo);
  else if (t.dataset.editPart) openPart(partOf(t.dataset.editPart));
  else if (t.dataset.history) { histBuild = t.dataset.history; renderHistory(); open('#histDlg'); }
  else if (t.dataset.goto) setView(t.dataset.goto);
  else if (t.dataset.link) window.bin.openLink(t.dataset.link);
  else if (t.dataset.apply) { const [b, i] = t.dataset.apply.split(':'); applySuggestion(b, +i); }
  else if (t.dataset.pull) {
    const p = partOf(t.dataset.pull);
    const from = buildOf(p.use)?.name;
    setUse(p, '');
    commit(`${p.item} removed from ${from}, now Available`);
  } else if (t.id === 'addBuild') openBuild(null);
});
// click on the dim backdrop closes a dialog (not the welcome screen)
for (const d of $$('dialog')) d.addEventListener('click', (e) => { if (e.target === d && d.id !== 'welcomeDlg') d.close(); });

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  const k = e.key.toLowerCase();
  if (e.ctrlKey && !typing && (k === 'z' || k === 'y')) { e.preventDefault(); (k === 'y' || e.shiftKey) ? redo() : undo(); return; }
  if ($('dialog[open]')) return;
  if ((e.key === '/' && !typing) || (e.ctrlKey && k === 'f')) { e.preventDefault(); setView('inventory'); $('#q').focus(); $('#q').select(); }
  else if (e.ctrlKey && k === 'n') { e.preventDefault(); openPart(null); }
  else if (e.key === 'Escape' && document.activeElement === $('#q')) { $('#q').value = ''; ui.q = ''; renderInventory(); }
  else if (!typing && !e.ctrlKey && !e.altKey && ['1', '2', '3'].includes(e.key)) setView(['inventory', 'builds', 'optimizer'][+e.key - 1]);
});

// header sky (drawn at half the window width, shown at 2x), page pattern and static sprites
let chromeKey = '';
function paintChrome() {
  const t = theme();
  // planets go in the free stretch between the tabs and the buttons (in the banner's half-size pixels)
  const tabs = $('#tabs').getBoundingClientRect(), btns = $('.hgroup').getBoundingClientRect();
  const sameRow = Math.abs(btns.top - tabs.top) < tabs.height;
  const gap = [Math.ceil(tabs.right / 2) + 10, Math.floor((sameRow ? btns.left : innerWidth) / 2) - 10];
  const key = `${t}:${Math.ceil(innerWidth / 2)}:${gap}:${db.builds.slice(0, 3).map((b) => Pixel.kind(b)).join()}`;
  if (key === chromeKey) return;
  chromeKey = key;
  const root = document.documentElement.style;
  root.setProperty('--banner', `url(${Pixel.banner(Math.ceil(innerWidth / 2), 48, t, db.builds, gap)})`);
  root.setProperty('--pattern', `url(${Pixel.pattern(t)})`);
  $('#themeIcon').src = Pixel.icon(t === 'dark' ? 'moon' : 'sun');
  $('#logo').src = Pixel.icon('logo');
  for (const img of $$('img[data-sprite]')) img.src = Pixel.icon(img.dataset.sprite);
}
$('#themeBtn').addEventListener('click', () => {
  db.settings.theme = theme() === 'light' ? 'dark' : 'light';
  applySettings();
  renderBuilds();
  commit('', {undoable: false});
});
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(paintChrome, 150); });
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applySettings);

(async function init() {
  PartsDB.init(await window.bin.partsDB());
  info = await window.bin.info();
  const {data, file} = await window.bin.load();
  const first = !data;
  const fromVersion = data?.version || 1; // read before migrate(), which upgrades the object in place
  db = first ? Model.empty() : Model.migrate(data);
  lastSnap = JSON.stringify(db);
  $('#dataPath').textContent = file;
  $('#archList').innerHTML = ARCHES.map((a) => `<option value="${esc(a)}">`).join('');
  applySettings();
  const s = $('#saved');
  s.className = 'saved ok';
  s.lastChild.textContent = `${parts().length} parts · ${db.builds.length} builds`;
  render();
  if (first) persist(); // writes the (possibly migrated) file right away
  else if (fromVersion < Model.VERSION) { persist(); toast('Your data was upgraded to the new format. The old file is kept in backups.'); }
  if (!db.settings.welcomed && !db.parts.length && !db.builds.length) open('#welcomeDlg');
})();
