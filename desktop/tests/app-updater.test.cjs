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
