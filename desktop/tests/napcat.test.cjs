'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-napcat-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'independent');
  const files = { 'node.exe': 'synthetic bundled node', 'index.js': 'synthetic canonical entry',
    'wrapper.node': 'synthetic bundled wrapper', 'napcat/napcat.mjs': 'synthetic official module NAPCAT_QQ_DATA_DIR version4.18.42' };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await fs.writeFile(path.join(folder, name), content);
  }
  await fs.mkdir(path.join(folder, 'napcat/config'), { recursive: true });
  const assets = { version: '4.18.42', minimumVersion: '4.18.42', platform: 'win32',
    guideURL: 'https://napneko.github.io/guide/boot/Shell',
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, crypto.createHash('sha256').update(content).digest('hex')])) };
  const changes = [], launches = [], stopped = [];
  const manager = { runtime: path.join(root, 'userData/runtime'), host: path.join(root, 'host'), environment: async () => ({ PATH: process.env.PATH, NODE_OPTIONS: '--require=untrusted.js' }) };
  const config = { musicSignUrl: 'keep-me', network: { httpServers: [{ name: 'other-server', token: 'other-secret' }],
    websocketClients: [{ name: 'another-app', url: 'ws://127.0.0.1:7000/ws', token: 'keep-token', debug: true }] } };
  const accountFile = path.join(folder, 'napcat/config/onebot11_12345678.json');
  if (options.account !== false) await fs.writeFile(accountFile, JSON.stringify(config));
  const { NapCatManager } = require('../lib/napcat.cjs');
  const session = options.session || { inspect: async () => ({ loginState: 'unknown' }), reset() {} };
  const app = new NapCatManager({ manager, userData: path.join(root, 'userData'), platform: options.platform || 'win32', assets,
    session, now: options.now,
    getConnection: async () => ({ port: 6199, token: 'synthetic-host-private-token' }), onChange: event => changes.push(event),
    spawn(command, args, launchOptions) {
      launches.push({ command, args, options: launchOptions });
      const child = new EventEmitter(); child.pid = 987654321; child.exitCode = null;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      process.nextTick(() => child.emit('spawn'));
      return child;
    }, stopOwned: async child => { stopped.push(child.pid); child.exitCode = 0; child.emit('close', 0); } });
  return { root, folder, app, manager, config, accountFile, changes, launches, stopped, session };
}

test('configure isolates data, preserves env and other OneBot clients, and is idempotent', async t => {
  const f = await fixture(t);
  const envFile = path.join(f.folder, 'napcat/config/.env');
  await fs.writeFile(envFile, '# keep comment\r\nCUSTOM_KEEP=a=b\r\nNAPCAT_QQ_DATA_DIR=old\r\nNAPCAT_QQ_DATA_DIR=duplicate\r\n');
  const first = await f.app.configure(f.folder);
  assert.equal(first.isolationApplied, true);
  assert.equal(first.connectionConfigured, true);
  const webui = JSON.parse(await fs.readFile(path.join(f.root, 'userData/napcat/work/config/webui.json'), 'utf8'));
  assert.equal(webui.host, '127.0.0.1');
  assert.ok(webui.token.length >= 32);
  const env = await fs.readFile(envFile, 'utf8');
  assert.match(env, /# keep comment\r\nCUSTOM_KEEP=a=b\r\n/);
  assert.equal(env.match(/^NAPCAT_QQ_DATA_DIR=/gm).length, 1);
  assert.ok(env.includes(`NAPCAT_QQ_DATA_DIR=${path.join(f.root, 'userData/napcat/qq-data')}`));
  const target = path.join(f.root, 'userData/napcat/work/config/onebot11_12345678.json');
  const configured = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.deepEqual(configured.network.httpServers, f.config.network.httpServers);
  assert.deepEqual(configured.network.websocketClients[0], f.config.network.websocketClients[0]);
  assert.equal(configured.musicSignUrl, 'keep-me');
  assert.equal(configured.network.websocketClients[1].url, 'ws://127.0.0.1:6199/ws');
  assert.equal(configured.network.websocketClients[1].token, 'synthetic-host-private-token');
  const bytes = await fs.readFile(target);
  await f.app.configure();
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.deepEqual(JSON.parse(await fs.readFile(f.accountFile, 'utf8')), f.config);
  const publicStatus = JSON.stringify(await f.app.status());
  for (const privateValue of ['12345678', 'synthetic-host-private-token', f.root, 'other-secret']) assert.equal(publicStatus.includes(privateValue), false);
});

test('WebUI login credentials are available only to the native main-process action', async t => {
  const f = await fixture(t);
  await f.app.configure(f.folder);
  const file = path.join(f.root, 'userData/napcat/work/config/webui.json');
  await fs.writeFile(file, JSON.stringify({ host: '127.0.0.1', port: 6099, token: 'synthetic-webui-secret', theme: { keep: true } }));
  assert.equal(typeof f.app.loginInfo, 'function');
  assert.deepEqual(await f.app.loginInfo(), { url: 'http://127.0.0.1:6099/webui/', token: 'synthetic-webui-secret' });
  assert.equal(JSON.stringify(await f.app.status()).includes('synthetic-webui-secret'), false);
  assert.equal(JSON.stringify(f.changes).includes('synthetic-webui-secret'), false);
  await f.app.configure();
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).theme, { keep: true });
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.writeFile(file, JSON.stringify({ host: '0.0.0.0', port: 6099, token: 'synthetic-webui-secret' }));
  await assert.rejects(f.app.loginInfo(), /本机|隔离|登录/);
});

test('multiple account configurations require WebUI selection without account disclosure', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.folder, 'napcat/config/onebot11_87654321.json'), JSON.stringify(f.config));
  const state = await f.app.configure(f.folder);
  assert.equal(state.needsAccountSelection, true);
  assert.equal(state.connectionConfigured, false);
  assert.equal((await f.app.status()).needsAccountSelection, true);
  assert.equal(JSON.stringify(state).includes('87654321'), false);
  assert.equal(JSON.stringify(state).includes('12345678'), false);
  await f.app.start();
  assert.equal(f.launches[0].options.env.NAPCAT_QUICK_ACCOUNT, undefined);
  await f.app.stop();
});

test('a historical bot resumes once from private data without exposing the account in arguments or status', async t => {
  const f = await fixture(t);
  await f.app.configure(f.folder);
  await f.app.start();
  await f.app.start();
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].options.env.NAPCAT_QUICK_ACCOUNT, '12345678');
  assert.equal(f.launches[0].args.some(arg => arg.includes('12345678')), false);
  assert.equal((await f.app.status()).hasSavedLogin, true);
  assert.equal(JSON.stringify(await f.app.status()).includes('12345678'), false);
  await f.app.stop();
});

test('a verified prior bot is retained among multiple configs without selecting the owner or another bot', async t => {
  const f = await fixture(t);
  await f.app.configure(f.folder);
  await fs.writeFile(path.join(f.app.work, 'config/onebot11_87654321.json'), JSON.stringify(f.config));
  await fs.writeFile(path.join(f.app.base, 'session.json'), JSON.stringify({ schema: 1, account: '87654321' }));
  await f.app.configure();
  await f.app.start();
  assert.equal(f.launches[0].options.env.NAPCAT_QUICK_ACCOUNT, '87654321');
  assert.equal((await f.app.status()).needsAccountSelection, false);
  assert.equal(JSON.stringify(f.changes).includes('87654321'), false);
  await f.app.stop();
});

test('reconstruction and repeated prepare preserve identity data and the saved bot selection', async t => {
  const f = await fixture(t);
  await f.app.configure(f.folder);
  const identity = path.join(f.app.data, 'nt_qq/global/device-identity.fixture');
  await fs.mkdir(path.dirname(identity), { recursive: true });
  const bytes = Buffer.from('synthetic existing QQ identity and login state');
  await fs.writeFile(identity, bytes);
  const session = path.join(f.app.base, 'session.json');
  const saved = JSON.stringify({ schema: 1, account: '12345678' });
  await fs.writeFile(session, saved);
  const next = new f.app.constructor({ manager: { ...f.manager, runtime: path.join(f.root, 'replacement-runtime') },
    userData: path.join(f.root, 'userData'), platform: 'win32', assets: f.app.assets,
    getConnection: f.app.getConnection, spawn: f.app.spawn, stopOwned: f.app.stopOwned, session: f.session });
  await next.configure();
  await next.configure();
  await next.start();
  assert.equal(f.launches[0].options.env.NAPCAT_QQ_DATA_DIR, f.app.data);
  assert.equal(f.launches[0].options.env.NAPCAT_QUICK_ACCOUNT, '12345678');
  assert.deepEqual(await fs.readFile(identity), bytes);
  assert.equal(await fs.readFile(session, 'utf8'), saved);
  await next.stop();
});

test('first login does not inherit an account or password from unrelated environment values', async t => {
  const f = await fixture(t, { account: false });
  f.manager.environment = async () => ({ PATH: process.env.PATH, NAPCAT_QUICK_ACCOUNT: '87654321',
    NAPCAT_QUICK_PASSWORD: 'synthetic-foreign-secret', NAPCAT_QUICK_PASSWORD_MD5: 'f'.repeat(32) });
  await f.app.configure(f.folder);
  await f.app.start();
  const env = f.launches[0].options.env;
  assert.equal(env.NAPCAT_QUICK_ACCOUNT, undefined);
  assert.equal(env.NAPCAT_QUICK_PASSWORD, undefined);
  assert.equal(env.NAPCAT_QUICK_PASSWORD_MD5, undefined);
  assert.equal((await f.app.status()).hasSavedLogin, false);
  await f.app.stop();
});

test('invalid saved account data cannot become a launch argument or automatic login target', async t => {
  const f = await fixture(t);
  await f.app.configure(f.folder);
  await fs.writeFile(path.join(f.app.base, 'session.json'), JSON.stringify({ schema: 1, account: '12345678\n--foreign' }));
  await assert.rejects(f.app.start(), /安全|记录|配置/);
  assert.equal(f.launches.length, 0);
});

test('only a verified online bot is saved privately and public status never includes account or API details', async t => {
  const session = { inspect: async () => ({ loginState: 'online', account: '87654321', token: 'synthetic-private-api-token', rawError: 'synthetic-private-error' }), reset() {} };
  const f = await fixture(t, { session });
  await f.app.configure(f.folder);
  const status = await f.app.start();
  assert.equal(status.loginState, 'online');
  assert.equal(status.connectionConfigured, false, 'a different account cannot inherit the old account connection flag');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.app.base, 'session.json'), 'utf8')), { schema: 1, account: '87654321' });
  for (const value of ['87654321', 'synthetic-private-api-token', 'synthetic-private-error']) {
    assert.equal(JSON.stringify(status).includes(value), false);
    assert.equal(JSON.stringify(f.changes).includes(value), false);
  }
  await f.app.stop();
});

test('saved sessions get time to resume and unknown observations do not become a new scan requirement', async t => {
  let now = 0, loginState = 'scan-required';
  const f = await fixture(t, { now: () => now, session: { inspect: async () => ({ loginState }), reset() {} } });
  await f.app.configure(f.folder);
  assert.equal((await f.app.start()).loginState, 'resuming');
  now = 20000;
  loginState = 'unknown';
  const unknown = await f.app.status();
  assert.equal(unknown.loginState, 'unknown');
  assert.equal(unknown.needsLogin, false);
  loginState = 'scan-required';
  assert.equal((await f.app.status()).needsLogin, true);
  await f.app.stop();
});

test('stopping during a live probe cannot save an old account or publish a late online event', async t => {
  let entered, finish;
  const waiting = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { session: { inspect: async () => { entered(); return response; }, reset() {} } });
  await f.app.configure(f.folder);
  const starting = f.app.start(); starting.catch(() => {});
  let timer;
  t.after(async () => { finish({ loginState: 'unknown' }); await f.app.stop(); });
  try { await Promise.race([waiting, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('owned live status probe was not started')), 100); })]); }
  finally { clearTimeout(timer); }
  const stopping = f.app.stop();
  finish({ loginState: 'online', account: '87654321' });
  await stopping;
  await assert.rejects(starting, /取消/);
  await assert.rejects(fs.stat(path.join(f.app.base, 'session.json')), { code: 'ENOENT' });
  assert.equal(f.changes.some(change => change.loginState === 'online'), false);
});

test('an unchanged OneBot connection does not write config or restart QQ', async t => {
  let config, writes = 0;
  const session = { inspect: async () => ({ loginState: 'online', account: '12345678' }), reset() {},
    getConfig: async () => structuredClone(config), setConfig: async () => { writes++; } };
  const f = await fixture(t, { session });
  await f.app.configure(f.folder);
  config = JSON.parse(await fs.readFile(path.join(f.app.work, 'config/onebot11_12345678.json'), 'utf8'));
  await f.app.start();
  await f.app.wire();
  assert.equal(writes, 0);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.stopped, []);
  await f.app.stop();
});

test('changed OneBot settings hot-apply while other connections and QQ login stay intact', async t => {
  let config, f, writes = 0;
  const session = { inspect: async () => ({ loginState: 'online', account: '12345678' }), reset() {},
    getConfig: async () => structuredClone(config), setConfig: async (_context, next) => {
      writes++; config = structuredClone(next);
      await fs.writeFile(path.join(f.app.work, 'config/onebot11_12345678.json'), JSON.stringify(config));
    } };
  f = await fixture(t, { session });
  await f.app.configure(f.folder);
  config = JSON.parse(await fs.readFile(path.join(f.app.work, 'config/onebot11_12345678.json'), 'utf8'));
  await f.app.start();
  f.app.getConnection = async () => ({ port: 6299, token: 'synthetic-new-host-token' });
  const status = await f.app.wire();
  assert.equal(writes, 1);
  assert.equal(config.network.websocketClients[1].url, 'ws://127.0.0.1:6299/ws');
  assert.equal(config.network.websocketClients[1].token, 'synthetic-new-host-token');
  assert.deepEqual(config.network.websocketClients[0], f.config.network.websocketClients[0]);
  assert.deepEqual(config.network.httpServers, f.config.network.httpServers);
  assert.equal(status.connectionConfigured, true);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.stopped, []);
  await f.app.stop();
});

test('an uncertain configuration write is not retried or turned into a QQ restart', async t => {
  let config, f, writes = 0;
  const session = { inspect: async () => ({ loginState: 'online', account: '12345678' }), reset() {},
    getConfig: async () => structuredClone(config), setConfig: async (_context, next) => {
      writes++; config = structuredClone(next);
      await fs.writeFile(path.join(f.app.work, 'config/onebot11_12345678.json'), JSON.stringify(config));
      throw Error('synthetic private response lost');
    } };
  f = await fixture(t, { session });
  await f.app.configure(f.folder);
  config = JSON.parse(await fs.readFile(path.join(f.app.work, 'config/onebot11_12345678.json'), 'utf8'));
  await f.app.start();
  f.app.getConnection = async () => ({ port: 6299, token: 'synthetic-new-host-token' });
  await assert.rejects(f.app.wire(), error => !error.message.includes('synthetic private') && /连接|确认/.test(error.message));
  assert.equal(writes, 1);
  assert.deepEqual(f.stopped, []);
  await f.app.wire();
  assert.equal(writes, 1, 'explicit follow-up reads the already applied config instead of repeating the uncertain write');
  await f.app.stop();
});

test('first login remains manual and is not invented from the owner account', async t => {
  const f = await fixture(t, { account: false });
  const state = await f.app.configure(f.folder);
  assert.equal(state.hasSavedLogin, false);
  assert.equal(state.loginState, 'stopped');
  assert.equal(state.needsLogin, false, 'a stopped component cannot establish a current QR requirement');
  assert.equal(state.connectionConfigured, false);
  assert.deepEqual((await fs.readdir(path.join(f.root, 'userData/napcat/work/config'))).filter(name => name.startsWith('onebot11_')), []);
});

test('configuration refuses symlinks and changed executable code without writing external data', async t => {
  const f = await fixture(t);
  const foreign = path.join(f.root, 'official-QQ-data');
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, '.env'), 'OFFICIAL_UNCHANGED=1');
  await fs.symlink(path.join(foreign, '.env'), path.join(f.folder, 'napcat/config/.env'));
  await assert.rejects(f.app.configure(f.folder), /链接|目录|安全/);
  assert.equal(await fs.readFile(path.join(foreign, '.env'), 'utf8'), 'OFFICIAL_UNCHANGED=1');
  await fs.unlink(path.join(f.folder, 'napcat/config/.env'));
  await fs.writeFile(path.join(f.folder, 'index.js'), 'arbitrary executable');
  await assert.rejects(f.app.configure(f.folder), /校验|官方|版本/);
  assert.equal(f.launches.length, 0);
});

test('start rechecks isolation and code, launches only the owned standalone entry, and drains output privately', async t => {
  const f = await fixture(t);
  await assert.rejects(f.app.start(), /选择|配置/);
  await f.app.configure(f.folder);
  await f.app.start();
  assert.equal(f.launches.length, 1);
  const launched = f.launches[0];
  assert.equal(launched.command, path.join(f.folder, 'node.exe'));
  assert.deepEqual(launched.args, [path.join(f.folder, 'index.js')]);
  assert.equal(launched.options.shell, false);
  assert.equal(launched.options.env.NODE_OPTIONS, undefined);
  assert.equal(launched.options.env.NAPCAT_QQ_DATA_DIR, path.join(f.root, 'userData/napcat/qq-data'));
  assert.equal((await f.app.status()).running, true);
  await f.app.stop();
  await f.app.stop();
  assert.deepEqual(f.stopped, [987654321]);
  assert.equal((await f.app.status()).running, false);
  assert.equal(JSON.stringify(f.changes).includes(f.root), false);
});

test('tampered .env or plugin code blocks launch and stop never discovers foreign processes', async t => {
  const f = await fixture(t);
  await f.app.configure(f.folder);
  await fs.appendFile(path.join(f.folder, 'napcat/config/.env'), '\nNAPCAT_QQ_DATA_DIR=/foreign/QQ\n');
  await assert.rejects(f.app.start(), /隔离|配置/);
  assert.equal(f.launches.length, 0);
  await f.app.stop();
  assert.deepEqual(f.stopped, []);
});

test('macOS exposes only external connection guidance and never inspects or launches QQ', async t => {
  const f = await fixture(t, { platform: 'darwin' });
  const status = await f.app.status();
  assert.equal(status.externalOnly, true);
  assert.equal(status.canStart, false);
  await assert.rejects(f.app.configure('/Applications/QQ.app'), /外部|独立/);
  await assert.rejects(f.app.start(), /外部|独立/);
  assert.equal(f.launches.length, 0);
});

test('unrecognized extra executable dependencies cannot be adopted by the trusted entrypoint', async t => {
  const f = await fixture(t);
  await f.app.configure(f.folder);
  const extra = path.join(f.folder, 'napcat/node_modules/optional-untrusted/index.js');
  await fs.mkdir(path.dirname(extra), { recursive: true });
  await fs.writeFile(extra, 'untrusted optional module');
  await assert.rejects(f.app.start(), /校验|额外|官方/);
  assert.equal(f.launches.length, 0);
});

test('Linux can configure verified standalone files but launches only through the external guide', async t => {
  const f = await fixture(t, { platform: 'linux' });
  await fs.rename(path.join(f.folder, 'napcat'), path.join(f.root, 'linux-shell'));
  f.app.assets = { ...f.app.assets, files: Object.fromEntries(Object.entries(f.app.assets.files).filter(([name]) => name.startsWith('napcat/'))) };
  const configured = await f.app.configure(path.join(f.root, 'linux-shell'));
  assert.equal(configured.isolationApplied, true);
  assert.equal(configured.externalOnly, true);
  assert.equal(configured.canStart, false);
  await assert.rejects(f.app.start(), /外部|独立/);
  assert.equal(f.launches.length, 0);
});

test('stop cancels an in-flight component download before extraction or launch', async t => {
  const f = await fixture(t);
  f.app.assets = { ...f.app.assets, asset: { url: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip', sha256: '0'.repeat(64) } };
  let entered, extracted = false;
  const downloading = new Promise(resolve => { entered = resolve; });
  f.app.fetch = async (url, options) => { entered(); return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); };
  f.app.runner = async () => { extracted = true; };
  const pending = f.app.install(); pending.catch(() => {});
  await downloading;
  await f.app.stop();
  await assert.rejects(pending, /取消/);
  assert.equal(extracted, false);
  assert.equal(f.launches.length, 0);
});

test('stop fences a pending independent start before the owned process can spawn', async t => {
  const f = await fixture(t);
  await f.app.configure(f.folder);
  let entered, release;
  const inEnvironment = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  f.manager.environment = async () => { entered(); return waiting; };
  const pending = f.app.start(); pending.catch(() => {});
  await inEnvironment;
  const stopping = f.app.stop(); release({});
  await stopping;
  await assert.rejects(pending, /取消/);
  assert.equal(f.launches.length, 0);
  assert.deepEqual(f.stopped, []);
});

test('explicit installation verifies the official download and extracts privately without launching', async t => {
  const f = await fixture(t, { account: false });
  const payload = Buffer.from('synthetic ZIP content validated by the extractor boundary');
  const requested = [], commands = [];
  f.app.assets = { ...f.app.assets, asset: { url: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip',
    sha256: crypto.createHash('sha256').update(payload).digest('hex'), size: payload.length } };
  f.app.fetch = async (url, options) => { requested.push({ url, options }); return new Response(payload, { headers: { 'content-length': String(payload.length) } }); };
  f.app.runner = async (command, args, options) => {
    commands.push({ command, args, options });
    const privateRoot = args[args.indexOf('--private-root') + 1];
    await fs.cp(f.folder, path.join(privateRoot, 'package-4.18.42'), { recursive: true });
    return Buffer.from('{"installed":true}');
  };
  f.manager.python = 'trusted-managed-python';
  assert.equal(typeof f.app.install, 'function');
  const installed = await f.app.install();
  assert.equal(installed.configured, true);
  assert.equal(installed.isolationApplied, true);
  assert.equal(installed.running, false);
  assert.equal(f.launches.length, 0);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, f.app.assets.asset.url);
  assert.equal(commands[0].command, 'trusted-managed-python');
  assert.deepEqual(commands[0].args.slice(0, 2), ['-m', 'dswhale.napcat_install']);
  assert.equal(commands[0].args.includes(f.root + '/official-QQ'), false);
});

test('installation refuses tampered downloads before extraction or launch', async t => {
  const f = await fixture(t);
  f.app.assets = { ...f.app.assets, asset: { url: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip', sha256: '0'.repeat(64), size: 10 } };
  f.app.fetch = async () => new Response('bad bytes', { headers: { 'content-length': '9' } });
  let extracted = false; f.app.runner = async () => { extracted = true; };
  assert.equal(typeof f.app.install, 'function');
  await assert.rejects(f.app.install(), /校验/);
  assert.equal(extracted, false);
  assert.equal(f.launches.length, 0);
});

test('owned launch removes competing quick credentials and disables legacy WebUI account fallback', async t=>{
  const f=await fixture(t,{account:false});
  const envFile=path.join(f.folder,'napcat/config/.env');
  await fs.writeFile(envFile,'# keep\nCUSTOM_KEEP=yes\nNAPCAT_QUICK_ACCOUNT=87654321\nNAPCAT_QUICK_PASSWORD=synthetic-password\nNAPCAT_QUICK_PASSWORD_MD5=00000000000000000000000000000000\n');
  await fs.mkdir(path.join(f.app.work,'config'),{recursive:true});
  await fs.writeFile(path.join(f.app.work,'config/webui.json'),JSON.stringify({autoLoginAccount:'87654321',theme:{keep:true}}));
  await f.app.configure(f.folder);
  const env=await fs.readFile(envFile,'utf8');
  assert.equal(/NAPCAT_QUICK_(?:ACCOUNT|PASSWORD)/.test(env),false);
  assert.match(env,/CUSTOM_KEEP=yes/);
  const webui=JSON.parse(await fs.readFile(path.join(f.app.work,'config/webui.json'),'utf8'));
  assert.equal(webui.autoLoginAccount,'');assert.deepEqual(webui.theme,{keep:true});
  await f.app.start();
  assert.equal(f.launches[0].options.env.NAPCAT_QUICK_ACCOUNT,undefined);
  await f.app.stop();
  await fs.appendFile(envFile,'NAPCAT_QUICK_ACCOUNT=87654321\n');
  await assert.rejects(f.app.start(),/隔离|配置/);
  assert.equal(f.launches.length,1);
});
for(const phase of ['changed','unknown']) {
 test('live apply rejects '+phase+' identity during config read without writing or persisting it',async t=>{
  let account='12345678',writes=0;
  const session={reset(){},inspect:async()=>account?{loginState:'online',account}:{loginState:'unknown'},
   getConfig:async()=>{account=phase==='changed'?'87654321':null;return {network:{websocketClients:[{name:'another-app',url:'ws://127.0.0.1:7000/ws'}]}};},
   setConfig:async()=>{writes++;}};
  const f=await fixture(t,{session});await f.app.configure(f.folder);await f.app.start();
  const identity=await fs.readFile(path.join(f.app.base,'session.json'));
  await assert.rejects(f.app.wire(),/账号|确认|登录/);
  assert.equal(writes,0);assert.deepEqual(await fs.readFile(path.join(f.app.base,'session.json')),identity);
  assert.equal(f.app.running,true);await f.app.stop();
 });
}

test('a newer identity observation fences an older private identity write', async t=>{
  let observed=false;
  const session={identityRevision:1,reset(){},inspect:async()=>{observed=true;return {loginState:'online',account:'12345678'};}};
  const f=await fixture(t,{session});await f.app.configure(f.folder);
  const file=path.join(f.app.base,'session.json');
  const previous=JSON.stringify({schema:1,account:'87654321'});
  await fs.writeFile(file,previous);
  const original=fs.readFile;let release,entered;
  const pending=new Promise(resolve=>{entered=resolve;});
  const wait=new Promise(resolve=>{release=resolve;});
  fs.readFile=async function(name,...args){const value=await original.call(this,name,...args);if(name===file&&observed){entered();await wait;}return value;};
  try {
    const started=f.app.start();await pending;
    session.identityRevision=2;release();await started;
    assert.equal(await original(file,'utf8'),previous);
  }finally{release();fs.readFile=original;await f.app.stop();}
});

test('wire targets the bound OneBot instance among several enabled robots', async t => {
  let config, f, writes = 0;
  const session = { inspect: async () => ({ loginState: 'online', account: '12345678' }), reset() {},
    getConfig: async () => structuredClone(config), setConfig: async (_context, next) => {
      writes++; config = structuredClone(next);
      await fs.writeFile(path.join(f.app.work, 'config/onebot11_12345678.json'), JSON.stringify(config));
    } };
  f = await fixture(t, { session });
  await f.app.configure(f.folder);
  config = JSON.parse(await fs.readFile(path.join(f.app.work, 'config/onebot11_12345678.json'), 'utf8'));
  await f.app.start();
  const platforms = [
    { id: 'other-bot', type: 'aiocqhttp', enable: true, ws_reverse_host: '127.0.0.1', ws_reverse_port: 6201, ws_reverse_token: 'synthetic-other-token-123' },
    { id: 'bound-qq', type: 'aiocqhttp', enable: true, ws_reverse_host: '127.0.0.1', ws_reverse_port: 6299, ws_reverse_token: 'synthetic-bound-token-456' },
  ];
  const { selectNapcatConnection } = require('../lib/qq-connections.cjs');
  f.app.getConnection = async () => {
    const selected = selectNapcatConnection(platforms, 'bound-qq');
    return selected ? { port: selected.port, token: selected.token } : null;
  };
  await f.app.wire();
  assert.equal(writes, 1);
  assert.equal(config.network.websocketClients[1].url, 'ws://127.0.0.1:6299/ws');
  assert.equal(config.network.websocketClients[1].token, 'synthetic-bound-token-456');
  assert.deepEqual(config.network.websocketClients[0], f.config.network.websocketClients[0]);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.stopped, []);
});
