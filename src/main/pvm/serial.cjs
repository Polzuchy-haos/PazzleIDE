// Список последовательных портов без нативных модулей.
'use strict';
const {execFile} = require('child_process');
const fs = require('fs');

function listPorts() {
  if (process.platform === 'win32') {
    // Реестр HARDWARE\DEVICEMAP\SERIALCOMM — то же, что показывает диспетчер устройств.
    return new Promise((resolve) => {
      execFile('reg', ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'], {windowsHide: true}, (err, stdout) => {
        if (err) return resolve([]);
        const ports = [...String(stdout).matchAll(/REG_SZ\s+(COM\d+)/g)].map((m) => m[1]);
        resolve([...new Set(ports)].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))));
      });
    });
  }
  const patterns = process.platform === 'darwin' ? [/^cu\./] : [/^ttyUSB\d+$/, /^ttyACM\d+$/, /^ttyS\d+$/, /^ttyAMA\d+$/];
  try {
    return Promise.resolve(
      fs
        .readdirSync('/dev')
        .filter((n) => patterns.some((p) => p.test(n)))
        .map((n) => '/dev/' + n)
        .sort(),
    );
  } catch {
    return Promise.resolve([]);
  }
}

module.exports = {listPorts};
