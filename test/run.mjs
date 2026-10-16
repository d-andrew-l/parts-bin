// Parts Bin test suite: node test/run.mjs  (also run by CI on every push)
import {createRequire} from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const DB = require('../src/partsdb.js');
DB.init({...require('../db/cpus.json'), ...require('../db/gpus.json'), boards: require('../db/boards.json').boards});
const Model = require('../src/model.js');
const O = require('../src/optimizer.js');
const I = require('../src/importers.js');
const fixture = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

let fail = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { fail++; console.log(`FAIL  ${msg}`); } else if (process.argv.includes('-v')) console.log(`pass  ${msg}`); };
const section = (s) => process.argv.includes('-v') && console.log(`\n# ${s}`);

section('parts database');
ok(DB.cpuKeys('Intel(R) Core(TM) i5-10500 CPU @ 3.10GHz').includes('i5-10500'), 'reads an Intel brand string');
ok(DB.findCPU('Intel Core i5-10400F')?.key === 'i5-10400', 'F (no iGPU) suffix falls back to the base model');
ok(DB.findCPU('AMD Ryzen 7 5800X3D 8-Core Processor')?.key === 'r7-5800x3d', 'reads an AMD brand string');
ok(DB.findCPU('Intel Pentium G2130')?.socket === 'LGA1155', 'Pentium lookup');
ok(DB.findGPU('NVIDIA GeForce RTX 4060 Ti')?.key === 'rtx4060ti', 'GPU lookup');
ok(DB.findGPU('Radeon RX 6600 XT')?.key === 'rx6600xt', 'AMD GPU lookup');
ok(DB.isIntegratedGPU('Intel CometLake-S GT2 [UHD Graphics 630]'), 'integrated graphics are recognised');
const s = (k) => DB.cpuScore(DB.findCPU(k));
ok(s('i5-10500') > s('i5-9500') && s('i5-9500') > s('i5-7500') && s('i5-7500') > s('i5-6500') && s('i5-6500') > s('g2130'), 'score ordering across generations');
ok(s('i5-12600k') > s('i5-10500') * 1.5, 'Alder Lake P+E score is well above Comet Lake');
ok(new Set(DB.cpus.map((c) => c.key)).size === DB.cpus.length, 'CPU keys are unique');
ok(new Set(DB.gpus.map((g) => g.key)).size === DB.gpus.length, 'GPU keys are unique');

section('model + migration');
const v1 = {version: 1, builds: [{id: 'saturn', name: 'Saturn', platform: {socket: 'LGA1200'}}], parts: [
  {id: 'a', type: 'CPU', item: 'Intel Core i5-10500', use: 'other', location: 'Cold spare', attrs: {socket: 'LGA1200', score: 12300}},
  {id: 'b', type: 'RAM', item: 'Stick', attrs: {memType: 'DDR4', capacityGB: 8}, deleted: 1}]};
const m = Model.migrate(structuredClone(v1));
ok(m.version === 2 && m.settings.welcomed === true, 'v1 data migrates to v2 and skips the welcome screen');
ok(m.parts[0].useNote === 'Cold spare' && !('location' in m.parts[0]), 'v1 location becomes useNote');
ok(m.parts[0].attrs.score === s('i5-10500'), 'PassMark score is replaced by the Parts Bin score');
ok(m.parts.length === 1, 'trash older than 30 days is emptied');
ok(Array.isArray(m.parts[0].tests) && m.parts[0].qty === 1, 'new fields get defaults');

section('importers');
const inxi = I.toProposal(I.parseInxi(fixture('inxi-prodesk.txt')));
ok(inxi.build.os === 'Debian GNU/Linux 13 (trixie)', 'inxi: OS');
ok(inxi.parts.some((p) => p.type === 'System' && /ProDesk 400 G7/.test(p.item)), 'inxi: pre-built system');
ok(inxi.parts.some((p) => p.type === 'CPU' && p.attrs.socket === 'LGA1200' && p.attrs.threads === 12), 'inxi: CPU with socket from the database');
ok(inxi.parts.some((p) => p.type === 'Storage' && p.attrs.capacityGB === 256 && p.attrs.kind === 'NVMe SSD'), 'inxi: 238 GiB NVMe reads as 256 GB');
ok(!inxi.parts.some((p) => p.type === 'GPU'), 'inxi: integrated graphics skipped');
ok(inxi.parts.some((p) => p.type === 'RAM' && p.attrs.capacityGB === 8 && p.attrs.memType === 'DDR4'), 'inxi: total RAM with type from the CPU');
const scan = I.toProposal(I.fromSystemInformation(JSON.parse(fixture('scan-workbench.json'))));
ok(scan.build.name === 'Workbench' && scan.build.platform.ramSlots === 4, 'scan: hostname and RAM slot count');
ok(scan.parts.filter((p) => p.type === 'RAM').length === 4, 'scan: every RAM stick');
ok(scan.parts.some((p) => p.type === 'Motherboard' && /^MSI PRO Z690/.test(p.item)) && !scan.parts.some((p) => p.type === 'System'), 'scan: DIY board, short vendor name');
ok(scan.parts.filter((p) => p.type === 'GPU').length === 1, 'scan: dedicated GPU only');
ok(scan.parts.filter((p) => p.type === 'Storage').length === 4, 'scan: all four drives');
ok(I.detect('random notes, there is a Ryzen 5 5600X in here').cpu?.name === 'AMD Ryzen 5 5600X', 'free text: finds a CPU name');

section('optimizer on the sample homelab');
const lab = Model.migrate(JSON.parse(fs.readFileSync(new URL('../samples/sample-homelab.json', import.meta.url))));
const B = Object.fromEntries(lab.builds.map((b) => [b.id, O.suggest(b, lab.parts)]));
const has = (id, fn) => B[id].some(fn);
ok(has('jupiter', (x) => x.action === 'replace' && x.partId === 'shelf-5700x'), 'Jupiter: 5700X from the shelf replaces the 5600X');
ok(has('jupiter', (x) => x.partId === 'shelf-ram-ddr4' && /24 GB/.test(x.reason)), 'Jupiter: spare DDR4 stick fills a free slot');
ok(has('jupiter', (x) => x.partId === 'shelf-nvme'), 'Jupiter: spare NVMe into the free M.2 slot');
ok(has('jupiter', (x) => x.action === 'buy' && /5950X/.test(x.title)), 'Jupiter: best AM4 chip listed as worth buying');
ok(!has('jupiter', (x) => x.partId === 'shelf-hdd'), 'Jupiter: no spare HDDs for a gaming box');
ok(has('mars', (x) => x.partId === 'shelf-ram-ddr4' && /dual channel/.test(x.reason)), 'Mars: second stick enables dual channel');
ok(has('mars', (x) => x.partId === 'shelf-6700' && x.action === 'replace'), 'Mars: i7-6700 replaces the i3-6100');
ok(has('mars', (x) => x.partId === 'shelf-hdd' && /2 free SATA/.test(x.reason)), 'Mars (NAS): the pair of spare HDDs, using two ports');
ok(has('mars', (x) => x.partId === 'shelf-1050ti'), 'Mars (Jellyfin): spare GPU for transcoding');
ok(has('venus', (x) => x.partId === 'shelf-1050ti'), 'Venus: low-profile GPU fits the SFF case and 240 W supply');
ok(!O.suggest({...lab.builds[2], platform: {...lab.builds[2].platform, psuW: 180}}, lab.parts).some((x) => x.partId === 'shelf-1050ti'), 'Venus: GPU rejected on a weaker power supply');
const noLP = structuredClone(lab.parts);
noLP.find((p) => p.id === 'shelf-1050ti').attrs.lowProfile = false;
ok(!O.suggest(lab.builds[2], noLP).some((x) => x.partId === 'shelf-1050ti'), 'Venus: full-height card rejected for a low-profile case');
ok(!Object.values(B).flat().some((x) => /sold|2500k|ddr3/i.test(x.partId || '')), 'sold parts and incompatible spares are never suggested');
const orph = O.orphans(lab.builds, lab.parts).map((p) => p.id);
ok(orph.includes('shelf-2500k') && orph.includes('shelf-ram-ddr3'), 'orphans: LGA1155 CPU and DDR3 sticks fit no build');
const hot = structuredClone(lab.parts);
hot.find((p) => p.id === 'jup-psu').attrs.watts = 300;
const hotS = O.suggest(lab.builds[0], hot);
ok(hotS.some((x) => x.action === 'replace' && x.partId === 'shelf-psu'), 'power: bigger spare PSU offered when the current one is tight');

section('dev boards');
ok(DB.boards.length > 1000, 'board list loaded');
ok(DB.findBoard('TI LaunchPad MSP-EXP430F5529LP')?.mcu === 'MSP430F5529', 'MSP430 LaunchPad found');
ok(DB.findBoard('esp32dev')?.name === 'Espressif ESP32 Dev Module', 'PlatformIO board id works too');
ok(DB.findBoard('my old arduino nano every board')?.name === 'Arduino Nano Every', 'finds a board inside loose text');
ok(!DB.findBoard('Some board nobody has heard of'), 'unknown boards are not guessed');
const sm = lab.parts.find((p) => p.id === 'shelf-launchpad');
ok(sm.attrs.arch === 'MSP430' && /25 MHz/.test(sm.specs), 'board parts get specs from the list');
ok(lab.parts.find((p) => p.id === 'shelf-pi4').attrs.ramGB === 4, "the user's own boards (\"Not here?\") fill details too");
ok(lab.parts.find((p) => p.id === 'shelf-bme').attrs.iface === 'I2C', 'typed details are kept for unknown modules');
ok(/Wi-Fi, Bluetooth/.test(lab.parts.find((p) => p.id === 'shelf-esp32').attrs.wireless), 'wireless labels are readable');
ok(O.suggest(lab.builds.find((b) => b.id === 'phobos'), lab.parts).length === 0, 'electronics projects get no PC upgrade suggestions');
ok(!O.orphans(lab.builds, lab.parts).some((p) => ['Dev Board', 'SBC', 'Module'].includes(p.type)), 'boards are never flagged as sell candidates');
ok(Model.fromCSV('Name,Category\nArduino Mega,Arduino\nBME280,sensor\n', [])[0].type === 'Dev Board', 'CSV maps board categories');

section('CSV');
const csv = Model.toCSV(lab);
const back = Model.fromCSV(csv, lab.builds);
ok(back.length === lab.parts.filter((p) => !p.deleted).length, 'CSV round trip keeps every part');
ok(back.find((p) => p.id === 'sold-970')?.sale.price === 75 && back.find((p) => p.id === 'jup-gpu')?.use === 'jupiter', 'CSV keeps money and status');
ok(Model.fromCSV('Name,Quantity,Category,Price\n"Fan, 120mm",4,fan,$5\n', [])[0]?.qty === 4, 'CSV: hand-made spreadsheet headers');

console.log(fail ? `${fail} of ${n} FAILED` : `all ${n} passed`);
process.exit(fail ? 1 : 0);
