'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const preferences=(()=>{try{return require('../lib/preferences.cjs');}catch{return {};}})();
const defaults={tray:false,startAtLogin:false,resumeAfterWake:false};
async function fixture(t){const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-prefs-')));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
function loginApp(){let enabled=false;const calls=[];return {calls,get enabled(){return enabled;},setLoginItemSettings(value){calls.push(value);enabled=value.openAtLogin;},getLoginItemSettings(){return {openAtLogin:enabled};}};}

test('preferences default off and save only exact private boolean flags',async t=>{
  assert.equal(typeof preferences.Preferences,'function');const directory=await fixture(t),app=loginApp();
  const manager=new preferences.Preferences({userData:path.join(directory,'data'),app,platform:'darwin'});
  assert.deepEqual(await manager.read(),defaults);assert.equal(app.calls.length,0);
  for(const value of [{tray:true}, {...defaults,startAtLogin:'yes'}, {...defaults,secret:'PRIVATE'}])await assert.rejects(manager.save(value),error=>error.code==='PREF_INVALID'&&!error.message.includes('PRIVATE'));
  const wanted={tray:true,startAtLogin:false,resumeAfterWake:true};assert.deepEqual(await manager.save(wanted),wanted);
  assert.deepEqual(await new preferences.Preferences({userData:path.join(directory,'data'),app,platform:'darwin'}).read(),wanted);
  const file=path.join(directory,'data/desktop-preferences.json');assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),wanted);
  if(process.platform!=='win32')assert.equal((await fs.stat(file)).mode&0o777,0o600);
});

test('Windows login opens visibly unless tray is enabled and macOS uses current Electron API',async t=>{
  const directory=await fixture(t),app=loginApp();
  const manager=new preferences.Preferences({userData:path.join(directory,'win'),app,platform:'win32',execPath:'C:\\Program Files\\DSWhale\\DSWhale.exe'});
  await manager.save({...defaults,startAtLogin:true});assert.deepEqual(app.calls.at(-1).args,['--dswhale-startup']);assert.equal(app.calls.at(-1).openAtLogin,true);
  await manager.save({...defaults,tray:true,startAtLogin:true});assert.deepEqual(app.calls.at(-1).args,['--dswhale-startup','--hidden']);
  assert.equal(app.calls.at(-1).path,'C:\\Program Files\\DSWhale\\DSWhale.exe');
  const mac=loginApp();await new preferences.Preferences({userData:path.join(directory,'mac'),app:mac,platform:'darwin'}).save({...defaults,startAtLogin:true});
  assert.deepEqual(mac.calls.at(-1),{openAtLogin:true});
});

test('Linux writes only its marked user entry and safely quotes executable names',async t=>{
  const directory=await fixture(t),home=path.join(directory,'home');await fs.mkdir(home);
  const manager=new preferences.Preferences({userData:path.join(directory,'data'),platform:'linux',home,env:{},execPath:'/opt/DS Whale/%u"cash$\\tail'});
  await manager.save({...defaults,tray:true,startAtLogin:true});
  const file=path.join(home,'.config/autostart/dswhale.desktop'),body=await fs.readFile(file,'utf8');
  assert.match(body,/^X-DSWhale-Managed=true$/m);assert.match(body,/ --dswhale-startup --hidden$/m);
  assert.ok(body.includes('%%u'));assert.ok(body.includes('\\\\"'));assert.ok(body.includes('\\\\$'));assert.ok(body.includes('\\\\\\\\tail'));
  await manager.save(defaults);await assert.rejects(fs.access(file));
  await fs.writeFile(file,'[Desktop Entry]\nName=Foreign application\nExec=/foreign/app\n');
  await assert.rejects(manager.save({...defaults,startAtLogin:true}),error=>error.code==='PREF_FOREIGN');
  assert.match(await fs.readFile(file,'utf8'),/Foreign application/);assert.deepEqual(await manager.read(),defaults);
});

test('preferences refuse symlink entries and config paths without exposing paths',async t=>{
  const directory=await fixture(t),outside=path.join(directory,'outside');await fs.mkdir(outside);
  const home=path.join(directory,'home');await fs.mkdir(path.join(home,'.config'),{recursive:true});await fs.symlink(outside,path.join(home,'.config/autostart'));
  const manager=new preferences.Preferences({userData:path.join(directory,'data'),platform:'linux',home,env:{},execPath:'/opt/DSWhale'});
  await assert.rejects(manager.save({...defaults,startAtLogin:true}),error=>error.code==='PREF_PATH'&&!error.message.includes(directory));
  await fs.symlink(outside,path.join(directory,'linked-data'));
  const linked=new preferences.Preferences({userData:path.join(directory,'linked-data'),platform:'darwin',app:loginApp()});
  await assert.rejects(linked.save(defaults),error=>error.code==='PREF_PATH');assert.deepEqual(await fs.readdir(outside),[]);
});

test('failed OS startup changes and failed file replacement preserve prior preferences',async t=>{
  const directory=await fixture(t),app=loginApp(),manager=new preferences.Preferences({userData:directory,app,platform:'darwin'});
  await manager.save(defaults);
  const originalSet=app.setLoginItemSettings;
  app.setLoginItemSettings=value=>{originalSet(value);if(value.openAtLogin)throw new Error('PRIVATE OS path');};
  await assert.rejects(manager.save({...defaults,startAtLogin:true}),error=>error.code==='PREF_STARTUP'&&!error.message.includes('PRIVATE'));
  assert.equal(app.enabled,false);assert.deepEqual(await manager.read(),defaults);
  app.setLoginItemSettings=originalSet;
  const rename=fs.rename;fs.rename=async(from,to)=>{if(to===path.join(directory,'desktop-preferences.json'))throw new Error('PRIVATE file path');return rename(from,to);};
  try{await assert.rejects(manager.save({...defaults,startAtLogin:true}),error=>error.code==='PREF_SAVE'&&!error.message.includes('PRIVATE'));}
  finally{fs.rename=rename;}
  assert.equal(app.enabled,false);assert.deepEqual(await manager.read(),defaults);
});

test('silent OS registration failure is not reported as a saved preference',async t=>{
  const directory=await fixture(t),app={setLoginItemSettings(){},getLoginItemSettings(){return {openAtLogin:false};}};
  const manager=new preferences.Preferences({userData:directory,app,platform:'darwin'});
  await assert.rejects(manager.save({...defaults,startAtLogin:true}),error=>error.code==='PREF_STARTUP');assert.deepEqual(await manager.read(),defaults);
});

test('saving startup off disables an existing owned entry even when preference history is missing',async t=>{
  const directory=await fixture(t),app=loginApp();app.setLoginItemSettings({openAtLogin:true});
  const native=new preferences.Preferences({userData:path.join(directory,'native'),app,platform:'darwin'});
  assert.deepEqual(await native.read(),defaults);await native.save(defaults);assert.equal(app.enabled,false);
  const home=path.join(directory,'home'),entry=path.join(home,'.config/autostart/dswhale.desktop');await fs.mkdir(path.dirname(entry),{recursive:true});
  await fs.writeFile(entry,'[Desktop Entry]\nName=DSWhale\nExec=/opt/DSWhale\nX-DSWhale-Managed=true\n');
  const linux=new preferences.Preferences({userData:path.join(directory,'linux'),platform:'linux',home,env:{},execPath:'/opt/DSWhale'});
  await linux.save(defaults);await assert.rejects(fs.access(entry));
  await fs.writeFile(entry,'[Desktop Entry]\nName=Foreign\nExec=/other/application\n');await linux.save(defaults);assert.match(await fs.readFile(entry,'utf8'),/Foreign/);
});
