(function () {
  'use strict';
  const { createController, escapeHTML: esc } = window.DSWhaleUI;
  const query = new URLSearchParams(location.search);
  const controller = createController({ bridge: window.dswhale, preview: query.get('preview') === '1' });
  const root = document.getElementById('app');
  const routeNames = { overview: '概览', environment: '运行环境', connect: '连接设置', intelligence: '模型与记忆', bilibili: '哔哩哔哩', settings: '应用设置' };
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
  let lastAnnouncement = '';
  const busy = data => !!data.pending || ['checking', 'installing'].includes(data.state.phase);
  const desktop = data => data.mode === 'desktop';
  const disabled = yes => yes ? ' disabled' : '';
  const button = (text, action, { primary = false, iconName, off = false, payload = '' } = {}) => `<button type="button" class="button${primary ? ' primary' : ''}" data-action="${action}"${payload ? ` data-panel="${payload}"` : ''}${disabled(off)}>${iconName ? icon(iconName) : ''}<span>${esc(text)}</span></button>`;
  const routeButton = (text, target) => `<button type="button" class="text-button" data-route="${target}">${esc(text)}${icon('arrow')}</button>`;
  const badge = (label, type = '') => `<span class="badge ${type}"><span class="status-dot"></span>${esc(label)}</span>`;
  function service(data) {
    if (data.state.running) return { label: '服务运行中', type: 'good', title: '一切就绪，保持连接。', description: '在这里管理你的对话服务、模型和记忆。' };
    if (data.state.phase === 'installing') return { label: '正在准备环境', type: 'working', title: '为下一次对话做好准备。', description: '正在准备独立运行环境，请保持网络连接。' };
    if (data.state.phase === 'checking' || data.pending === 'inspect') return { label: '正在检查', type: 'working', title: '正在了解你的工作空间。', description: '检查运行环境与本地服务状态。' };
    if (data.state.installed) return { label: '服务未启动', type: '', title: '准备好了，随时出发。', description: '运行环境已就绪。启动服务，继续你的对话。' };
    return { label: '尚未准备', type: '', title: '让陪伴，从这里开始。', description: '准备运行环境，连接 QQ，再为 DSWhale 选择一个模型。' };
  }
  function installButton(data) {
    const needsRepair = data.state.components.some(c => ['missing', 'incompatible', 'unknown'].includes(c.status));
    const needsUpdate = data.state.components.some(c => c.status === 'outdated');
    const text = data.state.phase === 'installing' || data.pending === 'install' ? '正在准备…' : !data.state.installed ? '一键准备环境' : needsRepair ? '修复运行环境' : needsUpdate ? '升级运行环境' : '检查并更新环境';
    return button(text, 'install', { primary: true, iconName: 'arrow', off: !desktop(data) || busy(data) || data.state.running || data.state.platform.supported === false });
  }
  function serviceButton(data) {
    return data.state.running ? button(data.pending === 'stop' ? '正在停止…' : '停止服务', 'stop', { iconName: 'stop', off: busy(data) || !desktop(data) }) : button(data.pending === 'start' ? '正在启动…' : '启动服务', 'start', { primary: true, iconName: 'play', off: busy(data) || !desktop(data) || !data.state.installed || data.state.platform.supported === false });
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
      <section class="hero"><div class="hero-copy">${badge(s.label, s.type)}<h2>${s.title}</h2><p>${s.description}</p><div class="hero-actions">${data.state.installed ? serviceButton(data) : installButton(data)}${routeButton('查看运行环境', 'environment')}</div></div><div class="whale-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="whale-glow"></div><img src="whale.svg" alt=""><span class="spark spark-one">✦</span><span class="spark spark-two">✦</span><span class="bubble bubble-one"></span><span class="bubble bubble-two"></span></div></section>
      <div class="section-heading"><h2>开始使用</h2><span>三个步骤，准备好你的 DSWhale</span></div>
      <div class="setup-grid">${steps.map(([num, title, desc, complete, target, glyph]) => `<button class="setup-card" data-route="${target}" type="button"><span class="card-top"><span class="tile-icon ${complete ? 'complete' : ''}">${icon(complete ? 'check' : glyph)}</span><span class="step-number">${complete ? '已完成' : num}</span></span><h3>${title}</h3><p>${desc}</p><span class="card-link">${complete ? '管理设置' : '前往设置'}${icon('arrow')}</span></button>`).join('')}</div>
      <div class="section-heading compact"><h2>工作空间状态</h2></div><section class="card status-list"><div class="status-row"><span class="row-label">${icon('environment')}运行环境</span><span>${data.state.installed ? '已准备' : '等待准备'}<span class="row-divider">·</span>${esc(data.state.platform.label || '未知系统')}</span></div><div class="status-row"><span class="row-label">${icon('play')}对话服务</span>${badge(s.label, s.type)}</div><div class="status-row"><span class="row-label">${icon('shield')}数据存储</span><span>保存在本机${routeButton('管理', 'settings')}</span></div></section>`;
  }
  function progress(data) {
    if (!busy(data)) return '';
    const value = Number.isFinite(data.state.progress) ? Math.max(0, Math.min(100, data.state.progress <= 1 ? data.state.progress * 100 : data.state.progress)) : null;
    return `<section class="task-status" aria-label="当前任务"><div class="task-line"><span class="spinner" aria-hidden="true"></span><strong>${esc(data.state.step || (data.pending === 'inspect' ? '正在检查本机环境…' : '正在处理，请稍候…'))}</strong>${value !== null ? `<span>${Math.round(value)}%</span>` : ''}</div>${value !== null ? `<progress max="100" value="${value}" aria-label="准备进度">${value}%</progress>` : ''}</section>`;
  }
  function environment(data) {
    const labels = { ready: ['已就绪', 'good'], missing: ['待安装', ''], outdated: ['可升级', 'warn'], incompatible: ['需修复', 'warn'], unknown: ['待检查', ''] };
    return `<section class="page-heading"><div><p class="eyebrow">独立环境 · 自动管理</p><h1>运行环境</h1><p class="subtitle">准备好所需工具，安心开始。</p></div>${button('重新检查', 'inspect', { iconName: 'refresh', off: busy(data) || !desktop(data) })}</section>
      <section class="card environment-summary"><span class="large-tile">${icon('environment')}</span><div><h2>${data.state.installed ? '运行环境已准备' : '为 DSWhale 准备独立环境'}</h2><p>兼容工具会自动复用，其余依赖安装到应用数据目录。</p><span class="system-label">${esc(data.state.platform.label || '未知系统')}</span></div>${installButton(data)}</section>
      ${data.state.platform.supported === false ? `<div class="alert error" role="alert"><strong>当前系统暂不支持</strong><p>${esc(data.state.platform.detail || '请使用受支持的系统与处理器架构。')}</p></div>` : ''}
      ${data.state.running ? '<p class="inline-note">请先停止服务，再更新或修复环境。</p>' : ''}${progress(data)}
      <div class="section-heading"><h2>环境组件</h2><span>${data.state.components.length ? `${data.state.components.length} 项` : '检查后显示'}</span></div><section class="card component-table"><table><thead><tr><th scope="col">组件</th><th scope="col">版本</th><th scope="col">状态</th></tr></thead><tbody>${data.state.components.length ? data.state.components.map(c => { const status = labels[c.status] || labels.unknown; return `<tr><td><strong>${esc(c.label)}</strong><span class="component-detail">${esc(c.detail)}</span></td><td class="version-text">${esc(c.version || '—')}</td><td>${badge(status[0], status[1])}</td></tr>`; }).join('') : '<tr><td colspan="3" class="empty-state">尚无检查结果。点击「重新检查」获取本机状态。</td></tr>'}</tbody></table></section><p class="footnote">${icon('shield')}环境准备不会启动对话服务。升级应用时，会保留你的配置、记忆和备份。</p>`;
  }
  function connect(data) {
    const value = draft || data.settings;
    if (!value) return `<section class="page-heading"><div><p class="eyebrow">对话的第一步</p><h1>连接设置</h1><p class="subtitle">设置主人账号与本机 OneBot 服务。</p></div></section><section class="card loading-card">${settingsLoading ? '<span class="spinner" aria-hidden="true"></span> 正在读取连接设置…' : `尚未读取连接设置。${button('重试', 'settings-get', { off: !desktop(data) || busy(data) })}`}</section>`;
    return `<section class="page-heading"><div><p class="eyebrow">让对话连接起来</p><h1>连接设置</h1><p class="subtitle">主人账号与 QQ 连接，在这里统一管理。</p></div>${badge(data.state.setup.ownerConfigured && data.state.setup.qqConfigured ? '已配置' : '等待配置', data.state.setup.ownerConfigured && data.state.setup.qqConfigured ? 'good' : '')}</section>
      <form id="connection-form"><section class="card form-card"><div class="card-heading"><span class="tile-icon">${icon('connect')}</span><div><h2>账号与平台</h2><p>使用你已配置的 QQ / OneBot 服务。</p></div></div><div class="form-grid"><div class="field"><label for="ownerQQ">主人 QQ 号</label><input id="ownerQQ" name="ownerQQ" inputmode="numeric" autocomplete="off" placeholder="输入主人 QQ 号" value="${esc(value.ownerQQ)}"${disabled(!desktop(data) || busy(data))}><p class="field-help">用于识别主人的指令与管理权限。</p></div><div class="field"><label for="platformId">平台标识</label><input id="platformId" name="platformId" autocomplete="off" placeholder="例如 qq" value="${esc(value.platformId)}"${disabled(!desktop(data) || busy(data))}><p class="field-help">对应 AstrBot 中的 OneBot 平台。</p></div></div><div class="form-divider"></div><div class="form-grid"><div class="field"><label for="onebotPort">OneBot 反向 WebSocket 端口</label><input id="onebotPort" name="onebotPort" type="number" min="1" max="65535" step="1" required value="${esc(value.onebotPort)}"${disabled(!desktop(data) || busy(data))}><p class="field-help">应与 QQ 客户端中的反向连接端口一致。</p></div><div class="field"><label for="onebotToken">OneBot 访问令牌</label><div class="secret-input"><input id="onebotToken" name="onebotToken" type="${reveal ? 'text' : 'password'}" autocomplete="off" placeholder="未设置" value="${esc(value.onebotToken)}"${disabled(!desktop(data) || busy(data))}><button type="button" class="reveal-button" data-reveal aria-controls="onebotToken" aria-pressed="${reveal}">${reveal ? '隐藏' : '显示'}</button></div><p class="field-help">令牌只保存在本机，请与 QQ 端保持一致。</p></div></div></section>
      <section class="card preference-card"><div><h3>主动互动</h3><p>允许已配置的主动互动功能。具体行为由现有插件设置决定。</p></div><label class="switch"><input id="proactiveEnabled" name="proactiveEnabled" type="checkbox"${value.proactiveEnabled ? ' checked' : ''}${disabled(!desktop(data) || busy(data))}><span aria-hidden="true"></span><span class="sr-only">启用主动互动</span></label></section><div class="form-footer"><p>${dirty ? '有未保存的更改' : '保存后应用到本地配置'}</p><button class="button primary" type="submit"${disabled(!desktop(data) || busy(data))}>${data.pending === 'settings-save' ? '正在保存…' : '保存连接设置'}</button></div></form>
      <section class="info-strip">${icon('shield')}<div><strong>连接已有的 QQ 环境</strong><p>需另行安装并启动 NapCat，再在 QQ 登录面板中完成登录。高级设置管理 AstrBot 连接。</p></div><div class="info-actions">${button('QQ 登录', 'open-panel', { payload: 'napcat', off: !data.state.running || !desktop(data) || busy(data) })}${button('高级设置', 'open-panel', { payload: 'qq', off: !data.state.running || !desktop(data) || busy(data) })}</div></section>${!data.state.running ? '<p class="footnote">启动服务后可打开高级设置。</p>' : ''}`;
  }
  function intelligence(data) {
    const off = !data.state.running || !desktop(data) || busy(data);
    return `<section class="page-heading"><div><p class="eyebrow">每一次对话，都更懂你</p><h1>模型与记忆</h1><p class="subtitle">连接云端模型，让记忆自然延续。</p></div></section><div class="feature-grid"><section class="card feature-card"><span class="feature-icon lavender">${icon('intelligence')}</span>${badge(data.state.setup.modelConfigured ? '已配置' : '待配置', data.state.setup.modelConfigured ? 'good' : '')}<h2>对话模型</h2><p>在 AstrBot 中管理模型服务商、API 密钥、模型选择与对话能力。</p><ul><li>使用现有的云端模型服务</li><li>无需下载本地模型权重</li></ul>${button('配置模型', 'open-panel', { primary: true, payload: 'models', iconName: 'arrow', off })}</section><section class="card feature-card"><span class="feature-icon mint">${icon('environment')}</span>${badge(data.state.setup.memoryConfigured ? '已配置' : '待配置', data.state.setup.memoryConfigured ? 'good' : '')}<h2>长期记忆</h2><p>在记忆插件中管理检索、总结与记忆设置，让重要的细节留下来。</p><ul><li>沿用现有记忆与插件配置</li><li>在同一个窗口中完成管理</li></ul>${button('管理记忆', 'open-panel', { payload: 'memory', iconName: 'arrow', off })}</section></div>${!data.state.running ? `<section class="info-strip">${icon('play')}<div><strong>先启动对话服务</strong><p>${data.state.installed ? '启动后，即可在当前窗口打开模型和记忆控制台。' : '请先准备运行环境，然后启动服务。'}</p></div>${data.state.installed ? serviceButton(data) : button('准备环境', 'route-environment', { primary: true, iconName: 'arrow' })}</section>` : `<section class="info-strip">${icon('shield')}<div><strong>完整配置，留在当前窗口。</strong><p>模型、插件与高级设置均通过现有 AstrBot 控制台管理。</p></div>${button('打开控制台', 'open-panel', { payload: 'astrbot', off })}</section>`}`;
  }
  function bilibili(data) {
    const value = draft || data.settings;
    return `<section class="page-heading"><div><p class="eyebrow">发现更多感兴趣的内容</p><h1>哔哩哔哩</h1><p class="subtitle">管理关注、动态与视频相关能力。</p></div>${badge(data.state.setup.biliEnabled ? '已启用' : '未启用', data.state.setup.biliEnabled ? 'good' : '')}</section><section class="card bili-card"><span class="feature-icon pink">${icon('bilibili')}</span><h2>把喜欢的内容，带进对话。</h2><p>在完整设置面板中管理登录状态、关注与订阅规则。<br>沿用现有配置，在当前窗口继续操作。</p>${button('打开哔哩哔哩设置', 'open-panel', { primary: true, payload: 'bilibili', iconName: 'arrow', off: !desktop(data) || !data.state.running || busy(data) })}</section><section class="card preference-card"><div><h3>启用哔哩哔哩功能</h3><p>保存后生效。登录与详细订阅请在完整设置中管理。</p></div><label class="switch"><input id="biliEnabled" type="checkbox"${(value?.biliEnabled ?? data.state.setup.biliEnabled) ? ' checked' : ''}${disabled(!desktop(data) || !value || busy(data))}><span aria-hidden="true"></span><span class="sr-only">启用哔哩哔哩功能</span></label></section>${dirty ? `<div class="form-footer"><p>有未保存的更改</p>${button('保存设置', 'save-settings', { primary: true, off: !desktop(data) || busy(data) })}</div>` : ''}${!data.state.running ? '<p class="footnote">启动服务后，可打开完整哔哩哔哩设置。</p>' : ''}`;
  }
  function settings(data) {
    return `<section class="page-heading"><div><p class="eyebrow">你的数据，由你掌握</p><h1>应用设置</h1><p class="subtitle">管理本地数据、备份与应用信息。</p></div></section><section class="card settings-list"><div class="settings-row"><span class="tile-icon">${icon('shield')}</span><div><h3>控制台首次登录</h3><p>查看首次登录口令，并可在系统对话框中复制。</p></div>${button('首次登录口令', 'initial-login', { off: !desktop(data) || !data.state.installed || busy(data) })}</div><div class="settings-row"><span class="tile-icon">${icon('folder')}</span><div><h3>数据文件夹</h3><p>查看本地配置、记忆、独立环境与备份。</p></div>${button('打开文件夹', 'open-data', { off: !desktop(data) || busy(data) })}</div><div class="settings-row"><span class="tile-icon">${icon('shield')}</span><div><h3>创建数据备份</h3><p>将当前数据保存为备份，便于迁移与恢复。</p></div>${button(data.pending === 'backup' ? '正在备份…' : '立即备份', 'backup', { off: !desktop(data) || busy(data) })}</div><div class="settings-row"><span class="tile-icon">${icon('folder')}</span><div><h3>导入数据备份</h3><p>导入自己创建的 DSWhale ZIP 备份，保留原配置和记忆；导入后需检查连接再启动。</p></div>${button(data.pending === 'restore' ? '正在导入…' : '导入备份', 'restore', { off: !desktop(data) || !data.state.installed || busy(data) })}</div></section><div class="section-heading"><h2>关于 DSWhale</h2></div><section class="card about-card"><img src="whale.svg" alt="DSWhale 鲸鱼标志"><div><h2>DSWhale</h2><p>让陪伴，在每一次对话中发生。</p><span class="version-text">${data.state.version ? `版本 ${esc(data.state.version)}` : '桌面应用'}<span class="row-divider">·</span>${esc(data.state.platform.label || '本地工作空间')}</span></div><span class="local-label">${icon('shield')}本地工作空间</span></section><p class="footnote">升级应用时，数据仍保留在应用数据目录。恢复或迁移前，建议先创建备份。</p>`;
  }
  function render(data) {
    const focused = document.activeElement?.id;
    const focusAction = document.activeElement?.dataset?.action;
    const focusPanel = document.activeElement?.dataset?.panel;
    const focusRoute = document.activeElement?.dataset?.route;
    const selection = document.activeElement && 'selectionStart' in document.activeElement ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const scroll = document.querySelector('.page')?.scrollTop || 0;
    const panel = data.state.panel;
    const status = service(data);
    const nav = Object.entries(routeNames).map(([id, label]) => `<button type="button" class="nav-item${route === id ? ' active' : ''}" data-route="${id}"${route === id ? ' aria-current="page"' : ''}>${icon(id)}<span>${label}</span>${id === 'environment' && !data.state.installed ? '<span class="nav-dot" aria-label="待准备"></span>' : ''}</button>`).join('');
    const preview = data.mode === 'preview' ? '<div class="mode-banner">界面预览 · 示例数据 · 所有设备操作已禁用</div>' : '';
    const error = data.error || data.state.error;
    const feedback = error ? `<div class="alert error" role="alert"><span class="alert-symbol">!</span><div><strong>操作未完成</strong><p>${esc(error)}</p></div>${data.retry ? button('重试', 'retry', { off: busy(data) || !desktop(data) }) : ''}</div>` : data.notice ? `<div class="alert success" role="status">${icon('check')}<span>${esc(data.notice)}</span></div>` : '';
    const views = { overview, environment, connect, intelligence, bilibili, settings };
    const content = data.mode === 'unavailable' ? `<section class="desktop-notice card"><img src="whale.svg" alt="DSWhale"><h1>请在桌面应用中打开</h1><p>运行环境、对话服务和本地设置需要 DSWhale 桌面应用。</p><p class="footnote">当前页面未连接桌面服务，无法读取或修改本机配置。</p></section>` : views[route](data);
    root.innerHTML = `<aside class="sidebar" aria-label="主导航"><div class="window-space"></div><div class="brand"><div class="brand-mark"><img src="whale.svg" alt=""></div><div><strong>DSWhale</strong><span>你的对话伙伴</span></div></div><div class="nav-label">工作空间</div><nav>${nav}</nav><div class="sidebar-bottom"><div class="sidebar-service"><span class="status-dot ${data.state.running ? 'good' : ''}"></span><div><strong>${esc(status.label)}</strong><span>${data.state.running ? '本地服务正在运行' : '一切从一段对话开始'}</span></div></div><div class="sidebar-version"><span>DSWhale Desktop</span><span>${esc(data.state.version || '')}</span></div></div></aside><div class="workspace"><header class="topbar"><div class="breadcrumb"><span>工作空间</span><span class="breadcrumb-slash">/</span><strong>${esc(panel ? panelNames[panel] || '控制台' : routeNames[route])}</strong></div><div class="topbar-right">${data.mode === 'preview' ? '<span class="preview-pill">只读预览</span>' : ''}<span class="topbar-status"><span class="status-dot ${data.state.running ? 'good' : ''}"></span>${esc(data.state.running ? '服务运行中' : '本地工作空间')}</span></div></header>${panel ? `<main class="embedded" id="main-content" tabindex="-1"><div class="panel-toolbar"><button type="button" data-action="home" class="panel-back">${icon('back')}返回${esc(routeNames[route])}</button><div class="panel-toolbar-actions"><span>${esc(panelNames[panel] || '控制台')} · 当前窗口</span>${button('首次登录口令', 'initial-login', { off: !desktop(data) || !data.state.installed || busy(data) })}</div></div><div class="embedded-placeholder"><span class="spinner" aria-hidden="true"></span><p>正在显示控制台…</p></div>${feedback ? `<div class="panel-feedback">${feedback}</div>` : ''}</main>` : `<main class="page" id="main-content" tabindex="-1">${preview}${feedback}${content}${route !== 'environment' ? progress(data) : ''}<footer class="page-footer"><span class="footer-line"></span><span>DSWhale · 让对话更有温度</span><span class="footer-line"></span></footer></main>`}</div>`;
    const page = document.querySelector('.page');
    if (page) page.scrollTop = scroll;
    if (focused) { const next = document.getElementById(focused); if (next) { next.focus({ preventScroll: true }); if (selection && typeof next.setSelectionRange === 'function' && next.type !== 'number') { try { next.setSelectionRange(...selection); } catch {} } } }
    if (!focused && (focusAction || focusRoute)) {
      const next = [...root.querySelectorAll('button')].find(item => focusRoute ? item.dataset.route === focusRoute : item.dataset.action === focusAction && item.dataset.panel === focusPanel);
      if (next && !next.disabled) next.focus({ preventScroll: true });
    }
    const announcement = error || data.notice || (busy(data) && data.state.step) || status.label;
    if (announcement !== lastAnnouncement) { document.getElementById('announcer').textContent = announcement; lastAnnouncement = announcement; }
  }
  async function run(action, payload) {
    try {
      const result = await controller.act(action, payload);
      if (action === 'restore' && !result?.canceled) { draft = null; dirty = false; reveal = false; render(controller.get()); }
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
  async function navigate(target) {
    if (!routeNames[target]) return;
    if (controller.get().state.panel) {
      await run('home');
      if (controller.get().state.panel) return;
    }
    route = target;
    reveal = false;
    render(controller.get());
    document.getElementById('main-content')?.focus({ preventScroll: true });
    const page = document.querySelector('.page'); if (page) page.scrollTop = 0;
    await ensureSettings();
  }
  function readField(target) {
    if (!draft) draft = { ...(controller.get().settings || {}) };
    draft[target.id] = target.type === 'checkbox' ? target.checked : target.value;
    dirty = true;
  }
  async function saveSettings() {
    await run('settings-save', draft || controller.get().settings);
    if (!controller.get().error) { dirty = false; draft = { ...controller.get().settings }; render(controller.get()); }
  }
  root.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target || target.disabled) return;
    if (target.dataset.route) return navigate(target.dataset.route);
    if (target.hasAttribute('data-reveal')) { reveal = !reveal; const input = document.getElementById('onebotToken'); input.type = reveal ? 'text' : 'password'; target.textContent = reveal ? '隐藏' : '显示'; target.setAttribute('aria-pressed', String(reveal)); return; }
    const action = target.dataset.action;
    if (!action) return;
    if (action === 'route-environment') return navigate('environment');
    if (action === 'save-settings') return saveSettings();
    if (action === 'retry') { const retry = controller.get().retry; if (retry) return run(retry.action, retry.payload); return; }
    if (action === 'settings-get') { await run(action); if (!dirty) draft = { ...controller.get().settings }; render(controller.get()); return; }
    await run(action, action === 'open-panel' ? { panel: target.dataset.panel } : undefined);
  });
  root.addEventListener('input', event => {
    if (event.target.matches('input') && event.target.type !== 'checkbox') readField(event.target);
  });
  root.addEventListener('change', event => {
    if (!event.target.matches('input')) return;
    readField(event.target);
    render(controller.get());
  });
  root.addEventListener('submit', event => { if (event.target.id === 'connection-form') { event.preventDefault(); saveSettings(); } });
  controller.subscribe(data => { if (data.settings && !dirty) draft = { ...data.settings }; render(data); });
  window.addEventListener('beforeunload', () => controller.dispose());
  render(controller.get());
  controller.init().catch(() => {}).then(ensureSettings);
})();
