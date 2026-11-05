import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {CASES, allowedCase, assertRealDirectory, childEnv, profilePaths, validateRunnerContext} from '../safety.mjs';

const workspace = '/home/runner/work/DSWhale/DSWhale';
const base = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_REPOSITORY: 'XianZe1226/DSWhale',
  GITHUB_REF: 'refs/heads/codex/a12-acceptance',
  GITHUB_EVENT_NAME: 'push',
  RUNNER_ARCH: 'X64',
  RUNNER_OS: 'Linux',
  RUNNER_TEMP: '/home/runner/work/_temp',
  GITHUB_WORKSPACE: workspace,
  BINARY_ROOT: path.join(workspace, 'binary'),
  HOME: '/home/runner',
  USER: 'runner',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  TMPDIR: '/home/runner/work/_temp',
};
const linux = {platform: 'linux', arch: 'x64'};
const expectRejected = (env, options = linux) => {
  assert.throws(() => validateRunnerContext(env, options), error => {
    assert.equal(error.code, 'ACCEPTANCE_RUNNER_REJECTED');
    assert.ok(Array.isArray(error.fields));
    return true;
  });
};
test('accepts only the exact Linux hosted push acceptance context', () => {
  const context = validateRunnerContext(base, linux);
  assert.equal(context.repository, 'XianZe1226/DSWhale');
  assert.equal(context.ref, 'refs/heads/codex/a12-acceptance');
  assert.equal(context.event, 'push');
  assert.equal(context.platform, 'linux');
  assert.equal(context.arch, 'x64');
});
test('accepts the exact Windows hosted x64 push context', () => {
  const winWorkspace = String.raw`D:\a\DSWhale\DSWhale`;
  const env = { ...base, RUNNER_OS: 'Windows', RUNNER_TEMP: String.raw`D:\a\_temp`, GITHUB_WORKSPACE: winWorkspace, BINARY_ROOT: path.win32.join(winWorkspace, 'binary'), APPDATA: String.raw`C:\Users\runner\AppData\Roaming` };
  const context = validateRunnerContext(env, {platform: 'win32', arch: 'x64'});
  assert.equal(context.platform, 'win32');
});
test('rejects non-CI, self-hosted, wrong repo/ref/event/arch and escaping paths before effects', () => {
  let effects = 0;
  const guarded = env => { validateRunnerContext(env, linux); effects += 1; };
  const mutations = [
    {GITHUB_ACTIONS: undefined}, {GITHUB_ACTIONS: 'false'}, {RUNNER_ENVIRONMENT: 'self-hosted'},
    {GITHUB_REPOSITORY: 'attacker/DSWhale'}, {GITHUB_REF: 'refs/heads/main'}, {GITHUB_EVENT_NAME: 'pull_request'},
    {RUNNER_ARCH: 'ARM64'}, {RUNNER_OS: 'Windows'}, {RUNNER_TEMP: 'relative/temp'}, {RUNNER_TEMP: '/'},
    {GITHUB_WORKSPACE: undefined}, {BINARY_ROOT: '/tmp/binary'},
  ];
  for (const mutation of mutations) {
    const env = { ...base, ...mutation };
    if (mutation.GITHUB_ACTIONS === undefined) delete env.GITHUB_ACTIONS;
    expectRejected(env);
    assert.throws(() => guarded(env));
  }
  assert.equal(effects, 0);
});
test('rejects wrong process platform/arch', () => {
  expectRejected(base, {platform: 'darwin', arch: 'x64'});
  expectRejected(base, {platform: 'linux', arch: 'arm64'});
});
test('rejects unknown case names and keeps the allowlist exact', () => {
  assert.deepEqual([...CASES], ['installer-upgrade-marker', 'fresh-repeat-marker']);
  assert.equal(allowedCase('installer-upgrade-marker'), 'installer-upgrade-marker');
  assert.equal(allowedCase('fresh-repeat-marker'), 'fresh-repeat-marker');
  assert.throws(() => allowedCase('cross-small'), /Unknown acceptance case/);
});
test('uses a whitelist, not an inherited environment, for installer/tool children', () => {
  const env = {
    ...base,
    GITHUB_TOKEN: 'fake-github-token', GH_TOKEN: 'fake-gh-token', ACTIONS_RUNTIME_TOKEN: 'fake-actions-token',
    SYNTHETIC_SECRET: 'fake-secret', CFFIXED_USER_HOME: '/tmp/real-profile', DSWHALE_FOO: 'fake', ASTRBOT_ROOT: '/tmp/fake-root',
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: '/tmp/temp', HOME: '/home/runner', USER: 'runner', LOGNAME: 'runner',
  };
  const child = childEnv('linux', env);
  for (const forbidden of ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'SYNTHETIC_SECRET', 'CFFIXED_USER_HOME', 'DSWHALE_FOO', 'ASTRBOT_ROOT']) {
    assert.equal(Object.hasOwn(child, forbidden), false);
  }
  assert.equal(child.PATH, '/usr/bin:/bin');
  assert.equal(child.HOME, '/home/runner');
  assert.equal(child.USER, 'runner');
  assert.equal(child.LANG, 'C.UTF-8');
});
test('Windows child environment is whitelist-only and case-insensitive', () => {
  const env = {
    GITHUB_TOKEN: 'fake-github-token', SYNTHETIC_SECRET: 'fake-secret', CFFIXED_USER_HOME: '/tmp/real-profile',
    SYSTEMROOT: 'C:\\\\Windows', Path: 'C:\\\\Windows\\\\System32', TEMP: 'C:\\\\Users\\\\runner\\\\AppData\\\\Local\\\\Temp',
    APPDATA: 'C:\\\\Users\\\\runner\\\\AppData\\\\Roaming', USERPROFILE: 'C:\\\\Users\\\\runner', OS: 'Windows_NT',
  };
  const child = childEnv('win32', env);
  for (const forbidden of ['GITHUB_TOKEN', 'SYNTHETIC_SECRET', 'CFFIXED_USER_HOME']) assert.equal(Object.hasOwn(child, forbidden), false);
  assert.equal(child.SystemRoot, 'C:\\\\Windows');
  assert.equal(child.PATH, 'C:\\\\Windows\\\\System32');
  assert.equal(child.APPDATA, 'C:\\\\Users\\\\runner\\\\AppData\\\\Roaming');
  assert.equal(child.TEMP, 'C:\\\\Users\\\\runner\\\\AppData\\\\Local\\\\Temp');
});
test('standard profile paths are absolute and fixed to the test user', () => {
  assert.deepEqual(profilePaths('linux', base), {parent: '/home/runner/.config', profile: '/home/runner/.config/DSWhale'});
  const appData = String.raw`C:\Users\runner\AppData\Roaming`;
  assert.deepEqual(profilePaths('win32', {APPDATA: appData}), {parent: appData, profile: path.win32.join(appData, 'DSWhale')});
  assert.throws(() => profilePaths('linux', {HOME: 'relative'}), /absolute/);
});
test('rejects symlinked/root/owned test directories before use', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.a12-path-test-'));
  const real = path.join(root, 'real'); fs.mkdirSync(real);
  const link = path.join(root, 'link'); fs.symlinkSync(real, link);
  assert.equal(assertRealDirectory(real, 'test dir'), path.resolve(real));
  assert.throws(() => assertRealDirectory(link, 'link dir'), error => error.code === 'ACCEPTANCE_PATH_REJECTED');
  fs.rmSync(root, {recursive: true, force: true});
});
test('entrypoint rejects a non-CI environment without touching the filesystem', () => {
  const result = spawnSync(process.execPath, ['acceptance/install-check.mjs', '--case=installer-upgrade-marker'], {
    cwd: process.cwd(),
    env: {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: '/tmp/a12-guard-test'},
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.passed, false);
  assert.equal(parsed.code, 'ACCEPTANCE_RUNNER_REJECTED');
  assert.ok(parsed.fields.includes('GITHUB_ACTIONS'));
  assert.equal(fs.existsSync('/tmp/a12-guard-test'), false);
});
