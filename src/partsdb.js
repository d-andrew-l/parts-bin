// Open parts database: lookups for db/cpus.json + db/gpus.json and the Parts Bin CPU score.
// The score is our own formula (cores x clock x per-architecture IPC, SMT and E-cores weighted), so the
// project never ships proprietary benchmark numbers. Works in the app (window.PartsDB) and in Node tests.
(function (root) {
  'use strict';
  // relative instructions-per-clock by architecture (Sandy Bridge = 1.0); E = efficiency cores
  const IPC = {
    'Sandy Bridge': 1.0, 'Ivy Bridge': 1.05, Haswell: 1.15, Broadwell: 1.2, Skylake: 1.3, 'Kaby Lake': 1.3, 'Coffee Lake': 1.3, 'Comet Lake': 1.3,
    'Rocket Lake': 1.5, 'Alder Lake': 1.75, 'Raptor Lake': 1.85, 'Arrow Lake': 2.0,
    Piledriver: 0.7, Zen: 1.1, 'Zen+': 1.15, 'Zen 2': 1.4, 'Zen 3': 1.65, 'Zen 4': 1.85, 'Zen 5': 2.0,
  };
  const IPC_E = {'Alder Lake': 0.95, 'Raptor Lake': 1.0, 'Arrow Lake': 1.25};
  let cpus = [], gpus = [], boards = [], custom = [];
  const byKey = new Map(), gpuByKey = new Map(), boardByName = new Map();
  // board names compare without punctuation or case ("Arduino Uno R3" = "arduino-uno-r3")
  const norm = (s) => String(s || '').toLowerCase().replace(/\((r|tm)\)|[®™]/g, '').replace(/[^a-z0-9]+/g, '');

  function init(data) {
    cpus = data.cpus || [];
    gpus = data.gpus || [];
    boards = data.boards || [];
    byKey.clear(); gpuByKey.clear();
    for (const c of cpus) byKey.set(c.key, c);
    for (const g of gpus) gpuByKey.set(g.key, g);
    indexBoards();
  }
  // the user's own boards ("Not here? Add it") win over the built-in list
  function setCustomBoards(list) {
    custom = (list || []).map((b) => ({...b, custom: true}));
    indexBoards();
  }
  function indexBoards() {
    boardByName.clear();
    for (const b of boards) { boardByName.set(norm(b.name), b); if (b.pio && !boardByName.has(norm(b.pio))) boardByName.set(norm(b.pio), b); }
    for (const b of custom) boardByName.set(norm(b.name), b);
  }
  // exact name first, then the longest board name contained in the text (so "my Arduino Uno clone" finds Arduino Uno)
  function findBoard(text) {
    const t = norm(text);
    if (!t) return null;
    if (boardByName.has(t)) return boardByName.get(t);
    let best = null;
    for (const b of [...custom, ...boards]) {
      const n = norm(b.name);
      if (n.length >= 5 && t.includes(n) && (!best || n.length > norm(best.name).length)) best = b;
    }
    return best;
  }
  const RADIO = {wifi: 'Wi-Fi', bluetooth: 'Bluetooth', ethernet: 'Ethernet', can: 'CAN', lora: 'LoRa', zigbee: 'Zigbee', thread: 'Thread', cellular: 'Cellular'};
  const radios = (w) => (Array.isArray(w) ? w.map((x) => RADIO[String(x).toLowerCase()] || x).join(', ') : w);
  const boardSpec = (b) => [b.mcu, b.arch, b.mhz && `${b.mhz} MHz`, b.flashKB && `${b.flashKB >= 1024 ? +(b.flashKB / 1024).toFixed(1) + ' MB' : b.flashKB + ' KB'} flash`,
    b.ramKB && `${b.ramKB >= 1024 ? +(b.ramKB / 1024).toFixed(1) + ' MB' : b.ramKB + ' KB'} RAM`, b.ramGB && `${b.ramGB} GB RAM`, b.cores && `${b.cores} cores`,
    b.wireless?.length && radios(b.wireless)].filter(Boolean).join(', ');
  // a board's specs as part attrs, keeping anything the user typed
  function boardAttrs(b, attrs = {}) {
    const base = {vendor: b.vendor, mcu: b.mcu, arch: b.arch, mhz: b.mhz, flashKB: b.flashKB, ramKB: b.ramKB, ramGB: b.ramGB, cores: b.cores,
      wireless: radios(b.wireless), voltage: b.voltage, moduleKind: b.moduleKind, iface: b.iface};
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));
    return {...clean(base), ...clean(attrs)};
  }

  // CPU score: P-cores at full IPC, E-cores at their own IPC and ~75% clock, SMT threads worth 25% of a core
  function cpuScore({cores, threads, boostGHz, baseGHz, arch, pCores, eCores}) {
    const ghz = boostGHz || baseGHz;
    if (!cores || !ghz) return null;
    const ipc = IPC[arch] || 1.3;
    const p = pCores || cores, e = eCores || 0;
    const smt = Math.max(0, (threads || cores) - cores);
    return Math.round(100 * (p * ipc * ghz + e * (IPC_E[arch] || ipc * 0.55) * ghz * 0.75 + smt * 0.25 * ipc * ghz));
  }

  // pull a model key out of whatever text a tool or a person wrote
  function cpuKeys(text) {
    const t = String(text || '').toLowerCase().replace(/\((r|tm)\)/g, ' ').replace(/\s+/g, ' ');
    const keys = [];
    let m;
    if ((m = /\bi([3579])[- ]?(\d{4,5})([a-z]{0,2})\b/.exec(t))) keys.push(`i${m[1]}-${m[2]}${m[3]}`, `i${m[1]}-${m[2]}${m[3].replace(/f|t|s/g, '')}`, `i${m[1]}-${m[2]}`);
    if ((m = /ultra\s*([579])\s*(\d{3})([a-z]{0,2})/.exec(t))) keys.push(`ultra${m[1]}-${m[2]}${m[3]}`, `ultra${m[1]}-${m[2]}`);
    if ((m = /ryzen\s*([3579])\s*(?:pro\s*)?(\d{4})(x3d|xt|x|g|ge|f)?/.exec(t))) keys.push(`r${m[1]}-${m[2]}${m[3] || ''}`, `r${m[1]}-${m[2]}`);
    if ((m = /\bfx-?\s?(\d{4})/.exec(t))) keys.push(`fx-${m[1]}`);
    if ((m = /\b(g\d{3,4})[a-z]?\b/.exec(t)) && /pentium|celeron|gold|\bg\d/.test(t)) keys.push(m[1]);
    return [...new Set(keys)];
  }
  function findCPU(text) {
    for (const k of cpuKeys(text)) if (byKey.has(k)) return byKey.get(k);
    return null;
  }
  function gpuKey(text) {
    const t = String(text || '').toLowerCase().replace(/nvidia|geforce|amd|radeon|intel|graphics|\(tm\)|\[|\]|\(r\)/g, ' ');
    let m;
    if ((m = /\b(rtx|gtx|gt)\s*(\d{3,4})\s*(ti|super)?\s*(super)?/.exec(t))) return `${m[1]}${m[2]}${m[3] || ''}${m[4] || ''}`;
    if ((m = /\brx\s*(\d{3,4})\s*(xt|gre)?/.exec(t))) return `rx${m[1]}${m[2] || ''}`;
    if ((m = /\barc\s*([ab]\d{3})/.exec(t))) return `arc${m[1]}`;
    return null;
  }
  const findGPU = (text) => gpuByKey.get(gpuKey(text)) || null;
  // integrated graphics show up as "GPUs" in scans; they aren't parts you can pull
  const isIntegratedGPU = (name) => /uhd|hd graphics|iris|\bvega\s*\d+\b|radeon\(tm\) graphics|radeon graphics|integrated|microsoft basic|virtual|vmware|virtualbox|llvmpipe|parsec|meta/i.test(String(name || ''));

  // fill a CPU part's attrs from the database, keeping anything the user typed
  function cpuAttrs(text, attrs = {}) {
    const c = findCPU(text);
    if (!c) return attrs;
    return {
      socket: c.socket, cores: c.cores, threads: c.threads, boostGHz: c.boostGHz, tdpW: c.tdpW, arch: c.arch,
      ...(c.pCores ? {pCores: c.pCores, eCores: c.eCores} : {}),
      ...Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== '' && v != null)),
      score: cpuScore(c),
    };
  }
  const specLine = (c) => `${c.pCores ? `${c.cores}C (${c.pCores}P+${c.eCores}E)` : `${c.cores}C`}/${c.threads}T, ${c.baseGHz} GHz${c.boostGHz > c.baseGHz ? ` (${c.boostGHz} boost)` : ''}, ${c.socket}, ${c.arch}`;
  const bestForSocket = (socket, memType) => cpus.filter((c) => c.socket === socket && (!memType || c.memTypes.includes(memType))).map((c) => ({...c, score: cpuScore(c)})).sort((a, b) => b.score - a.score);

  const api = {init, setCustomBoards, findBoard, boardAttrs, boardSpec, get boards() { return [...custom, ...boards]; }, cpuScore, findCPU, findGPU, cpuKeys, gpuKey, isIntegratedGPU, cpuAttrs, specLine, bestForSocket, get cpus() { return cpus; }, get gpus() { return gpus; }};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PartsDB = api;
})(typeof window !== 'undefined' ? window : globalThis);
