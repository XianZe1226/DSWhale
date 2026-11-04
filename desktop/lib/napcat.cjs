'use strict';
// Optional independent protocol component. Never finds or patches installed QQ.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const officialAssets = require('./napcat-assets.json');
const { NapCatSession } = require('./napcat-session.cjs');
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
async function atomic(file, text, guard = () => {}) {
  await safePath(file); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await safePath(path.dirname(file));
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await safePath(file); guard(); await fs.rename(temporary, file); await fs.chmod(file, 0o600); }
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
    // The upstream launcher reads this file after inheriting our environment.
    // Keep quick-account selection authoritative and never enable passwords.
    if (/^NAPCAT_QUICK_(?:ACCOUNT|PASSWORD|PASSWORD_MD5)$/i.test(key)) continue;
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
function applyConnection(config, connection) {
  if (!config || Array.isArray(config) || typeof config !== 'object' || (config.network && (typeof config.network !== 'object' || Array.isArray(config.network)))) throw unsafe();
  const before = JSON.stringify(config);
  config.network ||= {}; config.network.websocketClients ||= [];
  if (!Array.isArray(config.network.websocketClients)) throw unsafe();
  const matches = config.network.websocketClients.filter(client => client && (client.name === CLIENT_NAME || client.url === connection.url));
  if (matches.length > 1) throw new NapCatError('NAP-CLIENTS', '存在多个 DSWhale 连接，请先在登录管理中保留一个');
  const client = matches[0] || { name: CLIENT_NAME, messagePostFormat: 'array', reportSelfMessage: false, reconnectInterval: 5000, heartInterval: 30000, debug: false };
  Object.assign(client, { name: CLIENT_NAME, enable: true, url: connection.url, token: connection.token });
  if (!matches.length) config.network.websocketClients.push(client);
  return JSON.stringify(config) !== before;
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
    spawn = childProcess.spawn, stopOwned = defaultStopOwned, onChange = () => {}, fetch = globalThis.fetch, runner,
    session = new NapCatSession(), now = Date.now, getProtocolState = async () => null } = {}) {
    this.manager = manager; this.platform = platform; this.assets = assets; this.getConnection = getConnection;
    this.spawn = spawn; this.stopOwned = stopOwned; this.onChange = onChange; this.fetch = fetch; this.runner = runner;
    this.session = session; this.now = now; this.monitor = null; this.livePending = null; this.polling = null; this.startedAt = null; this.stopping = null;
    this.getProtocolState = getProtocolState;
    this.base = path.resolve(userData ? path.join(userData, 'napcat') : path.join(manager.runtime, 'napcat'));
    this.data = path.join(this.base, 'qq-data'); this.work = path.join(this.base, 'work');
    this.receipt = path.join(this.base, 'receipt.json'); this.child = null; this.starting = null; this.installing = null; this.generation = 0; this.controller = null;
    this.identityAccount = ''; this.identityKnown = false; this.identityToken = crypto.randomBytes(16).toString('hex');
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
  async _resumeAccount(names) {
    let session;
    try { session = JSON.parse(await readText(path.join(this.base, 'session.json'), 'null', 16384)); }
    catch { throw unsafe(); }
    if (session !== null && (session.schema !== 1 || typeof session.account !== 'string' || !/^[1-9]\d{4,19}$/.test(session.account))) throw unsafe();
    // A saved online account is authoritative. Legacy versions have no session
    // record: only an unambiguous historical component config can supply it.
    // Never use the owner's ordinary QQ or enumerate desktop QQ data.
    return session?.account || (names.length === 1 ? names[0].slice(9, -5) : null);
  }
  async _observe() {
    if (!this.running) return { loginState: 'stopped' };
    if (this.livePending) return this.livePending;
    const generation = this.generation, child = this.child;
    let identityRevision;
    const guard = () => { this._active(generation); if (!this.running || this.child !== child || identityRevision !== this.session.identityRevision) throw new NapCatError('NAP-CANCELLED', '独立组件或登录状态已变化'); };
    const pending = (async () => {
      try {
        const observed = await this.session.inspect(await this._webui()); identityRevision = this.session.identityRevision; guard();
        const phases = ['online', 'offline', 'connecting', 'confirming', 'scan-required', 'unknown'];
        const loginState = phases.includes(observed?.loginState) ? observed.loginState : 'unknown';
        if (loginState !== 'online') return { loginState };
        if (typeof observed.account !== 'string' || !/^[1-9]\d{4,19}$/.test(observed.account)) return { loginState: 'unknown' };
        const file = path.join(this.base, 'session.json');
        const prior = JSON.parse(await readText(file, 'null', 16384)); guard();
        if (prior?.schema !== 1 || prior?.account !== observed.account) {
          await atomic(file, JSON.stringify({ schema: 1, account: observed.account }) + '\n', guard); guard();
        }
        return { loginState: 'online', account: observed.account };
      } catch { return { loginState: generation !== this.generation || this.child !== child ? 'stopped' : 'unknown' }; }
    })().finally(() => { if (this.livePending === pending) this.livePending = null; });
    this.livePending = pending; return pending;
  }
  async _connectionSaved(account) {
    if (!account) return false;
    const file = path.join(this.work, 'config', `onebot11_${account}.json`);
    let config; try { config = JSON.parse(await readText(file)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const connection = await this._connection();
    const clients = config?.network?.websocketClients;
    if (!Array.isArray(clients)) return false;
    const matches = clients.filter(client => client && (client.name === CLIENT_NAME || client.url === connection.url));
    return matches.length === 1 && matches[0].name === CLIENT_NAME && matches[0].enable === true && matches[0].url === connection.url && matches[0].token === connection.token;
  }
  _monitor() {
    clearInterval(this.monitor);
    const generation = this.generation;
    this.monitor = setInterval(() => {
      if (this.polling || !this.running || generation !== this.generation) return;
      const pending = this.status().then(status => { if (this.running && generation === this.generation) this.onChange(status); })
        .catch(() => {}).finally(() => { if (this.polling === pending) this.polling = null; });
      this.polling = pending;
    }, 5000);
    this.monitor.unref?.();
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
    if (Object.keys(current).some(key => /^NAPCAT_QUICK_(?:ACCOUNT|PASSWORD|PASSWORD_MD5)$/i.test(key)) || webui.autoLoginAccount) return false;
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
  async identityRevision({ fresh = true } = {}) {
    // Opaque per-identity token: a stable account or a stable unknown state keeps
    // the same token, while an actual login change gets a new one. Raw accounts
    // never leave this process.
    if (!this.running) return { token: 'stopped', known: true };
    let observed = null;
    try { observed = await this.session.inspect(await this._webui(), { fresh }); } catch {}
    const account = observed?.loginState === 'online' && /^[1-9]\d{4,19}$/.test(observed?.account || '') ? observed.account : '';
    const known = Boolean(account);
    if (account !== this.identityAccount || known !== this.identityKnown) {
      this.identityAccount = account;
      this.identityKnown = known;
      this.identityToken = crypto.randomBytes(16).toString('hex');
    }
    return { token: this.identityToken, known };
  }

  async status() {
    const externalOnly = this.platform !== 'win32';
    const state = { supported: ['win32', 'linux'].includes(this.platform), externalOnly, configured: false, isolationApplied: false,
      version: '', loginState: 'stopped', protocolConnected: null, needsLogin: false, hasSavedLogin: false, needsAccountSelection: false, connectionConfigured: false,
      canStart: false, canInstall: !externalOnly, running: this.running, code: externalOnly ? 'NAP-EXTERNAL' : null,
      nextStep: externalOnly ? '按指南连接外部独立协议端' : '安装官方独立组件或选择已解压的受支持目录', guideURL: GUIDE };
    try { const protocol = await this.getProtocolState(); state.protocolConnected = typeof protocol === 'boolean' ? protocol : null; } catch {}
    if (this.platform === 'darwin') return state;
    try {
      const record = await this._record(); if (!record) return state;
      const names = await accountConfigs(path.join(this.work, 'config'));
      const resume = await this._resumeAccount(names);
      const live = await this._observe();
      state.configured = true; state.version = this.assets.version; state.isolationApplied = await this._isolation(record.folder);
      state.loginState = live.loginState;
      if (['scan-required', 'unknown'].includes(state.loginState) && Number.isFinite(this.startedAt) && this.now() - this.startedAt < 15000) state.loginState = resume ? 'resuming' : 'connecting';
      state.hasSavedLogin = Boolean(live.account || resume);
      state.needsLogin = state.loginState === 'scan-required'; state.needsAccountSelection = !live.account && !resume && (names.length > 1 || record.needsAccountSelection === true);
      state.connectionConfigured = await this._connectionSaved(live.account || resume);
      state.canStart = !externalOnly && state.isolationApplied;
      state.nextStep = state.needsAccountSelection ? '在登录管理中选择机器人账号' : state.needsLogin ? '打开登录管理，完成 QQ 要求的验证；不要连续扫码' : this.running ? '已保留登录数据，按当前登录状态继续' : '启动连接后优先恢复此前登录的机器人账号';
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
    const resume = await this._resumeAccount(names);
    const selected = resume && names.find(name => name === `onebot11_${resume}.json`);
    let connectionConfigured = false;
    if (selected) {
      const file = path.join(destination, selected); let config;
      try { await fs.stat(file); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const text = await readText(path.join(this._binary(folder), 'config', selected));
        try { JSON.parse(text); } catch { throw unsafe(); }
        await atomic(file, text);
      }
      try { config = JSON.parse(await readText(file)); } catch { throw unsafe(); }
      const connection = await this._connection();
      applyConnection(config, connection);
      await atomic(file, JSON.stringify(config, null, 2) + '\n'); connectionConfigured = true;
    }
    const webuiFile = path.join(destination, 'webui.json');
    let webui;
    try { webui = JSON.parse(await readText(webuiFile, '{}', 65536)); } catch { throw unsafe(); }
    if (!webui || typeof webui !== 'object' || Array.isArray(webui)) throw unsafe();
    webui.host = '127.0.0.1'; webui.disableWebUI = false; webui.autoLoginAccount = '';
    if (!Number.isInteger(webui.port) || webui.port < 1024 || webui.port > 65535) webui.port = 6099;
    if (typeof webui.token !== 'string' || webui.token.length < 8 || webui.token.length > 4096 || /[\x00-\x1f\x7f]/.test(webui.token)) webui.token = crypto.randomBytes(32).toString('base64url');
    await atomic(webuiFile, JSON.stringify(webui, null, 2) + '\n');
    await atomic(envFile, updateEnvironment(env, { ...this._values(folder), NAPCAT_WEBUI_PREFERRED_PORT: String(webui.port) }));
    await atomic(this.receipt, JSON.stringify({ schema: 1, folder, version: this.assets.version, connectionConfigured,
      needsAccountSelection: names.length > 1 && !resume }) + '\n');
    const result = await this.status();
    if (names.length > 1 && !resume) Object.assign(result, { needsAccountSelection: true, connectionConfigured: false, nextStep: '启动连接后，在登录面板中选择机器人账号' });
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
    if (this.stopping) return Promise.reject(new NapCatError('NAP-STOPPING', '独立组件正在停止，请稍候'));
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
    const resume = await this._resumeAccount(await accountConfigs(path.join(this.work, 'config')));
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
    if (resume) environment.NAPCAT_QUICK_ACCOUNT = resume;
    const child = this.spawn(path.join(record.folder, 'node.exe'), [path.join(record.folder, 'index.js')],
      { cwd: record.folder, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child; child.stdout?.resume(); child.stderr?.resume();
    child.once('close', () => { if (this.child === child) { this.child = null; clearInterval(this.monitor); this.session.reset(); this.status().then(status => this.onChange(status)).catch(() => {}); } });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new NapCatError('NAP-START', '独立组件无法启动，请检查官方组件文件'))); });
    this._active(generation); this.startedAt = this.now(); const result = await this.status(); this._active(generation); this._monitor(); this.onChange(result); return result;
  }
  async wire() {
    this._supported(true);
    if (!this.running) return this.configure();
    const generation = this.generation, child = this.child;
    try {
      const webui = await this._webui(), connection = await this._connection();
      const identity = await this.session.inspect(webui, { fresh: true }); this._active(generation);
      if (identity?.loginState !== 'online' || !/^[1-9]\d{4,19}$/.test(identity.account || '')) throw new NapCatError('NAP-ACCOUNT', '请先在登录面板确认机器人账号在线，再应用连接。');
      const config = await this.session.getConfig(webui); this._active(generation);
      if (!this.running || this.child !== child) throw new NapCatError('NAP-CANCELLED', '独立组件已停止');
      if (applyConnection(config, connection)) {
        const current = await this.session.inspect(webui, { fresh: true }); this._active(generation);
        if (!this.running || this.child !== child || current?.loginState !== 'online' || current.account !== identity.account) throw new NapCatError('NAP-ACCOUNT', '机器人账号状态已变化，尚未应用连接。请在登录面板确认后重试。');
        await this.session.setConfig(webui, config);
      }
      this._active(generation);
      const result = await this.status(); this.onChange(result); return result;
    } catch (error) {
      if (error instanceof NapCatError) throw error;
      throw new NapCatError('NAP-WIRE', '连接配置尚未确认；QQ 保持运行，请刷新状态后再处理。');
    }
  }
  stop() {
    if (this.stopping) return this.stopping;
    const pending = this._stop().finally(() => { if (this.stopping === pending) this.stopping = null; });
    this.stopping = pending; return pending;
  }
  async _stop() {
    ++this.generation; this.controller?.abort();
    clearInterval(this.monitor); this.session.reset();
    const pending = this.starting, installing = this.installing, child = this.child, observing = this.livePending, polling = this.polling; this.child = null;
    if (child) await this.stopOwned(child);
    if (pending) await pending.catch(() => {});
    if (installing) await installing.catch(() => {});
    if (observing) await observing.catch(() => {});
    if (polling) await polling.catch(() => {});
    const result = await this.status(); this.onChange(result); return result;
  }
}
module.exports = { NapCatManager, NapCatError };
