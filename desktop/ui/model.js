(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSWhaleUI = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const workspaceActions = new Set(['workspace-status','health-check','backup-list','backup-restore','backup-delete','diagnostics-export','app-update-check','app-update-download','app-update-install','app-update-rollback','napcat-install','napcat-configure','napcat-wire','napcat-stop','napcat-guide','napcat-login-code','preferences-save']);
  const noPayloadActions = new Set(['workspace-status','health-check','backup-list','diagnostics-export','app-update-download','app-update-install','napcat-install','napcat-configure','napcat-wire','napcat-stop','napcat-guide','napcat-login-code']);
  const actions = new Set(['inspect', 'install', 'start', 'stop', 'open-panel', 'home', 'settings-get', 'settings-save', 'open-data', 'backup', 'restore', 'initial-login', 'extensions-status', 'extension-check', 'extension-update', 'extension-rollback',...workspaceActions]);
  const panels = new Set(['astrbot', 'models', 'memory', 'bilibili', 'qq', 'napcat']);
  const extensionIds = new Set(['memory', 'memes']);
  const extensionActions = new Set(['extension-check', 'extension-update', 'extension-rollback']);
  const settingsDefaults = value => ({ ...value, dashboardPort:value?.dashboardPort??6185, signatureEnabled: value?.signatureEnabled === true, qzoneEnabled: value?.qzoneEnabled === true });
  const preferencesPayload = value => ({tray:value?.tray===true,startAtLogin:value?.startAtLogin===true,resumeAfterWake:value?.resumeAfterWake===true});
  function extensionsStatus(value) {
    if (!value || [...extensionIds].some(id => !value[id] || typeof value[id].installed !== 'boolean')) throw new Error('未能读取插件状态，请重试。');
    return Object.fromEntries([...extensionIds].map(id => [id, { ...value[id] }]));
  }
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function settingsPayload(value) {
    const port = Number(value.onebotPort);
    const dashboardPort=Number(value.dashboardPort??6185);
    if ([port,dashboardPort].some(p=>!Number.isInteger(p)||p<1024||p>65535)) throw new Error('端口应为 1024–65535 之间的整数。');
    if(port===dashboardPort)throw new Error('OneBot 与控制台端口不能相同。');
    return { ownerQQ: String(value.ownerQQ ?? '').trim(), platformId: String(value.platformId ?? '').trim(), onebotPort: port, dashboardPort, onebotToken: String(value.onebotToken ?? ''), biliEnabled: Boolean(value.biliEnabled), proactiveEnabled: Boolean(value.proactiveEnabled), signatureEnabled: value.signatureEnabled === true, qzoneEnabled: value.qzoneEnabled === true };
  }
  function connectionViewModel(data) {
    const state = data.state || {}, qq = data.workspace?.napcat;
    const view = (stage, title, description, badge, tone, action = '', actionLabel = '') =>
      ({ stage, title, description, badge, tone, action, actionLabel, ...(action === 'open-panel' ? { panel: 'napcat' } : {}) });
    if (data.workspace?.appUpdate?.recovery?.servicesMustRemainStopped) return view('recovery', '先完成应用更新', '当前更新或恢复尚未完成，请先处理应用设置中的提示。', '等待恢复', 'warn', 'route-settings', '查看恢复步骤');
    if (!state.installed || state.platform?.supported === false) return view('environment', '先准备运行环境', '环境准备完成后，再连接 QQ。已有配置与登录数据会保留。', '尚未准备', '', 'route-environment', '准备运行环境');
    const startup = {
      'starting-conversation': ['正在启动对话服务', '先启动消息处理服务，完成后再连接 QQ。'],
      'checking-qq': ['对话服务已启动', '正在检查已有的 QQ 连接。'],
      'starting-qq': ['正在启动 QQ 连接', '对话服务已准备好，正在启动独立 QQ 组件。'],
      'reusing-qq': ['沿用现有 QQ 连接', 'QQ 仍在运行，正在把它连接到对话服务，不会重新登录。'],
    }[state.startup?.stage];
    if (startup) return view(state.startup.stage, ...startup, '正在启动', 'working');
    if (!qq) return view('checking', '正在检查 QQ 连接', '读取已有配置和当前连接状态。', '检查中', 'working', 'workspace-status', '检查连接状态');
    const ownerSaved = state.setup?.ownerConfigured || /^[1-9]\d{4,19}$/.test(data.settings?.ownerQQ || '');
    if (!ownerSaved && data.settings) return view('owner', '先填写你的 QQ 号', '这是接收消息的账号。机器人小号将在下一步单独登录。', '首次设置', '', 'save-settings', '保存并继续');
    if (qq.code && qq.code !== 'NAP-EXTERNAL' && qq.code !== 'EXTERNAL_REQUIRED') return view('issue', 'QQ 连接需要检查', '已有登录数据会保留。请先查看连接选项，不必反复安装或扫码。', '需要处理', 'warn', 'show-connection-options', '查看连接选项');
    const managed = qq.configured && !qq.externalOnly;
    const onlineProof = state.running && qq.protocolConnected === true && (!managed || qq.running && !['scan-required', 'offline'].includes(qq.loginState));
    if (onlineProof) return view('ready', 'QQ 已连接', state.setup?.modelConfigured === false ? '消息连接已建立。接下来选择一个对话模型。' : '消息连接已建立，可以回到 QQ 与鱼聊天。', '已连接', 'good', state.setup?.modelConfigured === false ? 'route-intelligence' : '', state.setup?.modelConfigured === false ? '选择对话模型' : '');
    if (!qq.configured && !qq.externalOnly && state.platform?.id === 'win32-x64') return view('component', '准备 QQ 连接组件', '仅首次需要准备独立组件；日常使用的 QQ 和账号数据保持分开。', '首次准备', '', 'napcat-install', '准备 QQ 连接');
    if (!state.running) return view('stopped', qq.running ? 'QQ 连接已保留' : '启动对话和 QQ 连接', qq.running ? 'QQ 仍在运行。启动对话服务，就能继续使用。' : qq.hasSavedLogin ? '将依次启动对话服务、恢复已有 QQ 登录，再建立消息连接。' : '先启动对话服务，再按提示登录机器人小号。', '等待启动', '', 'start', qq.running ? '启动对话服务' : '启动并连接');
    if (qq.externalOnly) return view('external', '连接外部 QQ 服务', '对话服务已启动。请在你的协议端登录机器人账号，再建立消息连接。', '等待外部连接', '', 'show-external-guide', '查看接入步骤');
    if (!qq.running) return view('qq-stopped', '对话服务已启动', '还需要启动 QQ 连接；已有登录会优先恢复。', '等待 QQ', '', 'start', '启动 QQ 连接');
    if (qq.loginState === 'online') return qq.connectionConfigured
      ? view('awaiting-link', 'QQ 已在线，等待消息连接', '正在等待机器人建立连接，此时不需要重新登录。', '连接中', 'working')
      : view('apply-connection', 'QQ 已在线', '最后应用一次消息连接设置，不会退出 QQ。', '还差一步', '', 'napcat-wire', '完成消息连接');
    const phases = {
      resuming: ['正在恢复已有登录', '优先使用这台电脑上保存的登录记录，请稍候。', '恢复登录中', 'working'],
      connecting: ['QQ 正在连接', '组件已启动，正在等待 QQ 完成初始化。', '连接中', 'working'],
      confirming: ['等待手机确认', '请在手机 QQ 上确认本次登录；确认后等待状态更新，不要重复扫码。', '需要手机确认', 'warn'],
      'scan-required': ['需要完成 QQ 登录', '在管理页登录机器人小号。已在手机确认时请先等待，不要连续扫码。', '需要登录', 'warn', 'open-panel', '打开 QQ 登录'],
      offline: ['QQ 连接已断开', '请到管理页查看 QQ 的验证提示；应用不会连续重试登录。', 'QQ 离线', 'warn', 'open-panel', '查看 QQ 登录状态'],
    }[qq.loginState];
    if (phases) return view(qq.loginState, ...phases);
    return view('unknown', '暂时无法确认 QQ 状态', 'QQ 组件仍在运行。可以打开管理页查看，无需重新准备环境。', '等待确认', '', 'open-panel', '打开 QQ 管理');
  }
  function createController({ bridge, preview = false } = {}) {
    const available = !!bridge && typeof bridge.invoke === 'function' && typeof bridge.onState === 'function';
    let data = { mode: available ? 'desktop' : preview ? 'preview' : 'unavailable', pending: '', pendingExtension: '', error: '', retry: null, settings: null, extensions: null, extensionChecks: { memory: false, memes: false }, workspaceLoaded:false, workspace:{health:null,backups:[],appUpdate:null,napcat:null,preferences:preferencesPayload(),diagnosticFiles:[]}, notice: '', state: { version: '', platform: { label: '正在读取系统信息', supported: true }, phase: 'idle', installed: false, running: false, components: [], setup: {}, panel: '' } };
    const subscribers = new Set();
    let unsubscribe;
    const emit = () => subscribers.forEach(callback => callback(data));
    function mergeWorkspace(next) {
      if(!next||typeof next!=='object'||Array.isArray(next))throw new Error('未能读取工作空间状态，请重试。');
      for(const key of ['health','backups','appUpdate','napcat','diagnosticFiles'])if(Object.hasOwn(next,key))data.workspace[key]=next[key];
      if(Object.hasOwn(next,'preferences'))data.workspace.preferences=preferencesPayload(next.preferences);
    }
    function merge(next) {
      if (!next || typeof next !== 'object') return;
      const {workspace,appUpdate,...state}=next;if(workspace)mergeWorkspace(workspace);
      if(Object.hasOwn(next,'appUpdate'))mergeWorkspace({appUpdate});
      data.state = { ...data.state, ...state, platform: { ...data.state.platform, ...state.platform }, setup: { ...data.state.setup, ...state.setup } };
    }
    if (!available && preview) {
      merge({ version: '0.3.0a9', platform: { id: 'darwin-arm64', label: 'macOS · Apple Silicon', supported: true }, components: [
        { id: 'python', label: 'Python', version: '3.12', status: 'missing', detail: '将安装到独立环境' },
        { id: 'node', label: 'Node.js', version: '22 LTS', status: 'missing', detail: '用于扩展与网页能力' },
        { id: 'ffmpeg', label: 'FFmpeg', version: '6+', status: 'missing', detail: '音频与视频处理' },
        { id: 'astrbot', label: 'AstrBot', version: '4.29.3', status: 'missing', detail: '对话服务与插件管理' },
        { id: 'memory', label: '记忆插件', version: '随环境安装', status: 'missing', detail: '长期记忆与上下文' },
      ] });
      data.settings = { ownerQQ: '', platformId: 'qq', onebotPort: 6199, dashboardPort:6185, onebotToken: '', biliEnabled: false, proactiveEnabled: false, signatureEnabled: false, qzoneEnabled: false, hasModels: false };
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
      if(noPayloadActions.has(action))payload=undefined;
      if(action==='app-update-check'){if(!['alpha','stable'].includes(payload?.channel))throw new Error('请选择稳定版或 Alpha 更新通道。');payload={channel:payload.channel};}
      if(['backup-restore','backup-delete'].includes(action)) {
        if(typeof payload?.id!=='string'||!data.workspace.backups?.some(item=>item.id===payload.id)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(payload.id)||payload.id.includes('..'))throw new Error('请选择列表中的本机备份。');
        payload={id:payload.id};
      }
      if(action==='app-update-rollback')payload={restoreData:payload?.restoreData===true,confirmDataRestore:payload?.confirmDataRestore===true};
      if (!available) throw new Error(preview ? '界面预览为只读模式，请在桌面应用中执行操作。' : '请在 DSWhale 桌面应用中执行操作。');
      if (data.pending) throw new Error('上一项操作仍在进行，请稍候。');
      if(action==='app-update-download'&&data.workspace.appUpdate?.canDownload!==true)throw new Error('请先检查应用更新，或继续未完成的下载。');
      if(action==='app-update-install'&&(!data.state.installed||data.workspace.appUpdate?.canInstall!==true))throw new Error('请先准备环境并下载经过校验的应用安装包。');
      if(action==='app-update-rollback'&&data.workspace.appUpdate?.canRollback!==true)throw new Error('当前没有可回退的应用安装包和备份。');
      if(action==='app-update-rollback'&&payload.restoreData&&!payload.confirmDataRestore)throw new Error('请明确确认恢复更新前数据。');
      if(['napcat-install','napcat-configure','napcat-wire'].includes(action)&&!data.state.installed)throw new Error('请先准备运行环境。');
      if(action==='napcat-install'&&(data.state.platform.id!=='win32-x64'||data.workspace.napcat?.supported!==true))throw new Error('当前平台请连接已有的外部 QQ 环境。');
      if (action === 'extension-update' && (!data.extensionChecks[payload.id] || data.extensions?.[payload.id]?.canUpdate !== true)) throw new Error('请先检查插件更新，确认可安装的版本。');
      if (action === 'extension-rollback' && data.extensions?.[payload.id]?.canRollback !== true) throw new Error('当前没有可回退的插件备份。');
      data.pending = action;
      data.pendingExtension = extensionActions.has(action) ? payload.id : '';
      data.error = '';
      data.notice = '';
      if (action === 'extension-check') data.extensionChecks[payload.id] = false;
      emit();
      let retryOverride;
      try {
        if (action === 'settings-save') payload = settingsPayload(payload);
        if(action==='preferences-save')payload=preferencesPayload(payload);
        const result = await bridge.invoke(action, payload);
        if (result && typeof result === 'object' && result.error) throw new Error(String(result.error));
        if(workspaceActions.has(action)&&!result?.canceled) {
          mergeWorkspace(result);if(action==='workspace-status')data.workspaceLoaded=true;
          if(action==='preferences-save')data.notice='应用偏好已保存。';
          if(action==='health-check')data.notice='本机环境检查已完成。';
          if(action==='backup-delete')data.notice='所选本机备份已删除。';
          if(action==='diagnostics-export'&&result.saved)data.notice='诊断报告已保存。';
          if(action==='app-update-check')data.notice='应用更新检查已完成。';
          if(action==='app-update-download')data.notice='应用安装包已下载并校验，等待你确认安装。';
          if(['app-update-install','app-update-rollback','backup-restore'].includes(action)){merge({running:false,panel:''});data.notice=action==='backup-restore'?'备份已恢复，当前数据已另行备份；请检查环境和连接后启动服务。':'安装程序已打开，请完成系统安装并重新打开应用。';}
          if(action==='backup-restore'){data.settings=null;data.extensions=null;data.extensionChecks={memory:false,memes:false};}
          if(action==='napcat-wire')data.notice='OneBot 连接设置已更新，请检查连接状态。';
        }
        else if (action === 'settings-get') data.settings = settingsDefaults(result);
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
        if (result && ('phase' in result || 'components' in result || 'running' in result || 'installed' in result || 'platform' in result || 'versionMatrix' in result)) merge(result);
        if(['install','restore'].includes(action)&&!result?.canceled) {
          retryOverride={action:'workspace-status',payload:undefined};
          const workspace=await bridge.invoke('workspace-status');
          if(workspace?.error)throw new Error(String(workspace.error));
          mergeWorkspace(workspace);data.workspaceLoaded=true;retryOverride=undefined;
        }
        data.retry = null;
        return result;
      } catch (error) {
        data.error = error instanceof Error ? error.message : String(error);
        // Never retain a settings payload containing a local access token in retry metadata.
        data.retry = retryOverride||(['settings-save','backup-restore','backup-delete','app-update-rollback'].includes(action) ? null : { action, payload });
        throw error;
      } finally { data.pending = ''; data.pendingExtension = ''; emit(); }
    }
    return {
      get: () => data,
      subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
      async init() { if (!available) { emit(); return; } unsubscribe = bridge.onState(next => { merge(next); emit(); }); await act('inspect');await act('workspace-status'); },
      act,
      dispose() { if (typeof unsubscribe === 'function') unsubscribe(); subscribers.clear(); },
    };
  }
  return { createController, escapeHTML, settingsPayload,preferencesPayload,connectionViewModel };
});
