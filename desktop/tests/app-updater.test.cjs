'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
let updater = {};
try { updater = require('../lib/app-updater.cjs'); } catch {}

const pair = crypto.generateKeyPairSync('ed25519');
const trust = { repository: 'XianZe1226/DSWhale', algorithm: 'ed25519', publicKey: pair.publicKey.export({format:'pem',type:'spki'}) };
const base = 'https://github.com/XianZe1226/DSWhale/releases/download/';
const bytes = Buffer.from('installer-fixture');
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
function manifest(version = '0.3.0a4', change = {}) {
  const npmVersion = version.replace(/a(\d+)$/, '-alpha.$1');
  const assets = {};
  for (const [platform, suffix] of Object.entries({'win32-x64':'Windows-x86_64-setup.exe','darwin-arm64':'macOS-arm64.dmg','linux-x64':'Linux-x86_64.deb'})) {
    const name = `DSWhale-${npmVersion}-${suffix}`;
    assets[platform] = {name,url:`${base}v${version}/${name}`,size:bytes.length,sha256:sha};
  }
  return {schemaVersion:1,product:'DSWhale',repository:'XianZe1226/DSWhale',version,npmVersion,channel:version.includes('a')?'alpha':'stable',tag:`v${version}`,commit:'a'.repeat(40),minimumOS:{win32:'10.0.19045',darwin:'13.0',linux:['ubuntu:22.04','ubuntu:24.04']},runtime:{astrbot:'4.29.3',python:'3.12',node:'22.23.4',ffmpeg:'9.0.2'},impact:{runtime:true,dataMigration:false,configuration:false,rollbackCompatible:true},assets,...change};
}
function signed(value) {
  const raw = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return {raw,signature:crypto.sign(null,raw,pair.privateKey)};
}
async function fixture(t, options = {}) {
  assert.equal(typeof updater.AppUpdater,'function');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-app-update-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const docs = new Map(['0.3.0a3','0.3.0a4','0.3.0'].map(v=>[v,signed(manifest(v))]));
  const requests = [], events = [];
  const request = async (url) => {
    requests.push(url);
    if(url==='https://api.github.com/repos/XianZe1226/DSWhale/releases?per_page=100') {
      return new Response(JSON.stringify((options.releases||['0.3.0a4']).map(v=>({tag_name:`v${v}`,draft:false,prerelease:v.includes('a')}))));
    }
    const match = url.match(/\/v([^/]+)\/release-manifest\.(json|sig)$/);
    if(match && docs.has(match[1])) return new Response(docs.get(match[1])[match[2]==='json'?'raw':'signature']);
    throw new Error('Unexpected network request with PRIVATE_FIXTURE');
  };
  const download = async (asset,file) => {events.push(`download:${asset.name}`);await fs.writeFile(file,bytes);};
  const config = {runtime:directory,currentVersion:'0.3.0-alpha.3',platform:'darwin',arch:'arm64',osRelease:'24.0.0',trust,fetch:request,download,
    stopServices:async()=>events.push('stop'),snapshot:async()=>{events.push('snapshot');return {id:'backup-fixture',fingerprint:'b'.repeat(64)};},
    launchInstaller:async payload=>events.push(payload.rollback?'launch-rollback':'launch-update'),
    restoreSnapshot:async(id)=>events.push(`restore:${id}`),...options};
  return {directory,docs,requests,events,config,manager:new updater.AppUpdater(config)};
}
async function prepared(t, options={}) { const f=await fixture(t,options);await f.manager.check({channel:'alpha'});await f.manager.download();return f; }

test('signed metadata is authenticated before parsing and rejects altered bytes', () => {
  assert.equal(typeof updater.verifyManifest,'function');
  const doc=signed(manifest());
  assert.equal(updater.verifyManifest(doc.raw,doc.signature,{trust}).version,'0.3.0a4');
  assert.throws(()=>updater.verifyManifest(Buffer.from('{PRIVATE_FIXTURE'),doc.signature,{trust}),e=>e.code==='SIGNATURE_INVALID');
  const invalid=signed('{not-json');
  assert.throws(()=>updater.verifyManifest(invalid.raw,invalid.signature,{trust}),e=>e.code==='MANIFEST_INVALID');
  assert.throws(()=>updater.verifyManifest(Buffer.alloc(65537),doc.signature,{trust}),e=>e.code==='MANIFEST_TOO_LARGE');
});

test('signed manifests reject unofficial URLs, filenames, versions and unsupported matrices', () => {
  assert.equal(typeof updater.verifyManifest,'function');
  const bad=[];
  let m=manifest();m.assets['darwin-arm64'].url='https://example.com/install.dmg';bad.push(m);
  m=manifest();m.assets['darwin-arm64'].name='../install.dmg';bad.push(m);
  m=manifest();m.npmVersion='0.3.0-alpha.5';bad.push(m);
  m=manifest();m.runtime.node='24.0.0';bad.push(m);
  m=manifest();m.assets['darwin-arm64'].size=0;bad.push(m);
  m=manifest();m.assets['darwin-arm64'].size=5*1024**3;bad.push(m);
  m=manifest();m.assets['darwin-arm64'].url+='?token=PRIVATE_FIXTURE';bad.push(m);
  m=manifest();m.impact.rollbackCompatible='yes';bad.push(m);
  m=manifest();m.channel='stable';bad.push(m);
  for(const value of bad) {const doc=signed(value);assert.throws(()=>updater.verifyManifest(doc.raw,doc.signature,{trust}),e=>e.code==='MANIFEST_INVALID');}
});

test('status is offline, normalizes versions and never claims an installer was applied', async t => {
  const f=await fixture(t);
  const status=await f.manager.status();
  assert.equal(status.currentVersion,'0.3.0a3');
  assert.equal(status.phase,'idle');
  assert.equal(status.canInstall,false);
  assert.deepEqual(f.requests,[]);
  await f.manager.check({channel:'alpha'});
  assert.equal((await f.manager.status()).targetVersion,'0.3.0a4');
  assert.equal((await f.manager.status()).canDownload,true);
  assert.ok(!JSON.stringify(await f.manager.status()).includes(f.directory));
});

test('GitHub REST discovery uses its JSON media type while signed assets use binary media',async t=>{
  const f=await fixture(t),seen=[];
  const manager=new updater.AppUpdater({...f.config,fetch:async(url,options)=>{
    const accept=new Headers(options.headers).get('accept');seen.push({api:new URL(url).hostname==='api.github.com',accept});
    if(accept!==(new URL(url).hostname==='api.github.com'?'application/vnd.github+json':'application/octet-stream'))return new Response('unsupported media type',{status:415});
    return f.config.fetch(url,options);
  }});
  assert.equal((await manager.check({channel:'alpha'})).targetVersion,'0.3.0a4');
  assert.deepEqual(seen.map(item=>item.accept),['application/vnd.github+json','application/octet-stream','application/octet-stream']);
});

test('channel selection uses canonical releases and persists a monotonic version floor', async t => {
  const f=await fixture(t,{releases:['0.3.0a4','0.3.0']});
  assert.equal((await f.manager.check({channel:'stable'})).targetVersion,'0.3.0');
  const next=new updater.AppUpdater({...f.config,releases:undefined,fetch:async()=>new Response(JSON.stringify([{tag_name:'v0.3.0a4',draft:false,prerelease:true}]))});
  await assert.rejects(next.check({channel:'alpha'}),e=>e.code==='DOWNGRADE_BLOCKED');
  await assert.rejects(f.manager.check({channel:'nightly'}),e=>e.code==='CHANNEL_INVALID');
});

test('download fetches and verifies the current installer before the target installer', async t => {
  const f=await prepared(t);
  assert.equal(f.events[0],'download:DSWhale-0.3.0-alpha.3-macOS-arm64.dmg');
  assert.equal(f.events[1],'download:DSWhale-0.3.0-alpha.4-macOS-arm64.dmg');
  assert.ok(f.requests.includes(`${base}v0.3.0a3/release-manifest.sig`));
  const status=await f.manager.status();
  assert.equal(status.phase,'downloaded');
  assert.equal(status.canInstall,true);
  assert.equal(status.canRollback,false);
  assert.equal(status.matrix.node,'22.23.4');
});

test('missing signed current metadata blocks upgrade instead of discarding rollback', async t => {
  const f=await fixture(t);f.docs.delete('0.3.0a3');
  await f.manager.check({channel:'alpha'});
  await assert.rejects(f.manager.download(),e=>e.code==='NETWORK_FAILED');
  assert.equal(f.events.length,0);
  assert.equal((await f.manager.status()).canInstall,false);
});

test('installer bytes are independently verified even with an injected downloader', async t => {
  const f=await fixture(t,{download:async(_asset,file)=>fs.writeFile(file,'WRONG')});
  await f.manager.check({channel:'alpha'});
  await assert.rejects(f.manager.download(),e=>e.code==='INSTALLER_INVALID');
  assert.equal((await f.manager.status()).canInstall,false);
  assert.ok(!JSON.stringify(await f.manager.status()).includes('WRONG'));
});

test('install requires stopped services and a durable backup before the explicit OS handoff', async t => {
  const f=await prepared(t);
  await f.manager.install();
  assert.deepEqual(f.events.slice(-3),['stop','snapshot','launch-update']);
  assert.equal((await f.manager.status()).phase,'install-launched');
  assert.equal((await f.manager.status()).canRollback,true);
  assert.notEqual((await f.manager.status()).phase,'installed');
  const saved=await fs.readFile(path.join(f.directory,'app-updates','state.json'),'utf8');
  assert.ok(saved.includes('backup-fixture'));
  assert.ok(!saved.includes(f.directory));
});

test('backup failure never launches an installer and exposes a bounded safe error', async t => {
  const f=await prepared(t,{snapshot:async()=>{throw new Error('PRIVATE_FIXTURE token /secret/path');}});
  await assert.rejects(f.manager.install(),e=>e.code==='BACKUP_FAILED'&&!e.message.includes('PRIVATE_FIXTURE'));
  assert.ok(!f.events.includes('launch-update'));
  assert.equal((await f.manager.status()).recovery.interrupted,true);
  assert.ok(!JSON.stringify(await f.manager.status()).includes('PRIVATE_FIXTURE'));
});

test('cache tampering and symlink installers cannot cross the installation boundary', async t => {
  const f=await prepared(t);
  const file=path.join(f.directory,'app-updates','installers','0.3.0a4','DSWhale-0.3.0-alpha.4-macOS-arm64.dmg');
  await fs.writeFile(file,'modified');
  await assert.rejects(f.manager.install(),e=>e.code==='INSTALLER_INVALID');
  assert.ok(!f.events.includes('snapshot'));
});

test('restart recognizes version replacement but requires an explicit health verification', async t => {
  const f=await prepared(t);await f.manager.install();
  const replacement=new updater.AppUpdater({...f.config,currentVersion:'0.3.0-alpha.4'});
  assert.equal((await replacement.status()).phase,'awaiting-verification');
  await replacement.completeVerification({healthy:false,version:'0.3.0a4'});
  assert.equal((await replacement.status()).phase,'repair-required');
  await replacement.completeVerification({healthy:true,version:'0.3.0a4'});
  assert.equal((await replacement.status()).phase,'installed');
  assert.equal((await replacement.status()).canRollback,true);
  assert.deepEqual(f.requests.filter(v=>v.includes('PRIVATE_FIXTURE')),[]);
});

test('unapplied installers cannot be marked healthy for a different running version', async t => {
  const f=await prepared(t);await f.manager.install();
  await assert.rejects(f.manager.completeVerification({healthy:true,version:'0.3.0a4'}),e=>e.code==='VERSION_NOT_APPLIED');
});

test('rollback preserves newer chat data by default and snapshots current state', async t => {
  const f=await prepared(t);await f.manager.install();f.events.length=0;
  const replacement=new updater.AppUpdater({...f.config,currentVersion:'0.3.0a4'});
  await replacement.rollback();
  assert.deepEqual(f.events,['stop','snapshot','launch-rollback']);
  assert.equal((await replacement.status()).phase,'rollback-launched');
  assert.ok(!f.events.some(x=>x.startsWith('restore:')));
});

test('data migration rollback requires confirmation and backs up newer data before restore', async t => {
  const f=await fixture(t);
  f.docs.set('0.3.0a4',signed(manifest('0.3.0a4',{impact:{runtime:true,dataMigration:true,configuration:true,rollbackCompatible:false}})));
  await f.manager.check({channel:'alpha'});await f.manager.download();await f.manager.install();f.events.length=0;
  const replacement=new updater.AppUpdater({...f.config,currentVersion:'0.3.0a4',snapshot:async()=>{f.events.push('snapshot-current');return {id:'new-chat-backup',fingerprint:'c'.repeat(64)};}});
  await assert.rejects(replacement.rollback(),e=>e.code==='DATA_RESTORE_REQUIRED');
  await assert.rejects(replacement.rollback({restoreData:true}),e=>e.code==='RESTORE_CONFIRMATION_REQUIRED');
  assert.equal(f.events.length,0);
  await replacement.rollback({restoreData:true,confirmDataRestore:true});
  assert.deepEqual(f.events,['stop','snapshot-current','restore:backup-fixture','launch-rollback']);
  const saved=await fs.readFile(path.join(f.directory,'app-updates','state.json'),'utf8');
  assert.ok(saved.includes('new-chat-backup'));
});

test('interrupted installation retains continue and rollback guidance without network', async t => {
  const f=await prepared(t,{launchInstaller:async()=>{throw new Error('PRIVATE_FIXTURE');}});
  await assert.rejects(f.manager.install(),e=>e.code==='INSTALLER_LAUNCH_FAILED');
  const restarted=new updater.AppUpdater({...f.config,fetch:async()=>{throw new Error('status must remain offline');}});
  const status=await restarted.status();
  assert.equal(status.recovery.interrupted,true);
  assert.ok(status.actions.includes('install'));
  assert.ok(status.actions.includes('rollback'));
  assert.ok(status.recovery.guidance.length<400);
});

test('the a2 to a3 boundary directs a first manual install before signed rollback updates', async t => {
  const f=await fixture(t,{currentVersion:'0.3.0-alpha.2'});
  await f.manager.check({channel:'alpha'});
  await assert.rejects(f.manager.download(),e=>e.code==='FIRST_MANUAL_INSTALL');
  assert.equal(f.events.length,0);
});

test('unsupported platforms and corrupt state fail safely without URLs or private file contents', async t => {
  const f=await fixture(t,{arch:'x64'});
  await assert.rejects(f.manager.check({channel:'alpha'}),e=>e.code==='PLATFORM_UNSUPPORTED');
  assert.equal(f.requests.length,0);
  await fs.mkdir(path.join(f.directory,'app-updates'),{recursive:true});
  await fs.writeFile(path.join(f.directory,'app-updates','state.json'),'{"secret":"PRIVATE_FIXTURE"}');
  const restarted=new updater.AppUpdater(f.config);
  const status=await restarted.status();
  assert.equal(status.phase,'repair-required');
  assert.ok(!JSON.stringify(status).includes('PRIVATE_FIXTURE'));
});

test('Alpha channel also offers a newer final release and remembers the selected channel', async t => {
  const f=await fixture(t,{releases:['0.3.0a4','0.3.0']});
  assert.equal((await f.manager.check({channel:'alpha'})).targetVersion,'0.3.0');
  await f.manager.check({channel:'stable'});
  const restarted=new updater.AppUpdater(f.config);
  assert.equal((await restarted.check()).channel,'stable');
});

test('installer symlinks and manifest symlinks are refused before callbacks', async t => {
  const f=await prepared(t);
  const file=path.join(f.directory,'app-updates','installers','0.3.0a4','DSWhale-0.3.0-alpha.4-macOS-arm64.dmg');
  const outside=path.join(f.directory,'outside');await fs.writeFile(outside,bytes);
  await fs.rm(file);await fs.symlink(outside,file);
  await assert.rejects(f.manager.install(),e=>e.code==='INSTALLER_INVALID');
  assert.ok(!f.events.includes('stop'));
  const metadata=path.join(f.directory,'app-updates','manifests','0.3.0a4','release-manifest.json');
  const copy=path.join(f.directory,'manifest-copy');await fs.copyFile(metadata,copy);
  await fs.rm(metadata);await fs.symlink(copy,metadata);
  await assert.rejects(f.manager.install(),e=>['MANIFEST_INVALID','STATE_INVALID'].includes(e.code));
});

test('download cancellation leaves a resumable checkpoint without launching services', async t => {
  let entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{download:async(_asset,_file,{signal})=>{entered();await new Promise((_,reject)=>{if(signal.aborted)reject(new Error('cancelled'));else signal.addEventListener('abort',()=>reject(new Error('PRIVATE_FIXTURE')),{once:true});});}});
  await f.manager.check({channel:'alpha'});
  const work=f.manager.download();await ready;
  const cancelled=f.manager.cancel();
  await assert.rejects(work,e=>e.code==='CANCELLED');await cancelled;
  const status=await new updater.AppUpdater(f.config).status();
  assert.equal(status.recovery.continueAction,'download');
  assert.equal(status.error.code,'CANCELLED');
  assert.ok(!f.events.includes('stop'));
});

test('unsafe backup IDs never become durable checkpoints or reach the installer', async t => {
  const f=await prepared(t,{snapshot:async()=>({id:'../PRIVATE_FIXTURE',fingerprint:'private chat'})});
  await assert.rejects(f.manager.install(),e=>e.code==='BACKUP_FAILED');
  const state=await fs.readFile(path.join(f.directory,'app-updates','state.json'),'utf8');
  assert.ok(!state.includes('PRIVATE_FIXTURE'));
  assert.ok(!f.events.includes('launch-update'));
});

test('source metadata responses are bounded and transport errors stay private', async t => {
  const f=await fixture(t,{fetch:async()=>new Response('x'.repeat(1024*1024+1))});
  await assert.rejects(f.manager.check({channel:'alpha'}),e=>e.code==='METADATA_TOO_LARGE');
  const g=await fixture(t,{fetch:async()=>{throw new Error('https://user:PRIVATE_FIXTURE@proxy.test');}});
  await assert.rejects(g.manager.check({channel:'alpha'}),e=>e.code==='NETWORK_FAILED'&&!e.message.includes('PRIVATE_FIXTURE'));
  assert.ok(!JSON.stringify(await g.manager.status()).includes('PRIVATE_FIXTURE'));
});

test('restore failure retains a current-data backup and never launches the old app', async t => {
  const f=await prepared(t);await f.manager.install();f.events.length=0;
  const replacement=new updater.AppUpdater({...f.config,currentVersion:'0.3.0a4',snapshot:async()=>({id:'current-data.zip',fingerprint:'c'.repeat(64)}),restoreSnapshot:async()=>{throw new Error('PRIVATE_FIXTURE');}});
  await assert.rejects(replacement.rollback({restoreData:true,confirmDataRestore:true}),e=>e.code==='RESTORE_FAILED');
  const state=JSON.parse(await fs.readFile(path.join(f.directory,'app-updates','state.json'),'utf8'));
  assert.equal(state.preRollbackBackup.id,'current-data.zip');
  assert.equal(state.backup.id,'backup-fixture');
  assert.ok(!f.events.includes('launch-rollback'));
});

test('Windows and Ubuntu installers are selected from their signed native platform slots', async t => {
  for(const [platform,arch,osRelease,distro,suffix] of [
    ['win32','x64','10.0.19045',{},'Windows-x86_64-setup.exe'],
    ['linux','x64','6.8.0',{ID:'ubuntu',VERSION_ID:'24.04'},'Linux-x86_64.deb'],
  ]) {
    const f=await prepared(t,{platform,arch,osRelease,distro});
    assert.ok(f.events[0].endsWith(suffix));
    await f.manager.install();assert.equal((await f.manager.status()).phase,'install-launched');
  }
});

test('retrying installation snapshots new private data instead of reusing an earlier failed handoff backup', async t => {
  let count=0;
  const f=await prepared(t,{snapshot:async()=>({id:`backup-${++count}.zip`,fingerprint:String(count).repeat(64)}),launchInstaller:async()=>{if(count===1)throw new Error('first handoff failed');}});
  await assert.rejects(f.manager.install(),e=>e.code==='INSTALLER_LAUNCH_FAILED');
  await f.manager.install();
  const state=JSON.parse(await fs.readFile(path.join(f.directory,'app-updates','state.json'),'utf8'));
  assert.equal(state.backup.id,'backup-2.zip');
});

test('an unrelated manually installed version is never offered a stale upgrade or rollback', async t => {
  const f=await prepared(t);await f.manager.install();
  const unrelated=new updater.AppUpdater({...f.config,currentVersion:'0.3.0a5'});
  const status=await unrelated.status();
  assert.equal(status.canInstall,false);
  assert.equal(status.canRollback,false);
});

test('checking and downloading a newer candidate preserve the last completed rollback route',async t=>{
  const releases=['0.3.0a4'];
  const f=await prepared(t,{releases});await f.manager.install();
  const running=new updater.AppUpdater({...f.config,currentVersion:'0.3.0a4'});
  await running.completeVerification({healthy:true});
  releases.push('0.3.0a5');f.docs.set('0.3.0a5',signed(manifest('0.3.0a5')));
  await running.check({channel:'alpha'});
  assert.equal((await running.status()).canRollback,true);
  assert.equal((await running.status()).previousVersion,'0.3.0a3');
  await running.download();
  assert.equal((await running.status()).canRollback,true);
  assert.equal((await running.status()).previousVersion,'0.3.0a3');
  f.events.length=0;
  const restored=new updater.AppUpdater({...f.config,currentVersion:'0.3.0a4',launchInstaller:async value=>f.events.push(`rollback:${value.version}`)});
  await restored.rollback();
  assert.ok(f.events.includes('rollback:0.3.0a3'));
});

test('automatic checks use the selected channel and only fetch signed metadata',async t=>{
 const f=await fixture(t,{releases:['0.3.0a4','0.3.0']});await f.manager.check({channel:'stable'});
 const next=new updater.AppUpdater(f.config);assert.equal((await next.check({automatic:true})).targetVersion,'0.3.0'); // metadata-only target can be refreshed after restart
 assert.equal((await next.status()).channel,'stable');assert.equal((await next.status()).targetVersion,'0.3.0');assert.deepEqual(f.events,[]);
});
test('automatic failures preserve offline state while manual failures remain explicit',async t=>{
 const f=await fixture(t,{fetch:async()=>{throw Error('network failure');}});const before=await f.manager.status();
 await assert.rejects(f.manager.check({automatic:true}),e=>e.code==='NETWORK_FAILED');assert.deepEqual(await f.manager.status(),before);
 await assert.rejects(f.manager.check({channel:'alpha'}),e=>e.code==='NETWORK_FAILED');assert.equal((await f.manager.status()).error.code,'NETWORK_FAILED');
});
test('automatic checks preserve downloaded installers and all interrupted recovery phases',async t=>{
 const f=await prepared(t);const before=await f.manager.status(),count=f.requests.length;
 assert.equal(await f.manager.check({automatic:true}),null);assert.deepEqual(await f.manager.status(),before);assert.equal(f.requests.length,count);
 for(const phase of ['downloading','snapshotting','install-ready','install-launched','awaiting-verification','rolling-back','rollback-launched','awaiting-rollback-verification','repair-required']){
  const state={format:1,channel:'stable',phase};await fs.writeFile(path.join(f.directory,'app-updates/state.json'),JSON.stringify(state));const next=new updater.AppUpdater(f.config);
  assert.equal(await next.check({automatic:true}),null);assert.equal((await next.status()).phase,phase);assert.equal(f.requests.length,count);
 }
});
test('automatic discovery can be cancelled before a manual channel check without a stale error',async t=>{
 const f=await fixture(t);let began;const started=new Promise(resolve=>{began=resolve;});
 f.manager.request=async(_url,{signal})=>{began();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));};
 const checking=f.manager.check({automatic:true});await started;const rejected=assert.rejects(checking,e=>e.code==='CANCELLED');await f.manager.cancel();await rejected;
 assert.equal((await f.manager.status()).error,null);f.manager.request=f.config.fetch;assert.equal((await f.manager.check({channel:'stable'})).phase,'up-to-date');
});
test('automatic checks skip unsupported platforms without writing a recovery error',async t=>{
 const f=await fixture(t,{platform:'linux',arch:'arm64'});assert.equal(await f.manager.check({automatic:true}),null);assert.equal((await f.manager.status()).error,null);assert.deepEqual(f.requests,[]);
});

test('automatic success follows persisted stable selection without publishing manual progress',async t=>{
 const progress=[];const f=await fixture(t,{releases:[],onProgress:value=>progress.push(value)});await f.manager.check({channel:'stable'});progress.length=0;
 const next=new updater.AppUpdater({...f.config,fetch:async(url,options)=>url.startsWith('https://api.github.com/')?new Response(JSON.stringify([{tag_name:'v0.3.0',draft:false,prerelease:false},{tag_name:'v0.3.0a4',draft:false,prerelease:true}])):f.config.fetch(url,options)});
 const status=await next.check({automatic:true});assert.equal(status.targetVersion,'0.3.0');assert.equal(status.channel,'stable');assert.deepEqual(progress,[]);assert.deepEqual(f.events,[]);
});

test('automatic discovery preserves verified rollback evidence after a completed update',async t=>{
 const f=await prepared(t);await f.manager.install();const next=new updater.AppUpdater({...f.config,currentVersion:'0.3.0-alpha.4'});await next.completeVerification({healthy:true});
 const record=JSON.parse(await fs.readFile(path.join(f.directory,'app-updates/state.json'),'utf8')).rollbackRecord;
 f.docs.set('0.3.0a5',signed(manifest('0.3.0a5')));next.request=async(url,options)=>url.startsWith('https://api.github.com/')?new Response(JSON.stringify([{tag_name:'v0.3.0a5',draft:false,prerelease:true}])):f.config.fetch(url,options);
 const status=await next.check({automatic:true});assert.equal(status.targetVersion,'0.3.0a5');assert.equal(status.canRollback,true);assert.equal(status.previousVersion,'0.3.0a3');
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,'app-updates/state.json'),'utf8')).rollbackRecord,record);assert.deepEqual(f.events.filter(value=>value==='stop'),['stop']);
});

test('manual channel selection survives restart when completed-update backup remains and no release matches',async t=>{
 const f=await prepared(t);await f.manager.install();const next=new updater.AppUpdater({...f.config,currentVersion:'0.3.0-alpha.4'});await next.completeVerification({healthy:true});next.request=async()=>new Response('[]');
 await next.check({channel:'stable'});const restarted=new updater.AppUpdater({...f.config,currentVersion:'0.3.0-alpha.4'});assert.equal((await restarted.status()).channel,'stable');assert.equal((await restarted.status()).canRollback,true);
});
test('manual channel selection survives restart when completed-update backup remains and release is current',async t=>{
 const f=await prepared(t,{releases:['0.3.0']});await f.manager.check({channel:'stable'});await f.manager.download();await f.manager.install();const next=new updater.AppUpdater({...f.config,currentVersion:'0.3.0'});await next.completeVerification({healthy:true});
 await next.check({channel:'alpha'});const restarted=new updater.AppUpdater({...f.config,currentVersion:'0.3.0'});assert.equal((await restarted.status()).channel,'alpha');assert.equal((await restarted.status()).canRollback,true);
});

test('automatic recheck advances a signed metadata-only available target to a newer release',async t=>{
 const f=await fixture(t);await f.manager.check({channel:'alpha'});f.docs.set('0.3.0a5',signed(manifest('0.3.0a5')));
 f.manager.request=async(url,options)=>url.startsWith('https://api.github.com/')?new Response(JSON.stringify([{tag_name:'v0.3.0a5',draft:false,prerelease:true}])):f.config.fetch(url,options);
 const result=await f.manager.check({automatic:true});assert.equal(result?.targetVersion,'0.3.0a5');assert.equal(result.phase,'available');assert.deepEqual(f.events,[]);
});
test('automatic recheck retains signed available target on network failure, empty or replayed discovery',async t=>{
 const f=await fixture(t);await f.manager.check({channel:'alpha'});const before=await f.manager.status(),saved=await fs.readFile(path.join(f.directory,'app-updates/state.json'),'utf8');
 f.manager.request=async()=>{throw Error('network failure');};await assert.rejects(f.manager.check({automatic:true}),e=>e.code==='NETWORK_FAILED');assert.deepEqual(await f.manager.status(),before);
 f.manager.request=async()=>new Response('[]');assert.deepEqual(await f.manager.check({automatic:true}),before);
 f.manager.request=async()=>new Response(JSON.stringify([{tag_name:'v0.3.0a3',draft:false,prerelease:true}]));await assert.rejects(f.manager.check({automatic:true}),e=>e.code==='DOWNGRADE_BLOCKED');
 assert.deepEqual(await f.manager.status(),before);assert.equal(await fs.readFile(path.join(f.directory,'app-updates/state.json'),'utf8'),saved);assert.deepEqual(f.events,[]);
});

test('automatic equal-target check preserves authenticated cache through signature-write failure without refetch',async t=>{
 const f=await fixture(t);await f.manager.check({channel:'alpha'});
 const directory=path.join(f.directory,'app-updates/manifests/0.3.0a4');
 const rawFile=path.join(directory,'release-manifest.json'),sigFile=path.join(directory,'release-manifest.sig');
 const before={raw:await fs.readFile(rawFile),signature:await fs.readFile(sigFile),status:await f.manager.status()};
 const revised=manifest();revised.impact.configuration=true;f.docs.set('0.3.0a4',signed(revised));
 const atomic=f.manager._atomic;f.manager._atomic=async function(file,bytes){
  if(file===sigFile)throw Object.assign(Error('signature storage full'),{code:'ENOSPC'});
  return atomic.call(this,file,bytes);
 };
 const requestsBefore=f.requests.length;
 const result=await f.manager.check({automatic:true});
 assert.deepEqual(f.requests.slice(requestsBefore),['https://api.github.com/repos/XianZe1226/DSWhale/releases?per_page=100']);
 assert.deepEqual(await fs.readFile(rawFile),before.raw);assert.deepEqual(await fs.readFile(sigFile),before.signature);
 assert.deepEqual(result,before.status);assert.equal(result.canDownload,true);assert.equal(result.error,null);
 const restarted=new updater.AppUpdater(f.config);assert.deepEqual(await restarted.status(),before.status);
 // Equal-version manual checks still refresh the official signed metadata.
 f.manager._atomic=atomic;const manualStart=f.requests.length;
 const manual=await f.manager.check({channel:'alpha'});assert.equal(f.requests.length-manualStart,3);assert.equal(manual.impact.configuration,true);assert.equal(manual.canDownload,true);
 assert.notDeepEqual(await fs.readFile(rawFile),before.raw);assert.notDeepEqual(await fs.readFile(sigFile),before.signature);
});

test('update downloads publish real aggregate byte progress without disclosing installer details',async t=>{
 const progress=[];
 const f=await fixture(t,{onProgress:p=>progress.push(p),download:async(_asset,file,options)=>{
  for(const ratio of [.25,.5,1])options.onProgress(ratio);
  await fs.writeFile(file,bytes);
 }});
 await f.manager.check({channel:'alpha'});await f.manager.download();
 const measured=progress.map(p=>p.progress).filter(p=>p?.stage==='downloading'&&Number.isFinite(p.ratio));
 assert.ok(measured.some(p=>p.ratio>0&&p.ratio<1));
 assert.ok(measured.every((p,i)=>p.totalBytes===bytes.length*2&&p.receivedBytes>=0&&p.receivedBytes<=p.totalBytes&&(i===0||p.ratio>=measured[i-1].ratio)));
 assert.equal((await f.manager.status()).progress.ratio,1);
 assert.ok(progress.some(p=>p.progress?.stage==='verifying'));
 for(const p of progress)assert.doesNotMatch(JSON.stringify(p),/PRIVATE_FIXTURE|https:|installer-fixture|\.dmg/);
});

for(const confirm of [false,true])test('one update action downloads then prompts before any service shutdown; confirm='+confirm,async t=>{
 const f=await fixture(t);await f.manager.check({channel:'alpha'});
 const {Workspace}=require('../lib/workspace.cjs');
 const workspace=new Workspace({appUpdater:f.manager,isInstalled:()=>true,isClosing:()=>false,
  confirmUpdate:async version=>{assert.equal(version,'0.3.0a4');f.events.push('confirm-overwrite');return confirm;},
  afterInstaller:async()=>f.events.push('quit-handoff')});
 const result=await workspace.perform('app-update-start');
 const prompt=f.events.indexOf('confirm-overwrite');assert.ok(prompt>=2);
 if(confirm)assert.deepEqual(f.events.slice(prompt),['confirm-overwrite','stop','snapshot','launch-update','quit-handoff']);
 else {assert.equal(result.canceled,true);assert.equal(result.appUpdate.canInstall,true);assert.equal(f.events.includes('stop'),false);assert.equal(f.events.includes('quit-handoff'),false);}
});

test('a canceled overwrite prompt reuses verified files on the next update click',async t=>{
 const f=await fixture(t);await f.manager.check({channel:'alpha'});let confirms=0;
 const {Workspace}=require('../lib/workspace.cjs');
 const workspace=new Workspace({appUpdater:f.manager,isInstalled:()=>true,isClosing:()=>false,confirmUpdate:async()=>++confirms>1,afterInstaller:async()=>{}});
 await workspace.perform('app-update-start');const count=f.events.filter(e=>e.startsWith('download:')).length;
 await workspace.perform('app-update-start');assert.equal(f.events.filter(e=>e.startsWith('download:')).length,count);
 assert.equal(f.events.filter(e=>e==='launch-update').length,1);
});

test('the single Update action repairs a damaged downloaded cache before asking to overwrite',async t=>{
 const f=await prepared(t);
 const target=path.join(f.directory,'app-updates/installers/0.3.0a4/DSWhale-0.3.0-alpha.4-macOS-arm64.dmg');
 await fs.writeFile(target,Buffer.alloc(bytes.length,120));
 const {Workspace}=require('../lib/workspace.cjs');let prompts=0;
 const workspace=new Workspace({appUpdater:f.manager,isInstalled:()=>true,isClosing:()=>false,confirmUpdate:async()=>{prompts++;return true;},afterInstaller:async()=>{}});
 await workspace.perform('app-update-start');
 assert.deepEqual(await fs.readFile(target),bytes);assert.equal(prompts,1);assert.equal(f.events.filter(e=>e==='launch-update').length,1);
});


test('real download retry announces discarded partial bytes before restarting progress',async t=>{
 const {downloadVerified}=require('../lib/runtime.cjs');const progress=[];let call=0;
 const f=await fixture(t,{onProgress:p=>progress.push(p.progress),download:async(asset,file,opts)=>{
  if(!asset.name.includes('alpha.4'))return fs.writeFile(file,bytes);
  return downloadVerified(asset,file,{...opts,fetch:async()=>{
   call++;const first=call===1;
   return {ok:true,status:200,headers:new Headers({'content-length':String(bytes.length)}),body:(async function*(){
    await new Promise(r=>setTimeout(r,110));yield bytes.subarray(0,first?8:2);
    if(first)throw Error('synthetic network interruption');
    await new Promise(r=>setTimeout(r,110));yield bytes.subarray(2);
   })()};
  }});
 }});
 await f.manager.check({channel:'alpha'});await f.manager.download();
 const restart=progress.findIndex(p=>p?.stage==='restarting');assert.ok(restart>=0);
 assert.equal(progress[restart].ratio,null);assert.equal(progress[restart].receivedBytes,bytes.length);
 const next=progress.slice(restart+1).find(p=>p.stage==='downloading');assert.equal(next.receivedBytes,bytes.length+2);
 assert.equal(progress.at(-1).ratio,1);
});


test('failed native handoff never announces that an installer was opened',async t=>{
 const progress=[];const f=await prepared(t,{onProgress:p=>progress.push(p.progress),launchInstaller:async()=>{throw Error('synthetic launch error');}});
 await assert.rejects(f.manager.install());
 assert.ok(progress.some(p=>p?.stage==='install-launched'));
 assert.ok(progress.every(p=>!p?.label.includes('已打开')));
});
