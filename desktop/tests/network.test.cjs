'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const network = (()=>{try{return require('../lib/network.cjs');}catch{return {};}})();

test('source classification recognizes pinned vendors and rejects lookalike domains',()=>{
  assert.equal(network.classifySource('https://ffmpeg.martin-riedl.de/download/tool.zip'),'ffmpeg');
  assert.equal(network.classifySource('https://nodejs.org/dist/asset'),'nodejs');
  assert.equal(network.classifySource('https://pypi.org/simple'),'pypi');
  assert.equal(network.classifySource('https://github.com.evil.test/asset'),'other');
});

test('network settings reject credentials and unsafe mirrors without echoing input', async()=>{
  assert.equal(typeof network.normalizeNetworkConfig,'function');
  for(const config of [
    {mode:'custom',proxyUrl:'http://user:PRIVATE@127.0.0.1:7890'},
    {mode:'custom',proxyUrl:'file:///PRIVATE'},
    {pypiIndex:'https://mirror.test/simple?token=PRIVATE'},
    {assetMirrors:[{from:'https://github.com/',to:'http://mirror.test/'}]},
    {password:'PRIVATE'},
  ])assert.throws(()=>network.normalizeNetworkConfig(config),error=>error.code==='NET_POLICY'&&!error.message.includes('PRIVATE'));
  const config=network.normalizeNetworkConfig({mode:'custom',proxyUrl:'http://127.0.0.1:7890',pypiIndex:'https://mirror.test/simple',npmRegistry:'https://npm.test/',assetMirrors:[{from:'https://nodejs.org/dist/',to:'https://mirror.test/node/'}]});
  assert.equal(network.resolveAssetUrl('https://nodejs.org/dist/v22/node.zip',config),'https://mirror.test/node/v22/node.zip');
  assert.equal(network.resolveAssetUrl('https://nodejs.org.evil.test/dist/x',config),'https://nodejs.org.evil.test/dist/x');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-net-'));
  try{
    await network.writeNetworkConfig(dir,config);assert.equal((await network.readNetworkConfig(dir)).mode,'system');
    const blocked=path.join(dir,'PRIVATE-file');await fs.writeFile(blocked,'fixture');
    await assert.rejects(network.writeNetworkConfig(blocked,config),error=>error.code==='NET_POLICY'&&!error.message.includes('PRIVATE'));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('network environment applies explicit routing and package mirrors',()=>{
  assert.equal(typeof network.networkEnvironment,'function');
  const base={PATH:'tools',HTTP_PROXY:'http://system.test:80',https_proxy:'http://system.test:81',ALL_PROXY:'socks5://system.test:82',PIP_EXTRA_INDEX_URL:'https://stale.test/'};
  assert.equal(network.networkEnvironment({mode:'system'},base).HTTP_PROXY,base.HTTP_PROXY);
  const direct=network.networkEnvironment({mode:'direct'},base);
  assert.equal(direct.HTTP_PROXY,undefined);assert.equal(direct.https_proxy,undefined);assert.equal(direct.ALL_PROXY,undefined);
  const custom=network.networkEnvironment({mode:'custom',proxyUrl:'http://127.0.0.1:7890',noProxy:'localhost,127.0.0.1',pypiIndex:'https://mirror.test/simple',npmRegistry:'https://npm.test/'},base);
  assert.equal(custom.HTTPS_PROXY,'http://127.0.0.1:7890/');assert.equal(custom.NO_PROXY,'localhost,127.0.0.1');
  assert.equal(custom.UV_DEFAULT_INDEX,'https://mirror.test/simple');assert.equal(custom.PIP_INDEX_URL,'https://mirror.test/simple');
  assert.equal(custom.PIP_EXTRA_INDEX_URL,undefined);assert.equal(custom.NPM_CONFIG_REGISTRY,'https://npm.test/');
  assert.match(network.networkEnvironment({mode:'custom',proxyUrl:'http://127.0.0.1:7890'},{}).NO_PROXY,/127\.0\.0\.1/);
});

test('Electron transport explicitly configures a dedicated session and suppresses transport errors',async()=>{
  assert.equal(typeof network.createElectronTransport,'function');
  const calls=[];let closed=0;
  const session={setProxy:async value=>calls.push(value),closeAllConnections:async()=>{closed++;},fetch:async()=>new Response('ok')};
  const request=network.createElectronTransport(session,{env:{HTTPS_PROXY:'http://127.0.0.1:7890'}});
  await request('https://github.com/example',{network:{mode:'system'}});
  assert.equal(calls[0].mode,'fixed_servers');assert.equal(calls[0].proxyRules,'http://127.0.0.1:7890');
  await request('https://github.com/example',{network:{mode:'direct'}});
  assert.deepEqual(calls[1],{mode:'direct'});
  assert.equal(closed,1);
  session.fetch=async()=>{throw new Error('PRIVATE /synthetic-home/private proxy password');};
  await assert.rejects(request('https://github.com/example'),error=>error.code==='NET_INTERRUPTED'&&!error.message.includes('PRIVATE'));
});

test('Electron transport follows HTTPS redirects explicitly and refuses insecure hops',async()=>{
  const requested=[];
  const session={setProxy:async()=>{},fetch:async(url,options)=>{
    requested.push(url);assert.equal(options.redirect,'manual');
    return requested.length===1?new Response(null,{status:302,headers:{location:'https://cdn.test/asset?signature=synthetic'}}):new Response('abc');
  }};
  const request=network.createElectronTransport(session,{env:{}});
  const response=await request('https://github.com/example/asset',{network:{mode:'direct'}});
  assert.equal(await response.text(),'abc');assert.equal(requested.length,2);
  session.fetch=async()=>new Response(null,{status:302,headers:{location:'http://insecure.test/asset'}});
  await assert.rejects(request('https://github.com/example/asset'),error=>error.code==='NET_POLICY');
});

test('Chromium session blocks insecure redirects through its request boundary',async()=>{
  let beforeRequest;
  const session={setProxy:async()=>{},webRequest:{onBeforeRequest:(filter,handler)=>{beforeRequest=handler;}},fetch:async(url,options)=>{
    assert.equal(options.redirect,'follow');
    let denied=false;
    beforeRequest({url:'http://insecure.test/asset'},result=>{denied=result.cancel;});
    assert.equal(denied,true);
    throw new Error('net::ERR_BLOCKED_BY_CLIENT');
  }};
  const request=network.createElectronTransport(session,{env:{}});
  await assert.rejects(request('https://github.com/example/asset'),error=>error.code==='NET_POLICY');
});

test('resumable verified downloads retain interrupted bytes and validate Content-Range',async()=>{
  const {downloadVerified}=require('../lib/runtime.cjs');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-resume-')),file=path.join(dir,'asset');
  const asset={url:'https://nodejs.org/dist/asset',sha256:crypto.createHash('sha256').update('abcdef').digest('hex')};
  const broken=async()=>({ok:true,status:200,headers:new Headers({'content-length':'6'}),body:(async function*(){yield Buffer.from('abc');throw new Error('PRIVATE');})()});
  try{
    await assert.rejects(downloadVerified(asset,file,{fetch:broken,retries:0}),error=>error.code==='NET_INTERRUPTED'&&!error.message.includes('PRIVATE'));
    assert.equal(await fs.readFile(file+'.part','utf8'),'abc');
    await downloadVerified(asset,file,{retries:0,fetch:async(url,options)=>{assert.equal(options.headers.Range,'bytes=3-');return new Response('def',{status:206,headers:{'content-range':'bytes 3-5/6','content-length':'3'}});}});
    assert.equal(await fs.readFile(file,'utf8'),'abcdef');
    await fs.writeFile(file+'.part','abc');
    await assert.rejects(downloadVerified(asset,file,{retries:0,fetch:async()=>new Response('def',{status:206,headers:{'content-range':'bytes 2-4/6'}})}),error=>error.code==='NET_RANGE');
    await assert.rejects(fs.access(file+'.part'));
    await fs.mkdir(file+'.part');
    await assert.rejects(downloadVerified(asset,file,{fetch:broken,retries:0}),error=>error.code==='NET_POLICY'&&!error.message.includes(dir));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('retry restarts when Range is ignored and never installs mismatched bytes',async()=>{
  const {downloadVerified}=require('../lib/runtime.cjs');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-retry-')),file=path.join(dir,'asset');
  const asset={url:'https://github.com/example/asset',sha256:crypto.createHash('sha256').update('abcdef').digest('hex')};
  let count=0;
  try{
    await fs.writeFile(file+'.part','abc');
    await downloadVerified(asset,file,{retries:1,fetch:async()=>{count++;if(count===1)throw Object.assign(new Error('PRIVATE'),{code:'EAI_AGAIN'});return new Response('abcdef');}});
    assert.equal(count,2);assert.equal(await fs.readFile(file,'utf8'),'abcdef');
    await fs.rm(file);
    await assert.rejects(downloadVerified(asset,file,{retries:0,fetch:async()=>new Response('bad')}),error=>error.code==='NET_CHECKSUM');
    await assert.rejects(fs.access(file));await assert.rejects(fs.access(file+'.part'));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a completely transferred partial is verified before requesting more bytes',async()=>{
  const {downloadVerified}=require('../lib/runtime.cjs');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-complete-')),file=path.join(dir,'asset');
  try{
    await fs.writeFile(file+'.part','abc');
    await downloadVerified({url:'https://nodejs.org/asset',sha256:crypto.createHash('sha256').update('abc').digest('hex')},file,{fetch:async()=>{throw new Error('must not fetch completed content');},retries:0});
    assert.equal(await fs.readFile(file,'utf8'),'abc');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('system proxy resolution supports Clash without a fixed port or credential exposure',async()=>{
  assert.equal(typeof network.systemProxyURL,'function');
  assert.equal(await network.systemProxyURL({resolveProxy:async()=> 'PROXY 127.0.0.1:7897; DIRECT'}),'http://127.0.0.1:7897/');
  assert.equal(await network.systemProxyURL({resolveProxy:async()=> 'DIRECT'}),'');
  assert.equal(await network.systemProxyURL({resolveProxy:async()=> 'PROXY user:PRIVATE@localhost:7890'}),'');
});
