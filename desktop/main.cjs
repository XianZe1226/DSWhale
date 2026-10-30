'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, session, dialog, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { RuntimeManager } = require('./lib/runtime.cjs');
const { validateRequest, permittedNavigation, biliURL, consolePopupTarget } = require('./lib/security.cjs');
const { ServiceSupervisor, settingsCommand, portOpen } = require('./lib/services.cjs');

app.setName('DSWhale');
if (!app.isPackaged && process.env.DSWHALE_DESKTOP_TEST_DATA) app.setPath('userData', path.resolve(process.env.DSWHALE_DESKTOP_TEST_DATA));
protocol.registerSchemesAsPrivileged([{ scheme: 'dswhale', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window, panelView, manager, supervisor, quitting = false, shutdownRequested = false, activeAction;
const activeCommands = new Set();
let state = { version: app.getVersion(), platform: { id: '', label: '本机', supported: true, detail: '' }, phase: 'idle', installed: false, running: false, components: [], setup: { ownerConfigured: false, qqConfigured: false, modelConfigured: false, memoryConfigured: false, biliEnabled: false } };
function publish(patch = {}) { state = { ...state, ...patch }; if (window && !window.isDestroyed()) window.webContents.send('dswhale:state', state); return state; }
function closePanel() {
  if (panelView) { if (window && !window.isDestroyed()) window.contentView.removeChildView(panelView); panelView.webContents.close(); panelView = null; }
  publish({ panel: undefined });
}
function resizePanel() { if (panelView && window) { const [width, height] = window.getContentSize(); panelView.setBounds({ x: 256, y: 140, width: Math.max(0, width - 256), height: Math.max(0, height - 140) }); } }
async function refresh() {
  const result = await manager.inspect();
  let setup = state.setup;
  if (result.installed) { try { setup = await settingsCommand(manager, 'status'); } catch {} }
  return publish({ ...result, setup, running: supervisor.running, phase: result.installed ? 'ready' : 'idle' });
}
async function openPanel(panel) {
  if (!supervisor.running) throw new Error('请先启动对话服务');
  let url = await supervisor.dashboard();
  if (panel === 'napcat') {
    if (!await portOpen(6099)) throw new Error('尚未检测到 NapCat，请先按连接指南安装并启动它');
    url = 'http://127.0.0.1:6099/';
  }
  if (panel === 'bilibili') {
    const file = path.join(manager.host, 'data/plugin_data/astrbot_plugin_dswhale/bilibili/control.json');
    let control;
    for (let count = 0; count < 50; count++) {
      try { if ((await fs.stat(file)).mtimeMs >= supervisor.startedAt - 2000) { control = JSON.parse(await fs.readFile(file, 'utf8')); break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    url = biliURL(control);
  }
  closePanel();
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: 'persist:dswhale-consoles' } });
  panelView = view;
  view.webContents.setWindowOpenHandler(details => {
    const target = consolePopupTarget(details.url, url);
    if (target) view.webContents.loadURL(target).catch(() => publish({ error: '页面暂时无法打开，请重试' }));
    return { action: 'deny' };
  });
  const restrict = (event, target) => { if (!permittedNavigation(target, url)) event.preventDefault(); };
  view.webContents.on('will-navigate', restrict); view.webContents.on('will-redirect', restrict);
  window.contentView.addChildView(view); resizePanel();
  publish({ panel });
  try { await view.webContents.loadURL(url); }
  catch { closePanel(); throw new Error('页面尚未就绪，请稍后重试'); }
}
async function backup() {
  if (!state.installed) throw new Error('请先完成环境安装');
  const selected = await dialog.showSaveDialog(window, { title: '保存私人备份（包含账号配置和记忆）', defaultPath: `DSWhale-backup-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: 'ZIP 备份', extensions: ['zip'] }] });
  if (selected.canceled) return { canceled: true };
  const wasRunning = supervisor.running; closePanel(); await supervisor.stop();
  try {
    await snapshotTo(selected.filePath);
    return { saved: true };
  } finally { if (wasRunning && !shutdownRequested) await supervisor.start(); }
}
async function snapshotTo(file) {
  await settingsCommand(manager, 'prepare-backup');
  try { await hostCommand(['backup', '--astrbot-dir', manager.host, file]); }
  finally { await settingsCommand(manager, 'finish-backup').catch(() => {}); }
}
async function hostCommand(args) {
  const environment = await manager.environment();
  if (shutdownRequested) throw new Error('应用正在退出');
  return new Promise((resolve, reject) => {
    const child = spawn(manager.python, ['-m', 'dswhale', ...args], { cwd: manager.host, env: environment, windowsHide: true, stdio: 'ignore' });
    activeCommands.add(child);
    const timer = setTimeout(() => child.kill(), 120000);
    const cleanup = () => { clearTimeout(timer); activeCommands.delete(child); };
    child.once('error', () => { cleanup(); reject(new Error('数据操作未完成，请检查保存目录和备份格式')); });
    child.once('close', code => { cleanup(); code === 0 ? resolve() : reject(new Error('数据操作未完成，原数据或操作前的备份会保留')); });
  });
}
async function restore() {
  if (!state.installed) throw new Error('请先准备运行环境，再导入自己的备份');
  const selected = await dialog.showOpenDialog(window, { title: '导入自己创建的 DSWhale ZIP 备份', properties: ['openFile'], filters: [{ name: 'DSWhale ZIP 备份', extensions: ['zip'] }] });
  if (selected.canceled || !selected.filePaths.length) return { canceled: true };
  closePanel(); await supervisor.stop();
  publish({ phase: 'installing', step: '备份当前数据并导入旧配置', progress: null, error: undefined });
  const folder = path.join(manager.runtime, 'backups');
  await fs.mkdir(folder, { recursive: true });
  await snapshotTo(path.join(folder, `before-import-${Date.now()}.zip`));
  // A failed/cancelled rebuild must not be mistaken for a startable installation.
  await fs.writeFile(path.join(manager.runtime, 'desktop-install.json'), JSON.stringify({ version: 'needs-import-repair' }));
  await hostCommand(['restore', '--astrbot-dir', manager.host, selected.filePaths[0]]);
  await settingsCommand(manager, 'prepare-import');
  await fs.rm(path.join(manager.runtime, '.desktop-auth.pending.json'), { force: true });
  await session.fromPartition('persist:dswhale-consoles').clearStorageData();
  await manager.install();
  await refresh();
  return { restored: true };
}
async function perform(action, payload) {
  if (shutdownRequested) throw new Error('应用正在退出');
  if (action === 'inspect') return refresh();
  if (action === 'home') { closePanel(); return state; }
  if (action === 'settings-get') return settingsCommand(manager, 'read');
  if (activeAction) throw new Error('当前操作尚未完成，请稍候');
  activeAction = action;
  try {
    if (action === 'install') { closePanel(); await supervisor.stop(); await manager.install(); return await refresh(); }
    if (action === 'start') { if (!state.installed) throw new Error('请先准备运行环境'); publish({ step: '正在启动对话服务', progress: null, error: undefined }); await supervisor.start(); return await refresh(); }
    if (action === 'stop') { closePanel(); await supervisor.stop(); return publish({ running: false, error: undefined }); }
    if (action === 'open-panel') { await openPanel(payload.panel); return state; }
    if (action === 'settings-save') {
      closePanel(); const wasRunning = supervisor.running; await supervisor.stop();
      try { return await settingsCommand(manager, 'save', payload); }
      finally { if (wasRunning && !shutdownRequested) await supervisor.start(); if (!shutdownRequested) await refresh(); }
    }
    if (action === 'open-data') { await fs.mkdir(manager.runtime, { recursive: true }); const error = await shell.openPath(manager.runtime); if (error) throw new Error('无法打开数据目录'); return {}; }
    if (action === 'initial-login') {
      const file = path.join(manager.runtime, 'desktop-auth.json');
      let value;
      try {
        value = JSON.parse(await fs.readFile(file, 'utf8'));
        const config = JSON.parse((await fs.readFile(path.join(manager.host, 'data/cmd_config.json'), 'utf8')).replace(/^\uFEFF/, ''));
        if (!config.dashboard?.password_change_required) { await fs.rm(file, { force: true }); value = null; }
      } catch { value = null; }
      if (!value || typeof value.username !== 'string' || typeof value.password !== 'string' || value.password.length < 16 || value.password.length > 256) {
        await dialog.showMessageBox(window, { type: 'info', message: '请使用你已设置的控制台账户与密码', detail: '已有安装沿用原密码。修改密码后，首次安装口令不会继续显示。', buttons: ['知道了'] });
        return {};
      }
      const choice = await dialog.showMessageBox(window, { type: 'info', title: '首次登录控制台', message: `用户名：${value.username}`, detail: `临时口令：${value.password}\n\n首次登录后，请按页面提示设置自己的密码。此口令仅保存在这台电脑，不会上传。`, buttons: ['复制口令', '关闭'], defaultId: 1, cancelId: 1 });
      if (choice.response === 0) clipboard.writeText(value.password);
      return {};
    }
    if (action === 'backup') return await backup();
    if (action === 'restore') return await restore();
  } finally { activeAction = null; }
}
async function createWindow() {
  const source = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '..');
  manager = new RuntimeManager({ source, runtime: path.join(app.getPath('userData'), 'runtime'), onProgress: patch => publish(patch) });
  supervisor = new ServiceSupervisor({ manager, onChange: patch => { if (!patch.running && panelView) closePanel(); publish(patch); } });
  const consoleSession = session.fromPartition('persist:dswhale-consoles');
  consoleSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  consoleSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({ width: 1220, height: 850, minWidth: 980, minHeight: 700, title: 'DSWhale', backgroundColor: '#f5f7fb', icon: path.join(__dirname, 'assets/icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('resize', resizePanel);
  ipcMain.handle('dswhale:action', async (event, action, payload) => {
    validateRequest(event, window.webContents, action, payload);
    try { return await perform(action, payload); }
    catch (error) { const message = typeof error.message === 'string' && !/[\\/]|token=|key=/.test(error.message) ? error.message : '操作未完成，请检查环境和配置后重试'; publish({ error: message, ...(['install', 'restore'].includes(action) ? { phase: 'error', installed: false, progress: null } : {}) }); throw new Error(message); }
  });
  await window.loadURL('dswhale://desktop/index.html');
  refresh().catch(() => publish({ phase: 'error', error: '无法读取运行环境，请重试检测' }));
  window.on('closed', () => { window = null; });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    protocol.handle('dswhale', request => {
      const url = new URL(request.url), name = url.pathname.replace(/^\//, '') || 'index.html';
      if (request.method !== 'GET' || url.hostname !== 'desktop' || !['index.html', 'style.css', 'app.js', 'model.js', 'whale.svg'].includes(name)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(path.join(__dirname, 'ui', name)).toString());
    });
    await createWindow();
  }).catch(() => { dialog.showErrorBox('DSWhale 未能打开', '请重新安装对应平台的桌面安装包；现有数据会保留。'); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (shutdownRequested) return;
    shutdownRequested = true;
    for (const child of activeCommands) child.kill();
    Promise.resolve().then(() => manager?.cancel()).then(() => supervisor?.stop()).finally(() => { quitting = true; app.quit(); });
  });
}
