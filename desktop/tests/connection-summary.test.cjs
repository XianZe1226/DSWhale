'use strict';
// T3-I2 (global connection summary independent of the locally inspected tab) and
// T3-I4 (normalized, dismissible renderer errors). Everything here is synthetic:
// no Electron, no real QQ/NapCat, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { connectionViewModel, connectionSummary, createController } = require('../ui/model.js');

const napcatChannel = {
  channel: 'napcat', label: '普通 QQ 小号', platformType: 'aiocqhttp', platformId: 'qq',
  platformEnabled: true, configured: true, targetIssue: '', bound: true,
  processRunning: true, loginState: 'online', protocolConnected: true, identityKnown: true, health: 'connected',
};
const officialChannel = {
  channel: 'official', label: 'QQ 官方机器人', platformType: 'qq_official', platformId: 'official-test',
  platformEnabled: false, configured: true, targetIssue: '', bound: true,
  processRunning: false, loginState: 'stopped', protocolConnected: false, identityKnown: false, health: 'disabled',
};

function liveNapcatState() {
  return {
    settings: { qqConnectionMode: 'napcat', officialConfigured: false, ownerQQ: '123456789' },
    state: { installed: true, running: true, platform: { id: 'win32-x64' }, setup: { qqConnectionMode: 'napcat', modelConfigured: true } },
    workspace: { napcat: { configured: true, externalOnly: false, running: true, loginState: 'online', protocolConnected: true } },
    connections: { channels: [napcatChannel, officialChannel] },
  };
}

test('T3-I2: the global summary ignores the tab the user is inspecting', () => {
  const base = liveNapcatState();
  const fromNoTab = connectionSummary({ ...base, connectionTab: '' });
  const fromOfficialTab = connectionSummary({ ...base, connectionTab: 'official' });
  const fromNapcatTab = connectionSummary({ ...base, connectionTab: 'napcat' });

  assert.equal(fromNoTab.badge, '已连接');
  assert.equal(fromOfficialTab.badge, fromNoTab.badge);
  assert.equal(fromNapcatTab.badge, fromNoTab.badge);
  assert.equal(fromOfficialTab.stage, fromNoTab.stage);
  // The tab view still follows the tab (that is what the connection page shows).
  assert.equal(connectionViewModel({ ...base, connectionTab: 'official' }).stage, 'official-disabled');
});

test('T3-I2: an unconfigured official tab does not make a live napcat account read as unconfigured', () => {
  const base = liveNapcatState();
  base.settings.qqConnectionMode = 'official';
  base.state.setup.qqConnectionMode = 'official';
  base.connections.channels = [napcatChannel, { ...officialChannel, platformEnabled: true, configured: false }];

  const tab = connectionViewModel({ ...base, connectionTab: 'official' });
  const summary = connectionSummary({ ...base, connectionTab: 'official' });

  assert.equal(tab.stage, 'official-setup');
  assert.equal(tab.badge, '待配置');
  assert.equal(summary.stage, 'ready');
  assert.equal(summary.badge, '已连接');
  assert.equal(summary.globalChannel, 'napcat');
});

test('T3-I2: with no live channel the summary still reports the configured channel honestly', () => {
  const base = liveNapcatState();
  base.settings.qqConnectionMode = 'official';
  base.state.setup.qqConnectionMode = 'official';
  base.connections.channels = [{ ...officialChannel, platformEnabled: true, configured: false }];

  const summary = connectionSummary({ ...base, connectionTab: 'napcat' });
  assert.equal(summary.badge, '待配置');
  assert.equal(summary.globalChannel, '');
});

test('T3-I4: the Electron IPC prefix is removed from the user-facing error', async () => {
  const bridge = {
    invoke: async () => { throw new Error("Error invoking remote method 'dswhale:action': Error: [APP-001] 至少要保留一路可用的 QQ 连接；如要切换，请先启用另一条连接"); },
    onState() { return () => {}; },
  };
  const controller = createController({ bridge });
  await assert.rejects(controller.act('connection-change', { channel: 'napcat', enabled: false }));
  assert.equal(controller.get().error, '[APP-001] 至少要保留一路可用的 QQ 连接；如要切换，请先启用另一条连接');
  assert.doesNotMatch(controller.get().error, /Error invoking remote method/);
  assert.doesNotMatch(controller.get().error, /^Error:/);
});

test('T3-I4: dismissing the banner clears the local error but not an in-flight action', async () => {
  let release;
  let push;
  const gate = new Promise(resolve => { release = resolve; });
  const fault = '[APP-001] 对话服务已退出，请检查配置后重试';
  const bridge = {
    invoke: async action => {
      if (action === 'inspect') return { installed: true, running: true };
      if (action === 'workspace-status') return { health: null, backups: [], appUpdate: null, napcat: null, preferences: {} };
      await gate; return { connections: {} };
    },
    onState(callback) { push = callback; return () => {}; },
  };
  const controller = createController({ bridge });
  await controller.init();
  const pending = controller.act('connection-change', { channel: 'napcat', enabled: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.get().pending, 'connection-change');

  // main publishes this through dswhale:state — it is a real fault, not a
  // renderer-local rejection, and the visible banner can still be dismissed.
  push({ error: fault });
  assert.equal(controller.get().state.error, fault);
  assert.equal(controller.get().error, '');
  controller.dismissError();
  assert.equal(controller.get().dismissedError, fault);
  assert.equal(controller.get().error, '');
  assert.equal(controller.get().state.error, fault, 'dismissing must not clear the real main-process fault');
  assert.equal(controller.get().pending, 'connection-change', 'dismissing a banner must not release the action fence');

  release();
  await pending;
  assert.equal(controller.get().pending, '');
});

test('T3-I4: a new operation re-arms the dismissed-error marker', async () => {
  let push;
  const bridge = {
    invoke: async action => (action === 'connections-status' ? { connections: {} } : {}),
    onState(callback) { push = callback; return () => {}; },
  };
  const controller = createController({ bridge });
  await controller.init();
  const fault = '[APP-001] 对话服务已退出，请检查配置后重试';
  push({ error: fault });
  controller.dismissError();
  assert.equal(controller.get().dismissedError, fault);

  await controller.act('workspace-status');
  assert.equal(controller.get().dismissedError, '', 'a new operation lets a still-present fault be shown again');
  assert.equal(controller.get().state.error, fault, 'the fault itself is retained');
});

test('T3-I4: dismissError clears the local error and retry metadata', async () => {
  const bridge = {
    invoke: async () => { throw new Error("Error invoking remote method 'dswhale:action': Error: [APP-001] 对话服务已退出，请检查配置后重试"); },
    onState() { return () => {}; },
  };
  const controller = createController({ bridge });
  await assert.rejects(controller.act('connections-status', {}));
  // connections-status is read-only and fails: the error banner is local data.
  assert.equal(controller.get().error, '[APP-001] 对话服务已退出，请检查配置后重试');
  controller.dismissError();
  assert.equal(controller.get().error, '');
  assert.equal(controller.get().retry, null);
});

// ---------------------------------------------------------------------------
// R2 — the global summary resolves both channels from enabled state and live
// workspace health. The legacy qqConnectionMode may only break ties.
// ---------------------------------------------------------------------------
const liveNapcatChannel = { ...napcatChannel };
const disabledNapcatChannel = {
  ...napcatChannel,
  platformEnabled: false, processRunning: false, loginState: 'stopped',
  protocolConnected: false, health: 'disabled',
};
const liveOfficialChannel = {
  ...officialChannel,
  platformEnabled: true, configured: true, protocolConnected: true,
  health: 'connected', loginState: 'official',
};

function liveOfficialState() {
  return {
    settings: {
      qqConnectionMode: 'napcat', defaultDelivery: 'official', officialConfigured: true,
      officialOwnerUMO: 'official-test:FriendMessage:owner', ownerQQ: '123456789',
    },
    state: { installed: true, running: true, platform: { id: 'win32-x64' }, setup: { qqConnectionMode: 'napcat', ownerConfigured: true, modelConfigured: true } },
    workspace: {
      napcat: { configured: true, externalOnly: false, running: false, loginState: 'stopped', protocolConnected: false },
      official: { protocolConnected: true },
    },
    connections: { channels: [disabledNapcatChannel, liveOfficialChannel] },
  };
}

test('R2: a live official channel is the global state even when the legacy mode still says napcat', () => {
  const base = liveOfficialState();
  for (const connectionTab of ['', 'official', 'napcat']) {
    const summary = connectionSummary({ ...base, connectionTab });
    assert.equal(summary.stage, 'ready', `tab ${connectionTab || '(none)'}: the live official channel is ready`);
    assert.equal(summary.badge, 'QQ 已连接');
    assert.equal(summary.globalChannel, 'official');
    assert.notEqual(summary.action, 'connection-change', 'the global state must not offer to enable the disabled NapCat channel');
  }
  // The NapCat tab itself still reports its own disabled channel; that is local.
  assert.equal(connectionViewModel({ ...base, connectionTab: 'napcat' }).stage, 'connection-disabled');
});

test('R2: a live napcat channel stays global when the official platform is disabled', () => {
  const base = liveNapcatState();
  base.settings.qqConnectionMode = 'official';
  base.state.setup.qqConnectionMode = 'official';
  base.connections.channels = [liveNapcatChannel, { ...officialChannel, platformEnabled: false, configured: true }];
  base.workspace.official = { protocolConnected: false };

  const summary = connectionSummary({ ...base, connectionTab: 'official' });
  assert.equal(summary.stage, 'ready');
  assert.equal(summary.badge, '已连接');
  assert.equal(summary.globalChannel, 'napcat');
  assert.equal(connectionViewModel({ ...base, connectionTab: 'official' }).stage, 'official-disabled');
});

test('R2: with both channels enabled, the healthy channel wins over one that still needs configuration', () => {
  const base = liveOfficialState();
  base.connections.channels = [
    { ...napcatChannel, platformEnabled: true, processRunning: false, loginState: 'stopped', protocolConnected: false, health: 'offline' },
    liveOfficialChannel,
  ];
  base.workspace.napcat = { configured: true, externalOnly: false, running: false, loginState: 'stopped', protocolConnected: false };

  const summary = connectionSummary({ ...base, connectionTab: 'napcat' });
  assert.equal(summary.stage, 'ready');
  assert.equal(summary.badge, 'QQ 已连接');
  assert.equal(summary.globalChannel, 'official', 'a healthy official channel must not be replaced by an enabled-but-offline small account');
});

test('R2: default delivery breaks a tie between two healthy channels, not the legacy mode', () => {
  const base = liveOfficialState();
  base.connections.channels = [liveNapcatChannel, liveOfficialChannel];
  base.workspace.napcat = { configured: true, externalOnly: false, running: true, loginState: 'online', protocolConnected: true };

  assert.equal(connectionSummary({ ...base, connectionTab: 'napcat' }).globalChannel, 'official');
  base.settings.defaultDelivery = '';
  assert.equal(connectionSummary({ ...base, connectionTab: 'official' }).globalChannel, 'napcat');
});

test('R2: stale snapshot flags never report a stopped channel as online', () => {
  const base = liveOfficialState();
  // The connection snapshot still says napcat is connected, but the current
  // workspace says its process/protocol are down.
  base.connections.channels[0] = { ...napcatChannel, platformEnabled: true, protocolConnected: true, health: 'connected' };
  base.workspace.napcat = { configured: true, externalOnly: false, running: false, loginState: 'stopped', protocolConnected: false };

  const summary = connectionSummary({ ...base, connectionTab: 'napcat' });
  assert.equal(summary.stage, 'ready');
  assert.equal(summary.globalChannel, 'official', 'the live official channel is preferred to a stale napcat snapshot');

  base.workspace.official = { protocolConnected: false };
  const staleOfficial = connectionSummary({ ...base, connectionTab: 'official' });
  assert.notEqual(staleOfficial.stage, 'ready', 'a disconnected official channel must not claim readiness');
  assert.notEqual(staleOfficial.badge, 'QQ 已连接');
});

// ---------------------------------------------------------------------------
// R3 — a main-process fault that clears and later recurs with the same text is
// a new failure and must be visible again (tray starts never call act()).
// ---------------------------------------------------------------------------
test('R3: a cleared main-process fault re-arms the same-text dismissal', async () => {
  let push;
  const bridge = {
    invoke: async action => (action === 'connections-status' ? { connections: {} } : {}),
    onState(callback) { push = callback; return () => {}; },
  };
  const controller = createController({ bridge });
  await controller.init();
  const fault = '启动未完成，请打开窗口查看体检结果';
  const visible = () => {
    const current = controller.get();
    const raw = current.error || current.state.error;
    return raw && raw !== current.dismissedError ? raw : '';
  };

  push({ error: fault });
  assert.equal(visible(), fault);
  controller.dismissError();
  assert.equal(visible(), '');

  // main.cjs startServices publishes error:undefined before a tray retry.
  push({ error: undefined, startup: { stage: 'starting-conversation' } });
  assert.equal(controller.get().dismissedError, '', 'an explicit error clear ends the old dismissal');

  push({ error: fault, startup: { stage: 'failed' } });
  assert.equal(controller.get().state.error, fault);
  assert.equal(visible(), fault, 'the same text after an actual clear is a new fault');
});

test('R3: an ordinary snapshot without an error field keeps the dismissal', async () => {
  let push;
  const bridge = {
    invoke: async action => (action === 'connections-status' ? { connections: {} } : {}),
    onState(callback) { push = callback; return () => {}; },
  };
  const controller = createController({ bridge });
  await controller.init();
  const fault = '启动未完成，请打开窗口查看体检结果';
  push({ error: fault });
  controller.dismissError();

  push({ running: true, startup: { stage: 'checking-qq' } });
  assert.equal(controller.get().dismissedError, fault, 'an update that does not mention error keeps the dismissal');
  assert.equal(controller.get().state.error, fault, 'nor does it clear the real fault');
});

test('F5: a healthy channel outranks the stale preferred channel during startup', () => {
  const base = liveNapcatState();
  base.state.running = true;
  base.connections.channels = [
    { ...napcatChannel, platformEnabled: true, health: 'connected' },
    { ...officialChannel, platformEnabled: true, configured: true, health: 'unknown' },
  ];
  base.settings.qqConnectionMode = 'official';
  const summary = connectionSummary({ ...base, connectionTab: 'official' });
  assert.equal(summary.globalChannel, 'napcat');
  assert.equal(summary.badge, '已连接');
  assert.equal(summary.tone, 'good');
});

test('F5: a single connecting channel does not make the global summary working', () => {
  const base = liveNapcatState();
  base.state.running = false;
  base.connections.channels = [
    { ...napcatChannel, health: 'connecting', processRunning: true, loginState: 'starting' },
    officialChannel,
  ];
  const summary = connectionSummary({ ...base, connectionTab: 'napcat' });
  assert.equal(summary.globalChannel, '');
  assert.notEqual(summary.badge, '已连接');
});
