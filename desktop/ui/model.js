(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSWhaleUI = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const actions = new Set(['inspect', 'install', 'start', 'stop', 'open-panel', 'home', 'settings-get', 'settings-save', 'open-data', 'backup', 'restore', 'initial-login', 'extensions-status', 'extension-check', 'extension-update', 'extension-rollback']);
  const panels = new Set(['astrbot', 'models', 'memory', 'bilibili', 'qq', 'napcat']);
  const extensionIds = new Set(['memory', 'memes']);
  const extensionActions = new Set(['extension-check', 'extension-update', 'extension-rollback']);
  const settingsDefaults = value => ({ ...value, signatureEnabled: value?.signatureEnabled === true, qzoneEnabled: value?.qzoneEnabled === true });
  function extensionsStatus(value) {
    if (!value || [...extensionIds].some(id => !value[id] || typeof value[id].installed !== 'boolean')) throw new Error('未能读取插件状态，请重试。');
    return Object.fromEntries([...extensionIds].map(id => [id, { ...value[id] }]));
  }
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function settingsPayload(value) {
    const port = Number(value.onebotPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口应为 1–65535 之间的整数。');
    return { ownerQQ: String(value.ownerQQ ?? '').trim(), platformId: String(value.platformId ?? '').trim(), onebotPort: port, onebotToken: String(value.onebotToken ?? ''), biliEnabled: Boolean(value.biliEnabled), proactiveEnabled: Boolean(value.proactiveEnabled), signatureEnabled: value.signatureEnabled === true, qzoneEnabled: value.qzoneEnabled === true };
  }
  function createController({ bridge, preview = false } = {}) {
    const available = !!bridge && typeof bridge.invoke === 'function' && typeof bridge.onState === 'function';
    let data = { mode: available ? 'desktop' : preview ? 'preview' : 'unavailable', pending: '', pendingExtension: '', error: '', retry: null, settings: null, extensions: null, extensionChecks: { memory: false, memes: false }, notice: '', state: { version: '', platform: { label: '正在读取系统信息', supported: true }, phase: 'idle', installed: false, running: false, components: [], setup: {}, panel: '' } };
    const subscribers = new Set();
    let unsubscribe;
    const emit = () => subscribers.forEach(callback => callback(data));
    function merge(next) {
      if (!next || typeof next !== 'object') return;
      data.state = { ...data.state, ...next, platform: { ...data.state.platform, ...next.platform }, setup: { ...data.state.setup, ...next.setup } };
    }
    if (!available && preview) {
      merge({ version: '0.3.0a2', platform: { id: 'darwin-arm64', label: 'macOS · Apple Silicon', supported: true }, components: [
        { id: 'python', label: 'Python', version: '3.12', status: 'missing', detail: '将安装到独立环境' },
        { id: 'node', label: 'Node.js', version: '22 LTS', status: 'missing', detail: '用于扩展与网页能力' },
        { id: 'ffmpeg', label: 'FFmpeg', version: '6+', status: 'missing', detail: '音频与视频处理' },
        { id: 'astrbot', label: 'AstrBot', version: '4.29.3', status: 'missing', detail: '对话服务与插件管理' },
        { id: 'memory', label: '记忆插件', version: '随环境安装', status: 'missing', detail: '长期记忆与上下文' },
      ] });
      data.settings = { ownerQQ: '', platformId: 'qq', onebotPort: 6199, onebotToken: '', biliEnabled: false, proactiveEnabled: false, signatureEnabled: false, qzoneEnabled: false, hasModels: false };
      data.extensions = { memory: { installed: false, version: null, latest: null, canUpdate: false, canRollback: false }, memes: { installed: false, version: null, latest: null, canUpdate: false, canRollback: false } };
    }
    async function act(action, payload) {
      if (!actions.has(action)) throw new Error('不支持的操作。');
      if (action === 'open-panel' && !panels.has(payload?.panel)) throw new Error('不支持的面板。');
      if (extensionActions.has(action)) {
        if (!extensionIds.has(payload?.id)) throw new Error('不支持的插件。');
        payload = { id: payload.id };
      }
      if (action === 'extensions-status') payload = undefined;
      if (!available) throw new Error(preview ? '界面预览为只读模式，请在桌面应用中执行操作。' : '请在 DSWhale 桌面应用中执行操作。');
      if (data.pending) throw new Error('上一项操作仍在进行，请稍候。');
      if (action === 'extension-update' && (!data.extensionChecks[payload.id] || data.extensions?.[payload.id]?.canUpdate !== true)) throw new Error('请先检查插件更新，确认可安装的版本。');
      if (action === 'extension-rollback' && data.extensions?.[payload.id]?.canRollback !== true) throw new Error('当前没有可回退的插件备份。');
      data.pending = action;
      data.pendingExtension = extensionActions.has(action) ? payload.id : '';
      data.error = '';
      data.notice = '';
      if (action === 'extension-check') data.extensionChecks[payload.id] = false;
      emit();
      try {
        if (action === 'settings-save') payload = settingsPayload(payload);
        const result = await bridge.invoke(action, payload);
        if (result && typeof result === 'object' && result.error) throw new Error(String(result.error));
        if (action === 'settings-get') data.settings = settingsDefaults(result);
        else if (action === 'settings-save') { if (result && 'ownerQQ' in result) data.settings = settingsDefaults(result); else data.settings = settingsDefaults({ ...data.settings, ...payload }); data.notice = '设置已保存。'; }
        else if ((action === 'extensions-status' || extensionActions.has(action)) && !result?.canceled) {
          const next = extensionsStatus(result);
          const wasInstalled = data.extensions?.[payload?.id]?.installed;
          data.extensions = next;
          if (action === 'extension-check') {
            data.extensionChecks[payload.id] = true;
            data.notice = `${payload.id === 'memory' ? 'LivingMemory' : '表情包管理器'}检查完成。`;
          } else if (action === 'extension-update' || action === 'extension-rollback') {
            data.extensionChecks[payload.id] = false;
            merge({ running: false, panel: '' });
            const verb = action === 'extension-rollback' ? '回退' : wasInstalled ? '更新' : '安装';
            data.notice = `${payload.id === 'memory' ? 'LivingMemory' : '表情包管理器'}已${verb}，服务保持停止。请检查设置后启动服务。`;
          }
        }
        else if (action === 'backup' && !result?.canceled) data.notice = '备份已保存到所选位置。';
        else if (action === 'restore' && !result?.canceled) { data.notice = '备份已导入，请检查配置后启动服务'; data.settings = null; data.extensions = null; data.extensionChecks = { memory: false, memes: false }; }
        else if (action === 'open-data') data.notice = '已打开数据文件夹。';
        if (result && ('phase' in result || 'components' in result || 'running' in result)) merge(result);
        data.retry = null;
        return result;
      } catch (error) {
        data.error = error instanceof Error ? error.message : String(error);
        // Never retain a settings payload containing a local access token in retry metadata.
        data.retry = action === 'settings-save' ? null : { action, payload };
        throw error;
      } finally { data.pending = ''; data.pendingExtension = ''; emit(); }
    }
    return {
      get: () => data,
      subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
      async init() { if (!available) { emit(); return; } unsubscribe = bridge.onState(next => { merge(next); emit(); }); await act('inspect'); },
      act,
      dispose() { if (typeof unsubscribe === 'function') unsubscribe(); subscribers.clear(); },
    };
  }
  return { createController, escapeHTML, settingsPayload };
});
