'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let runtime;
try { runtime = require('../lib/runtime.cjs'); } catch { runtime = {}; }

test('desktop accepts only supported native architectures and minimum OS', () => {
  assert.equal(typeof runtime.platformInfo, 'function');
  assert.equal(runtime.platformInfo('darwin', 'arm64', '22.0.0').supported, true);
  assert.equal(runtime.platformInfo('darwin', 'x64', '24.0.0').supported, false);
  assert.equal(runtime.platformInfo('darwin', 'arm64', '21.0.0').supported, false);
  assert.equal(runtime.platformInfo('win32', 'x64', '10.0.19045').supported, true);
  assert.equal(runtime.platformInfo('win32', 'x64', '10.0.19044').supported, false);
  assert.equal(runtime.platformInfo('linux', 'x64', '6.8', {ID:'ubuntu', VERSION_ID:'24.04'}).supported, true);
  assert.equal(runtime.platformInfo('linux', 'arm64', '6.8', {ID:'ubuntu', VERSION_ID:'24.04'}).supported, false);
  assert.equal(runtime.platformInfo('linux', 'x64', '6.8', {ID:'debian', VERSION_ID:'12'}).supported, false);
});

test('compatible runtimes reject wrong majors, prereleases and malformed output', () => {
  assert.equal(typeof runtime.compatibleVersion, 'function');
  for (const [tool, value, wanted] of [
    ['uv','uv 0.13.5 (46776a95d 2026-10-21 aarch64-apple-darwin)',true],
    ['uv','uv 0.13.4',false], ['uv','uv 0.13.5rc1',false],
    ['python','Python 3.12.15',true], ['python','Python 3.13.0',false],
    ['python','Python 3.12.0rc1',false], ['node','v22.23.4',true],
    ['node','v22.0.0',false], ['node','v22.23.3',false], ['node','v22.23.5',true],
    ['node','v22.24.0',true], ['node','v24.0.0',false], ['ffmpeg','ffmpeg version 6.1.1 Copyright',true],
    ['ffprobe','ffprobe version 9.0.2-static Copyright',true],
    ['ffmpeg','ffmpeg version N-12345',false], ['ffprobe','ffprobe version 5.1',false],
  ]) assert.equal(runtime.compatibleVersion(tool,value),wanted, `${tool} ${value}`);
});

test('verified downloads enforce HTTPS, checksum and streamed size limits', async () => {
  assert.equal(typeof runtime.downloadVerified, 'function');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-download-'));
  const file=path.join(dir,'asset');
  const fake = async () => new Response(Buffer.from('abc'));
  try {
    await assert.rejects(runtime.downloadVerified({url:'http://bad.test/x',sha256:'0'.repeat(64)},file,{fetch:fake}), /HTTPS/);
    await assert.rejects(runtime.downloadVerified({url:'https://ok.test/x',sha256:'0'.repeat(64)},file,{fetch:fake}), /校验|checksum/);
    await assert.rejects(runtime.downloadVerified({url:'https://ok.test/x',sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'},file,{fetch:fake,maxBytes:2}), /大小|size/);
    await assert.rejects(fs.access(file));
    await runtime.downloadVerified({url:'https://ok.test/x',sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'},file,{fetch:fake});
    assert.equal(await fs.readFile(file,'utf8'),'abc');
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('Windows UV extraction passes Unicode paths as data instead of tar arguments', async () => {
  assert.equal(typeof runtime.extractUVArchive, 'function');
  const archive = "C:\\Users\\synthetic\\鱼 '$ env\\uv.zip";
  const staged = "C:\\Users\\synthetic\\鱼 '$ env\\uv.exe";
  const calls = [];
  await runtime.extractUVArchive(archive, staged, 'uv.exe', { platform: 'win32', runner: async (...args) => { calls.push(args); return Buffer.alloc(0); } });
  assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.match(command, /powershell\.exe$/i);
  assert.equal(options.env.DSWHALE_UV_ARCHIVE, archive);
  assert.equal(options.env.DSWHALE_UV_OUTPUT, staged);
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /System\.IO\.Compression\.ZipFile/);
  assert.ok(!script.includes(archive));
  assert.ok(!args.includes(archive));
});

test('installer locks are exclusive and released without exposing subprocess output', async () => {
  assert.equal(typeof runtime.withInstallLock, 'function');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-lock-'));
  let release;
  const blocked=new Promise(resolve=>{release=resolve;});
  try {
    const first=runtime.withInstallLock(dir,async()=>{await blocked; throw new Error('failure');});
    await new Promise(resolve=>setTimeout(resolve,30));
    await assert.rejects(runtime.withInstallLock(dir,async()=>{}),/正在|already/);
    release();
    await assert.rejects(first,/failure/);
    await runtime.withInstallLock(dir,async()=>fs.writeFile(path.join(dir,'success'),'yes'));
    assert.equal(await fs.readFile(path.join(dir,'success'),'utf8'),'yes');
  } finally {release(); await fs.rm(dir,{recursive:true,force:true});}
});

test('environment uses external runtime data and rejects malformed saved tools', async () => {
  assert.equal(typeof runtime.RuntimeManager,'function');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-env-'));
  try {
    await fs.writeFile(path.join(dir,'tool-env.json'),JSON.stringify({node:'/private/tools/node',ffmpeg:'/private/media/ffmpeg',ffprobe:'/private/media/ffprobe',other:'SECRET'}));
    const manager=new runtime.RuntimeManager({source:'/installed/backend',runtime:dir});
    const env=await manager.environment();
    assert.equal(env.ASTRBOT_ROOT,path.join(dir,'astrbot'));
    assert.equal(env.DSWHALE_RUNTIME_DIR,dir);
    assert.equal(env.DSWHALE_NODE,'/private/tools/node');
    assert.equal(env.PYTHONUTF8,'1');
    assert.equal(env.PATH.split(path.delimiter)[0],'/private/tools');
    assert.ok(!env.PATH.includes('SECRET'));
    await fs.writeFile(path.join(dir,'tool-env.json'),'{broken');
    await assert.rejects(manager.environment(),/环境|environment/);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('bounded subprocess cancellation kills owned children and suppresses private stderr', async () => {
  assert.equal(typeof runtime.runBounded,'function');
  const controller=new AbortController();
  const running=runtime.runBounded(process.execPath,['-e','console.error("PRIVATE_FIXTURE"); setTimeout(()=>{}, 30000)'],{signal:controller.signal});
  setTimeout(()=>controller.abort(),30);
  await assert.rejects(running,error=>error.message==='安装已取消'&&!error.message.includes('PRIVATE_FIXTURE'));
});

test('install sanitizes file system errors before emitting progress', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-error-'));
  const events=[];
  try {
    const file=path.join(dir,'private-fixture');
    await fs.writeFile(file,'not a directory');
    const manager=new runtime.RuntimeManager({source:dir,runtime:file,onProgress:event=>events.push(event)});
    await assert.rejects(manager.install(),error=>!error.message.includes('private-fixture')&&!error.message.includes(dir));
    assert.ok(!JSON.stringify(events).includes(dir));
  }finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('same-manager install joins one operation and validates backend without launching services', {skip:process.platform==='win32'}, async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-install-'));
  const source=path.join(dir,'installed-source'), data=path.join(dir,'runtime'), tools=path.join(dir,'fixture-tools');
  const oldPath=process.env.PATH;
  const events=[];
  try {
    await fs.mkdir(source);await fs.mkdir(tools);await fs.mkdir(data);
    await fs.writeFile(path.join(source,'pyproject.toml'),'[project]\nversion = "0.3.0a1"\n');
    const writeExecutable=async(name,text)=>{const file=path.join(tools,name);await fs.writeFile(file,`#!/bin/sh\n${text}\n`,{mode:0o755});return file;};
    const python=await writeExecutable('python3.12','if [ "$1" = "--version" ]; then printf "Python 3.12.15\\n"; else printf \'{"dswhale":"0.3.0a1","astrbot":"4.29.3"}\\n\'; fi');
    const node=await writeExecutable('node','printf "v22.23.4\\n"');
    const ffmpeg=await writeExecutable('ffmpeg','printf "ffmpeg version 9.0.2 Copyright\\n"');
    const ffprobe=await writeExecutable('ffprobe','printf "ffprobe version 9.0.2 Copyright\\n"');
    const uv=await writeExecutable('uv',String.raw`
[ "$1" = "run" ] || exit 1
[ "$DSWHALE_DESKTOP" = "1" ] || exit 2
case "$*" in *astrbot.cli*|*login*) exit 3 ;; esac
printf 'called\n' >> "$DSWHALE_RUNTIME_DIR/calls"
mkdir -p "$DSWHALE_RUNTIME_DIR/venv/bin" "$DSWHALE_RUNTIME_DIR/astrbot/data/plugins/astrbot_plugin_livingmemory" "$DSWHALE_RUNTIME_DIR/astrbot/data/plugins/astrbot_plugin_dswhale"
cp "${python}" "$DSWHALE_RUNTIME_DIR/venv/bin/python"
printf '{}' > "$DSWHALE_RUNTIME_DIR/astrbot/data/cmd_config.json"
printf '' > "$DSWHALE_RUNTIME_DIR/astrbot/data/plugins/astrbot_plugin_livingmemory/requirements.txt"
printf '' > "$DSWHALE_RUNTIME_DIR/astrbot/data/plugins/astrbot_plugin_livingmemory/main.py"
printf '' > "$DSWHALE_RUNTIME_DIR/astrbot/data/plugins/astrbot_plugin_dswhale/main.py"
printf '{"version":"0.3.0a1","format":1}' > "$DSWHALE_RUNTIME_DIR/desktop-install.json"
printf 'DSWHALE_PROGRESS {"step":"dependencies","progress":0.28}\n'
`);
    await fs.writeFile(path.join(data,'tool-env.json'),JSON.stringify({node,ffmpeg,ffprobe}));
    process.env.PATH=tools+path.delimiter+oldPath;
    // Replace only external uv acquisition; the subprocess, environment, completion check and lock are real.
    const manager=new runtime.RuntimeManager({source,runtime:data,onProgress:event=>events.push(event)});
    manager._uv=async()=>uv;
    manager._platform=async()=>({id:'fixture',label:'Fixture',supported:true,detail:''});
    assert.equal((await manager.inspect()).installed,false);
    const first=manager.install(), second=manager.install();
    assert.equal(first,second);
    assert.equal((await first).installed,true);
    assert.equal((await fs.readFile(path.join(data,'calls'),'utf8')).trim(),'called');
    assert.ok(events.some(event=>event.step==='安装应用依赖'&&event.progress===0.28));
    assert.equal(events.at(-1).phase,'ready');
    assert.equal((await manager.inspect()).installed,true);
    await fs.rm(path.join(data,'astrbot/data/plugins/astrbot_plugin_dswhale/main.py'));
    assert.equal((await manager.inspect()).installed,false);
  }finally {process.env.PATH=oldPath;await fs.rm(dir,{recursive:true,force:true});}
});

test('media probe exposes only the clean version identifier', {skip:process.platform==='win32'}, async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-probe-'));
  try {
    const file=path.join(dir,'ffmpeg');
    await fs.writeFile(file,'#!/bin/sh\nprintf "ffmpeg version 9.0.2-essentials_build Copyright (c) 2000-2026 developers\\nconfiguration: flags\\n"\n',{mode:0o755});
    const manager=new runtime.RuntimeManager({source:dir,runtime:path.join(dir,'runtime')});
    const result=await manager._version(file,'ffmpeg',process.env);
    assert.equal(result.version,'9.0.2-essentials_build');
    assert.equal(result.ok,true);
  }finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('inspect preserves incompatible Python discovery while installer selects compatible only', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-old-python-'));
  try {
    const manager=new runtime.RuntimeManager({source:dir,runtime:path.join(dir,'runtime')});
    manager._platform=async()=>({id:'fixture',label:'Fixture',supported:true,detail:''});
    manager._version=async(command,tool)=>{
      if(tool==='python')return command==='python3'?{version:'Python 3.11.10',ok:false}:null;
      if(tool==='node')return {version:'v24.0.0',ok:false};
      return {version:'9.0.2',ok:true};
    };
    const result=await manager.inspect();
    const python=result.components.find(item=>item.id==='python');
    assert.equal(python.version,'Python 3.11.10');
    assert.ok(['outdated','incompatible'].includes(python.status));
    assert.match(python.detail,/专用 Python 3\.12/);
    assert.equal(result.components.find(item=>item.id==='node').status,'incompatible');
    assert.equal(await manager._pythonChoice({}),null);
  }finally {await fs.rm(dir,{recursive:true,force:true});}
});


test('GUI environment detects trusted platform tool directories with an empty PATH', {skip:!['darwin','win32'].includes(process.platform)}, async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-gui-path-'));
  const previous=process.env.PATH;
  try {
    process.env.PATH='';
    const managed=path.join(dir,'managed-tools');
    await fs.writeFile(path.join(dir,'tool-env.json'),JSON.stringify({node:path.join(managed,'node')}));
    const manager=new runtime.RuntimeManager({source:dir,runtime:dir});
    const directories=(await manager.environment()).PATH.split(path.delimiter);
    assert.equal(directories[0],managed);
    if(process.platform==='darwin') {
      assert.ok(directories.includes('/opt/homebrew/bin'));
      assert.ok(directories.includes('/usr/local/bin'));
    }else if(process.env.LOCALAPPDATA)assert.ok(directories.includes(path.join(process.env.LOCALAPPDATA,'Microsoft','WinGet','Links')));
    assert.ok(!directories.includes(''));
    process.env.PATH=directories.join(path.delimiter);
    const repeated=(await manager.environment()).PATH.split(path.delimiter);
    assert.equal(repeated.length,new Set(repeated).size);
  }finally {if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;await fs.rm(dir,{recursive:true,force:true});}
});
