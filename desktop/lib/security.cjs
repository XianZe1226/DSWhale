'use strict';
const ACTIONS = new Set(['inspect', 'install', 'start', 'stop', 'open-panel', 'home', 'settings-get', 'settings-save', 'open-data', 'backup', 'restore', 'initial-login', 'extensions-status', 'extension-check', 'extension-update', 'extension-rollback']);
const PANELS = new Set(['astrbot', 'models', 'memory', 'bilibili', 'qq', 'napcat']);
const WORKSPACE_ACTIONS = new Set(['workspace-status','health-check','backup-list','backup-restore','backup-delete','diagnostics-export','app-update-check','app-update-download','app-update-install','app-update-rollback','napcat-install','napcat-configure','napcat-wire','napcat-stop','napcat-guide','napcat-login-code','preferences-save']);
for (const action of WORKSPACE_ACTIONS) ACTIONS.add(action);

function validateRequest(event, shell, action, payload) {
  if (!shell || event.sender !== shell || event.senderFrame !== shell.mainFrame || !ACTIONS.has(action)) throw new Error('不允许此操作');
  if (action === 'open-panel' && (!payload || !PANELS.has(payload.panel))) throw new Error('页面无效');
  if (action === 'settings-save' && (!payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 16384)) throw new Error('设置无效');
  if (action.startsWith('extension-') && (!payload || Object.keys(payload).length !== 1 || !['memory', 'memes'].includes(payload.id))) throw new Error('插件无效');
  if (['backup-restore','backup-delete'].includes(action) && (!payload || Object.keys(payload).length !== 1 || typeof payload.id !== 'string' || !/^before-(import|upgrade|update|rollback|restore)-[a-zA-Z0-9._-]{1,120}\.zip$/.test(payload.id))) throw new Error('备份无效');
  if (action === 'app-update-check' && (!payload || Object.keys(payload).length !== 1 || !['alpha','stable'].includes(payload.channel))) throw new Error('更新通道无效');
  if (action === 'app-update-rollback' && (!payload || Object.keys(payload).sort().join(',') !== 'confirmDataRestore,restoreData' || typeof payload.restoreData !== 'boolean' || typeof payload.confirmDataRestore !== 'boolean')) throw new Error('回退选项无效');
  if (action === 'preferences-save' && (!payload || Object.keys(payload).sort().join(',') !== 'resumeAfterWake,startAtLogin,tray' || Object.values(payload).some(value => typeof value !== 'boolean'))) throw new Error('应用设置无效');
  if (WORKSPACE_ACTIONS.has(action) && !['backup-restore','backup-delete','app-update-check','app-update-rollback','preferences-save'].includes(action) && payload != null) throw new Error('此操作不接受额外参数');
}

function permittedNavigation(target, base) {
  try {
    const url = new URL(target), origin = new URL(base);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && url.origin === origin.origin;
  } catch { return false; }
}

function biliURL(control) {
  if (!Number.isInteger(control?.port) || control.port < 1 || control.port > 65535 || typeof control.token !== 'string' || !/^[A-Za-z0-9_-]{12,256}$/.test(control.token)) throw new Error('B站服务尚未就绪，请先启用并启动机器人');
  return `http://127.0.0.1:${control.port}/#token=${encodeURIComponent(control.token)}`;
}

function consolePopupTarget(target, base) { return permittedNavigation(target, base) ? target : null; }
module.exports = { validateRequest, permittedNavigation, biliURL, consolePopupTarget };
