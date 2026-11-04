'use strict';
// Pure connection orchestration: no Electron, fs, process or network access.
// The main process injects the actual platform/config/process operations.
const CHANNELS = ['napcat', 'official'];
const PLATFORM = {
  napcat: { channel: 'napcat', type: 'aiocqhttp', label: '普通 QQ 小号', typed: '小号' },
  official: { channel: 'official', type: 'qq_official', label: 'QQ 官方机器人', typed: '官方' },
};
const HEALTH_STATES = new Set(['connected', 'connecting', 'offline', 'unknown']);

function channelForType(type) {
  for (const channel of CHANNELS) if (PLATFORM[channel].type === type) return channel;
  return null;
}

function resolveTarget(channel, platforms, boundPlatformIds) {
  const candidates = platforms.filter(item => item && item.type === PLATFORM[channel].type);
  const boundId = typeof boundPlatformIds?.[channel] === 'string' ? boundPlatformIds[channel] : '';
  if (boundId) {
    const matches = candidates.filter(item => item.id === boundId);
    if (matches.length === 1) return { platform: matches[0], issue: '' };
    return { platform: null, issue: matches.length === 0 ? 'missing-bound' : 'ambiguous' };
  }
  if (candidates.length === 1) return { platform: candidates[0], issue: '' };
  if (candidates.length === 0) return { platform: null, issue: 'missing' };
  // Multiple platforms and no binding: never guess the first one.
  return { platform: null, issue: 'ambiguous' };
}

function selectNapcatConnection(platforms, boundId) {
  // Resolve the exact OneBot instance DSWhale uses for its owned component.
  // Other enabled OneBot platforms are preserved and never considered.
  const candidates = Array.isArray(platforms) ? platforms.filter(item => item && item.type === 'aiocqhttp') : [];
  let target = null;
  if (boundId) {
    const matches = candidates.filter(item => item.id === boundId);
    if (matches.length !== 1) return null;
    target = matches[0];
  } else if (candidates.length === 1) {
    target = candidates[0];
  } else {
    return null;
  }
  if (
    target.enable !== true ||
    target.ws_reverse_host !== '127.0.0.1' ||
    !Number.isInteger(target.ws_reverse_port) ||
    target.ws_reverse_port < 1024 ||
    target.ws_reverse_port > 65535 ||
    typeof target.ws_reverse_token !== 'string' ||
    target.ws_reverse_token.length < 16 ||
    target.ws_reverse_token.length > 4096 ||
    /[\r\n\0]/.test(target.ws_reverse_token)
  ) return null;
  return { platformId: target.id, port: target.ws_reverse_port, token: target.ws_reverse_token };
}

function snapshot(input = {}) {
  const platforms = Array.isArray(input.platforms) ? input.platforms : [];
  const health = input.health && typeof input.health === 'object' && input.health.channels && typeof input.health.channels === 'object' ? input.health.channels : {};
  const napcat = input.napcat && typeof input.napcat === 'object' ? input.napcat : {};
  const bindings = input.bindings && typeof input.bindings === 'object' ? input.bindings : {};
  const boundPlatformIds = input.boundPlatformIds && typeof input.boundPlatformIds === 'object' ? input.boundPlatformIds : {};
  const channels = CHANNELS.map(channel => {
    const candidates = platforms.filter(item => item && item.type === PLATFORM[channel].type);
    const resolved = resolveTarget(channel, platforms, boundPlatformIds);
    const platform = resolved.platform;
    const entry = health[channel];
    return {
      channel,
      label: PLATFORM[channel].label,
      platformType: PLATFORM[channel].type,
      platformId: typeof platform?.id === 'string' ? platform.id : '',
      platformEnabled: platform?.enable === true,
      configured: platform?.configured === true,
      targetIssue: resolved.issue,
      boundPlatformId: typeof boundPlatformIds[channel] === 'string' ? boundPlatformIds[channel] : '',
      platformCandidates: candidates.map(item => ({ id: typeof item.id === 'string' ? item.id : '', enable: item.enable === true, configured: item.configured === true })),
      bound: bindings[channel] === true,
      processRunning: channel === 'napcat' ? Boolean(napcat.running) : false,
      loginState: channel === 'napcat' && typeof napcat.loginState === 'string' ? napcat.loginState : '',
      protocolConnected: entry?.protocolConnected === true,
      identityKnown: channel === 'napcat' ? input.napcatIdentityKnown !== false : true,
      health: HEALTH_STATES.has(entry?.state) ? entry.state : 'unknown',
    };
  });
  return {
    revision: typeof input.revision === 'string' ? input.revision : '',
    running: input.running === true,
    defaultDelivery: CHANNELS.includes(input.defaultDelivery) ? input.defaultDelivery : '',
    enabled: channels.filter(item => item.platformEnabled).map(item => item.channel),
    channels,
  };
}

function channelEntry(value, channel) {
  return Array.isArray(value?.channels) ? value.channels.find(item => item.channel === channel) || null : null;
}

function planChange(value, request, options = {}) {
  if (!value || !Array.isArray(value.channels) || typeof value.revision !== 'string') return { ok: false, error: '连接状态无效，请刷新后重试' };
  if (!request || !CHANNELS.includes(request.channel) || typeof request.enabled !== 'boolean') return { ok: false, error: '连接操作无效' };
  const entry = channelEntry(value, request.channel);
  if (!entry) return { ok: false, error: '连接操作无效' };
  if (entry.targetIssue === 'ambiguous') return { ok: false, error: `存在多个同类型平台，无法确定${entry.label}要操作哪个实例；请先在 AstrBot 平台设置中修正，或重新完成主人绑定` };
  if (entry.targetIssue === 'missing-bound') return { ok: false, error: `${entry.label}绑定的平台实例已不存在；请先重新完成绑定，再启用或停用连接` };
  const base = { ok: true, noop: false, channel: entry.channel, label: entry.label, platformId: entry.platformId, revision: value.revision, typedLabel: PLATFORM[entry.channel].typed, requiresRestart: value.running, stopNapcat: false, effects: [] };
  if (entry.platformEnabled === request.enabled) return { ...base, noop: true, message: `${entry.label}已经处于${request.enabled ? '启用' : '停用'}状态。`, effects: [] };
  if (request.enabled) {
    if (!entry.platformId || !entry.configured) return { ok: false, error: `请先完成${entry.label}的配置，再启用连接` };
    return {
      ...base,
      enable: true,
      effects: [
        `启用${entry.label}`,
        value.running ? '先停止对话服务，写入平台配置后重启' : '下次启动对话服务时生效',
        '其他连接的配置与组件保留；重启期间消息连接会短暂中断',
      ],
      message: `将启用${entry.label}，${value.running ? '先停止对话服务写入平台配置，然后重新启动' : '将在下次启动对话服务时生效'}。`,
    };
  }
  if (options.pendingActivity === true) return { ok: false, error: '还有未完成的主动活动，请等它结束后再停用连接' };
  if (request.enabled === false && PLATFORM[entry.channel].type === 'aiocqhttp' && entry.processRunning && entry.identityKnown === false) {
    return { ok: false, error: '无法确认普通 QQ 小号当前登录身份，暂不停止连接' };
  }
  if (value.enabled.length <= 1) return { ok: false, error: '至少要保留一路可用的 QQ 连接；如要切换，请先启用另一条连接' };
  if (!value.defaultDelivery) return { ok: false, error: '请先选择主动消息默认渠道，再停用连接' };
  if (value.defaultDelivery === entry.channel) return { ok: false, error: `请先把主动消息默认渠道改到另一条连接，再停用${entry.label}` };
  const stopNapcat = entry.channel === 'napcat' && entry.processRunning;
  const effects = [`停用${entry.label}`];
  if (entry.channel === 'napcat') {
    effects.push(stopNapcat ? '结束普通 QQ 小号进程' : '结束该平台在对话服务中的加载');
    effects.push('官方机器人进程不因本操作结束；重启对话服务时其消息连接会短暂中断');
  } else {
    effects.push('结束官方机器人在对话服务中的连接');
    effects.push('普通 QQ 小号进程保持运行；重启对话服务时其消息连接会短暂中断');
  }
  if (value.running) effects.push('先停止对话服务，写入平台配置后重启');
  return {
    ...base,
    enable: false,
    stopNapcat,
    effects,
    message: `将停用${entry.label}。${stopNapcat ? '普通 QQ 小号进程会被结束。' : ''}${value.running ? '先停止对话服务写入平台配置，然后重新启动；期间两条消息连接都会短暂中断。' : ''}`,
  };
}

function typedPrompt(plan) {
  return plan && plan.typedLabel ? `请输入「${plan.typedLabel}」确认：${plan.message}` : '';
}

function checkTyped(plan, value) {
  if (!plan || !plan.typedLabel) return { ok: false, error: '连接操作无效' };
  if (typeof value !== 'string' || value.trim() !== plan.typedLabel) return { ok: false, error: `请输入「${plan.typedLabel}」确认操作` };
  return { ok: true };
}

function isStale(plan, currentRevision) {
  return Boolean(plan) && typeof currentRevision === 'string' && plan.revision !== currentRevision;
}

async function executePlan(plan, io = {}) {
  const confirmed = checkTyped(plan, io.typed);
  if (!confirmed.ok) return confirmed;
  if (plan.noop) return { ok: true, events: [], snapshot: typeof io.snapshotAfter === 'function' ? await io.snapshotAfter() : null };
  // Validate every required interface before changing anything.
  if (typeof io.setPlatform !== 'function') return { ok: false, error: '缺少平台开关接口' };
  if (plan.requiresRestart && typeof io.stopConversation !== 'function') return { ok: false, error: '缺少停止对话服务的接口' };
  if (plan.requiresRestart && typeof io.restartConversation !== 'function') return { ok: false, error: '缺少重启对话服务的接口' };
  if (!plan.enable && plan.stopNapcat && typeof io.stopComponent !== 'function') return { ok: false, error: '缺少停止独立组件的接口' };
  const events = [];
  const isOpen = typeof io.isOpen === 'function' ? io.isOpen : () => true;
  const ensureOpen = () => {
    if (!isOpen()) throw new Error('应用正在退出');
  };
  let conversationStopped = false;
  try {
    // AstrBot holds astrbot.lock while running. The platform config write would
    // fail against that lock, and stopping the component first would leave a
    // half-applied change, so stop the host before touching either.
    if (plan.requiresRestart) {
      ensureOpen();
      await io.stopConversation();
      conversationStopped = true;
      events.push('stop-conversation');
    }
    ensureOpen();
    await io.setPlatform(plan.channel, plan.enable);
    events.push(plan.enable ? 'enable-platform' : 'disable-platform');
    if (!plan.enable && plan.stopNapcat) {
      ensureOpen();
      await io.stopComponent(plan.channel);
      events.push('stop-component');
    }
    if (plan.requiresRestart) {
      ensureOpen();
      await io.restartConversation();
      conversationStopped = false;
      events.push('restart-conversation');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const platformChanged = events.includes('enable-platform') || events.includes('disable-platform');
    if (!conversationStopped) return { ok: false, error: message, events };
    if (!isOpen()) {
      events.push('restore-canceled');
      return { ok: false, error: `${message}；应用正在退出，未恢复对话服务`, events };
    }
    try {
      if (typeof io.restoreConversation === 'function') {
        await io.restoreConversation();
        events.push('restore-conversation');
      } else {
        await io.restartConversation();
        events.push('restart-conversation');
      }
    } catch {
      events.push('restore-failed');
      return { ok: false, error: `${message}；对话服务已停止且未能自动恢复，请手动启动`, events };
    }
    return { ok: false, error: platformChanged ? `${message}；平台开关可能已更新，请查看最新连接状态` : message, events };
  }
  return { ok: true, events, snapshot: typeof io.snapshotAfter === 'function' ? await io.snapshotAfter() : null };
}

function describeChannels(value) {
  if (!value || !Array.isArray(value.channels)) return [];
  return value.channels.map(entry => {
    const state = entry.targetIssue ? 'needs-attention' : !entry.platformEnabled ? 'disabled' : entry.bound ? (entry.health === 'connected' || entry.protocolConnected ? 'connected' : 'unbound-or-waiting') : 'enabled-unbound';
    return { ...entry, state };
  });
}

module.exports = {
  CHANNELS,
  PLATFORM,
  channelForType,
  selectNapcatConnection,
  snapshot,
  planChange,
  typedPrompt,
  checkTyped,
  isStale,
  executePlan,
  describeChannels,
};
