'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { constants } = require('node:fs');

async function readJSON(file) { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
const CONNECTION_CHANNELS = ['napcat', 'official'];
function unknownChannels() {
  return Object.fromEntries(CONNECTION_CHANNELS.map(channel => [channel, { bound: false, platformReady: false, protocolConnected: false, state: 'unknown' }]));
}
function unknownConnectionHealth() { return { format: 0, updatedAt: 0, channels: unknownChannels() }; }
async function readRawHealth({ host }) {
  if (typeof host !== 'string') return null;
  let handle;
  try {
    const file = path.join(host, 'data/plugin_data/astrbot_plugin_dswhale/health.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 16384) return null;
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const actual = await handle.stat();
    if (!actual.isFile() || actual.nlink > 1 || actual.size > 16384) return null;
    const bytes = Buffer.alloc(16385), read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 16384) return null;
    return JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8'));
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}
function fresh(value, { startedAt = 0, now = Date.now() } = {}) {
  return Boolean(value && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
    && value.updatedAt >= Math.max(startedAt / 1000, now / 1000 - 90) && value.updatedAt <= now / 1000 + 5);
}
function normalizeConnectionHealth(value, options = {}) {
  if (!value || value.format !== 2 || !value.channels || typeof value.channels !== 'object' || !fresh(value, options)) return unknownConnectionHealth();
  const channels = {};
  for (const channel of CONNECTION_CHANNELS) {
    const entry = value.channels[channel];
    if (!entry || typeof entry !== 'object') { channels[channel] = { bound: false, platformReady: false, protocolConnected: false, state: 'unknown' }; continue; }
    const bound = entry.bound === true;
    const platformReady = entry.platformReady === true;
    const protocolConnected = entry.protocolConnected === true;
    const state = !options.running || !bound ? 'unknown' : protocolConnected ? 'connected' : platformReady ? 'connecting' : 'offline';
    channels[channel] = { bound, platformReady, protocolConnected, state };
  }
  return { format: 2, updatedAt: value.updatedAt, channels };
}
async function readConnectionHealth(options) {
  if (!options?.running) return unknownConnectionHealth();
  const value = await readRawHealth(options);
  return normalizeConnectionHealth(value, options);
}
async function readQQConnectionHealth({ host, running, startedAt = 0, now = Date.now(), channel = 'napcat', legacyChannel = '' }) {
  if (!running) return false;
  if (!['napcat', 'official'].includes(channel)) return null;
  const value = await readRawHealth({ host });
  if (!value || !fresh(value, { startedAt, now })) return null;
  if (value.format === 2) {
    const normalized = normalizeConnectionHealth(value, { startedAt, now, running });
    return normalized.format === 2 ? normalized.channels[channel].state === 'connected' : null;
  }
  // Format 1 only recorded one boolean. It may be attributed only to the
  // legacy channel that produced it; otherwise the health is unknown.
  if (!['napcat', 'official'].includes(legacyChannel) || channel !== legacyChannel) return null;
  return typeof value.qqConnected === 'boolean' ? value.qqConnected : null;
}
function dashboardURL(config) {
  const dashboard = config.dashboard;
  if (!dashboard || dashboard.enable === false || dashboard.host !== '127.0.0.1' || !Number.isInteger(dashboard.port) || dashboard.port < 1024 || dashboard.port > 65535 || dashboard.ssl?.enable) throw new Error('管理页面需启用本机 HTTP 地址 127.0.0.1；请检查高级配置');
  return `http://127.0.0.1:${dashboard.port}/`;
}
class PortConflictError extends Error {
  constructor(report) {
    super(`本机端口 ${report.occupiedPorts.join('、')} 已被占用；请更换连接端口，或手动停止您确认的对应服务后重试`);
    this.code = 'PORT-001';
    this.report = report;
  }
}
function probePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(new Error('无法检查本机连接端口，请检查系统网络权限后重试')));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
function portReport(ports, occupiedPorts) {
  return { ok: occupiedPorts.length === 0, code: occupiedPorts.length ? 'PORT-001' : null, ports, occupiedPorts,
    nextSteps: occupiedPorts.length ? [
      { id: 'change-port', label: '在高级配置中更换冲突端口，并同步修改连接端口' },
      { id: 'stop-service-manually', label: '确认占用服务后手动停止，再重试；应用不会结束其他程序' },
    ] : [] };
}
async function preflightPorts(config) {
  const url = dashboardURL(config);
  const dashboardPort = Number(new URL(url).port);
  const reversePorts = (config.platform ?? []).filter(p => p.enable && p.type === 'aiocqhttp').map(p => p.ws_reverse_port);
  if (reversePorts.includes(dashboardPort)) throw new Error('管理页面和 OneBot 连接不能共用相同端口，请在高级配置中更换端口');
  const ports = [...new Set([dashboardPort, ...reversePorts])];
  if (ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('连接端口配置无效');
  const available = await Promise.all(ports.map(probePort));
  return portReport(ports, ports.filter((port, index) => !available[index]));
}
async function portFree(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('连接端口配置无效');
  if (!await probePort(port)) throw new PortConflictError(portReport([port], [port]));
}
function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(700);
    const done = value => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
  });
}
function signalOwned(child, force = false) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // The host runs under DSWhale's Job Object wrapper. Only this PID's tree is stopped.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

class ServiceSupervisor {
  constructor({ manager, onChange = () => {} }) { this.manager = manager; this.onChange = onChange; this.child = null; this.starting = null; this.startedAt = 0; this.stopped = false; this.generation = 0; }
  get running() { return Boolean(this.child && this.child.exitCode === null && !this.child.killed); }
  async dashboard() { return dashboardURL(await readJSON(path.join(this.manager.host, 'data/cmd_config.json'))); }
  start() {
    if (this.starting) return this.starting;
    if (this.running) return Promise.resolve();
    const generation = ++this.generation;
    this.starting = this._start(generation).finally(() => { this.starting = null; });
    return this.starting;
  }
  _active(generation) { if (generation !== this.generation) throw new Error('启动已取消'); }
  async _start(generation) {
    const config = await readJSON(path.join(this.manager.host, 'data/cmd_config.json'));
    this._active(generation);
    const url = dashboardURL(config);
    const report = await preflightPorts(config);
    this._active(generation);
    if (!report.ok) throw new PortConflictError(report);
    const python = this.manager.python;
    const args = process.platform === 'win32' ? [path.join(this.manager.source, 'dswhale/winjob.py'), python, '-m', 'astrbot.cli', 'run'] : ['-m', 'astrbot.cli', 'run'];
    const environment = { ...await this.manager.environment(), ASTRBOT_DESKTOP_MANAGED: '1' };
    // This application uses its existing dashboard login, not another launcher's session.
    delete environment.ASTRBOT_DESKTOP_SESSION_SECRET;
    this._active(generation);
    const child = spawn(python, args, { cwd: this.manager.host, env: environment, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child; this.stopped = false; this.startedAt = Date.now();
    // Do not forward raw host logs: messages, account data and service keys may appear there.
    child.stdout.resume(); child.stderr.resume();
    child.on('error', () => { if (this.child === child) { this.child = null; this.onChange({ running: false, error: '对话服务无法启动，请重新检查环境' }); } });
    child.on('exit', () => {
      if (this.child === child) { this.child = null; this.onChange({ running: false, ...(this.stopped ? {} : { error: '对话服务已退出，请检查配置后重试' }) }); }
    });
    try {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        this._active(generation);
        if (this.child !== child || child.exitCode !== null) throw new Error('对话服务启动失败，请检查模型和插件配置');
        if (await portOpen(Number(new URL(url).port))) { this.onChange({ running: true, error: undefined }); return; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('对话服务准备超时，请检查网络和配置后重试');
    } catch (error) { await this._stopChild(); throw error; }
  }
  async stop() {
    const pending = this.starting;
    ++this.generation;
    await this._stopChild();
    if (pending) await pending.catch(() => {});
  }
  async _stopChild() {
    const child = this.child;
    if (!child) return;
    this.stopped = true;
    const closed = once(child, 'close').catch(() => {});
    signalOwned(child);
    let timer;
    try {
      await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { signalOwned(child, true); resolve(); }, 5000); })]);
      if (child.exitCode === null) await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000))]);
    } finally { clearTimeout(timer); if (this.child === child) this.child = null; }
    this.onChange({ running: false });
  }
}

async function settingsCommand(manager, action, payload) {
  const environment = await manager.environment();
  return new Promise((resolve, reject) => {
    const child = spawn(manager.python, ['-m', 'dswhale.desktop_settings', action, '--host', manager.host], { cwd: manager.host, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', tooLarge = false;
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', value => { output += value.toString('utf8'); if (output.length > 65536) { tooLarge = true; child.kill(); } });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('请先准备运行环境')); });
    child.on('close', code => {
      clearTimeout(timer);
      try { const value = JSON.parse(output); if (code || tooLarge || value.error) throw new Error(); resolve(value); }
      catch { reject(new Error('配置未完成，请停止服务并检查输入后重试')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(action === 'save' || action === 'restore-field' ? JSON.stringify(payload) : '');
  });
}

module.exports = { ServiceSupervisor, settingsCommand, dashboardURL, portFree, portOpen, preflightPorts, PortConflictError, readQQConnectionHealth, readConnectionHealth };
