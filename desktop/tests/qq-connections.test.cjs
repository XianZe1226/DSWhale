'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib/qq-connections.cjs');

function status(overrides = {}) {
  return {
    revision: 'rev-1',
    running: true,
    defaultDelivery: 'napcat',
    platforms: [
      { id: 'old-qq', type: 'aiocqhttp', enable: true, configured: true },
      { id: 'official-test', type: 'qq_official', enable: true, configured: true },
    ],
    bindings: { napcat: true, official: true },
    napcat: { running: true, loginState: 'online' },
    health: { channels: { napcat: { state: 'connected', protocolConnected: true }, official: { state: 'connecting', protocolConnected: false } } },
    ...overrides,
  };
}

test('snapshot exposes both channels without credentials and unknown health degrades safely', () => {
  const value = lib.snapshot(status());
  assert.deepEqual(value.enabled, ['napcat', 'official']);
  assert.equal(value.channels[0].platformId, 'old-qq');
  assert.equal(value.channels[0].health, 'connected');
  assert.equal(value.channels[1].health, 'connecting');
  assert.equal(value.channels[1].processRunning, false);
  const unknown = lib.snapshot(status({ health: { channels: { napcat: { state: 'made-up' } } } }));
  assert.equal(unknown.channels[1].health, 'unknown');
  assert.equal(unknown.channels[0].health, 'unknown');
  assert.equal(lib.snapshot({}).channels.every(item => item.health === 'unknown'), true);
});

test('plans are preview-only and describe the real channel impact', () => {
  const value = lib.snapshot(status({ defaultDelivery: 'official' }));
  const noop = lib.planChange(value, { channel: 'official', enabled: true });
  assert.equal(noop.ok, true);
  assert.equal(noop.noop, true);
  const enable = lib.planChange(lib.snapshot(status({ platforms: [{ id: 'q', type: 'aiocqhttp', enable: false, configured: true }], enabled: undefined })), { channel: 'napcat', enabled: true });
  assert.equal(enable.ok, true);
  assert.equal(enable.requiresRestart, true);
  assert.match(enable.effects.join(' '), /写入平台配置后重启/);
  const missing = lib.planChange(lib.snapshot(status({ platforms: [{ id: 'q', type: 'qq_official', enable: false, configured: false }] })), { channel: 'official', enabled: true });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /配置/);
});

test('stopping a channel is explicit, typed and keeps the other channel running', () => {
  const value = lib.snapshot(status());
  const official = lib.planChange(value, { channel: 'official', enabled: false });
  assert.equal(official.ok, true);
  assert.equal(official.typedLabel, '官方');
  assert.equal(official.stopNapcat, false);
  assert.match(official.effects.join(' '), /普通 QQ 小号进程保持运行/);
  const napcat = lib.planChange(lib.snapshot(status({ defaultDelivery: 'official' })), { channel: 'napcat', enabled: false });
  assert.equal(napcat.ok, true);
  assert.equal(napcat.stopNapcat, true);
  assert.match(napcat.message, /小号进程会被结束/);
  assert.match(napcat.effects.join(' '), /官方机器人进程不因本操作结束/);
  assert.match(lib.typedPrompt(napcat), /请输入「小号」/);
});

test('invalid disable cases are rejected before any side effect', () => {
  const value = lib.snapshot(status({ defaultDelivery: 'official' }));
  assert.match(lib.planChange(value, { channel: 'official', enabled: false }).error, /默认渠道/);
  assert.match(lib.planChange(lib.snapshot(status({ defaultDelivery: '' })), { channel: 'napcat', enabled: false }).error, /默认渠道|至少/);
  assert.match(lib.planChange(lib.snapshot(status({ platforms: [{ id: 'q', type: 'aiocqhttp', enable: true, configured: true }] })), { channel: 'napcat', enabled: false }).error, /至少.*保留/);
  assert.match(lib.planChange(value, { channel: 'official', enabled: false }, { pendingActivity: true }).error, /主动活动/);
  assert.equal(lib.planChange(value, { channel: 'official', enabled: 'yes' }).ok, false);
});

test('stale plans and wrong typed confirmation cannot execute', async () => {
  const plan = lib.planChange(lib.snapshot(status({ defaultDelivery: 'official' })), { channel: 'napcat', enabled: false });
  assert.equal(lib.isStale(plan, 'rev-2'), true);
  assert.equal(lib.isStale(plan, 'rev-1'), false);
  let called = 0;
  const io = { typed: '官方', setPlatform: async () => { called += 1; }, stopComponent: async () => { called += 1; }, restartConversation: async () => { called += 1; } };
  const rejected = await lib.executePlan(plan, io);
  assert.equal(rejected.ok, false);
  assert.equal(called, 0);
});

test('confirmed execution orders component stop, platform toggle and conversation restart', async () => {
  const value = lib.snapshot(status({ defaultDelivery: 'official' }));
  const plan = lib.planChange(value, { channel: 'napcat', enabled: false });
  const events = [];
  const result = await lib.executePlan(plan, {
    typed: '小号',
    stopConversation: async () => events.push('stop-conversation'),
    stopComponent: async channel => events.push(`stop:${channel}`),
    setPlatform: async (channel, enabled) => events.push(`set:${channel}:${enabled}`),
    restartConversation: async () => events.push('restart'),
    snapshotAfter: async () => ({ revision: 'rev-2' }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['stop-conversation', 'set:napcat:false', 'stop:napcat', 'restart']);
  assert.deepEqual(result.events, ['stop-conversation', 'disable-platform', 'stop-component', 'restart-conversation']);
  assert.equal(result.snapshot.revision, 'rev-2');
});

test('official disable never stops the QQ component and noop plans do nothing', async () => {
  const events = [];
  const plan = lib.planChange(lib.snapshot(status()), { channel: 'official', enabled: false });
  const result = await lib.executePlan(plan, {
    typed: '官方',
    stopConversation: async () => events.push('stop-conversation'),
    stopComponent: async () => events.push('stop-component'),
    setPlatform: async (channel, enabled) => events.push(`set:${channel}:${enabled}`),
    restartConversation: async () => events.push('restart'),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['stop-conversation', 'set:official:false', 'restart']);
  const noop = lib.planChange(lib.snapshot(status()), { channel: 'napcat', enabled: true });
  const noopResult = await lib.executePlan(noop, { typed: '小号', setPlatform: async () => events.push('should-not-run') });
  assert.deepEqual(events, ['stop-conversation', 'set:official:false', 'restart']);
  assert.equal(noopResult.ok, true);
});

test('a failed config write after the host stop restores the conversation before any component stop', async () => {
  const events = [];
  const plan = lib.planChange(lib.snapshot(status({ defaultDelivery: 'official' })), { channel: 'napcat', enabled: false });
  const result = await lib.executePlan(plan, {
    typed: '小号',
    stopConversation: async () => events.push('stop-conversation'),
    setPlatform: async () => { events.push('set-platform'); throw new Error('请先在应用内停止对话服务，再修改连接平台'); },
    stopComponent: async () => events.push('stop-component'),
    restartConversation: async () => events.push('restart'),
    restoreConversation: async () => events.push('restore-conversation'),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(events, ['stop-conversation', 'set-platform', 'restore-conversation']);
  assert.deepEqual(result.events, ['stop-conversation', 'restore-conversation']);
  assert.match(result.error, /停止对话服务/);
});

test('missing lifecycle interfaces fail before stopping or writing anything', async () => {
  const plan = lib.planChange(lib.snapshot(status()), { channel: 'official', enabled: false });
  let called = 0;
  const result = await lib.executePlan(plan, { typed: '官方', setPlatform: async () => { called += 1; } });
  assert.equal(result.ok, false);
  assert.match(result.error, /停止对话服务/);
  assert.equal(called, 0);
  const stopped = lib.planChange(lib.snapshot(status({ running: false, defaultDelivery: 'napcat' })), { channel: 'official', enabled: false });
  const events = [];
  const stoppedResult = await lib.executePlan(stopped, {
    typed: '官方',
    setPlatform: async (channel, enabled) => events.push(`set:${channel}:${enabled}`),
  });
  assert.equal(stoppedResult.ok, true);
  assert.deepEqual(events, ['set:official:false']);
  assert.deepEqual(stoppedResult.events, ['disable-platform']);
});

test('channel descriptions are derived from platform, binding and health', () => {
  const described = lib.describeChannels(lib.snapshot(status({ health: { channels: { napcat: { protocolConnected: false } } } })));
  assert.equal(described[0].state, 'unbound-or-waiting');
  assert.equal(described[1].state, 'unbound-or-waiting');
  const disabled = lib.describeChannels(lib.snapshot(status({ platforms: [{ id: 'q', type: 'aiocqhttp', enable: false }] })));
  assert.equal(disabled[0].state, 'disabled');
});

test('connection control targets the bound platform instance instead of the first same type', () => {
  const platforms = [
    { id: 'unbound-first', type: 'aiocqhttp', enable: true, configured: true },
    { id: 'bound-second', type: 'aiocqhttp', enable: false, configured: true },
    { id: 'official-test', type: 'qq_official', enable: true, configured: true },
  ];
  const value = lib.snapshot(status({ platforms, boundPlatformIds: { napcat: 'bound-second' } }));
  assert.equal(value.channels[0].platformId, 'bound-second');
  assert.equal(value.channels[0].targetIssue, '');
  const plan = lib.planChange(value, { channel: 'napcat', enabled: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.platformId, 'bound-second');
  const reversed = lib.snapshot(status({ platforms: [...platforms].reverse(), boundPlatformIds: { napcat: 'bound-second' } }));
  assert.equal(reversed.channels[0].platformId, 'bound-second');
  const rebound = lib.snapshot(status({ platforms, boundPlatformIds: { napcat: 'unbound-first' } }));
  assert.equal(rebound.channels[0].platformId, 'unbound-first');

  // Multiple same-type platforms without a binding are ambiguous, not "first".
  const ambiguous = lib.snapshot(status({ platforms, boundPlatformIds: {} }));
  assert.equal(ambiguous.channels[0].targetIssue, 'ambiguous');
  assert.match(lib.planChange(ambiguous, { channel: 'napcat', enabled: true }).error, /多个/);
  const missing = lib.snapshot(status({ platforms, boundPlatformIds: { napcat: 'gone' } }));
  assert.equal(missing.channels[0].targetIssue, 'missing-bound');
  assert.match(lib.planChange(missing, { channel: 'napcat', enabled: true }).error, /不存在/);

  // A single unbound platform is deterministic and safe to enable for binding.
  const single = lib.snapshot(status({ platforms: [{ id: 'only-one', type: 'aiocqhttp', enable: false, configured: true }] }));
  assert.equal(single.channels[0].platformId, 'only-one');
  assert.equal(lib.planChange(single, { channel: 'napcat', enabled: true }).ok, true);
  assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC|secret|token/i);
});

test('the OneBot connection is selected from the bound instance even with other enabled robots', () => {
  const token = 'SYNTHETIC-BOUND-TOKEN-123456';
  const platforms = [
    { id: 'other-bot', type: 'aiocqhttp', enable: true, ws_reverse_host: '127.0.0.1', ws_reverse_port: 6201, ws_reverse_token: 'other-token-1234567890' },
    { id: 'bound-qq', type: 'aiocqhttp', enable: true, ws_reverse_host: '127.0.0.1', ws_reverse_port: 6299, ws_reverse_token: token },
  ];
  assert.deepEqual(lib.selectNapcatConnection(platforms, 'bound-qq'), { platformId: 'bound-qq', port: 6299, token });
  assert.deepEqual(lib.selectNapcatConnection([...platforms].reverse(), 'bound-qq'), { platformId: 'bound-qq', port: 6299, token });
  assert.equal(lib.selectNapcatConnection(platforms, 'missing'), null);
  assert.equal(lib.selectNapcatConnection(platforms, ''), null, 'multiple unbound robots are ambiguous');
  assert.equal(lib.selectNapcatConnection([{ id: 'only', type: 'qq_official', enable: true }]), null);
  const disabled = platforms.map(item => item.id === 'bound-qq' ? { ...item, enable: false } : item);
  assert.equal(lib.selectNapcatConnection(disabled, 'bound-qq'), null);
  const external = platforms.map(item => item.id === 'bound-qq' ? { ...item, ws_reverse_host: '0.0.0.0' } : item);
  assert.equal(lib.selectNapcatConnection(external, 'bound-qq'), null);
  const shortToken = platforms.map(item => item.id === 'bound-qq' ? { ...item, ws_reverse_token: 'short' } : item);
  assert.equal(lib.selectNapcatConnection(shortToken, 'bound-qq'), null);
});
