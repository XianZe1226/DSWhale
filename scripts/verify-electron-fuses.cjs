'use strict';

const path = require('node:path');
const { getCurrentFuseWire, FuseVersion, FuseV1Options } = require('@electron/fuses');

async function verifyBinary(binary) {
  const wire = await getCurrentFuseWire(binary);
  if (wire.version !== FuseVersion.V1) throw new Error('Unsupported Electron fuse version');
  for (const name of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) {
    // Electron's binary fuse wire encodes disabled as the ASCII digit 0.
    if (wire[FuseV1Options[name]] !== '0'.charCodeAt(0)) throw new Error(`Packaged Electron fuse must be disabled: ${name}`);
  }
  return true;
}

if (require.main === module) {
  const targets = { darwin: 'mac-arm64/DSWhale.app', win32: 'win-unpacked/DSWhale.exe', linux: 'linux-unpacked/dswhale' };
  if (!targets[process.platform]) throw new Error('Unsupported native build platform');
  verifyBinary(path.resolve('desktop-dist', targets[process.platform])).then(() => {
    console.log('Packaged Electron GUI startup fuses verified');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { verifyBinary };
