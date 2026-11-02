'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness({ saveFails = false, recovery = {} } = {}) {
  const file = path.resolve(__dirname, '../main.cjs'), native = createRequire(file);
  const events = [];
  const supervisor = { running: true, async stop() { events.push('stop-conversation'); this.running = false; },
    async start() { events.push('start-conversation'); this.running = true; } };
  const napcat = { running: true, async stop() { events.push('stop-qq'); this.running = false; },
    async start() { if (!this.running) { events.push('launch-qq'); this.running = true; } return this.status(); },
    async configure() { if (this.running) throw Error('cannot reconfigure running QQ'); },
    async wire() { events.push('apply-connection'); return this.status(); },
    async status() { return { configured: true, externalOnly: false, canStart: true, running: this.running }; } };
  const manager = { host: 'synthetic-host', async inspect() { return { installed: true }; },
    async install() { events.push('prepare-backend'); } };
  const electron = { app: { setName() {}, getVersion: () => '0.3.0-alpha.8', requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), on() {} }, protocol: { registerSchemesAsPrivileged() {} } };
  const fakeServices = { ...native('./lib/services.cjs'), settingsCommand: async (_manager, command) => {
    if (command === 'save') { events.push('save-settings'); if (saveFails) throw Error('synthetic save failure'); }
    return { onebotPort: 6199, onebotToken: 'synthetic-existing-token' };
  } };
  const context = { require: name => name === 'electron' ? electron : name === './lib/services.cjs' ? fakeServices
    : name === 'node:fs/promises' ? { readdir: async () => { throw Object.assign(Error(), { code: 'ENOENT' }); } } : native(name),
    __dirname: path.dirname(file), process, console, Buffer, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `;globalThis.hooks={perform,stopAll,set(values){
    state.installed=true; manager=values.manager; supervisor=values.supervisor; napcat=values.napcat;
    extensions={operation:null,run:async()=>({})};appUpdater={status:async()=>({recovery:values.recovery})};}};`, context);
  context.hooks.set({ manager, supervisor, napcat, recovery });
  return { ...context.hooks, events, napcat, supervisor };
}

test('ordinary conversation stop preserves an already logged-in owned QQ process', async () => {
  const h = harness();
  const state = await h.perform('stop');
  assert.equal(state.running, false);
  assert.equal(h.napcat.running, true);
  assert.deepEqual(h.events, ['stop-conversation']);
});

test('saving a plugin toggle restarts the backend without stopping or launching QQ', async () => {
  const h = harness();
  await h.perform('settings-save', { biliEnabled: true });
  assert.equal(h.supervisor.running, true);
  assert.equal(h.napcat.running, true);
  assert.deepEqual(h.events, ['stop-conversation', 'save-settings', 'start-conversation']);
});

test('changed OneBot settings apply to a running QQ without a QQ login restart', async () => {
  const h = harness();
  await h.perform('settings-save', { onebotPort: 6299 });
  assert.equal(h.supervisor.running, true);
  assert.equal(h.napcat.running, true);
  assert.deepEqual(h.events, ['stop-conversation', 'save-settings', 'apply-connection', 'start-conversation']);
});

test('a failed settings save recovers the conversation without a QQ login restart', async () => {
  const h = harness({ saveFails: true });
  await assert.rejects(h.perform('settings-save', {}), /synthetic save failure/);
  assert.equal(h.supervisor.running, true);
  assert.equal(h.napcat.running, true);
  assert.equal(h.events.includes('stop-qq'), false);
  assert.equal(h.events.includes('launch-qq'), false);
});

test('backend environment preparation leaves the independent QQ identity process running', async () => {
  const h = harness();
  await h.perform('install');
  assert.equal(h.napcat.running, true);
  assert.deepEqual(h.events, ['stop-conversation', 'prepare-backend']);
});

test('full application shutdown still stops its own QQ and conversation services', async () => {
  const h = harness();
  await h.stopAll();
  assert.equal(h.napcat.running, false);
  assert.equal(h.supervisor.running, false);
  assert.deepEqual(h.events, ['stop-qq', 'stop-conversation']);
});

test('update recovery still stops QQ when all managed services must remain stopped', async () => {
  const h = harness({ recovery: { servicesMustRemainStopped: true } });
  await h.perform('install');
  assert.equal(h.napcat.running, false);
  assert.deepEqual(h.events, ['stop-qq', 'stop-conversation', 'prepare-backend']);
});
