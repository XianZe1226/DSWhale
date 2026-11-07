'use strict';
// T3-I1 / T3-I2 / T3-I4 — executable specifications for the a12 Windows 11 fix round.
//
// This file is intentionally named *.spec.cjs so `npm test`
// (`node --test desktop/tests/*.test.cjs`) does NOT run it against the unfixed
// baseline. Run it explicitly while implementing:
//
//   node --test desktop/tests/windows11-fix.spec.cjs
//
// Every assertion below fails on commit 6997f37 and is expected to pass only
// after the corresponding fix. It uses the same DOM double as desktop/tests/ui.test.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const uiPath = path.join(__dirname, '../ui/model.js');
const load = () => require(uiPath);
const workspaceStatus = (patch = {}) => ({
  health: { checks: [], summary: { requiredFailures: 0, warnings: 0 } },
  backups: [],
  appUpdate: { currentVersion: '0.3.0a12', targetVersion: null, channel: 'alpha', phase: 'idle', canDownload: false, canInstall: false, canRollback: false, actions: ['check'], impact: null, recovery: { interrupted: false } },
  network: { mode: 'system', proxyUrl: '', noProxy: '', pypiIndex: '', npmRegistry: '', assetMirrors: [] },
  napcat: { supported: true, configured: true, needsLogin: false, connectionConfigured: true, running: true, externalOnly: false, loginState: 'online', protocolConnected: true },
  preferences: { tray: false, startAtLogin: false, resumeAfterWake: false },
  diagnosticFiles: ['health.json', 'events.json', 'versions.json', 'README.txt'],
  ...patch,
});

function renderApp({ screen = 'intelligence', invoke, workspace = workspaceStatus() } = {}) {
  const handlers = {};
  const page = { scrollTop: 0, focus() {} };
  const announcer = { textContent: '' };
  const body = {};
  let markup = '';
  let buttons = [];
  const inputValues = {};
  let document;
  const root = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      document.activeElement = body;
      buttons = [...value.matchAll(/<button\b([^>]*)>/g)].map(([, attrs]) => {
        const attr = key => attrs.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];
        return { id: attr('id'), disabled: /\sdisabled(?:\s|$)/.test(attrs), dataset: { action: attr('data-action'), panel: attr('data-panel'), route: attr('data-route'), channel: attr('data-channel'), enabled: attr('data-enabled') }, focus() { if (!this.disabled) document.activeElement = this; } };
      });
    },
    addEventListener(name, callback) { handlers[name] = callback; },
    querySelectorAll() { return buttons; },
  };
  document = { body, activeElement: body, getElementById(id) { if (inputValues[id] !== undefined) return { value: inputValues[id], focus() {}, type: 'text' }; return id === 'app' ? root : id === 'announcer' ? announcer : id === 'main-content' ? page : buttons.find(button => button.id === id); }, querySelector() { return page; } };
  const calls = [];
  let stateListener;
  const bridge = { invoke: async (action, payload) => { calls.push([action, payload && JSON.parse(JSON.stringify(payload))]); return action === 'workspace-status' ? workspace : invoke(action, payload); }, onState: callback => { stateListener = callback; return () => {}; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), {
    window: { DSWhaleUI: load(), dswhale: bridge, addEventListener() {} }, document,
    location: { search: `?screen=${screen}` }, URLSearchParams,
  });
  return {
    calls, html: () => root.innerHTML,
    settle: () => new Promise(resolve => setImmediate(resolve)),
    clickConnection: (channel, enabled) => handlers.click({ target: { closest() { return this; }, dataset: { action: 'connection-change', channel, enabled }, hasAttribute() { return false; } } }),
    selectMode: mode => handlers.click({ target: { closest() { return this; }, dataset: { action: 'select-qq-mode', mode }, hasAttribute() { return false; } } }),
    pushState: value => stateListener(value),
    buttons: () => buttons,
  };
}

// One enabled channel only: napcat is the sole remaining enabled connection,
// which is exactly the case desktop/lib/qq-connections.cjs:126 refuses.
function soleConnectionSnapshot() {
  return createRequire(path.join(__dirname, '../main.cjs'))('./lib/qq-connections.cjs').snapshot({
    revision: 'rev-1', running: true, defaultDelivery: 'napcat',
    platforms: [
      { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
      { id: 'official-test', type: 'qq_official', enable: false, configured: true },
    ],
    bindings: { napcat: true, official: true },
    napcat: { running: true, loginState: 'online' },
    health: { channels: {
      napcat: { state: 'connected', platformReady: true, protocolConnected: true },
      official: { state: 'unknown', platformReady: false, protocolConnected: false },
    } },
  });
}

const connectInvoke = (connections, settings = {}) => async (action, payload) => {
  if (action === 'inspect') return { installed: true, running: true, platform: { id: 'win32-x64', supported: true }, setup: { ownerConfigured: true, modelConfigured: true, qqConnectionMode: 'napcat' } };
  if (action === 'connections-status') return { connections };
  if (action === 'connection-change') {
    // Mirrors desktop/main.cjs -> reportActionError: the main process rejects with
    // this exact message, Electron wraps it into the invoke rejection.
    throw new Error(`Error invoking remote method 'dswhale:action': Error: [APP-001] 至少要保留一路可用的 QQ 连接；如要切换，请先启用另一条连接`);
  }
  if (action === 'settings-history') return { format: 1, records: [], migrationReceipt: null };
  if (action === 'extensions-status') return {};
  return { ownerQQ: '123456', platformId: 'qq', onebotPort: 6199, dashboardPort: 6185, onebotToken: 'synthetic-token', qqConnectionMode: 'napcat', napcatBound: true, officialBound: true, defaultDelivery: 'napcat', ...settings };
};

// ---------------------------------------------------------------------------
// T3-I1 — the last enabled connection cannot be disabled: the UI must explain
// the rule before the user triggers a request the server is guaranteed to reject.
// Do NOT weaken desktop/lib/qq-connections.cjs:126 to satisfy this.
// ---------------------------------------------------------------------------
test('T3-I1 spec: the connect screen explains the last-connection rule in visible (non-collapsed) content', async () => {
  const connections = soleConnectionSnapshot();
  assert.deepEqual(connections.channels.filter(c => c.platformEnabled).map(c => c.channel), ['napcat'], 'fixture: napcat is the only enabled channel');

  const app = renderApp({ screen: 'connect', invoke: connectInvoke(connections) });
  await app.settle();

  const html = app.html();
  const visible = html.replace(/<details\b[^>]*id="connection-advanced"[\s\S]*?<\/details>/g, '');
  assert.match(visible, /至少要保留一路|仅剩一路|唯一的?(?:可用)?连接|无法停用最后/, 'the rule must be explained outside the collapsed "更多连接选项" section');

  // Distinguish "stop the conversation" from "disable the channel" where the card is shown.
  assert.match(visible, /停止对话/, 'the card area must distinguish stopping the conversation from disabling the channel');
});

test('T3-I1 spec: clicking the last enabled connection never reaches the server guard unannounced', async () => {
  const connections = soleConnectionSnapshot();
  const app = renderApp({ screen: 'connect', invoke: connectInvoke(connections) });
  await app.settle();

  const button = app.buttons().find(b => b.dataset.action === 'connection-change' && b.dataset.channel === 'napcat');
  assert.ok(button, 'napcat card has a connection-change control');
  assert.equal(button.dataset.enabled, '0', 'fixture: the card offers "disable"');

  if (button.disabled) return; // disabled + explained is an acceptable fix
  await app.clickConnection('napcat', '0');
  await app.settle();
  assert.equal(app.calls.some(([action]) => action === 'connection-change'), false, 'an enabled control must ask for confirmation/explanation locally instead of letting the server reject it');
});

// ---------------------------------------------------------------------------
// T3-I2 — a locally selected tab must not rewrite the global connection summary
// (sidebar badge / overview hero / tab summaries all reuse connectionViewModel).
// ---------------------------------------------------------------------------
test('T3-I2 spec: the global status summary ignores the locally selected connection tab', () => {
  const ui = load();
  const summary = ui.connectionSummary || ui.globalConnectionViewModel || ui.connectionOverview;
  assert.equal(typeof summary, 'function', 'a global connection summary must be separated from the tab-scoped connectionViewModel');

  const base = {
    settings: { qqConnectionMode: 'napcat', ownerQQ: '123456' },
    state: { installed: true, running: true, platform: { id: 'win32-x64', supported: true }, setup: { ownerConfigured: true, modelConfigured: true, qqConnectionMode: 'napcat' } },
    workspace: { napcat: { configured: true, externalOnly: false, running: true, loginState: 'online', protocolConnected: true } },
  };
  const napcatView = summary({ ...base, connectionTab: '' });
  const officialTabView = summary({ ...base, connectionTab: 'official' });
  assert.equal(officialTabView.badge, napcatView.badge, 'switching tabs must not change the sidebar/overview badge');
  assert.match(napcatView.badge, /已连接|已就绪|就绪|运行/, 'fixture: the live napcat connection is reported as connected');
});

test('T3-I2 spec: selecting the official tab does not flip the sidebar or the overview to 待配置', async () => {
  const connections = soleConnectionSnapshot();
  const app = renderApp({ screen: 'connect', invoke: connectInvoke(connections) });
  await app.settle();
  const sidebar = () => app.html().match(/<div class="sidebar-service">[\s\S]*?<\/div><\/div>/)?.[0] || '';
  const label = () => (sidebar().match(/<strong>([^<]*)<\/strong>/) || [])[1] || '';
  const before = label();
  assert.match(before, /已连接|已就绪|就绪/, 'fixture: the overall state is connected before the tab switch');

  app.selectMode('official');
  await app.settle();
  assert.match(app.html(), /data-mode="official" aria-selected="true"/, 'fixture: the tab switch must actually take effect');

  assert.equal(label(), before, 'the sidebar badge describes the overall connection, not the tab being viewed');
  const hero = app.html().match(/<section class="hero"[\s\S]*?<\/section>/)?.[0] || '';
  assert.ok(hero, 'fixture: the overview hero is rendered');
  assert.doesNotMatch(hero, /创建或连接 QQ 官方机器人|尚未启动|已停用/, 'the overview hero must not replace the live connection with the tab-scoped channel');
});

// ---------------------------------------------------------------------------
// T3-I4 — error text lifecycle: strip the Electron IPC wrapper, allow dismissing
// the transient message, never let dismissal erase a persistent fault or unlock
// an in-flight operation.
// ---------------------------------------------------------------------------
test('T3-I4 spec: the controller normalizes the renderer-side IPC prefix', async () => {
  const { createController } = load();
  const controller = createController({
    bridge: {
      invoke: async () => { throw new Error(`Error invoking remote method 'dswhale:action': Error: [APP-001] 至少要保留一路可用的 QQ 连接；如要切换，请先启用另一条连接`); },
      onState: () => () => {},
    },
  });
  await assert.rejects(controller.act('connection-change', { channel: 'napcat', enabled: false }));
  assert.equal(controller.get().error, '[APP-001] 至少要保留一路可用的 QQ 连接；如要切换，请先启用另一条连接');
  assert.doesNotMatch(controller.get().error, /Error invoking remote method|^Error:/);
});

test('T3-I4 spec: the transient error can be dismissed without unlocking anything', async () => {
  const { createController } = load();
  const controller = createController({ bridge: { invoke: async () => { throw new Error('操作未完成'); }, onState: () => () => {} } });
  await assert.rejects(controller.act('connections-status'));
  assert.equal(controller.get().error, '操作未完成');
  assert.equal(typeof controller.dismissError, 'function', 'the banner must expose a dismiss action');
  controller.dismissError();
  assert.equal(controller.get().error, '');
  assert.equal(controller.get().pending, '', 'dismissing a message must not clear or fake the operation lock');
});

test('T3-I4 spec: a dismissed banner does not hide a still-present main-process fault', async () => {
  const app = renderApp({ screen: 'connect', invoke: connectInvoke(soleConnectionSnapshot()) });
  await app.settle();
  app.pushState({ error: '[APP-001] 对话服务已退出，请检查配置后重试' });
  await app.settle();
  const html = app.html();
  assert.match(html, /对话服务已退出/);
  // The banner must offer a dismiss control for the transient part while the
  // persistent state.error stays actionable.
  assert.match(html, /data-action="dismiss-error"/);
});
