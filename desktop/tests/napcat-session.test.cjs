'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
let NapCatSession;
try { ({ NapCatSession } = require('../lib/napcat-session.cjs')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const token = 'synthetic-private-webui-token';
const credential = Buffer.from('synthetic-local-credential').toString('base64');

async function fixture(t, { route, options = {} } = {}) {
  assert.equal(typeof NapCatSession, 'function', 'bounded localhost session client is available');
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', data => { raw += data; });
    req.on('end', async () => {
      const call = { path: req.url, method: req.method, authorization: req.headers.authorization, body: JSON.parse(raw || '{}') };
      calls.push(call);
      res.setHeader('Content-Type', 'application/json');
      const custom = route && await route(call, res);
      if (custom === false || res.writableEnded) return;
      const data = call.path === '/api/auth/login' ? { Credential: credential }
        : call.path === '/api/QQLogin/CheckLoginStatus' ? { isLogin: true, coreReady: true, isOffline: false,
          loginPhase: 'online', qrcodeurl: 'synthetic-private-qr-url', loginError: 'synthetic-private-error' }
        : call.path === '/api/QQLogin/GetQQLoginInfo' ? { uin: '12345678', online: true, nick: 'synthetic-private-name' }
        : { network: { websocketClients: [] } };
      res.end(JSON.stringify({ code: 0, message: 'success', data: custom === undefined ? data : custom }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new NapCatSession(options);
  t.after(async () => { client.reset(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { client, calls, context: { port: server.address().port, token } };
}

test('live QQ observation uses the pinned WebUI auth protocol and exposes only its private minimal result', async t => {
  const f = await fixture(t);
  const result = await f.client.inspect(f.context);
  assert.deepEqual(result, { loginState: 'online', account: '12345678' });
  assert.deepEqual(f.calls.map(c => c.path), ['/api/auth/login', '/api/QQLogin/CheckLoginStatus', '/api/QQLogin/GetQQLoginInfo']);
  assert.equal(f.calls[0].body.hash, crypto.createHash('sha256').update(token + '.napcat').digest('hex'));
  assert.equal(f.calls[0].authorization, undefined);
  assert.ok(f.calls.slice(1).every(c => c.authorization === 'Bearer ' + credential && c.method === 'POST'));
  for (const value of [token, credential, 'synthetic-private-name', 'synthetic-private-qr-url', 'synthetic-private-error'])
    assert.equal(JSON.stringify(result).includes(value), false);
});

test('simultaneous and repeated status observations reuse one bounded read and never start a QQ login', async t => {
  let now = 1000;
  const f = await fixture(t, { options: { now: () => now } });
  await Promise.all([f.client.inspect(f.context), f.client.inspect(f.context), f.client.inspect(f.context)]);
  await f.client.inspect(f.context);
  assert.equal(f.calls.length, 3);
  now += 6000;
  await f.client.inspect(f.context);
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls.filter(c => c.path === '/api/auth/login').length, 1);
  assert.ok(f.calls.every(c => !/QuickLogin|Qrcode|Refresh|Password|Logout|Device|Restart/.test(c.path)));
});

for (const [phase, expected] of [['initializing', 'connecting'], ['qrcode_scanned', 'confirming'], ['waiting_qrcode', 'scan-required'], ['reconnecting', 'connecting'], ['offline', 'offline'], ['unexpected', 'unknown']]) {
  test('QQ login phase ' + phase + ' is observed without requesting another QR or login', async t => {
    const f = await fixture(t, { route: call => call.path === '/api/QQLogin/CheckLoginStatus'
      ? { isLogin: false, coreReady: false, loginPhase: phase } : undefined });
    assert.deepEqual(await f.client.inspect(f.context), { loginState: expected });
    assert.equal(f.calls.length, 2);
  });
}

test('a stale online flag cannot promote QQ before its core and current account are ready', async t => {
  const f = await fixture(t, { route: call => call.path === '/api/QQLogin/CheckLoginStatus'
    ? { isLogin: true, coreReady: false, loginPhase: 'initializing' } : undefined });
  assert.deepEqual(await f.client.inspect(f.context), { loginState: 'connecting' });
  assert.equal(f.calls.some(c => c.path.endsWith('/GetQQLoginInfo')), false);
});

test('WebUI two-factor or authentication failures stay unknown and do not retry at each refresh', async t => {
  let now = 1000;
  const f = await fixture(t, { options: { now: () => now }, route: call => call.path === '/api/auth/login' ? { require2FA: true } : undefined });
  assert.deepEqual(await f.client.inspect(f.context), { loginState: 'unknown' });
  now += 6000;
  assert.deepEqual(await f.client.inspect(f.context), { loginState: 'unknown' });
  assert.equal(f.calls.length, 1);
});

test('redirects cannot forward a local credential or turn a private response into a login prompt', async t => {
  let foreignCalls = 0;
  const foreign = http.createServer((_req, res) => { foreignCalls++; res.end('{}'); });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  const f = await fixture(t, { route: (_call, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:' + foreign.address().port + '/' }); res.end(); return false; } });
  assert.deepEqual(await f.client.inspect(f.context), { loginState: 'unknown' });
  assert.equal(foreignCalls, 0);
});

test('oversized, malformed and stalled localhost responses fail safely with bounded work', async t => {
  for (const kind of ['oversized', 'malformed', 'stalled']) {
    const f = await fixture(t, { options: { timeout: 40, maxBytes: 1024 }, route: (_call, res) => {
      if (kind === 'oversized') res.end('x'.repeat(2000));
      else if (kind === 'malformed') res.end('synthetic-private-malformed');
      return false;
    } });
    assert.deepEqual(await f.client.inspect(f.context), { loginState: 'unknown' });
    assert.equal(f.calls.length, 1);
  }
});

test('reset cancels an outstanding observation and prevents stale results from becoming new cached state', async t => {
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { route: (_call, _res) => { entered(); return false; } });
  const pending = f.client.inspect(f.context);
  await waiting;
  f.client.reset();
  assert.deepEqual(await pending, { loginState: 'unknown' });
});

test('only an explicit configuration write invokes the fixed SetConfig endpoint with the complete config', async t => {
  const f = await fixture(t);
  const config = await f.client.getConfig(f.context);
  assert.deepEqual(config, { network: { websocketClients: [] } });
  config.network.websocketClients.push({ name: 'DSWhale', enable: true, url: 'ws://127.0.0.1:6199/ws', token: 'synthetic-onebot-secret' });
  await f.client.setConfig(f.context, config);
  assert.deepEqual(f.calls.map(c => c.path), ['/api/auth/login', '/api/OB11Config/GetConfig', '/api/OB11Config/SetConfig']);
  assert.deepEqual(f.calls[2].body, { config: JSON.stringify(config) });
});

test('invalid local endpoints and credentials fail closed before any network request', async t => {
  const f = await fixture(t);
  for (const context of [{ port: 80, token }, { port: 65536, token }, { port: f.context.port, token: 'bad\nsecret' }]) {
    assert.deepEqual(await f.client.inspect(context), { loginState: 'unknown' });
    await assert.rejects(f.client.getConfig(context), /登录管理|本机/);
  }
  assert.equal(f.calls.length, 0);
});

test('explicit fresh identity checks bypass cached observations',async t=>{
 let account='12345678';
 const f=await fixture(t,{route:call=>call.path==='/api/QQLogin/GetQQLoginInfo'?{uin:account,online:true}:undefined});
 assert.equal((await f.client.inspect(f.context)).account,'12345678');
 account='87654321';
 assert.equal((await f.client.inspect(f.context)).account,'12345678');
 assert.equal((await f.client.inspect(f.context,{fresh:true})).account,'87654321');
});

test('fresh identity check waits for an older request and then makes its own observation',async t=>{
 let held,entered;const waiting=new Promise(resolve=>{entered=resolve;});let infoCalls=0;
 const f=await fixture(t,{route:(call,res)=>{
  if(call.path!=='/api/QQLogin/GetQQLoginInfo')return;
  if(++infoCalls===1){held=res;entered();return false;}
  return {uin:'87654321',online:true};
 }});
 const older=f.client.inspect(f.context);await waiting;
 const fresh=f.client.inspect(f.context,{fresh:true});
 held.end(JSON.stringify({code:0,data:{uin:'12345678',online:true}}));
 assert.equal((await older).account,'12345678');
 assert.equal((await fresh).account,'87654321');assert.equal(infoCalls,2);
});
