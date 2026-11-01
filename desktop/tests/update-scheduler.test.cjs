'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
let UpdateScheduler;
try {({UpdateScheduler}=require('../lib/update-scheduler.cjs'));}catch{}
function clock() {
  let now=0,id=0;const tasks=new Map();let unrefs=0;
  return {now:()=>now,setTimeout:(fn,delay)=>{const key=++id;tasks.set(key,{fn,at:now+delay});return {key,unref(){unrefs++;}};},clearTimeout:timer=>tasks.delete(timer?.key),
    async tick(ms){const end=now+ms;for(;;){const due=[...tasks].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;tasks.delete(due[0]);due[1].fn();await new Promise(resolve=>setImmediate(resolve));}now=end;},jump:ms=>{now+=ms;},pending:()=>tasks.size,unrefs:()=>unrefs};
}
function setup(options={}) {assert.equal(typeof UpdateScheduler,'function','automatic scheduler exists');const time=clock(),results=[];let checks=0;
 const scheduler=new UpdateScheduler({...time,check:async()=>{checks++;return {phase:'up-to-date'};},onResult:value=>results.push(value),...options});return {time,scheduler,results,checks:()=>checks};}

test('starts after 30 seconds, repeats after six hours, unrefs and stops timers',async()=>{
 const f=setup();f.scheduler.start();f.scheduler.start();await f.time.tick(29999);assert.equal(f.checks(),0);await f.time.tick(1);assert.equal(f.checks(),1);await f.time.tick(6*3600000-1);assert.equal(f.checks(),1);await f.time.tick(1);assert.equal(f.checks(),2);assert.equal(f.results.length,1);assert.ok(f.time.unrefs()>=3);f.scheduler.stop();await f.time.tick(12*3600000);assert.equal(f.checks(),2);assert.equal(f.time.pending(),0);
});
test('busy work defers for a minute and resume avoids a burst of overdue checks',async()=>{
 let busy=true;const f=setup({shouldRun:()=>!busy});f.scheduler.start();await f.time.tick(30000);assert.equal(f.checks(),0);busy=false;await f.time.tick(59999);assert.equal(f.checks(),0);await f.time.tick(1);assert.equal(f.checks(),1);f.scheduler.resume();f.scheduler.resume();await f.time.tick(6*3600000);assert.equal(f.checks(),2);
});
test('deduplicates a slow check and cancellation suppresses late results',async()=>{
 let finish,cancelled=0;const f=setup({check:()=>new Promise(resolve=>{finish=resolve;}),cancelCheck:async()=>{cancelled++;finish({phase:'available',targetVersion:'0.3.0a6'});}});f.scheduler.start();await f.time.tick(30000);const a=f.scheduler.runNow(),b=f.scheduler.runNow();assert.equal(a,b);await f.scheduler.cancel();assert.equal(cancelled,1);assert.equal(f.results.length,0);assert.equal(f.time.pending(),1);f.scheduler.stop();
});
test('rejections are quiet and do not retry at network-error speed',async()=>{
 let checks=0;const f=setup({check:async()=>{checks++;throw Error('network failed');}});f.scheduler.start();await f.time.tick(30000);assert.equal(checks,1);assert.deepEqual(f.results,[]);await f.time.tick(59999);assert.equal(checks,1);await f.time.tick(6*3600000);assert.equal(checks,2);f.scheduler.stop();
});
test('an updater skip retries later and stopping an in-flight check suppresses publication',async()=>{
 let checks=0,finish;const f=setup({check:async()=>{checks++;return checks===1?null:new Promise(resolve=>{finish=resolve;});}});f.scheduler.start();await f.time.tick(30000);await f.time.tick(60000);assert.equal(checks,2);f.scheduler.stop();finish({phase:'available'});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.results,[]);assert.equal(f.time.pending(),0);
});

test('wake schedules one delayed overdue check even after repeated resume events',async()=>{
 const f=setup();f.scheduler.start();await f.time.tick(30000);f.time.jump(12*3600000);f.scheduler.resume();f.scheduler.resume();await f.time.tick(29999);assert.equal(f.checks(),1);await f.time.tick(1);assert.equal(f.checks(),2);assert.equal(f.time.pending(),1);f.scheduler.stop();
});

test('a concurrent updater operation defers the background check for one minute',async()=>{
 let checks=0;const f=setup({check:async()=>{checks++;if(checks===1)throw Object.assign(Error('busy'),{code:'UPDATER_BUSY'});return {phase:'up-to-date'};}});f.scheduler.start();await f.time.tick(30000);assert.equal(checks,1);await f.time.tick(60000);assert.equal(checks,2);assert.equal(f.results.length,1);f.scheduler.stop();
});
