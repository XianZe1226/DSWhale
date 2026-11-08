'use strict';
// F1/F7: edits are tracked per field, external refreshes never overwrite a dirty
// draft, and the preview textarea is local state that never enters a save patch.
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
        return { id: attr('id'), disabled: /\sdisabled(?:\s|$)/.test(attrs), dataset: { action: attr('data-action'), mode: attr('data-mode'), route: attr('data-route') }, focus() { if (!this.disabled) document.activeElement = this; } };
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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), { window: { DSWhaleUI: model, dswhale: bridge, addEventListener() {} }, document, location: { search: '?screen=intelligence' }, URLSearchParams });
  return {
    calls, html: () => root.innerHTML,
    settle: () => new Promise(resolve => setImmediate(resolve)),
    click: dataset => handlers.click({ target: { closest() { return this; }, dataset, hasAttribute() { return false; } } }),
    input: (id, value) => { inputValues[id] = value; },
    type: (id, value) => { inputValues[id] = value; handlers.input?.({ target: { id, value, type: 'textarea', matches() { return true; } } }); },
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
  app.click({ action: 'reply-style-mode', mode: 'natural' });
  await app.settle();
  app.click({ action: 'settings-get' });
  for (let i = 0; i < 4; i += 1) await app.settle();
  assert.match(app.html(), /自然短句/);
  app.click({ action: 'save-settings' });
  for (let i = 0; i < 4; i += 1) await app.settle();
  const save = app.calls.find(([action]) => action === 'settings-save');
  assert.ok(save);
  assert.equal(save[1].patch.replyStyleMode, 'natural');
  assert.equal(Object.hasOwn(save[1].patch, 'proactiveEnabled'), false);
});

test('F1: the same field changed externally needs a second confirmation', async () => {
  let reads = 0;
  const app = await boot(async action => {
    if (action === 'settings-get') { reads += 1; return reads === 1 ? settings() : settings({ replyStyleMode: 'single' }); }
    if (action === 'inspect') return { installed: true, running: true, phase: 'ready', setup: { ownerConfigured: true, qqConfigured: true, modelConfigured: true } };
    if (action === 'extensions-status') return {};
    return {};
  });
  app.click({ action: 'reply-style-mode', mode: 'natural' });
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
  assert.equal(save[1].patch.replyStyleMode, 'natural');
});

test('F6: an uncomputed host preview never renders a fabricated count or bubbles', async () => {
  const app = await boot(async action => {
    if (action === 'settings-get') return settings();
    if (action === 'inspect') return { installed: true, running: true, phase: 'ready', setup: { ownerConfigured: true, qqConfigured: true, modelConfigured: true } };
    if (action === 'extensions-status') return {};
    if (action === 'reply-style-preview') return { mode: 'inherit', path: 'host', hostPath: 'host_unknown', computed: false, uncomputedReason: 'host_regex_timeout', count: 99, bubbles: ['不应渲染'], interval: null, warnings: [], hostSource: { profileId: 'qq', platform: 'aiocqhttp', segmented: { enable: true } } };
    return {};
  });
  app.input('replyStylePreviewText', '甲。乙。');
  app.click({ action: 'reply-style-preview' });
  for (let i = 0; i < 4; i += 1) await app.settle();
  const html = app.html();
  assert.match(html, /条数未计算/);
  assert.doesNotMatch(html, /99 条/);
  assert.doesNotMatch(html, /不应渲染/);
  assert.match(html, /宿主分段规则执行超时/);
});

test('F7: the preview textarea is local state and never part of the save payload', async () => {
  const app = await boot(async action => {
    if (action === 'settings-get') return settings();
    if (action === 'inspect') return { installed: true, running: true, phase: 'ready', setup: { ownerConfigured: true, qqConfigured: true, modelConfigured: true } };
    if (action === 'extensions-status') return {};
    return {};
  });
  app.type('replyStylePreviewText', '只在这里出现的合成文本。');
  app.click({ action: 'reply-style-mode', mode: 'natural' });
  await app.settle();
  assert.match(app.html(), /只在这里出现的合成文本。/);
  app.click({ action: 'save-settings' });
  for (let i = 0; i < 4; i += 1) await app.settle();
  const save = app.calls.find(([action]) => action === 'settings-save');
  assert.ok(save);
  assert.equal(JSON.stringify(save[1]).includes('只在这里出现的合成文本'), false);
});

test('F6: a host-segmented preview shows the real three bubbles, not one placeholder', async () => {
  const app = await boot(async action => {
    if (action === 'settings-get') return settings();
    if (action === 'inspect') return { installed: true, running: true, phase: 'ready', setup: { ownerConfigured: true, qqConfigured: true, modelConfigured: true } };
    if (action === 'extensions-status') return {};
    if (action === 'reply-style-preview') return { mode: 'inherit', path: 'host', hostPath: 'host_segmented', computed: true, count: 3, bubbles: ['甲。', '乙。', '丙。'], interval: null, warnings: [], hostSource: { profileId: 'qq', platform: 'aiocqhttp', segmented: { enable: true } } };
    return {};
  });
  app.input('replyStylePreviewText', '甲。乙。丙。');
  app.click({ action: 'reply-style-preview' });
  for (let i = 0; i < 4; i += 1) await app.settle();
  const html = app.html();
  assert.match(html, /3 条 · 沿用宿主 · host_segmented/);
  assert.match(html, /甲。/);
  assert.match(html, /乙。/);
  assert.match(html, /丙。/);
});
