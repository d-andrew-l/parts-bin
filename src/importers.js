// Hardware report importers. Every source is turned into one normalised report:
//   {source, hostname, os, system, board, cpu:{name,cores,threads,baseGHz,boostGHz}, memory:{totalGB,slots,sticks:[...]},
//    disks:[{model,sizeGB,kind,formFactor,health}], gpus:[{model,vramGB}], nics:[{model,speedMbps,iface}], ip}
// and then into a proposed build + parts (toProposal). Sources: this app's own scan (systeminformation),
// pasted `inxi -Fxz` output, and CPU-Z .txt reports. Works in the app (window.Importers) and in Node tests.
(function (root) {
  'use strict';
  const DB = () => (typeof module !== 'undefined' && module.exports ? require('./partsdb.js') : root.PartsDB);
  const num = (v) => (v == null || v === '' || Number.isNaN(+v) ? null : +v);
  // short, familiar vendor names instead of the legal ones firmware reports
  const VENDORS = [[/micro-star international( co\.?,? ltd\.?)?/i, 'MSI'], [/asustek computer inc\.?/i, 'ASUS'], [/gigabyte technology co\.?,? ltd\.?/i, 'Gigabyte'],
    [/hewlett-packard|\bhp inc\.?/i, 'HP'], [/dell inc\.?/i, 'Dell'], [/lenovo/i, 'Lenovo'], [/g\.? ?skill intl/i, 'G.Skill'], [/asrock incorporation|asrock inc\.?/i, 'ASRock'],
    [/kingston technology/i, 'Kingston'], [/micron technology/i, 'Micron'], [/samsung electronics/i, 'Samsung'], [/hynix semiconductor|sk ?hynix/i, 'SK Hynix'], [/\bwdc\b/i, 'WD']];
  const clean = (s) => VENDORS.reduce((t, [re, to]) => t.replace(re, to), String(s || '')).replace(/\((r|tm)\)|[®™]/gi, '').replace(/\s+/g, ' ').trim();
  // GiB / TB etc -> GB (decimal, the way drives are sold)
  function toGB(val, unit) {
    const v = parseFloat(val);
    if (!Number.isFinite(v)) return null;
    const u = String(unit || 'GB').toLowerCase();
    const gb = u.startsWith('t') ? v * (u.includes('i') ? 1099.5 : 1000) : u.startsWith('m') ? v / (u.includes('i') ? 953.7 : 1000) : u.includes('i') ? v * 1.0737 : v;
    return gb;
  }
  // round a measured capacity to the size printed on the box (238.47 GiB -> 256 GB, 465.8 GB -> 500 GB)
  function marketing(gb) {
    if (!gb) return null;
    const sizes = [16, 32, 60, 64, 80, 120, 128, 160, 240, 250, 256, 320, 480, 500, 512, 640, 750, 960, 1000, 1024, 1500, 2000, 3000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22000, 24000];
    return sizes.find((s) => gb <= s * 1.02 && gb >= s * 0.86) || Math.round(gb);
  }
  const ramGB = (gb) => [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128].find((s) => Math.abs(s - gb) < s * 0.08) || Math.round(gb);

  /* ---------------------------------------------------------------- inxi -Fxz */
  function parseInxi(text) {
    // section headers ("Machine:", "CPU:") start at column 0; everything indented belongs to the section above
    const sec = {};
    let cur = null;
    for (const raw of text.replace(/\r/g, '').replace(/\u001b\[[0-9;]*m/g, '').split('\n')) {
      const h = /^([A-Z][A-Za-z ]{1,20}):(?:\s+(.*))?$/.exec(raw.replace(/^\S*\$ .*/, ''));
      if (h && !/^\s/.test(raw)) { cur = h[1]; sec[cur] = (sec[cur] || '') + ' ' + (h[2] || ''); }
      else if (cur) sec[cur] += ' ' + raw.trim();
    }
    // value of "key:" up to the next "word:" token
    const grab = (s, key) => {
      if (!s) return null;
      const r = new RegExp(`(?:^|\\s)${key.replace(/[()]/g, '\\$&')}:\\s*(.*?)(?=\\s+[A-Za-z][\\w/()-]{0,24}:(?:\\s|$)|$)`).exec(s);
      return r ? r[1].trim() : null;
    };
    const parts = (s, tag) => (s ? s.split(new RegExp(`\\b${tag}-\\d+:`)).slice(1) : []);
    const out = {source: 'inxi', disks: [], gpus: [], nics: [], memory: {sticks: []}};
    const sys = sec.System || '';
    out.os = grab(sys, 'Distro');
    const mach = sec.Machine || '';
    const prodVendor = grab(mach, 'System');
    const product = grab(mach, 'product');
    if (product) out.system = clean(product.startsWith(prodVendor || '\0') ? product : `${prodVendor || ''} ${product}`);
    const mobo = grab(mach, 'Mobo');
    const moboModel = grab(mach, 'model');
    if (mobo || moboModel) out.board = clean(`${mobo || ''} ${moboModel || ''}`);
    const cpu = sec.CPU || '';
    const cores = /(\d+)-core/.exec(cpu);
    const minmax = /min\/max:\s*(\d+)\/(\d+)/.exec(cpu);
    out.cpu = {name: clean(grab(cpu, 'model')), cores: cores ? +cores[1] : null, threads: null, boostGHz: minmax ? +minmax[2] / 1000 : null};
    const tl = /cores:\s*((?:\d+:\s*\d+\s*)+)/.exec(cpu);
    if (tl) out.cpu.threads = (tl[1].match(/\d+:/g) || []).length || null;
    if (/\btype:\s*MT\b/.test(cpu) && out.cpu.cores && !out.cpu.threads) out.cpu.threads = out.cpu.cores * 2;
    for (const d of parts(sec.Graphics, 'Device')) out.gpus.push({model: clean(d.split(/\s(?:vendor|driver|bus-ID|v):/)[0])});
    for (const d of parts(sec.Network, 'Device')) {
      const nic = {model: clean(d.split(/\s(?:vendor|driver|bus-ID|v|port):/)[0])};
      const iface = /IF:\s*(\S+)/.exec(d), sp = /speed:\s*(\d+)\s*Mbps/.exec(d);
      if (iface) nic.iface = iface[1];
      if (sp) nic.speedMbps = +sp[1];
      out.nics.push(nic);
    }
    for (const d of parts(sec.Drives, 'ID')) {
      const path = (/^\s*(\/dev\/\S+)/.exec(d) || [])[1] || '';
      const model = clean(`${grab(d, 'vendor') || ''} ${grab(d, 'model') || ''}`);
      const size = /size:\s*([\d.]+)\s*([KMGT]i?B)/.exec(d);
      const kind = /nvme/.test(path) ? 'NVMe SSD' : /\bSSD\b/i.test(d) || /type:\s*SSD/.test(d) ? 'SATA SSD' : /rotation:\s*\d+/.test(d) || /HDD|WD\d|ST\d/.test(model) ? 'HDD' : /usb/i.test(d) ? 'USB' : 'SATA SSD';
      if (kind === 'USB') continue;
      out.disks.push({model, sizeGB: size ? marketing(toGB(size[1], size[2])) : null, kind, formFactor: kind === 'NVMe SSD' ? 'M.2' : ''});
    }
    const memTotal = /(?:Memory|System RAM):\s*(?:total:\s*)?(?:available:\s*)?([\d.]+)\s*([KMGT]i?B)/.exec(sec.Info || '') || /total:\s*([\d.]+)\s*([KMGT]i?B)/.exec(sec.Memory || '');
    if (memTotal) out.memory.totalGB = ramGB(toGB(memTotal[1], memTotal[2]) / 1.0737);
    return out;
  }

  /* ---------------------------------------------------------------- CPU-Z .txt report */
  function parseCpuz(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    const kv = (line) => { const m = /^\s*([^\t]+?)\t+(.+?)\s*$/.exec(line); return m ? [m[1].trim(), m[2].trim()] : null; };
    const out = {source: 'cpuz', disks: [], gpus: [], nics: [], memory: {sticks: []}};
    let mode = '', stick = null, gpu = null;
    for (const line of lines) {
      if (/^Processors Information/i.test(line)) mode = 'cpu';
      else if (/^Memory SPD/i.test(line)) mode = 'spd';
      else if (/^Display Adapters/i.test(line)) mode = 'gpu';
      else if (/^(Mainboard|Motherboard)/i.test(line)) mode = 'board';
      else if (/^Memory\s*$/i.test(line) || /^Memory$/i.test(line.trim())) mode = 'mem';
      else if (/^(Software|Monitoring|Chipset|Hardware Monitors|PCI Devices|DMI)/i.test(line)) mode = '';
      const p = kv(line);
      if (!p) continue;
      const [k, v] = p;
      if (mode === 'cpu') {
        if (k === 'Specification' && !out.cpu) out.cpu = {name: clean(v.replace(/\s*@.*$/, '').replace(/\bCPU\b/, ''))};
        if (k === 'Number of cores' && out.cpu) out.cpu.cores = parseInt(v, 10);
        if (k === 'Number of threads' && out.cpu) out.cpu.threads = parseInt(v, 10);
        if (k === 'Max frequency' && out.cpu) out.cpu.boostGHz = parseFloat(v) / 1000;
      } else if (mode === 'board') {
        if (k === 'Mainboard Vendor') out.boardVendor = v;
        if (k === 'Mainboard Model') out.board = clean(`${out.boardVendor || ''} ${v.replace(/\(0x.*$/, '')}`);
      } else if (mode === 'mem') {
        if (k === 'Memory Type') out.memory.type = v;
        if (k === 'Memory Size') out.memory.totalGB = ramGB(parseFloat(v));
      } else if (mode === 'spd') {
        if (k === 'DIMM #') { stick = {slot: v}; out.memory.sticks.push(stick); }
        if (!stick) continue;
        if (k === 'Memory type') stick.type = v.replace(/\s*\(.*/, '');
        if (k === 'Module format') stick.formFactor = /SO/i.test(v) ? 'SODIMM' : 'UDIMM';
        if (k === 'Manufacturer (ID)' || k === 'Module Manufacturer(ID)' || k === 'Module Manufacturer (ID)') stick.manufacturer = v.replace(/\s*\(.*/, '');
        if (k === 'Size') stick.sizeGB = ramGB(parseFloat(v) / (/MB/i.test(v) ? 1024 : 1));
        if (k === 'Max bandwidth') { const s = /(\d{3,4})\s*MHz/.exec(v); if (s) stick.speed = +s[1] * 2; }
        if (k === 'Part number') stick.partNumber = v;
      } else if (mode === 'gpu') {
        if (k === 'Name') { gpu = {model: clean(v)}; out.gpus.push(gpu); }
        if (gpu && (k === 'Memory size' || k === 'Memory Size')) gpu.vramGB = Math.round(parseFloat(v) / (/MB/i.test(v) ? 1024 : 1));
      }
    }
    const host = /Computer name\s*\t+(.+)/i.exec(text);
    if (host) out.hostname = host[1].trim();
    const os = /Windows Version\s*\t+(.+)/i.exec(text);
    if (os) out.os = os[1].trim();
    return out;
  }

  /* ---------------------------------------------------------------- this app's own scan (systeminformation) */
  function fromSystemInformation(r) {
    const out = {source: 'scan', hostname: r.osInfo?.hostname, os: [r.osInfo?.distro, r.osInfo?.release].filter(Boolean).join(' '), disks: [], gpus: [], nics: [], memory: {sticks: []}};
    const sysName = clean(`${r.system?.manufacturer || ''} ${r.system?.model || ''}`);
    out.board = clean(`${r.baseboard?.manufacturer || ''} ${r.baseboard?.model || ''}`);
    // a pre-built (HP, Dell, Lenovo...) has its own product name; a DIY board just repeats the board's
    const diy = !r.system?.model || /to be filled|default string|system product name|o\.e\.m|^ms-\w{4}$/i.test(r.system.model) || out.board.includes(r.system.model);
    if (sysName && !diy) out.system = sysName;
    const c = r.cpu || {};
    out.cpu = {name: clean(`${c.manufacturer || ''} ${c.brand || ''}`), cores: c.physicalCores || null, threads: c.cores || null, baseGHz: c.speed || null, boostGHz: c.speedMax || null, socket: c.socket};
    const layout = r.memLayout || [];
    out.memory.slots = layout.length || null;
    for (const s of layout) if (s.size > 0) out.memory.sticks.push({sizeGB: ramGB(s.size / 1073741824), type: s.type, speed: s.clockSpeed, manufacturer: s.manufacturer, partNumber: (s.partNum || '').trim(), formFactor: /SO/i.test(s.formFactor || '') ? 'SODIMM' : 'UDIMM', slot: s.bank});
    out.memory.totalGB = r.mem?.total ? ramGB(r.mem.total / 1073741824) : null;
    for (const d of r.diskLayout || []) {
      if (/usb/i.test(d.interfaceType || '') || d.size < 8e9) continue;
      const nvme = /nvme/i.test(`${d.interfaceType} ${d.name} ${d.device}`);
      const kind = nvme ? 'NVMe SSD' : d.type === 'HD' ? 'HDD' : 'SATA SSD';
      const disk = {model: clean(d.name || d.model), sizeGB: marketing(d.size / 1e9), kind, formFactor: nvme ? 'M.2' : kind === 'HDD' ? '3.5"' : '2.5"', vendor: d.vendor};
      if (d.smartData) {
        const sd = d.smartData;
        disk.health = {status: d.smartStatus, powerOnHours: sd.power_on_time?.hours ?? null, percentUsed: sd.nvme_smart_health_information_log?.percentage_used ?? null};
      } else if (d.smartStatus && d.smartStatus !== 'unknown') disk.health = {status: d.smartStatus};
      out.disks.push(disk);
    }
    for (const g of r.graphics?.controllers || []) out.gpus.push({model: clean(g.model || g.name), vramGB: g.vram ? Math.round(g.vram / 1024) : null});
    for (const n of r.networkInterfaces || []) {
      if (n.internal || n.virtual || !n.mac || /loopback|vethernet|virtual|vpn|tap|tun|wsl|hyper-v|bluetooth/i.test(`${n.iface} ${n.ifaceName}`)) continue;
      out.nics.push({model: clean(n.ifaceName || n.iface), iface: n.iface, speedMbps: n.speed || null, type: n.type});
      if (!out.ip && n.ip4 && n.operstate === 'up') out.ip = n.ip4;
    }
    return out;
  }

  function detect(text) {
    if (/Processors Information|CPU-Z TXT Report/i.test(text)) return parseCpuz(text);
    if (/\b(Machine|CPU|Drives):\s/.test(text)) return parseInxi(text);
    // last resort: find a CPU/GPU name anywhere in the text
    const db = DB();
    const cpu = db.findCPU(text), gpu = db.findGPU(text);
    return {source: 'text', cpu: cpu ? {name: cpu.name} : null, gpus: gpu ? [{model: gpu.name}] : [], disks: [], nics: [], memory: {sticks: []}};
  }

  /* ---------------------------------------------------------------- report -> proposed build + parts */
  function toProposal(rep) {
    const db = DB();
    const parts = [];
    const add = (p) => parts.push({verdict: 'Keep', tested: true, qty: 1, attrs: {}, notes: '', model: '', specs: '', ...p});
    let socket = '', memType = '';
    if (rep.system) add({type: 'System', item: rep.system, specs: rep.board ? `Board: ${rep.board}` : '', notes: 'Chassis, board and PSU as one unit (pre-built).'});
    else if (rep.board) add({type: 'Motherboard', item: rep.board});
    if (rep.cpu?.name) {
      const hit = db.findCPU(rep.cpu.name);
      const attrs = db.cpuAttrs(rep.cpu.name, {cores: rep.cpu.cores, threads: rep.cpu.threads});
      if (!hit && rep.cpu.cores) Object.assign(attrs, {score: db.cpuScore({cores: rep.cpu.cores, threads: rep.cpu.threads, boostGHz: rep.cpu.boostGHz || rep.cpu.baseGHz})});
      socket = attrs.socket || '';
      add({type: 'CPU', item: hit ? hit.name : rep.cpu.name, specs: hit ? db.specLine(hit) : [rep.cpu.cores && `${rep.cpu.cores}C/${rep.cpu.threads || rep.cpu.cores}T`, rep.cpu.boostGHz && `${rep.cpu.boostGHz} GHz`].filter(Boolean).join(', '), attrs});
      if (hit) memType = hit.memTypes.length === 1 ? hit.memTypes[0] : '';
    }
    const sticks = rep.memory?.sticks || [];
    for (const s of sticks) {
      const type = /DDR\d/i.exec(s.type || rep.memory.type || '')?.[0]?.toUpperCase() || memType;
      memType = type || memType;
      add({type: 'RAM', item: `${[s.manufacturer && !/unknown|undefined/i.test(s.manufacturer) ? clean(s.manufacturer) : '', `${s.sizeGB}GB`, type, s.speed ? `-${s.speed}` : ''].filter(Boolean).join(' ').replace(' -', '-')}`, model: s.partNumber || '', specs: [s.formFactor || 'UDIMM', s.slot].filter(Boolean).join(', '),
        attrs: {memType: type, memForm: s.formFactor || 'UDIMM', capacityGB: s.sizeGB, speed: s.speed || null}});
    }
    if (!sticks.length && rep.memory?.totalGB) {
      add({type: 'RAM', item: `${rep.memory.totalGB}GB ${memType} (module not identified)`.replace('  ', ' '), notes: 'The report only gave total memory. Edit this if it is more than one stick.', attrs: {memType, memForm: 'UDIMM', capacityGB: rep.memory.totalGB}});
    }
    for (const g of rep.gpus || []) {
      if (db.isIntegratedGPU(g.model)) continue;
      const hit = db.findGPU(g.model);
      add({type: 'GPU', item: hit ? `${hit.name}${g.vramGB && g.vramGB !== hit.vramGB ? ` ${g.vramGB}GB` : ''}` : g.model, specs: hit ? `${g.vramGB || hit.vramGB}GB, ${hit.tdpW}W, ${hit.power} power` : '', attrs: {vramGB: g.vramGB || hit?.vramGB || null, tdpW: hit?.tdpW, perf: hit?.perf}});
    }
    for (const d of rep.disks || []) {
      const attrs = {kind: d.kind, formFactor: d.formFactor || (d.kind === 'NVMe SSD' ? 'M.2' : ''), capacityGB: d.sizeGB};
      if (d.health?.powerOnHours != null) attrs.powerOnHours = d.health.powerOnHours;
      if (d.health?.percentUsed != null) attrs.healthPct = Math.max(0, 100 - d.health.percentUsed);
      add({type: 'Storage', item: `${d.model}${d.sizeGB && !new RegExp(`${d.sizeGB}|${d.sizeGB / 1000}T`, 'i').test(d.model) ? ` ${d.sizeGB >= 1000 ? d.sizeGB / 1000 + 'TB' : d.sizeGB + 'GB'}` : ''}`, specs: [d.kind, d.formFactor].filter(Boolean).join(', '), attrs,
        notes: d.health?.status && d.health.status !== 'Ok' ? `SMART status: ${d.health.status}` : ''});
    }
    for (const n of rep.nics || []) {
      if (/wi-?fi|wireless|802\.11|wlan/i.test(n.model) || !/ethernet|gbe|nic|realtek|intel|i2\d\d|rtl|killer|aquantia|marvell|broadcom/i.test(n.model)) continue;
      add({type: 'Network', item: n.model, specs: [n.iface && `interface ${n.iface}`, n.speedMbps && `${n.speedMbps >= 1000 ? n.speedMbps / 1000 + ' Gbps' : n.speedMbps + ' Mbps'} link`].filter(Boolean).join(', '), notes: 'Onboard network port.', attrs: {linkGbps: n.speedMbps ? n.speedMbps / 1000 : null}});
    }
    const name = rep.hostname ? rep.hostname.replace(/[-_](win\d*|pc|desktop)$/i, '').replace(/^./, (c) => c.toUpperCase()) : (rep.system || rep.cpu?.name || 'New build');
    const plat = {socket, memType, memForm: sticks[0]?.formFactor || 'UDIMM', ramSlots: rep.memory?.slots || null, maxRamGB: null, m2Slots: null, sataPorts: null, pcieFree: null};
    return {
      build: {name, role: '', ip: rep.ip || '', os: rep.os || '', notes: `Imported from ${({scan: 'a scan of this PC', inxi: 'inxi output', cpuz: 'a CPU-Z report', text: 'pasted text'})[rep.source] || 'a report'} on ${new Date().toISOString().slice(0, 10)}.`, platform: plat},
      parts,
    };
  }

  const api = {parseInxi, parseCpuz, fromSystemInformation, detect, toProposal, marketing};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Importers = api;
})(typeof window !== 'undefined' ? window : globalThis);
