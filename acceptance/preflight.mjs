#!/usr/bin/env node
// Acceptance-only provenance preflight. Never installs, launches, or uploads raw data.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {EXPECTED, childEnv, validateRunnerContext} from './safety.mjs';

let context;
try { context = validateRunnerContext(process.env); } catch (error) {
  console.error(JSON.stringify({schemaVersion: 2, passed: false, code: error?.code || 'ACCEPTANCE_REFUSED', fields: error?.fields || []}, null, 2));
  process.exit(2);
}
if (path.resolve(process.cwd()) !== context.workspace) throw new Error('preflight must run from GITHUB_WORKSPACE');
const root = context.workspace;
const binaryRoot = context.binaryRoot;
const childEnvironment = childEnv(context.platform, process.env);
const head = execFileSync('git', ['-C', binaryRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8', env: childEnvironment}).trim();
if (head !== EXPECTED.binaryCommit) throw new Error('BINARY_ROOT is not the fixed binary commit');
const lockPath = path.join(root, 'acceptance/a12-binaries.lock.json');
const lock = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
const token = process.env.GITHUB_TOKEN || '';
const require = createRequire(path.join(binaryRoot, 'desktop/lib/'));
const {verifyManifest} = require('./app-updater.cjs');
const runId = lock.candidate.runId;
const repo = lock.repository;
const api = `https://api.github.com/repos/${repo}`;
const runTemp = context.runnerTemp;
const out = path.join(runTemp, `a12-preflight-${process.pid}`);
const resultPath = path.join(runTemp, 'a12-preflight-result.json');
await fsp.mkdir(out, {recursive: true});
const result = {schemaVersion: 2, scope: 'provenance-preflight', harnessCommit: process.env.HARNESS_COMMIT || '', binaryCommit: EXPECTED.binaryCommit, oldBinaryCommit: lock.old.commit, binaryRunId: runId, acceptanceRunId: process.env.GITHUB_RUN_ID || '', acceptanceRunAttempt: process.env.GITHUB_RUN_ATTEMPT || '', jobKey: 'provenance-preflight', repository: repo, ref: EXPECTED.ref, event: EXPECTED.event, artifactIds: {}, checks: {}, files: {}, errors: []};
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject); stream.on('end', resolve);
  });
  return hash.digest('hex');
}
async function download(url, file, headers = {}) {
  const response = await fetch(url, {headers, redirect: 'follow'});
  if (!response.ok) throw new Error(`download failed ${response.status} for ${url}`);
  await fsp.writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}
async function apiJson(url) {
  const response = await fetch(url, {headers: {Accept: 'application/vnd.github+json', ...(token ? {Authorization: `Bearer ${token}`} : {})}});
  if (!response.ok) throw new Error(`API ${response.status} for ${url}`);
  return response.json();
}
function check(condition, message) { if (!condition) throw new Error(message); }
function zipNames(file) { return execFileSync('unzip', ['-Z1', file], {encoding: 'utf8', env: childEnvironment}).trim().split('\n').filter(Boolean); }
function zipRead(file, name) {
  const names = zipNames(file);
  check(names.includes(name), `missing ${name} in ${path.basename(file)}`);
  return execFileSync('unzip', ['-p', file, name], {maxBuffer: 300 * 1024 * 1024, env: childEnvironment});
}
async function main() {
  check(lock.repository === 'XianZe1226/DSWhale', 'repository lock mismatch');
  check(lock.candidate.runId === 41963512296, 'candidate run lock mismatch');
  const run = await apiJson(`${api}/actions/runs/${runId}`);
  check(run.head_sha === lock.candidate.binaryCommit, 'candidate head_sha changed');
  check(run.conclusion === 'success' && run.status === 'completed', 'candidate CI run is not successful/completed');
  check(run.path === '.github/workflows/desktop.yml', 'candidate run workflow path changed');
  result.checks.run = {headSha: run.head_sha, conclusion: run.conclusion, attempt: run.run_attempt, url: run.html_url};
  const listed = await apiJson(`${api}/actions/runs/${runId}/artifacts`);
  for (const expected of lock.candidate.artifacts) {
    const artifact = listed.artifacts.find(item => item.id === expected.id);
    check(artifact, `candidate artifact ${expected.id} missing`);
    check(artifact.name === expected.name, `artifact ${expected.id} name changed`);
    check(artifact.expired === false, `artifact ${expected.id} expired`);
    check(artifact.workflow_run?.id === runId && artifact.workflow_run?.head_sha === lock.candidate.binaryCommit, `artifact ${expected.id} provenance mismatch`);
    check(artifact.digest === expected.digest, `artifact ${expected.id} API digest mismatch`);
    const zip = path.join(out, `artifact-${expected.id}.zip`);
    await download(`${api}/actions/artifacts/${expected.id}/zip`, zip, token ? {Authorization: `Bearer ${token}`} : {});
    const zipHash = await sha256File(zip);
    check(zipHash === expected.digest.replace(/^sha256:/,''), `artifact ${expected.id} ZIP hash mismatch`);
    result.artifactIds[expected.name] = expected.id;
    result.files[path.basename(zip)] = {bytes: (await fsp.stat(zip)).size, sha256: zipHash};
  }
  const release = await apiJson(`${api}/releases/tags/${lock.old.tag}`);
  check(release.id === lock.old.releaseId, 'a11 release id changed');
  check(release.tag_name === lock.old.tag, 'a11 tag changed');
  const releaseAssets = new Map(release.assets.map(asset => [asset.name, asset]));
  for (const expected of lock.old.assets) {
    const asset = releaseAssets.get(expected.name);
    check(asset, `a11 asset ${expected.name} missing`);
    check(asset.id === expected.id, `a11 asset ${expected.name} id changed`);
    check(asset.size === expected.size, `a11 asset ${expected.name} size changed`);
    check(asset.digest === `sha256:${expected.sha256}`, `a11 asset ${expected.name} digest changed`);
    if (['release-manifest.json','release-manifest.sig'].includes(expected.name)) continue;
    const file = path.join(out, expected.name);
    await download(asset.browser_download_url, file);
    check((await fsp.stat(file)).size === expected.size, `a11 ${expected.name} byte size mismatch after download`);
    const hash = await sha256File(file);
    check(hash === expected.sha256, `a11 ${expected.name} hash mismatch after download`);
    result.files[expected.name] = {bytes: expected.size, sha256: hash};
  }
  for (const name of ['release-manifest.json','release-manifest.sig']) {
    const expected = lock.old.assets.find(asset => asset.name === name);
    const file = path.join(out, name);
    await download(releaseAssets.get(name).browser_download_url, file);
    check((await fsp.stat(file)).size === expected.size, `a11 ${name} size mismatch`);
    check((await sha256File(file)) === expected.sha256, `a11 ${name} hash mismatch`);
  }
  const rawManifest = await fsp.readFile(path.join(out, 'release-manifest.json'));
  const signature = await fsp.readFile(path.join(out, 'release-manifest.sig'));
  const manifest = verifyManifest(rawManifest, signature, {expectedVersion: '0.3.0a11'});
  check(manifest.commit === lock.old.commit, 'signed a11 manifest commit mismatch');
  check(manifest.tag === lock.old.tag, 'signed a11 manifest tag mismatch');
  for (const feature of ['win32-x64','darwin-arm64','linux-x64']) {
    const signed = manifest.assets[feature];
    check(signed && typeof signed.sha256 === 'string' && signed.sha256.length === 64, `signed manifest ${feature} asset missing`);
    const locked = lock.old.assets.find(asset => asset.sha256 === signed.sha256);
    check(locked && locked.size === signed.size, `signed manifest ${feature} asset not covered by lock`);
  }
  result.checks.signedA11Manifest = {version: manifest.version, commit: manifest.commit, tag: manifest.tag, assets: Object.keys(manifest.assets)};
  const platformArtifact = name => {
    if (name.includes('Windows-x86_64')) return 'DSWhale-Windows-x86_64';
    if (name.includes('Linux-x86_64')) return 'DSWhale-Linux-x86_64';
    if (name.includes('macOS-arm64')) return 'DSWhale-macOS-arm64';
    throw new Error(`unknown candidate asset platform ${name}`);
  };
  for (const [name, expected] of Object.entries(lock.candidate.assets)) {
    const artifactName = platformArtifact(name);
    const artifact = lock.candidate.artifacts.find(item => item.name === artifactName);
    check(artifact, `unable to map candidate asset ${name}`);
    const zip = path.join(out, `artifact-${artifact.id}.zip`);
    const bytes = zipRead(zip, name);
    check(bytes.length === expected.bytes, `${name} inner byte size mismatch`);
    check(digest(bytes) === expected.sha256, `${name} inner hash mismatch`);
    result.files[name] = {bytes: bytes.length, sha256: expected.sha256, artifactId: artifact.id};
  }
  result.passed = true;
  await fsp.writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => {
  result.passed = false;
  result.errors.push(String(error.message || error));
  try { if (context) fs.writeFileSync(path.join(context.runnerTemp, 'a12-preflight-result.json'), JSON.stringify(result, null, 2)); } catch {}
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
});
