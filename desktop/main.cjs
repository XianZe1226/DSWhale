'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, session, dialog, shell, clipboard, Tray, Menu, nativeImage, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL, URL } = require('node:url');
const { spawn } = require('node:child_process');
const { RuntimeManager, SetupError } = require('./lib/runtime.cjs');
const { validateRequest, permittedNavigation, biliURL, consolePopupTarget } = require('./lib/security.cjs');
const { ServiceSupervisor, settingsCommand, portOpen, readQQConnectionHealth } = require('./lib/services.cjs');
const { ExtensionRunner, runExtensionAction } = require('./lib/extensions.cjs');
const { Operations } = require('./lib/operations.cjs');
const { Workspace, WORKSPACE_ACTIONS } = require('./lib/workspace.cjs');
const { AppUpdater, UpdateError } = require('./lib/app-updater.cjs');
const { UpdateScheduler } = require('./lib/update-scheduler.cjs');
const { NapCatManager, NapCatError } = require('./lib/napcat.cjs');
const { Preferences, PreferencesError } = require('./lib/preferences.cjs');
const { DiagnosticsError } = require('./lib/diagnostics.cjs');
const { readNetworkConfig, createElectronTransport, systemProxyURL, NetworkError } = require('./lib/network.cjs');
class UserActionError extends Error {}

app.setName('DSWhale');
if (!app.isPackaged && process.env.DSWHALE_DESKTOP_TEST_DATA) app.setPath('userData', path.resolve(process.env.DSWHALE_DESKTOP_TEST_DATA));
protocol.registerSchemesAsPrivileged([{ scheme: 'dswhale', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let operations, appUpdater, updateScheduler, napcat, workspace, preferenceStore, tray, preferences = {tray:false,startAtLogin:false,resumeAfterWake:false}, installerHandedOff = false;
let window, panelView, manager, supervisor, extensions, quitting = false, shutdownRequested = false, activeAction, startupInProgress = false, startupOperation, externalConnectionMonitor;
const activeCommands = new Set();
let state = { version: app.getVersion(), platform: { id: '', label: '本机', supported: true, detail: '' }, phase: 'idle', installed: false, running: false, components: [], setup: { ownerConfigured: false, qqConfigured: false, modelConfigured: false, memoryConfigured: false, biliEnabled: false } };
function publish(patch = {}) { state = { ...state, ...patch }; if (window && !window.isDestroyed()) window.webContents.send('dswhale:state', state); return state; }
function qqMode() { return state.qqConnectionMode || state.setup?.qqConnectionMode || 'napcat'; }
async function readBoundQQStatus() {
  if (qqMode() !== 'official') return napcat.status();
  return {mode:'official',supported:false,externalOnly:true,running:false,loginState:'official',protocolConnected:await readQQConnectionHealth({host:manager.host,running:supervisor.running,startedAt:supervisor.startedAt})};
}
function connectionStage(qq) {
  if (qqMode() === 'official') return supervisor?.running ? qq?.protocolConnected === true ? 'ready' : 'official-connecting' : 'stopped';
  if (!supervisor?.running) return state.error ? 'failed' : 'stopped';
  if (qq.configured && !qq.externalOnly && !qq.running) return 'qq-stopped';
  if (qq.protocolConnected === true && (qq.externalOnly || !['scan-required', 'offline'].includes(qq.loginState))) return 'ready';
  if (qq.externalOnly) return 'external';
  if (!qq.configured) return 'setup-qq';
  if (qq.loginState === 'online') return qq.connectionConfigured ? 'awaiting-link' : 'apply-connection';
  return ['resuming', 'connecting', 'confirming', 'scan-required', 'offline'].includes(qq.loginState) ? qq.loginState : 'unknown';
}
function publishQQ(patch, completeStartup = false) {
  if (patch.phase === 'installing') return publish({ step: patch.step, progress: patch.progress });
  return publish({ workspace: { ...state.workspace, napcat: patch },
    ...(!startupInProgress || completeStartup ? { startup: { stage: connectionStage(patch) } } : {}) });
}
function closePanel() {
  if (panelView) { if (window && !window.isDestroyed()) window.contentView.removeChildView(panelView); panelView.webContents.close(); panelView = null; }
  publish({ panel: undefined });
}
function resizePanel() { if (panelView && window) { const [width, height] = window.getContentSize(); panelView.setBounds({ x: 256, y: 140, width: Math.max(0, width - 256), height: Math.max(0, height - 140) }); } }
async function refresh() {
  if (!supervisor.running && !extensions.operation) {
    let pending = false;
    try { pending = (await fs.readdir(path.join(manager.host, '.dswhale-extensions'))).some(name => name.endsWith('-transaction.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pending) await extensions.run('status');
  }
  const result = await manager.inspect();
  let setup = state.setup;
  if (result.installed) { try { setup = await settingsCommand(manager, 'status'); } catch {} }
  return publish({ ...result, setup, qqConnectionMode: setup?.qqConnectionMode || 'napcat', running: supervisor.running, phase: result.installed ? 'ready' : 'idle' });
}
async function openPanel(panel) {
  if (!supervisor.running && panel !== 'napcat') throw new UserActionError('请先启动对话服务');
  let url = panel === 'napcat' ? null : await supervisor.dashboard();
  if (panel === 'napcat') {
    const managed=await napcat.status();
    if(managed.configured&&!managed.externalOnly){if(!napcat.running)throw new UserActionError('请先启动独立 QQ 组件');url=(await napcat.loginInfo()).url;}
    else if (!await portOpen(6099)) throw new UserActionError('尚未检测到 NapCat，请先按连接指南安装并启动它');
    else url = 'http://127.0.0.1:6099/';
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
  if (!['napcat', 'bilibili'].includes(panel)) {
    const entry = new URL(url);
    // The managed core handles this identity with cache-only invalidation;
    // cookies/storage stay intact. Match the pinned AstrBot runtime matrix.
    entry.searchParams.set('astrbot_bundle', `${app.getVersion()}-astrbot-4.29.3`);
    if (panel === 'models') entry.hash = '/providers';
    if (panel === 'qq') entry.hash = '/platforms';
    url = entry.toString();
  }
  closePanel();
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: panel==='napcat'?'persist:dswhale-napcat-console':panel==='bilibili'?'persist:dswhale-bili-console':'persist:dswhale-consoles' } });
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
  catch { closePanel(); throw new UserActionError('页面尚未就绪，请稍后重试'); }
}
async function backup() {
  if (!state.installed) throw new UserActionError('请先完成环境安装');
  const selected = await dialog.showSaveDialog(window, { title: '保存私人备份（包含账号配置和记忆）', defaultPath: `DSWhale-backup-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: 'ZIP 备份', extensions: ['zip'] }] });
  if (selected.canceled) return { canceled: true };
  const wasRunning = supervisor.running; await stopAll();
  try {
    await snapshotTo(selected.filePath);
    return { saved: true };
  } finally { if (wasRunning && !shutdownRequested) await startAll(); }
}
async function snapshotTo(file) {
  await settingsCommand(manager, 'prepare-backup');
  try { await hostCommand(['backup', '--astrbot-dir', manager.host, file]); }
  finally { await settingsCommand(manager, 'finish-backup').catch(() => {}); }
}
async function hostCommand(args) {
  const environment = await manager.environment();
  if (shutdownRequested) throw new UserActionError('应用正在退出');
  return new Promise((resolve, reject) => {
    const child = spawn(manager.python, ['-m', 'dswhale', ...args], { cwd: manager.host, env: environment, windowsHide: true, stdio: 'ignore' });
    activeCommands.add(child);
    const timer = setTimeout(() => child.kill(), 120000);
    const cleanup = () => { clearTimeout(timer); activeCommands.delete(child); };
    child.once('error', () => { cleanup(); reject(new Error('数据操作未完成，请检查保存目录和备份格式')); });
    child.once('close', code => { cleanup(); code === 0 ? resolve() : reject(new Error('数据操作未完成，原数据或操作前的备份会保留')); });
  });
}
async function stopAll() { closePanel(); await napcat?.stop(); await supervisor.stop(); }
// QQ login has its own lifetime. A backend restart must not become a new QQ login.
async function stopConversation() { closePanel(); await supervisor.stop(); publish({ running: false, startup: { stage: 'stopped' } }); }
function startAll() {
  if (startupOperation) return startupOperation;
  const pending = startServices().finally(() => { if (startupOperation === pending) startupOperation = null; });
  startupOperation = pending; return pending;
}
async function startServices() {
  const stillOpen = () => { if (shutdownRequested) throw new UserActionError('应用正在退出，启动已取消'); };
  stillOpen();
  if (!state.installed) throw new UserActionError('请先准备运行环境');
  const recovery = appUpdater ? (await appUpdater.status()).recovery : null;
  if (recovery?.servicesMustRemainStopped) throw new UserActionError('更新或回退尚未完成，请先在应用设置中修复并体检');
  await extensions.run('status');
  if (shutdownRequested) throw new UserActionError('应用正在退出');
  const connectionSettings = await settingsCommand(manager, 'read'); stillOpen();
  const official = connectionSettings.qqConnectionMode === 'official';
  publish({qqConnectionMode:official?'official':'napcat'});
  const reuseQQ = napcat?.running;
  startupInProgress = true;
  publish({ startup: { stage: supervisor.running ? 'checking-qq' : 'starting-conversation' }, error: undefined });
  try {
    await supervisor.start();
    stillOpen();
    publish({ running: true, startup: { stage: 'checking-qq' } });
    if (official) {
      publishQQ(await readBoundQQStatus(), true); stillOpen();
    } else if (napcat) {
      const configured = await napcat.status();
      stillOpen();
      if (configured.canStart) {
        publish({ startup: { stage: napcat.running ? 'reusing-qq' : 'starting-qq' } });
        if (!napcat.running) await napcat.configure();
        stillOpen();
        publishQQ(await napcat.start(), true);
        stillOpen();
      } else publishQQ(configured, true);
    }
    return await refresh();
  } catch (error) {
    if (!official && !reuseQQ) await napcat?.stop();
    await supervisor.stop();
    publish({ running: false, startup: { stage: 'failed' } });
    throw error;
  } finally { startupInProgress = false; }
}
async function restoreFile(file, {rebuild = true} = {}) {
  if (!state.installed) throw new UserActionError('请先准备运行环境，再导入自己的备份');
  await stopAll();
  publish({phase:'installing',step:'备份当前数据并恢复所选配置',progress:null,error:undefined});
  await operations.snapshot({reason:'import'});
  await fs.writeFile(path.join(manager.runtime,'desktop-install.json'),JSON.stringify({version:'needs-import-repair'}));
  await hostCommand(['restore','--astrbot-dir',manager.host,file]);
  await settingsCommand(manager,'prepare-import');
  await fs.rm(path.join(manager.runtime,'.desktop-auth.pending.json'),{force:true});
  await session.fromPartition('persist:dswhale-consoles').clearStorageData();
  if (rebuild) { await manager.install();const restored=await settingsCommand(manager,'read');if(shutdownRequested)throw new UserActionError('应用正在退出');if(restored.qqConnectionMode!=='official'){const nc=await napcat.status();if(nc.configured&&!nc.externalOnly)await napcat.configure();} await refresh(); }
  return {restored:true};
}
async function restore() {
  const selected = await dialog.showOpenDialog(window,{title:'导入自己创建的 DSWhale ZIP 备份',properties:['openFile'],filters:[{name:'DSWhale ZIP 备份',extensions:['zip']}]});
  if (selected.canceled || !selected.filePaths.length) return {canceled:true};
  // A backup is a trusted artefact: it replaces data/ and any plugin code inside
  // runs the next time services start. Make that an explicit confirmation.
  const confirm = await dialog.showMessageBox(window,{type:'warning',title:'确认导入备份',message:'备份会替换当前数据，其中的插件代码会在下次启动服务时加载',detail:'请只导入你本人创建的 DSWhale 备份；来源不明的备份可能包含会运行的插件代码。',buttons:['继续导入','取消'],defaultId:1,cancelId:1});
  if (confirm.response !== 0) return {canceled:true};
  return restoreFile(selected.filePaths[0]);
}
function showWindow() { if (window && !window.isDestroyed()) { window.show(); if(window.isMinimized())window.restore();window.focus(); } }
function applyPreferences(value) {
  preferences=value;
  if(!value.tray) { tray?.destroy();tray=null;return; }
  if(!tray) { const icon=nativeImage.createFromPath(path.join(__dirname,'assets/icon.png')).resize({width:process.platform==='darwin'?18:20,height:process.platform==='darwin'?18:20}); if(process.platform==='darwin')icon.setTemplateImage(true); tray=new Tray(icon);tray.setToolTip('DSWhale');tray.on('click',showWindow); }
  tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 DSWhale',click:showWindow},{label:'启动对话与 QQ',click:()=>perform('start').catch(()=>publish({error:'启动未完成，请打开窗口查看体检结果'}))},{label:'停止对话服务',click:()=>perform('stop').catch(()=>{})},{type:'separator'},{label:'退出',click:()=>app.quit()}]));
}
async function finishPendingUpdate() {
  const status=await appUpdater.status();
  if(!['awaiting-verification','awaiting-rollback-verification'].includes(status.phase))return;
  if(activeAction||shutdownRequested)return;
  activeAction='install';
  try { await manager.install();await refresh();const health=await operations.health();await appUpdater.completeVerification({healthy:health.summary.requiredFailures===0});publish({error:health.summary.requiredFailures?'[UPD-001] 更新后的体检未通过，请在应用设置查看恢复选项':undefined}); }
  catch { await appUpdater.completeVerification({healthy:false}).catch(()=>{});publish({phase:'error',error:'[UPD-001] 更新准备未完成，备份已保留，请重试修复或回退'}); }
  finally {activeAction=null;}
}
async function perform(action, payload) {
  if (shutdownRequested) throw new UserActionError('应用正在退出');
  if (action === 'inspect') return activeAction ? state : refresh();
  if (action === 'home') { closePanel(); return state; }
  if (action === 'settings-get') return settingsCommand(manager, 'read');
  if (activeAction) throw new UserActionError('当前操作尚未完成，请稍候');
  activeAction = action;
  try {
    // Metadata checks never claim activeAction. Conflicting updater mutations
    // cancel and settle that check while retaining the normal action fence.
    if (action.startsWith('app-update-') || action === 'install') await updateScheduler?.cancel();
    if (WORKSPACE_ACTIONS.has(action)) { const result = await workspace.perform(action,payload); if(result?.napcat)publishQQ(result.napcat); return result; }
    if (action === 'extensions-status' || action.startsWith('extension-')) {
      if (!state.installed) throw new UserActionError('请先准备运行环境');
      return await runExtensionAction({ runner: extensions, supervisor, closePanel, publish, refresh, isClosing: () => shutdownRequested }, action === 'extensions-status' ? 'status' : action.slice(10), payload?.id);
    }
    if (action === 'install') { const prior=appUpdater?await appUpdater.status():null; if(prior?.recovery?.servicesMustRemainStopped)await stopAll();else await stopConversation(); await manager.install(); await refresh(); const pending=appUpdater?await appUpdater.status():null; if(pending?.recovery?.requiresHealthVerification){const health=await operations.health();await appUpdater.completeVerification({healthy:health.summary.requiredFailures===0});} return state; }
    if (action === 'start') return await startAll();
    if (action === 'stop') { await stopConversation();return publish({running:false,error:undefined}); }
    if (action === 'open-panel') { await openPanel(payload.panel); return state; }
    if (action === 'settings-save') {
      const before = await settingsCommand(manager, 'read');
      const connectionChanged = ['onebotPort', 'onebotToken'].some(key => Object.hasOwn(payload, key) && payload[key] !== before[key]);
      const wasRunning = supervisor.running; await stopConversation();
      let saved = false;
      try { const result = await settingsCommand(manager, 'save', payload); saved = true; return result; }
      finally { const mode=payload.qqConnectionMode||before.qqConnectionMode||'napcat';if(saved && mode==='official' && before.qqConnectionMode!=='official' && !shutdownRequested)await napcat?.stop();if(saved && mode!=='official' && connectionChanged && napcat?.running && !shutdownRequested)await napcat.wire(); if (wasRunning && !shutdownRequested) await startAll(); if (!shutdownRequested) await refresh(); }
    }
    if (action === 'open-data') { await fs.mkdir(manager.runtime, { recursive: true }); const error = await shell.openPath(manager.runtime); if (error) throw new UserActionError('无法打开数据目录'); return {}; }
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
  } finally {
    // publish() sends the whole main state. Keep its updater snapshot current so
    // later service events cannot replace the renderer's newer manual result.
    if (action.startsWith('app-update-') || action === 'install') {
      try { publish({appUpdate:await appUpdater.status()}); } catch {}
    }
    activeAction = null;
  }
}
async function reportActionError(error, action) {
  const safe=error instanceof UserActionError||error instanceof UpdateError||error instanceof NapCatError||error instanceof NetworkError||error instanceof SetupError||error instanceof PreferencesError||error instanceof DiagnosticsError||error?.code==='PORT-001';
  const code=error instanceof UpdateError?'UPD-001':error instanceof NapCatError?'NAP-001':error instanceof NetworkError?'NET-001':error?.code==='PORT-001'?'PORT-001':'APP-001';
  const message=`[${code}] ${safe?error.message:'操作未完成，请重新检查状态或导出诊断'}`;
  // Reporting must never replace the user-facing action error: the event log or
  // the operations object may be unavailable during an early failure.
  try { await operations?.events?.write({component:error instanceof UpdateError?'update':'app',action:['start','stop','install','restore'].includes(action)?action:'check',code}); } catch {}
  publish({error:message,...(['install','restore'].includes(action)?{phase:'error',installed:false,progress:null}:{})});
  return message;
}
async function createWindow() {
  const source = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '..');
  const downloadSession=session.fromPartition('persist:dswhale-downloads');
  const transport=createElectronTransport(downloadSession);
  manager = new RuntimeManager({ source, runtime: path.join(app.getPath('userData'), 'runtime'), fetch:transport,proxyResolver:()=>systemProxyURL(downloadSession),onProgress: patch => publish(patch) });
  extensions = new ExtensionRunner(manager);
  supervisor = new ServiceSupervisor({ manager, onChange: patch => { if (!patch.running && panelView) closePanel(); publish(patch); } });
  preferenceStore=new Preferences({userData:app.getPath('userData'),app});
  napcat=new NapCatManager({manager,userData:app.getPath('userData'),fetch:transport,onChange:publishQQ,
    getProtocolState:()=>readQQConnectionHealth({host:manager.host,running:supervisor.running,
      startedAt:Math.max(supervisor.startedAt,napcat?.running ? napcat.startedAt || 0 : 0)})});
  operations=new Operations({manager,supervisor,snapshotTo});
  const distro={};if(process.platform==='linux'){try{for(const line of(await fs.readFile('/etc/os-release','utf8')).split('\n')){const m=line.match(/^(ID|VERSION_ID)=["']?([^"']+)["']?$/);if(m)distro[m[1]]=m[2];}}catch{}}
  appUpdater=new AppUpdater({runtime:manager.runtime,currentVersion:app.getVersion(),distro,
    fetch:async(url,options)=>transport(url,{...options,network:await readNetworkConfig(manager.runtime)}),
    download:async(asset,file,options)=>require('./lib/runtime.cjs').downloadVerified(asset,file,{...options,fetch:transport,network:await readNetworkConfig(manager.runtime)}),
    stopServices:stopAll,snapshot:({reason})=>operations.snapshot({reason:reason.includes('rollback')?'rollback':'update'}),
    restoreSnapshot:async(id)=>restoreFile(await operations.backupFile(id),{rebuild:false}),
    launchInstaller:async({file,signal})=>{if(process.platform==='win32'){if(!app.isPackaged)throw new UserActionError('开发环境请使用官方安装包');await require('./lib/installer.cjs').launchWindowsUpdate({file,exePath:app.getPath('exe'),signal});}else{const error=await shell.openPath(file);if(error)throw new UserActionError('安装程序未打开，请重试；备份已保留');}installerHandedOff=true;},
    onProgress:patch=>publish({appUpdateProgress:patch.progress})});
  workspace=new Workspace({manager,operations,appUpdater,napcat,preferences:preferenceStore,
    getQQStatus:readBoundQQStatus,getQQMode:qqMode,isInstalled:()=>state.installed,isClosing:()=>shutdownRequested,stopServices:stopAll,getState:()=>state,restoreFile,trash:file=>shell.trashItem(file),applyPreferences,
    chooseDiagnostic:async()=>{const preview=await dialog.showMessageBox(window,{type:'info',message:'导出诊断元信息',detail:'包含 health.json、events.json、versions.json、README.txt。只记录版本、状态和事件代码，不包含账号、路径、聊天、记忆、人格、密钥或原始日志。',buttons:['继续保存','取消'],defaultId:1,cancelId:1});if(preview.response!==0)return null;const choice=await dialog.showSaveDialog(window,{defaultPath:'DSWhale-diagnostics.zip',filters:[{name:'诊断 ZIP',extensions:['zip']}]});return choice.canceled?null:choice.filePath;},
    chooseNapCat:async()=>{const choice=await dialog.showOpenDialog(window,{title:'选择官方独立 NapCat 包的解压目录',properties:['openDirectory']});return choice.canceled?null:choice.filePaths[0];},
    openGuide:()=>shell.openExternal('https://napneko.github.io/guide/boot/Shell'),
    showLoginInfo:async(info)=>{const choice=await dialog.showMessageBox(window,{type:'info',title:'独立 QQ 组件登录口令',message:'口令仅用于本机 NapCat 管理页面',detail:info.token,buttons:['复制口令','关闭'],defaultId:1,cancelId:1});if(choice.response===0)clipboard.writeText(info.token);},
    confirmUpdate:async version=>{const answer=await dialog.showMessageBox(window,{type:'info',title:'覆盖安装更新',message:`DSWhale ${version} 已准备好`,detail:process.platform==='win32'?'将备份数据、关闭应用并覆盖安装到当前目录，无需重新选择位置。原有配置、聊天、记忆和 QQ 设备数据会保留。':'将备份数据并打开系统安装程序。请按系统提示覆盖原应用，个人数据会保留。',buttons:['覆盖安装','稍后'],defaultId:0,cancelId:1});return answer.response===0;},
    afterInstaller:async()=>{if(installerHandedOff)setTimeout(()=>app.quit(),500);}});
  for(const name of ['persist:dswhale-consoles','persist:dswhale-napcat-console','persist:dswhale-bili-console']){const consoleSession=session.fromPartition(name);consoleSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));consoleSession.setPermissionCheckHandler(()=>false);}
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
    catch (error) { throw new UserActionError(await reportActionError(error, action)); }
  });
  await window.loadURL('dswhale://desktop/index.html');
  applyPreferences(await preferenceStore.read());
  const openedAtLogin=process.platform==='darwin'&&app.getLoginItemSettings().wasOpenedAtLogin;
  if(preferences.tray&&(process.argv.includes('--hidden')||openedAtLogin))window.hide();
  window.on('close',event=>{if(preferences.tray&&!shutdownRequested&&!quitting){event.preventDefault();window.hide();}});
  await refresh().catch(()=>publish({phase:'error',error:'无法读取运行环境，请重试检测'}));
  await finishPendingUpdate();
  updateScheduler=new UpdateScheduler({
    shouldRun:()=>!activeAction&&!shutdownRequested,
    check:()=>appUpdater.check({automatic:true}),
    cancelCheck:()=>appUpdater.cancel(),
    onResult:appUpdate=>publish({appUpdate}),
  });
  updateScheduler.start();
  externalConnectionMonitor = setInterval(() => {
    if (shutdownRequested || activeAction || (qqMode()!=='official' && napcat.running) || !supervisor.running) return;
    readBoundQQStatus().then(publishQQ).catch(() => {});
  }, 5000);
  externalConnectionMonitor.unref?.();
  let wasRunning=false;powerMonitor.on('suspend',()=>{wasRunning=supervisor.running;});powerMonitor.on('resume',()=>{if(shutdownRequested)return;updateScheduler?.resume();if(preferences.resumeAfterWake&&wasRunning&&!supervisor.running&&!activeAction)perform('start').catch(()=>publish({error:'系统已唤醒，请重新检查连接'}));else publish({notice:'系统已唤醒，可重新检查连接状态'});});
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
    clearInterval(externalConnectionMonitor);
    updateScheduler?.stop();
    for (const child of activeCommands) child.kill();
    Promise.resolve().then(async()=>{for(const close of [()=>appUpdater?.cancel(),()=>operations?.close(),()=>extensions?.close(),()=>manager?.cancel(),()=>napcat?.stop(),()=>supervisor?.stop(),()=>startupOperation?.catch(()=>{}),()=>stopAll()]){try{await close();}catch{}}}).finally(()=>{quitting=true;app.quit();});
  });
}
