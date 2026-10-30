(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSWhaleUI = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const actions = new Set(['inspect', 'install', 'start', 'stop', 'open-panel', 'home', 'settings-get', 'settings-save', 'open-data', 'backup', 'restore', 'initial-login']);
  const panels = new Set(['astrbot', 'models', 'memory', 'bilibili', 'qq', 'napcat']);
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function settingsPayload(value) {
    const port = Number(value.onebotPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口应为 1–65535 之间的整数。');
    return { ownerQQ: String(value.ownerQQ ?? '').trim(), platformId: String(value.platformId ?? '').trim(), onebotPort: port, onebotToken: String(value.onebotToken ?? ''), biliEnabled: Boolean(value.biliEnabled), proactiveEnabled: Boolean(value.proactiveEnabled) };
  }
  function createController({ bridge, preview = false } = {}) {
    const available = !!bridge && typeof bridge.invoke === 'function' && typeof bridge.onState === 'function';
    let data = { mode: available ? 'desktop' : preview ? 'preview' : 'unavailable', pending: '', error: '', retry: null, settings: null, notice: '', state: { version: '', platform: { label: '正在读取系统信息', supported: true }, phase: 'idle', installed: false, running: false, components: [], setup: {}, panel: '' } };
    const subscribers = new Set();
    let unsubscribe;
    const emit = () => subscribers.forEach(callback => callback(data));
    function merge(next) {
      if (!next || typeof next !== 'object') return;
      data.state = { ...data.state, ...next, platform: { ...data.state.platform, ...next.platform }, setup: { ...data.state.setup, ...next.setup } };
    }
    if (!available && preview) {
      merge({ version: '0.3.0a1', platform: { id: 'darwin-arm64', label: 'macOS · Apple Silicon', supported: true }, components: [
        { id: 'python', label: 'Python', version: '3.12', status: 'missing', detail: '将安装到独立环境' },
        { id: 'node', label: 'Node.js', version: '22 LTS', status: 'missing', detail: '用于扩展与网页能力' },
        { id: 'ffmpeg', label: 'FFmpeg', version: '6+', status: 'missing', detail: '音频与视频处理' },
        { id: 'astrbot', label: 'AstrBot', version: '4.29.3', status: 'missing', detail: '对话服务与插件管理' },
        { id: 'memory', label: '记忆插件', version: '随环境安装', status: 'missing', detail: '长期记忆与上下文' },
      ] });
      data.settings = { ownerQQ: '', platformId: 'qq', onebotPort: 6199, onebotToken: '', biliEnabled: false, proactiveEnabled: false, hasModels: false };
    }
    async function act(action, payload) {
      if (!actions.has(action)) throw new Error('不支持的操作。');
      if (action === 'open-panel' && !panels.has(payload?.panel)) throw new Error('不支持的面板。');
      if (!available) throw new Error(preview ? '界面预览为只读模式，请在桌面应用中执行操作。' : '请在 DSWhale 桌面应用中执行操作。');
      if (data.pending) throw new Error('上一项操作仍在进行，请稍候。');
      data.pending = action;
      data.error = '';
      data.notice = '';
      emit();
      try {
        if (action === 'settings-save') payload = settingsPayload(payload);
        const result = await bridge.invoke(action, payload);
        if (result && typeof result === 'object' && result.error) throw new Error(String(result.error));
        if (action === 'settings-get') data.settings = result;
        else if (action === 'settings-save') { if (result && 'ownerQQ' in result) data.settings = result; else data.settings = { ...data.settings, ...payload }; data.notice = '设置已保存。'; }
        else if (action === 'backup' && !result?.canceled) data.notice = '备份已保存到所选位置。';
        else if (action === 'restore' && !result?.canceled) { data.notice = '备份已导入，请检查配置后启动服务'; data.settings = null; }
        else if (action === 'open-data') data.notice = '已打开数据文件夹。';
        if (result && ('phase' in result || 'components' in result || 'running' in result)) merge(result);
        data.retry = null;
        return result;
      } catch (error) {
        data.error = error instanceof Error ? error.message : String(error);
        // Never retain a settings payload containing a local access token in retry metadata.
        data.retry = action === 'settings-save' ? null : { action, payload };
        throw error;
      } finally { data.pending = ''; emit(); }
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
