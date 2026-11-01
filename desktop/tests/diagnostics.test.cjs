'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const diagnostics=(()=>{try{return require('../lib/diagnostics.cjs');}catch{return {};}})();
const execute=promisify(execFile),secret='PRIVATE-KEY-PERSONA-CHAT-123456789';
async function fixture(t){const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-diagnostic-')));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
async function unzip(file){const script="import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n:z.read(n).decode('utf8') for n in z.namelist()}))";return JSON.parse((await execute(process.env.PYTHON||'python3',['-c',script,file])).stdout);}

test('first-install diagnostics work without Python and include only four whitelisted documents',async t=>{
  assert.equal(typeof diagnostics.writeDiagnostics,'function');const directory=await fixture(t),runtime=path.join(directory,'runtime');await fs.mkdir(runtime);
  await fs.writeFile(path.join(runtime,'PRIVATE-config.json'),secret);await fs.mkdir(path.join(runtime,'logs'));
  await fs.writeFile(path.join(runtime,'logs/events.jsonl'),[
    {at:'2026-11-01T10:00:00.000Z',component:'runtime',action:'install',code:'APP-001',message:secret,path:directory},
    {at:'2026-11-01T10:00:00.000Z',component:'runtime',action:'install',code:'PRIVATE-001',message:secret},
    {at:secret,component:'runtime',action:'install',code:'APP-001'},
    {at:'2026-11-01T10:00:00.000Z',component:secret,action:'health',code:'CFG-001'},
  ].map(x=>JSON.stringify(x)).join('\n'));
  const input={runtime,health:{checks:[{id:'config',ok:false,required:true,code:'CFG-001',name:secret,detail:secret},{id:secret,ok:true,required:true,code:'APP-000'}],summary:{requiredFailures:1,warnings:0,secret}},versionMatrix:{expected:{dswhale:'0.3.0a3',python:'3.12',node:'22.23.4',channel:'alpha',secret},actual:{dswhale:secret,ffmpeg:'9.0.2-PRIVATE',python:'3.12.15',node:'22.23.4',channel:secret},secret},appUpdate:{phase:'available',currentVersion:'0.3.0a3',targetVersion:'0.3.0-alpha.4',previousVersion:secret,detail:secret}};
  const output=path.join(directory,'report.zip');assert.deepEqual(await diagnostics.writeDiagnostics(input,output),{saved:true});
  const files=await unzip(output);assert.deepEqual(Object.keys(files).sort(),['README.txt','events.json','health.json','versions.json']);
  assert.deepEqual([...diagnostics.DIAGNOSTIC_FILES].sort(),Object.keys(files).sort());
  const combined=Object.values(files).join('\n');assert.ok(!combined.includes(secret));assert.ok(!combined.includes(directory));assert.ok(!combined.includes('PRIVATE'));assert.ok(!combined.includes('123456789'));
  assert.deepEqual(JSON.parse(files['health.json']).checks,[{id:'config',ok:false,required:true,code:'CFG-001'}]);assert.equal(JSON.parse(files['events.json']).length,1);
  const versions=JSON.parse(files['versions.json']);assert.equal(versions.expected.dswhale,'0.3.0a3');assert.equal(versions.actual.python,'3.12.15');assert.equal(versions.appUpdate.phase,'available');
  if(process.platform!=='win32')assert.equal((await fs.stat(output)).mode&0o777,0o600);
});

test('diagnostics refuse existing outputs and every symlink path without overwriting data',async t=>{
  const directory=await fixture(t),output=path.join(directory,'existing.zip');await fs.writeFile(output,'keep');
  await assert.rejects(diagnostics.writeDiagnostics({runtime:directory},output),error=>error.code==='DIAG_OUTPUT'&&!error.message.includes(directory));assert.equal(await fs.readFile(output,'utf8'),'keep');
  const target=path.join(directory,'target');await fs.mkdir(target);await fs.symlink(target,path.join(directory,'link'));
  await assert.rejects(diagnostics.writeDiagnostics({runtime:directory},path.join(directory,'link/report.zip')),error=>error.code==='DIAG_OUTPUT');assert.deepEqual(await fs.readdir(target),[]);
  await fs.symlink(output,path.join(directory,'output-link.zip'));await assert.rejects(diagnostics.writeDiagnostics({runtime:directory},path.join(directory,'output-link.zip')),error=>error.code==='DIAG_OUTPUT');
});

test('event export caps at the last 100 lines and ignores oversized or linked logs',async t=>{
  const directory=await fixture(t),runtime=path.join(directory,'runtime');await fs.mkdir(path.join(runtime,'logs'),{recursive:true});const events=path.join(runtime,'logs/events.jsonl');
  const event={at:'2026-11-01T10:00:00.000Z',component:'app',action:'check',code:'APP-000'};await fs.writeFile(events,Array.from({length:120},()=>JSON.stringify(event)).join('\n'));
  await diagnostics.writeDiagnostics({runtime},path.join(directory,'bounded.zip'));assert.equal(JSON.parse((await unzip(path.join(directory,'bounded.zip')))['events.json']).length,100);
  await fs.writeFile(events,'x'.repeat(1024*1024+1));await diagnostics.writeDiagnostics({runtime},path.join(directory,'large.zip'));assert.deepEqual(JSON.parse((await unzip(path.join(directory,'large.zip')))['events.json']),[]);
  await fs.rm(events);await fs.symlink(path.join(directory,'PRIVATE.log'),events);await fs.writeFile(path.join(directory,'PRIVATE.log'),secret);
  await diagnostics.writeDiagnostics({runtime},path.join(directory,'linked.zip'));assert.deepEqual(JSON.parse((await unzip(path.join(directory,'linked.zip')))['events.json']),[]);
});
