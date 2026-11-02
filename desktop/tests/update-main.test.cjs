'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
function mainHarness(options) {
 const file=path.resolve(__dirname,'../main.cjs'),realRequire=createRequire(file),events=[];
 const dialog=options?.dialog||{showOpenDialog:async()=>({canceled:true}),showMessageBox:async()=>({response:1})};
 const electron={app:{setName(){},getVersion:()=> '0.3.0-alpha.5',requestSingleInstanceLock:()=>true,whenReady:()=>new Promise(()=>{}),on(){}},protocol:{registerSchemesAsPrivileged(){}},powerMonitor:{},dialog};
 const context={updateScheduler:null,require:name=>name==='electron'?electron:realRequire(name),__dirname:path.dirname(file),process,console,Buffer,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(file,'utf8')+`;globalThis.hooks={perform,reportActionError,restore,configure(value){operations=value.operations;appUpdater=value.updater;updateScheduler=value.scheduler;workspace=value.workspace;supervisor=value.supervisor;napcat=value.napcat;}};`,context);
 context.hooks.configure({updater:{},scheduler:{cancel:async()=>events.push('cancel-auto')},workspace:{perform:async(action,payload)=>{events.push([action,payload]);return {ok:true};}},supervisor:{stop:async()=>events.push('stop')},napcat:{stop:async()=>events.push('stop-qq')},...options});return {...context.hooks,events};
}
test('manual update mutations await automatic cancellation while ordinary stop remains available',async()=>{
 const h=mainHarness();await h.perform('stop');assert.deepEqual(h.events,['stop']);h.events.length=0;
 for(const action of ['app-update-check','app-update-download','app-update-install','app-update-rollback']){
  await h.perform(action,{channel:'stable'});assert.equal(h.events[0],'cancel-auto');assert.equal(h.events[1][0],action);h.events.length=0;
 }
});
test('manual cancellation reserves the action fence until completion',async()=>{
 let release;const h=mainHarness({scheduler:{cancel:()=>new Promise(resolve=>{release=resolve;})}});
 const manual=h.perform('app-update-check',{channel:'stable'});await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');await assert.rejects(h.perform('stop'),/当前操作/);release();await manual;
 assert.equal(h.events[0][0],'app-update-check');await h.perform('stop');
});

test('manual updater results replace the automatic snapshot used by later state publications',async()=>{
 const appUpdate={phase:'downloaded',canInstall:true};const h=mainHarness({updater:{status:async()=>appUpdate},workspace:{perform:async()=>({appUpdate})}});
 await h.perform('app-update-download');assert.deepEqual((await h.perform('home')).appUpdate,appUpdate);
});

test('action failures stay user-safe before the operations log exists',async()=>{
 const h=mainHarness();
 const message=await h.reportActionError(new TypeError('boom'),'stop');
 assert.match(message,/^\[APP-001\] 操作未完成，请重新检查状态或导出诊断$/);
 assert.deepEqual(h.events,[]);
});

test('backup import requires an explicit trusted-source confirmation',async()=>{
 const calls=[];
 const h=mainHarness({dialog:{showOpenDialog:async()=>({canceled:false,filePaths:['/tmp/backup.zip']}),showMessageBox:async()=>{calls.push('confirm');return {response:1};}}});
 const result=await h.restore();
 assert.equal(result.canceled,true);
 assert.deepEqual(calls,['confirm']);
});


test('action failures stay user-safe when the operations log write fails',async()=>{
 const rows=[];
 const h=mainHarness({operations:{events:{write:async row=>{rows.push({...row});throw Error('private log failure');}}}});
 const message=await h.reportActionError(new TypeError('private original failure'),'unsupported-action');
 assert.equal(message,'[APP-001] 操作未完成，请重新检查状态或导出诊断');
 assert.deepEqual(rows,[{component:'app',action:'check',code:'APP-001'}]);
 assert.deepEqual(h.events,[]);
});
