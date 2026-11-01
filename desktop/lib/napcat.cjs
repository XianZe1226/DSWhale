'use strict';
// Optional independent protocol component. Never finds or patches installed QQ.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const officialAssets = require('./napcat-assets.json');
const CLIENT_NAME = 'DSWhale';
const GUIDE = 'https://napneko.github.io/guide/boot/Shell';
class NapCatError extends Error {
  constructor(code, message) { super(message); this.name = 'NapCatError'; this.code = code; }
}
const unsafe = () => new NapCatError('NAP-002', '独立组件目录或文件不安全，请选择无符号链接的官方独立目录');
async function safePath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\r\n\0]/.test(file)) throw unsafe();
  let current = path.resolve(file);
  for (;;) {
    try { const stat = await fs.lstat(current); if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw unsafe(); }
    catch (error) { if (error.code !== 'ENOENT') throw error instanceof NapCatError ? error : unsafe(); }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
async function readText(file, fallback, limit = 1024 * 1024) {
  await safePath(file);
  try { const stat = await fs.stat(file); if (!stat.isFile() || stat.size > limit) throw unsafe(); return (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function atomic(file, text) {
  await safePath(file); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await safePath(path.dirname(file));
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await safePath(file); await fs.rename(temporary, file); await fs.chmod(file, 0o600); }
  finally { await fs.rm(temporary, { force: true }); }
}
function environmentValues(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) { const line = raw.trim(); if (!line || line.startsWith('#')) continue; const index = line.indexOf('='); if (index > 0) values[line.slice(0, index).trim()] = line.slice(index + 1).trim(); }
  return values;
}
function updateEnvironment(text, values) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const pending = new Set(Object.keys(values)), lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const key = raw.trim().split('=', 1)[0].trim();
    if (Object.hasOwn(values, key)) { if (pending.delete(key)) lines.push(`${key}=${values[key]}`); }
    else lines.push(raw);
  }
  while (lines.at(-1) === '') lines.pop();
  for (const key of pending) lines.push(`${key}=${values[key]}`);
  return lines.join(newline) + newline;
}
async function accountConfigs(directory) {
  await safePath(directory);
  let names; try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (names.length > 2000) throw unsafe();
  const matches = names.filter(name => /^onebot11_[1-9]\d{4,19}\.json$/.test(name));
  for (const name of matches) await safePath(path.join(directory, name));
  return matches.sort();
}
async function defaultStopOwned(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.exitCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  if (process.platform === 'win32') {
    const killer = childProcess.spawn(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else { child.kill('SIGTERM'); }
  let timer;
  try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); })]); }
  finally { clearTimeout(timer); }
}
class NapCatManager {
  constructor({ manager, userData, platform = process.platform, assets = officialAssets, getConnection,
    spawn = childProcess.spawn, stopOwned = defaultStopOwned, onChange = () => {}, fetch = globalThis.fetch, runner } = {}) {
    this.manager = manager; this.platform = platform; this.assets = assets; this.getConnection = getConnection;
    this.spawn = spawn; this.stopOwned = stopOwned; this.onChange = onChange; this.fetch = fetch; this.runner = runner;
    this.base = path.resolve(userData ? path.join(userData, 'napcat') : path.join(manager.runtime, 'napcat'));
    this.data = path.join(this.base, 'qq-data'); this.work = path.join(this.base, 'work');
    this.receipt = path.join(this.base, 'receipt.json'); this.child = null; this.starting = null; this.installing = null; this.generation = 0; this.controller = null;
  }
  get running() { return Boolean(this.child && this.child.exitCode === null && !this.child.killed); }
  _supported(configure = false) { if (this.platform !== 'win32' && !(configure && this.platform === 'linux')) throw new NapCatError('NAP-EXTERNAL', '此平台使用外部独立协议端连接；请按指南设置，不修改官方 QQ'); }
  _binary(folder) { return this.platform === 'linux' ? folder : path.join(folder, 'napcat'); }
  _active(generation) { if (generation !== this.generation) throw new NapCatError('NAP-CANCELLED', '独立组件启动已取消'); }
  async _record() {
    const raw = await readText(this.receipt, 'null', 16384);
    let value; try { value = JSON.parse(raw); } catch { throw unsafe(); }
    if (value !== null && (value.schema !== 1 || typeof value.folder !== 'string' || !path.isAbsolute(value.folder))) throw unsafe();
    return value;
  }
  _values(folder) { return { NAPCAT_QQ_DATA_DIR: this.data, NAPCAT_WORKDIR: this.work,
    NAPCAT_DISABLE_PIPE: '1', NAPCAT_DISABLE_MULTI_PROCESS: '1',
    ...(this.platform === 'win32' ? { NAPCAT_WRAPPER_PATH: path.join(folder, 'wrapper.node'),
      NAPCAT_QQ_PACKAGE_INFO_PATH: path.join(folder, 'package.json'), NAPCAT_QQ_VERSION_CONFIG_PATH: path.join(folder, 'config.json') } : {}) }; }
  async _isolation(folder) {
    const text = await readText(path.join(this._binary(folder), 'config/.env'), '', 65536), current = environmentValues(text);
    if (Object.keys(current).some(key => /^(NODE_OPTIONS|NODE_PATH|NAPCAT_PRELOAD_NODE_ADDON_PATH)$/i.test(key))) throw unsafe();
    await safePath(this.data); await safePath(this.work);
    const webui = await this._webui();
    return Object.entries(this._values(folder)).every(([key, value]) => current[key] === value)
      && current.NAPCAT_WEBUI_PREFERRED_PORT === String(webui.port);
  }
  async _webui() {
    const value = JSON.parse(await readText(path.join(this.work, 'config/webui.json'), undefined, 65536));
    if (!value || value.host !== '127.0.0.1' || value.disableWebUI === true || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535
      || typeof value.token !== 'string' || value.token.length < 8 || value.token.length > 4096 || /[\x00-\x1f\x7f]/.test(value.token)) throw new NapCatError('NAP-WEBUI', '独立组件登录页面需使用本机隔离配置，请重新配置');
    return value;
  }
  async loginInfo() {
    // Main process only: the caller displays/copies this in a native dialog.
    // Never attach this object to status, progress events, IPC results or logs.
    try {
      this._supported(true); const record = await this._record();
      if (!record || !await this._isolation(record.folder)) throw new NapCatError('NAP-WEBUI', '请先完成独立组件的本机隔离配置');
      const value = await this._webui(); await fs.chmod(path.join(this.work, 'config/webui.json'), 0o600);
      return { url: `http://127.0.0.1:${value.port}/webui/`, token: value.token };
    } catch (error) { if (error instanceof NapCatError) throw error; throw new NapCatError('NAP-WEBUI', '登录信息尚未准备好，请先配置并启动独立组件后重试'); }
  }
  async _verify(folder) {
    await safePath(folder);
    if (/^\/(?:opt|usr\/lib)\/qq(?:\/|$)/i.test(folder) || /(?:^|[\\/])(?:QQ\.app|Tencent Files)(?:[\\/]|$)/i.test(folder)) throw unsafe();
    // Only byte-identical files from the pinned official standalone Node asset
    // may execute. Shell/OneKey launchers are never run or inferred from registry.
    const expectedFiles = this.platform === 'linux' ? Object.fromEntries(Object.entries(this.assets.files).filter(([name]) => name.startsWith('napcat/')).map(([name, hash]) => [name.slice(7), hash])) : this.assets.files;
    for (const [name, expected] of Object.entries(expectedFiles)) {
      if (path.isAbsolute(name) || name.split('/').includes('..') || name.includes('\\')) throw unsafe();
      const file = path.join(folder, name); await safePath(file);
      let stat; try { stat = await fs.stat(file); } catch { throw new NapCatError('NAP-TRUST', '请选择受支持的官方独立 Node 组件；文件或版本校验未通过'); }
      if (!stat.isFile() || stat.size > 256 * 1024 ** 2) throw unsafe();
      const hash = crypto.createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
      if (hash.digest('hex') !== expected) throw new NapCatError('NAP-TRUST', '官方独立组件文件校验失败，请重新下载受支持版本');
    }
    const inspect = async directory => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      if (entries.length > 2000) throw unsafe();
      for (const entry of entries) {
        const file = path.join(directory, entry.name), relative = path.relative(folder, file).split(path.sep).join('/');
        await safePath(file);
        if (entry.isDirectory()) await inspect(file);
        else if (!Object.hasOwn(expectedFiles, relative) && /\.(?:[cm]?js|json|node|dll|exe)$/i.test(entry.name)
          && !relative.startsWith(this.platform === 'linux' ? 'config/' : 'napcat/config/')) throw new NapCatError('NAP-TRUST', '组件包含额外的未审定程序文件，请使用官方独立目录');
      }
    };
    await inspect(folder);
  }
  async _connection() {
    let value;
    if (this.getConnection) value = await this.getConnection();
    else {
      const config = JSON.parse(await readText(path.join(this.manager.host, 'data/cmd_config.json')));
      const items = (config.platform || []).filter(item => item.enable && item.type === 'aiocqhttp');
      if (items.length !== 1 || items[0].ws_reverse_host !== '127.0.0.1') throw new NapCatError('NAP-HOST', '请先在 DSWhale 配置唯一的本机 OneBot 连接');
      value = { port: items[0].ws_reverse_port, token: items[0].ws_reverse_token };
    }
    if (!value || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || typeof value.token !== 'string' || value.token.length < 16 || value.token.length > 4096 || /[\r\n\0]/.test(value.token)) throw new NapCatError('NAP-HOST', '请先完成 DSWhale 本机连接端口与安全令牌配置');
    return { url: `ws://127.0.0.1:${value.port}/ws`, token: value.token };
  }
  async status() {
    const externalOnly = this.platform !== 'win32';
    const state = { supported: ['win32', 'linux'].includes(this.platform), externalOnly, configured: false, isolationApplied: false,
      version: '', needsLogin: true, needsAccountSelection: false, connectionConfigured: false,
      canStart: false, canInstall: !externalOnly, running: this.running, code: externalOnly ? 'NAP-EXTERNAL' : null,
      nextStep: externalOnly ? '按指南连接外部独立协议端' : '安装官方独立组件或选择已解压的受支持目录', guideURL: GUIDE };
    if (this.platform === 'darwin') return state;
    try {
      const record = await this._record(); if (!record) return state;
      const names = await accountConfigs(path.join(this.work, 'config'));
      state.configured = true; state.version = this.assets.version; state.isolationApplied = await this._isolation(record.folder);
      state.needsLogin = names.length === 0; state.needsAccountSelection = names.length > 1 || record.needsAccountSelection === true;
      state.connectionConfigured = names.length === 1 && record.connectionConfigured === true;
      state.canStart = !externalOnly && state.isolationApplied && !state.needsAccountSelection;
      state.nextStep = state.needsAccountSelection ? '在 NapCat WebUI 中确认所用账号与 DSWhale 反向连接' : state.needsLogin ? '启动独立组件后在 NapCat WebUI 手动扫码登录，再点连接配置' : '先启动对话服务，再启动独立组件';
      return state;
    } catch { return { ...state, configured: true, code: 'NAP-002', nextStep: '请重新选择安全的官方独立组件目录并检查隔离配置' }; }
  }
  async configure(folder) {
    try { return await this._configure(folder); }
    catch (error) { if (error instanceof NapCatError) throw error; throw new NapCatError('NAP-CONFIG', '独立组件配置未完成，请检查安全目录和配置格式后重试'); }
  }
  async _configure(folder) {
    this._supported(true); if (this.running) throw new NapCatError('NAP-RUNNING', '请先停止独立组件再修改配置');
    const record = await this._record(); folder = folder || record?.folder;
    if (!folder) throw new NapCatError('NAP-SELECT', '请先选择官方独立组件目录或安装组件');
    folder = path.resolve(folder); await this._verify(folder);
    const envFile = path.join(this._binary(folder), 'config/.env');
    const env = await readText(envFile, '', 65536), values = environmentValues(env);
    if (Object.keys(values).some(key => /^(NODE_OPTIONS|NODE_PATH|NAPCAT_PRELOAD_NODE_ADDON_PATH)$/i.test(key))) throw unsafe();
    await safePath(this.base); await safePath(this.work); await safePath(this.data);
    const destination = path.join(this.work, 'config');
    let names = await accountConfigs(destination);
    if (!names.length) {
      const sourceNames = await accountConfigs(path.join(this._binary(folder), 'config'));
      if (sourceNames.length === 1) {
        const text = await readText(path.join(this._binary(folder), 'config', sourceNames[0]));
        try { JSON.parse(text); } catch { throw unsafe(); }
        await atomic(path.join(destination, sourceNames[0]), text); names = sourceNames;
      } else if (sourceNames.length > 1) names = sourceNames;
    }
    await fs.mkdir(this.data, { recursive: true, mode: 0o700 }); await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    let connectionConfigured = false;
    if (names.length === 1) {
      const file = path.join(destination, names[0]); let config;
      try { config = JSON.parse(await readText(file)); } catch { throw unsafe(); }
      if (!config || Array.isArray(config) || typeof config !== 'object' || (config.network && (typeof config.network !== 'object' || Array.isArray(config.network)))) throw unsafe();
      config.network ||= {}; config.network.websocketClients ||= [];
      if (!Array.isArray(config.network.websocketClients)) throw unsafe();
      const connection = await this._connection();
      const matches = config.network.websocketClients.filter(client => client && (client.name === CLIENT_NAME || client.url === connection.url));
      if (matches.length > 1) throw new NapCatError('NAP-CLIENTS', '存在多个 DSWhale 连接，请先在 NapCat WebUI 中保留一个');
      const client = matches[0] || { name: CLIENT_NAME, messagePostFormat: 'array', reportSelfMessage: false, reconnectInterval: 5000, heartInterval: 30000, debug: false };
      Object.assign(client, { name: CLIENT_NAME, enable: true, url: connection.url, token: connection.token });
      if (!matches.length) config.network.websocketClients.push(client);
      await atomic(file, JSON.stringify(config, null, 2) + '\n'); connectionConfigured = true;
    }
    const webuiFile = path.join(destination, 'webui.json');
    let webui;
    try { webui = JSON.parse(await readText(webuiFile, '{}', 65536)); } catch { throw unsafe(); }
    if (!webui || typeof webui !== 'object' || Array.isArray(webui)) throw unsafe();
    webui.host = '127.0.0.1'; webui.disableWebUI = false;
    if (!Number.isInteger(webui.port) || webui.port < 1024 || webui.port > 65535) webui.port = 6099;
    if (typeof webui.token !== 'string' || webui.token.length < 8 || webui.token.length > 4096 || /[\x00-\x1f\x7f]/.test(webui.token)) webui.token = crypto.randomBytes(32).toString('base64url');
    await atomic(webuiFile, JSON.stringify(webui, null, 2) + '\n');
    await atomic(envFile, updateEnvironment(env, { ...this._values(folder), NAPCAT_WEBUI_PREFERRED_PORT: String(webui.port) }));
    await atomic(this.receipt, JSON.stringify({ schema: 1, folder, version: this.assets.version, connectionConfigured,
      needsAccountSelection: names.length > 1 }) + '\n');
    const result = await this.status();
    if (names.length > 1) Object.assign(result, { needsAccountSelection: true, connectionConfigured: false, canStart: false, nextStep: '存在多个账号配置，请在 NapCat WebUI 中选择并确认连接' });
    this.onChange(result); return result;
  }
  install() {
    if (this.installing) return this.installing;
    const generation = ++this.generation;
    this.controller = new AbortController();
    this.installing = this._install(generation, this.controller.signal).catch(error => {
      if (error instanceof NapCatError || (typeof error.code === 'string' && error.code.startsWith('NET_'))) throw error;
      throw new NapCatError('NAP-INSTALL', '独立组件安装失败，请检查网络、校验结果和可用空间后重试');
    }).finally(() => { this.installing = null; this.controller = null; });
    return this.installing;
  }
  async _install(generation, signal) {
    this._supported(); if (this.running || this.starting) throw new NapCatError('NAP-RUNNING', '请先停止独立组件，再安装');
    if (!/^\d+\.\d+\.\d+$/.test(this.assets.version) || !this.assets.asset) throw new NapCatError('NAP-TRUST', '官方独立组件发布信息无效');
    const { downloadVerified, runBounded } = require('./runtime.cjs');
    const { readNetworkConfig } = require('./network.cjs');
    const destination = path.join(this.base, `package-${this.assets.version}`);
    await safePath(this.base); await safePath(destination);
    try { if ((await fs.stat(destination)).isDirectory()) { await this._verify(destination); this._active(generation); return this.configure(destination); } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const directory = path.join(this.base, 'downloads'); await safePath(directory); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const archive = path.join(directory, `NapCat-${this.assets.version}.zip`), metadata = path.join(this.base, 'release-trust.json');
    await safePath(archive); await safePath(`${archive}.part`);
    const network = await readNetworkConfig(this.manager.runtime); this._active(generation);
    await downloadVerified(this.assets.asset, archive, { fetch: this.fetch, network, signal, maxBytes: 1024 ** 3,
      onProgress: progress => this.onChange({ phase: 'installing', progress, step: '正在下载并校验官方独立组件' }) });
    this._active(generation);
    await atomic(metadata, JSON.stringify(this.assets) + '\n');
    await (this.runner || runBounded)(this.manager.python, ['-m', 'dswhale.napcat_install', '--archive', archive,
      '--private-root', this.base, '--metadata', metadata], { env: await this.manager.environment(), signal, timeout: 120000, maxBytes: 65536 });
    this._active(generation); await this._verify(destination); this._active(generation);
    return this.configure(destination);
  }
  start() {
    if (this.installing) return Promise.reject(new NapCatError('NAP-INSTALLING', '独立组件正在安装，请等待完成'));
    if (this.starting) return this.starting;
    if (this.running) return this.status();
    const generation = ++this.generation;
    this.starting = this._start(generation).catch(error => { if (error instanceof NapCatError) throw error; throw new NapCatError('NAP-START', '独立组件无法启动，请检查组件文件与隔离配置'); }).finally(() => { this.starting = null; });
    return this.starting;
  }
  async _start(generation) {
    this._supported(); const record = await this._record();
    if (!record) throw new NapCatError('NAP-SELECT', '请先选择并配置官方独立组件');
    if (record.needsAccountSelection) throw new NapCatError('NAP-ACCOUNTS', '存在多个账号配置，请先在 NapCat WebUI 中选择');
    if (!await this._isolation(record.folder)) throw new NapCatError('NAP-ISOLATION', '隔离配置已变化，请重新完成连接配置后再启动');
    await this._verify(record.folder); this._active(generation);
    const webui = await this._webui();
    // Upstream may silently move to another port; refuse a known conflict so a
    // login-code action cannot direct the user to an unrelated local service.
    await require('./services.cjs').portFree(webui.port); this._active(generation);
    const plugins = path.join(this.work, 'plugins'); await safePath(plugins);
    try { if ((await fs.readdir(plugins)).length) throw new NapCatError('NAP-PLUGINS', '托管独立组件暂不加载额外插件，请使用单独的外部部署'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const environment = { ...await this.manager.environment() };
    for (const key of Object.keys(environment)) if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|NAPCAT_|QQ_)/i.test(key)) delete environment[key];
    Object.assign(environment, this._values(record.folder), { NAPCAT_WEBUI_PREFERRED_PORT: String(webui.port) }); this._active(generation);
    const child = this.spawn(path.join(record.folder, 'node.exe'), [path.join(record.folder, 'index.js')],
      { cwd: record.folder, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child; child.stdout?.resume(); child.stderr?.resume();
    child.once('close', () => { if (this.child === child) { this.child = null; this.onChange({ running: false }); } });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new NapCatError('NAP-START', '独立组件无法启动，请检查官方组件文件'))); });
    this._active(generation); const result = await this.status(); this.onChange(result); return result;
  }
  async stop() {
    ++this.generation; this.controller?.abort();
    const pending = this.starting, installing = this.installing, child = this.child; this.child = null;
    if (child) await this.stopOwned(child);
    if (pending) await pending.catch(() => {});
    if (installing) await installing.catch(() => {});
    this.onChange({ running: false }); return this.status();
  }
}
module.exports = { NapCatManager, NapCatError };
