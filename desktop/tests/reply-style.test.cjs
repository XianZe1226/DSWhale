'use strict';
// R4: reply style configuration stays independent from the persona text, is
// validated before saving, and renders a usable offline preview card.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const model = require('../ui/model.js');
const security = require('../lib/security.cjs');

const settings = (patch = {}) => ({
  ownerQQ: '123456789', platformId: '', onebotPort: 6199, dashboardPort: 6185, onebotToken: '',
  qqConnectionMode: 'napcat', officialOwnerUMO: '', defaultDelivery: '',
  biliEnabled: false, proactiveEnabled: false, signatureEnabled: false, qzoneEnabled: false,
  replyStyleMode: 'inherit', replyStyleMaxBubbles: 3, replyStyleInterval: '0.8,1.5',
  replyStylePunctuation: 'keep', replyStylePrompt: true,
  replyStyleCustomRegex: '', replyStyleCustomCleanup: '', persona: '你是一只可爱的大肥鱼。', ...patch,
});

const workspace = () => ({
  health: { checks: [], summary: { requiredFailures: 0, warnings: 0 } }, backups: [],
  appUpdate: { currentVersion: '0.3.0a12', targetVersion: null, channel: 'alpha', phase: 'idle', canDownload: false, canInstall: false, canRollback: false, actions: ['check'], impact: null, recovery: { interrupted: false } },
  network: { mode: 'system', proxyUrl: '', noProxy: '', pypiIndex: '', npmRegistry: '', assetMirrors: [] },
  napcat: { supported: true, configured: true, needsLogin: false, connectionConfigured: true, running: true, externalOnly: false, loginState: 'online', protocolConnected: true },
  preferences: { tray: false, startAtLogin: false, resumeAfterWake: false },
  diagnosticFiles: [], ...{},
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
    buttons: () => buttons,
  };
}

test('reply style fields are serialized with strict validation', () => {
  const payload = model.settingsPayload(settings({ replyStyleMode: 'natural', replyStyleMaxBubbles: 2, replyStyleInterval: '1, 2', replyStylePunctuation: 'sentence_end', replyStyleCustomRegex: '[^\\n]+' }));
  assert.equal(payload.replyStyleMode, 'natural');
  assert.equal(payload.replyStyleMaxBubbles, 2);
  assert.equal(payload.replyStyleInterval, '1,2');
  assert.equal(payload.replyStylePunctuation, 'sentence_end');
  assert.equal(payload.replyStyleCustomRegex, '[^\\n]+');
  assert.equal(payload.persona, undefined);
  assert.throws(() => model.settingsPayload(settings({ replyStyleMode: 'token' })), /回复方式无效/);
  assert.throws(() => model.settingsPayload(settings({ replyStyleMaxBubbles: 4 })), /1–3/);
  assert.throws(() => model.settingsPayload(settings({ replyStyleInterval: '2,1' })), /发送间隔/);
  // JavaScript's regex dialect is not authoritative. These are accepted by the
  // transport and rejected by the Python settings validator instead of by a
  // hidden renderer check that could reject valid host-only patterns.
  assert.equal(model.settingsPayload(settings({ replyStyleCustomRegex: '(a)' })).replyStyleCustomRegex, '(a)');
  assert.equal(model.settingsPayload(settings({ replyStyleCustomRegex: 'x*' })).replyStyleCustomRegex, 'x*');
  assert.throws(() => model.settingsPayload(settings({ replyStyleCustomRegex: 'a'.repeat(201) })), /200/);
});

test('reply style fields are allowlisted by the renderer security gate', () => {
  assert.equal(security.validateSettings({ patch: model.settingsPayload(settings({ replyStyleMode: 'custom', replyStyleCustomRegex: '[^\\n]+' })) }), true);
  assert.equal(security.validateSettings({ patch: { replyStyleMode: 'custom', unknown: true } }), false);
  assert.equal(security.validateSettings({ patch: { ownerQQ: '1', replyStylePrompt: true } }), true);
});

test('the intelligence page shows the persona source and reply-style controls', async () => {
  const app = renderApp(async action => {
    if (action === 'settings-get') return settings();
    if (action === 'inspect') return { installed: true, running: true, phase: 'ready', setup: { ownerConfigured: true, qqConfigured: true, modelConfigured: true, memoryConfigured: false, biliEnabled: false } };
    if (action === 'extensions-status') return { memory: { installed: false, version: '' }, memes: { installed: false, version: '' } };
    if (action === 'connections-status') return { channels: [] };
    if (action === 'settings-history') return { records: [] };
    return {};
  });
  for (let i = 0; i < 10; i += 1) await app.settle();
  const html = app.html();
  assert.match(html, /人格来源/);
  assert.match(html, /DSWhale 补充人格/);
  assert.match(html, /自然短句/);
  assert.match(html, /离线预览/);
  assert.match(html, /仅 DSWhale 授权的私聊与主人会话/);
  assert.ok(app.buttons().some(button => button.dataset.action === 'reply-style-mode' && button.dataset.mode === 'natural'));
  assert.ok(app.buttons().some(button => button.dataset.action === 'reply-style-preview'));
});

test('preview uses the runtime plan returned by the main process and does not call a model', async () => {
  const app = renderApp(async (action, payload) => {
    if (action === 'settings-get') return settings();
    if (action === 'inspect') return { installed: true, running: true, phase: 'ready', setup: { ownerConfigured: true, qqConfigured: true, modelConfigured: true, memoryConfigured: false, biliEnabled: false } };
    if (action === 'extensions-status') return { memory: { installed: false, version: '' }, memes: { installed: false, version: '' } };
    if (action === 'reply-style-preview') return { mode: 'natural', path: 'plugin', hostPath: 'plugin_owned', bubbles: ['甲。', '乙。'], count: 2, warnings: [], protected: [], interval: [0.8, 1.5] };
    return {};
  });
  for (let i = 0; i < 10; i += 1) await app.settle();
  app.input('replyStylePreviewText', '甲。乙。');
  app.click({ action: 'reply-style-preview' });
  for (let i = 0; i < 4; i += 1) await app.settle();
  const previewCall = app.calls.find(([action]) => action === 'reply-style-preview');
  assert.ok(previewCall);
  assert.equal(previewCall[1].text, '甲。乙。');
  assert.equal(previewCall[1].platform, 'aiocqhttp');
  assert.match(app.html(), /2 条 · DSWhale 接管/);
  assert.match(app.html(), /甲。/);
  assert.match(app.html(), /乙。/);
});

test('the persona text is displayed only locally and is not part of a save patch', () => {
  const payload = model.settingsPayload(settings());
  assert.equal(Object.hasOwn(payload, 'persona'), false);
});

test('host decoration preview fields are allowlisted and explained in the card', async () => {
  const shell = { mainFrame: {} };
  const event = { sender: shell, senderFrame: shell.mainFrame };
  assert.doesNotThrow(() => security.validateRequest(event, shell, 'reply-style-preview', { text: '甲', hostReplyPrefix: true, hostTtsEnabled: true }));
  assert.throws(() => security.validateRequest(event, shell, 'reply-style-preview', { text: '甲', tts: true }), /预览内容无效/);
  const app = renderApp(async action => {
    if (action === 'settings-get') return settings({ hostReplyPrefix: true });
    if (action === 'inspect') return { installed: true, running: true, phase: 'ready', setup: { ownerConfigured: true, qqConfigured: true, modelConfigured: true, memoryConfigured: false, biliEnabled: false } };
    if (action === 'extensions-status') return { memory: { installed: false, version: '' }, memes: { installed: false, version: '' } };
    return {};
  });
  for (let i = 0; i < 10; i += 1) await app.settle();
  assert.match(app.html(), /宿主已配置回复前缀/);
  assert.match(app.html(), /预览会标记实际回退路径/);
});
