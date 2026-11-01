'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
function mainHarness(options) {
 const file=path.resolve(__dirname,'../main.cjs'),realRequire=createRequire(file),events=[];
 const electron={app:{setName(){},getVersion:()=> '0.3.0-alpha.5',requestSingleInstanceLock:()=>true,whenReady:()=>new Promise(()=>{}),on(){}},protocol:{registerSchemesAsPrivileged(){}},powerMonitor:{}};
 const context={updateScheduler:null,require:name=>name==='electron'?electron:realRequire(name),__dirname:path.dirname(file),process,console,Buffer,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(file,'utf8')+`;globalThis.hooks={perform,configure(value){appUpdater=value.updater;updateScheduler=value.scheduler;workspace=value.workspace;supervisor=value.supervisor;napcat=value.napcat;}};`,context);
 context.hooks.configure({updater:{},scheduler:{cancel:async()=>events.push('cancel-auto')},workspace:{perform:async(action,payload)=>{events.push([action,payload]);return {ok:true};}},supervisor:{stop:async()=>events.push('stop')},napcat:{stop:async()=>events.push('stop-qq')},...options});return {...context.hooks,events};
}
test('manual update mutations await automatic cancellation while ordinary stop remains available',async()=>{
 const h=mainHarness();await h.perform('stop');assert.deepEqual(h.events,['stop-qq','stop']);h.events.length=0;
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
