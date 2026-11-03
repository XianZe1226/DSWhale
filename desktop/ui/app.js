(function () {
  'use strict';
  const { createController, escapeHTML: esc, connectionViewModel } = window.DSWhaleUI;
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
  let dirty = false;
  let reveal = false;
  let settingsLoading = false;
  let extensionsLoading = false;
  let extensionReview = '';
  let extensionMessage = null;
  let workspaceLoading=false;
  let backupReview=null;
  let rollbackReview=false;
  let restoreUpdateData=false;
  let updateChannel=null;
  let preferencesDraft=null;
  let preferencesDirty=false;
  let localMessage='';
  let pendingFocus = null;
  let lastAnnouncement = '';
  let connectionAdvancedOpen = false;
  let externalGuideOpen = false;
  const busy = data => !!data.pending || ['checking', 'installing'].includes(data.state.phase);
  const desktop = data => data.mode === 'desktop';
  const disabled = yes => yes ? ' disabled' : '';
  const button = (text, action, { primary = false, iconName, off = false, payload = '', id = '', extension = '', operation = '', item='' } = {}) => `<button type="button" class="button${primary ? ' primary' : ''}" data-action="${esc(action)}"${id ? ` id="${esc(id)}"` : ''}${payload ? ` data-panel="${esc(payload)}"` : ''}${extension ? ` data-extension="${esc(extension)}"` : ''}${operation ? ` data-operation="${esc(operation)}"` : ''}${item ? ` data-item="${esc(item)}"` : ''}${disabled(off)}>${iconName ? icon(iconName) : ''}<span>${esc(text)}</span></button>`;
  const routeButton = (text, target) => `<button type="button" class="text-button" data-route="${target}">${esc(text)}${icon('arrow')}</button>`;
  const badge = (label, type = '') => `<span class="badge ${type}"><span class="status-dot"></span>${esc(label)}</span>`;
  const extensionName = id => id === 'memory' ? 'LivingMemory' : '表情包管理器';
  function extensionProgress(data) {
    if (data.pending === 'extensions-status') return '正在读取本机插件状态…';
    if (!data.pendingExtension) return '';
    const verb = { 'extension-check': '检查', 'extension-update': data.extensions?.[data.pendingExtension]?.installed ? '更新' : '安装', 'extension-rollback': '回退' }[data.pending];
    return verb ? `正在${verb}${extensionName(data.pendingExtension)}…` : '';
  }
  const workspaceProgress = data => ({'workspace-status':'正在读取本机工作空间状态…','health-check':'正在检查本机环境…','backup-list':'正在读取本机备份…','backup-restore':'正在备份当前数据并恢复所选备份…','backup-delete':'正在删除所选本机备份…','diagnostics-export':'正在准备诊断报告…','app-update-check':'正在检查官方应用更新…','app-update-download':'正在下载并校验应用安装包…','app-update-install':'正在备份并打开系统安装程序…','app-update-rollback':'正在备份并准备应用回退…','preferences-save':'正在保存应用偏好…','napcat-install':'正在下载并校验独立连接组件…','napcat-configure':'请选择已有独立组件目录…','napcat-wire':'正在应用消息连接，QQ 保持在线…','napcat-stop':'正在停止 QQ 连接…','napcat-guide':'正在打开官方连接指南…','napcat-login-code':'请在系统对话框中查看登录口令…'}[data.pending]||'');
  const preference = (data, value, id, title, description) => `<section class="card preference-card"><div><h3 id="${id}-label">${esc(title)}</h3><p id="${id}-help">${esc(description)}</p></div><label class="switch"><input id="${id}" name="${id}" type="checkbox" aria-labelledby="${id}-label" aria-describedby="${id}-help"${value[id] ? ' checked' : ''}${disabled(!desktop(data) || busy(data))}><span aria-hidden="true"></span></label></section>`;
  function healthCard(data, bili=false) {
    const health=data.workspace.health;
    const checks=Array.isArray(health?.checks)?health.checks.filter(check=>!bili||/bili|bridge|pkg/i.test(`${check.id} ${check.code}`)):[];
    const failures=checks.filter(check=>!check.ok&&check.required).length;
    return `<section class="card reliability-card" aria-labelledby="${bili?'bili-':'environment-'}health-title"><div class="reliability-heading"><div><h2 id="${bili?'bili-':'environment-'}health-title">${bili?'视频服务检查':'环境检查'}</h2><p>${health?failures?`${failures} 项必要检查需要处理`:'必要检查结果如下，账号可用性仍需实际验证':'准备环境后可检查本机组件与配置。'}</p></div>${button('重新检查','health-check',{iconName:'refresh',off:!desktop(data)||busy(data)||!data.state.installed})}</div>${checks.length?`<ul class="health-list">${checks.map(check=>`<li><span class="health-indicator ${check.ok?'pass':'attention'}" aria-label="${check.ok?'通过':check.required?'需要处理':'待确认'}">${icon(check.ok?'check':'refresh')}</span><div><strong>${esc(check.name)}</strong><p>${esc(check.detail)}</p></div>${badge(check.ok?'通过':check.required?'需处理':'待确认',check.ok?'good':'warn')}</li>`).join('')}</ul>`:'<p class="reliability-empty">尚无检查结果；此页不会连接你的模型或发送 QQ 消息。</p>'}<div class="card-actions">${button('修复运行环境','install',{off:!desktop(data)||busy(data)||data.state.running||data.state.platform.supported===false})}${button('连接设置','route-connect',{off:busy(data)})}</div>${data.state.running?'<p class="reliability-note">修复前请先停止服务。</p>':''}</section>`;
  }
  function versionMatrix(data) {
    const matrix=data.state.versionMatrix;if(!matrix?.expected)return '';
    const names={dswhale:'DSWhale',astrbot:'AstrBot',python:'Python',node:'Node.js',ffmpeg:'FFmpeg'};
    return `<div class="section-heading"><h2>版本对照</h2><span>兼容的本机工具可继续使用</span></div><section class="card component-table matrix-table"><table><thead><tr><th scope="col">组件</th><th scope="col">预期版本</th><th scope="col">实际版本</th></tr></thead><tbody>${Object.entries(names).map(([id,name])=>`<tr><th scope="row">${name}</th><td class="version-text">${esc(matrix.expected[id]||'—')}</td><td class="version-text">${esc(matrix.actual?.[id]||'未检测到')}</td></tr>`).join('')}</tbody></table></section><p class="reliability-note">FFmpeg 可复用兼容版本；组件是否可用以环境检查结果为准。</p>`;
  }
  function napcatCard(data) {
    const view = connectionViewModel(data), value = draft || data.settings || {};
    return `<section class="card connection-main" id="qq-connection" aria-labelledby="qq-connection-title"><div class="connection-heading"><span class="connection-symbol ${view.tone === 'good' ? 'complete' : ''}">${icon(view.tone === 'good' ? 'check' : 'connect')}</span>${badge(view.badge,view.tone)}</div><h2 id="qq-connection-title">${esc(view.title)}</h2><p class="connection-description">${esc(view.description)}</p>${view.stage === 'owner' ? ownerField(data,value) : ''}<div class="connection-primary-row">${connectionPrimary(data)}${!view.action && view.tone === 'working' ? '<span class="connection-wait"><span class="spinner" aria-hidden="true"></span>状态会自动更新，无需重复操作</span>' : ''}</div>${connectionTimeline(data)}</section>`;
  }
  function connectionPrimary(data, overview = false) {
    const view = connectionViewModel(data);
    if (!view.action) return '';
    if (overview && ['save-settings','show-connection-options','show-external-guide'].includes(view.action)) return routeButton('前往 QQ 连接','connect');
    return button(view.actionLabel,view.action,{primary:true,id:overview?'overview-connection-primary':'connection-primary',payload:view.panel||'',iconName:view.action==='start'?'play':'arrow',off:!desktop(data)||busy(data)});
  }
  function connectionTimeline(data) {
    const qq = data.workspace.napcat || {}, view = connectionViewModel(data), stage = data.state.startup?.stage || view.stage;
    const backend = data.state.running, logged = qq.loginState === 'online' || view.stage === 'ready';
    const items = [
      ['对话服务', backend ? '已启动' : stage === 'starting-conversation' ? '正在启动' : '等待启动', backend ? 'done' : stage === 'starting-conversation' ? 'active' : 'waiting'],
      ['QQ 登录', logged ? !backend && qq.running ? '保持在线' : '已在线' : {resuming:'正在恢复登录',confirming:'等待手机确认','scan-required':'需要登录',connecting:'正在连接','starting-qq':'正在启动','reusing-qq':'沿用现有连接'}[stage] || (qq.hasSavedLogin ? '已保存账号记录' : '首次需要登录'), logged ? 'done' : backend ? 'active' : 'waiting'],
      ['消息连接', view.stage === 'ready' ? '已建立连接' : view.stage === 'apply-connection' ? '等待应用设置' : '等待连接', view.stage === 'ready' ? 'done' : logged && backend ? 'active' : 'waiting'],
    ];
    return `<ol class="connection-timeline" aria-label="启动与连接步骤">${items.map(([title,detail,status],i)=>`<li data-state="${status}"><span class="connection-step-marker" aria-hidden="true">${status==='done'?icon('check'):i+1}</span><div><strong>${title}</strong><span>${esc(detail)}</span></div></li>`).join('')}</ol>`;
  }
  function ownerField(data,value) {
    return `<div class="field connection-owner-field"><label for="ownerQQ">你的 QQ 号（接收消息）</label><input id="ownerQQ" name="ownerQQ" inputmode="numeric" autocomplete="off" placeholder="填写你自己的 QQ 号" value="${esc(value.ownerQQ||'')}"${disabled(!desktop(data)||busy(data))}><p class="field-help">这里填你的账号，不是机器人的小号。</p></div>`;
  }
  function connectionOptions(data,value) {
    const qq=data.workspace.napcat,windows=data.state.platform.id==='win32-x64',off=!desktop(data)||busy(data),view=connectionViewModel(data);
    return `<details class="card connection-advanced" id="connection-advanced"${connectionAdvancedOpen?' open':''}><summary id="connection-advanced-summary">更多连接选项<span>账号、端口、互动功能与组件管理</span></summary><div class="connection-option-content">${view.stage!=='owner'?ownerField(data,value):''}<h3>连接参数</h3><p class="option-help">通常保持默认即可。只在端口冲突或连接已有协议端时修改。</p><div class="form-grid"><div class="field"><label for="platformId">AstrBot 平台标识</label><input id="platformId" value="${esc(value.platformId||'qq')}"${disabled(off)}></div><div class="field"><label for="onebotPort">OneBot 反向 WebSocket 端口</label><input id="onebotPort" type="number" min="1024" max="65535" value="${esc(value.onebotPort)}"${disabled(off)}></div><div class="field"><label for="dashboardPort">AstrBot 控制台端口</label><input id="dashboardPort" type="number" min="1024" max="65535" value="${esc(value.dashboardPort??6185)}"${disabled(off)}></div><div class="field field-wide"><label for="onebotToken">OneBot 访问令牌</label><div class="secret-input"><input id="onebotToken" type="${reveal?'text':'password'}" autocomplete="off" value="${esc(value.onebotToken||'')}"${disabled(off)}><button type="button" class="reveal-button" data-reveal aria-controls="onebotToken" aria-pressed="${reveal}">${reveal?'隐藏':'显示'}</button></div><p class="field-help">只保存在本机，与协议端保持一致。</p></div></div><h3>互动功能</h3>${preference(data,value,'proactiveEnabled','主动互动','按现有插件设置主动发起对话。')}${preference(data,value,'signatureEnabled','QQ 个性签名','仅绑定的主人可要求修改机器人签名。')}${preference(data,value,'qzoneEnabled','QQ 空间文字动态','先创建草稿，经你确认后发布。')}<div class="card-actions">${button(data.pending==='settings-save'?'正在保存…':'保存设置','save-settings',{off})}<span class="option-help">${dirty?'有未保存的更改':'设置只保存在本机'}</span></div><h3>QQ 连接管理</h3><p class="option-help">停止对话服务会保留 QQ 在线。只有需要断开 QQ 时，才停止 QQ 连接。</p><div class="card-actions">${button('打开 QQ 管理','open-panel',{payload:'napcat',off:off||!data.state.running&&!qq?.running})}${windows?button('QQ 管理口令','napcat-login-code',{off:off||!qq?.configured}):''}${windows&&qq?.running?button('停止 QQ 连接','napcat-stop',{off}):''}${button('应用消息连接','napcat-wire',{off:off||!qq?.configured||qq?.loginState!=='online'||qq?.externalOnly})}</div><p class="option-help">管理口令用于本机管理页，不是 QQ 密码。首次 QQ 登录和账号验证由你本人完成。</p><h3>组件与帮助</h3><div class="card-actions">${windows?button('检查并准备组件','napcat-install',{off:off||!data.state.installed||qq?.running||qq?.canInstall===false}):''}${windows||data.state.platform.id==='linux-x64'?button('使用已有独立组件','napcat-configure',{off:off||!data.state.installed||qq?.running}):''}${button('官方连接指南','napcat-guide',{off})}${button('AstrBot 平台设置','open-panel',{payload:'qq',off:off||!data.state.running})}</div><p class="option-help">不会安装、注入或修改日常使用的官方 QQ。私人记忆与主人管理用于绑定私聊，群聊由 AstrBot 单独配置。</p></div></details>`;
  }
  function updateCard(data) {
    const state=data.workspace.appUpdate,off=!desktop(data)||busy(data);
    const channel=updateChannel||state?.channel||'alpha';
    const phases={idle:'尚未检查','up-to-date':'当前版本已是所选通道最新',available:'发现可用版本',downloading:'下载尚未完成',downloaded:'安装包已校验',snapshotting:'正在备份私人数据','install-ready':'等待系统安装','install-launched':'请完成系统安装','awaiting-verification':'等待环境检查',installed:'更新已通过检查','rolling-back':'正在准备回退','rollback-launched':'请完成旧版安装','awaiting-rollback-verification':'等待回退后检查','rolled-back':'回退已通过检查','repair-required':'需要检查与修复'};
    const restoreRequired=typeof state?.recovery?.rollbackRequiresDataRestore==='boolean'?state.recovery.rollbackRequiresDataRestore:state?.impact?.dataMigration===true||state?.impact?.rollbackCompatible===false;
    const impact=state?.impact;
    return `<section class="card reliability-card app-update-card" aria-labelledby="app-update-title"><div class="reliability-heading"><div><h2 id="app-update-title">应用更新</h2><p>启动约 30 秒后自动检查，此后每 6 小时检查一次（需保持应用运行）；下载与安装由你点击确认。</p></div>${badge(phases[state?.phase]||'尚未检查',state?.recovery?.interrupted?'warn':'')}</div><dl class="update-versions"><div><dt>当前应用</dt><dd>${esc(state?.currentVersion||data.state.version||'待读取')}</dd></div><div><dt>可用版本</dt><dd>${esc(state?.targetVersion||'检查后显示')}</dd></div>${state?.previousVersion?`<div><dt>保留的上一版</dt><dd>${esc(state.previousVersion)}</dd></div>`:''}</dl><div class="update-controls"><label for="app-update-channel">更新通道</label><select id="app-update-channel"${disabled(off)}><option value="stable"${channel==='stable'?' selected':''}>稳定版</option><option value="alpha"${channel==='alpha'?' selected':''}>Alpha 预览版</option></select>${button('检查应用更新','app-update-check',{id:'app-update-check',off:off||state?.actions?.includes('check')===false||state?.recovery?.servicesMustRemainStopped===true})}</div>${impact?`<div class="update-impact"><strong>这次更新的影响</strong><ul>${impact.runtime?'<li>安装后需要准备并检查运行环境。</li>':''}${impact.configuration?'<li>配置可能调整，安装前会保存私人备份。</li>':''}${impact.dataMigration?'<li>涉及数据格式变化，请保留更新前备份。</li>':''}<li>${impact.rollbackCompatible?'可回退应用并保留当前数据。':'回退需要明确选择恢复更新前数据。'}</li></ul></div>`:''}${state?.error?`<p class="recovery-note" role="alert">${esc(state.error.message)}</p>`:state?.recovery?.interrupted||state?.recovery?.requiresHealthVerification?`<p class="recovery-note">${esc(state.recovery.guidance||'更新尚未完成，请继续安装、修复环境或回退。')}</p>`:''}${rollbackReview?`<div class="inline-review" role="group" aria-labelledby="app-rollback-heading"><h3 id="app-rollback-heading">确认回退应用？</h3><p>默认保留当前数据；操作前会停止服务并保存当前数据备份。</p><label class="check-option"><input id="rollback-restore-data" type="checkbox"${restoreUpdateData?' checked':''}${disabled(off)}>同时恢复更新前的配置、聊天与记忆</label><p>${restoreUpdateData?'你已选择恢复旧数据；后来的聊天会先另行备份，再恢复更新前状态。':restoreRequired?'此版本涉及不兼容变化，需要选择恢复旧数据后才能回退。':'仅替换应用程序，当前配置、聊天与记忆保留。'}</p><div class="card-actions">${button(restoreUpdateData?'确认恢复旧数据并回退':'确认回退应用','app-rollback-confirm',{primary:true,id:'app-rollback-confirm',off:off||restoreRequired&&!restoreUpdateData})}${button('取消','app-rollback-cancel',{off})}</div></div>`:`<div class="card-actions">${state?.canDownload?button(state.recovery?.continueAction==='download'?'继续下载安装包':'下载安装包','app-update-download',{off,primary:true}):''}${state?.canInstall?button(state.recovery?.continueAction==='install'?'继续系统安装':'备份并安装','app-update-install',{off:off||!data.state.installed,primary:true}):''}${state?.canRollback?button('回退上一版','app-rollback-review',{id:'app-rollback-review',off:off||!data.state.installed}):''}${state?.recovery?.requiresHealthVerification?button('修复并检查环境','install',{off:off||data.state.running}):''}</div>`}<p class="reliability-note">更新清单经 Ed25519 签名验证，安装包校验大小与 SHA256。这不代表操作系统签名或系统公证；安装时请按系统提示操作。</p></section>`;
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
    if (data.state.installed) { const view=connectionViewModel(data);return {label:view.badge,type:view.tone,title:view.title,description:view.description}; }
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
    const setup = data.state.setup;
    const steps = [
      ['01', '准备运行环境', '自动管理所需工具与依赖', data.state.installed, 'environment', 'environment'],
      ['02', '连接你的 QQ', '设置主人账号与 OneBot 连接', setup.ownerConfigured && setup.qqConfigured, 'connect', 'connect'],
      ['03', '选择模型与记忆', '连接云端模型，延续每一次对话', setup.modelConfigured, 'intelligence', 'intelligence'],
    ];
    return `<section class="page-heading"><div><p class="eyebrow">你的专属工作空间</p><h1>概览</h1><p class="subtitle">把配置交给这里，把时间留给对话。</p></div>${button('刷新状态', 'inspect', { iconName: 'refresh', off: busy(data) || !desktop(data) })}</section>
      <section class="hero"><div class="hero-copy">${badge(s.label, s.type)}<h2>${s.title}</h2><p>${s.description}</p>${data.state.installed?connectionTimeline(data):''}<div class="hero-actions">${data.state.installed ? connectionPrimary(data,true)+(data.state.running?serviceButton(data):'') : installButton(data)}${routeButton('查看 QQ 连接', 'connect')}</div></div><div class="whale-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="whale-glow"></div><img src="whale.svg" alt=""><span class="spark spark-one">✦</span><span class="spark spark-two">✦</span><span class="bubble bubble-one"></span><span class="bubble bubble-two"></span></div></section>
      <div class="section-heading"><h2>开始使用</h2><span>三个步骤，准备好你的 DSWhale</span></div>
      <div class="setup-grid">${steps.map(([num, title, desc, complete, target, glyph]) => `<button class="setup-card" data-route="${target}" type="button"><span class="card-top"><span class="tile-icon ${complete ? 'complete' : ''}">${icon(complete ? 'check' : glyph)}</span><span class="step-number">${complete ? '已完成' : num}</span></span><h3>${title}</h3><p>${desc}</p><span class="card-link">${complete ? '管理设置' : '前往设置'}${icon('arrow')}</span></button>`).join('')}</div>
      <div class="section-heading compact"><h2>工作空间状态</h2></div><section class="card status-list"><div class="status-row"><span class="row-label">${icon('environment')}运行环境</span><span>${data.state.installed ? '已准备' : '等待准备'}<span class="row-divider">·</span>${esc(data.state.platform.label || '未知系统')}</span></div><div class="status-row"><span class="row-label">${icon('play')}对话服务</span>${badge(s.label, s.type)}</div><div class="status-row"><span class="row-label">${icon('shield')}数据存储</span><span>保存在本机${routeButton('管理', 'settings')}</span></div></section>`;
  }
  function progress(data) {
    if (!busy(data)) return '';
    const task=workspaceProgress(data);
    const value = !task&&Number.isFinite(data.state.progress) ? Math.max(0, Math.min(100, data.state.progress <= 1 ? data.state.progress * 100 : data.state.progress)) : null;
    const plugin = extensionProgress(data)||task;
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
  function connect(data) {
    const value = draft || data.settings;
    if (!value) return `<section class="page-heading"><div><h1>QQ 连接</h1><p class="subtitle">正在读取连接设置。</p></div></section><section class="card loading-card">${settingsLoading ? '<span class="spinner" aria-hidden="true"></span> 正在读取…' : button('重新读取','settings-get',{off:!desktop(data)||busy(data)})}</section>`;
    const qq=data.workspace.napcat,view=connectionViewModel(data);
    return `<section class="page-heading connection-page-heading"><div><h1>QQ 连接</h1><p class="subtitle">一次设置，之后按状态继续即可。</p></div>${button('检查状态','workspace-status',{iconName:'refresh',off:!desktop(data)||busy(data)})}</section>
      <form id="connection-form">${napcatCard(data)}${qq?.externalOnly||externalGuideOpen?`<details class="card external-connection-help" id="external-connection-help"${externalGuideOpen?' open':''}><summary>外部协议端接入步骤</summary><ol><li>在外部 NapCat 或其他 OneBot 协议端登录机器人账号。</li><li>添加反向 WebSocket 连接：<code>ws://127.0.0.1:${esc(value.onebotPort)}/ws</code>，令牌与下方连接选项保持一致。</li><li>保持协议端运行，回到这里检查消息连接。</li></ol>${button('官方接入指南','napcat-guide',{off:!desktop(data)||busy(data)})}</details>`:''}${connectionOptions(data,value)}</form>
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
  function intelligence(data) {
    const off = !data.state.running || !desktop(data) || busy(data);
    return `<section class="page-heading"><div><p class="eyebrow">每一次对话，都更懂你</p><h1>模型与记忆</h1><p class="subtitle">连接云端模型，让记忆自然延续。</p></div></section><div class="feature-grid"><section class="card feature-card"><span class="feature-icon lavender">${icon('intelligence')}</span>${badge(data.state.setup.modelConfigured ? '已配置' : '待配置', data.state.setup.modelConfigured ? 'good' : '')}<h2>对话模型</h2><p>在 AstrBot 中管理模型服务商、API 密钥、模型选择与对话能力。</p><ul><li>使用现有的云端模型服务</li><li>无需下载本地模型权重</li></ul>${button('配置模型', 'open-panel', { primary: true, payload: 'models', iconName: 'arrow', off })}</section><section class="card feature-card"><span class="feature-icon mint">${icon('environment')}</span>${badge(data.state.setup.memoryConfigured ? '已配置' : '待配置', data.state.setup.memoryConfigured ? 'good' : '')}<h2>长期记忆</h2><p>在记忆插件中管理检索、总结与记忆设置，让重要的细节留下来。</p><ul><li>沿用现有记忆与插件配置</li><li>在同一个窗口中完成管理</li></ul>${button('管理记忆', 'open-panel', { payload: 'memory', iconName: 'arrow', off })}</section></div>${extensions(data)}${!data.state.running ? `<section class="info-strip">${icon('play')}<div><strong>先启动对话服务</strong><p>${data.state.installed ? '启动后，即可在当前窗口打开模型和记忆控制台。' : '请先准备运行环境，然后启动服务。'}</p></div>${data.state.installed ? serviceButton(data) : button('准备环境', 'route-environment', { primary: true, iconName: 'arrow' })}</section>` : `<section class="info-strip">${icon('shield')}<div><strong>完整配置，留在当前窗口。</strong><p>模型、插件与高级设置均通过现有 AstrBot 控制台管理。</p></div>${button('打开控制台', 'open-panel', { payload: 'astrbot', off })}</section>`}`;
  }
  function bilibili(data) {
    const value = draft || data.settings;
    return `<section class="page-heading"><div><p class="eyebrow">发现更多感兴趣的内容</p><h1>哔哩哔哩</h1><p class="subtitle">管理关注、动态与视频相关能力。</p></div>${badge(data.state.setup.biliEnabled ? '已启用' : '未启用', data.state.setup.biliEnabled ? 'good' : '')}</section><section class="card bili-card"><span class="feature-icon pink">${icon('bilibili')}</span><h2>把喜欢的内容，带进对话。</h2><p>在完整设置面板中管理登录状态、关注与订阅规则。<br>沿用现有配置，在当前窗口继续操作。</p>${button('打开哔哩哔哩设置', 'open-panel', { primary: true, payload: 'bilibili', iconName: 'arrow', off: !desktop(data) || !data.state.running || busy(data) })}</section><section class="card preference-card"><div><h3>启用哔哩哔哩功能</h3><p>保存后生效。登录与详细订阅请在完整设置中管理。</p></div><label class="switch"><input id="biliEnabled" type="checkbox"${(value?.biliEnabled ?? data.state.setup.biliEnabled) ? ' checked' : ''}${disabled(!desktop(data) || !value || busy(data))}><span aria-hidden="true"></span><span class="sr-only">启用哔哩哔哩功能</span></label></section>${dirty ? `<div class="form-footer"><p>有未保存的更改</p>${button('保存设置', 'save-settings', { primary: true, off: !desktop(data) || busy(data) })}</div>` : ''}${!data.state.running ? '<p class="footnote">启动服务后，可打开完整哔哩哔哩设置。</p>' : ''}${healthCard(data,true)}`;
  }
  function settings(data) {
    const off=!desktop(data)||busy(data);
    return `<section class="page-heading"><div><p class="eyebrow">你的数据，由你掌握</p><h1>应用设置</h1><p class="subtitle">管理应用更新、备份与日常运行。</p></div>${button('刷新本机状态','workspace-status',{off})}</section>
      ${!data.workspaceLoaded&&!workspaceLoading?`<p class="inline-note">本机状态尚未读取。${button('重试读取','workspace-status',{off})}</p>`:''}
      ${updateCard(data)}${versionMatrix(data)}${networkCard(data)}${appPreferences(data)}${backupCard(data)}
      <div class="section-heading"><h2>本机数据</h2></div><section class="card settings-list"><div class="settings-row"><span class="tile-icon">${icon('shield')}</span><div><h3>控制台首次登录</h3><p>在系统对话框中查看或复制口令，口令不会进入此页面。</p></div>${button('首次登录口令','initial-login',{off:off||!data.state.installed})}</div><div class="settings-row"><span class="tile-icon">${icon('folder')}</span><div><h3>数据文件夹</h3><p>查看本地配置、记忆、独立环境与备份。</p></div>${button('打开文件夹','open-data',{off})}</div><div class="settings-row"><span class="tile-icon">${icon('shield')}</span><div><h3>创建数据备份</h3><p>将私人数据另存为 ZIP 备份，便于迁移与恢复。</p></div>${button(data.pending==='backup'?'正在备份…':'立即备份','backup',{off:off||!data.state.installed})}</div><div class="settings-row"><span class="tile-icon">${icon('folder')}</span><div><h3>导入数据备份</h3><p>导入自己的 DSWhale ZIP 备份；操作前保留当前数据，完成后检查环境与连接。</p></div>${button(data.pending==='restore'?'正在导入…':'导入备份','restore',{off:off||!data.state.installed})}</div></section>
      ${diagnosticsCard(data)}<div class="section-heading"><h2>关于 DSWhale</h2></div><section class="card about-card"><img src="whale.svg" alt="DSWhale 鲸鱼标志"><div><h2>DSWhale</h2><p>让陪伴，在每一次对话中发生。</p><span class="version-text">${data.state.version?`版本 ${esc(data.state.version)}`:'桌面应用'}<span class="row-divider">·</span>${esc(data.state.platform.label||'本地工作空间')}</span></div><span class="local-label">${icon('shield')}本地工作空间</span></section>`;
  }
  function render(data) {
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
    const error = data.error || data.state.error;
    const feedback = error ? `<div class="alert error" role="alert"><span class="alert-symbol">!</span><div><strong>操作未完成</strong><p>${esc(error)}</p></div>${data.retry ? button('重试', 'retry', { off: busy(data) || !desktop(data) }) : ''}</div>` : localMessage||data.notice ? `<div class="alert success" role="status">${icon('check')}<span>${esc(localMessage||data.notice)}</span></div>` : '';
    const views = { overview, environment, connect, intelligence, bilibili, settings };
    const content = data.mode === 'unavailable' ? `<section class="desktop-notice card"><img src="whale.svg" alt="DSWhale"><h1>请在桌面应用中打开</h1><p>运行环境、对话服务和本地设置需要 DSWhale 桌面应用。</p><p class="footnote">当前页面未连接桌面服务，无法读取或修改本机配置。</p></section>` : views[route](data);
    root.innerHTML = `<aside class="sidebar" aria-label="主导航"><div class="window-space"></div><div class="brand"><div class="brand-mark"><img src="whale.svg" alt=""></div><div><strong>DSWhale</strong><span>你的对话伙伴</span></div></div><div class="nav-label">工作空间</div><nav>${nav}</nav><div class="sidebar-bottom"><div class="sidebar-service"><span class="status-dot ${status.type==='good'?'good':status.type==='working'?'working':''}"></span><div><strong>${esc(status.label)}</strong><span>${data.state.running ? '对话服务已启动' : '对话服务尚未启动'}</span></div></div><div class="sidebar-version"><span>DSWhale Desktop</span><span>${esc(data.state.version || '')}</span></div></div></aside><div class="workspace"><header class="topbar"><div class="breadcrumb"><span>工作空间</span><span class="breadcrumb-slash">/</span><strong>${esc(panel ? panelNames[panel] || '控制台' : routeNames[route])}</strong></div><div class="topbar-right">${data.mode === 'preview' ? '<span class="preview-pill">只读预览</span>' : ''}<span class="topbar-status"><span class="status-dot ${data.state.running ? 'good' : ''}"></span>${esc(data.state.running ? '对话服务已启动' : '对话服务尚未启动')}</span></div></header>${panel ? `<main class="embedded" id="main-content" tabindex="-1"><div class="panel-toolbar"><button type="button" data-action="home" class="panel-back">${icon('back')}返回${esc(routeNames[route])}</button><div class="panel-toolbar-actions"><span class="panel-context">${esc(panelNames[panel] || '控制台')}${['astrbot','models','memory','qq'].includes(panel)?'<small>内核由 DSWhale 统一管理，更新请到应用设置</small>':''}</span>${button(panel==='napcat'?'QQ 管理口令':'控制台首次口令',panel==='napcat'?'napcat-login-code':'initial-login',{off:!desktop(data)||!data.state.installed||busy(data)})}</div></div><div class="embedded-placeholder"><span class="spinner" aria-hidden="true"></span><p>正在显示控制台…</p></div>${feedback ? `<div class="panel-feedback">${feedback}</div>` : ''}</main>` : `<main class="page" id="main-content" tabindex="-1">${preview}${feedback}${content}${route !== 'environment' ? progress(data) : ''}<footer class="page-footer"><span class="footer-line"></span><span>DSWhale · 让对话更有温度</span><span class="footer-line"></span></footer></main>`}</div>`;
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
    const announcement = error || localMessage || extensionMessage?.text || data.notice || extensionProgress(data) || workspaceProgress(data) || (busy(data) && data.state.step) || status.label;
    if (announcement !== lastAnnouncement) { document.getElementById('announcer').textContent = announcement; lastAnnouncement = announcement; }
  }
  async function run(action, payload) {
    extensionMessage = null;
    localMessage='';
    try {
      const result = await controller.act(action, payload);
      if (['restore','backup-restore'].includes(action) && !result?.canceled) { draft = null; dirty = false; reveal = false; render(controller.get()); }
      return result;
    } catch { /* Visible error and retry are rendered by the controller. */ }
  }
  async function ensureSettings() {
    const data = controller.get();
    if (!['connect', 'bilibili'].includes(route) || data.settings || settingsLoading || data.mode !== 'desktop') return;
    settingsLoading = true; render(data);
    await run('settings-get');
    settingsLoading = false;
    if (!dirty && controller.get().settings) draft = { ...controller.get().settings };
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
    backupReview=null;rollbackReview=false;restoreUpdateData=false;localMessage='';
    render(controller.get());
    document.getElementById('main-content')?.focus({ preventScroll: true });
    const page = document.querySelector('.page'); if (page) page.scrollTop = 0;
    await ensureSettings();
    await ensureExtensions();
    await ensureWorkspace(true);
  }
  function readField(target) {
    if(target.id==='app-update-channel'){updateChannel=target.value;return;}
    if(target.id==='rollback-restore-data'){restoreUpdateData=target.checked===true;return;}

    if(target.id.startsWith('pref-')){if(!preferencesDraft)preferencesDraft={...controller.get().workspace.preferences};preferencesDraft[target.id.slice(5)]=target.checked===true;preferencesDirty=true;return;}
    if(!['ownerQQ','platformId','onebotPort','dashboardPort','onebotToken','biliEnabled','proactiveEnabled','signatureEnabled','qzoneEnabled'].includes(target.id))return;
    if (!draft) draft = { ...(controller.get().settings || {}) };
    draft[target.id] = target.type === 'checkbox' ? target.checked : target.value;
    dirty = true;
  }
  async function saveSettings() {
    const data = controller.get();
    const value = draft || data.settings;
    if (connectionViewModel(data).stage === 'owner' && !/^[1-9]\d{4,19}$/.test(String(value?.ownerQQ || '').trim())) {
      localMessage = '请填写接收消息的 QQ 号。';
      render(data);
      document.getElementById('ownerQQ')?.focus();
      return;
    }
    await run('settings-save', value);
    if (!controller.get().error) { dirty = false; draft = { ...controller.get().settings }; render(controller.get()); }
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
    if(action==='app-rollback-review'){if(!controller.get().workspace.appUpdate?.canRollback)return;rollbackReview=true;restoreUpdateData=false;localMessage='';render(controller.get());document.getElementById('app-rollback-confirm')?.focus({preventScroll:true});return;}
    if(action==='app-rollback-cancel'){rollbackReview=false;restoreUpdateData=false;localMessage='已取消回退，应用与数据未更改。';render(controller.get());document.getElementById('app-rollback-review')?.focus({preventScroll:true});return;}
    if(action==='app-rollback-confirm') {
      if(!rollbackReview)return;
      const state=controller.get().workspace.appUpdate;
      const required=typeof state?.recovery?.rollbackRequiresDataRestore==='boolean'?state.recovery.rollbackRequiresDataRestore:state?.impact?.dataMigration===true||state?.impact?.rollbackCompatible===false;
      if(required&&!restoreUpdateData)return;
      const restoreData=restoreUpdateData;rollbackReview=false;restoreUpdateData=false;await run('app-update-rollback',{restoreData,confirmDataRestore:restoreData});return;
    }
    if (action === 'retry') { const retry = controller.get().retry; if (retry) return run(retry.action, retry.payload); return; }
    if (action === 'settings-get') { await run(action); if (!dirty) draft = { ...controller.get().settings }; render(controller.get()); return; }
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
  controller.subscribe(data => { if (data.settings && !dirty) draft = { ...data.settings }; render(data); });
  window.addEventListener('beforeunload', () => controller.dispose());
  render(controller.get());
  controller.init().catch(() => {}).then(async () => { await ensureSettings(); await ensureExtensions(); await ensureWorkspace(); });
})();
