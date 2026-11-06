import test from 'node:test';
import assert from 'node:assert/strict';
import {minimizeEnvironment} from '../windows-startup-env.mjs';

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
