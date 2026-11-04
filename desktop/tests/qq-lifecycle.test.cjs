'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness({ saveFails = false, recovery = {}, backendRunning = true, qqRunning = true, loginState = 'online', backendReadyWait, qqStatusWait, qqConfigureWait, qqMode='napcat', startFails = false, settingsOverrides = {}, hostQuery = null, workspace = null, dialogResponse = 1, settingsHistory = null, useRealWorkspace = false } = {}) {
  const file = path.resolve(__dirname, '../main.cjs'), native = createRequire(file);
  const events = [], snapshots = [], loadedURLs = [], savePayloads = [], restorePayloads = [], wirePorts = [], views = [];
  const settingsState = { configRevision: 'abcdef12', defaultDelivery: '', napcatBound: true, officialBound: false, officialOwnerUMO: '', ...settingsOverrides };
  const supervisor = { dashboard:async()=> 'http://127.0.0.1:6185/', running: backendRunning, async stop() { events.push('stop-conversation'); this.running = false; },
    async start() { if (this.running) return; events.push('start-conversation'); if(startFails)throw Error('synthetic backend failure'); await backendReadyWait; this.running = true; } };
  const napcat = { configurationCalls:0, running: qqRunning, generation: 0, child: { exitCode: null, killed: false, pid: 987654321 },
    identityToken: 'identity-token-a', identityKnown: true,
    async identityRevision() { return { token: this.identityToken, known: this.identityKnown }; }, async stop() { events.push('stop-qq'); this.running = false; },
    async start() { if (!this.running) { events.push('launch-qq'); this.running = true; } return this.status(); },
    async configure() { this.configurationCalls++;await qqConfigureWait; if (this.running) throw Error('cannot reconfigure running QQ'); },
    async wire() { wirePorts.push(settingsState.onebotPort); events.push('apply-connection'); return this.status(); },
    async loginInfo() { return {url:'http://127.0.0.1:6099/webui/',token:'synthetic-only-management-token'}; },
    async status() { await qqStatusWait; return { configured: true, externalOnly: false, canStart: true, running: this.running, loginState: this.running ? loginState : 'stopped', hasSavedLogin: true, connectionConfigured: true, protocolConnected: false }; } };
  const effectiveWorkspace = workspace || (useRealWorkspace ? new (require('../lib/workspace.cjs').Workspace)({ napcat }) : null);
  const manager = { runtime:'synthetic-runtime',host: 'synthetic-host', inspectCalls:0, async inspect() { this.inspectCalls += 1; return { installed: true }; },
    async install() { events.push('prepare-backend'); } };
  class LocalView { constructor() { views.push(this); this.webContents={setWindowOpenHandler(){},on(){},close(){},isDestroyed:()=>false,loadURL:async url=>{loadedURLs.push(url);events.push('open-qq-management');}}; } setBounds(){} }
  const dialogs = [];
  const dialogReply = typeof dialogResponse === 'function' ? dialogResponse : () => dialogResponse;
  const electron = { session:{fromPartition:()=>({clearStorageData:async()=>{}})}, WebContentsView:LocalView, dialog:{showMessageBox:async(...args)=>{dialogs.push(args.at(-1));return {response:dialogReply()};}}, app: { setName() {}, getVersion: () => '0.3.0-alpha.8', requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), on() {} }, protocol: { registerSchemesAsPrivileged() {} } };
  const fakeServices = { ...native('./lib/services.cjs'), settingsCommand: async (_manager, command, payload) => {
    if (command === 'save') {
      events.push('save-settings'); savePayloads.push(payload);
      if (saveFails) throw Error('synthetic save failure');
      const patch = payload && payload.patch && typeof payload.patch === 'object' ? payload.patch : payload;
      if (patch && typeof patch === 'object') Object.assign(settingsState, patch);
    }
    if (command === 'history') return settingsHistory || { format: 1, records: [], migrationReceipt: null };
    if (command === 'restore-field') {
      events.push('restore-field'); restorePayloads.push(payload);
      const record = settingsHistory?.records?.find(item => item.id === payload?.recordId);
      const change = record?.changes?.find(item => item.field === payload?.field);
      if (change && 'before' in change) Object.assign(settingsState, { [payload.field]: change.before });
    }
    return { ...settingsState, qqConnectionMode:qqMode, onebotPort: settingsState.onebotPort ?? 6199, onebotToken: 'synthetic-existing-token' };
  } };
  const context = { require: name => name === 'electron' ? electron : name === './lib/services.cjs' ? fakeServices
    : name === 'node:fs/promises' ? {writeFile:async()=>{},rm:async()=>{}, readdir: async () => { throw Object.assign(Error(), { code: 'ENOENT' }); } } : native(name),
    __dirname: path.dirname(file), process, console, Buffer, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `;globalThis.hooks={perform,stopAll,publishQQ,restoreFile,refresh,getState:()=>state,requestShutdown:()=>{shutdownRequested=true;},set(values){
    state.installed=true;operations={snapshot:async()=>{}};hostCommand=async()=>{};manager=values.manager; supervisor=values.supervisor; napcat=values.napcat;
    window={isDestroyed:()=>false,webContents:{send:(_channel,value)=>values.snapshot(value)},contentView:{addChildView(){},removeChildView(){}},getContentSize:()=>[1220,850]};
    extensions={operation:null,run:async()=>({})};appUpdater={status:async()=>({recovery:values.recovery})};hostQueryOverride=values.hostQuery||null;if(values.workspace)workspace=values.workspace;}};`, context);
  context.hooks.set({ manager, supervisor, napcat, recovery, hostQuery, workspace: effectiveWorkspace, snapshot: value => snapshots.push(JSON.parse(JSON.stringify(value))) });
  return { ...context.hooks, events, snapshots, loadedURLs, savePayloads, restorePayloads, wirePorts, views, dialogs, napcat, supervisor, settingsState, manager };
}

function enabledOneBotPlatforms() {
  return async args => {
    if (args[0] === 'status') return { platforms: [
      { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
    ] };
    if (args[0] === 'pending') return { pending: false };
    return {};
  };
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
  const h = harness({ hostQuery: enabledOneBotPlatforms() });
  await h.perform('settings-save', { onebotPort: 6299 });
  assert.equal(h.supervisor.running, true);
  assert.equal(h.napcat.running, true);
  assert.deepEqual(h.events, ['stop-conversation', 'save-settings', 'apply-connection', 'start-conversation']);
});

test('a failed settings save recovers the conversation without a QQ login restart', async () => {
  const h = harness({ saveFails: true });
  await assert.rejects(h.perform('settings-save', { biliEnabled: true }), /synthetic save failure/);
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
  const h = harness({ backendRunning: false, qqRunning: false, loginState: 'resuming', backendReadyWait: wait, hostQuery: enabledOneBotPlatforms() });
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
  const h = harness({ backendRunning: false, qqRunning: true, hostQuery: enabledOneBotPlatforms() });
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

for (const boundary of ['backendReadyWait','qqStatusWait','qqConfigureWait']) {
  test('quit during '+boundary+' cannot launch QQ after final cleanup', async () => {
    let release;
    const wait = new Promise(resolve=>{release=resolve;});
    const h=harness({backendRunning:false,qqRunning:false,[boundary]:wait,hostQuery:enabledOneBotPlatforms()});
    const started=h.perform('start');
    const result=assert.rejects(started,/退出|取消/);
    await new Promise(resolve=>setImmediate(resolve));
    h.requestShutdown();
    // Release the wait while shutdown stops its owned processes.
    release();
    await h.stopAll();
    await result;
    assert.equal(h.events.includes('launch-qq'),false);
    assert.equal(h.napcat.running,false);
    assert.equal(h.supervisor.running,false);
  });
}

test('models console uses the actual providers route and cache-only bundle refresh entry',async()=>{
 const h=harness();await h.perform('open-panel',{panel:'models'});
 const url=new URL(h.loadedURLs[0]);assert.equal(url.origin,'http://127.0.0.1:6185');assert.equal(url.hash,'#/providers');
 assert.ok(url.searchParams.get('astrbot_bundle')?.includes('0.3.0-alpha.8'));assert.ok(url.searchParams.get('astrbot_bundle')?.includes('4.29.3'));
});

test('official QQ startup starts its host without configuring or launching NapCat',async()=>{
 const h=harness({backendRunning:false,qqRunning:false,qqMode:'official'});
 await h.perform('start');assert.equal(h.supervisor.running,true);assert.equal(h.napcat.running,false);
 assert.equal(h.events.includes('launch-qq'),false);assert.equal(h.events.includes('apply-connection'),false);
 assert.ok(h.getState().workspace?.official);
});


test('restoring an official-only backup does not configure a retained NapCat component',async()=>{
 const h=harness({qqMode:'official',qqRunning:false});
 await h.restoreFile('synthetic-backup.zip');
 assert.equal(h.napcat.configurationCalls,0);
});

test('viewing or repeating loaded settings never restarts the backend or QQ', async () => {
  const h = harness();
  const state = await h.perform('settings-save', {});
  assert.equal(state.changed, false);
  const identical = await h.perform('settings-save', { patch: { onebotPort: 6199 } });
  assert.equal(identical.changed, false);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.savePayloads, []);
  assert.equal(h.supervisor.running, true);
  assert.equal(h.napcat.running, true);
});

test('changed settings carry only the patch and the loaded revision', async () => {
  const h = harness();
  const state = await h.perform('settings-save', { patch: { biliEnabled: true }, expectedRevision: 'abcdef12' });
  assert.equal(state.changed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.savePayloads)), [{ patch: { biliEnabled: true }, expectedRevision: 'abcdef12' }]);
  assert.deepEqual(h.events, ['stop-conversation', 'save-settings', 'start-conversation']);
});

test('legacy bare patches still save through the compatibility path', async () => {
  const h = harness();
  await h.perform('settings-save', { biliEnabled: true });
  assert.deepEqual(JSON.parse(JSON.stringify(h.savePayloads)), [{ biliEnabled: true }]);
  assert.deepEqual(h.events, ['stop-conversation', 'save-settings', 'start-conversation']);
});

function connectionHarness(overrides = {}) {
  const platformCalls = [];
  const h = harness({
    backendRunning: true,
    qqRunning: true,
    settingsOverrides: { defaultDelivery: 'official', napcatBound: true, officialBound: true, officialOwnerUMO: 'official-test:FriendMessage:OPAQUE', ...(overrides.settingsOverrides || {}) },
    hostQuery: async args => {
      if (args[0] === 'status') return { platforms: [
        { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
        { id: 'official-test', type: 'qq_official', enable: true, configured: true },
      ] };
      if (args[0] === 'pending') return { pending: false };
      if (args[0] === 'set-enable') { platformCalls.push([args[4], args[6]]); return { platforms: [] }; }
      return {};
    },
    ...overrides,
  });
  return { h, platformCalls };
}

test('connection changes preview first, reject wrong typed confirmation and never skip the fence', async () => {
  const { h, platformCalls } = connectionHarness({ settingsOverrides: { defaultDelivery: 'napcat' } });
  const preview = await h.perform('connection-change', { channel: 'official', enabled: false });
  assert.equal(typeof preview.plan.id, 'string');
  assert.equal(preview.plan.id.length, 24);
  assert.match(preview.plan.prompt, /官方/);
  assert.deepEqual(h.events, []);
  assert.deepEqual(platformCalls, []);
  await assert.rejects(h.perform('connection-confirm', { planId: preview.plan.id, typed: '错' }), /请输入/);
  assert.deepEqual(h.events, []);
  const done = await h.perform('connection-confirm', { planId: preview.plan.id, typed: '官方' });
  assert.deepEqual(platformCalls, [['official-test', 'false']]);
  assert.ok(h.events.includes('stop-conversation') && h.events.includes('start-conversation'));
  assert.equal(h.events.includes('stop-qq'), false);
  assert.equal(h.napcat.running, true);
  assert.ok(Array.isArray(done.events));
  await assert.rejects(h.perform('connection-confirm', { planId: preview.plan.id, typed: '官方' }), /失效/);
});

test('a stale connection plan is rejected after the settings revision changes', async () => {
  const { h, platformCalls } = connectionHarness({ settingsOverrides: { defaultDelivery: 'napcat' } });
  const preview = await h.perform('connection-change', { channel: 'official', enabled: false });
  h.settingsState.configRevision = 'rev-2';
  await assert.rejects(h.perform('connection-confirm', { planId: preview.plan.id, typed: '官方' }), /变化/);
  assert.deepEqual(platformCalls, []);
  assert.deepEqual(h.events, []);
});

test('disabling the small account stops only that component and keeps the official channel', async () => {
  const { h, platformCalls } = connectionHarness();
  const preview = await h.perform('connection-change', { channel: 'napcat', enabled: false });
  assert.match(preview.plan.message, /小号进程会被结束/);
  assert.match(preview.plan.effects.join(' '), /官方机器人进程不因本操作结束/);
  await h.perform('connection-confirm', { planId: preview.plan.id, typed: '小号' });
  assert.deepEqual(platformCalls, [['qq', 'false']]);
  assert.equal(h.events.includes('stop-qq'), true);
  assert.equal(h.napcat.running, false);
  assert.ok(h.events.includes('stop-conversation') && h.events.includes('start-conversation'));
});

test('disabling the default delivery channel is refused before confirmation', async () => {
  const { h, platformCalls } = connectionHarness({ settingsOverrides: { defaultDelivery: 'official' } });
  await assert.rejects(h.perform('connection-change', { channel: 'official', enabled: false }), /默认渠道/);
  assert.deepEqual(platformCalls, []);
  assert.deepEqual(h.events, []);
});

test('warm navigation reuses cached inspect and workspace snapshots until a mutation', async () => {
  let workspaceCalls = 0;
  const workspace = {
    async perform() {
      workspaceCalls += 1;
      return { health: { checks: [], summary: { requiredFailures: 0, warnings: 0 } }, backups: [], appUpdate: {}, napcat: {}, preferences: { tray: false, startAtLogin: false, resumeAfterWake: false }, diagnosticFiles: [] };
    },
  };
  const h = harness({ workspace });
  for (let index = 0; index < 50; index += 1) await h.perform('inspect');
  assert.equal(h.manager.inspectCalls, 1);
  for (let index = 0; index < 50; index += 1) await h.perform('workspace-status');
  assert.equal(workspaceCalls, 1);
  await h.perform('install');
  await h.perform('inspect');
  assert.equal(h.manager.inspectCalls, 2);
  await h.perform('workspace-status');
  assert.equal(workspaceCalls, 2);
});

test('reopening the same console reuses one bounded view and stop closes it', async () => {
  const h = harness();
  const initial = h.loadedURLs.length;
  await h.perform('open-panel', { panel: 'models' });
  assert.equal(h.views.length, 1);
  assert.equal(h.loadedURLs.length, initial + 1);
  await h.perform('open-panel', { panel: 'models' });
  assert.equal(h.views.length, 1);
  assert.equal(h.loadedURLs.length, initial + 1);
  await h.perform('open-panel', { panel: 'astrbot' });
  assert.equal(h.views.length, 2);
  assert.equal(h.loadedURLs.length, initial + 2);
  await h.perform('stop');
  assert.equal(h.snapshots.at(-1)?.panel, undefined);
});

test('starting with the small-account platform disabled never launches its component', async () => {
  const h = harness({
    backendRunning: false,
    qqRunning: false,
    hostQuery: async args => args[0] === 'status'
      ? { platforms: [{ id: 'qq', type: 'aiocqhttp', enable: false, configured: true }] }
      : {},
  });
  await h.perform('start');
  assert.equal(h.events.includes('launch-qq'), false);
  assert.equal(h.events.includes('start-conversation'), true);
  assert.equal(h.napcat.running, false);
});

test('platform writes require the host to be stopped and happen before the component stop', async () => {
  let h;
  const seen = [];
  const hostQuery = async args => {
    if (args[0] === 'status') return { platforms: [
      { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
      { id: 'official-test', type: 'qq_official', enable: true, configured: true },
    ] };
    if (args[0] === 'pending') return { pending: false };
    if (args[0] === 'set-enable') {
      seen.push({ hostRunning: h.supervisor.running, componentRunning: h.napcat.running });
      if (h.supervisor.running) throw new Error('astrbot.lock');
      return { platforms: [] };
    }
    return {};
  };
  h = harness({ hostQuery, settingsOverrides: { defaultDelivery: 'official', napcatBound: true, officialBound: true } });
  const preview = await h.perform('connection-change', { channel: 'napcat', enabled: false });
  await h.perform('connection-confirm', { planId: preview.plan.id, typed: '小号' });
  assert.deepEqual(seen, [{ hostRunning: false, componentRunning: true }]);
  const lifecycle = h.events.filter(item => ['stop-conversation', 'stop-qq', 'start-conversation'].includes(item));
  assert.deepEqual(lifecycle, ['stop-conversation', 'stop-qq', 'start-conversation']);
  assert.equal(h.napcat.running, false);
  assert.equal(h.supervisor.running, true);
});

test('a failed platform write restores the conversation and keeps the small account running', async () => {
  const h = harness({
    hostQuery: async args => {
      if (args[0] === 'status') return { platforms: [
        { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
        { id: 'official-test', type: 'qq_official', enable: true, configured: true },
      ] };
      if (args[0] === 'pending') return { pending: false };
      if (args[0] === 'set-enable') throw new Error('请先在应用内停止对话服务，再修改连接平台');
      return {};
    },
    settingsOverrides: { defaultDelivery: 'official', napcatBound: true, officialBound: true },
  });
  const preview = await h.perform('connection-change', { channel: 'napcat', enabled: false });
  await assert.rejects(h.perform('connection-confirm', { planId: preview.plan.id, typed: '小号' }), /停止对话服务/);
  assert.equal(h.napcat.running, true);
  assert.equal(h.events.includes('stop-qq'), false);
  assert.deepEqual(h.events, ['stop-conversation', 'start-conversation']);
  assert.equal(h.supervisor.running, true);
});

test('changing a channel while the host is stopped writes config before stopping the component', async () => {
  let h;
  const seen = [];
  h = harness({
    backendRunning: false,
    qqRunning: true,
    settingsOverrides: { defaultDelivery: 'official', napcatBound: true, officialBound: true },
    hostQuery: async args => {
      if (args[0] === 'status') return { platforms: [
        { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
        { id: 'official-test', type: 'qq_official', enable: true, configured: true },
      ] };
      if (args[0] === 'pending') return { pending: false };
      if (args[0] === 'set-enable') { seen.push({ hostRunning: h.supervisor.running, componentRunning: h.napcat.running }); return { platforms: [] }; }
      return {};
    },
  });
  const preview = await h.perform('connection-change', { channel: 'napcat', enabled: false });
  await h.perform('connection-confirm', { planId: preview.plan.id, typed: '小号' });
  assert.deepEqual(seen, [{ hostRunning: false, componentRunning: true }]);
  assert.deepEqual(h.events, ['stop-qq']);
  assert.equal(h.napcat.running, false);
  assert.equal(h.supervisor.running, false);
});

test('actual default delivery UI payload passes IPC and reaches the backend save', async () => {
  const { validateRequest } = require('../lib/security.cjs');
  const { settingsPatch } = require('../ui/model.js');
  const shell = { mainFrame: {} };
  const event = { sender: shell, senderFrame: shell.mainFrame };
  const payload = {
    patch: settingsPatch({ defaultDelivery: 'official' }, { defaultDelivery: '' }),
    expectedRevision: 'abcdef12',
  };
  assert.doesNotThrow(() => validateRequest(event, shell, 'settings-save', payload));
  const h = harness({
    settingsOverrides: {
      defaultDelivery: '',
      officialBound: true,
      officialOwnerUMO: 'official-test:FriendMessage:OPAQUE',
    },
  });
  await h.perform('settings-save', payload);
  assert.deepEqual(JSON.parse(JSON.stringify(h.savePayloads.at(-1))), payload);
});

test('connection control targets the bound platform instance and not the first same type', async () => {
  const platformCalls = [];
  const h = harness({
    settingsOverrides: {
      defaultDelivery: 'official',
      napcatBound: true,
      napcatBoundPlatformId: 'bound-second',
      officialBound: false,
    },
    hostQuery: async args => {
      if (args[0] === 'status') return { platforms: [
        { id: 'unbound-first', type: 'aiocqhttp', enable: true, configured: true },
        { id: 'bound-second', type: 'aiocqhttp', enable: true, configured: true },
        { id: 'official-test', type: 'qq_official', enable: true, configured: true },
      ] };
      if (args[0] === 'pending') return { pending: false };
      if (args[0] === 'set-enable') { platformCalls.push([args[4], args[6]]); return { platforms: [] }; }
      return {};
    },
  });
  const preview = await h.perform('connection-change', { channel: 'napcat', enabled: false });
  assert.equal(preview.plan.platformId, 'bound-second');
  await h.perform('connection-confirm', { planId: preview.plan.id, typed: '小号' });
  assert.deepEqual(platformCalls, [['bound-second', 'false']]);
});

function confirmHarness(options = {}) {
  const platformCalls = [];
  let h;
  const hostQuery = async args => {
    if (args[0] === 'status') return { platforms: [
      { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
      { id: 'official-test', type: 'qq_official', enable: true, configured: true },
    ] };
    if (args[0] === 'pending') return { pending: false };
    if (args[0] === 'set-enable') { platformCalls.push([args[4], args[6]]); return { platforms: [] }; }
    return {};
  };
  h = harness({
    settingsOverrides: {
      defaultDelivery: 'napcat',
      napcatBound: true,
      napcatBoundPlatformId: 'qq',
      officialBound: true,
      officialBoundPlatformId: 'official-test',
    },
    hostQuery,
    ...options,
  });
  return { h, platformCalls };
}

test('canceling the native confirmation leaves connections and processes untouched', async () => {
  const { h, platformCalls } = confirmHarness({ dialogResponse: 0 });
  const preview = await h.perform('connection-change', { channel: 'official', enabled: false });
  const result = await h.perform('connection-confirm', { planId: preview.plan.id, typed: '官方' });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { canceled: true });
  assert.deepEqual(platformCalls, []);
  assert.deepEqual(h.events, []);
  assert.equal(h.napcat.running, true);
  assert.equal(h.supervisor.running, true);
  await assert.rejects(h.perform('connection-confirm', { planId: preview.plan.id, typed: '官方' }), /失效/);
});

test('a stale settings revision is rejected before the conversation stops', async () => {
  const h = harness();
  await assert.rejects(
    h.perform('settings-save', { patch: { biliEnabled: true }, expectedRevision: 'ffffffff' }),
    /另一处更新/,
  );
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.savePayloads, []);
  assert.equal(h.supervisor.running, true);
});

test('a new owned generation invalidates a pending connection plan', async () => {
  const { h, platformCalls } = confirmHarness();
  const preview = await h.perform('connection-change', { channel: 'official', enabled: false });
  h.supervisor.generation = 1;
  await assert.rejects(h.perform('connection-confirm', { planId: preview.plan.id, typed: '官方' }), /变化/);
  assert.deepEqual(platformCalls, []);
  assert.deepEqual(h.events, []);
});

test('confirmation during shutdown is rejected without side effects', async () => {
  const { h, platformCalls } = confirmHarness();
  const preview = await h.perform('connection-change', { channel: 'official', enabled: false });
  h.requestShutdown();
  await assert.rejects(h.perform('connection-confirm', { planId: preview.plan.id, typed: '官方' }), /退出/);
  assert.deepEqual(platformCalls, []);
  assert.deepEqual(h.events, []);
});

test('shutdown between stopping the host and writing the platform never restarts it', async () => {
  const { h, platformCalls } = confirmHarness();
  const preview = await h.perform('connection-change', { channel: 'official', enabled: false });
  const originalStop = h.supervisor.stop.bind(h.supervisor);
  h.supervisor.stop = async () => { await originalStop(); h.requestShutdown(); };
  await assert.rejects(h.perform('connection-confirm', { planId: preview.plan.id, typed: '官方' }), /退出|恢复/);
  assert.deepEqual(platformCalls, []);
  assert.deepEqual(h.events, ['stop-conversation']);
  assert.equal(h.events.includes('start-conversation'), false);
  assert.equal(h.napcat.running, true);
});

test('the legacy napcat-stop action cannot bypass native confirmation', async () => {
  const workspaceCalls = [];
  const workspace = { perform: async action => { workspaceCalls.push(action); return { napcat: { running: false } }; } };
  const canceled = harness({ dialogResponse: 0, workspace });
  assert.deepEqual(JSON.parse(JSON.stringify(await canceled.perform('napcat-stop'))), { canceled: true });
  assert.deepEqual(workspaceCalls, []);
  assert.equal(canceled.napcat.running, true);
  const confirmed = harness({ dialogResponse: 1, workspace });
  await confirmed.perform('napcat-stop');
  assert.deepEqual(workspaceCalls, ['napcat-stop']);
  assert.equal(confirmed.dialogs.length, 1);
});

test('unknown pending activity blocks connection changes', async () => {
  const h = harness({
    settingsOverrides: { defaultDelivery: 'napcat', napcatBound: true, napcatBoundPlatformId: 'qq' },
    hostQuery: async args => {
      if (args[0] === 'status') return { platforms: [
        { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
        { id: 'official-test', type: 'qq_official', enable: true, configured: true },
      ] };
      if (args[0] === 'pending') throw new Error('synthetic pending query failure');
      return {};
    },
  });
  await assert.rejects(h.perform('connection-change', { channel: 'official', enabled: false }), /无法确认/);
  assert.deepEqual(h.events, []);
});

test('a late inspect response cannot overwrite post-mutation state', async () => {
  const h = harness();
  let releaseOld;
  let calls = 0;
  h.manager.inspect = async () => {
    calls += 1;
    if (calls === 1) {
      return new Promise(resolve => {
        releaseOld = () => resolve({ installed: false, marker: 'old', components: [], needsPrepare: true });
      });
    }
    return { installed: true, marker: 'new', components: [], needsPrepare: false };
  };
  const oldRefresh = h.refresh();
  for (let attempt = 0; attempt < 50 && typeof releaseOld !== 'function'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof releaseOld, 'function');
  await h.perform('install');
  releaseOld();
  const oldResult = await oldRefresh;
  assert.equal(oldResult.stale, true);
  assert.equal(h.getState().marker, 'new');
  assert.equal(h.getState().installed, true);
});

test('reopening a dual-enabled install restores the small account even in legacy official mode', async () => {
  const h = harness({
    backendRunning: false,
    qqRunning: false,
    qqMode: 'official',
    settingsOverrides: {
      napcatBound: true,
      napcatBoundPlatformId: 'qq',
      officialBound: true,
      officialBoundPlatformId: 'official-test',
    },
    hostQuery: async args => {
      if (args[0] === 'status') return { platforms: [
        { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
        { id: 'official-test', type: 'qq_official', enable: true, configured: true },
      ] };
      return {};
    },
  });
  await h.perform('start');
  assert.equal(h.events.includes('launch-qq'), true);
  assert.equal(h.napcat.running, true);
  assert.equal(h.supervisor.running, true);
  assert.ok(h.snapshots.some(snapshot => snapshot.workspace?.official));
});

test('concurrent read-only queries no longer reject each other', async () => {
  let release;
  const workspace = {
    perform: async action => {
      if (action === 'workspace-status') {
        await new Promise(resolve => { release = resolve; });
        return { health: null, backups: [], appUpdate: {}, napcat: {}, preferences: {}, diagnosticFiles: [] };
      }
      return {};
    },
  };
  const h = harness({ workspace });
  const first = h.perform('workspace-status');
  for (let attempt = 0; attempt < 50 && typeof release !== 'function'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof release, 'function');
  const settings = await h.perform('settings-get');
  assert.ok(settings && typeof settings === 'object');
  release();
  await first;
});

test('leaving and returning to the same console reuses the hidden view, switching rebuilds it', async () => {
  const h = harness();
  const initial = h.loadedURLs.length;
  await h.perform('open-panel', { panel: 'models' });
  assert.equal(h.views.length, 1);
  assert.equal(h.loadedURLs.length, initial + 1);
  await h.perform('home');
  assert.equal(h.getState().panel, undefined);
  assert.equal(h.views.length, 1);
  await h.perform('open-panel', { panel: 'models' });
  assert.equal(h.views.length, 1);
  assert.equal(h.loadedURLs.length, initial + 1);
  await h.perform('home');
  await h.perform('open-panel', { panel: 'astrbot' });
  assert.equal(h.views.length, 2);
  assert.equal(h.loadedURLs.length, initial + 2);
  await h.perform('stop');
  assert.equal(h.getState().panel, undefined);
});

test('settings history and per-field restore use the real payload and revision', async () => {
  const recordId = '1700000000000000000-abcdef12';
  const history = {
    format: 1,
    records: [{ id: recordId, changedAt: 1700000000, changes: [{ field: 'proactiveEnabled', before: true, after: false }] }],
    migrationReceipt: { migrationVersion: 1, archivedFields: [], verifiedAt: 1700000000 },
  };
  const h = harness({ settingsHistory: history });
  const listed = await h.perform('settings-history');
  assert.equal(listed.records[0].id, recordId);
  assert.equal(listed.migrationReceipt.migrationVersion, 1);
  const payload = { recordId, field: 'proactiveEnabled', expectedRevision: 'abcdef12' };
  const eventsBefore = h.events.length;
  await assert.rejects(
    h.perform('settings-restore-field', { ...payload, expectedRevision: 'ffffffff' }),
    /另一处更新/,
  );
  assert.equal(h.events.length, eventsBefore);
  await h.perform('settings-restore-field', payload);
  assert.deepEqual(JSON.parse(JSON.stringify(h.restorePayloads.at(-1))), payload);
  assert.equal(h.events.includes('stop-conversation'), true);
  assert.equal(h.events.includes('start-conversation'), true);
});

test('synthetic five-minute console navigation keeps one view and one load', async () => {
  const h = harness();
  const initial = h.loadedURLs.length;
  await h.perform('open-panel', { panel: 'models' });
  for (let index = 0; index < 50; index += 1) {
    await h.perform('home');
    await h.perform('open-panel', { panel: 'models' });
  }
  assert.equal(h.views.length, 1);
  assert.equal(h.loadedURLs.length, initial + 1);
});

test('changes while the native connection dialog is open invalidate the plan before side effects', async () => {
  for (const kind of ['revision', 'generation', 'pending', 'binding']) {
    let h;
    let pendingFlag = false;
    const platformCalls = [];
    const hostQuery = async args => {
      if (args[0] === 'status') return { platforms: [
        { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
        { id: 'official-test', type: 'qq_official', enable: true, configured: true },
      ] };
      if (args[0] === 'pending') return { pending: pendingFlag };
      if (args[0] === 'set-enable') { platformCalls.push([args[4], args[6]]); return { platforms: [] }; }
      return {};
    };
    h = harness({
      settingsOverrides: {
        defaultDelivery: 'napcat',
        napcatBound: true,
        napcatBoundPlatformId: 'qq',
        officialBound: true,
        officialBoundPlatformId: 'official-test',
      },
      hostQuery,
      dialogResponse: () => {
        if (kind === 'revision') h.settingsState.configRevision = 'ffffffff';
        if (kind === 'generation') h.supervisor.generation = 10;
        if (kind === 'pending') pendingFlag = true;
        if (kind === 'binding') {
          h.settingsState.officialBoundPlatformId = 'other-official';
          h.settingsState.configRevision = 'ffffffff';
        }
        return 1;
      },
    });
    const preview = await h.perform('connection-change', { channel: 'official', enabled: false });
    const eventsBefore = h.events.length;
    const expected = kind === 'pending' ? /无法确认/ : /变化/;
    await assert.rejects(h.perform('connection-confirm', { planId: preview.plan.id, typed: '官方' }), expected);
    assert.deepEqual(platformCalls, []);
    assert.equal(h.events.slice(eventsBefore).includes('stop-conversation'), false);
    await assert.rejects(h.perform('connection-confirm', { planId: preview.plan.id, typed: '官方' }), /失效/);
  }
});

test('settings restore rechecks the revision after the native dialog', async () => {
  let h;
  const recordId = '1700000000000000000-abcdef12';
  h = harness({
    settingsHistory: { format: 1, records: [{ id: recordId, changedAt: 1700000000, changes: [{ field: 'proactiveEnabled', before: true, after: false }] }], migrationReceipt: null },
    dialogResponse: () => { h.settingsState.configRevision = 'ffffffff'; return 1; },
  });
  const eventsBefore = h.events.length;
  await assert.rejects(
    h.perform('settings-restore-field', { recordId, field: 'proactiveEnabled', expectedRevision: 'abcdef12' }),
    /另一处更新/,
  );
  assert.deepEqual(h.restorePayloads, []);
  assert.equal(h.events.slice(eventsBefore).includes('stop-conversation'), false);
});

test('legacy official mode still applies a port change to the running small account', async () => {
  const h = harness({
    qqMode: 'official',
    settingsOverrides: { napcatBound: true, napcatBoundPlatformId: 'qq' },
    hostQuery: enabledOneBotPlatforms(),
  });
  await h.perform('settings-save', { onebotPort: 6299 });
  assert.equal(h.events.includes('apply-connection'), true);
  assert.deepEqual(h.wirePorts, [6299]);
  assert.equal(h.events.includes('stop-qq'), false);
  assert.equal(h.events.includes('launch-qq'), false);
  assert.equal(h.supervisor.running, true);
  assert.equal(h.napcat.running, true);
});

test('restoring a recorded port applies it to the running small account without relogin', async () => {
  const recordId = '1700000000000000000-abcdef12';
  const h = harness({
    settingsOverrides: { onebotPort: 6299, napcatBound: true, napcatBoundPlatformId: 'qq' },
    settingsHistory: {
      format: 1,
      records: [{ id: recordId, changedAt: 1700000000, changes: [{ field: 'onebotPort', before: 6199, after: 6299 }] }],
      migrationReceipt: null,
    },
    hostQuery: enabledOneBotPlatforms(),
  });
  await h.perform('settings-restore-field', { recordId, field: 'onebotPort', expectedRevision: 'abcdef12' });
  assert.equal(h.events.includes('apply-connection'), true);
  assert.deepEqual(h.wirePorts, [6199]);
  assert.equal(h.events.includes('stop-qq'), false);
  assert.equal(h.events.includes('launch-qq'), false);
  assert.equal(h.napcat.running, true);
  assert.equal(h.supervisor.running, true);
});

test('a stale connections response cannot overwrite the newer published state', async () => {
  let releaseOld;
  let statusCalls = 0;
  const h = harness({
    hostQuery: async args => {
      if (args[0] === 'status') {
        statusCalls += 1;
        if (statusCalls === 1) return new Promise(resolve => {
          releaseOld = () => resolve({ platforms: [
            { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
            { id: 'official-test', type: 'qq_official', enable: true, configured: true },
          ] });
        });
        return { platforms: [
          { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
          { id: 'official-test', type: 'qq_official', enable: false, configured: true },
        ] };
      }
      if (args[0] === 'pending') return { pending: false };
      return {};
    },
  });
  const oldCall = h.perform('connections-status');
  for (let attempt = 0; attempt < 50 && typeof releaseOld !== 'function'; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseOld, 'function');
  await h.perform('stop');
  const fresh = await h.perform('connections-status');
  assert.equal(fresh.connections.channels.find(item => item.channel === 'official').platformEnabled, false);
  releaseOld();
  await assert.rejects(oldCall, /状态已更新|退出/);
  const finalConnections = h.getState().connections;
  assert.equal(finalConnections.channels.find(item => item.channel === 'official').platformEnabled, false);
  assert.equal(finalConnections.revision, fresh.connections.revision);
});

test('a login identity switch or unknown state during the native dialog invalidates a stop plan', async () => {
  for (const kind of ['switch', 'unknown']) {
    let h;
    const platformCalls = [];
    const hostQuery = async args => {
      if (args[0] === 'status') return { platforms: [
        { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
        { id: 'official-test', type: 'qq_official', enable: true, configured: true },
      ] };
      if (args[0] === 'pending') return { pending: false };
      if (args[0] === 'set-enable') { platformCalls.push([args[4], args[6]]); return {}; }
      return {};
    };
    h = harness({
      settingsOverrides: {
        defaultDelivery: 'official',
        napcatBound: true,
        napcatBoundPlatformId: 'qq',
        officialBound: true,
        officialBoundPlatformId: 'official-test',
      },
      hostQuery,
      dialogResponse: () => {
        if (kind === 'switch') h.napcat.identityToken = 'identity-token-b';
        else { h.napcat.identityKnown = false; h.napcat.identityToken = 'identity-token-unknown'; }
        return 1;
      },
    });
    const preview = await h.perform('connection-change', { channel: 'napcat', enabled: false });
    const eventsBefore = h.events.length;
    await assert.rejects(h.perform('connection-confirm', { planId: preview.plan.id, typed: '小号' }), /变化/);
    assert.deepEqual(platformCalls, []);
    assert.equal(h.events.slice(eventsBefore).includes('stop-conversation'), false);
    assert.equal(h.napcat.running, true);
  }
});

test('the same account refreshed during the native dialog can still confirm the plan', async () => {
  const platformCalls = [];
  const h = harness({
    settingsOverrides: {
      defaultDelivery: 'official',
      napcatBound: true,
      napcatBoundPlatformId: 'qq',
      officialBound: true,
      officialBoundPlatformId: 'official-test',
    },
    hostQuery: async args => {
      if (args[0] === 'status') return { platforms: [
        { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
        { id: 'official-test', type: 'qq_official', enable: true, configured: true },
      ] };
      if (args[0] === 'pending') return { pending: false };
      if (args[0] === 'set-enable') { platformCalls.push([args[4], args[6]]); return {}; }
      return {};
    },
  });
  const preview = await h.perform('connection-change', { channel: 'napcat', enabled: false });
  await h.perform('connection-confirm', { planId: preview.plan.id, typed: '小号' });
  assert.deepEqual(platformCalls, [['qq', 'false']]);
  assert.equal(h.napcat.running, false);
  assert.equal(h.events.includes('stop-qq'), true);
});

function stopHarness(options = {}) {
  return harness({ useRealWorkspace: true, ...options });
}

test('legacy napcat-stop rejects a switched, unknown or replaced owned target', async () => {
  const cases = {
    account: h => { h.napcat.identityToken = 'identity-token-b'; },
    unknown: h => { h.napcat.identityKnown = false; },
    pid: h => { h.napcat.child.pid = 111111; },
    generation: h => { h.napcat.generation = 9; },
    shutdown: h => { h.requestShutdown(); },
  };
  for (const [kind, mutate] of Object.entries(cases)) {
    let h;
    h = stopHarness({
      dialogResponse: () => { mutate(h); return 1; },
    });
    await assert.rejects(h.perform('napcat-stop'), kind === 'shutdown' ? /退出/ : /变化/);
    assert.equal(h.events.filter(event => event === 'stop-qq').length, 0, kind);
    assert.equal(h.events.includes('stop-conversation'), false, kind);
    assert.equal(h.napcat.running, true, kind);
    assert.equal(h.supervisor.running, true, kind);
  }
});

test('legacy napcat-stop cancel and stable identity stop exactly one owned component', async () => {
  const canceled = stopHarness({ dialogResponse: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(await canceled.perform('napcat-stop'))), { canceled: true });
  assert.equal(canceled.events.filter(event => event === 'stop-qq').length, 0);
  assert.equal(canceled.napcat.running, true);

  const stopped = stopHarness({ dialogResponse: 1 });
  await stopped.perform('napcat-stop');
  assert.equal(stopped.events.filter(event => event === 'stop-qq').length, 1);
  assert.equal(stopped.events.includes('stop-conversation'), false);
  assert.equal(stopped.events.includes('start-conversation'), false);
  assert.equal(stopped.napcat.running, false);
  assert.equal(stopped.supervisor.running, true);
  assert.doesNotMatch(JSON.stringify(stopped.getState()), /identity-token-a|synthetic-only-management-token/);
});
