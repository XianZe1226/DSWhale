'use strict';
// T5-O1 (action-lock boundary) and T3-O1 (stop command / process exit / state
// event / final UI) — synthetic diagnosis of the a12 main-process state machine.
//
// Everything here is synthetic: fake supervisor/napcat/manager, no real QQ,
// no real NapCat, no network, no user data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness({ backendRunning = true, qqRunning = true, backendReadyWait, startFails = false, hostQuery = null, extensionsRun = async () => ({}), contentSize = [1220, 850] } = {}) {
  const file = path.resolve(__dirname, '../main.cjs'), native = createRequire(file);
  const events = [], snapshots = [], loadedURLs = [], views = [];
  const settingsState = { configRevision: 'abcdef12', defaultDelivery: 'napcat', napcatBound: true, officialBound: false, officialOwnerUMO: '' };
  const supervisor = {
    dashboard: async () => 'http://127.0.0.1:6185/', running: backendRunning,
    async stop() { events.push('stop-conversation'); this.running = false; },
    async start() { if (this.running) return; events.push('start-conversation'); if (startFails) throw Error('synthetic backend failure'); await backendReadyWait; this.running = true; },
  };
  const napcat = {
    configurationCalls: 0, running: qqRunning, child: { exitCode: null, killed: false, pid: 987654321 },
    identityToken: 'identity-token-a', identityKnown: true,
    async identityRevision() { return { token: this.identityToken, known: this.identityKnown }; },
    async stop() { events.push('stop-qq'); this.running = false; },
    async start() { if (!this.running) { events.push('launch-qq'); this.running = true; } return this.status(); },
    async configure() { this.configurationCalls += 1; },
    async wire() { events.push('apply-connection'); return this.status(); },
    async loginInfo() { return { url: 'http://127.0.0.1:6099/webui/', token: 'synthetic-only-management-token' }; },
    async status() { return { configured: true, externalOnly: false, canStart: true, running: this.running, loginState: this.running ? 'online' : 'stopped', hasSavedLogin: true, connectionConfigured: true, protocolConnected: false }; },
  };
  const manager = {
    runtime: 'synthetic-runtime', host: 'synthetic-host', inspectCalls: 0,
    async inspect() { this.inspectCalls += 1; return { installed: true }; },
    async install() {},
  };
  class LocalView {
    constructor() {
      views.push(this);
      this.webContents = { setWindowOpenHandler() {}, on() {}, close() {}, isDestroyed: () => false, loadURL: async url => { loadedURLs.push(url); events.push('open-panel'); } };
    }
    setBounds(bounds) { this.bounds = { ...bounds }; }
  }
  const electron = {
    session: { fromPartition: () => ({ clearStorageData: async () => {} }) },
    WebContentsView: LocalView,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    app: { setName() {}, getVersion: () => '0.3.0-alpha.12', requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on() {} },
    protocol: { registerSchemesAsPrivileged() {} },
  };
  const fakeServices = {
    ...native('./lib/services.cjs'),
    settingsCommand: async (_manager, command, payload) => {
      if (command === 'save') {
        events.push('save-settings');
        const patch = payload && payload.patch && typeof payload.patch === 'object' ? payload.patch : payload;
        if (patch && typeof patch === 'object') Object.assign(settingsState, patch);
      }
      if (command === 'history') return { format: 1, records: [], migrationReceipt: null };
      return { ...settingsState, qqConnectionMode: 'napcat', onebotPort: 6199, onebotToken: 'synthetic-existing-token' };
    },
  };
  const context = {
    require: name => name === 'electron' ? electron : name === './lib/services.cjs' ? fakeServices
      : name === 'node:fs/promises' ? { writeFile: async () => {}, rm: async () => {}, readdir: async () => { throw Object.assign(Error(), { code: 'ENOENT' }); } } : native(name),
    __dirname: path.dirname(file), process, console, Buffer, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `;globalThis.hooks={perform,stopAll,publishQQ,refresh,reportActionError,getState:()=>state,set(values){
    state.installed=true;operations={snapshot:async()=>{}};hostCommand=async()=>{};manager=values.manager;supervisor=values.supervisor;napcat=values.napcat;
    window={isDestroyed:()=>false,webContents:{send:(_channel,value)=>values.snapshot(value)},contentView:{addChildView(){},removeChildView(){}},getContentSize:()=>values.contentSize||[1220,850]};
    extensions={operation:null,run:values.extensionsRun||(async()=>({}))};appUpdater={status:async()=>({recovery:{}})};hostQueryOverride=values.hostQuery||null;}};`, context);
  context.hooks.set({ manager, supervisor, napcat, hostQuery, extensionsRun, contentSize, snapshot: value => snapshots.push(JSON.parse(JSON.stringify(value))) });
  return { ...context.hooks, events, snapshots, loadedURLs, views, napcat, supervisor, settingsState, manager };
}

const onlinePlatforms = () => async args => {
  if (args[0] === 'status') return { platforms: [{ id: 'qq', type: 'aiocqhttp', enable: true, configured: true }] };
  if (args[0] === 'pending') return { pending: false };
  return {};
};

function deferred() {
  let release;
  const promise = new Promise(resolve => { release = () => resolve(); });
  return { promise, release };
}

// ---------------------------------------------------------------------------
// T5-O1 — action-lock boundary
// ---------------------------------------------------------------------------
test('T5-O1 spec: a rejected concurrent action does not release the fence held by the running action', async () => {
  const backendReadyWait = deferred();
  const h = harness({ backendRunning: false, qqRunning: false, backendReadyWait: backendReadyWait.promise, hostQuery: onlinePlatforms() });

  const start = h.perform('start');                       // A: controlled-latency fake start
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.getState().running, false);

  // B: a second action is refused while A owns the fence.
  await assert.rejects(h.perform('open-panel', { panel: 'models' }), /当前操作尚未完成，请稍候/);
  assert.equal(h.views.length, 0, 'rejected open-panel must not create a panel view');
  assert.deepEqual(h.events.filter(e => e === 'open-panel'), []);

  // The rejection itself must not have released A's ownership: C is still refused.
  await assert.rejects(h.perform('stop'), /当前操作尚未完成，请稍候/);
  assert.equal(h.napcat.running, false, 'stop must not have run while fenced');
  assert.deepEqual(h.events, ['start-conversation']);

  // A read-only inspect is still served while A runs; it must report the live
  // state without clearing the fence either.
  const mid = await h.perform('inspect');
  assert.equal(mid.running, false);
  await assert.rejects(h.perform('stop'), /当前操作尚未完成，请稍候/);

  backendReadyWait.release();
  await start;
  assert.equal(h.getState().running, true, 'A eventually completes normally');

  // C is executable once A settles.
  const stopped = await h.perform('stop');
  assert.equal(stopped.running, false);
  assert.ok(h.events.includes('stop-conversation'));
});

test('T5-O1 spec: a failed action still releases the fence', async () => {
  const h = harness({ backendRunning: false, qqRunning: false, startFails: true, hostQuery: onlinePlatforms() });
  await assert.rejects(h.perform('start'), /synthetic backend failure/);
  // Not fenced any more: the next action runs instead of being refused.
  const state = await h.perform('stop');
  assert.equal(state.running, false);
  // The failing start already unwinds the backend (one stop); the manual stop is the
  // second one. What matters is that it was not refused by a leaked fence.
  assert.equal(h.supervisor.running, false);
  assert.ok(h.events.includes('stop-conversation'));
});

test('T5-O1 spec: the fence refusal reaches the user as a clean [APP-001] message', async () => {
  const backendReadyWait = deferred();
  const h = harness({ backendRunning: false, qqRunning: false, backendReadyWait: backendReadyWait.promise, hostQuery: onlinePlatforms() });
  const start = h.perform('start');
  await new Promise(resolve => setImmediate(resolve));

  let refused = null;
  try { await h.perform('open-panel', { panel: 'models' }); } catch (error) { refused = error; }
  assert.ok(refused, 'open-panel must be refused while start is in flight');

  // ipcMain.handle wraps the thrown error through reportActionError.
  const message = await h.reportActionError(refused, 'open-panel');
  assert.equal(message, '[APP-001] 当前操作尚未完成，请稍候');
  assert.doesNotMatch(message, /Error invoking remote method/);

  backendReadyWait.release();
  await start;
});

// ---------------------------------------------------------------------------
// T3-O1 — stop command / process exit / state event / final interface
// ---------------------------------------------------------------------------
test('T3-O1 spec: stop closes the panel and publishes a complete stopped state', async () => {
  const h = harness({ backendRunning: true, qqRunning: true, hostQuery: onlinePlatforms() });
  await h.perform('open-panel', { panel: 'qq' });
  assert.equal(h.getState().panel, 'qq');
  h.snapshots.length = 0;

  const state = await h.perform('stop');

  assert.equal(state.running, false);
  assert.equal(state.startup.stage, 'stopped');
  assert.equal(state.panel, undefined);
  assert.equal(state.error, undefined);
  assert.equal(h.napcat.running, true, 'stopping the conversation must keep the QQ (NapCat) process');
  assert.deepEqual(h.events, ['open-panel', 'stop-conversation']);

  // Event order: the panel is closed first, the running:false flip comes last.
  const panelClosed = h.snapshots.findIndex(s => s.panel === undefined);
  const stopped = h.snapshots.findIndex(s => s.running === false);
  assert.ok(panelClosed >= 0 && stopped >= 0, 'both events are published');
  assert.ok(panelClosed <= stopped, 'panel closes before the stopped state is published');
});

test('T3-O1 spec: a renderer that missed the stop event recovers through inspect (reload path)', async () => {
  const h = harness({ backendRunning: true, qqRunning: true, hostQuery: onlinePlatforms() });
  await h.perform('stop');
  h.snapshots.length = 0;                       // simulate a renderer that lost the IPC push

  const recovered = await h.perform('inspect'); // what renderer reload/init does

  assert.equal(recovered.running, false, 'inspect must report the live supervisor state');
  assert.notEqual(recovered.stale, true);
  assert.ok(h.snapshots.length >= 1);
});

test('T3-O1 spec: a stop in flight shows the pre-stop state and publishes no progress stage', async () => {
  const h = harness({ backendRunning: true, qqRunning: true, hostQuery: onlinePlatforms() });
  await h.perform('inspect');                   // main-process state now mirrors supervisor.running === true
  assert.equal(h.getState().running, true);
  h.snapshots.length = 0;
  const gate = deferred();
  h.supervisor.stop = async () => { h.events.push('stop-conversation'); await gate.promise; h.supervisor.running = false; };

  const stop = h.perform('stop');
  await new Promise(resolve => setImmediate(resolve));

  // Documented boundary: until supervisor.stop() settles the UI still reads running:true
  // and no intermediate "stopping" stage exists (app.js has no such stage either).
  assert.equal(h.getState().running, true);
  assert.ok(h.snapshots.every(s => s.startup?.stage !== 'stopped'));
  assert.ok(h.snapshots.some(s => s.panel === undefined), 'the panel is closed before the process is gone');

  // Other actions are fenced during the stop.
  await assert.rejects(h.perform('open-panel', { panel: 'models' }), /当前操作尚未完成/);

  gate.release();
  const final = await stop;
  assert.equal(final.running, false);
  assert.equal(final.startup.stage, 'stopped');
});

// ---------------------------------------------------------------------------
// T3-I3 — the first state event must carry a real startup stage, before the
// slow readiness probes (extensions.run("status") + settings read) complete.
// ---------------------------------------------------------------------------
test('T3-I3 spec: a real startup stage is published before the readiness probes', async () => {
  const gate = deferred();
  const h = harness({ backendRunning: false, qqRunning: false, extensionsRun: () => gate.promise, hostQuery: onlinePlatforms() });

  const start = h.perform('start');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.getState().startup?.stage, 'starting-conversation', 'main process publishes the real stage immediately');
  assert.ok(h.snapshots.length >= 1, 'the renderer receives a state event while the probes are still running');
  assert.equal(h.snapshots[0].startup?.stage, 'starting-conversation', 'the very first snapshot carries the stage');

  gate.release();
  await start;
  assert.equal(h.getState().running, true);
});

test('T3-I3 spec: an early readiness probe failure does not leave a stale starting stage', async () => {
  const h = harness({
    backendRunning: false,
    qqRunning: false,
    extensionsRun: async () => { throw Error('synthetic extension probe failure'); },
    hostQuery: onlinePlatforms(),
  });

  await assert.rejects(h.perform('start'), /synthetic extension probe failure/);
  assert.equal(h.getState().running, false);
  assert.equal(h.getState().startup.stage, 'failed');
});

// ---------------------------------------------------------------------------
// T4-I3 — the embedded console must keep the upstream navigation reachable by
// giving it the full content width below 1220 DIP (the upstream drawer closes
// its navigation at <=960 CSS px).
// ---------------------------------------------------------------------------
async function panelBoundsFor(size) {
  const h = harness({ backendRunning: true, qqRunning: true, hostQuery: onlinePlatforms(), contentSize: size });
  await h.perform('open-panel', { panel: 'astrbot' });
  assert.equal(h.views.length, 1, 'the panel view was created');
  assert.ok(h.views[0].bounds, 'the panel received explicit bounds');
  return h.views[0].bounds;
}

test('T4-I3 spec: a 1219 DIP window gives the embedded console the full content width', async () => {
  const bounds = await panelBoundsFor([1219, 850]);
  assert.deepEqual(bounds, { x: 0, y: 140, width: 1219, height: 710 });
  assert.ok(bounds.width >= 960, 'upstream navigation stays in the permanent drawer');
  assert.ok(bounds.y >= 94, 'the desktop toolbar stays above the console panel');
});

test('T4-I3 spec: a 1220 DIP window keeps the desktop sidebar offset', async () => {
  const bounds = await panelBoundsFor([1220, 850]);
  assert.deepEqual(bounds, { x: 256, y: 140, width: 964, height: 710 });
  assert.ok(bounds.width >= 960);
});

test('T4-I3 spec: the minimum 980x700 window gives the console the full width and height', async () => {
  const bounds = await panelBoundsFor([980, 700]);
  assert.deepEqual(bounds, { x: 0, y: 140, width: 980, height: 560 });
  assert.ok(bounds.width >= 960);
  assert.ok(bounds.height > 0);
});
