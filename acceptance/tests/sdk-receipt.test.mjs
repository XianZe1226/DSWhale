import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawn, spawnSync} from 'node:child_process';

const source = fs.readFileSync(new URL('../sdk-check.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function semanticFixture(value) {');
const end = source.indexOf('\nfunction equalJson', start);
assert.ok(start > 0 && end > start);
const validate = new vm.Script('(' + source.slice(start, end) + ')').runInNewContext();
const good = () => ({
  schemaVersion: 2, kind: 'DSWhaleSyntheticStorageReadback', scenario: 'small-only',
  snapshotSha256: 'a'.repeat(64), embeddingMode: 'deterministic-storage-test-double',
  counts: {personas: 2, conversations: 2, memories: 2, vectors: 2},
  sqliteIntegrity: 'ok', markerPreserved: true, networkGuard: {probeBlocked: true},
});
test('SDK receipt rejects empty or malformed seed evidence', () => {
  validate(good());
  for (const counts of [{}, {personas: 0}, {personas: 2, conversations: 2, memories: 2, vectors: 0}]) {
    assert.throws(() => validate({...good(), counts}), /baseline/);
  }
  assert.throws(() => validate({...good(), kind: 'unrelated-log-json'}), /invalid/);
});
test('SDK receipt preserves a changed full-snapshot digest', () => {
  const before = validate(good());
  const after = validate({...good(), snapshotSha256: 'b'.repeat(64)});
  assert.notEqual(before.snapshotSha256, after.snapshotSha256);
});
test('SDK receipt requires marker, integrity and process guard evidence', () => {
  for (const patch of [{markerPreserved: false}, {sqliteIntegrity: 'corrupt'}, {networkGuard: {}}, {embeddingMode: 'unreported-mock'}]) {
    assert.throws(() => validate({...good(), ...patch}), /integrity/);
  }
});

test('SDK entrypoint rejects an ordinary local process before doing work', () => {
  const child = spawnSync(process.execPath, ['acceptance/sdk-check.mjs', '--scenario=small-only'], {
    cwd: process.cwd(), env: {PATH: process.env.PATH}, encoding: 'utf8',
  });
  assert.equal(child.status, 1);
  const error = JSON.parse(child.stderr);
  assert.equal(error.code, 'ACCEPTANCE_RUNNER_REJECTED');
  assert.equal(error.passed, false);
  assert.equal(Object.hasOwn(error, 'errors'), false);
});

test('runtime process forwards safe progress and retains the final result', async () => {
  const start = source.indexOf('async function runRuntimeProcess(');
  const end = source.indexOf('\nasync function main()', start);
  assert.ok(start > 0 && end > start);
  const forwarded = [];
  const run = new vm.Script('(' + source.slice(start, end) + ')').runInNewContext({
    spawn, setTimeout, clearTimeout, console: {log: line => forwarded.push(JSON.parse(line))},
  });
  const code = 'console.log(JSON.stringify({stage:"runtime",phase:"installing",step:"SYNTHETIC_DO_NOT_LOG",progress:0.5}));console.log(JSON.stringify({installed:true}));';
  const output = await run(process.execPath, ['-e', code], {cwd: process.cwd(), env: {PATH: process.env.PATH}});
  assert.match(output, /"installed":true/);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].phase, 'installing');
  assert.equal(forwarded[0].progress, 0.5);
  assert.equal(JSON.stringify(forwarded).includes('SYNTHETIC_DO_NOT_LOG'), false);
});
