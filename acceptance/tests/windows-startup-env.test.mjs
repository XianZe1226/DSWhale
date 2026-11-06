import test from 'node:test';
import assert from 'node:assert/strict';
import {minimizeEnvironment, startupExtras} from '../windows-startup-env.mjs';
import {childEnv} from '../safety.mjs';

test('Windows child retains OS module-analysis cache context but excludes module search overrides', () => {
  const result = childEnv('win32', {PSModuleAnalysisCachePath: 'synthetic-cache', PSModulePath: 'untrusted-modules', GITHUB_TOKEN: 'private'});
  assert.deepEqual(result, {PSModuleAnalysisCachePath: 'synthetic-cache'});
  assert.deepEqual(startupExtras({}, {PSModuleAnalysisCachePath: 'synthetic-cache'}), {PSModuleAnalysisCachePath: 'synthetic-cache'});
});

test('startup diagnostic only forwards explicitly allowed OS context', () => {
  const result = startupExtras({SystemRoot: 'base'}, {systemroot: 'other', USERDOMAIN_ROAMINGPROFILE: 'os-value', DATABASE_URL: 'private', CONNECTION_STRING: 'private', DSN: 'private', UNKNOWN_STANDARD_LOOKING: 'private', GITHUB_TOKEN: 'private'});
  assert.deepEqual(result, {USERDOMAIN_ROAMINGPROFILE: 'os-value'});
});

test('environment diagnostic isolates missing context without exporting values', async () => {
  const result = await minimizeEnvironment({BASE: 'x'}, {A: 'PRIVATE_A', B: 'PRIVATE_B', C: 'PRIVATE_C', D: 'PRIVATE_D'}, env => env.B === 'PRIVATE_B', 16);
  assert.deepEqual(result.requiredKeys, ['B']);
  assert.equal(result.isolated, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});
test('environment diagnostic preserves interactions and respects its execution limit', async () => {
  let actual = 0;
  const result = await minimizeEnvironment({}, {A: 'a', B: 'b', C: 'c'}, env => {actual++; return Boolean(env.A && env.C);}, 12);
  assert.deepEqual(result.requiredKeys, ['A', 'C']);
  assert.equal(actual, result.calls);
  assert.ok(actual <= 12);
});
test('no differential result is never presented as an isolated cause', async () => {
  assert.equal((await minimizeEnvironment({}, {A: 'x'}, () => false)).isolated, false);
  assert.equal((await minimizeEnvironment({}, {A: 'x'}, () => true)).isolated, false);
});
