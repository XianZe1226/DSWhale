import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Exercise the actual branch/command builder while replacing only native I/O.
// Never import the installer entrypoint, spawn a command, or impersonate CI.
const source = fs.readFileSync(new URL('../install-check.mjs', import.meta.url), 'utf8');
const marker = 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT';
const helperStart = source.indexOf('  function linuxInstall(');
const helperEnd = source.indexOf('\n  function linuxVersion()', helperStart);
const branchStart = source.indexOf("  } else if (context.platform === 'linux') {");
const branchEnd = source.indexOf("\n  } else {\n    throw new Error('unsupported platform');", branchStart);
assert.ok(helperStart > 0 && helperEnd > helperStart && branchStart > 0 && branchEnd > branchStart);

async function runLinuxBranch(caseName) {
  const calls = [];
  const files = new Map();
  let installed = '';
  const result = {checks: {}};
  const context = vm.createContext({
    caseName, result, path, MARKER: marker,
    temp: '/SYNTHETIC_TEMP', profile: {profile: '/SYNTHETIC_PROFILE'},
    artifactZip: async () => '/SYNTHETIC_ARTIFACT.zip',
    zipExtract() {},
    releaseAsset: async name => {
      calls.push({kind: 'old-download'});
      return '/SYNTHETIC_TEMP/' + name;
    },
    fs: {existsSync: file => file === '/opt/DSWhale/dswhale'},
    fsp: {
      mkdir: async () => {},
      writeFile: async (name, value) => files.set(name, value),
      readFile: async name => files.get(name),
    },
    linuxInstall: (file, options) => {
      calls.push({kind: 'install', file, options});
      installed = file.includes('alpha.11') ? '0.3.0~alpha.11' : '0.3.0~alpha.12';
    },
    linuxVersion: () => installed,
  });
  const body = source.slice(branchStart + "  } else if (context.platform === 'linux') {".length, branchEnd);
  await new vm.Script('(async function () {' + body + '\n})').runInContext(context)();
  return {calls, checks: result.checks};
}

test('Linux fresh/repeat requests a real reinstall of the identical a12 package', async () => {
  const {calls, checks} = await runLinuxBranch('fresh-repeat-marker');
  assert.equal(calls.some(call => call.kind === 'old-download'), false);
  const installs = calls.filter(call => call.kind === 'install');
  assert.equal(installs.length, 2);
  assert.equal(installs[0].file, installs[1].file);
  assert.ok(installs[0].file.endsWith('DSWhale-0.3.0-alpha.12-Linux-x86_64.deb'));
  assert.equal(installs[1].options?.reinstall, true);
  assert.equal(checks.firstVersion, '0.3.0~alpha.12');
  assert.equal(checks.repeatVersion, '0.3.0~alpha.12');
  assert.equal(checks.dataMarker, 'preserved');
});

test('Linux repeat passes --reinstall to APT without forcing the initial install', () => {
  const calls = [];
  const context = vm.createContext({
    env: {}, spawnSync: (command, args) => { calls.push({command, args}); return {status: 0}; },
  });
  const install = new vm.Script('(' + source.slice(helperStart, helperEnd).trim() + ')').runInContext(context);
  install('/SYNTHETIC/a12.deb');
  install('/SYNTHETIC/a12.deb', {reinstall: true});
  assert.equal(calls[0].command, 'sudo');
  assert.deepEqual(Array.from(calls[0].args), ['apt-get', 'install', '-y', '--no-install-recommends', '/SYNTHETIC/a12.deb']);
  assert.deepEqual(Array.from(calls[1].args), ['apt-get', 'install', '-y', '--no-install-recommends', '--reinstall', '/SYNTHETIC/a12.deb']);
});

test('Linux cross-version branch still installs a11 then a12 without forced reinstall', async () => {
  const {calls, checks} = await runLinuxBranch('installer-upgrade-marker');
  const installs = calls.filter(call => call.kind === 'install');
  assert.equal(installs.length, 2);
  assert.ok(installs[0].file.endsWith('DSWhale-0.3.0-alpha.11-Linux-x86_64.deb'));
  assert.ok(installs[1].file.endsWith('DSWhale-0.3.0-alpha.12-Linux-x86_64.deb'));
  assert.equal(installs[0].options?.reinstall, undefined);
  assert.equal(installs[1].options?.reinstall, undefined);
  assert.equal(checks.oldVersion, '0.3.0~alpha.11');
  assert.equal(checks.newVersion, '0.3.0~alpha.12');
  assert.equal(checks.dataMarker, 'preserved');
});
