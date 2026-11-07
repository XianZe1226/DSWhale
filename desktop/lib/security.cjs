'use strict';
const ACTIONS = new Set(['inspect', 'install', 'start', 'stop', 'open-panel', 'home', 'settings-get', 'settings-save', 'open-data', 'backup', 'restore', 'initial-login', 'extensions-status', 'extension-check', 'extension-update', 'extension-rollback', 'connections-status', 'connection-change', 'connection-confirm', 'settings-history', 'settings-restore-field', 'reply-style-preview']);
const PANELS = new Set(['astrbot', 'models', 'memory', 'bilibili', 'qq', 'napcat']);
const WORKSPACE_ACTIONS = new Set(['workspace-status','health-check','backup-list','backup-restore','backup-delete','diagnostics-export','app-update-check','app-update-start','app-update-download','app-update-install','app-update-rollback','napcat-install','napcat-configure','napcat-wire','napcat-stop','napcat-guide','napcat-login-code','preferences-save']);
for (const action of WORKSPACE_ACTIONS) ACTIONS.add(action);
const SETTINGS_FIELDS = new Set(['qqConnectionMode','officialOwnerUMO','defaultDelivery','dashboardPort','ownerQQ','platformId','onebotPort','onebotToken','biliEnabled','proactiveEnabled','signatureEnabled','qzoneEnabled','replyStyleMode','replyStyleMaxBubbles','replyStyleInterval','replyStylePunctuation','replyStylePrompt','replyStyleCustomRegex','replyStyleCustomCleanup']);
function validateSettings(payload) {
  // Accept the revisioned envelope from this renderer and the legacy bare patch
  // from older CLI callers; every field must still be allowlisted.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const envelope = Object.hasOwn(payload, 'patch');
  if (envelope) {
    const keys = Object.keys(payload).sort().join(',');
    if (keys !== 'patch' && keys !== 'expectedRevision,patch') return false;
    if (Object.hasOwn(payload, 'expectedRevision') && (typeof payload.expectedRevision !== 'string' || !/^[a-f0-9]{8,64}$/.test(payload.expectedRevision))) return false;
  }
  const patch = envelope ? payload.patch : payload;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
  if (Object.keys(patch).some(key => !SETTINGS_FIELDS.has(key))) return false;
  return JSON.stringify(payload).length <= 16384;
}

function validateRequest(event, shell, action, payload) {
  if (!shell || event.sender !== shell || event.senderFrame !== shell.mainFrame || !ACTIONS.has(action)) throw new Error('不允许此操作');
  if (action === 'open-panel' && (!payload || !PANELS.has(payload.panel))) throw new Error('页面无效');
  if (action === 'settings-save' && !validateSettings(payload)) throw new Error('设置无效');
  if (action === 'settings-history' && payload != null) throw new Error('此操作不接受额外参数');
  if (action === 'settings-restore-field' && (!payload || Object.keys(payload).sort().join(',') !== 'expectedRevision,field,recordId' || typeof payload.recordId !== 'string' || !/^[0-9]{10,20}-[a-f0-9]{8}$/.test(payload.recordId) || typeof payload.field !== 'string' || payload.field === 'onebotToken' || !/^[A-Za-z][A-Za-z0-9]{1,31}$/.test(payload.field) || typeof payload.expectedRevision !== 'string' || !/^[a-f0-9]{8,64}$/.test(payload.expectedRevision))) throw new Error('设置恢复请求无效');
  if (action === 'connections-status' && payload != null) throw new Error('此操作不接受额外参数');
  if (action === 'reply-style-preview') {
    const allowed = new Set(['text', 'mode', 'maxBubbles', 'interval', 'punctuation', 'customRegex', 'customCleanup', 'platform', 'hostReplyPrefix', 'hostTtsEnabled']);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !allowed.has(key))) throw new Error('预览内容无效');
    if (typeof payload.text !== 'string' || payload.text.length > 8192) throw new Error('预览文本不能超过 8192 个字符');
    if (payload.mode !== undefined && !['inherit', 'natural', 'single', 'custom'].includes(payload.mode)) throw new Error('回复方式无效');
  }
  if (action === 'connection-change' && (!payload || Object.keys(payload).sort().join(',') !== 'channel,enabled' || !['napcat', 'official'].includes(payload.channel) || typeof payload.enabled !== 'boolean')) throw new Error('连接操作无效');
  if (action === 'connection-confirm' && (!payload || Object.keys(payload).sort().join(',') !== 'planId,typed' || typeof payload.planId !== 'string' || !/^[a-f0-9]{16,64}$/.test(payload.planId) || typeof payload.typed !== 'string' || payload.typed.length > 16 || /[\x00-\x1f\x7f]/.test(payload.typed))) throw new Error('连接确认无效');
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
module.exports = { validateRequest, validateSettings, permittedNavigation, biliURL, consolePopupTarget };
