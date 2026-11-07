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
  const gate = new Promise(resolve => { release = resolve; });
  const bridge = {
    invoke: async () => { await gate; return { connections: {} }; },
    onState() { return () => {}; },
  };
  const controller = createController({ bridge });
  const pending = controller.act('connection-change', { channel: 'napcat', enabled: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.get().pending, 'connection-change');

  controller.dismissError();
  assert.equal(controller.get().pending, 'connection-change', 'dismissing a banner must not release the action fence');

  release();
  await pending;
  assert.equal(controller.get().pending, '');
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
