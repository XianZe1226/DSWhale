const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
    ownerQQ: '123456', platformId: 'qq', onebotPort: 6199, onebotToken: 'local secret', biliEnabled: true, proactiveEnabled: false,
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
