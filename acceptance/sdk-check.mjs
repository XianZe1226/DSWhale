#!/usr/bin/env node
// Hosted SDK/four-profile acceptance. Installers and runtimes are real; no GUI or real accounts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {EXPECTED, assertRealDirectory, childEnv, validateRunnerContext} from './safety.mjs';

const SCENARIOS = ['small-only', 'official-only', 'dual-enabled', 'fresh-unconfigured'];
const MARKER = 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT';
const SCOPE = {
  scope: 'four-profile-sdk-first-read',
  covered: ['actual a11 runtime with synthetic four-profile settings, personas, conversations and LivingMemory data', 'actual a12 runtime first read and migration', 'type-sensitive config, persona, conversation and memory readback'],
  notExecuted: ['provider WebUI login/edit/save/restart', 'memory WebUI login/edit/save/restart', 'GUI cards and visual state', 'Windows 11 DPI', 'real accounts or platforms'],
};
function fail(error) { console.error(JSON.stringify({schemaVersion: 2, passed: false, code: error?.code || 'SDK_CHECK_FAILED', errors: [String(error?.message || error).slice(0, 500)]}, null, 2)); process.exitCode = 1; }
function arg(name) { const hit = process.argv.find(v => v.startsWith(`--${name}=`)); return hit?.slice(name.length + 3); }
function expectedArg() { const value = arg('scenario'); if (!SCENARIOS.includes(value)) throw Object.assign(new Error('Unknown SDK scenario'), {code: 'SDK_SCENARIO_REJECTED'}); return value; }
async function sha256File(file) { const h = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) h.update(chunk); return h.digest('hex'); }
function zipExtract(file, dir, platform) { const env = childEnv(platform, process.env); if (platform === 'win32') execFileSync('tar', ['-xf', file, '-C', dir], {env}); else execFileSync('unzip', ['-q', file, '-d', dir], {env}); }
function runInstaller(exe, args, cwd, env, windowsSpawnOptions) { const child = spawnSync(exe, args, {...windowsSpawnOptions, cwd, env, stdio: 'inherit', windowsHide: true}); if (child.status !== 0) throw new Error(`installer failed with status ${child.status}`); }
function linuxInstall(file, env) { const child = spawnSync('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', file], {env: {...env, DEBIAN_FRONTEND: 'noninteractive'}, stdio: 'inherit'}); if (child.status !== 0) throw new Error(`apt install failed with status ${child.status}`); }
function linuxVersion(env) { return execFileSync('dpkg-query', ['-W', '-f=${Version}', 'dswhale-desktop'], {encoding: 'utf8', env}).trim(); }
function venvPython(runtime, platform) { return platform === 'win32' ? path.join(runtime, 'venv', 'Scripts', 'python.exe') : path.join(runtime, 'venv', 'bin', 'python'); }
function nodeExe() { return process.execPath; }
function lastJson(text) {
  const lines = String(text).trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('fixture returned no JSON');
}
function semanticFixture(value) {
  const settings = value.settings || {};
  return {
    platforms: (value.platforms || []).map(p => ({id: p.id, type: p.type, enable: p.enable, hasAppid: Boolean(p.appid), hasWsToken: Boolean(p.ws_reverse_token)})),
    provider_sources: (value.provider_sources || []).map(p => ({id: p.id, type: p.type, enable: p.enable, api_base: p.api_base})),
    provider: (value.provider || []).map(p => ({id: p.id, provider_source_id: p.provider_source_id, model: p.model, enable: p.enable})),
    settings: {ownerQQ: settings.ownerQQ, qqConnectionMode: settings.qqConnectionMode, officialOwnerUMO: settings.officialOwnerUMO, defaultDelivery: settings.defaultDelivery, platformId: settings.platformId, napcatBound: settings.napcatBound, officialBound: settings.officialBound, napcatConfigured: settings.napcatConfigured, officialConfigured: settings.officialConfigured},
    personas: [...(value.personas || [])].sort(),
    conversations: (value.conversations || []).map(c => ({persona_id: c.persona_id, user_id: c.user_id, platform_id: c.platform_id, title: c.title, content: c.content})).sort((a,b) => String(a.title).localeCompare(String(b.title))),
    memory: (value.memory_hits || []).map(m => ({content: m.content, persona_id: m.metadata?.persona_id, status: m.metadata?.status})).sort((a,b) => String(a.content).localeCompare(String(b.content))),
    marker: value.marker,
  };
}
function equalJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function main() {
  const context = validateRunnerContext(process.env);
  const scenario = expectedArg();
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
  const host = path.join(runtime, 'astrbot');
  const target = path.join(temp, 'DSWhale 中文 空格 & path');
  const resultPath = path.join(context.runnerTemp, `a12-sdk-${scenario}-${context.platform}.json`);
  const result = {schemaVersion: 2, ...SCOPE, scenario, harnessCommit: process.env.HARNESS_COMMIT || '', binaryCommit: EXPECTED.binaryCommit, oldBinaryCommit: lock.old.commit, binaryRunId: lock.candidate.runId, acceptanceRunId: process.env.GITHUB_RUN_ID || '', acceptanceRunAttempt: process.env.GITHUB_RUN_ATTEMPT || '', jobKey: process.env.ACCEPTANCE_JOB_KEY || `a12-sdk-${scenario}-${context.platform}-x64`, repository: EXPECTED.repository, ref: EXPECTED.ref, event: EXPECTED.event, platform: context.platform, arch: context.arch, os: os.version?.() || os.release(), checks: {}, passed: false, errors: []};
  const writeResult = () => fsp.writeFile(resultPath, JSON.stringify(result, null, 2));
  async function download(url, file, headers = {}) { const response = await fetch(url, {headers, redirect: 'follow'}); if (!response.ok) throw new Error(`download failed ${response.status}`); await fsp.writeFile(file, Buffer.from(await response.arrayBuffer())); }
  async function artifact(platformName) { const item = lock.candidate.artifacts.find(a => a.name === platformName); if (!item) throw new Error(`missing artifact ${platformName}`); const file = path.join(temp, `${platformName}.zip`); await download(`https://api.github.com/repos/${EXPECTED.repository}/actions/artifacts/${item.id}/zip`, file, {Authorization: `Bearer ${token}`}); if (await sha256File(file) !== item.digest.replace(/^sha256:/, '')) throw new Error('artifact hash mismatch'); return file; }
  async function old(name) { const item = lock.old.assets.find(a => a.name === name); if (!item) throw new Error(`missing old ${name}`); const file = path.join(temp, name); await download(item.browser_download_url, file); if (await sha256File(file) !== item.sha256) throw new Error(`old hash mismatch ${name}`); return file; }
  async function prepareRuntime(appRoot) {
    const lib = path.join(temp, `runtime-lib-${Math.random().toString(36).slice(2)}`); await fsp.mkdir(lib);
    for (const name of ['runtime.cjs', 'network.cjs', 'tool-assets.json']) await fsp.writeFile(path.join(lib, name), asar.extractFile(path.join(appRoot, 'resources/app.asar'), `desktop/lib/${name}`));
    const script = path.join(lib, 'prepare.cjs');
    await fsp.writeFile(script, `const path=require('node:path');const {RuntimeManager}=require('./runtime.cjs');(async()=>{const m=new RuntimeManager({source:process.argv[2],runtime:process.argv[3]});const r=await m.install();console.log(JSON.stringify(r));})().catch(e=>{console.error(e);process.exit(1)});`);
    const child = spawnSync(nodeExe(), [script, path.join(appRoot, 'resources/backend'), runtime], {cwd: lib, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30 * 60 * 1000});
    if (child.status !== 0) throw new Error(`runtime prepare failed ${child.status}: ${String(child.stderr || '').slice(-500)}`);
    const value = lastJson(child.stdout);
    if (!value.installed) throw new Error('runtime prepare did not report installed');
    return value;
  }
  async function fixture(action) {
    const python = venvPython(runtime, context.platform);
    const plugins = path.join(host, 'data', 'plugins');
    const fixtureEnv = {...env, ASTRBOT_ROOT: host, PYTHONPATH: plugins, PYTHONNOUSERSITE: '1'};
    const child = spawnSync(python, [path.join(context.workspace, 'acceptance/fixtures/profile_fixture.py'), '--host', host, '--scenario', scenario, '--action', action, '--out', path.join(temp, `${action}.json`)], {cwd: temp, env: fixtureEnv, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10 * 60 * 1000});
    if (child.status !== 0) throw new Error(`fixture ${action} failed ${child.status}: ${String(child.stderr || '').slice(-700)}`);
    return lastJson(child.stdout);
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
    result.errors.push(String(error.message || error).slice(0, 800)); await writeResult(); throw error;
  }
}
try { await main(); } catch (error) { fail(error); }
