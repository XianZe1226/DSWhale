'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
let api;try{api=require('../lib/installer.cjs');}catch{}

test('Windows update arguments skip directory selection and pin the running application directory',()=>{
 assert.equal(typeof api?.windowsUpdateArgs,'function');
 for(const folder of ['C:\\Users\\Example\\AppData\\Local\\Programs\\DSWhale','D:\\应用 空格 & 保留\\DSWhale']){
  const args=api.windowsUpdateArgs(folder+'\\DSWhale.exe');
  assert.deepEqual(args,['--updated','/currentuser','/D='+folder]);
 }
 for(const exe of ['C:\\tools\\electron.exe','DSWhale.exe','\\\\server\\share\\DSWhale.exe','C:\\bad\npath\\DSWhale.exe'])assert.throws(()=>api.windowsUpdateArgs(exe),/安装|位置/);
});

test('installer handoff uses exact argument boundaries without a shell and resolves only after spawn',async()=>{
 assert.equal(typeof api?.launchWindowsUpdate,'function');let launch,unref=false;
 const child=new EventEmitter();child.unref=()=>{unref=true;};
 const promise=api.launchWindowsUpdate({file:'D:\\cache\\update.exe',exePath:'D:\\应用 空格 & 保留\\DSWhale\\DSWhale.exe',spawn:(file,args,options)=>{launch={file,args,options};return child;}});
 assert.equal(unref,false);child.emit('spawn');await promise;
 assert.equal(unref,true);assert.equal(launch.options.shell,false);assert.equal(launch.options.windowsVerbatimArguments,true);assert.equal(launch.options.detached,true);assert.equal(launch.options.stdio,'ignore');
 assert.equal(launch.args.at(-1),'/D=D:\\应用 空格 & 保留\\DSWhale');
});

test('failed or canceled installer launch never returns a successful handoff or private process error',async()=>{
 assert.equal(typeof api?.launchWindowsUpdate,'function');
 const controller=new AbortController();controller.abort();let spawns=0;
 await assert.rejects(api.launchWindowsUpdate({file:'D:\\cache\\update.exe',exePath:'D:\\DSWhale\\DSWhale.exe',signal:controller.signal,spawn:()=>{spawns++;}}),/取消/);assert.equal(spawns,0);
 const child=new EventEmitter();const pending=api.launchWindowsUpdate({file:'D:\\cache\\update.exe',exePath:'D:\\DSWhale\\DSWhale.exe',spawn:()=>child});
 child.emit('error',new Error('PRIVATE_PROCESS_ERROR'));
 await assert.rejects(pending,e=>!e.message.includes('PRIVATE_PROCESS_ERROR')&&/安装/.test(e.message));
});
