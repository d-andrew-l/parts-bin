// Prints this machine's raw systeminformation scan as JSON (handy for bug reports and test fixtures).
// Usage: node scripts/dump-scan.mjs > scan.json
import si from 'systeminformation';

const r = await si.get({
  osInfo: 'hostname,distro,release', system: 'manufacturer,model', baseboard: 'manufacturer,model',
  cpu: 'manufacturer,brand,physicalCores,cores,speed,speedMax,socket', mem: 'total',
  memLayout: '*', diskLayout: '*', graphics: 'controllers', networkInterfaces: '*',
});
process.stdout.write(JSON.stringify(r, null, 1));
