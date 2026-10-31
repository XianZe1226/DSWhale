const test = require('node:test');
const assert = require('node:assert/strict');

test('extension requests reject arbitrary source URLs and return bounded plugin state', async () => {
  const { ExtensionRunner } = require('../lib/extensions.cjs');
  const calls = [];
  const manager = { python: 'python-fixture', host: '/fixture/host', environment: async () => ({ FIXTURE: '1' }) };
  const cards = { memory: { installed: true, version: '2.7.1' }, memes: { installed: false } };
  const runner = new ExtensionRunner(manager, async (...args) => { calls.push(args); return Buffer.from(JSON.stringify(cards)); });
  await assert.rejects(runner.run('update', 'https://evil.test/code'), /插件/);
  await assert.rejects(runner.run('exec', 'memory'), /操作/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await runner.run('check', 'memory'), cards);
  assert.deepEqual(calls[0][1], ['-m', 'dswhale.extensions', '--host', manager.host, 'check', '--id', 'memory']);
  assert.ok(calls[0][2].signal instanceof AbortSignal);
});

test('extension shutdown cancels work and fences commands awaiting environment', async () => {
  const { ExtensionRunner } = require('../lib/extensions.cjs');
  let release; const waiting = new Promise(resolve => { release = resolve; }); let called = false;
  const manager = { host: '/fixture', environment: () => waiting };
  const runner = new ExtensionRunner(manager, async () => { called = true; });
  const pending = runner.run('check', 'memory');
  const closing = runner.close(); release({});
  await assert.rejects(pending, /退出|取消/); await closing;
  assert.equal(called, false);
  await assert.rejects(runner.run('status'), /退出/);
});

test('extension IPC allowlists ids and refuses extra payload properties', () => {
  const { validateRequest } = require('../lib/security.cjs');
  const shell = { mainFrame: {} }, event = { sender: shell, senderFrame: shell.mainFrame };
  assert.doesNotThrow(() => validateRequest(event, shell, 'extensions-status'));
  assert.doesNotThrow(() => validateRequest(event, shell, 'extension-check', { id: 'memory' }));
  for (const payload of [{ id: 'other' }, { id: 'memory', url: 'https://evil.test' }, null]) {
    assert.throws(() => validateRequest(event, shell, 'extension-update', payload));
  }
});

test('plugin replacement stops service first and never automatically restarts it', async () => {
  const { runExtensionAction } = require('../lib/extensions.cjs');
  const calls = [];
  const host = { runner: { run: async (action, id) => { calls.push(action); return { memory: {}, memes: {} }; } }, supervisor: { stop: async () => calls.push('stop'), start: async () => calls.push('start') }, closePanel: () => calls.push('close'), publish: () => {}, refresh: async () => calls.push('refresh'), isClosing: () => false };
  await runExtensionAction(host, 'update', 'memory');
  assert.deepEqual(calls, ['close', 'stop', 'update', 'refresh']);
  calls.length = 0;
  await runExtensionAction(host, 'check', 'memory');
  assert.deepEqual(calls, ['check']);
});

test('actual Electron action dispatcher routes manual extension actions to the updater', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const file = path.resolve(__dirname, '../main.cjs');
  const nativeRequire = require('node:module').createRequire(file);
  const app = { setName() {}, getVersion: () => 'fixture', requestSingleInstanceLock: () => false, quit() {} };
  const sandbox = { require: id => id === 'electron' ? { app, protocol: { registerSchemesAsPrivileged() {} } } : nativeRequire(id), __dirname: path.dirname(file), process, module: { exports: {} }, setTimeout, clearTimeout };
  const source = fs.readFileSync(file, 'utf8') + '\n globalThis.harness = { perform, set(value) { state.installed = true; extensions = value.runner; supervisor = value.supervisor; manager = value.manager; } };';
  vm.runInNewContext(source, sandbox, { filename: file });
  const calls = [], cards = { memory: { installed: true }, memes: { installed: false } };
  sandbox.harness.set({ runner: { run: async (action, id) => { calls.push([action, id]); return cards; } }, supervisor: { running: false, stop: async () => calls.push(['stop']) }, manager: { host: path.join(require('node:os').tmpdir(), 'dswhale-dispatch-fixture-absent'), inspect: async () => ({ installed: false }) } });
  assert.deepEqual(await sandbox.harness.perform('extension-check', { id: 'memory' }), cards);
  assert.deepEqual(calls, [['check', 'memory']]);
  calls.length = 0;
  assert.deepEqual(await sandbox.harness.perform('extension-update', { id: 'memory' }), cards);
  assert.deepEqual(calls, [['stop'], ['update', 'memory']]);
  calls.length = 0;
  sandbox.harness.set({ runner: { run: async () => { throw new Error('请先恢复未完成的更新'); } }, supervisor: { start: async () => calls.push(['start']) } });
  await assert.rejects(sandbox.harness.perform('start'), /恢复/);
  assert.deepEqual(calls, []);
});
