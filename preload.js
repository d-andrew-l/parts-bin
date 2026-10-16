// The only bridge between the window and the OS. Every call is a named, single-purpose IPC message.
const {contextBridge, ipcRenderer} = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('bin', {
  load: call('data:load'), save: call('data:save'), exportData: call('data:export'), importData: call('data:import'), openFolder: call('data:openFolder'),
  backups: call('backups:list'), restoreBackup: call('backups:restore'), backupNow: call('backups:now'),
  exportCSV: call('csv:export'), importCSV: call('csv:import'), openReport: call('report:text'),
  printPDF: call('print:pdf'), printDialog: call('print:dialog'),
  addPhotos: call('photos:add'), openPhoto: call('photos:open'), deletePhotos: call('photos:delete'),
  scan: call('scan'), partsDB: call('db:load'), sample: call('sample:load'), qr: call('qr'),
  info: call('app:info'), setTheme: call('theme:set'), setZoom: call('zoom:set'), openLink: call('link:open'), checkUpdates: call('update:check'),
});
