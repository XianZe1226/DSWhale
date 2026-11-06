#!/usr/bin/env node
// Hosted SDK/four-profile acceptance. Installers and runtimes are real; no GUI or real accounts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync, spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {EXPECTED, assertRealDirectory, childEnv, validateRunnerContext} from './safety.mjs';

const SCENARIOS = ['small-only', 'official-only', 'dual-enabled', 'fresh-unconfigured'];
const MARKER = 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT';
const SCOPE = {
  scope: 'four-profile-sdk-storage-first-read',
  covered: ['actual a11 runtime with synthetic four-profile settings, personas, conversations and LivingMemory data', 'actual a12 runtime first read and migration', 'type-sensitive config, persona, conversation and memory storage readback with deterministic embedding test double'],
  notExecuted: ['provider WebUI login/edit/save/restart', 'memory WebUI login/edit/save/restart', 'GUI cards and visual state', 'Windows 11 DPI', 'real accounts or platforms', 'provider initialization/model requests and full LivingMemory host startup', 'graph-memory and native-wide egress sandbox'],
};
const DIAGNOSTIC_SCOPE = {
  scope: 'windows-acl-runtime-diagnostics',
  covered: ['actual a11 installed runtime ACL API on owned empty directories', 'input-handle, window, audit, event-loop and interpreter diagnostic controls'],
  notExecuted: ['a12 installation or upgrade', 'SDK configuration/persona/conversation/memory matrix', 'GUI or real accounts'],
};
function fail(error) { console.error(JSON.stringify({schemaVersion: 2, passed: false, code: error?.code || 'SDK_CHECK_FAILED', errorClass: error?.name || 'Error'}, null, 2)); process.exitCode = 1; }
function arg(name) { const hit = process.argv.find(v => v.startsWith(`--${name}=`)); return hit?.slice(name.length + 3); }
function expectedArg() { const value = arg('scenario'); if (!SCENARIOS.includes(value)) throw Object.assign(new Error('Unknown SDK scenario'), {code: 'SDK_SCENARIO_REJECTED'}); return value; }
async function sha256File(file) { const h = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) h.update(chunk); return h.digest('hex'); }
function zipExtract(file, dir, platform) { const env = childEnv(platform, process.env); if (platform === 'win32') execFileSync('tar', ['-xf', file, '-C', dir], {env, timeout: 120000}); else execFileSync('unzip', ['-q', file, '-d', dir], {env, timeout: 120000}); }
function runInstaller(exe, args, cwd, env, windowsSpawnOptions) { const child = spawnSync(exe, args, {...windowsSpawnOptions, cwd, env, stdio: 'inherit', windowsHide: true, timeout: 10 * 60 * 1000}); if (child.status !== 0) throw new Error(`installer failed with status ${child.status}`); }
function linuxInstall(file, env) { const child = spawnSync('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', file], {env: {...env, DEBIAN_FRONTEND: 'noninteractive'}, stdio: 'inherit', timeout: 10 * 60 * 1000}); if (child.status !== 0) throw new Error(`apt install failed with status ${child.status}`); }
function linuxVersion(env) { return execFileSync('dpkg-query', ['-W', '-f=${Version}', 'dswhale-desktop'], {encoding: 'utf8', env}).trim(); }
function venvPython(runtime, platform) { return platform === 'win32' ? path.join(runtime, 'venv', 'Scripts', 'python.exe') : path.join(runtime, 'venv', 'bin', 'python'); }
function nodeExe() { return process.execPath; }
function runtimeArchivePath(name, platform) { return (platform === 'win32' ? path.win32 : path.posix).join('desktop', 'lib', name); }
function fixtureIoOptions(mode = 'closed-eof', inputFd) {
  if (mode === 'file-eof' && Number.isInteger(inputFd) && inputFd >= 0) return {stdio: [inputFd, 'pipe', 'pipe'], encoding: 'utf8'};
  if (mode === 'closed-eof') return {stdio: ['pipe', 'pipe', 'pipe'], input: '', encoding: 'utf8'};
  if (mode === 'nul') return {stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'};
  throw new Error('unknown fixture input mode');
}
function lastJson(text) {
  const lines = String(text).trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('fixture returned no JSON');
}
function semanticFixture(value) {
  if (value?.schemaVersion !== 2 || value.kind !== 'DSWhaleSyntheticStorageReadback' || !/^[a-f0-9]{64}$/.test(value.snapshotSha256 || '')) throw new Error('invalid SDK fixture receipt');
  if (['personas', 'conversations', 'memories', 'vectors'].some(k => value.counts?.[k] !== 2)) throw new Error('SDK fixture baseline is empty or incomplete');
  if (value.sqliteIntegrity !== 'ok' || value.markerPreserved !== true || value.networkGuard?.probeBlocked !== true || value.embeddingMode !== 'deterministic-storage-test-double') throw new Error('SDK fixture integrity/guard evidence is incomplete');
  return {scenario: value.scenario, snapshotSha256: value.snapshotSha256, counts: value.counts, embeddingMode: value.embeddingMode};
}
function equalJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function runRuntimeProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', pending = '', timedOut = false, killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
    }, 30 * 60 * 1000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const text = chunk.toString(); output = (output + text).slice(-2 * 1024 * 1024); pending += text;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try { const event = JSON.parse(line); if (event.stage === 'runtime') console.log(JSON.stringify({stage: 'runtime', phase: String(event.phase || '').slice(0, 30), progress: typeof event.progress === 'number' ? event.progress : null})); } catch {}
      }
      if (pending.length > 128 * 1024) pending = '';
    });
    child.stderr.on('data', () => {}); // Raw child errors never enter public result artifacts.
    child.once('error', () => { clearTimeout(timer); clearTimeout(killTimer); reject(new Error('runtime process could not start')); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (timedOut || code !== 0) reject(new Error('runtime prepare failed or timed out; child output withheld'));
      else resolve(output);
    });
  });
}
async function main() {
  const context = validateRunnerContext(process.env);
  const scenario = expectedArg();
  const diagnosticOnly = process.argv.includes('--diagnostic-only');
  if (diagnosticOnly && (context.platform !== 'win32' || scenario !== 'small-only')) throw new Error('ACL diagnostics require Windows small-only context');
  if (path.resolve(process.cwd()) !== context.workspace) throw new Error('sdk-check must run from GITHUB_WORKSPACE');
  assertRealDirectory(context.workspace, 'GITHUB_WORKSPACE', context.platform);
  assertRealDirectory(context.runnerTemp, 'RUNNER_TEMP', context.platform);
  assertRealDirectory(context.binaryRoot, 'BINARY_ROOT', context.platform);
  const head = execFileSync('git', ['-C', context.binaryRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8', env: childEnv(context.platform, process.env)}).trim();
  if (head !== EXPECTED.binaryCommit) throw Object.assign(new Error('BINARY_ROOT is not the fixed binary commit'), {code: 'ACCEPTANCE_BINARY_REJECTED'});
  const lock = JSON.parse(await fsp.readFile(path.join(context.workspace, 'acceptance/a12-binaries.lock.json'), 'utf8'));
  const env = childEnv(context.platform, process.env);
  const asar = createRequire(path.join(context.workspace, 'acceptance/package.json'))('@electron/asar');
  const binaryRequire = createRequire(path.join(context.binaryRoot, 'desktop/lib/'));
  const {windowsUpdateArgs, windowsSpawnOptions} = binaryRequire('./installer.cjs');
  const token = process.env.GITHUB_TOKEN || '';
  const temp = await fsp.mkdtemp(path.join(context.runnerTemp, `a12-sdk-${scenario}-`));
  const runtime = path.join(temp, 'profile', 'runtime');
  await fsp.writeFile(path.join(temp, 'synthetic-root.json'), JSON.stringify({kind: 'DSWhaleSyntheticAcceptance', scenario}), {flag: 'wx'});
  const host = path.join(runtime, 'astrbot');
  const inputFile = path.join(temp, 'empty-input.txt');
  await fsp.writeFile(inputFile, '', {flag: 'wx', mode: 0o600});
  const inputFd = fs.openSync(inputFile, 'r');
  const target = path.join(temp, 'DSWhale 中文 空格 & path');
  const resultPath = path.join(context.runnerTemp, diagnosticOnly ? 'a12-windows-acl-diagnostics-win32.json' : `a12-sdk-${scenario}-${context.platform}.json`);
  const result = {schemaVersion: 2, ...(diagnosticOnly ? DIAGNOSTIC_SCOPE : SCOPE), scenario, harnessCommit: process.env.HARNESS_COMMIT || '', binaryCommit: EXPECTED.binaryCommit, oldBinaryCommit: lock.old.commit, binaryRunId: lock.candidate.runId, acceptanceRunId: process.env.GITHUB_RUN_ID || '', acceptanceRunAttempt: process.env.GITHUB_RUN_ATTEMPT || '', jobKey: process.env.ACCEPTANCE_JOB_KEY || `a12-sdk-${scenario}-${context.platform}-x64`, repository: EXPECTED.repository, ref: EXPECTED.ref, event: EXPECTED.event, platform: context.platform, arch: context.arch, os: os.version?.() || os.release(), checks: {}, passed: false, errors: []};
  const writeResult = () => fsp.writeFile(resultPath, JSON.stringify(result, null, 2));
  async function download(url, file, headers = {}) { console.log(JSON.stringify({stage: 'download', file: path.basename(file), state: 'started'})); const response = await fetch(url, {headers, redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000)}); if (!response.ok) throw new Error(`download failed ${response.status}`); await fsp.writeFile(file, Buffer.from(await response.arrayBuffer())); console.log(JSON.stringify({stage: 'download', file: path.basename(file), state: 'complete'})); }
  async function artifact(platformName) { const item = lock.candidate.artifacts.find(a => a.name === platformName); if (!item) throw new Error(`missing artifact ${platformName}`); const file = path.join(temp, `${platformName}.zip`); await download(`https://api.github.com/repos/${EXPECTED.repository}/actions/artifacts/${item.id}/zip`, file, {Authorization: `Bearer ${token}`}); if (await sha256File(file) !== item.digest.replace(/^sha256:/, '')) throw new Error('artifact hash mismatch'); return file; }
  async function old(name) { const item = lock.old.assets.find(a => a.name === name); if (!item) throw new Error(`missing old ${name}`); const file = path.join(temp, name); await download(item.browser_download_url, file); if (await sha256File(file) !== item.sha256) throw new Error(`old hash mismatch ${name}`); return file; }
  async function prepareRuntime(appRoot) {
    console.log(JSON.stringify({stage: 'runtime-prepare', state: 'started'}));
    const lib = path.join(temp, `runtime-lib-${Math.random().toString(36).slice(2)}`); await fsp.mkdir(lib);
    for (const name of ['runtime.cjs', 'network.cjs', 'tool-assets.json']) await fsp.writeFile(path.join(lib, name), asar.extractFile(path.join(appRoot, 'resources/app.asar'), runtimeArchivePath(name, context.platform)));
    const script = path.join(lib, 'prepare.cjs');
    await fsp.writeFile(script, `const {RuntimeManager}=require('./runtime.cjs');let m;let timer;(async()=>{m=new RuntimeManager({source:process.argv[2],runtime:process.argv[3],onProgress:p=>console.log(JSON.stringify({stage:'runtime',phase:p.phase,step:p.step,progress:p.progress}))});timer=setTimeout(()=>m.cancel(),20*60*1000);process.once('SIGTERM',()=>m.cancel().finally(()=>process.exit(1)));const r=await m.install();console.log(JSON.stringify(r));})().catch(e=>{console.error(JSON.stringify({code:'RUNTIME_PREPARE_FAILED',name:e.name}));process.exitCode=1}).finally(()=>clearTimeout(timer));`);
    const output = await runRuntimeProcess(nodeExe(), [script, path.join(appRoot, 'resources/backend'), runtime], {cwd: lib, env});
    const value = lastJson(output);
    if (!value.installed) throw new Error('runtime prepare did not report installed');
    console.log(JSON.stringify({stage: 'runtime-prepare', state: 'complete'}));
    return value;
  }
  async function fixture(action) {
    console.log(JSON.stringify({stage: 'fixture', action, state: 'started'}));
    const python = venvPython(runtime, context.platform);
    const plugins = path.join(host, 'data', 'plugins');
    const fixtureEnv = {...env, ASTRBOT_ROOT: host, PYTHONPATH: plugins, PYTHONNOUSERSITE: '1'};
    const child = spawnSync(python, [path.join(context.workspace, 'acceptance/fixtures/profile_fixture.py'), '--host', host, '--root', temp, '--baseline', path.join(temp, 'baseline.json'), '--scenario', scenario, '--action', action, '--out', path.join(temp, `${action}.json`)], {cwd: temp, env: fixtureEnv, ...fixtureIoOptions('file-eof', inputFd), windowsHide: true, timeout: 10 * 60 * 1000});
    if (child.status !== 0) {
      let diagnostic = {};
      try { const d = lastJson(child.stderr); if (d.kind === 'DSWhaleFixtureFailure') diagnostic = {errorClass: d.errorClass, code: d.code, fields: d.fields, frames: d.frames, causes: d.causes}; } catch {}
      throw new Error(`fixture ${action} failed with status ${child.status}: ${JSON.stringify(diagnostic)}`);
    }
    const value = lastJson(child.stdout);
    semanticFixture(value);
    if (value.sdkVersion !== '4.29.3' || value.backendVersion !== (action === 'seed' ? '0.3.0a11' : '0.3.0a12') || value.scenario !== scenario || value.action !== action || (action === 'verify' && value.baselineMatched !== true)) throw new Error('fixture scenario/action/baseline evidence mismatch');
    console.log(JSON.stringify({stage: 'fixture', action, state: 'complete'}));
    return value;
  }
  async function windowsAclIoProbe() {
    if (context.platform !== 'win32') return [];
    const observations = [];
    let systemPython = null;
    try { systemPython = execFileSync('where', ['python'], {encoding: 'utf8', env, timeout: 10000}).trim().split(/\r?\n/).find(file => path.win32.isAbsolute(file) && fs.existsSync(file)); } catch {}
    const nativeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'a12-sdk-native-'));
    const nativeHost = path.join(nativeRoot, 'profile', 'runtime', 'astrbot');
    await fsp.mkdir(path.join(nativeHost, 'data'), {recursive: true});
    await fsp.writeFile(path.join(nativeRoot, 'synthetic-root.json'), JSON.stringify({kind: 'DSWhaleSyntheticAcceptance', scenario}), {flag: 'wx'});
    const cases = [
      {mode: 'file-eof', hidden: true, audit: true},
      {mode: 'closed-eof', hidden: true, audit: true},
      {mode: 'nul', hidden: true, audit: true},
      {mode: 'file-eof', hidden: false, audit: true},
      {mode: 'closed-eof', hidden: false, audit: true},
      {mode: 'nul', hidden: false, audit: true},
      {mode: 'file-eof', hidden: true, audit: false},
      {mode: 'file-eof', hidden: true, audit: true},
      {mode: 'file-eof', hidden: true, audit: true, synchronous: true},
      {mode: 'file-eof', hidden: true, audit: false, synchronous: true},
      {mode: 'file-eof', hidden: true, audit: true, idleLoop: true},
      {mode: 'file-eof', hidden: true, audit: true, synchronous: true, interpreter: 'hosted-system'},
      {mode: 'file-eof', hidden: true, audit: false, synchronous: true, interpreter: 'hosted-system'},
      {mode: 'file-eof', hidden: true, audit: true, synchronous: true, location: 'native-temp'},
      {mode: 'file-eof', hidden: true, audit: true, synchronous: true, interpreter: 'hosted-system', location: 'native-temp'},
    ];
    for (const [index, specification] of cases.entries()) {
      const started = Date.now();
      if (specification.interpreter && !systemPython) { observations.push({...specification, passed: false, skipped: 'hosted-system interpreter unavailable'}); continue; }
      const action = specification.idleLoop ? 'acl-probe-idle-loop' : (specification.audit ? 'acl-probe' : 'acl-probe-no-audit') + (specification.synchronous ? '-sync' : '');
      const python = specification.interpreter ? systemPython : venvPython(runtime, context.platform);
      const pythonPath = specification.interpreter ? path.join(target, 'resources', 'backend') : path.join(host, 'data', 'plugins');
      const probeRoot = specification.location ? nativeRoot : temp;
      const probeHost = specification.location ? nativeHost : host;
      const child = spawnSync(python, [path.join(context.workspace, 'acceptance/fixtures/profile_fixture.py'), '--host', probeHost, '--root', probeRoot, '--baseline', path.join(probeRoot, 'baseline.json'), '--scenario', scenario, '--action', action, '--out', path.join(probeRoot, `acl-probe-${index}.json`)], {cwd: probeRoot, env: {...env, ASTRBOT_ROOT: probeHost, PYTHONPATH: pythonPath, PYTHONNOUSERSITE: '1'}, ...fixtureIoOptions(specification.mode, inputFd), windowsHide: specification.hidden, timeout: 60000});
      let diagnostic = {}, valid = false;
      try { const d = lastJson(child.status === 0 ? child.stdout : child.stderr); valid = child.status === 0 && d.kind === 'DSWhaleSyntheticAclProbe' && d.apiCompleted === true && (specification.audit ? d.networkGuard?.allowedWindowsAclProcesses >= 1 && d.networkGuard?.probeBlocked === true : d.networkGuard?.mode === 'diagnostic-api-only-no-python-audit'); diagnostic = valid ? {aclElapsedMs: d.elapsedMs, stdinType: d.stdinType, eventLoopActive: d.eventLoopActive, pythonVersion: d.pythonVersion, privateApiSha256: d.privateApiSha256, allowedAclProcesses: d.networkGuard.allowedWindowsAclProcesses ?? null} : {errorClass: d.errorClass, causes: d.causes, stdinType: d.stdinType, eventLoopActive: d.eventLoopActive}; } catch {}
      const observation = {...specification, nativeTempIsDifferentVolume: specification.location ? path.win32.parse(nativeRoot).root.toLowerCase() !== path.win32.parse(temp).root.toLowerCase() : null, passed: valid, elapsedMs: Date.now() - started, ...diagnostic};
      observations.push(observation); console.log(JSON.stringify({stage: 'windows-acl-diagnostic', ...observation}));
    }
    result.checks.windowsAclIo = observations;
    if (!observations[0].passed || !observations[7].passed) throw new Error('Windows file-EOF/hidden audited ACL diagnostic failed');
    return observations;
  }
  async function installA11(a11) { if (context.platform === 'win32') runInstaller(a11, ['/S', '/currentuser', `/D=${target}`], temp, env, windowsSpawnOptions); else linuxInstall(a11, env); }
  async function installA12(a12) { if (context.platform === 'win32') runInstaller(a12, [...windowsUpdateArgs(path.join(target, 'DSWhale.exe')).slice(0, -1), '/S', `/D=${target}`], temp, env, windowsSpawnOptions); else linuxInstall(a12, env); }
  try {
    const platformName = context.platform === 'win32' ? 'DSWhale-Windows-x86_64' : 'DSWhale-Linux-x86_64';
    const artifactFile = await artifact(platformName); const zipDir = path.join(temp, 'artifact'); await fsp.mkdir(zipDir); zipExtract(artifactFile, zipDir, context.platform);
    const a12 = path.join(zipDir, context.platform === 'win32' ? 'DSWhale-0.3.0-alpha.12-Windows-x86_64-setup.exe' : 'DSWhale-0.3.0-alpha.12-Linux-x86_64.deb');
    const a11 = await old(context.platform === 'win32' ? 'DSWhale-0.3.0-alpha.11-Windows-x86_64-setup.exe' : 'DSWhale-0.3.0-alpha.11-Linux-x86_64.deb');
    await installA11(a11);
    const appRoot11 = context.platform === 'win32' ? target : '/opt/DSWhale';
    const prepared11 = await prepareRuntime(appRoot11);
    const v11 = prepared11.components?.find(c => c.id === 'backend')?.version;
    if (v11 !== '0.3.0a11') throw new Error(`unexpected a11 runtime version ${v11}`);
    if (diagnosticOnly) {
      const windowsAclIo = await windowsAclIoProbe();
      result.checks = {a11Runtime: v11, windowsAclIo}; result.passed = true; await writeResult(); console.log(JSON.stringify(result, null, 2)); return;
    }
    const before = await fixture('seed');
    await installA12(a12);
    const appRoot12 = context.platform === 'win32' ? target : '/opt/DSWhale';
    const prepared12 = await prepareRuntime(appRoot12);
    const v12 = prepared12.components?.find(c => c.id === 'backend')?.version;
    if (v12 !== '0.3.0a12') throw new Error(`unexpected a12 runtime version ${v12}`);
    const after = await fixture('verify');
    const beforeSem = semanticFixture(before), afterSem = semanticFixture(after);
    if (!equalJson(beforeSem, afterSem)) throw new Error('type-sensitive fixture readback differs after a12 upgrade');
    if (await fsp.readFile(path.join(host, 'data', 'synthetic-device-marker.txt'), 'utf8') !== MARKER) throw new Error('device marker changed');
    const migration = path.join(host, 'data', 'plugin_data', 'astrbot_plugin_dswhale', 'config-migration-receipt.json');
    result.checks = {a11Runtime: prepared11.components?.find(c => c.id === 'backend')?.version, a12Runtime: prepared12.components?.find(c => c.id === 'backend')?.version, before: beforeSem, after: afterSem, marker: 'preserved', migrationReceipt: fs.existsSync(migration)};
    result.passed = true;
    await writeResult(); console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    let message = String(error.message || error); for (const prefix of [context.workspace, context.runnerTemp, context.binaryRoot]) message = message.split(prefix).join('<runner>'); result.errors.push(message.slice(0, 800)); await writeResult(); throw Object.assign(new Error(message), {code: 'SDK_CHECK_FAILED'});
  } finally { fs.closeSync(inputFd); }
}
try { await main(); } catch (error) { fail(error); }
