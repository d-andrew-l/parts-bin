// Data model: schema defaults, migrations, derived specs from the parts database, and CSV.
// Schema v2 part: {id, type, item, model, specs, qty, bin, mfgDate, valueLow, valueHigh, verdict, tested,
//   use: '' | <buildId> | 'other' | 'sold', useNote, notes, attrs, purchase:{price,date,from,warrantyUntil},
//   sale:{price,date,to}, photos:[file], tests:[{date,result,note}], added, deleted}
// Works in the app (window.Model) and in Node tests.
(function (root) {
  'use strict';
  const DB = () => (typeof module !== 'undefined' && module.exports ? require('./partsdb.js') : root.PartsDB);
  const VERSION = 2;
  const SETTINGS = {theme: 'light', textScale: 1, reduceMotion: false, currency: '$', autoUpdate: true, welcomed: false};

  // boards, single-board computers and modules are looked up in the board list (built in + the user's own)
  const BOARD_TYPES = ['Dev Board', 'SBC', 'Module'];
  const empty = () => ({version: VERSION, settings: {...SETTINGS}, builds: [], parts: [], log: [], customBoards: []});

  function normalizePart(p) {
    const n = {
      type: 'Other', item: '', model: '', specs: '', qty: 1, bin: '', mfgDate: '', valueLow: null, valueHigh: null, verdict: 'Spare', tested: false,
      use: '', useNote: '', notes: '', attrs: {}, purchase: {}, sale: {}, photos: [], tests: [], ...p,
    };
    n.qty = Math.max(1, Math.round(+n.qty || 1));
    for (const k of ['attrs', 'purchase', 'sale']) if (!n[k] || typeof n[k] !== 'object') n[k] = {};
    for (const k of ['photos', 'tests']) if (!Array.isArray(n[k])) n[k] = [];
    return derive(n);
  }

  // fill specs we can look up; the CPU score is always recomputed so everyone's numbers are comparable
  function derive(p) {
    const db = DB();
    if (p.type === 'CPU') {
      const hit = db.findCPU(`${p.item} ${p.model}`);
      if (hit) {
        const keep = Object.fromEntries(Object.entries(p.attrs).filter(([k, v]) => v !== '' && v != null && !['score'].includes(k)));
        p.attrs = {...db.cpuAttrs(hit.name), ...keep, socket: keep.socket || hit.socket};
        p.attrs.score = db.cpuScore({...hit, ...keep});
        if (!p.specs) p.specs = db.specLine(hit);
      } else if (p.attrs.cores && (p.attrs.boostGHz || p.attrs.baseGHz)) {
        p.attrs.score = db.cpuScore(p.attrs);
      } else delete p.attrs.score;
    } else if (p.type === 'GPU') {
      const hit = db.findGPU(`${p.item} ${p.model}`);
      if (hit) {
        p.attrs = {tdpW: hit.tdpW, perf: hit.perf, vramGB: hit.vramGB, ...Object.fromEntries(Object.entries(p.attrs).filter(([, v]) => v !== '' && v != null))};
        p.attrs.perf = hit.perf;
      }
    } else if (BOARD_TYPES.includes(p.type)) {
      const hit = db.findBoard(p.item) || (p.model && db.findBoard(p.model));
      if (hit) {
        p.attrs = db.boardAttrs(hit, p.attrs);
        if (!p.specs) p.specs = db.boardSpec(hit);
      }
    }
    return p;
  }

  function migrate(data) {
    const d = data && typeof data === 'object' ? data : empty();
    const from = d.version || 1;
    if (from < 2) {
      // v1 -> v2: "location" meant "where it's in use", now useNote; new money/photos/tests/qty/bin fields
      for (const p of d.parts || []) {
        if (p.location != null) { p.useNote = p.location; delete p.location; }
      }
      // PassMark numbers from v1 are dropped; derive() recomputes the open Parts Bin score
      for (const p of d.parts || []) if (p.attrs) delete p.attrs.score;
    }
    d.version = VERSION;
    d.settings = {...SETTINGS, ...(d.settings || {}), ...(from < 2 ? {welcomed: true} : {})};
    d.builds = (d.builds || []).map((b) => ({kind: 'computer', role: '', ip: '', os: '', notes: '', ...b, platform: {memForm: 'UDIMM', ...(b.platform || {})}}));
    d.customBoards = Array.isArray(d.customBoards) ? d.customBoards : [];
    DB().setCustomBoards(d.customBoards);
    d.parts = (d.parts || []).map(normalizePart);
    d.log = Array.isArray(d.log) ? d.log : [];
    // trash empties itself after 30 days
    const cutoff = Date.now() - 30 * 864e5;
    d.parts = d.parts.filter((p) => !p.deleted || p.deleted > cutoff);
    return d;
  }

  /* ---------------------------------------------------------------- CSV */
  const COLS = ['id', 'type', 'item', 'model', 'specs', 'qty', 'bin', 'status', 'verdict', 'tested', 'mfgDate', 'valueLow', 'valueHigh',
    'paid', 'boughtOn', 'boughtFrom', 'warrantyUntil', 'soldFor', 'soldOn', 'soldTo', 'notes'];
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  function toCSV(d) {
    const status = (p) => (!p.use ? 'Available' : p.use === 'sold' ? 'Sold' : p.use === 'other' ? `In use: ${p.useNote || 'elsewhere'}` : `In ${d.builds.find((b) => b.id === p.use)?.name || p.use}`);
    const rows = d.parts.filter((p) => !p.deleted).map((p) => [p.id, p.type, p.item, p.model, p.specs, p.qty, p.bin, status(p), p.verdict, p.tested ? 'yes' : 'no', p.mfgDate, p.valueLow, p.valueHigh,
      p.purchase.price, p.purchase.date, p.purchase.from, p.purchase.warrantyUntil, p.sale.price, p.sale.date, p.sale.to, p.notes]);
    return [COLS, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }
  function parseCSV(text) {
    const rows = [];
    let row = [], f = '', q = false;
    const s = text.replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"' && s[i + 1] === '"') { f += '"'; i++; }
        else if (c === '"') q = false;
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim()));
  }
  // CSV -> parts; headers are matched loosely so spreadsheets made by hand also work
  function fromCSV(text, builds) {
    const [head, ...rows] = parseCSV(text);
    if (!head) return [];
    const key = (h) => h.toLowerCase().replace(/[^a-z]/g, '');
    const ALIAS = {name: 'item', part: 'item', partname: 'item', description: 'item', partno: 'model', partnumber: 'model', quantity: 'qty', count: 'qty', location: 'bin', box: 'bin',
      price: 'paid', cost: 'paid', purchaseprice: 'paid', purchased: 'boughtOn', category: 'type', condition: 'verdict', manufactured: 'mfgDate'};
    const idx = {};
    head.forEach((h, i) => { const k = key(h); const col = COLS.find((c) => c.toLowerCase() === k) || ALIAS[k]; if (col && idx[col] == null) idx[col] = i; });
    const num = (v) => (v === '' || v == null || Number.isNaN(+String(v).replace(/[$,]/g, '')) ? null : +String(v).replace(/[$,]/g, ''));
    const TYPES = ['CPU', 'Motherboard', 'RAM', 'GPU', 'Storage', 'Power', 'Cooling', 'Network', 'Case', 'System', ...BOARD_TYPES, 'Other'];
    return rows.map((r) => {
      const g = (c) => (idx[c] == null ? '' : (r[idx[c]] || '').trim());
      const st = g('status');
      const b = builds.find((x) => new RegExp(`^in ${x.name}$`, 'i').test(st) || x.name.toLowerCase() === st.toLowerCase());
      const t = TYPES.find((x) => x.toLowerCase() === g('type').toLowerCase()) || (/memory|dimm/i.test(g('type')) ? 'RAM' : /ssd|hdd|drive|disk/i.test(g('type')) ? 'Storage' : /psu|power/i.test(g('type')) ? 'Power' : /fan|cooler/i.test(g('type')) ? 'Cooling' : /arduino|esp32|microcontroller|mcu|dev ?board|launchpad/i.test(g('type')) ? 'Dev Board' : /raspberry|sbc|single.board/i.test(g('type')) ? 'SBC' : /sensor|module|shield|breakout/i.test(g('type')) ? 'Module' : 'Other');
      return {
        id: g('id'), type: t, item: g('item'), model: g('model'), specs: g('specs'), qty: num(g('qty')) || 1, bin: g('bin'),
        use: /^sold/i.test(st) ? 'sold' : b ? b.id : /^in use/i.test(st) ? 'other' : '', useNote: /^in use:/i.test(st) ? st.replace(/^in use:\s*/i, '') : '',
        verdict: ['Keep', 'Spare', 'Sell'].find((v) => v.toLowerCase() === g('verdict').toLowerCase()) || 'Spare', tested: /^(y|yes|true|1|tested)$/i.test(g('tested')),
        mfgDate: g('mfgDate'), valueLow: num(g('valueLow')), valueHigh: num(g('valueHigh')),
        purchase: {price: num(g('paid')), date: g('boughtOn'), from: g('boughtFrom'), warrantyUntil: g('warrantyUntil')},
        sale: {price: num(g('soldFor')), date: g('soldOn'), to: g('soldTo')}, notes: g('notes'), attrs: {},
      };
    }).filter((p) => p.item);
  }

  const api = {VERSION, SETTINGS, BOARD_TYPES, empty, migrate, normalizePart, derive, toCSV, fromCSV, parseCSV};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Model = api;
})(typeof window !== 'undefined' ? window : globalThis);
