'use strict';
// Edits are tracked per field; refresh and conflict handling preserve the draft.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const model = require('../ui/model.js');

const settings = (patch = {}) => ({
  ownerQQ: '123456789', platformId: '', onebotPort: 6199, dashboardPort: 6185, onebotToken: '',
  qqConnectionMode: 'napcat', officialOwnerUMO: '', defaultDelivery: '',
  biliEnabled: false, proactiveEnabled: false, signatureEnabled: false, qzoneEnabled: false,
  replyStyleMode: 'inherit', replyStyleMaxBubbles: 3, replyStyleInterval: '0.8,1.5',
  replyStylePunctuation: 'keep', replyStylePrompt: true,
  replyStyleCustomRegex: '', replyStyleCustomCleanup: '', persona: '人格正文。', ...patch,
});
const workspace = () => ({
  health: { checks: [], summary: { requiredFailures: 0, warnings: 0 } }, backups: [],
  appUpdate: { currentVersion: '0.3.0a12', targetVersion: null, channel: 'alpha', phase: 'idle', canDownload: false, canInstall: false, canRollback: false, actions: ['check'], impact: null, recovery: { interrupted: false } },
  network: { mode: 'system', proxyUrl: '', noProxy: '', pypiIndex: '', npmRegistry: '', assetMirrors: [] },
  napcat: { supported: true, configured: true, needsLogin: false, connectionConfigured: true, running: true, externalOnly: false, loginState: 'online', protocolConnected: true },
  preferences: { tray: false, startAtLogin: false, resumeAfterWake: false }, diagnosticFiles: [],
});

function renderApp(invoke) {
  const handlers = {};
  const page = { scrollTop: 0, focus() {} };
  const announcer = { textContent: '' };
  const body = {};
  const inputValues = {};
  let markup = '', buttons = [], document;
  const root = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value; document.activeElement = body;
      buttons = [...value.matchAll(/<button\b([^>]*)>/g)].map(([, attrs]) => {
        const attr = key => attrs.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];
        return {
          id: attr('id'), disabled: /\sdisabled(?:\s|$)/.test(attrs),
          dataset: { action: attr('data-action'), mode: attr('data-mode'), route: attr('data-route') },
          closest(selector) { return selector === 'button' ? this : null; },
          hasAttribute(name) { return name === 'disabled' ? this.disabled : Object.hasOwn(this.dataset, name); },
          focus() { if (!this.disabled) document.activeElement = this; },
        };
      });
    },
    addEventListener(name, callback) { handlers[name] = callback; },
    querySelectorAll() { return buttons; },
  };
  document = {
    body, activeElement: body,
    getElementById(id) {
      if (inputValues[id] !== undefined) return { value: inputValues[id], focus() {}, type: 'text' };
      return id === 'app' ? root : id === 'announcer' ? announcer : id === 'main-content' ? page : buttons.find(button => button.id === id);
    },
    querySelector() { return page; },
  };
  const calls = [];
  const bridge = { invoke: async (action, payload) => { calls.push([action, payload]); return action === 'workspace-status' ? workspace() : invoke(action, payload); }, onState: () => () => {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), { window: { DSWhaleUI: model, dswhale: bridge, addEventListener() {} }, document, location: { search: '?screen=connect' }, URLSearchParams });
  return {
    calls, html: () => root.innerHTML,
    settle: () => new Promise(resolve => setImmediate(resolve)),
    click: dataset => handlers.click({ target: { closest() { return this; }, dataset, hasAttribute() { return false; } } }),
    clickButton: button => handlers.click({ target: button }),
    input: (id, value) => { inputValues[id] = value; },
    type: (id, value) => { inputValues[id] = value; handlers.input?.({ target: { id, value, type: 'text', matches() { return true; } } }); },
    buttons: () => buttons,
  };
}

async function boot(invoke) {
  const app = renderApp(invoke);
  for (let i = 0; i < 12; i += 1) await app.settle();
  return app;
}

test('F1: a dirty field survives an external refresh and only that field is patched', async () => {
  let reads = 0;
  const app = await boot(async action => {
    if (action === 'settings-get') { reads += 1; return reads === 1 ? settings() : settings({ proactiveEnabled: true }); }
    if (action === 'inspect') return { installed: true, running: true, phase: 'ready', setup: { ownerConfigured: true, qqConfigured: true, modelConfigured: true } };
    if (action === 'extensions-status') return {};
    if (action === 'connections-status') return { channels: [] };
    return {};
  });
  app.type('dashboardPort', '6186');
  await app.settle();
  app.click({ action: 'settings-get' });
  for (let i = 0; i < 4; i += 1) await app.settle();
  assert.match(app.html(), /6186/);
  app.click({ action: 'save-settings' });
  for (let i = 0; i < 4; i += 1) await app.settle();
  const save = app.calls.find(([action]) => action === 'settings-save');
  assert.ok(save);
  assert.equal(save[1].patch.dashboardPort, 6186);
  assert.equal(Object.hasOwn(save[1].patch, 'proactiveEnabled'), false);
});

test('F1: the same field changed externally needs a second confirmation', async () => {
  let reads = 0;
  const app = await boot(async action => {
    if (action === 'settings-get') { reads += 1; return reads === 1 ? settings() : settings({ dashboardPort: 6187 }); }
    if (action === 'inspect') return { installed: true, running: true, phase: 'ready', setup: { ownerConfigured: true, qqConfigured: true, modelConfigured: true } };
    if (action === 'extensions-status') return {};
    return {};
  });
  app.type('dashboardPort', '6186');
  await app.settle();
  app.click({ action: 'settings-get' });
  for (let i = 0; i < 4; i += 1) await app.settle();
  app.click({ action: 'save-settings' });
  for (let i = 0; i < 3; i += 1) await app.settle();
  assert.equal(app.calls.some(([action]) => action === 'settings-save'), false);
  assert.match(app.html(), /已在外部更新/);
  app.click({ action: 'save-settings' });
  for (let i = 0; i < 4; i += 1) await app.settle();
  const save = app.calls.find(([action]) => action === 'settings-save');
  assert.equal(save[1].patch.dashboardPort, 6186);
});

test('S5: a failed save exposes an in-app refresh that preserves the draft', async () => {
  let reads = 0;
  let saves = 0;
  const app = await boot(async action => {
    if (action === 'settings-get') {
      reads += 1;
      return reads === 1 ? settings() : settings({ dashboardPort: 6187, proactiveEnabled: true });
    }
    if (action === 'settings-save') {
      saves += 1;
      return saves === 1 ? { error: '设置已被外部修改，请重新读取。' } : settings({ dashboardPort: 6186, proactiveEnabled: true });
    }
    if (action === 'inspect') return { installed: true, running: true, phase: 'ready', setup: { ownerConfigured: true, qqConfigured: true, modelConfigured: true } };
    if (action === 'extensions-status') return {};
    return {};
  });
  app.type('dashboardPort', '6186');
  await app.settle();
  app.click({ action: 'save-settings' });
  for (let i = 0; i < 4; i += 1) await app.settle();
  assert.equal(saves, 1);
  assert.match(app.html(), /设置已被外部修改/);
  assert.match(app.html(), /重新读取并保留修改/);
  const refresh = app.buttons().find(button => button.dataset.action === 'settings-get');
  assert.ok(refresh);
  assert.equal(refresh.disabled, false);
  app.clickButton(refresh);
  for (let i = 0; i < 4; i += 1) await app.settle();
  assert.equal(reads, 2);

  app.click({ action: 'save-settings' });
  for (let i = 0; i < 3; i += 1) await app.settle();
  assert.equal(saves, 1, 'the first save after refresh must only ask for confirmation');
  assert.match(app.html(), /再次点击保存将覆盖外部值/);

  app.click({ action: 'save-settings' });
  for (let i = 0; i < 4; i += 1) await app.settle();
  assert.equal(saves, 2);
  const save = app.calls.filter(([action]) => action === 'settings-save').at(-1);
  assert.deepEqual(save[1].patch, { dashboardPort: 6186 });
  assert.doesNotMatch(app.html(), /重新读取并保留修改/);
});
