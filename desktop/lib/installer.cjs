'use strict';
const path = require('node:path');
const { spawn: spawnProcess } = require('node:child_process');
// NSIS consumes the final /D= suffix as a raw directory, including spaces.
// Node's usual argv quoting would leave a trailing quote in that directory.
const windowsSpawnOptions = Object.freeze({shell:false,windowsVerbatimArguments:true});

function windowsUpdateArgs(exePath) {
  if (typeof exePath !== 'string' || !/^[a-z]:\\/i.test(exePath) || /[\x00-\x1f"\x7f]/.test(exePath)
    || path.win32.basename(exePath).toLowerCase() !== 'dswhale.exe') throw new Error('无法确认当前应用安装位置，请使用官方安装包');
  const directory = path.win32.dirname(exePath);
  if (directory === path.win32.parse(directory).root) throw new Error('当前应用安装位置无效');
  // NSIS requires /D to be last. Pass a single argv value through CreateProcess,
  // never a shell command; the destination comes from this process, not the UI.
  return ['--updated', '/currentuser', `/D=${directory}`];
}

function launchWindowsUpdate({ file, exePath, signal, spawn = spawnProcess }) {
  if (signal?.aborted) return Promise.reject(new Error('安装已取消'));
  const args = windowsUpdateArgs(exePath);
  return new Promise((resolve, reject) => {
    let child, timer;
    const finish = error => { clearTimeout(timer); error ? reject(new Error('安装程序未能打开，请重试；备份已保留')) : resolve(); };
    try {
      child = spawn(file, args, { ...windowsSpawnOptions, detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', () => finish(true));
      child.once('spawn', () => { child.unref(); finish(); });
      timer = setTimeout(() => finish(true), 5000);
    } catch { finish(true); }
  });
}

module.exports = { windowsUpdateArgs, launchWindowsUpdate, windowsSpawnOptions };
