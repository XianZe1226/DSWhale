const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const uiPath = path.join(__dirname, '../ui/model.js');
const load = () => { assert.ok(fs.existsSync(uiPath), 'desktop UI controller exists'); return require(uiPath); };

test('browser mode never invents an installed or running service', () => {
  const { createController } = load();
  const c = createController();
  assert.equal(c.get().mode, 'unavailable');
  assert.equal(c.get().state.running, false);
  assert.equal(c.get().state.installed, false);
});

test('explicit preview is read only and privileged actions cannot be invoked', async () => {
  const { createController } = load();
  const c = createController({ preview: true });
  assert.equal(c.get().mode, 'preview');
  await assert.rejects(c.act('start'), /预览/);
  await assert.rejects(c.act('settings-save', {}), /预览/);
});

test('desktop consumes inspect and subscription state without fabricating readiness', async () => {
  const { createController } = load();
  let listener;
  let removed = false;
  const c = createController({ bridge: {
    invoke: async a => a === 'inspect' ? { installed: false, running: false, phase: 'idle', components: [] } : {},
    onState: cb => { listener = cb; return () => { removed = true; }; },
  }});
  await c.init();
  assert.equal(c.get().state.installed, false);
  listener({ installed: true, running: false, phase: 'ready', setup: { ownerConfigured: true } });
  assert.equal(c.get().state.installed, true);
  assert.equal(c.get().state.running, false);
  assert.equal(c.get().state.setup.ownerConfigured, true);
  c.dispose();
  assert.equal(removed, true);
});

test('actions pass only contracted panel identifiers and preserve error for retry', async () => {
  const { createController } = load();
  const calls = [];
  const c = createController({ bridge: { invoke: async (a, p) => { calls.push([a, p]); if (a === 'install') throw new Error('网络不可用'); return {}; }, onState: () => () => {} }});
  await c.act('open-panel', { panel: 'memory' });
  assert.deepEqual(calls[0], ['open-panel', { panel: 'memory' }]);
  await assert.rejects(c.act('open-panel', { panel: 'https://example.org' }), /面板/);
  await assert.rejects(c.act('run-command', {}), /操作/);
  await assert.rejects(c.act('install'), /网络不可用/);
  assert.equal(c.get().pending, '');
  assert.equal(c.get().error, '网络不可用');
  assert.equal(c.get().retry.action, 'install');
});

test('settings-save serializes supported values and excludes hasModels', async () => {
  const { settingsPayload } = load();
  assert.deepEqual(settingsPayload({ ownerQQ: ' 123456 ', platformId: ' qq ', onebotPort: '6199', onebotToken: 'local secret', biliEnabled: true, proactiveEnabled: false, hasModels: true }), {
    ownerQQ: '123456', platformId: 'qq', onebotPort: 6199, onebotToken: 'local secret', biliEnabled: true, proactiveEnabled: false, signatureEnabled: false, qzoneEnabled: false,
  });
  assert.throws(() => settingsPayload({ onebotPort: '0' }), /端口/);
  assert.throws(() => settingsPayload({ onebotPort: '6199.5' }), /端口/);
});

test('text escaping prevents backend detail from becoming active markup', () => {
  assert.equal(load().escapeHTML('<img src=x onerror="x">&'), '&lt;img src=x onerror=&quot;x&quot;&gt;&amp;');
});

test('shell uses local assets, restrictive CSP and accessible live feedback', () => {
  const htmlPath = path.join(__dirname, '../ui/index.html');
  assert.ok(fs.existsSync(htmlPath), 'shell HTML exists');
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /lang="zh-CN"/);
  assert.doesNotMatch(html, /https?:\/\/.*(?:script|stylesheet)/);
});

test('invalid settings remain visible and no secret is retained for retry', async () => {
  const { createController } = load();
  const c = createController({ bridge: { invoke: async () => { throw new Error('写入失败'); }, onState: () => () => {} } });
  await assert.rejects(c.act('settings-save', { onebotPort: 0, onebotToken: 'secret' }), /端口/);
  assert.match(c.get().error, /端口/);
  assert.equal(c.get().pending, '');
  await assert.rejects(c.act('settings-save', { onebotPort: 6199, onebotToken: 'secret' }), /写入失败/);
  assert.equal(c.get().retry, null);
});

test('duplicate actions are rejected until the actual bridge operation settles', async () => {
  const { createController } = load();
  let finish;
  const c = createController({ bridge: { invoke: () => new Promise(resolve => { finish = resolve; }), onState: () => () => {} } });
  const task = c.act('install');
  assert.equal(c.get().pending, 'install');
  await assert.rejects(c.act('start'), /仍在进行/);
  finish({ phase: 'ready', installed: true, running: false });
  await task;
  assert.equal(c.get().state.installed, true);
  assert.equal(c.get().state.running, false);
  assert.equal(c.get().pending, '');
});

test('initial login opens a native dialog without retaining its result in renderer state', async () => {
  const { createController } = load();
  const calls = [];
  const c = createController({ bridge: { invoke: async action => { calls.push(action); return { displayed: true }; }, onState: () => () => {} } });
  await c.act('initial-login');
  assert.deepEqual(calls, ['initial-login']);
  assert.equal(c.get().notice, '');
  assert.equal(c.get().settings, null);
});

test('existing NapCat console is an allowlisted embedded panel', async () => {
  const { createController } = load();
  let received;
  const c = createController({ bridge: { invoke: async (action, payload) => { received = { action, payload }; return {}; }, onState: () => () => {} } });
  await c.act('open-panel', { panel: 'napcat' });
  assert.deepEqual(received, { action: 'open-panel', payload: { panel: 'napcat' } });
});

test('restore success tells the user to review configuration and keeps the service stopped', async () => {
  const { createController } = load();
  const c = createController({ bridge: { invoke: async action => ({ canceled: false, phase: 'ready', installed: true, running: false }), onState: () => () => {} } });
  await c.act('restore');
  assert.equal(c.get().notice, '备份已导入，请检查配置后启动服务');
  assert.equal(c.get().state.running, false);
});

test('canceled backup and restore dialogs never report success', async () => {
  const { createController } = load();
  const c = createController({ bridge: { invoke: async () => ({ canceled: true }), onState: () => () => {} } });
  await c.act('backup');
  assert.equal(c.get().notice, '');
  await c.act('restore');
  assert.equal(c.get().notice, '');
});

const extensionStatus = () => ({
  memory: { installed: true, version: '1.0.0', latest: null, canUpdate: false, canRollback: false },
  memes: { installed: false, version: null, latest: null, canUpdate: false, canRollback: false },
});

test('social settings default off and survive saving unrelated Bilibili settings', async () => {
  const { createController } = load();
  let saved;
  const c = createController({ bridge: {
    invoke: async (action, payload) => {
      if (action === 'settings-get') return { ownerQQ: '123456', platformId: 'qq', onebotPort: 6199, onebotToken: 'token', biliEnabled: false, proactiveEnabled: true, signatureEnabled: true };
      saved = payload;
      return payload;
    },
    onState: () => () => {},
  }});
  await c.act('settings-get');
  assert.equal(c.get().settings.signatureEnabled, true);
  assert.equal(c.get().settings.qzoneEnabled, false);
  await c.act('settings-save', { ...c.get().settings, biliEnabled: true, qzoneEnabled: true });
  assert.deepEqual(saved, { ownerQQ: '123456', platformId: 'qq', onebotPort: 6199, onebotToken: 'token', biliEnabled: true, proactiveEnabled: true, signatureEnabled: true, qzoneEnabled: true });
});

test('opening the plugin store reads local status without checking or installing', async () => {
  const { createController } = load();
  const calls = [];
  const c = createController({ bridge: {
    invoke: async (action, payload) => { calls.push([action, payload]); return action === 'inspect' ? { installed: true, running: false } : extensionStatus(); },
    onState: () => () => {},
  }});
  await c.init();
  await c.act('extensions-status');
  assert.deepEqual(calls, [['inspect', undefined], ['extensions-status', undefined]]);
  assert.equal(c.get().extensions.memory.version, '1.0.0');
  assert.equal(c.get().extensionChecks.memory, false);
});

test('plugin update requires a successful explicit check and only sends allowlisted IDs', async () => {
  const { createController } = load();
  const calls = [];
  const checked = extensionStatus();
  checked.memory.latest = '1.1.0';
  checked.memory.canUpdate = true;
  const c = createController({ bridge: {
    invoke: async (action, payload) => { calls.push([action, payload]); return checked; },
    onState: () => () => {},
  }});
  await c.act('extensions-status');
  await assert.rejects(c.act('extension-update', { id: 'memory' }), /检查/);
  await assert.rejects(c.act('extension-check', { id: 'other' }), /插件/);
  await c.act('extension-check', { id: 'memory', url: 'https://untrusted.invalid' });
  assert.equal(c.get().extensionChecks.memory, true);
  await c.act('extension-update', { id: 'memory' });
  assert.deepEqual(calls, [['extensions-status', undefined], ['extension-check', { id: 'memory' }], ['extension-update', { id: 'memory' }]]);
  assert.equal(c.get().extensionChecks.memory, false);
  assert.match(c.get().notice, /检查.*启动/);
  assert.equal(c.get().state.running, false);
});

test('optional meme installation uses its checked candidate and preserves memory status', async () => {
  const { createController } = load();
  const checked = extensionStatus();
  checked.memes = { installed: false, version: null, latest: '2.0.0', canUpdate: true, canRollback: false };
  const updated = extensionStatus();
  updated.memes = { installed: true, version: '2.0.0', latest: '2.0.0', canUpdate: false, canRollback: true };
  const c = createController({ bridge: { invoke: async action => action === 'extension-update' ? updated : checked, onState: () => () => {} } });
  await c.act('extension-check', { id: 'memes' });
  await c.act('extension-update', { id: 'memes' });
  assert.equal(c.get().extensions.memes.installed, true);
  assert.equal(c.get().extensions.memory.version, '1.0.0');
  assert.match(c.get().notice, /安装/);
});

test('plugin failures retain retry context without replacing installed versions', async () => {
  const { createController } = load();
  const checked = extensionStatus();
  checked.memory = { installed: true, version: '1.0.0', latest: '1.1.0', canUpdate: true, canRollback: false };
  let fail = false;
  const c = createController({ bridge: { invoke: async () => { if (fail) throw new Error('下载未完成'); return checked; }, onState: () => () => {} } });
  await c.act('extension-check', { id: 'memory' });
  fail = true;
  await assert.rejects(c.act('extension-update', { id: 'memory' }), /下载未完成/);
  assert.equal(c.get().extensions.memory.version, '1.0.0');
  assert.equal(c.get().notice, '');
  assert.equal(c.get().error, '下载未完成');
  assert.deepEqual(c.get().retry, { action: 'extension-update', payload: { id: 'memory' } });
  assert.equal(c.get().pending, '');
  assert.equal(c.get().pendingExtension, '');
});

test('rollback requires a snapshot and success closes the console for review', async () => {
  const { createController } = load();
  let listener;
  const current = extensionStatus();
  const c = createController({ bridge: {
    invoke: async action => action === 'inspect' ? { installed: true, running: true, panel: 'memory' } : current,
    onState: cb => { listener = cb; return () => {}; },
  }});
  await c.init();
  await c.act('extensions-status');
  await assert.rejects(c.act('extension-rollback', { id: 'memory' }), /回退/);
  current.memory.canRollback = true;
  await c.act('extensions-status');
  listener({ running: false, panel: '' });
  await c.act('extension-rollback', { id: 'memory' });
  assert.equal(c.get().state.running, false);
  assert.equal(c.get().state.panel, '');
  assert.match(c.get().notice, /回退.*检查.*启动/);
});

test('canceled or malformed plugin responses never report a successful upgrade', async () => {
  const { createController } = load();
  const checked = extensionStatus();
  checked.memory.canUpdate = true;
  checked.memory.latest = '1.1.0';
  let result = checked;
  const c = createController({ bridge: { invoke: async () => result, onState: () => () => {} } });
  await c.act('extension-check', { id: 'memory' });
  result = { canceled: true };
  await c.act('extension-update', { id: 'memory' });
  assert.doesNotMatch(c.get().notice, /已更新|已安装/);
  assert.equal(c.get().extensions.memory.version, '1.0.0');
  result = {};
  await assert.rejects(c.act('extension-update', { id: 'memory' }), /状态/);
  assert.equal(c.get().notice, '');
  assert.equal(c.get().extensions.memory.version, '1.0.0');
});

function renderApp({ screen = 'intelligence', invoke } = {}) {
  const handlers = {};
  const page = { scrollTop: 0, focus() {} };
  const announcer = { textContent: '' };
  const body = {};
  let markup = '';
  let buttons = [];
  let document;
  const root = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      document.activeElement = body;
      buttons = [...value.matchAll(/<button\b([^>]*)>/g)].map(([, attrs]) => {
        const attr = key => attrs.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];
        return { id: attr('id'), disabled: /\sdisabled(?:\s|$)/.test(attrs), dataset: { action: attr('data-action'), panel: attr('data-panel'), route: attr('data-route'), extension: attr('data-extension') }, focus() { if (!this.disabled) document.activeElement = this; } };
      });
    },
    addEventListener(name, callback) { handlers[name] = callback; },
    querySelectorAll() { return buttons; },
  };
  document = { body, activeElement: body, getElementById(id) { return id === 'app' ? root : id === 'announcer' ? announcer : id === 'main-content' ? page : buttons.find(button => button.id === id); }, querySelector() { return page; } };
  const calls = [];
  const bridge = { invoke: async (action, payload) => { calls.push([action, payload && JSON.parse(JSON.stringify(payload))]); return invoke(action, payload); }, onState: () => () => {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), {
    window: { DSWhaleUI: load(), dswhale: bridge, addEventListener() {} }, document,
    location: { search: `?screen=${screen}` }, URLSearchParams,
  });
  return {
    calls, html: () => root.innerHTML, announcement: () => announcer.textContent,
    focused: () => document.activeElement?.id,
    focus: (action, id) => buttons.find(button => button.dataset.action === action && button.dataset.extension === id)?.focus(),
    settle: () => new Promise(resolve => setImmediate(resolve)),
    click: (action, id, operation) => handlers.click({ target: { closest() { return this; }, dataset: { action, extension: id, operation }, hasAttribute() { return false; } } }),
    change: (id, checked) => handlers.change({ target: { id, type: 'checkbox', checked, matches() { return true; } } }),
  };
}

test('plugin cards read local status, escape version text and wait for an explicit check', async () => {
  const status = extensionStatus();
  status.memory.version = '<img src=x>';
  const app = renderApp({ invoke: async action => action === 'inspect' ? { installed: true, running: true } : status });
  await app.settle();
  assert.deepEqual(app.calls, [['inspect', undefined], ['extensions-status', undefined]]);
  assert.match(app.html(), /LivingMemory/);
  assert.match(app.html(), /表情包管理器/);
  assert.match(app.html(), /&lt;img src=x&gt;/);
  assert.match(app.html(), /当前版本/);
  assert.match(app.html(), /最新版本/);
  assert.doesNotMatch(app.html(), /data-action="extension-review"/);
});

test('checked plugin installs directly while rollback can be reviewed and canceled', async () => {
  const status = extensionStatus();
  status.memes = { installed: false, version: null, latest: '2.0.0', canUpdate: true, canRollback: true };
  const app = renderApp({ invoke: async action => action === 'inspect' ? { installed: true, running: true } : status });
  await app.settle();
  await app.click('extension-check', 'memes');
  assert.match(app.html(), /停止服务/);
  assert.match(app.html(), /备份/);
  await app.click('extension-update', 'memes');
  assert.deepEqual(app.calls.at(-1), ['extension-update', { id: 'memes' }]);
  await app.click('extension-review', 'memes', 'extension-rollback');
  assert.match(app.html(), /确认回退/);
  await app.click('extension-cancel', 'memes');
  assert.match(app.html(), /已取消/);
  assert.equal(app.calls.filter(([action]) => action === 'extension-rollback').length, 0);
  await app.click('extension-review', 'memes', 'extension-rollback');
  assert.match(app.html(), /确认回退/);
  await app.click('extension-confirm', 'memes');
  assert.deepEqual(app.calls.at(-1), ['extension-rollback', { id: 'memes' }]);
  assert.match(app.announcement(), /回退.*检查.*启动/);
});

test('connection controls save owner-only social choices alongside existing connection fields', async () => {
  const initial = { ownerQQ: '123456', platformId: 'qq', onebotPort: 6199, onebotToken: 'token', biliEnabled: true, proactiveEnabled: false };
  const app = renderApp({ screen: 'connect', invoke: async (action, payload) => action === 'inspect' ? { installed: true } : action === 'settings-get' ? initial : payload });
  await app.settle();
  assert.match(app.html(), /id="signatureEnabled"[^>]*type="checkbox"/);
  assert.doesNotMatch(app.html(), /id="signatureEnabled"[^>]* checked/);
  assert.doesNotMatch(app.html(), /id="qzoneEnabled"[^>]* checked/);
  assert.match(app.html(), /仅.*绑定.*主人/);
  assert.match(app.html(), /草稿.*确认/);
  app.change('signatureEnabled', true);
  app.change('qzoneEnabled', true);
  await app.click('save-settings');
  assert.deepEqual(app.calls.at(-1), ['settings-save', { ...initial, signatureEnabled: true, qzoneEnabled: true }]);
});

test('a failed repeated check disables an old update candidate until checking succeeds', async () => {
  const { createController } = load();
  const status = extensionStatus();
  status.memory.latest = '1.1.0';
  status.memory.canUpdate = true;
  let fail = false;
  const c = createController({ bridge: { invoke: async () => { if (fail) throw new Error('检查失败'); return status; }, onState: () => () => {} } });
  await c.act('extension-check', { id: 'memory' });
  fail = true;
  await assert.rejects(c.act('extension-check', { id: 'memory' }), /检查失败/);
  await assert.rejects(c.act('extension-update', { id: 'memory' }), /检查/);
  assert.equal(c.get().extensions.memory.version, '1.0.0');
  assert.equal(c.get().extensionChecks.memory, false);
});

test('restoring a backup invalidates plugin versions and checked candidates', async () => {
  const { createController } = load();
  const status = extensionStatus();
  status.memory.canUpdate = true;
  const c = createController({ bridge: { invoke: async action => action === 'restore' ? { canceled: false, running: false } : status, onState: () => () => {} } });
  await c.act('extension-check', { id: 'memory' });
  await c.act('restore');
  assert.equal(c.get().extensions, null);
  assert.equal(c.get().extensionChecks.memory, false);
  assert.equal(c.get().extensionChecks.memes, false);
});

test('canceling rollback announces cancellation even after a successful check', async () => {
  const status = extensionStatus();
  status.memory.canRollback = true;
  const app = renderApp({ invoke: async action => action === 'inspect' ? { installed: true, running: false } : status });
  await app.settle();
  await app.click('extension-check', 'memory');
  await app.click('extension-review', 'memory', 'extension-rollback');
  await app.click('extension-cancel', 'memory');
  assert.match(app.announcement(), /已取消/);
});

test('keyboard focus returns to the plugin check button after its update button disappears', async () => {
  const status = extensionStatus();
  status.memory.latest = '1.1.0';
  status.memory.canUpdate = true;
  const updated = extensionStatus();
  updated.memory = { installed: true, version: '1.1.0', latest: '1.1.0', canUpdate: false, canRollback: true };
  const app = renderApp({ invoke: async action => action === 'inspect' ? { installed: true, running: false } : action === 'extension-update' ? updated : status });
  await app.settle();
  app.focus('extension-check', 'memory');
  await app.click('extension-check', 'memory');
  assert.equal(app.focused(), 'extension-check-memory');
  app.focus('extension-update', 'memory');
  await app.click('extension-update', 'memory');
  assert.equal(app.focused(), 'extension-check-memory');
});

test('a failed local status read offers retry without leaving the cards in loading state', async () => {
  let fail = true;
  const app = renderApp({ invoke: async action => {
    if (action === 'inspect') return { installed: true, running: false };
    if (fail) throw new Error('本机状态读取失败');
    return extensionStatus();
  }});
  await app.settle();
  assert.match(app.html(), /本机状态读取失败/);
  assert.match(app.html(), /重试读取/);
  assert.doesNotMatch(app.html(), /<dd>正在读取<\/dd>/);
  fail = false;
  await app.click('extensions-status');
  assert.match(app.html(), /1\.0\.0/);
  assert.doesNotMatch(app.html(), /本机状态读取失败/);
});
