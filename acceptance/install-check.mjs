#!/usr/bin/env node
// Acceptance-only real installer/upgrade smoke. No app launch, QQ, SDK or account use yet.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

const root = process.cwd();
const lock = JSON.parse(await fsp.readFile(path.join(root, 'acceptance/a12-binaries.lock.json'), 'utf8'));
const binaryRoot = process.env.BINARY_ROOT;
if (!binaryRoot) throw new Error('BINARY_ROOT is required');
const require = createRequire(path.join(binaryRoot, 'desktop/lib/'));
const {windowsUpdateArgs, windowsSpawnOptions} = require('./installer.cjs');
const {listPackage} = createRequire(path.join(root, 'acceptance/package.json'))('@electron/asar');
const token = process.env.GITHUB_TOKEN || '';
const platform = process.platform;
const mode = process.argv.find(v => v.startsWith('--case='))?.split('=')[1] || 'cross-small';
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:^GH_|^GITHUB_|^ACTIONS_|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|^ASTRBOT_ROOT$|^DSWHALE_)/i.test(key)));
const temp = await fsp.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'a12-install-'));
const result = {schemaVersion: 1, harnessCommit: process.env.HARNESS_COMMIT || '', binaryCommit: lock.candidate.binaryCommit, repository: lock.repository, runId: lock.candidate.runId, case: mode, platform, arch: process.arch, os: os.version?.() || os.release(), checks: {}, passed: false, errors: []};
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
async function sha256File(file) { const h = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) h.update(chunk); return h.digest('hex'); }
function safeName(name) { if (!name || path.isAbsolute(name) || name.includes('..') || name.includes('\\') || name.includes('\0')) throw new Error(`unsafe member ${name}`); return name; }
function zipExtract(file, dir) {
  if (platform === 'win32') execFileSync('tar', ['-xf', file, '-C', dir], {env: safeEnv});
  else execFileSync('unzip', ['-q', file, '-d', dir], {env: safeEnv});
}
async function download(url, file, headers = {}) { const response = await fetch(url, {headers, redirect: 'follow'}); if (!response.ok) throw new Error(`download ${response.status}`); await fsp.writeFile(file, Buffer.from(await response.arrayBuffer())); }
async function artifactZip(platformName) {
  const artifact = lock.candidate.artifacts.find(item => item.name === platformName);
  if (!artifact) throw new Error(`missing artifact for ${platformName}`);
  const file = path.join(temp, `${platformName}.zip`);
  await download(`https://api.github.com/repos/${lock.repository}/actions/artifacts/${artifact.id}/zip`, file, {Authorization: `Bearer ${token}`});
  if (await sha256File(file) !== artifact.digest.replace(/^sha256:/, '')) throw new Error('artifact ZIP hash mismatch');
  return file;
}
async function releaseAsset(name) {
  const asset = lock.old.assets.find(item => item.name === name);
  if (!asset) throw new Error(`missing old asset ${name}`);
  const file = path.join(temp, name);
  await download(asset.browser_download_url, file);
  if ((await fsp.stat(file)).size !== asset.size) throw new Error(`old ${name} size mismatch`);
  if (await sha256File(file) !== asset.sha256) throw new Error(`old ${name} hash mismatch`);
  return file;
}
function installedAsarVersion(asar) { const pkg = JSON.parse(execFileSync(process.execPath, ['-e', `const a=require(${JSON.stringify(path.join(root, 'acceptance/node_modules/@electron/asar'))}); const p=JSON.parse(a.extractFile(${JSON.stringify(asar)}, 'package.json').toString()); console.log(JSON.stringify({version:p.version,productName:p.productName,name:p.name}))`], {encoding: 'utf8', env: safeEnv})); return pkg; }
function runInstaller(exe, args, cwd) {
  const r = spawnSync(exe, args, {cwd, env: safeEnv, stdio: 'inherit', windowsHide: true, ...windowsSpawnOptions});
  if (r.status !== 0) throw new Error(`installer failed: ${r.status}`);
}
function windowsInstall(exe, version, target) {
  if (version === 'old') runInstaller(exe, ['/S', '/currentuser', `/D=${target}`], temp);
  else runInstaller(exe, [...windowsUpdateArgs(path.join(target, 'DSWhale.exe')).slice(0, -1), '/S', `/D=${target}`], temp);
  const installed = path.join(target, 'DSWhale.exe');
  if (!fs.existsSync(installed)) throw new Error('installed exe missing');
  return installed;
}
function linuxInstall(file) {
  const r = spawnSync('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', file], {env: safeEnv, stdio: 'inherit'});
  if (r.status !== 0) throw new Error(`apt install failed: ${r.status}`);
}
function linuxVersion() { return execFileSync('dpkg-query', ['-W', '-f=${Version}', 'dswhale-desktop'], {encoding: 'utf8', env: safeEnv}).trim(); }
async function main() {
  if (platform === 'win32') {
    const name = 'DSWhale-Windows-x86_64';
    const artifact = await artifactZip(name);
    const zipDir = path.join(temp, 'artifact'); await fsp.mkdir(zipDir);
    zipExtract(artifact, zipDir);
    const a12 = path.join(zipDir, 'DSWhale-0.3.0-alpha.12-Windows-x86_64-setup.exe');
    const a11 = await releaseAsset('DSWhale-0.3.0-alpha.11-Windows-x86_64-setup.exe');
    const target = path.join(temp, 'DSWhale 中文 空格 & path');
    const profile = path.join(process.env.APPDATA, 'DSWhale');
    if (fs.existsSync(profile)) throw new Error('Windows test profile already exists');
    const marker = path.join(profile, 'synthetic-device-marker.txt');
    if (mode === 'cross-small') {
      windowsInstall(a11, 'old', target);
      const oldVersion = installedAsarVersion(path.join(target, 'resources/app.asar'));
      if (oldVersion.version !== '0.3.0-alpha.11') throw new Error(`unexpected a11 version ${oldVersion.version}`);
      await fsp.mkdir(profile, {recursive: true}); await fsp.writeFile(marker, 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT');
      windowsInstall(a12, 'new', target);
      const newVersion = installedAsarVersion(path.join(target, 'resources/app.asar'));
      if (newVersion.version !== '0.3.0-alpha.12') throw new Error(`unexpected a12 version ${newVersion.version}`);
      if (await fsp.readFile(marker, 'utf8') !== 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT') throw new Error('profile marker changed');
      result.checks = {oldVersion: oldVersion.version, newVersion: newVersion.version, target, dataMarker: 'preserved'};
    } else {
      windowsInstall(a12, 'new', target);
      await fsp.mkdir(profile, {recursive: true}); await fsp.writeFile(marker, 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT');
      windowsInstall(a12, 'new', target);
      if (await fsp.readFile(marker, 'utf8') !== 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT') throw new Error('profile marker changed after repeat install');
      result.checks = {newVersion: installedAsarVersion(path.join(target, 'resources/app.asar')).version, target, dataMarker: 'preserved'};
    }
  } else if (platform === 'linux') {
    const name = 'DSWhale-Linux-x86_64';
    const artifact = await artifactZip(name);
    const zipDir = path.join(temp, 'artifact'); await fsp.mkdir(zipDir);
    zipExtract(artifact, zipDir);
    const a12 = path.join(zipDir, 'DSWhale-0.3.0-alpha.12-Linux-x86_64.deb');
    const a11 = await releaseAsset('DSWhale-0.3.0-alpha.11-Linux-x86_64.deb');
    const configRoot = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config');
    const profile = path.join(configRoot, 'DSWhale');
    if (fs.existsSync(profile)) throw new Error('Linux test profile already exists');
    const marker = path.join(profile, 'synthetic-device-marker.txt');
    if (mode === 'cross-small') {
      linuxInstall(a11);
      if (linuxVersion() !== '0.3.0~alpha.11') throw new Error(`unexpected a11 dpkg version ${linuxVersion()}`);
      await fsp.mkdir(profile, {recursive: true}); await fsp.writeFile(marker, 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT');
      linuxInstall(a12);
      if (linuxVersion() !== '0.3.0~alpha.12') throw new Error(`unexpected a12 dpkg version ${linuxVersion()}`);
      if (await fsp.readFile(marker, 'utf8') !== 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT') throw new Error('profile marker changed');
      if (!fs.existsSync('/opt/DSWhale/dswhale')) throw new Error('installed Linux executable missing');
      result.checks = {oldVersion: '0.3.0~alpha.11', newVersion: linuxVersion(), executable: '/opt/DSWhale/dswhale', dataMarker: 'preserved'};
    } else {
      linuxInstall(a12);
      await fsp.mkdir(profile, {recursive: true}); await fsp.writeFile(marker, 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT');
      linuxInstall(a12);
      if (await fsp.readFile(marker, 'utf8') !== 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT') throw new Error('profile marker changed after repeat install');
      if (!fs.existsSync('/opt/DSWhale/dswhale')) throw new Error('installed Linux executable missing');
      result.checks = {newVersion: linuxVersion(), executable: '/opt/DSWhale/dswhale', dataMarker: 'preserved'};
    }
  } else throw new Error(`unsupported platform ${platform}`);
  result.passed = true;
  console.log(JSON.stringify(result, null, 2));
  await fsp.writeFile(path.join(process.env.RUNNER_TEMP || os.tmpdir(), `a12-${mode}-${platform}.json`), JSON.stringify(result, null, 2));
}
main().catch(error => {
  result.passed = false; result.errors.push(String(error.message || error));
  try { fs.writeFileSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), `a12-${mode}-${platform}.json`), JSON.stringify(result, null, 2)); } catch {}
  console.error(JSON.stringify(result, null, 2)); process.exitCode = 1;
});
