// Side-effect-free runner/context guards and subprocess environment whitelists.
import path from 'node:path';

export const EXPECTED = Object.freeze({
  repository: 'XianZe1226/DSWhale',
  ref: 'refs/heads/codex/a12-acceptance',
  event: 'push',
  binaryCommit: '6997f37102efe07cfdfd3d4b1a60b584a2b56158',
});
export const CASES = Object.freeze(['installer-upgrade-marker']);
const pathFor = platform => platform === 'win32' ? path.win32 : path;
const isAbsolute = (value, platform) => { const p = pathFor(platform); return typeof value === 'string' && value.length > 0 && p.isAbsolute(value); };
function value(env, key, platform) {
  if (platform === 'win32') {
    const lower = key.toLowerCase();
    const entry = Object.entries(env).find(([name]) => name.toLowerCase() === lower);
    return entry ? entry[1] : undefined;
  }
  return env[key];
}
function need(env, key, platform, failures) {
  const found = value(env, key, platform);
  if (typeof found !== 'string' || !found) failures.push(key);
  return found;
}
export function validateRunnerContext(env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const failures = [];
  if (!['win32', 'linux'].includes(platform)) failures.push('platform');
  if (arch !== 'x64') failures.push('arch');
  const actions = need(env, 'GITHUB_ACTIONS', platform, failures);
  if (actions !== 'true') failures.push('GITHUB_ACTIONS');
  const runner = need(env, 'RUNNER_ENVIRONMENT', platform, failures);
  if (runner !== 'github-hosted') failures.push('RUNNER_ENVIRONMENT');
  const repository = need(env, 'GITHUB_REPOSITORY', platform, failures);
  if (repository !== EXPECTED.repository) failures.push('GITHUB_REPOSITORY');
  const ref = need(env, 'GITHUB_REF', platform, failures);
  if (ref !== EXPECTED.ref) failures.push('GITHUB_REF');
  const event = need(env, 'GITHUB_EVENT_NAME', platform, failures);
  if (event !== EXPECTED.event) failures.push('GITHUB_EVENT_NAME');
  const runnerArch = need(env, 'RUNNER_ARCH', platform, failures);
  if (String(runnerArch || '').toUpperCase() !== 'X64') failures.push('RUNNER_ARCH');
  const runnerOs = need(env, 'RUNNER_OS', platform, failures);
  const wantedOs = platform === 'win32' ? 'Windows' : 'Linux';
  if (String(runnerOs || '').toUpperCase() !== wantedOs.toUpperCase()) failures.push('RUNNER_OS');
  const p = pathFor(platform);
  const runnerTemp = need(env, 'RUNNER_TEMP', platform, failures);
  if (!isAbsolute(runnerTemp, platform)) failures.push('RUNNER_TEMP');
  const workspace = need(env, 'GITHUB_WORKSPACE', platform, failures);
  if (!isAbsolute(workspace, platform)) failures.push('GITHUB_WORKSPACE');
  const binaryRoot = need(env, 'BINARY_ROOT', platform, failures);
  if (!isAbsolute(binaryRoot, platform)) failures.push('BINARY_ROOT');
  if (isAbsolute(workspace, platform) && isAbsolute(binaryRoot, platform)) {
    const expected = p.resolve(workspace, 'binary');
    if (p.resolve(binaryRoot) !== expected) failures.push('BINARY_ROOT');
  }
  if (isAbsolute(runnerTemp, platform) && (p.parse(runnerTemp).root === runnerTemp || p.parse(workspace || '').root === workspace)) failures.push('ROOT_PATH');
  if (failures.length) {
    const error = new Error(`Refusing acceptance install outside a verified disposable GitHub-hosted ${platform === 'win32' ? 'Windows' : 'Linux'} x64 push runner: ${[...new Set(failures)].join(', ')}`);
    error.code = 'ACCEPTANCE_RUNNER_REJECTED';
    error.fields = [...new Set(failures)];
    throw error;
  }
  return { repository, ref, event, platform, arch, runnerTemp: p.resolve(runnerTemp), workspace: p.resolve(workspace), binaryRoot: p.resolve(binaryRoot) };
}
export function allowedCase(name) {
  if (!CASES.includes(name)) { const error = new Error(`Unknown acceptance case: ${String(name)}`); error.code = 'ACCEPTANCE_CASE_REJECTED'; throw error; }
  return name;
}
const COMMON = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];
const LINUX = [...COMMON, 'HOME', 'USER', 'LOGNAME', 'SHELL'];
const WINDOWS = ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'LANG', 'LC_ALL', 'TZ'];
export function childEnv(platform, env = process.env, extras = {}) {
  const keys = platform === 'win32' ? WINDOWS : LINUX;
  const out = {};
  for (const key of keys) {
    const found = value(env, key, platform);
    if (found !== undefined) out[key] = found;
  }
  for (const [key, val] of Object.entries(extras)) if (val !== undefined) out[key] = val;
  return out;
}
export function profilePaths(platform, env) {
  const p = pathFor(platform);
  if (platform === 'win32') {
    const appData = value(env, 'APPDATA', platform);
    if (!isAbsolute(appData, platform)) throw new Error('APPDATA must be an absolute test-user path');
    return { parent: appData, profile: p.join(appData, 'DSWhale') };
  }
  const home = value(env, 'HOME', platform);
  if (!isAbsolute(home, platform)) throw new Error('HOME must be an absolute test-user path');
  const config = p.join(home, '.config');
  return { parent: config, profile: p.join(config, 'DSWhale') };
}
