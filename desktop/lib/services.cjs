'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function readJSON(file) { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
function dashboardURL(config) {
  const dashboard = config.dashboard;
  if (!dashboard || dashboard.enable === false || dashboard.host !== '127.0.0.1' || !Number.isInteger(dashboard.port) || dashboard.port < 1024 || dashboard.port > 65535 || dashboard.ssl?.enable) throw new Error('管理页面需启用本机 HTTP 地址 127.0.0.1；请检查高级配置');
  return `http://127.0.0.1:${dashboard.port}/`;
}
function portFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`本机端口 ${port} 已被占用，请先关闭对应服务或更换端口`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
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
    const ports = [Number(new URL(url).port), ...(config.platform ?? []).filter(p => p.enable && p.type === 'aiocqhttp').map(p => p.ws_reverse_port)];
    for (const port of new Set(ports)) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('连接端口配置无效');
      await portFree(port);
      this._active(generation);
    }
    const python = this.manager.python;
    const args = process.platform === 'win32' ? [path.join(this.manager.source, 'dswhale/winjob.py'), python, '-m', 'astrbot.cli', 'run'] : ['-m', 'astrbot.cli', 'run'];
    const environment = await this.manager.environment();
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
    child.stdin.end(action === 'save' ? JSON.stringify(payload) : '');
  });
}

module.exports = { ServiceSupervisor, settingsCommand, dashboardURL, portFree, portOpen };
