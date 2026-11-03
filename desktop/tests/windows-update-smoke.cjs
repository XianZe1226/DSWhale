'use strict';
// CI-only: never installs an application on a developer's own Windows profile.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { windowsUpdateArgs, windowsSpawnOptions } = require('../lib/installer.cjs');

async function run(file, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...windowsSpawnOptions, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native installation timed out')); }, 180000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Native installer could not start')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Native installation failed')); });
  });
}

async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This test only runs on disposable GitHub runners');
  assert.ok(process.env.RUNNER_TEMP && process.env.APPDATA);
  const out = path.resolve('desktop-dist');
  const names = (await fs.readdir(out)).filter(n => /^DSWhale-.*-Windows-x86_64-setup\.exe$/.test(n));
  assert.equal(names.length, 1);
  const installer = path.join(out, names[0]);
  const folder = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'dswhale-native-update-'));
  const target = path.join(folder, 'DSWhale 中文 空格 & path');
  const profile = path.join(process.env.APPDATA, 'DSWhale');
  await fs.mkdir(path.join(profile, 'napcat/qq-data'), { recursive: true });
  const marker = path.join(profile, 'napcat/qq-data/dswhale-synthetic-upgrade-marker');
  const bytes = Buffer.from('SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT');
  await fs.writeFile(marker, bytes, { flag: 'wx' });
  await run(installer, ['/S', '/currentuser', `/D=${target}`]);
  const exe = path.join(target, 'DSWhale.exe');
  assert.equal((await fs.stat(exe)).isFile(), true, 'First install must use the exact requested directory');
  const args = windowsUpdateArgs(exe);
  assert.equal(args.at(-1), `/D=${target}`);
  await run(installer, [...args.slice(0, -1), '/S', args.at(-1)]);
  assert.equal((await fs.stat(exe)).isFile(), true);
  assert.deepEqual(await fs.readFile(marker), bytes);
  assert.equal((await fs.stat(path.join(target, 'resources/app.asar'))).isFile(), true);
  console.log('Native NSIS first install and update retained the exact Chinese/space path and synthetic QQ data');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
