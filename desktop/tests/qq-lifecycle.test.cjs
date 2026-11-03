'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness({ saveFails = false, recovery = {}, backendRunning = true, qqRunning = true, loginState = 'online', backendReadyWait, startFails = false } = {}) {
  const file = path.resolve(__dirname, '../main.cjs'), native = createRequire(file);
  const events = [], snapshots = [];
  const supervisor = { running: backendRunning, async stop() { events.push('stop-conversation'); this.running = false; },
    async start() { if (this.running) return; events.push('start-conversation'); if(startFails)throw Error('synthetic backend failure'); await backendReadyWait; this.running = true; } };
  const napcat = { running: qqRunning, async stop() { events.push('stop-qq'); this.running = false; },
    async start() { if (!this.running) { events.push('launch-qq'); this.running = true; } return this.status(); },
    async configure() { if (this.running) throw Error('cannot reconfigure running QQ'); },
    async wire() { events.push('apply-connection'); return this.status(); },
    async loginInfo() { return {url:'http://127.0.0.1:6099/webui/',token:'synthetic-only-management-token'}; },
    async status() { return { configured: true, externalOnly: false, canStart: true, running: this.running, loginState: this.running ? loginState : 'stopped', hasSavedLogin: true, connectionConfigured: true, protocolConnected: false }; } };
  const manager = { host: 'synthetic-host', async inspect() { return { installed: true }; },
    async install() { events.push('prepare-backend'); } };
  class LocalView { constructor() { this.webContents={setWindowOpenHandler(){},on(){},close(){},loadURL:async()=>events.push('open-qq-management')}; } setBounds(){} }
  const electron = { WebContentsView:LocalView, app: { setName() {}, getVersion: () => '0.3.0-alpha.8', requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), on() {} }, protocol: { registerSchemesAsPrivileged() {} } };
  const fakeServices = { ...native('./lib/services.cjs'), settingsCommand: async (_manager, command) => {
    if (command === 'save') { events.push('save-settings'); if (saveFails) throw Error('synthetic save failure'); }
    return { onebotPort: 6199, onebotToken: 'synthetic-existing-token' };
  } };
  const context = { require: name => name === 'electron' ? electron : name === './lib/services.cjs' ? fakeServices
    : name === 'node:fs/promises' ? { readdir: async () => { throw Object.assign(Error(), { code: 'ENOENT' }); } } : native(name),
    __dirname: path.dirname(file), process, console, Buffer, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `;globalThis.hooks={perform,stopAll,publishQQ,getState:()=>state,set(values){
    state.installed=true; manager=values.manager; supervisor=values.supervisor; napcat=values.napcat;
    window={isDestroyed:()=>false,webContents:{send:(_channel,value)=>values.snapshot(value)},contentView:{addChildView(){},removeChildView(){}},getContentSize:()=>[1220,850]};
    extensions={operation:null,run:async()=>({})};appUpdater={status:async()=>({recovery:values.recovery})};}};`, context);
  context.hooks.set({ manager, supervisor, napcat, recovery, snapshot: value => snapshots.push(JSON.parse(JSON.stringify(value))) });
  return { ...context.hooks, events, snapshots, napcat, supervisor };
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

test('startup shows backend readiness before it starts QQ, then shows the actual login-resume wait', async () => {
  let ready;
  const wait = new Promise(resolve => { ready = resolve; });
  const h = harness({ backendRunning: false, qqRunning: false, loginState: 'resuming', backendReadyWait: wait });
  const pending = h.perform('start');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.getState().startup?.stage, 'starting-conversation');
  assert.equal(h.events.includes('launch-qq'), false);
  ready(); await pending;
  assert.deepEqual(h.events.filter(e => ['start-conversation', 'launch-qq'].includes(e)), ['start-conversation', 'launch-qq']);
  assert.equal(h.getState().startup.stage, 'resuming');
  assert.ok(h.snapshots.some(s => s.startup?.stage === 'starting-qq'));
});

test('starting conversation with an online QQ explicitly reuses that process and waits for the real host connection', async () => {
  const h = harness({ backendRunning: false, qqRunning: true });
  await h.perform('start');
  assert.equal(h.events.includes('launch-qq'), false);
  assert.equal(h.events.includes('stop-qq'), false);
  assert.ok(h.snapshots.some(s => s.startup?.stage === 'reusing-qq'));
  assert.equal(h.getState().startup.stage, 'awaiting-link');
  h.publishQQ({ running: true, configured: true, loginState: 'online', connectionConfigured: true, protocolConnected: true });
  assert.equal(h.getState().startup.stage, 'ready');
  h.publishQQ({ running: true, configured: true, loginState: 'scan-required', connectionConfigured: true, protocolConnected: true });
  assert.equal(h.getState().startup.stage, 'scan-required', 'stale host health cannot conceal a current login verification request');
});

test('a failed backend start reports its failed stage without relaunching an existing QQ', async () => {
  const h = harness({ backendRunning: false, qqRunning: true, startFails: true });
  await assert.rejects(h.perform('start'), /synthetic backend failure/);
  assert.equal(h.getState().startup?.stage, 'failed');
  assert.equal(h.napcat.running, true);
  assert.equal(h.events.includes('launch-qq'), false);
});

test('a running owned QQ can be managed while conversation is paused without starting or logging it in again', async () => {
  const h=harness({backendRunning:false,qqRunning:true});
  await h.perform('open-panel',{panel:'napcat'});
  assert.deepEqual(h.events,['open-qq-management']);
  assert.equal(h.getState().panel,'napcat');
  assert.equal(JSON.stringify(h.getState()).includes('synthetic-only-management-token'),false);
});
