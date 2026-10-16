// Parts Bin: Electron main process. Owns the data file, photos, backups and anything that touches the OS;
// the window only talks to it through preload.js.
const {app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, protocol, net, session} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

app.setName('Parts Bin');
app.setAppUserModelId('io.github.partsbin');
protocol.registerSchemesAsPrivileged([{scheme: 'pbin', privileges: {standard: true, secure: true, supportFetchAPI: true}}]);

// Where the inventory lives:
//  - PARTSBIN_DATA, if set (tests, portable installs)
//  - running from the project (npm start / the desktop shortcut): ./user-data next to the code (gitignored)
//  - the installed app: the OS app-data folder
const appDataDir = path.join(app.getPath('userData'), 'data');
const dataDir = process.env.PARTSBIN_DATA || (app.isPackaged ? appDataDir : path.join(__dirname, 'user-data'));
// first run from the project: bring over the existing inventory, backups and photos (copied, the original stays)
if (!process.env.PARTSBIN_DATA && dataDir !== appDataDir && !fs.existsSync(path.join(dataDir, 'inventory.json')) && fs.existsSync(path.join(appDataDir, 'inventory.json'))) {
  fs.cpSync(appDataDir, dataDir, {recursive: true, errorOnExist: false, force: false});
}
const dataFile = path.join(dataDir, 'inventory.json');
const backupDir = path.join(dataDir, 'backups');
const photoDir = path.join(dataDir, 'photos');
const KEEP_BACKUPS = 40;
let lastBackup = 0;

function readData() {
  fs.mkdirSync(dataDir, {recursive: true});
  if (!fs.existsSync(dataFile)) return null; // first run: the window shows the welcome screen
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  // keep a copy of the old format before the window migrates it
  if ((data.version || 1) < 2) {
    fs.mkdirSync(backupDir, {recursive: true});
    const pre = path.join(backupDir, 'inventory-v1-before-upgrade.json');
    if (!fs.existsSync(pre)) fs.copyFileSync(dataFile, pre);
  }
  return data;
}

// one timestamped copy of the previous file every 10 minutes of editing, newest KEEP_BACKUPS kept
function backup(force) {
  if (!fs.existsSync(dataFile) || (!force && Date.now() - lastBackup < 10 * 60 * 1000)) return;
  fs.mkdirSync(backupDir, {recursive: true});
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  fs.copyFileSync(dataFile, path.join(backupDir, `inventory-${stamp}.json`));
  lastBackup = Date.now();
  const old = fs.readdirSync(backupDir).filter((f) => /^inventory-\d/.test(f)).sort().slice(0, -KEEP_BACKUPS);
  for (const f of old) fs.rmSync(path.join(backupDir, f));
}

function save(data) {
  fs.mkdirSync(dataDir, {recursive: true});
  backup(false);
  const tmp = dataFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, dataFile); // atomic replace, a crash mid-write can't corrupt the file
  return {ok: true, at: Date.now()};
}

const win = (e) => BrowserWindow.fromWebContents(e.sender);
const docs = (name) => path.join(app.getPath('documents'), name);
const today = () => new Date().toISOString().slice(0, 10);
async function saveAs(e, title, defaultName, ext, write) {
  const {canceled, filePath} = await dialog.showSaveDialog(win(e), {title, defaultPath: docs(defaultName), filters: [{name: ext.toUpperCase(), extensions: [ext]}]});
  if (canceled || !filePath) return {ok: false};
  await write(filePath);
  return {ok: true, filePath};
}
async function openOne(e, title, exts) {
  const {canceled, filePaths} = await dialog.showOpenDialog(win(e), {title, filters: [{name: exts.join(', ').toUpperCase(), extensions: exts}], properties: ['openFile']});
  return canceled || !filePaths[0] ? null : filePaths[0];
}

/* ---------------------------------------------------------------- data */
ipcMain.handle('data:load', () => ({data: readData(), file: dataFile, dir: dataDir}));
ipcMain.handle('data:save', (_e, data) => save(data));
ipcMain.handle('data:openFolder', () => shell.openPath(dataDir));
ipcMain.handle('data:export', (e, data) => saveAs(e, 'Export inventory', `parts-bin-${today()}.json`, 'json', (f) => fs.writeFileSync(f, JSON.stringify(data, null, 1))));
ipcMain.handle('data:import', async (e) => {
  const f = await openOne(e, 'Import inventory (replaces the current data; a backup is kept)', ['json']);
  if (!f) return {ok: false};
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!Array.isArray(data.parts) || !Array.isArray(data.builds)) return {ok: false, error: 'Not a Parts Bin file (needs parts and builds).'};
  backup(true);
  return {ok: true, data};
});
ipcMain.handle('backups:list', () => {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir).filter((f) => f.endsWith('.json')).sort().reverse().map((name) => {
    const full = path.join(backupDir, name);
    let parts = null, builds = null;
    try { const d = JSON.parse(fs.readFileSync(full, 'utf8')); parts = d.parts?.filter((p) => !p.deleted).length; builds = d.builds?.length; } catch {}
    return {name, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs, parts, builds};
  });
});
ipcMain.handle('backups:restore', (_e, name) => {
  const full = path.join(backupDir, path.basename(name));
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  backup(true); // the current state becomes a backup too, so a restore can be undone
  return data;
});
ipcMain.handle('backups:now', () => { backup(true); return true; });

/* ---------------------------------------------------------------- csv, pdf */
ipcMain.handle('csv:export', (e, text) => saveAs(e, 'Export parts as CSV', `parts-bin-${today()}.csv`, 'csv', (f) => fs.writeFileSync(f, '﻿' + text)));
ipcMain.handle('csv:import', async (e) => {
  const f = await openOne(e, 'Import parts from CSV', ['csv', 'txt']);
  return f ? fs.readFileSync(f, 'utf8') : null;
});
ipcMain.handle('report:text', async (e) => {
  const f = await openOne(e, 'Open a hardware report (inxi, CPU-Z)', ['txt', 'log', 'json']);
  return f ? fs.readFileSync(f, 'utf8') : null;
});
// prints whatever the window put in its print area to a PDF or a printer. Label sheets use no margins
// (the page CSS positions them for Avery sheets); reports get normal margins.
const pageOpts = (kind) => kind === 'labels'
  ? {printBackground: true, pageSize: 'Letter', preferCSSPageSize: true, margins: {marginType: 'none'}}
  : {printBackground: true, pageSize: 'Letter', margins: {marginType: 'custom', top: 0.5, bottom: 0.5, left: 0.5, right: 0.5}};
ipcMain.handle('print:pdf', (e, name, kind) => saveAs(e, 'Save PDF', name, 'pdf', async (f) => {
  fs.writeFileSync(f, await e.sender.printToPDF(pageOpts(kind)));
  shell.openPath(f);
}));
ipcMain.handle('print:dialog', (e, kind) => new Promise((res) => {
  const o = pageOpts(kind);
  e.sender.print({printBackground: true, margins: kind === 'labels' ? {marginType: 'none'} : {marginType: 'default'}, pageSize: o.pageSize}, (ok, why) => res({ok, why}));
}));

/* ---------------------------------------------------------------- photos */
ipcMain.handle('photos:add', async (e, partId) => {
  const {canceled, filePaths} = await dialog.showOpenDialog(win(e), {title: 'Add photos', filters: [{name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic']}], properties: ['openFile', 'multiSelections']});
  if (canceled) return [];
  fs.mkdirSync(photoDir, {recursive: true});
  return filePaths.map((src, i) => {
    const name = `${String(partId).replace(/[^\w-]/g, '')}-${Date.now()}-${i}${path.extname(src).toLowerCase()}`;
    fs.copyFileSync(src, path.join(photoDir, name));
    return name;
  });
});
ipcMain.handle('photos:open', (_e, name) => shell.openPath(path.join(photoDir, path.basename(name))));
ipcMain.handle('photos:delete', (_e, names) => {
  for (const n of [].concat(names)) { const f = path.join(photoDir, path.basename(n)); if (fs.existsSync(f)) fs.rmSync(f); }
  return true;
});

/* ---------------------------------------------------------------- hardware scan, parts db, qr, sample */
ipcMain.handle('scan', async () => {
  const si = require('systeminformation');
  return si.get({
    osInfo: 'hostname,distro,release', system: 'manufacturer,model', baseboard: 'manufacturer,model',
    cpu: 'manufacturer,brand,physicalCores,cores,speed,speedMax,socket', mem: 'total',
    memLayout: '*', diskLayout: '*', graphics: 'controllers', networkInterfaces: '*',
  });
});
ipcMain.handle('db:load', () => ({
  ...JSON.parse(fs.readFileSync(path.join(__dirname, 'db', 'cpus.json'), 'utf8')),
  ...JSON.parse(fs.readFileSync(path.join(__dirname, 'db', 'gpus.json'), 'utf8')),
  boards: JSON.parse(fs.readFileSync(path.join(__dirname, 'db', 'boards.json'), 'utf8')).boards,
}));
ipcMain.handle('sample:load', () => JSON.parse(fs.readFileSync(path.join(__dirname, 'samples', 'sample-homelab.json'), 'utf8')));
ipcMain.handle('qr', (_e, text) => require('qrcode').toDataURL(text, {errorCorrectionLevel: 'M', margin: 1, scale: 8, color: {dark: '#241a33', light: '#ffffff'}}));

/* ---------------------------------------------------------------- app, theme, zoom, updates */
ipcMain.handle('app:info', () => ({version: app.getVersion(), packaged: app.isPackaged, dataDir, platform: process.platform}));
ipcMain.handle('theme:set', (_e, mode) => { nativeTheme.themeSource = mode; });
ipcMain.handle('zoom:set', (e, factor) => e.sender.setZoomFactor(Math.min(1.6, Math.max(0.8, +factor || 1))));
ipcMain.handle('link:open', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
let updater = null;
function getUpdater() {
  if (!app.isPackaged) return null;
  if (!updater) { updater = require('electron-updater').autoUpdater; updater.autoDownload = true; }
  return updater;
}
ipcMain.handle('update:check', async () => {
  const u = getUpdater();
  if (!u) return {status: 'dev', message: 'Updates are only checked in the installed app.'};
  try {
    const r = await u.checkForUpdatesAndNotify();
    return r?.updateInfo && r.updateInfo.version !== app.getVersion() ? {status: 'available', message: `Version ${r.updateInfo.version} is downloading; it installs when you quit.`} : {status: 'latest', message: `You're on the latest version (${app.getVersion()}).`};
  } catch (err) {
    return {status: 'error', message: `Couldn't check for updates: ${err.message}`};
  }
});

function createWindow() {
  const w = new BrowserWindow({
    width: 1480, height: 940, minWidth: 900, minHeight: 600, title: 'Parts Bin', backgroundColor: '#fff1d6',
    icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true,
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true},
  });
  w.removeMenu();
  // links open in the real browser, never inside the app
  w.webContents.setWindowOpenHandler(({url}) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return {action: 'deny'};
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') w.webContents.toggleDevTools();
  });
  w.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (process.env.PARTSBIN_SMOKE) smoke(w, process.env.PARTSBIN_SMOKE);
}

app.whenReady().then(() => {
  // photos are served from the data folder as pbin://photo/<file>
  protocol.handle('pbin', (req) => {
    const u = new URL(req.url);
    if (u.host !== 'photo') return new Response('not found', {status: 404});
    return net.fetch(pathToFileURL(path.join(photoDir, path.basename(decodeURIComponent(u.pathname)))).toString());
  });
  // the camera is only used by "Scan label"; nothing else may ask for permissions
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  createWindow();
  // background update check for the installed app, if the user hasn't turned it off
  try {
    const d = readData();
    if (d?.settings?.autoUpdate !== false) getUpdater()?.checkForUpdatesAndNotify().catch(() => {});
  } catch {}
});
app.on('window-all-closed', () => app.quit());

// test mode: run a script of UI steps, screenshot each, then quit
async function smoke(w, outDir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const errors = [];
  w.webContents.on('console-message', (e, level, message, line, source) => {
    const lv = e.level ?? level, msg = e.message ?? message;
    if (lv === 'error' || lv === 3 || lv === 'warning' || lv === 2) errors.push(`${msg} (${String(e.sourceId ?? source).split('/').pop()}:${e.lineNumber ?? line})`);
  });
  await new Promise((r) => w.webContents.once('did-finish-load', r));
  await wait(900);
  const steps = JSON.parse(fs.readFileSync(path.join(outDir, 'steps.json'), 'utf8'));
  const log = [];
  for (const [name, code] of steps) {
    try {
      log.push([name, await w.webContents.executeJavaScript(code)]);
    } catch (e) {
      log.push([name, 'ERROR ' + e.message]);
    }
    await wait(450);
    fs.writeFileSync(path.join(outDir, `${name}.png`), (await w.webContents.capturePage()).toPNG());
  }
  log.push(['console errors', errors]);
  fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify(log, null, 1));
  app.quit();
}
