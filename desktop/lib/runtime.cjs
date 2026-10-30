'use strict';
// Pure Node module: installing never starts AstrBot or touches QQ.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const assets = require('./tool-assets.json');
class SetupError extends Error {}

function platformInfo(system = process.platform, arch = process.arch, release = os.release(), distro = {}) {
  let supported = false, label = system;
  if (system === 'darwin') { label = 'macOS · Apple Silicon'; supported = arch === 'arm64' && Number(release.split('.')[0]) >= 22; }
  if (system === 'win32') { label = 'Windows · 64 位'; supported = arch === 'x64' && /^10\.0\./.test(release) && Number(release.split('.')[2]) >= 19045; }
  if (system === 'linux') { label = 'Ubuntu · 64 位'; supported = arch === 'x64' && distro.ID === 'ubuntu' && ['22.04','24.04'].includes(distro.VERSION_ID); }
  return {id:`${system}-${arch}`,label,supported,detail:supported ? '系统满足桌面版要求' : '支持 Windows 10 22H2+/11 x64、macOS 13+ Apple Silicon、Ubuntu 22.04/24.04 x64'};
}
function compatibleVersion(tool, output) {
  if (typeof output !== 'string') return false;
  if (tool === 'uv') return new RegExp(`^uv ${assets.uvVersion.replaceAll('.', '\\.')}($| \\([^\\n]*\\)$)`).test(output.trim());
  if (tool === 'python') return /^Python 3\.12\.\d+\s*$/.test(output.trim());
  if (tool === 'node') {
    const match=output.trim().match(/^v22\.(\d+)\.(\d+)$/);
    return Boolean(match&&(Number(match[1])>23||Number(match[1])===23&&Number(match[2])>=4));
  }
  const match = output.match(new RegExp(`^${tool} version (\\d+)\\.(\\d+)(?:\\.\\d+)?(?:[-\\s]|$)`));
  return Boolean(match && Number(match[1]) >= 6);
}
async function downloadVerified(asset, destination, {fetch: request = globalThis.fetch, maxBytes = 100 * 1024**2, signal, onProgress} = {}) {
  if (new URL(asset.url).protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new SetupError('下载必须使用 HTTPS 和 SHA256 校验');
  const partial = `${destination}.part`;
  const timeout = AbortSignal.timeout(180000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await request(asset.url, {signal:combined,redirect:'follow',headers:{'User-Agent':'DSWhale-Desktop'}});
    if (!response.ok || (response.url && new URL(response.url).protocol !== 'https:')) throw new SetupError('下载失败，请检查网络后重试');
    const size = Number(response.headers.get('content-length'));
    if (size > maxBytes) throw new SetupError('下载大小超过限制');
    const handle = await fs.open(partial,'w');
    let count = 0;
    const digest = crypto.createHash('sha256');
    try {
      for await (const chunk of response.body) {
        combined.throwIfAborted();
        count += chunk.length;
        if (count > maxBytes) throw new SetupError('下载大小超过限制');
        digest.update(chunk);
        await handle.write(chunk);
        onProgress?.(size > 0 ? Math.min(count/size,1) : null);
      }
    } finally {await handle.close();}
    if (digest.digest('hex') !== asset.sha256) throw new SetupError('下载校验失败，请重试');
    await fs.rename(partial,destination);
  } finally {await fs.rm(partial,{force:true});}
}
async function withInstallLock(directory, operation) {
  await fs.mkdir(directory,{recursive:true});
  const file = path.join(directory,'.desktop-install.lock');
  let handle;
  try { handle = await fs.open(file,'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale-owner recovery so two launchers cannot remove a new owner's lock.
    let recovery;
    try {recovery=await fs.open(`${file}.recover`,'wx');}
    catch {throw new SetupError('另一个安装正在准备，请稍后重试');}
    try {
      let owner;
      try {owner=JSON.parse(await fs.readFile(file,'utf8'));}
      catch {throw new SetupError('另一个安装正在准备，请稍后重试');}
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new SetupError('安装锁异常，请重新打开应用');
      try {process.kill(owner.pid,0); throw new SetupError('另一个安装正在进行，请稍后重试');}
      catch (error) {if(error.code !== 'ESRCH') throw new SetupError('另一个安装正在进行，请稍后重试');}
      await fs.rm(file,{force:true});
      return withInstallLock(directory,operation);
    } finally {await recovery.close();await fs.rm(`${file}.recover`,{force:true});}
  }
  try {await handle.writeFile(JSON.stringify({pid:process.pid})); return await operation();}
  finally {await handle.close(); await fs.rm(file,{force:true});}
}
function runBounded(command,args,{env=process.env,cwd,timeout=15000,maxBytes=1024*1024,signal,onLine} = {}) {
  return new Promise((resolve,reject)=>{
    const child = spawn(command,args,{env,cwd,windowsHide:true,detached:process.platform !== 'win32',stdio:['ignore','pipe','pipe']});
    let bytes=0, output=[], lines='', failed;
    let timer;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer=spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});
        killer.on('error',()=>child.kill());
      } else {try {process.kill(-child.pid,'SIGKILL');} catch {child.kill('SIGKILL');}}
    };
    const abort = () => {failed=new SetupError('安装已取消'); stop();};
    timer=setTimeout(()=>{failed=new SetupError('操作超时，请检查网络后重试');stop();},timeout);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;
      if (bytes>maxBytes) {failed=new SetupError('安装输出超过限制');stop();return;}
      output.push(chunk);
      if(onLine) {lines+=chunk.toString('utf8'); let index; while((index=lines.indexOf('\n'))>=0) {onLine(lines.slice(0,index));lines=lines.slice(index+1);} }
    });
    // Drain stderr, but never pass dependency logs/secrets to the renderer.
    child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){failed=new SetupError('安装输出超过限制');stop();}});
    child.on('error',()=>{failed=new SetupError('所需程序无法运行，请重新准备环境');});
    child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(failed)reject(failed);else if(code!==0)reject(new SetupError('环境准备失败，请检查网络或关闭运行中的服务后重试'));else resolve(Buffer.concat(output));});
  });
}
async function readJSON(file, fallback) {
  try {return JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error) {if(error.code==='ENOENT')return fallback;throw new SetupError('环境记录损坏，请重新准备环境');}
}
class RuntimeManager {
  constructor({source,runtime,onProgress=()=>{}}) {
    this.source=path.resolve(source);this.runtime=path.resolve(runtime);this.onProgress=onProgress;
    this.operation=null;this.controller=null;
  }
  get host(){return path.join(this.runtime,'astrbot');}
  get python(){return path.join(this.runtime,'venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');}
  async environment() {
    const saved=await readJSON(path.join(this.runtime,'tool-env.json'),{});
    const tools={};
    for(const key of ['node','ffmpeg','ffprobe']) {
      if (saved[key] !== undefined) {
        if(typeof saved[key]!=='string'||!path.isAbsolute(saved[key])||saved[key].includes('\0'))throw new SetupError('环境记录损坏，请重新准备环境');
        tools[key]=saved[key];
      }
    }
    const common=process.platform==='darwin'?['/opt/homebrew/bin','/usr/local/bin']:process.platform==='win32'&&process.env.LOCALAPPDATA?[path.join(process.env.LOCALAPPDATA,'Microsoft','WinGet','Links')]:[];
    const directories=[...Object.values(tools).map(value=>path.dirname(value)),...common,...(process.env.PATH||'').split(path.delimiter)].filter(Boolean);
    return {...process.env,PYTHONUTF8:'1',DSWHALE_RUNTIME_DIR:this.runtime,ASTRBOT_ROOT:this.host,
      ...(tools.node?{DSWHALE_NODE:tools.node}:{}),
      PATH:[...new Set(directories)].join(path.delimiter)};
  }
  async _platform() {
    let distro={};
    if(process.platform==='linux') {
      try {for(const line of (await fs.readFile('/etc/os-release','utf8')).split('\n')) {const match=line.match(/^(ID|VERSION_ID)=["']?([^"'\n]+)["']?$/);if(match)distro[match[1]]=match[2];}}catch{}
    }
    return platformInfo(process.platform,process.arch,os.release(),distro);
  }
  async _version(command,tool,env) {
    try {
      const output=(await runBounded(command,[tool==='ffmpeg'||tool==='ffprobe'?'-version':'--version'],{env})).toString('utf8');
      const media=tool==='ffmpeg'||tool==='ffprobe';
      const version=media?output.match(new RegExp(`^${tool} version ([^\\s]+)`))?.[1]||'未知版本':output.trim().split('\n')[0];
      return {version:version.slice(0,120),ok:compatibleVersion(tool,output)};
    }catch{return null;}
  }
  async _pythonChoice(env,{includeIncompatible=false}={}) {
    let incompatible=null;
    for(const command of [this.python,'python3.12','python3','python']) {
      const version=await this._version(command,'python',env);
      if(version?.ok)return {command,...version};
      if(version&&!incompatible)incompatible={command,...version};
    }
    return includeIncompatible?incompatible:null;
  }
  async inspect() {
    const platform=await this._platform(), env=await this.environment(), components=[];
    const python=await this._pythonChoice(env,{includeIncompatible:true});
    const managed=await this._version(this.python,'python',env);
    components.push({id:'python',label:'Python 3.12',status:python?.ok?'ready':python?'incompatible':'missing',version:python?.version||'',detail:python?.ok?'已找到兼容版本':'将安装专用 Python 3.12'});
    for(const tool of ['node','ffmpeg','ffprobe']) {
      const command=tool==='node'?(env.DSWHALE_NODE||tool):tool;
      const version=await this._version(command,tool,env);
      const newerNode=tool==='node'&&Number(version?.version.match(/^v(\d+)/)?.[1])>22;
      components.push({id:tool,label:tool==='node'?'Node.js 22':tool==='ffmpeg'?'FFmpeg':'FFprobe',status:version?(version.ok?'ready':newerNode?'incompatible':'outdated'):'missing',version:version?.version||'',detail:version?.ok?'版本可用':'将准备兼容的专用版本'});
    }
    let backend=false, version='';
    if(managed?.ok) {
      try {
        const metadata=JSON.parse((await runBounded(this.python,['-c','import importlib.metadata as m,json; print(json.dumps({"dswhale":m.version("dswhale"),"astrbot":m.version("astrbot")}))'],{env})).toString('utf8'));
        version=metadata.dswhale;
        const source=await fs.readFile(path.join(this.source,'pyproject.toml'),'utf8');
        const expected=source.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
        const marker=await readJSON(path.join(this.runtime,'desktop-install.json'),{});
        backend=metadata.astrbot==='4.29.3'&&version===expected&&marker.version===expected;
        await fs.access(path.join(this.host,'data/cmd_config.json'));
        await fs.access(path.join(this.host,'data/plugins/astrbot_plugin_livingmemory/requirements.txt'));
        await fs.access(path.join(this.host,'data/plugins/astrbot_plugin_livingmemory/main.py'));
        await fs.access(path.join(this.host,'data/plugins/astrbot_plugin_dswhale/main.py'));
      }catch {backend=false;}
    }
    components.push({id:'backend',label:'DSWhale 与 AstrBot',status:backend?'ready':version?'outdated':'missing',version,detail:backend?'已完成安装':'准备应用与记忆插件'});
    return {platform,components,installed:platform.supported&&components.every(item=>item.status==='ready')};
  }
  install() {
    if(this.operation)return this.operation;
    this.controller=new AbortController();
    const signal=this.controller.signal;
    this.operation=withInstallLock(this.runtime,async()=>{
      const platform=await this._platform();
      if(!platform.supported)throw new SetupError(platform.detail);
      this.onProgress({phase:'installing',step:'准备经过校验的安装工具',progress:0.02});
      const uv=await this._uv(signal);
      const environment={...await this.environment(),UV_PYTHON_INSTALL_DIR:path.join(this.runtime,'tools/python'),UV_CACHE_DIR:path.join(this.runtime,'cache/uv'),UV_TOOL_DIR:path.join(this.runtime,'tools/uv-tools'),UV_NO_PROGRESS:'1',UV_NO_MODIFY_PATH:'1',DSWHALE_UV:uv,DSWHALE_DESKTOP:'1'};
      environment.PATH=path.dirname(uv)+path.delimiter+environment.PATH;
      const python=await this._pythonChoice(environment);
      this.onProgress({phase:'installing',step:python?'使用兼容的 Python 3.12':'下载专用 Python 3.12',progress:0.12});
      await runBounded(uv,['run','--no-project','--python',python?.command||'3.12','--with','filelock>=3.17,<4',path.join(this.source,'scripts/bootstrap.py')],{
        cwd:this.source,env:environment,signal,timeout:30*60*1000,maxBytes:8*1024**2,
        onLine:line=>{
          if(!line.startsWith('DSWHALE_PROGRESS '))return;
          try {const event=JSON.parse(line.slice(17));const allowed={python:'准备 Python 环境',backup:'备份现有数据',dependencies:'安装应用依赖',media:'准备 FFmpeg 和 FFprobe',node:'准备 Node.js 22',initialize:'初始化应用配置',plugins:'准备记忆与 B站组件',complete:'环境准备完成'};
            if(allowed[event.step])this.onProgress({phase:'installing',step:allowed[event.step],progress:typeof event.progress==='number'?Math.max(.12,Math.min(.99,event.progress)):null});
          }catch{}
        }
      });
      const result=await this.inspect();
      if(!result.installed)throw new SetupError('环境校验尚未完成，请重试准备环境');
      this.onProgress({phase:'ready',step:'环境准备完成',progress:1});
      return result;
    }).catch(error=>{const safe=signal.aborted?'安装已取消':error instanceof SetupError?error.message:'环境准备失败，请检查可用空间和网络后重试';this.onProgress({phase:'error',step:'环境准备未完成',error:safe});throw new SetupError(safe);}).finally(()=>{this.operation=null;this.controller=null;});
    return this.operation;
  }
  async _uv(signal) {
    const asset=assets.uv[`${process.platform}-${process.arch}`];
    if(!asset)throw new SetupError('当前系统没有兼容的安装工具');
    const directory=path.join(this.runtime,'tools',`uv-${assets.uvVersion}`), executable=path.join(directory,process.platform==='win32'?'uv.exe':'uv');
    try {if(compatibleVersion('uv',(await runBounded(executable,['--version'],{signal})).toString('utf8')))return executable;}catch{}
    await fs.mkdir(directory,{recursive:true});
    const stage=await fs.mkdtemp(path.join(this.runtime,'tools','uv-stage-'));
    try {
      const archive=path.join(stage,asset.url.endsWith('.zip')?'uv.zip':'uv.tar.gz');
      await downloadVerified(asset,archive,{signal,onProgress:progress=>this.onProgress({phase:'installing',step:'下载并校验安装工具',progress:progress===null?null:.02+progress*.08})});
      // Read the one pinned member through stdout; never extract archive paths or links.
      const list=(await runBounded('tar',['-tf',archive],{signal,timeout:60000})).toString('utf8').trim().split(/\r?\n/);
      if(list.some(name=>name.startsWith('/')||name.includes('\\')||name.includes(':')||name.split('/').includes('..'))||!list.includes(asset.member))throw new SetupError('安装工具压缩包路径不安全');
      const binary=await runBounded('tar',['-xOf',archive,asset.member],{signal,timeout:60000,maxBytes:100*1024**2});
      const staged=path.join(stage,process.platform==='win32'?'uv.exe':'uv');
      await fs.writeFile(staged,binary,{mode:0o755});
      if(!compatibleVersion('uv',(await runBounded(staged,['--version'],{signal})).toString('utf8')))throw new SetupError('安装工具版本校验失败');
      await fs.rename(staged,executable);
      return executable;
    }finally {await fs.rm(stage,{recursive:true,force:true});}
  }
  async cancel() {this.controller?.abort();if(this.operation)await this.operation.catch(()=>{});}
}
module.exports={RuntimeManager,SetupError,platformInfo,compatibleVersion,downloadVerified,withInstallLock,runBounded};
