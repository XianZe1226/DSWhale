#!/usr/bin/env node
// Acceptance-only installer/upgrade marker smoke. No app, SDK, QQ, provider or account use.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {EXPECTED, allowedCase, assertRealDirectory, childEnv, profilePaths, validateRunnerContext} from './safety.mjs';

const CASES = ['installer-upgrade-marker', 'fresh-repeat-marker'];
const MARKER = 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT';
const COMMON_NOT_EXECUTED = [
  'SDK first read or migration',
  'QQ owner/platform scenarios',
  'provider WebUI save/restart',
  'persona, conversation, memory or database matrix',
  'GUI automation and Windows 11 DPI',
];
function scopeFor(name) {
  if (name === 'installer-upgrade-marker') return {
    scope: 'installer-upgrade-marker',
    covered: ['real a11 installer to real a12 installer over the same isolated path', 'installed app.asar version a11 then a12', 'synthetic device marker retained across the upgrade'],
    notExecuted: COMMON_NOT_EXECUTED,
  };
  if (name === 'fresh-repeat-marker') return {
    scope: 'fresh-repeat-marker',
    covered: ['fresh real a12 installer installation', 'repeated real a12 installer installation over the same isolated path', 'installed a12 version and synthetic device marker retained'],
    notExecuted: COMMON_NOT_EXECUTED,
  };
  throw Object.assign(new Error(`Unknown acceptance case: ${String(name)}`), {code: 'ACCEPTANCE_CASE_REJECTED'});
}

function printRejection(error) {
  const fields = Array.isArray(error?.fields) ? error.fields : [];
  console.error(JSON.stringify({schemaVersion: 2, passed: false, code: error?.code || 'ACCEPTANCE_REFUSED', fields}, null, 2));
}
function parseCase(argv) {
  const args = argv.filter(arg => arg !== '--');
  if (args.length !== 1 || !args[0].startsWith('--case=')) throw Object.assign(new Error('Expected exactly one --case='), {code: 'ACCEPTANCE_CASE_REJECTED'});
  try { return allowedCase(args[0].slice('--case='.length)); }
  catch (error) { error.code = 'ACCEPTANCE_CASE_REJECTED'; throw error; }
}
function safe(message, context) {
  let text = String(message || '');
  for (const value of [context?.workspace, context?.runnerTemp, context?.binaryRoot]) if (value) text = text.split(value).join('<runner>');
  return text.slice(0, 500);
}
async function main() {
  const context = validateRunnerContext(process.env);
  const caseName = parseCase(process.argv.slice(2));
  const scope = scopeFor(caseName);
  if (path.resolve(process.cwd()) !== context.workspace) throw Object.assign(new Error('install-check must run from GITHUB_WORKSPACE'), {code: 'ACCEPTANCE_PATH_REJECTED'});
  assertRealDirectory(context.workspace, 'GITHUB_WORKSPACE', context.platform);
  assertRealDirectory(context.runnerTemp, 'RUNNER_TEMP', context.platform);
  assertRealDirectory(context.binaryRoot, 'BINARY_ROOT', context.platform);
  const head = execFileSync('git', ['-C', context.binaryRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8', env: childEnv(context.platform, process.env)}).trim();
  if (head !== EXPECTED.binaryCommit) throw Object.assign(new Error('BINARY_ROOT is not the fixed a12 binary commit'), {code: 'ACCEPTANCE_BINARY_REJECTED'});
  const lock = JSON.parse(await fsp.readFile(path.join(context.workspace, 'acceptance/a12-binaries.lock.json'), 'utf8'));
  if (lock.candidate.binaryCommit !== EXPECTED.binaryCommit || lock.repository !== EXPECTED.repository) throw Object.assign(new Error('binary lock identity mismatch'), {code: 'ACCEPTANCE_LOCK_REJECTED'});
  const binaryRequire = createRequire(path.join(context.binaryRoot, 'desktop/lib/'));
  const {windowsUpdateArgs, windowsSpawnOptions} = binaryRequire('./installer.cjs');
  const asar = createRequire(path.join(context.workspace, 'acceptance/package.json'))('@electron/asar');
  const token = process.env.GITHUB_TOKEN || '';
  const env = childEnv(context.platform, process.env);
  const profile = profilePaths(context.platform, process.env);
  if (context.platform === 'linux' && !fs.existsSync(profile.parent)) await fsp.mkdir(profile.parent, {recursive: true});
  assertRealDirectory(profile.parent, 'standard test-user profile parent', context.platform);
  if (fs.existsSync(profile.profile)) throw Object.assign(new Error('standard test-user DSWhale profile already exists; refusing to merge or delete it'), {code: 'ACCEPTANCE_PROFILE_REJECTED'});
  if (path.dirname(profile.profile) !== path.resolve(profile.parent)) throw Object.assign(new Error('standard test-user profile escaped its parent'), {code: 'ACCEPTANCE_PROFILE_REJECTED'});
  const temp = await fsp.mkdtemp(path.join(context.runnerTemp, 'a12-installer-upgrade-marker-'));
  const resultPath = path.join(context.runnerTemp, `a12-${caseName}-${context.platform}.json`);
  const result = {
    schemaVersion: 2,
    scope: scope.scope,
    covered: scope.covered,
    notExecuted: scope.notExecuted,
    harnessCommit: process.env.HARNESS_COMMIT || '',
    binaryCommit: EXPECTED.binaryCommit,
    oldBinaryCommit: lock.old.commit,
    binaryRunId: lock.candidate.runId,
    acceptanceRunId: process.env.GITHUB_RUN_ID || '',
    acceptanceRunAttempt: process.env.GITHUB_RUN_ATTEMPT || '',
    jobKey: process.env.ACCEPTANCE_JOB_KEY || `${context.platform}-x64`,
    repository: EXPECTED.repository,
    ref: EXPECTED.ref,
    event: EXPECTED.event,
    case: caseName,
    platform: context.platform,
    arch: context.arch,
    os: os.version?.() || os.release(),
    checks: {},
    passed: false,
    errors: [],
  };
  const writeResult = async () => fsp.writeFile(resultPath, JSON.stringify(result, null, 2));
  function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
  async function sha256File(file) { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
  function zipExtract(file, dir) {
    if (context.platform === 'win32') execFileSync('tar', ['-xf', file, '-C', dir], {env});
    else execFileSync('unzip', ['-q', file, '-d', dir], {env});
  }
  async function download(url, file, headers = {}) {
    const response = await fetch(url, {headers, redirect: 'follow'});
    if (!response.ok) throw new Error(`download failed with status ${response.status}`);
    await fsp.writeFile(file, Buffer.from(await response.arrayBuffer()));
  }
  async function artifactZip(platformName) {
    const artifact = lock.candidate.artifacts.find(item => item.name === platformName);
    if (!artifact) throw new Error(`missing artifact for ${platformName}`);
    const file = path.join(temp, `${platformName}.zip`);
    await download(`https://api.github.com/repos/${EXPECTED.repository}/actions/artifacts/${artifact.id}/zip`, file, {Authorization: `Bearer ${token}`});
    if (await sha256File(file) !== artifact.digest.replace(/^sha256:/, '')) throw new Error('artifact ZIP hash mismatch');
    return file;
  }
  async function releaseAsset(name) {
    const asset = lock.old.assets.find(item => item.name === name);
    if (!asset) throw new Error(`missing old asset ${name}`);
    const file = path.join(temp, name);
    await download(asset.browser_download_url, file);
    if ((await fsp.stat(file)).size !== asset.size) throw new Error(`old asset size mismatch: ${name}`);
    if (await sha256File(file) !== asset.sha256) throw new Error(`old asset hash mismatch: ${name}`);
    return file;
  }
  function installedAsarVersion(asarFile) {
    const code = `const a=require(${JSON.stringify(path.join(context.workspace, 'acceptance/node_modules/@electron/asar'))}); const p=JSON.parse(a.extractFile(${JSON.stringify(asarFile)}, 'package.json').toString()); console.log(JSON.stringify({version:p.version,productName:p.productName,name:p.name}));`;
    return JSON.parse(execFileSync(process.execPath, ['-e', code], {encoding: 'utf8', env}));
  }
  function runInstaller(exe, args, cwd) {
    const child = spawnSync(exe, args, {...windowsSpawnOptions, cwd, env, stdio: 'inherit', windowsHide: true});
    if (child.status !== 0) throw new Error(`installer failed with status ${child.status}`);
  }
  function linuxInstall(file) {
    const child = spawnSync('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', file], {env: {...env, DEBIAN_FRONTEND: 'noninteractive'}, stdio: 'inherit'});
    if (child.status !== 0) throw new Error(`apt install failed with status ${child.status}`);
  }
  function linuxVersion() { return execFileSync('dpkg-query', ['-W', '-f=${Version}', 'dswhale-desktop'], {encoding: 'utf8', env}).trim(); }
  if (context.platform === 'win32') {
    const artifact = await artifactZip('DSWhale-Windows-x86_64');
    const zipDir = path.join(temp, 'artifact'); await fsp.mkdir(zipDir);
    zipExtract(artifact, zipDir);
    const a12 = path.join(zipDir, 'DSWhale-0.3.0-alpha.12-Windows-x86_64-setup.exe');
    const target = path.join(temp, 'DSWhale 中文 空格 & path');
    const marker = path.join(profile.profile, 'synthetic-device-marker.txt');
    if (caseName === 'installer-upgrade-marker') {
      const a11 = await releaseAsset('DSWhale-0.3.0-alpha.11-Windows-x86_64-setup.exe');
      runInstaller(a11, ['/S', '/currentuser', `/D=${target}`], temp);
      const oldVersion = installedAsarVersion(path.join(target, 'resources/app.asar'));
      if (oldVersion.version !== '0.3.0-alpha.11') throw new Error(`unexpected a11 version ${oldVersion.version}`);
      await fsp.mkdir(profile.profile, {recursive: true});
      await fsp.writeFile(marker, MARKER);
      runInstaller(a12, [...windowsUpdateArgs(path.join(target, 'DSWhale.exe')).slice(0, -1), '/S', `/D=${target}`], temp);
      const newVersion = installedAsarVersion(path.join(target, 'resources/app.asar'));
      if (newVersion.version !== '0.3.0-alpha.12') throw new Error(`unexpected a12 version ${newVersion.version}`);
      if (await fsp.readFile(marker, 'utf8') !== MARKER) throw new Error('synthetic marker changed');
      result.checks = {oldVersion: oldVersion.version, newVersion: newVersion.version, installTargetLabel: 'Chinese space ampersand path', dataMarker: 'preserved'};
    } else {
      runInstaller(a12, ['/S', '/currentuser', `/D=${target}`], temp);
      const firstVersion = installedAsarVersion(path.join(target, 'resources/app.asar')).version;
      if (firstVersion !== '0.3.0-alpha.12') throw new Error(`unexpected first a12 version ${firstVersion}`);
      await fsp.mkdir(profile.profile, {recursive: true});
      await fsp.writeFile(marker, MARKER);
      runInstaller(a12, [...windowsUpdateArgs(path.join(target, 'DSWhale.exe')).slice(0, -1), '/S', `/D=${target}`], temp);
      const repeatVersion = installedAsarVersion(path.join(target, 'resources/app.asar')).version;
      if (repeatVersion !== '0.3.0-alpha.12') throw new Error(`unexpected repeat a12 version ${repeatVersion}`);
      if (await fsp.readFile(marker, 'utf8') !== MARKER) throw new Error('synthetic marker changed after repeat install');
      result.checks = {firstVersion, repeatVersion, installTargetLabel: 'Chinese space ampersand path', dataMarker: 'preserved'};
    }
  } else if (context.platform === 'linux') {
    const artifact = await artifactZip('DSWhale-Linux-x86_64');
    const zipDir = path.join(temp, 'artifact'); await fsp.mkdir(zipDir);
    zipExtract(artifact, zipDir);
    const a12 = path.join(zipDir, 'DSWhale-0.3.0-alpha.12-Linux-x86_64.deb');
    const marker = path.join(profile.profile, 'synthetic-device-marker.txt');
    if (caseName === 'installer-upgrade-marker') {
      const a11 = await releaseAsset('DSWhale-0.3.0-alpha.11-Linux-x86_64.deb');
      linuxInstall(a11);
      if (linuxVersion() !== '0.3.0~alpha.11') throw new Error(`unexpected a11 dpkg version ${linuxVersion()}`);
      await fsp.mkdir(profile.profile, {recursive: true});
      await fsp.writeFile(marker, MARKER);
      linuxInstall(a12);
      if (linuxVersion() !== '0.3.0~alpha.12') throw new Error(`unexpected a12 dpkg version ${linuxVersion()}`);
      if (await fsp.readFile(marker, 'utf8') !== MARKER) throw new Error('synthetic marker changed');
      if (!fs.existsSync('/opt/DSWhale/dswhale')) throw new Error('installed Linux executable missing');
      result.checks = {oldVersion: '0.3.0~alpha.11', newVersion: linuxVersion(), installTargetLabel: 'system package path', dataMarker: 'preserved'};
    } else {
      linuxInstall(a12);
      const firstVersion = linuxVersion();
      if (firstVersion !== '0.3.0~alpha.12') throw new Error(`unexpected first a12 dpkg version ${firstVersion}`);
      await fsp.mkdir(profile.profile, {recursive: true});
      await fsp.writeFile(marker, MARKER);
      linuxInstall(a12);
      if (linuxVersion() !== '0.3.0~alpha.12') throw new Error(`unexpected repeat a12 dpkg version ${linuxVersion()}`);
      if (await fsp.readFile(marker, 'utf8') !== MARKER) throw new Error('synthetic marker changed after repeat install');
      if (!fs.existsSync('/opt/DSWhale/dswhale')) throw new Error('installed Linux executable missing');
      result.checks = {firstVersion, repeatVersion: linuxVersion(), installTargetLabel: 'system package path', dataMarker: 'preserved'};
    }
  } else {
    throw new Error('unsupported platform');
  }
  result.passed = true;
  await writeResult();
  console.log(JSON.stringify(result, null, 2));
}
try {
  await main();
} catch (error) {
  if (error?.code === 'ACCEPTANCE_RUNNER_REJECTED' || error?.code === 'ACCEPTANCE_CASE_REJECTED' || error?.code === 'ACCEPTANCE_PATH_REJECTED' || error?.code === 'ACCEPTANCE_BINARY_REJECTED' || error?.code === 'ACCEPTANCE_LOCK_REJECTED' || error?.code === 'ACCEPTANCE_PROFILE_REJECTED') {
    printRejection(error); process.exitCode = 2;
  } else {
    let context = null;
    let failureScope = null;
    try { context = validateRunnerContext(process.env); } catch {}
    try { failureScope = scopeFor(parseCase(process.argv.slice(2))); } catch {}
    const scopeName = failureScope?.scope || 'installer-upgrade-marker';
    const result = {schemaVersion: 2, scope: scopeName, covered: failureScope?.covered || [], notExecuted: failureScope?.notExecuted || [], harnessCommit: process.env.HARNESS_COMMIT || '', binaryCommit: EXPECTED.binaryCommit, oldBinaryCommit: '030960c55c8fe341ccbe7ec1d0df713fee803043', binaryRunId: 41963512296, acceptanceRunId: process.env.GITHUB_RUN_ID || '', acceptanceRunAttempt: process.env.GITHUB_RUN_ATTEMPT || '', jobKey: process.env.ACCEPTANCE_JOB_KEY || `${process.platform}-x64`, passed: false, errors: [safe(error?.message, context)]};
    try { if (context) fs.writeFileSync(path.join(context.runnerTemp, `a12-${scopeName}-${process.platform}.json`), JSON.stringify(result, null, 2)); } catch {}
    console.error(JSON.stringify(result, null, 2)); process.exitCode = 1;
  }
}
