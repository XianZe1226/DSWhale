(function () {
  'use strict';
  const { createController, escapeHTML: esc, connectionViewModel, connectionSummary, settingsPatch } = window.DSWhaleUI;
  const query = new URLSearchParams(location.search);
  const controller = createController({ bridge: window.dswhale, preview: query.get('preview') === '1' });
  const root = document.getElementById('app');
  const routeNames = { overview: '概览', environment: '运行环境', connect: 'QQ 连接', intelligence: '模型与记忆', bilibili: '哔哩哔哩', settings: '应用设置' };
  const panelNames = { astrbot: 'AstrBot 控制台', models: '模型配置', memory: '记忆管理', bilibili: '哔哩哔哩设置', qq: 'QQ 连接控制台', napcat: 'QQ 登录' };
  const iconPaths = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    environment: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
    connect: '<path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v3"/>',
    intelligence: '<path d="M9 4a4 4 0 0 0-6 4c-3 2-2 6 0 7-1 4 3 7 6 5V4Zm6 0a4 4 0 0 1 6 4c3 2 2 6 0 7 1 4-3 7-6 5V4ZM6 9l3 2m-4 5 4-1m9-6-3 2m4 5-4-1"/>',
    bilibili: '<rect x="3" y="6" width="18" height="15" rx="4"/><path d="m7 2 4 4m6-4-4 4M8 11v4m8-4v4m-7 3h6"/>',
    settings: '<path d="m9 3-1 3-3 1v4l-2 1 2 2v3l3 1 1 3h5l1-3 3-1 1-3 2-1-2-2V7l-3-1-1-3H9Z"/><circle cx="12" cy="12" r="3"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    refresh: '<path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    play: '<path d="m8 4 12 8-12 8V4Z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  };
  const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name] || iconPaths.environment}</svg>`;
  let route = routeNames[query.get('screen')] ? query.get('screen') : 'overview';
  let draft = null;
  let draftBase = null;
  let dirtyFields = new Set();
  let conflictFields = new Set();
  let overwritePending = false;
  let reveal = false;
  let settingsLoading = false;
  let extensionsLoading = false;
  let extensionReview = '';
  let extensionMessage = null;
  let workspaceLoading=false;
  let connectionsLoading=false;
  let settingsHistoryLoading=false;
  let lastMarkup='';
  let composing=false;
  let deferredData=null;
  let backupReview=null;
  let updateChannel=null;
  let preferencesDraft=null;
  let preferencesDirty=false;
  let localMessage='';
  let settingsConflict=false;
  let pendingFocus = null;
  let lastAnnouncement = '';
  let connectionAdvancedOpen = false;
  let externalGuideOpen = false;
  let replyStylePreviewResult = null;
  let replyStylePreviewText = '';
  const busy = data => !!data.pending || ['checking', 'installing'].includes(data.state.phase);
  const desktop = data => data.mode === 'desktop';
  const disabled = yes => yes ? ' disabled' : '';
  const button = (text, action, { primary = false, iconName, off = false, payload = '', id = '', extension = '', operation = '', item='', channel='', enabled } = {}) => `<button type="button" class="button${primary ? ' primary' : ''}" data-action="${esc(action)}"${id ? ` id="${esc(id)}"` : ''}${payload ? ` data-panel="${esc(payload)}"` : ''}${extension ? ` data-extension="${esc(extension)}"` : ''}${operation ? ` data-operation="${esc(operation)}"` : ''}${item ? ` data-item="${esc(item)}"` : ''}${channel ? ` data-channel="${esc(channel)}" data-enabled="${enabled === true ? '1' : '0'}"` : ''}${disabled(off)}>${iconName ? icon(iconName) : ''}<span>${esc(text)}</span></button>`;
  const routeButton = (text, target) => `<button type="button" class="text-button" data-route="${target}">${esc(text)}${icon('arrow')}</button>`;
  const badge = (label, type = '') => `<span class="badge ${type}"><span class="status-dot"></span>${esc(label)}</span>`;
  const extensionName = id => id === 'memory' ? 'LivingMemory' : '表情包管理器';
  function extensionProgress(data) {
    if (data.pending === 'extensions-status') return '正在读取本机插件状态…';
    if (!data.pendingExtension) return '';
    const verb = { 'extension-check': '检查', 'extension-update': data.extensions?.[data.pendingExtension]?.installed ? '更新' : '安装', 'extension-rollback': '回退' }[data.pending];
    return verb ? `正在${verb}${extensionName(data.pendingExtension)}…` : '';
  }
  const workspaceProgress = data => ({'workspace-status':'正在读取本机工作空间状态…','health-check':'正在检查本机环境…','backup-list':'正在读取本机备份…','backup-restore':'正在备份当前数据并恢复所选备份…','backup-delete':'正在删除所选本机备份…','diagnostics-export':'正在准备诊断报告…','app-update-check':'正在检查官方应用更新…','app-update-start':'正在准备应用更新…','app-update-download':'正在下载并校验应用安装包…','app-update-install':'正在备份并打开系统安装程序…','app-update-rollback':'正在备份并准备应用回退…','preferences-save':'正在保存应用偏好…','napcat-install':'正在下载并校验独立连接组件…','napcat-configure':'请选择已有独立组件目录…','napcat-wire':'正在应用消息连接，QQ 保持在线…','napcat-stop':'正在停止 QQ 连接…','napcat-guide':'正在打开官方连接指南…','napcat-login-code':'请在系统对话框中查看登录口令…'}[data.pending]||'');
  const startupProgress = data => ({'starting-conversation':'正在启动对话服务…','checking-qq':'对话服务已启动，正在检查已有的 QQ 连接…','starting-qq':'正在启动 QQ 连接…','reusing-qq':'正在沿用现有 QQ 连接…'}[data.state.startup?.stage]||'');
  const preference = (data, value, id, title, description) => `<section class="card preference-card"><div><h3 id="${id}-label">${esc(title)}</h3><p id="${id}-help">${esc(description)}</p></div><label class="switch"><input id="${id}" name="${id}" type="checkbox" aria-labelledby="${id}-label" aria-describedby="${id}-help"${value[id] ? ' checked' : ''}${disabled(!desktop(data) || busy(data))}><span aria-hidden="true"></span></label></section>`;
  function healthCard(data, bili=false) {
    const health=data.workspace.health;
    const checks=Array.isArray(health?.checks)?health.checks.filter(check=>!bili||/bili|bridge|pkg/i.test(`${check.id} ${check.code}`)):[];
    const failures=checks.filter(check=>!check.ok&&check.required).length;
    return `<section class="card reliability-card" aria-labelledby="${bili?'bili-':'environment-'}health-title"><div class="reliability-heading"><div><h2 id="${bili?'bili-':'environment-'}health-title">${bili?'视频服务检查':'环境检查'}</h2><p>${health?failures?`${failures} 项必要检查需要处理`:'必要检查结果如下，账号可用性仍需实际验证':'准备环境后可检查本机组件与配置。'}</p></div>${button('重新检查','health-check',{iconName:'refresh',off:!desktop(data)||busy(data)||!data.state.installed})}</div>${checks.length?`<ul class="health-list">${checks.map(check=>`<li><span class="health-indicator ${check.ok?'pass':'attention'}" aria-label="${check.ok?'通过':check.required?'需要处理':'待确认'}">${icon(check.ok?'check':'refresh')}</span><div><strong>${esc(check.name)}</strong><p>${esc(check.detail)}</p></div>${badge(check.ok?'通过':check.required?'需处理':'待确认',check.ok?'good':'warn')}</li>`).join('')}</ul>`:'<p class="reliability-empty">尚无检查结果；此页不会连接你的模型或发送 QQ 消息。</p>'}<div class="card-actions">${button('修复运行环境','install',{off:!desktop(data)||busy(data)||data.state.running||data.state.platform.supported===false})}${button('QQ 连接','route-connect',{off:busy(data)})}</div>${data.state.running?'<p class="reliability-note">修复前请先停止服务。</p>':''}</section>`;
  }
  function versionMatrix(data) {
    const matrix=data.state.versionMatrix;if(!matrix?.expected)return '';
    const names={dswhale:'DSWhale',astrbot:'AstrBot',python:'Python',node:'Node.js',ffmpeg:'FFmpeg'};
    return `<div class="section-heading"><h2>版本对照</h2><span>兼容的本机工具可继续使用</span></div><section class="card component-table matrix-table"><table><thead><tr><th scope="col">组件</th><th scope="col">预期版本</th><th scope="col">实际版本</th></tr></thead><tbody>${Object.entries(names).map(([id,name])=>`<tr><th scope="row">${name}</th><td class="version-text">${esc(matrix.expected[id]||'—')}</td><td class="version-text">${esc(matrix.actual?.[id]||'未检测到')}</td></tr>`).join('')}</tbody></table></section><p class="reliability-note">FFmpeg 可复用兼容版本；组件是否可用以环境检查结果为准。</p>`;
  }
  function napcatCard(data) {
    const view = connectionViewModel(data), value = draft || data.settings || {};
    return `<section class="card connection-main" id="qq-connection" aria-labelledby="qq-connection-title"><div class="connection-heading"><span class="connection-symbol ${view.tone === 'good' ? 'complete' : ''}">${icon(view.tone === 'good' ? 'check' : 'connect')}</span>${badge(view.badge,view.tone)}</div><h2 id="qq-connection-title">${esc(view.title)}</h2><p class="connection-description">${esc(view.description)}</p>${['owner','official-owner'].includes(view.stage) ? ownerField(data,value) : ''}<div class="connection-primary-row">${connectionPrimary(data)}${!view.action && view.tone === 'working' ? '<span class="connection-wait"><span class="spinner" aria-hidden="true"></span>状态会自动更新，无需重复操作</span>' : ''}</div>${connectionTimeline(data)}</section>`;
  }
  function connectionPrimary(data, overview = false, view = connectionViewModel(data)) {
    if (!view.action) return '';
    if (overview && ['save-settings','show-connection-options','show-external-guide','connection-change'].includes(view.action)) return routeButton('前往 QQ 连接','connect');
    return button(view.actionLabel,view.action,{primary:true,id:overview?'overview-connection-primary':'connection-primary',payload:view.panel||'',channel:view.channel||'',enabled:view.enabled,iconName:view.action==='start'?'play':'arrow',off:!desktop(data)||busy(data)});
  }
  function connectionTimeline(data, view = connectionViewModel(data), channel = data.connectionTab||data.settings?.qqConnectionMode||data.state.qqConnectionMode||data.state.setup?.qqConnectionMode||'napcat') {
    const qq = data.workspace.napcat || {}, stage = data.state.startup?.stage || view.stage;
    if(channel==='official'){
      const bound=data.settings?!!data.settings.officialOwnerUMO:data.state.setup?.ownerConfigured;
      const officialConnection=(data.connections?.channels||[]).find(item=>item.channel==='official');
      const officialHealth=data.workspace.official;
      const targetIssue=officialConnection?.targetIssue||'';
      const candidates=Array.isArray(officialConnection?.platformCandidates)?officialConnection.platformCandidates:[];
      const candidatesReady=candidates.some(item=>item&&item.enable===true&&item.configured===true);
      const bindingBlocked=Boolean(targetIssue)&&!candidatesReady;
      const resolvedUnconfigured=!targetIssue&&officialConnection?.configured===false;
      const connected=!targetIssue && !resolvedUnconfigured && officialConnection?.platformEnabled!==false && (officialHealth && typeof officialHealth.protocolConnected==='boolean' ? officialHealth.protocolConnected===true : (officialConnection?.protocolConnected===true || officialConnection?.health==='connected'));
      const targetDetail=resolvedUnconfigured?'等待完成配置':targetIssue==='ambiguous'?'目标待确认':targetIssue==='missing-bound'?'绑定失效':targetIssue==='missing'?'未配置':'等待连接';
      const bindingInvalid=targetIssue==='missing-bound';
      const boundDetail=bindingBlocked?'待实例启用后绑定':bindingInvalid?'绑定失效，等待重新绑定':resolvedUnconfigured?(bound?'已绑定，等待配置完成':'等待完成配置后绑定'):bound?'已绑定':'等待复制会话 ID';
      return `<ol class="connection-timeline" aria-label="官方 QQ 连接进度">${[['对话服务',data.state.running?'已启动':'尚未启动',data.state.running],['官方接口',connected?'网关已连接':targetDetail,connected],['主人私聊',boundDetail,bound&&!bindingInvalid&&!bindingBlocked&&!resolvedUnconfigured]].map(([label,detail,done],i)=>`<li class="${done?'done':'waiting'}"><span class="connection-step-marker">${done?icon('check'):i+1}</span><div><strong>${label}</strong><span>${detail}</span></div></li>`).join('')}</ol>`;
    }
    const backend = data.state.running, logged = qq.loginState === 'online' || view.stage === 'ready';
    const items = [
      ['对话服务', backend ? '已启动' : stage === 'starting-conversation' ? '正在启动' : '等待启动', backend ? 'done' : stage === 'starting-conversation' ? 'active' : 'waiting'],
      ['QQ 登录', logged ? !backend && qq.running ? '保持在线' : '已在线' : {resuming:'正在恢复登录',confirming:'等待手机确认','scan-required':'需要登录',connecting:'正在连接','starting-qq':'正在启动','reusing-qq':'沿用现有连接'}[stage] || (qq.hasSavedLogin ? '已保存账号记录' : '首次需要登录'), logged ? 'done' : backend ? 'active' : 'waiting'],
      ['消息连接', view.stage === 'ready' ? '已建立连接' : view.stage === 'apply-connection' ? '等待应用设置' : '等待连接', view.stage === 'ready' ? 'done' : logged && backend ? 'active' : 'waiting'],
    ];
    return `<ol class="connection-timeline" aria-label="启动与连接步骤">${items.map(([title,detail,status],i)=>`<li data-state="${status}"><span class="connection-step-marker" aria-hidden="true">${status==='done'?icon('check'):i+1}</span><div><strong>${title}</strong><span>${esc(detail)}</span></div></li>`).join('')}</ol>`;
  }
  function ownerField(data,value) {
    const channel=data.connectionTab||value.qqConnectionMode||'napcat';
    if(channel==='official')return `<div class="field connection-owner-field"><label for="officialOwnerUMO">官方机器人私聊会话 ID</label><input id="officialOwnerUMO" autocomplete="off" placeholder="复制 /fish whoami 返回的完整本会话" value="${esc(value.officialOwnerUMO||'')}"${disabled(!desktop(data)||busy(data))}><p class="field-help">仅限你的私聊；不是 QQ 号码，也不要填写群聊或频道会话。</p></div>`;
    return `<div class="field connection-owner-field"><label for="ownerQQ">你的 QQ 号（接收消息）</label><input id="ownerQQ" name="ownerQQ" inputmode="numeric" autocomplete="off" placeholder="填写你自己的 QQ 号" value="${esc(value.ownerQQ||'')}"${disabled(!desktop(data)||busy(data))}><p class="field-help">这里填你的账号，不是机器人的小号。</p></div>`;
  }
  function defaultDeliveryField(data,value) {
    const settings=value||{},off=!desktop(data)||busy(data);
    const options=[['','沿用当前接入方式'],['napcat','普通 QQ 小号'],['official','QQ 官方机器人']];
    const napcatReady=Boolean(settings.platformId&&settings.ownerQQ)||settings.napcatConfigured===true;
    const officialReady=Boolean(settings.officialOwnerUMO)&&settings.officialConfigured===true;
    return `<div class="field"><label for="defaultDelivery">主动消息发送到</label><select id="defaultDelivery"${disabled(off)}>${options.map(([id,label])=>`<option value="${id}"${((settings.defaultDelivery??'')===id)?' selected':''}${id==='napcat'&&!napcatReady?' disabled':''}${id==='official'&&!officialReady?' disabled':''}>${label}</option>`).join('')}</select><p class="field-help">两路可同时接收私聊；主动聊天与自动推荐只走这里选定的已绑定渠道。</p></div>`;
  }
  function connectionOptions(data,value) {
    const channel=data.connectionTab||value.qqConnectionMode||'napcat';
    if(channel==='official'){
      const off=!desktop(data)||busy(data),view=connectionViewModel(data);
      return `<details class="card connection-advanced" id="connection-advanced"${connectionAdvancedOpen?' open':''}><summary id="connection-advanced-summary">更多官方连接选项<span>私聊绑定与主动互动</span></summary><div class="connection-option-content">${['official-owner','official-target'].includes(view.stage)?'':ownerField(data,value)}${defaultDeliveryField(data,value)}${preference(data,value,'proactiveEnabled','主动互动','需具备官方消息权限；结果不明确时不会自动重发。')}<p class="option-help">官方接口不支持修改个人 QQ 签名或发表 QQ 空间。机器人连接随对话服务启停，个人 QQ 不受影响。密钥只在内置机器人配置中填写。</p><div class="card-actions">${button('保存设置','save-settings',{off})}${button('打开机器人配置','open-panel',{payload:'qq',off:off||!data.state.running})}</div></div></details>`;
    }
    const qq=data.workspace.napcat,windows=data.state.platform.id==='win32-x64',off=!desktop(data)||busy(data),view=connectionViewModel(data);
    return `<details class="card connection-advanced" id="connection-advanced"${connectionAdvancedOpen?' open':''}><summary id="connection-advanced-summary">更多连接选项<span>账号、端口、互动功能与组件管理</span></summary><div class="connection-option-content">${view.stage!=='owner'?ownerField(data,value):''}<h3>连接参数</h3><p class="option-help">通常保持默认即可。只在端口冲突或连接已有协议端时修改。</p><div class="form-grid"><div class="field"><label for="platformId">AstrBot 平台标识</label><input id="platformId" value="${esc(value.platformId||'qq')}"${disabled(off)}></div><div class="field"><label for="onebotPort">OneBot 反向 WebSocket 端口</label><input id="onebotPort" type="number" min="1024" max="65535" value="${esc(value.onebotPort)}"${disabled(off)}></div><div class="field"><label for="dashboardPort">AstrBot 控制台端口</label><input id="dashboardPort" type="number" min="1024" max="65535" value="${esc(value.dashboardPort??6185)}"${disabled(off)}></div><div class="field field-wide"><label for="onebotToken">OneBot 访问令牌</label><div class="secret-input"><input id="onebotToken" type="${reveal?'text':'password'}" autocomplete="off" value="${esc(value.onebotToken||'')}"${disabled(off)}><button type="button" class="reveal-button" data-reveal aria-controls="onebotToken" aria-pressed="${reveal}">${reveal?'隐藏':'显示'}</button></div><p class="field-help">只保存在本机，与协议端保持一致。</p></div></div><h3>互动功能</h3>${defaultDeliveryField(data,value)}${preference(data,value,'proactiveEnabled','主动互动','按现有插件设置主动发起对话。')}${preference(data,value,'signatureEnabled','QQ 个性签名','仅绑定的主人可要求修改机器人签名。')}${preference(data,value,'qzoneEnabled','QQ 空间文字动态','先创建草稿，经你确认后发布。')}<div class="card-actions">${button(data.pending==='settings-save'?'正在保存…':'保存设置','save-settings',{off})}<span class="option-help">${dirtyFields.size?'有未保存的更改':'设置只保存在本机'}</span></div><h3>QQ 连接管理</h3><p class="option-help">停止对话服务会保留 QQ 在线。只有需要断开 QQ 时，才停止 QQ 连接。</p><div class="card-actions">${button('打开 QQ 管理','open-panel',{payload:'napcat',off:off||!data.state.running&&!qq?.running})}${windows?button('QQ 管理口令','napcat-login-code',{off:off||!qq?.configured}):''}${windows&&qq?.running?button('停止 QQ 连接','napcat-stop',{off}):''}${button('应用消息连接','napcat-wire',{off:off||!qq?.configured||qq?.loginState!=='online'||qq?.externalOnly})}</div><p class="option-help">管理口令用于本机管理页，不是 QQ 密码。首次 QQ 登录和账号验证由你本人完成。</p><h3>组件与帮助</h3><div class="card-actions">${windows?button('检查并准备组件','napcat-install',{off:off||!data.state.installed||qq?.running||qq?.canInstall===false}):''}${windows||data.state.platform.id==='linux-x64'?button('使用已有独立组件','napcat-configure',{off:off||!data.state.installed||qq?.running}):''}${button('官方连接指南','napcat-guide',{off})}${button('AstrBot 平台设置','open-panel',{payload:'qq',off:off||!data.state.running})}</div><p class="option-help">不会安装、注入或修改日常使用的官方 QQ。私人记忆与主人管理用于绑定私聊，群聊由 AstrBot 单独配置。</p></div></details>`;
  }
  function updateCard(data) {
    const update=data.workspace.appUpdate||{},off=!desktop(data)||busy(data);
    const channel=updateChannel||update.channel||'alpha',ready=update.canDownload||update.canInstall;
    const active=['app-update-start','app-update-download','app-update-install'].includes(data.pending);
    const current=data.state.appUpdateProgress||update.progress;
    const ratio=Number.isFinite(current?.ratio)?Math.max(0,Math.min(1,current.ratio)):null;
    const percent=ratio===null?'':`${Math.floor(ratio*100)}%`;
    const megabytes=value=>`${(Math.max(0,Number(value)||0)/1024**2).toFixed(1)} MB`;
    const measured=current?.totalBytes>0?`${megabytes(current.receivedBytes)} / ${megabytes(current.totalBytes)}`:'';
    const phases={available:'有新版本',downloaded:'已准备好安装',installed:'更新已完成','up-to-date':'已是最新版本','repair-required':'需要修复环境'};
    const label=current?.label||'正在准备更新';
    const bar=active?`<div class="app-update-progress" id="app-update-progress" role="group" aria-label="更新进度"><div class="update-progress-heading"><span class="spinner" aria-hidden="true"></span><strong>${esc(label)}</strong>${percent?`<span>${esc(percent)}</span>`:''}</div><progress max="1"${ratio!==null&&ratio>0?` value="${ratio}"`:''} aria-label="${esc(label)}"></progress><p>${measured?esc(measured):'请保持应用打开，完成后会提示覆盖安装'}${current?.stage==='downloading'&&ratio===0?' · 正在连接下载服务器…':''}</p></div>`:'';
    const action=ready?button(active?'正在更新…':'更新','app-update-start',{primary:true,id:'app-update-start',off:off||!data.state.installed}):update.recovery?.requiresHealthVerification?button('修复并检查环境','install',{primary:true,off:off||data.state.running}):button('检查更新','app-update-check',{id:'app-update-check',off:off||update.recovery?.servicesMustRemainStopped===true});
    return `<section class="card reliability-card app-update-card" aria-labelledby="app-update-title"${active?' aria-busy="true"':''}><div class="reliability-heading"><div><h2 id="app-update-title">应用更新</h2><p>发现新版后点击更新。下载完成会提示覆盖安装，安装前自动备份本机数据。</p></div>${badge(phases[update.phase]||'自动检查更新',update.error?'warn':'')}</div><dl class="update-versions"><div><dt>当前版本</dt><dd>${esc(update.currentVersion||data.state.version||'待读取')}</dd></div>${ready?`<div><dt>新版本</dt><dd>${esc(update.targetVersion||'待读取')}</dd></div>`:''}</dl>${bar}${update.error?`<p class="recovery-note" role="alert">${esc(update.error.message)}</p>`:''}<div class="card-actions">${action}</div><details class="update-options"><summary>更新选项</summary><label for="app-update-channel">更新通道</label><select id="app-update-channel"${disabled(off)}><option value="stable"${channel==='stable'?' selected':''}>稳定版</option><option value="alpha"${channel==='alpha'?' selected':''}>Alpha 预览版</option></select><p>应用运行时会自动检查新版。下载使用系统网络，更新清单经签名验证、安装包校验完整性；这不替代操作系统签名或系统公证。</p></details></section>`;
  }
  function backupCard(data) {
    const backups=Array.isArray(data.workspace.backups)?data.workspace.backups:[],off=!desktop(data)||busy(data);
    const review=backupReview&&backups.find(item=>item.id===backupReview.id);
    const sizes=value=>Number.isFinite(value)?value<1024**2?`${Math.max(1,Math.round(value/1024))} KB`:`${(value/1024**2).toFixed(1)} MB`:'大小未知';
    return `<section class="card reliability-card" aria-labelledby="automatic-backup-title"><div class="reliability-heading"><div><h2 id="automatic-backup-title">自动备份</h2><p>更新与恢复前创建，包含私人配置与记忆，仅保存在本机。</p></div>${button('刷新列表','backup-list',{off})}</div>${backups.length?`<ul class="backup-list">${backups.map((item,index)=>`<li><span class="tile-icon">${icon('folder')}</span><div><strong>${esc(item.created?new Date(item.created).toLocaleString('zh-CN'):`本机备份 ${index+1}`)}</strong><p>${esc(sizes(item.size))}<span class="row-divider">·</span>${esc({'app-update':'应用更新前','before-app-rollback':'应用回退前','restore':'数据恢复前','import':'数据导入前'}[item.source]||'本机安全备份')}</p></div><div class="card-actions">${button('恢复','backup-review',{item:item.id,operation:'backup-restore',id:`backup-restore-${index}`,off:off||!data.state.installed})}${button('删除','backup-review',{item:item.id,operation:'backup-delete',off})}</div></li>`).join('')}</ul>`:'<p class="reliability-empty">暂无自动备份。你仍可在下方手动创建或导入备份。</p>'}${review?`<div class="inline-review" role="group" aria-labelledby="backup-review-heading"><h3 id="backup-review-heading">${backupReview.operation==='backup-restore'?'确认恢复此备份？':'确认删除此备份？'}</h3><p>${backupReview.operation==='backup-restore'?'当前配置、聊天与记忆会先另行备份，再恢复所选版本。服务会保持停止，供你检查。':'所选备份将从本机删除。请确认已保留需要的数据。'}</p><div class="card-actions">${button(backupReview.operation==='backup-restore'?'确认恢复':'确认删除','backup-confirm',{primary:true,id:'backup-confirm',off})}${button('取消','backup-cancel',{off})}</div></div>`:''}</section>`;
  }
  function networkCard() { return '<p class="footnote">下载跟随系统网络。需要代理时，在 Clash 开启系统代理或 TUN 即可，无需在这里配置。</p>'; }
  function appPreferences(data) {
    const value=preferencesDraft||data.workspace.preferences,off=!desktop(data)||busy(data);
    return `<section class="card reliability-card" aria-labelledby="preferences-title"><div class="reliability-heading"><div><h2 id="preferences-title">启动与后台运行</h2><p>所有选项默认关闭，按你的使用方式开启。</p></div></div>${[['tray','关闭窗口后保留在托盘','保持已启动的本地服务；可从托盘退出。'],['startAtLogin','登录系统后打开应用','仅打开应用，不会自动启动对话服务或安装更新。'],['resumeAfterWake','唤醒后恢复先前运行的服务','仅恢复休眠前由 DSWhale 启动的服务。']].map(([id,title,help])=>`<div class="preference-row"><div><h3 id="pref-${id}-label">${title}</h3><p id="pref-${id}-help">${help}</p></div><label class="switch"><input id="pref-${id}" type="checkbox" aria-labelledby="pref-${id}-label" aria-describedby="pref-${id}-help"${value?.[id]===true?' checked':''}${disabled(off)}><span aria-hidden="true"></span></label></div>`).join('')}<div class="card-actions">${button(preferencesDirty?'保存偏好':'保存应用偏好','save-preferences',{off})}</div></section>`;
  }
  function diagnosticsCard(data) {
    const files=Array.isArray(data.workspace.diagnosticFiles)?data.workspace.diagnosticFiles:[];
    return `<section class="card reliability-card" aria-labelledby="diagnostics-title"><div class="reliability-heading"><div><h2 id="diagnostics-title">诊断报告</h2><p>导出本机检查结果、组件版本与操作事件，便于排查问题。</p></div>${button('导出诊断报告','diagnostics-export',{off:!desktop(data)||busy(data)})}</div><p class="reliability-note">不包含账号、配置值、聊天、记忆、令牌或原始日志。</p>${files.length?`<p class="diagnostic-files">${files.map(file=>`<span>${esc(file)}</span>`).join('')}</p>`:''}</section>`;
  }
  function service(data) {
    if (data.state.phase === 'installing') return { label: '正在准备环境', type: 'working', title: '为下一次对话做好准备。', description: '正在准备独立运行环境，请保持网络连接。' };
    if (data.state.phase === 'checking' || data.pending === 'inspect') return { label: '正在检查', type: 'working', title: '正在了解你的工作空间。', description: '检查运行环境与本地服务状态。' };
    if (data.state.installed) { const view=connectionSummary(data);return {label:view.badge,type:view.tone,title:view.title,description:view.description}; }
    return { label: '尚未准备', type: '', title: '让陪伴，从这里开始。', description: '准备运行环境，连接 QQ，再为 DSWhale 选择一个模型。' };
  }
  function installButton(data) {
    const needsRepair = data.state.components.some(c => ['missing', 'incompatible', 'unknown'].includes(c.status));
    const needsUpdate = data.state.components.some(c => c.status === 'outdated');
    const text = data.state.phase === 'installing' || data.pending === 'install' ? '正在准备…' : !data.state.installed ? '一键准备环境' : needsRepair ? '修复运行环境' : needsUpdate ? '升级运行环境' : '检查并更新环境';
    return button(text, 'install', { primary: true, iconName: 'arrow', off: !desktop(data) || busy(data) || data.state.running || data.state.platform.supported === false });
  }
  function serviceButton(data) {
    return data.state.running ? button(data.pending === 'stop' ? '正在停止…' : '停止对话服务', 'stop', { iconName: 'stop', off: busy(data) || !desktop(data) }) : button(data.pending === 'start' ? '正在启动…' : '启动服务', 'start', { primary: true, iconName: 'play', off: busy(data) || !desktop(data) || !data.state.installed || data.state.platform.supported === false || data.workspace.appUpdate?.recovery?.servicesMustRemainStopped===true });
  }
  function overview(data) {
    const s = service(data);
    // The overview describes the whole workspace, not whichever connection tab
    // the user last visited on the connect page.
    const summary = connectionSummary(data);
    const globalChannel = summary.globalChannel || data.settings?.qqConnectionMode || data.state.qqConnectionMode || data.state.setup?.qqConnectionMode || '';
    const setup = data.state.setup;
    const steps = [
      ['01', '准备运行环境', '自动管理所需工具与依赖', data.state.installed, 'environment', 'environment'],
      ['02', '连接你的 QQ', '选择接入方式并绑定你的私聊', setup.ownerConfigured && setup.qqConfigured, 'connect', 'connect'],
      ['03', '选择模型与记忆', '连接云端模型，延续每一次对话', setup.modelConfigured, 'intelligence', 'intelligence'],
    ];
    return `<section class="page-heading"><div><p class="eyebrow">你的专属工作空间</p><h1>概览</h1><p class="subtitle">把配置交给这里，把时间留给对话。</p></div>${button('刷新状态', 'inspect', { iconName: 'refresh', off: busy(data) || !desktop(data) })}</section>
      <section class="hero"><div class="hero-copy">${badge(s.label, s.type)}<h2>${s.title}</h2><p>${s.description}</p>${data.state.installed?connectionTimeline(data,summary,globalChannel):''}<div class="hero-actions">${data.state.installed ? connectionPrimary(data,true,summary)+(data.state.running?serviceButton(data):'') : installButton(data)}${routeButton('查看 QQ 连接', 'connect')}</div></div><div class="whale-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="whale-glow"></div><img src="whale.svg" alt=""><span class="spark spark-one">✦</span><span class="spark spark-two">✦</span><span class="bubble bubble-one"></span><span class="bubble bubble-two"></span></div></section>
      <div class="section-heading"><h2>开始使用</h2><span>三个步骤，准备好你的 DSWhale</span></div>
      <div class="setup-grid">${steps.map(([num, title, desc, complete, target, glyph]) => `<button class="setup-card" data-route="${target}" type="button"><span class="card-top"><span class="tile-icon ${complete ? 'complete' : ''}">${icon(complete ? 'check' : glyph)}</span><span class="step-number">${complete ? '已完成' : num}</span></span><h3>${title}</h3><p>${desc}</p><span class="card-link">${complete ? '管理设置' : '前往设置'}${icon('arrow')}</span></button>`).join('')}</div>
      <div class="section-heading compact"><h2>工作空间状态</h2></div><section class="card status-list"><div class="status-row"><span class="row-label">${icon('environment')}运行环境</span><span>${data.state.installed ? '已准备' : '等待准备'}<span class="row-divider">·</span>${esc(data.state.platform.label || '未知系统')}</span></div><div class="status-row"><span class="row-label">${icon('play')}对话服务</span>${badge(s.label, s.type)}</div><div class="status-row"><span class="row-label">${icon('shield')}数据存储</span><span>保存在本机${routeButton('管理', 'settings')}</span></div></section>`;
  }
  function progress(data) {
    if (!busy(data)||data.pending==='app-update-start') return '';
    const task=workspaceProgress(data);
    const value = !task&&Number.isFinite(data.state.progress) ? Math.max(0, Math.min(100, data.state.progress <= 1 ? data.state.progress * 100 : data.state.progress)) : null;
    const plugin = extensionProgress(data)||task||(data.pending==='start'?startupProgress(data):'');
    return `<section class="task-status" aria-label="当前任务"><div class="task-line"><span class="spinner" aria-hidden="true"></span><strong>${esc(plugin || data.state.step || (data.pending === 'inspect' ? '正在检查本机环境…' : '正在处理，请稍候…'))}</strong>${value !== null && !plugin ? `<span>${Math.round(value)}%</span>` : ''}</div>${value !== null && !plugin ? `<progress max="100" value="${value}" aria-label="准备进度">${value}%</progress>` : ''}</section>`;
  }
  function environment(data) {
    const labels = { ready: ['已就绪', 'good'], missing: ['待安装', ''], outdated: ['可升级', 'warn'], incompatible: ['需修复', 'warn'], unknown: ['待检查', ''] };
    return `<section class="page-heading"><div><p class="eyebrow">独立环境 · 自动管理</p><h1>运行环境</h1><p class="subtitle">准备好所需工具，安心开始。</p></div>${button('重新检查', 'inspect', { iconName: 'refresh', off: busy(data) || !desktop(data) })}</section>
      <section class="card environment-summary"><span class="large-tile">${icon('environment')}</span><div><h2>${data.state.installed ? '运行环境已准备' : '为 DSWhale 准备独立环境'}</h2><p>兼容工具会自动复用，其余依赖安装到应用数据目录。</p><span class="system-label">${esc(data.state.platform.label || '未知系统')}</span></div>${installButton(data)}</section>
      ${data.state.platform.supported === false ? `<div class="alert error" role="alert"><strong>当前系统暂不支持</strong><p>${esc(data.state.platform.detail || '请使用受支持的系统与处理器架构。')}</p></div>` : ''}
      ${data.state.running ? '<p class="inline-note">请先停止服务，再更新或修复环境。</p>' : ''}${progress(data)}
      <div class="section-heading"><h2>环境组件</h2><span>${data.state.components.length ? `${data.state.components.length} 项` : '检查后显示'}</span></div><section class="card component-table"><table><thead><tr><th scope="col">组件</th><th scope="col">版本</th><th scope="col">状态</th></tr></thead><tbody>${data.state.components.length ? data.state.components.map(c => { const status = labels[c.status] || labels.unknown; return `<tr><td><strong>${esc(c.label)}</strong><span class="component-detail">${esc(c.detail)}</span></td><td class="version-text">${esc(c.version || '—')}</td><td>${badge(status[0], status[1])}</td></tr>`; }).join('') : '<tr><td colspan="3" class="empty-state">尚无检查结果。点击「重新检查」获取本机状态。</td></tr>'}</tbody></table></section>${versionMatrix(data)}${healthCard(data)}<p class="footnote">${icon('shield')}环境准备不会启动对话服务。升级应用时，会保留你的配置、记忆和备份。</p>`;
  }
  function connectionModePicker(data,value){
    const mode=controller.get().connectionTab||value.qqConnectionMode||'napcat',off=!desktop(data)||busy(data);
    const summary=id=>connectionViewModel({...data,connectionTab:id}).badge;
    return `<div class="connection-mode-picker" role="tablist" aria-label="QQ 接入方式">${[['official','QQ 官方机器人','适合同一台电脑使用，不需要 NapCat'],['napcat','普通 QQ 小号','通过独立 NapCat，支持签名与空间']].map(([id,title,note])=>`<button type="button" role="tab" data-action="select-qq-mode" data-mode="${id}" aria-selected="${mode===id}" aria-pressed="${mode===id}" class="${mode===id?'selected':''}"${disabled(off)}><strong>${title}<em>${esc(summary(id))}</em></strong><span>${note}</span></button>`).join('')}</div>`;
  }
  function connectionChannelCards(data) {
    const conn=data.connections;
    if(!conn||!Array.isArray(conn.channels))return '';
    const targetState=entry=>entry.targetIssue==='ambiguous'?'待确认':entry.targetIssue==='missing-bound'?'绑定失效':entry.targetIssue==='missing'?'未配置':'';
    const unconfigured=entry=>!targetState(entry)&&entry.configured===false;
    const stateText=entry=>targetState(entry)||(unconfigured(entry)?'待配置':!entry.platformEnabled?'已停用':entry.health==='connected'?'已连接':entry.health==='connecting'?'连接中':entry.health==='offline'?'离线':entry.bound?'等待验证':'待绑定');
    const platformText=entry=>targetState(entry)||(entry.platformEnabled?'已启用':'已停用');
    const healthText=entry=>targetState(entry)||(unconfigured(entry)?'未配置':({connected:'已连接',connecting:'连接中',offline:'离线',unknown:'未知',disabled:'未启用'}[entry.health]||entry.health));
    const off=!desktop(data)||busy(data);
    const unconfiguredText=entry=>entry.channel==='napcat'?'该实例尚未填写 OneBot 反向 WebSocket 端口或访问令牌，请先在 AstrBot 平台设置中检查 OneBot 参数。':'该实例尚未填写 AppID/AppSecret，请先在 AstrBot 平台设置中完成配置。';
    const issueText=entry=>entry.targetIssue==='ambiguous'?'存在多个同类型平台，请先确认或清理平台设置。':entry.targetIssue==='missing-bound'?'绑定的平台实例已不存在，请重新完成主人绑定。':entry.targetIssue==='missing'?'没有找到可用的平台实例，请先完成连接配置。':unconfigured(entry)?unconfiguredText(entry):'';
    const liveOfficial=data.workspace?.official,liveNapcat=data.workspace?.napcat;
    const freshChannels=conn.channels.map(entry=>{
      if(entry.platformEnabled===false)return {...entry,protocolConnected:false,health:'disabled'};
      if(entry.channel==='official'&&liveOfficial&&typeof liveOfficial.protocolConnected==='boolean')return {...entry,protocolConnected:liveOfficial.protocolConnected,health:liveOfficial.protocolConnected?'connected':'offline'};
      if(entry.channel==='napcat'&&liveNapcat){
        const protocol=liveNapcat.protocolConnected===true;
        return {...entry,protocolConnected:protocol,health:protocol?'connected':(liveNapcat.running&&liveNapcat.loginState==='online'?'connecting':'offline')};
      }
      return entry;
    });
    const onlyOneEnabled=freshChannels.filter(entry=>entry.platformEnabled).length===1;
    const cards=freshChannels.map(entry=>`<section class="card connection-channel-card" aria-labelledby="connection-${entry.channel}-title"><div class="connection-channel-heading"><div><h3 id="connection-${entry.channel}-title">${esc(entry.label)}</h3><p>${entry.channel==='napcat'?'通过独立 NapCat 接入普通 QQ 小号':'通过 QQ 官方 WebSocket 接入'}</p></div>${badge(stateText(entry),targetState(entry)||unconfigured(entry)?'warn':entry.platformEnabled&&(entry.healthy===true||entry.health==='connected')?'good':entry.platformEnabled?'warn':'')}</div><dl class="connection-channel-facts"><div><dt>平台</dt><dd>${esc(platformText(entry))}</dd></div><div><dt>实例</dt><dd>${esc(entry.platformId||'未确定')}</dd></div><div><dt>主人绑定</dt><dd>${entry.bound?'已绑定':'未绑定'}</dd></div><div><dt>消息连接</dt><dd>${esc(healthText(entry))}</dd></div></dl>${issueText(entry)?`<p class="option-help">${esc(issueText(entry))}</p>`:''}<button type="button" class="button${entry.platformEnabled?'':' primary'}" data-action="connection-change" data-channel="${entry.channel}" data-enabled="${entry.platformEnabled?'0':'1'}"${entry.platformEnabled&&onlyOneEnabled?' aria-describedby="connection-last-rule"':''}${disabled(off||Boolean(entry.targetIssue)||(unconfigured(entry)&&!entry.platformEnabled)||(entry.platformEnabled&&onlyOneEnabled))}><span>${entry.platformEnabled?'停用连接':'启用连接'}</span></button></section>`).join('');
    const preview=data.connectionPreview;
    const lastRule=onlyOneEnabled?'<p class="inline-note connection-last-rule" id="connection-last-rule">仅剩一路可用的 QQ 连接时，无法停用最后一条渠道；如要切换，请先启用并确认另一条连接。停用渠道会断开该渠道的消息连接；“停止对话”只停止对话服务，不会停用任何已启用的渠道。</p>':'';
    const confirm=preview?`<section class="card connection-confirm" role="group" aria-labelledby="connection-confirm-title"><h3 id="connection-confirm-title">确认${preview.enabled?'启用':'停用'} ${esc(preview.label)}</h3><p>${esc(preview.message||'')}</p><ul>${(preview.effects||[]).map(effect=>`<li>${esc(effect)}</li>`).join('')}</ul><label for="connection-confirm-typed">${esc(preview.prompt||'请输入确认文字')}</label><input id="connection-confirm-typed" type="text" maxlength="8" autocomplete="off"><div class="card-actions"><button type="button" class="button primary" data-action="connection-confirm"${disabled(busy(data)||!desktop(data))}><span>确认</span></button><button type="button" class="button" data-action="connection-cancel"${disabled(busy(data))}><span>取消</span></button></div></section>`:'';
    return `<div class="section-heading"><h2>连接管理</h2><span>两路可同时在线，各自保存身份与消息</span></div>${lastRule}${!freshChannels.some(entry=>entry.platformEnabled)?'<p class="inline-note">暂无启用的 QQ 连接。完成下方配置后启用。</p>':''}<div class="connection-channel-grid">${cards}</div>${confirm}`;
  }
  function connect(data) {
    const value = draft || data.settings;
    if (!value) return `<section class="page-heading"><div><h1>QQ 连接</h1><p class="subtitle">正在读取连接设置。</p></div></section><section class="card loading-card">${settingsLoading ? '<span class="spinner" aria-hidden="true"></span> 正在读取…' : button('重新读取','settings-get',{off:!desktop(data)||busy(data)})}</section>`;
    const qq=data.workspace.napcat,view=connectionViewModel(data),global=connectionSummary(data);
    return `<section class="page-heading connection-page-heading"><div><h1>QQ 连接</h1><p class="subtitle">一次设置，之后按状态继续即可。</p></div>${button('检查状态','workspace-status',{iconName:'refresh',off:!desktop(data)||busy(data)})}</section>
      <section class="hero"><div class="hero-copy">${badge(global.badge,global.tone)}<h2>${esc(global.title)}</h2><p>${esc(global.description)}</p></div>${global.action?`<div class="hero-actions">${button(global.actionLabel,global.action,{primary:true,payload:global.panel||'',channel:global.channel||'',enabled:global.enabled,iconName:'arrow',off:!desktop(data)||busy(data)})}</div>`:''}</section>
      ${connectionModePicker(data,value)}<form id="connection-form">${napcatCard(data)}${qq?.externalOnly||externalGuideOpen?`<details class="card external-connection-help" id="external-connection-help"${externalGuideOpen?' open':''}><summary>外部协议端接入步骤</summary><ol><li>在外部 NapCat 或其他 OneBot 协议端登录机器人账号。</li><li>添加反向 WebSocket 连接：<code>ws://127.0.0.1:${esc(value.onebotPort)}/ws</code>，令牌与下方连接选项保持一致。</li><li>保持协议端运行，回到这里检查消息连接。</li></ol>${button('官方接入指南','napcat-guide',{off:!desktop(data)||busy(data)})}</details>`:''}${connectionOptions(data,value)}</form>
      ${connectionChannelCards(data)}
      <p class="connection-footnote">${view.stage==='ready'?'连接已建立。日常在概览页管理对话即可。':'登录数据保存在本机。停止对话服务会保留 QQ 连接，退出应用会停止由它管理的组件。'}</p>`;
  }
  function extensionCard(data, id) {
    const value = data.extensions?.[id];
    const checked = data.extensionChecks[id];
    const updating = data.pendingExtension === id;
    const off = !desktop(data) || busy(data) || !data.state.installed || !value;
    const canUpdate = checked && value?.canUpdate === true;
    const label = !value ? '待读取' : canUpdate ? value.installed ? '可更新' : '可安装' : checked ? '已检查' : value.installed ? '已安装' : '可选安装';
    const failed = data.error && data.retry?.payload?.id === id;
    const review = extensionReview === id;
    const current = !value ? extensionsLoading ? '正在读取' : '尚未读取' : value.installed ? value.version || '版本未知' : '未安装';
    const latest = value?.latest || (checked ? '暂无可用版本' : '点击检查更新');
    return `<section class="card extension-card" aria-labelledby="extension-${id}-title" aria-busy="${updating}"><div class="extension-heading"><span class="tile-icon${id === 'memory' ? ' complete' : ''}">${icon(id === 'memory' ? 'intelligence' : 'folder')}</span><div><h3 id="extension-${id}-title">${extensionName(id)}</h3><p>${id === 'memory' ? '长期记忆 · 独立管理插件版本' : '可选扩展 · 按需安装与管理表情包'}</p></div>${badge(label, canUpdate ? 'warn' : value?.installed ? 'good' : '')}</div>
      <dl class="extension-versions"><div><dt>当前版本</dt><dd>${esc(current)}</dd></div><div><dt>最新版本</dt><dd>${esc(latest)}</dd></div></dl>
      <p class="extension-note">更新或安装会自动备份、停止服务，保留配置与数据。完成后请检查设置，再手动启动服务。</p>
      ${review ? `<div class="extension-review" role="group" aria-labelledby="extension-${id}-review"><strong id="extension-${id}-review">确认回退${extensionName(id)}？</strong><p>将停止服务并恢复上次插件备份。完成后服务保持停止，供你检查。</p><div class="extension-actions">${button('确认回退', 'extension-confirm', { id: `extension-confirm-${id}`, extension: id, primary: true, off })}${button('取消', 'extension-cancel', { id: `extension-cancel-${id}`, extension: id, off: busy(data) })}</div></div>` : `<div class="extension-actions">${button(updating && data.pending === 'extension-check' ? '正在检查…' : '检查更新', 'extension-check', { id: `extension-check-${id}`, extension: id, iconName: 'refresh', off })}${canUpdate ? button(updating && data.pending === 'extension-update' ? '正在处理…' : value.installed ? '更新插件' : '安装插件', 'extension-update', { id: `extension-update-${id}`, extension: id, primary: true, off }) : ''}${value?.canRollback === true ? button('回退版本', 'extension-review', { id: `extension-rollback-${id}`, extension: id, operation: 'extension-rollback', off }) : ''}</div>`}
      ${updating ? `<p class="extension-feedback" role="status"><span class="spinner" aria-hidden="true"></span>${esc(extensionProgress(data))}</p>` : failed ? `<div class="extension-feedback extension-error" role="alert"><span>${esc(data.error)}</span>${button('重试', 'retry', { extension: id, off: busy(data) })}</div>` : extensionMessage?.id === id ? `<p class="extension-feedback" role="status">${esc(extensionMessage.text)}</p>` : ''}</section>`;
  }
  function extensions(data) {
    return `<div class="section-heading"><h2>插件管理</h2><span>独立更新，无需升级应用</span></div><p class="extension-intro">打开此页只读取本机状态；点击「检查更新」后才会联网查找版本。</p>${extensionsLoading ? '<p class="extension-feedback" role="status"><span class="spinner" aria-hidden="true"></span>正在读取本机插件状态…</p>' : ''}<div class="extension-grid">${extensionCard(data, 'memory')}${extensionCard(data, 'memes')}</div>${!data.extensions && !extensionsLoading ? `<p class="inline-note">未能读取插件状态。${button('重试读取', 'extensions-status', { off: !desktop(data) || busy(data) })}</p>` : ''}`;
  }
  function replyStyleCard(data) {
    const value = draft || data.settings;
    if (!value) return `<section class="card reply-style-card"><div class="section-heading"><h2>人格与回复方式</h2></div><p class="inline-note">${settingsLoading ? '<span class="spinner" aria-hidden="true"></span> 正在读取…' : '正在读取本机回复方式。'}${button('重新读取', 'settings-get', { off: !desktop(data) || busy(data) })}</p></section>`;
    const off = !desktop(data) || busy(data);
    const mode = value.replyStyleMode || 'inherit';
    const custom = mode === 'custom';
    const personas = value.persona ? [{ label: 'DSWhale 补充人格', source: '自定义', text: value.persona }] : [{ label: 'DSWhale 补充人格', source: '内置默认', text: '' }];
    const persona = personas[0];
    const firstLine = persona.text ? persona.text.split(/\r?\n/)[0].slice(0, 80) : '内置默认人格（可爱大肥鱼）';
    const preview = replyStylePreviewResult;
    return `<div class="section-heading"><h2>人格与回复方式</h2><span>原人格不改写，回复方式独立保存</span></div>
      <section class="card reply-style-card">
        <div class="persona-sources"><h3>人格来源</h3><dl class="connection-channel-facts"><div><dt>${esc(persona.label)}</dt><dd>${esc(persona.source)} · ${persona.text.length} 字符</dd></div><div><dt>适用聊天</dt><dd>仅 DSWhale 授权的私聊与主人会话</dd></div><div><dt>宿主基础人格</dt><dd>由 AstrBot 全局人格提供；DSWhale 只在其后追加，不替换</dd></div></dl><p class="option-help">${esc(firstLine)}</p>${persona.text ? `<details class="reply-persona-full"><summary>查看完整人格文本（仅本机）</summary><pre>${esc(persona.text)}</pre></details>` : ''}</div>
        <h3>回复方式</h3>
        <div class="reply-style-modes" role="group" aria-label="回复方式">${[['inherit','沿用现有','由 AstrBot 决定分段与流式，DSWhale 不额外拆分'],['natural','自然短句','收齐完整回复后按语义分成 1–3 条'],['single','整段发送','合并为一条，不再被普通分段或流式拆开'],['custom','自定义','使用下方 Python 正则拆分；保存前校验']].map(([id,title,help])=>`<button type="button" class="button${mode===id?' primary':''}" data-action="reply-style-mode" data-mode="${id}" aria-pressed="${mode===id}"${disabled(off)}><span>${title}</span></button>`).join('')}</div>
        ${value.hostReplyPrefix||value.hostTtsEnabled?`<p class="option-help" role="note">宿主已配置${value.hostReplyPrefix?'回复前缀':''}${value.hostReplyPrefix&&value.hostTtsEnabled?'和':''}${value.hostTtsEnabled?'TTS':''}；运行时会把最终发送交还宿主，预览会标记实际回退路径。</p>`:''}
        <p class="option-help">${mode==='inherit'?'保持现状：不接管发送，也不改写宿主的分段、流式或间隔设置。':mode==='natural'?'会先收齐完整回复再发送，首字延迟可能增加；模型仍可能不严格遵守 1–3 条。':mode==='single'?'会接管最终发送；图片、引用、@、语音或混合链会回退宿主，页面会显示实际路径。':'自定义规则由 Python 正则执行；只接受可信规则，复杂规则仍有性能风险。'}</p>
        <div class="settings-grid"><label for="replyStyleMaxBubbles">最多几条<input id="replyStyleMaxBubbles" type="number" min="1" max="3" step="1" value="${esc(value.replyStyleMaxBubbles??3)}"${disabled(off||mode==='inherit'||mode==='single'||mode==='custom')}></label><label for="replyStyleInterval">发送间隔（秒）<input id="replyStyleInterval" type="text" value="${esc(value.replyStyleInterval||'0.8,1.5')}"${disabled(off||mode==='inherit')}></label><label for="replyStylePunctuation">句尾标点<select id="replyStylePunctuation"${disabled(off||mode==='inherit')}><option value="keep"${value.replyStylePunctuation!=='sentence_end'?' selected':''}>保留原标点</option><option value="sentence_end"${value.replyStylePunctuation==='sentence_end'?' selected':''}>去掉每条末尾一个句号</option></select></label><label class="switch-row"><input id="replyStylePrompt" type="checkbox"${value.replyStylePrompt!==false?' checked':''}${disabled(off||mode==='inherit')}><span>在授权聊天中附加一次排版提示</span></label></div>
        <details class="reply-style-advanced"${custom?' open':''}><summary>自定义规则与高级选项</summary><label for="replyStyleCustomRegex">拆分规则（Python 正则）<textarea id="replyStyleCustomRegex" rows="2" maxlength="200"${disabled(off)}>${esc(value.replyStyleCustomRegex||'')}</textarea></label><label for="replyStyleCustomCleanup">清理规则（可选，只在受保护区间外删除）<textarea id="replyStyleCustomCleanup" rows="2" maxlength="200"${disabled(off)}>${esc(value.replyStyleCustomCleanup||'')}</textarea></label><p class="option-help">不能包含捕获组、不能匹配空字符串；示例：[^\\n]+。保存后重载插件生效。</p></details>
        <div class="reply-style-preview"><label for="replyStylePreviewText">离线预览（不调用模型或 QQ，不保存正文）<textarea id="replyStylePreviewText" rows="3" placeholder="粘贴一段合成文字，查看将如何分条。">${esc(replyStylePreviewText)}</textarea></label><div class="card-actions">${button('生成预览', 'reply-style-preview', {off})}${button('恢复回复方式默认值', 'reply-style-reset', {off})}${button('保存回复方式', 'save-settings', {primary:true,off})}</div>${preview?`<div class="reply-style-preview-result" role="status"><strong>${preview.computed===false?'条数未计算':`${esc(preview.count)} 条`} · ${preview.path==='plugin'?'DSWhale 接管':'沿用宿主'} · ${esc(preview.hostPath||'')}</strong>${preview.computed===false?`<p class="option-help">${esc(({host_owned:'发送由宿主装饰，条数由宿主决定',profile_unknown:'无法唯一确定宿主配置档',config_missing:'宿主配置档不存在',host_regex_timeout:'宿主分段规则执行超时，正文将整段发送'}[preview.uncomputedReason]||'当前无法计算实际条数'))}</p>`:`<ol>${(preview.bubbles||[]).map(bubble=>`<li>${esc(bubble)}</li>`).join('')}</ol>`}${(preview.warnings||[]).length?`<p class="option-help">保护/回退：${esc(preview.warnings.join('、'))}</p>`:''}${preview.hostSource?`<p class="option-help">宿主配置：${esc(preview.hostSource.profileId||'')} · ${esc(preview.hostSource.platform||'')} · 分段${preview.hostSource.segmented?.enable?'开':'关'}</p>`:''}</div>`:''}</div>
      </section>`;
  }
  function intelligence(data) {
    const off = !data.state.running || !desktop(data) || busy(data);
    return `<section class="page-heading"><div><p class="eyebrow">每一次对话，都更懂你</p><h1>模型与记忆</h1><p class="subtitle">连接云端模型，让记忆自然延续。</p></div></section><div class="feature-grid"><section class="card feature-card"><span class="feature-icon lavender">${icon('intelligence')}</span>${badge(data.state.setup.modelConfigured ? '已配置' : '待配置', data.state.setup.modelConfigured ? 'good' : '')}<h2>对话模型</h2><p>在 AstrBot 中管理模型服务商、API 密钥、模型选择与对话能力。</p><ul><li>使用现有的云端模型服务</li><li>无需下载本地模型权重</li></ul>${button('配置模型', 'open-panel', { primary: true, payload: 'models', iconName: 'arrow', off })}</section><section class="card feature-card"><span class="feature-icon mint">${icon('environment')}</span>${badge(data.state.setup.memoryConfigured ? '已配置' : '待配置', data.state.setup.memoryConfigured ? 'good' : '')}<h2>长期记忆</h2><p>在记忆插件中管理检索、总结与记忆设置，让重要的细节留下来。</p><ul><li>沿用现有记忆与插件配置</li><li>在同一个窗口中完成管理</li></ul>${button('管理记忆', 'open-panel', { payload: 'memory', iconName: 'arrow', off })}</section></div>${replyStyleCard(data)}${extensions(data)}${!data.state.running ? `<section class="info-strip">${icon('play')}<div><strong>先启动对话服务</strong><p>${data.state.installed ? '启动后，即可在当前窗口打开模型和记忆控制台。' : '请先准备运行环境，然后启动服务。'}</p></div>${data.state.installed ? serviceButton(data) : button('准备环境', 'route-environment', { primary: true, iconName: 'arrow' })}</section>` : `<section class="info-strip">${icon('shield')}<div><strong>完整配置，留在当前窗口。</strong><p>模型、插件与高级设置均通过现有 AstrBot 控制台管理。</p></div>${button('打开控制台', 'open-panel', { payload: 'astrbot', off })}</section>`}`;
  }
  function bilibili(data) {
    const value = draft || data.settings;
    return `<section class="page-heading"><div><p class="eyebrow">发现更多感兴趣的内容</p><h1>哔哩哔哩</h1><p class="subtitle">管理关注、动态与视频相关能力。</p></div>${badge(data.state.setup.biliEnabled ? '已启用' : '未启用', data.state.setup.biliEnabled ? 'good' : '')}</section><section class="card bili-card"><span class="feature-icon pink">${icon('bilibili')}</span><h2>把喜欢的内容，带进对话。</h2><p>在完整设置面板中管理登录状态、关注与订阅规则。<br>沿用现有配置，在当前窗口继续操作。</p>${button('打开哔哩哔哩设置', 'open-panel', { primary: true, payload: 'bilibili', iconName: 'arrow', off: !desktop(data) || !data.state.running || busy(data) })}</section><section class="card preference-card"><div><h3>启用哔哩哔哩功能</h3><p>保存后生效。登录与详细订阅请在完整设置中管理。</p></div><label class="switch"><input id="biliEnabled" type="checkbox"${(value?.biliEnabled ?? data.state.setup.biliEnabled) ? ' checked' : ''}${disabled(!desktop(data) || !value || busy(data))}><span aria-hidden="true"></span><span class="sr-only">启用哔哩哔哩功能</span></label></section>${dirtyFields.size ? `<div class="form-footer"><p>有未保存的更改</p>${button('保存设置', 'save-settings', { primary: true, off: !desktop(data) || busy(data) })}</div>` : ''}${!data.state.running ? '<p class="footnote">启动服务后，可打开完整哔哩哔哩设置。</p>' : ''}${healthCard(data,true)}`;
  }
  const settingLabels={dashboardPort:'控制台端口',ownerQQ:'主人 QQ',qqConnectionMode:'接入方式',officialOwnerUMO:'官方私聊绑定',platformId:'平台标识',onebotPort:'OneBot 端口',biliEnabled:'B站整合',proactiveEnabled:'主动互动',signatureEnabled:'QQ 个性签名',qzoneEnabled:'QQ 空间',defaultDelivery:'主动消息渠道'};
  function settingsHistoryCard(data) {
    const history=data.settingsHistory;
    if(!history||!Array.isArray(history.records))return '';
    const records=history.records.slice(0,3);
    const receipt=history.migrationReceipt;
    const revision=data.settings?.configRevision||'';
    const off=!desktop(data)||busy(data)||!revision;
    const label=field=>settingLabels[field]||field;
    return `<div class="section-heading"><h2>最近修改</h2><span>只保存在本机，可按字段恢复</span></div><section class="card settings-history">${receipt?`<p class="reliability-note">升级保护检查：迁移版本 ${esc(String(receipt.migrationVersion??'—'))}，归档旧字段 ${Array.isArray(receipt.archivedFields)?receipt.archivedFields.length:0} 项${receipt.verifiedAt?`，最近校验 ${esc(new Date(receipt.verifiedAt*1000).toLocaleString('zh-CN'))}`:''}。</p>`:''}${records.length?`<ul>${records.map(record=>`<li><div><strong>${esc(new Date((record.changedAt||0)*1000).toLocaleString('zh-CN'))}</strong><p>${record.changes.map(change=>esc(label(change.field))).join('、')}</p></div><div class="card-actions">${record.changes.filter(change=>change.field!=='onebotToken').slice(0,2).map(change=>`<button type="button" class="button" data-action="settings-restore-field" data-record="${esc(record.id)}" data-field="${esc(change.field)}"${disabled(off)}><span>恢复${esc(label(change.field))}</span></button>`).join('')}</div></li>`).join('')}</ul>`:'<p class="reliability-empty">还没有可恢复的本机设置修改。</p>'}</section>`;
  }
  function settings(data) {
    const off=!desktop(data)||busy(data);
    return `<section class="page-heading"><div><p class="eyebrow">你的数据，由你掌握</p><h1>应用设置</h1><p class="subtitle">管理应用更新、备份与日常运行。</p></div>${button('刷新本机状态','workspace-status',{off})}</section>
      ${!data.workspaceLoaded&&!workspaceLoading?`<p class="inline-note">本机状态尚未读取。${button('重试读取','workspace-status',{off})}</p>`:''}
      ${updateCard(data)}${versionMatrix(data)}${networkCard(data)}${appPreferences(data)}${backupCard(data)}${settingsHistoryCard(data)}
      <div class="section-heading"><h2>本机数据</h2></div><section class="card settings-list"><div class="settings-row"><span class="tile-icon">${icon('shield')}</span><div><h3>控制台首次登录</h3><p>在系统对话框中查看或复制口令，口令不会进入此页面。</p></div>${button('首次登录口令','initial-login',{off:off||!data.state.installed})}</div><div class="settings-row"><span class="tile-icon">${icon('folder')}</span><div><h3>数据文件夹</h3><p>查看本地配置、记忆、独立环境与备份。</p></div>${button('打开文件夹','open-data',{off})}</div><div class="settings-row"><span class="tile-icon">${icon('shield')}</span><div><h3>创建数据备份</h3><p>将私人数据另存为 ZIP 备份，便于迁移与恢复。</p></div>${button(data.pending==='backup'?'正在备份…':'立即备份','backup',{off:off||!data.state.installed})}</div><div class="settings-row"><span class="tile-icon">${icon('folder')}</span><div><h3>导入数据备份</h3><p>导入自己的 DSWhale ZIP 备份；操作前保留当前数据，完成后检查环境与连接。</p></div>${button(data.pending==='restore'?'正在导入…':'导入备份','restore',{off:off||!data.state.installed})}</div></section>
      ${diagnosticsCard(data)}<div class="section-heading"><h2>关于 DSWhale</h2></div><section class="card about-card"><img src="whale.svg" alt="DSWhale 鲸鱼标志"><div><h2>DSWhale</h2><p>让陪伴，在每一次对话中发生。</p><span class="version-text">${data.state.version?`版本 ${esc(data.state.version)}`:'桌面应用'}<span class="row-divider">·</span>${esc(data.state.platform.label||'本地工作空间')}</span></div><span class="local-label">${icon('shield')}本地工作空间</span></section>`;
  }
  function render(data) {
    if (composing) { deferredData = data; return; }
    const focused = document.activeElement?.id;
    const focusAction = document.activeElement?.dataset?.action;
    const focusPanel = document.activeElement?.dataset?.panel;
    const focusExtension = document.activeElement?.dataset?.extension;
    const focusRoute = document.activeElement?.dataset?.route;
    if (data.pending && !pendingFocus && (focused || focusAction)) pendingFocus = { id: focused, action: focusAction, panel: focusPanel, extension: focusExtension };
    const selection = document.activeElement && 'selectionStart' in document.activeElement ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const scroll = document.querySelector('.page')?.scrollTop || 0;
    const panel = data.state.panel;
    const status = service(data);
    const nav = Object.entries(routeNames).map(([id, label]) => `<button type="button" class="nav-item${route === id ? ' active' : ''}" data-route="${id}"${route === id ? ' aria-current="page"' : ''}>${icon(id)}<span>${label}</span>${id === 'environment' && !data.state.installed ? '<span class="nav-dot" aria-label="待准备"></span>' : ''}${id === 'settings' && (data.workspace.appUpdate?.canDownload||data.workspace.appUpdate?.canInstall) ? '<span class="nav-dot" role="img" aria-label="有应用更新"></span>' : ''}</button>`).join('');
    const preview = data.mode === 'preview' ? '<div class="mode-banner">界面预览 · 示例数据 · 所有设备操作已禁用</div>' : '';
    const rawError = data.error || data.state.error;
    // "关闭提示" records the exact message that was on screen. Hide only that
    // message; the underlying state.error (a real main-process fault) stays
    // published and a different/new error is still shown immediately.
    const error = rawError && rawError !== data.dismissedError ? rawError : '';
    const feedback = error ? `<div class="alert error" role="alert"><span class="alert-symbol">!</span><div><strong>操作未完成</strong><p>${esc(error)}</p></div>${settingsConflict && data.settings ? button('重新读取并保留修改', 'settings-get', { off: busy(data) || !desktop(data) }) : ''}${data.retry ? button('重试', 'retry', { off: busy(data) || !desktop(data) }) : ''}${button('关闭提示', 'dismiss-error', { off: false })}</div>` : localMessage||data.notice ? `<div class="alert success" role="status">${icon('check')}<span>${esc(localMessage||data.notice)}</span></div>` : '';
    const views = { overview, environment, connect, intelligence, bilibili, settings };
    const content = data.mode === 'unavailable' ? `<section class="desktop-notice card"><img src="whale.svg" alt="DSWhale"><h1>请在桌面应用中打开</h1><p>运行环境、对话服务和本地设置需要 DSWhale 桌面应用。</p><p class="footnote">当前页面未连接桌面服务，无法读取或修改本机配置。</p></section>` : views[route](data);
    const markup = `<aside class="sidebar" aria-label="主导航"><div class="window-space"></div><div class="brand"><div class="brand-mark"><img src="whale.svg" alt=""></div><div><strong>DSWhale</strong><span>你的对话伙伴</span></div></div><div class="nav-label">工作空间</div><nav>${nav}</nav><div class="sidebar-bottom"><div class="sidebar-service"><span class="status-dot ${status.type==='good'?'good':status.type==='working'?'working':''}"></span><div><strong>${esc(status.label)}</strong><span>${data.state.running ? '对话服务已启动' : '对话服务尚未启动'}</span></div></div><div class="sidebar-version"><span>DSWhale Desktop</span><span>${esc(data.state.version || '')}</span></div></div></aside><div class="workspace"><header class="topbar"><div class="breadcrumb"><span>工作空间</span><span class="breadcrumb-slash">/</span><strong>${esc(panel ? panelNames[panel] || '控制台' : routeNames[route])}</strong></div><div class="topbar-right">${data.mode === 'preview' ? '<span class="preview-pill">只读预览</span>' : ''}<span class="topbar-status"><span class="status-dot ${data.state.running ? 'good' : ''}"></span>${esc(data.state.running ? '对话服务已启动' : '对话服务尚未启动')}</span></div></header>${panel ? `<main class="embedded" id="main-content" tabindex="-1"><div class="panel-toolbar"><button type="button" data-action="home" class="panel-back">${icon('back')}返回${esc(routeNames[route])}</button><div class="panel-toolbar-actions"><span class="panel-context">${esc(panelNames[panel] || '控制台')}${['astrbot','models','memory','qq'].includes(panel)?'<small>内核由 DSWhale 统一管理，更新请到应用设置</small>':''}</span>${button(panel==='napcat'?'QQ 管理口令':'控制台首次口令',panel==='napcat'?'napcat-login-code':'initial-login',{off:!desktop(data)||!data.state.installed||busy(data)})}</div></div><div class="embedded-placeholder"><span class="spinner" aria-hidden="true"></span><p>正在显示控制台…</p></div>${feedback ? `<div class="panel-feedback">${feedback}</div>` : ''}</main>` : `<main class="page" id="main-content" tabindex="-1">${preview}${feedback}${content}${route !== 'environment' ? progress(data) : ''}<footer class="page-footer"><span class="footer-line"></span><span>DSWhale · 让对话更有温度</span><span class="footer-line"></span></footer></main>`}</div>`;
    if (markup === lastMarkup) return;
    lastMarkup = markup;
    root.innerHTML = markup;
    const page = document.querySelector('.page');
    if (page) page.scrollTop = scroll;
    if (focused) { const next = document.getElementById(focused); if (next) { next.focus({ preventScroll: true }); if (selection && typeof next.setSelectionRange === 'function' && next.type !== 'number') { try { next.setSelectionRange(...selection); } catch {} } } }
    if (!focused && (focusAction || focusRoute)) {
      const next = [...root.querySelectorAll('button')].find(item => focusRoute ? item.dataset.route === focusRoute : item.dataset.action === focusAction && item.dataset.panel === focusPanel && item.dataset.extension === focusExtension);
      if (next && !next.disabled) next.focus({ preventScroll: true });
    }
    if (!data.pending && pendingFocus) {
      if (!document.activeElement || document.activeElement === document.body) {
        const next = (pendingFocus.id ? document.getElementById(pendingFocus.id) : [...root.querySelectorAll('button')].find(item => item.dataset.action === pendingFocus.action && item.dataset.panel === pendingFocus.panel && item.dataset.extension === pendingFocus.extension)) || (pendingFocus.extension && document.getElementById(`extension-check-${pendingFocus.extension}`));
        if (next && !next.disabled) next.focus({ preventScroll: true });
      }
      pendingFocus = null;
    }
    const announcement = error || localMessage || extensionMessage?.text || data.notice || extensionProgress(data) || workspaceProgress(data) || (data.pending==='start'&&startupProgress(data)) || (busy(data) && data.state.step) || status.label;
    if (announcement !== lastAnnouncement) { document.getElementById('announcer').textContent = announcement; lastAnnouncement = announcement; }
  }
  async function run(action, payload) {
    extensionMessage = null;
    localMessage='';
    try {
      const result = await controller.act(action, payload);
      if (['restore','backup-restore'].includes(action) && !result?.canceled) { draft = null; draftBase = null; dirtyFields.clear(); conflictFields.clear(); overwritePending = false; reveal = false; render(controller.get()); }
      return result;
    } catch { /* Visible error and retry are rendered by the controller. */ }
  }
  async function ensureSettings() {
    const data = controller.get();
    if (!['connect', 'bilibili', 'settings', 'intelligence'].includes(route) || data.settings || settingsLoading || data.mode !== 'desktop') return;
    settingsLoading = true; render(data);
    await run('settings-get');
    settingsLoading = false;
    if (controller.get().settings) adoptSettings(controller.get().settings);
    render(controller.get());
  }
  async function ensureExtensions() {
    const data = controller.get();
    if (route !== 'intelligence' || data.extensions || extensionsLoading || data.mode !== 'desktop') return;
    extensionsLoading = true; render(data);
    await run('extensions-status');
    extensionsLoading = false;
    render(controller.get());
  }
  async function ensureConnections(force=false) {
    const data=controller.get();
    if(route!=='connect'||connectionsLoading||data.mode!=='desktop'||!data.state.installed)return;
    if(data.connections&&!force)return;
    connectionsLoading=true;
    await run('connections-status');
    connectionsLoading=false;
    render(controller.get());
  }
  async function ensureSettingsHistory(force=false) {
    const data=controller.get();
    if(route!=='settings'||settingsHistoryLoading||data.mode!=='desktop'||!data.state.installed)return;
    if(data.settingsHistory&&!force)return;
    settingsHistoryLoading=true;
    await run('settings-history');
    settingsHistoryLoading=false;
    render(controller.get());
  }
  async function ensureWorkspace(force=false) {
    const data=controller.get();
    if(!['settings','connect','environment','bilibili'].includes(route)||workspaceLoading||data.mode!=='desktop'||data.pending||data.workspaceLoaded&&!force)return;
    workspaceLoading=true;render(data);await run('workspace-status');workspaceLoading=false;render(controller.get());
  }
  async function navigate(target) {
    if (!routeNames[target]) return;
    if (controller.get().state.panel) {
      await run('home');
      if (controller.get().state.panel) return;
    }
    route = target;
    reveal = false;
    extensionReview = '';
    extensionMessage = null;
    backupReview=null;localMessage='';
    render(controller.get());
    document.getElementById('main-content')?.focus({ preventScroll: true });
    const page = document.querySelector('.page'); if (page) page.scrollTop = 0;
    await ensureSettings();
    await ensureExtensions();
    await ensureConnections(true);
    await ensureSettingsHistory(true);
    await ensureWorkspace(true);
  }
  function adoptSettings(fresh) {
    if (!fresh) return;
    const previousBase = draftBase;
    draftBase = { ...fresh };
    if (!dirtyFields.size) {
      draft = { ...fresh };
      conflictFields.clear();
    } else {
      draft = { ...draft };
      for (const key of Object.keys(fresh)) if (!dirtyFields.has(key)) draft[key] = fresh[key];
      for (const key of dirtyFields) {
        const externallyChanged = previousBase ? String(fresh[key] ?? '') !== String(previousBase[key] ?? '') : false;
        if (externallyChanged && String(draft?.[key] ?? '') !== String(fresh[key] ?? '')) conflictFields.add(key);
      }
    }
    overwritePending = false;
  }
  function markDraft(key, value) {
    if (!draft) draft = { ...(controller.get().settings || {}) };
    if (!draftBase) draftBase = { ...(controller.get().settings || {}) };
    draft[key] = value;
    if (String(value ?? '') === String(draftBase[key] ?? '')) dirtyFields.delete(key);
    else dirtyFields.add(key);
    conflictFields.delete(key);
    overwritePending = false;
  }
  function readField(target) {
    if(target.id==='app-update-channel'){updateChannel=target.value;return;}
    if(target.id==='replyStylePreviewText'){replyStylePreviewText=target.value;return;}

    if(target.id.startsWith('pref-')){if(!preferencesDraft)preferencesDraft={...controller.get().workspace.preferences};preferencesDraft[target.id.slice(5)]=target.checked===true;preferencesDirty=true;return;}
    if(!['ownerQQ','platformId','onebotPort','dashboardPort','onebotToken','biliEnabled','proactiveEnabled','signatureEnabled','qzoneEnabled','officialOwnerUMO','defaultDelivery','replyStyleMode','replyStyleMaxBubbles','replyStyleInterval','replyStylePunctuation','replyStylePrompt','replyStyleCustomRegex','replyStyleCustomCleanup'].includes(target.id))return;
    markDraft(target.id, target.type === 'checkbox' ? target.checked : target.value);
  }
  async function saveSettings() {
    const data = controller.get();
    const value = draft || data.settings;
    if(connectionViewModel(data).stage==='official-owner'&&!/^[^:\s]+:FriendMessage:[A-Za-z0-9_-]{1,128}$/.test(String(value?.officialOwnerUMO||'').trim())){
      localMessage='请复制官方机器人私聊 /fish whoami 返回的完整本会话。';render(data);document.getElementById('officialOwnerUMO')?.focus();return;
    }
    if (connectionViewModel(data).stage === 'owner' && !/^[1-9]\d{4,19}$/.test(String(value?.ownerQQ || '').trim())) {
      localMessage = '请填写接收消息的 QQ 号。';
      render(data);
      document.getElementById('ownerQQ')?.focus();
      return;
    }
    const settings = data.settings || {};
    if (!dirtyFields.size) { localMessage = '没有需要保存的修改。'; render(controller.get()); return; }
    const edited = Object.fromEntries([...dirtyFields].map(key => [key, value?.[key]]));
    const patch = settingsPatch(edited, draftBase || settings);
    if (!Object.keys(patch).length) { localMessage = '没有需要保存的修改。'; render(controller.get()); return; }
    if (conflictFields.size && !overwritePending) {
      overwritePending = true;
      localMessage = `这些字段已在外部更新：${[...conflictFields].join('、')}。再次点击保存将覆盖外部值。`;
      render(controller.get());
      return;
    }
    await run('settings-save', { patch, ...(settings.configRevision ? { expectedRevision: settings.configRevision } : {}) });
    if (controller.get().error) {
      settingsConflict = dirtyFields.size > 0;
      render(controller.get());
    } else {
      draft = { ...controller.get().settings }; draftBase = { ...controller.get().settings };
      dirtyFields.clear(); conflictFields.clear(); overwritePending = false; settingsConflict = false;
      localMessage = ''; await run('connections-status'); render(controller.get());
    }
  }
  root.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target || target.disabled) return;
    if (target.dataset.route) return navigate(target.dataset.route);
    if (target.hasAttribute('data-reveal')) { reveal = !reveal; const input = document.getElementById('onebotToken'); input.type = reveal ? 'text' : 'password'; target.textContent = reveal ? '隐藏' : '显示'; target.setAttribute('aria-pressed', String(reveal)); return; }
    const action = target.dataset.action;
    if (!action) return;
    if (action === 'route-environment') return navigate('environment');
    if(action==='route-connect')return navigate('connect');
    if(action==='route-settings')return navigate('settings');
    if(action==='route-intelligence')return navigate('intelligence');
    if(action==='show-connection-options'){connectionAdvancedOpen=true;render(controller.get());document.getElementById('connection-advanced-summary')?.focus();return;}
    if(action==='show-external-guide'){externalGuideOpen=true;render(controller.get());document.getElementById('external-connection-help')?.focus();return;}
    if(action==='settings-restore-field'){
      const recordId=target.dataset.record, field=target.dataset.field;
      const revision=controller.get().settings?.configRevision;
      if(!recordId||!field||!revision)return;
      await run('settings-restore-field',{recordId,field,expectedRevision:revision});
      if(!controller.get().error){
        controller.invalidateSettingsHistory();
        await run('settings-get');
        await ensureSettingsHistory();
        render(controller.get());
      }
      return;
    }
    if(action==='connection-change'){
      await run('connection-change',{channel:target.dataset.channel,enabled:target.dataset.enabled==='1'});
      render(controller.get());
      return;
    }
    if(action==='connection-cancel'){controller.dismissConnectionPreview();localMessage='已取消连接操作，未做任何更改。';render(controller.get());return;}
    if(action==='connection-confirm'){
      const planId=controller.get().connectionPreview?.id;
      if(!planId)return;
      const typed=document.getElementById('connection-confirm-typed')?.value||'';
      await run('connection-confirm',{planId,typed});
      render(controller.get());
      return;
    }
    if(action==='select-qq-mode'){
      const mode=target.dataset.mode;if(!['napcat','official'].includes(mode))return;
      // Viewing another connection is local UI state: no save, no service
      // restart and no owned-process change. Enabling is a separate action.
      controller.setConnectionTab(mode);
      render(controller.get());
      return;
    }
    if (action === 'reply-style-mode') {
      const mode = target.dataset.mode; if (!['inherit','natural','single','custom'].includes(mode)) return;
      markDraft('replyStyleMode', mode); replyStylePreviewResult = null; render(controller.get()); return;
    }
    if (action === 'reply-style-reset') {
      for (const [key, next] of Object.entries({ replyStyleMode:'inherit', replyStyleMaxBubbles:3, replyStyleInterval:'0.8,1.5', replyStylePunctuation:'keep', replyStylePrompt:true, replyStyleCustomRegex:'', replyStyleCustomCleanup:'' })) markDraft(key, next);
      replyStylePreviewResult = null; localMessage = '已恢复回复方式默认值，保存后才会写入。'; render(controller.get()); return;
    }
    if (action === 'reply-style-preview') {
      const value = draft || controller.get().settings || {};
      const text = document.getElementById('replyStylePreviewText')?.value || '';
      replyStylePreviewText = text;
      const result = await run('reply-style-preview', { text, mode:value.replyStyleMode, maxBubbles:value.replyStyleMaxBubbles, interval:value.replyStyleInterval, punctuation:value.replyStylePunctuation, customRegex:value.replyStyleCustomRegex||'', customCleanup:value.replyStyleCustomCleanup||'', platform:value.qqConnectionMode==='official'?'qq_official':'aiocqhttp', hostReplyPrefix:value.hostReplyPrefix===true, hostTtsEnabled:value.hostTtsEnabled===true });
      if (result) replyStylePreviewResult = result;
      render(controller.get()); return;
    }
    if (action === 'save-settings') return saveSettings();
    if(action==='save-preferences'){await run('preferences-save',preferencesDraft||controller.get().workspace.preferences);if(!controller.get().error){preferencesDirty=false;preferencesDraft=null;render(controller.get());}return;}
    if(action==='app-update-check')return run(action,{channel:updateChannel||controller.get().workspace.appUpdate?.channel||'alpha'});
    if(action==='backup-review') {
      if(!['backup-restore','backup-delete'].includes(target.dataset.operation)||!controller.get().workspace.backups?.some(item=>item.id===target.dataset.item))return;
      const index=controller.get().workspace.backups.findIndex(item=>item.id===target.dataset.item);
      backupReview={id:target.dataset.item,operation:target.dataset.operation,focusId:`backup-restore-${index}`};localMessage='';render(controller.get());document.getElementById('backup-confirm')?.focus({preventScroll:true});return;
    }
    if(action==='backup-cancel'){const focusId=backupReview?.focusId;backupReview=null;localMessage='已取消，备份与当前数据未更改。';render(controller.get());document.getElementById(focusId)?.focus({preventScroll:true});return;}
    if(action==='backup-confirm'){if(!backupReview)return;const review=backupReview;backupReview=null;await run(review.operation,{id:review.id});return;}
    if (action === 'retry') { const retry = controller.get().retry; if (retry) return run(retry.action, retry.payload); return; }
    if(action==='dismiss-error'){settingsConflict=false;controller.dismissError();render(controller.get());return;}
    if (action === 'settings-get') { await run(action); if (!controller.get().error) { adoptSettings(controller.get().settings); settingsConflict = false; } render(controller.get()); return; }
    if (action === 'extension-review') {
      const id = target.dataset.extension;
      if (!['memory', 'memes'].includes(id) || target.dataset.operation !== 'extension-rollback' || !controller.get().extensions?.[id]?.canRollback) return;
      extensionReview = id; extensionMessage = null; render(controller.get());
      document.getElementById(`extension-confirm-${id}`)?.focus({ preventScroll: true });
      return;
    }
    if (action === 'extension-cancel') {
      const id = extensionReview;
      extensionReview = '';
      extensionMessage = { id, text: '已取消回退，插件未更改。' };
      render(controller.get());
      document.getElementById(`extension-rollback-${id}`)?.focus({ preventScroll: true });
      return;
    }
    if (action === 'extension-confirm') {
      const id = extensionReview;
      if (!id || target.dataset.extension !== id) return;
      extensionReview = ''; extensionMessage = null;
      await run('extension-rollback', { id });
      document.getElementById(`extension-check-${id}`)?.focus({ preventScroll: true });
      return;
    }
    if (action === 'extension-check' || action === 'extension-update') {
      extensionReview = ''; extensionMessage = null;
      await run(action, { id: target.dataset.extension });
      return;
    }
    await run(action, action === 'open-panel' ? { panel: target.dataset.panel } : undefined);
  });
  root.addEventListener('input', event => {
    if (event.target.matches('input,textarea') && event.target.type !== 'checkbox') readField(event.target);
  });
  root.addEventListener('change', event => {
    if (!event.target.matches('input,select,textarea')) return;
    readField(event.target);
    render(controller.get());
  });
  root.addEventListener('submit', event => { if (event.target.id === 'connection-form') { event.preventDefault(); saveSettings(); } });
  root.addEventListener('toggle', event => { if(event.target.id==='connection-advanced')connectionAdvancedOpen=event.target.open;if(event.target.id==='external-connection-help')externalGuideOpen=event.target.open; }, true);
  root.addEventListener('compositionstart', event => { if (event.target && event.target.closest && event.target.closest('input,textarea')) composing = true; }, true);
  root.addEventListener('compositionend', event => { if (!(event.target && event.target.closest && event.target.closest('input,textarea'))) return; composing = false; const next = deferredData; deferredData = null; render(next || controller.get()); }, true);
  controller.subscribe(data => { if (data.settings) adoptSettings(data.settings); render(data); });
  window.addEventListener('beforeunload', () => controller.dispose());
  render(controller.get());
  controller.init().catch(() => {}).then(async () => { await ensureSettings(); await ensureExtensions(); await ensureConnections(); await ensureSettingsHistory(); await ensureWorkspace(); });
})();
