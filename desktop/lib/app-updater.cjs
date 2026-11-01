'use strict';
// Manual desktop application updates. This module never starts an installer,
// restores private data, quits Electron, or prepares the backend by itself.
// The root process supplies those capabilities as explicit callbacks.
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const defaultTrust = require('./release-trust.json');

const REPOSITORY = 'XianZe1226/DSWhale';
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
const RELEASE_BASE = `https://github.com/${REPOSITORY}/releases/download/`;
const MAX_MANIFEST = 65536, MAX_STATE = 8192, MAX_INSTALLER = 4 * 1024**3;
const MATRIX = {astrbot:'4.29.3',python:'3.12',node:'22.23.4',ffmpeg:'9.0.2'};
const MINIMUM_OS = {win32:'10.0.19045',darwin:'13.0',linux:['ubuntu:22.04','ubuntu:24.04']};
const SUFFIXES = {'win32-x64':'Windows-x86_64-setup.exe','darwin-arm64':'macOS-arm64.dmg','linux-x64':'Linux-x86_64.deb'};
const MESSAGES = {
  SIGNATURE_INVALID:'更新清单签名无效，请从官方发布页重新检查。',
  MANIFEST_INVALID:'更新清单内容不符合要求，请等待官方修复。',
  MANIFEST_TOO_LARGE:'更新清单超过安全大小限制。',
  METADATA_TOO_LARGE:'发布信息超过安全大小限制。',
  NETWORK_FAILED:'无法获取官方更新，请检查网络后重试。',
  CHANNEL_INVALID:'请选择稳定版或 Alpha 更新通道。',
  DOWNGRADE_BLOCKED:'此版本低于当前版本或已验证版本，请使用明确的回退操作。',
  PLATFORM_UNSUPPORTED:'支持 Windows 10 22H2+/11 x64、macOS 13+ Apple Silicon、Ubuntu 22.04/24.04 x64。',
  FIRST_MANUAL_INSTALL:'旧版没有签名更新与回退支持，请先从官方发布页手动安装 0.3.0a3。',
  CHECK_REQUIRED:'请先检查官方更新。',
  DOWNLOAD_REQUIRED:'请先下载并校验当前版与目标版安装包。',
  INSTALLER_INVALID:'安装包缺失或校验失败，请重新下载。',
  BACKUP_FAILED:'私人数据备份未完成，更新已停止；请检查可用空间后重试。',
  STOP_FAILED:'服务未能安全停止，更新已停止，请关闭服务后重试。',
  INSTALLER_LAUNCH_FAILED:'安装程序未能打开，请继续安装或使用已保存的回退包。',
  CALLBACK_REQUIRED:'此安装方式尚未接入应用，请使用官方安装包。',
  STATE_INVALID:'更新记录损坏；请保留私人数据并使用官方安装包修复。',
  STORAGE_FAILED:'更新记录未能保存，请检查可用空间和目录权限。',
  UPDATER_BUSY:'另一项更新操作正在进行，请等待完成。',
  CANCELLED:'更新已取消；已验证的安装包和备份仍保留在本机。',
  ROLLBACK_UNAVAILABLE:'尚无可验证的上一版安装包和更新前备份。',
  DATA_RESTORE_REQUIRED:'此版本的数据发生变化，回退需要明确选择恢复更新前数据。',
  RESTORE_CONFIRMATION_REQUIRED:'恢复旧数据前需要明确确认；当前新数据将先另行备份。',
  RESTORE_FAILED:'旧数据恢复未完成；请保持服务停止并检查本机备份。',
  VERSION_NOT_APPLIED:'运行中的应用版本尚未完成替换，请完成系统安装并重新打开应用。',
  VERIFICATION_FAILED:'更新后的环境检查未通过，请继续修复环境或回退。',
  UPDATE_PENDING:'现有更新尚待安装或检查，请先继续、修复或回退。',
};
class UpdateError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES.STORAGE_FAILED); this.name='UpdateError'; this.code=Object.hasOwn(MESSAGES,code)?code:'STORAGE_FAILED'; }
}
const fail = code => {throw new UpdateError(code);};
const isObject = value => Boolean(value && typeof value==='object' && !Array.isArray(value));
const keysAre = (value, keys) => isObject(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function normalizeVersion(input) {
  if(typeof input!=='string'||input.length>64)fail('MANIFEST_INVALID');
  const version=input.replace(/-alpha\.(\d+)$/,'a$1');
  const match=version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:a(0|[1-9]\d*))?$/);
  if(!match || match.slice(1).some(value=>value!==undefined&&!Number.isSafeInteger(Number(value))))fail('MANIFEST_INVALID');
  return version;
}
function compareVersions(left,right) {
  const parts = value => normalizeVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:a(\d+))?$/).slice(1).map((v,i)=>v===undefined&&i===3?Infinity:Number(v));
  const a=parts(left),b=parts(right);
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]>b[i]?1:-1;
  return 0;
}
function verifyManifest(raw,signature,{trust=defaultTrust,expectedVersion}={}) {
  if(!Buffer.isBuffer(raw))raw=Buffer.from(raw);
  if(raw.length>MAX_MANIFEST)fail('MANIFEST_TOO_LARGE');
  // Authenticate exact bytes before decoding or reading a version/URL/size.
  try {
    if(trust.repository!==REPOSITORY||trust.algorithm!=='ed25519'||!Buffer.isBuffer(signature)||signature.length!==64)fail('SIGNATURE_INVALID');
    const key=crypto.createPublicKey(trust.publicKey);
    if(key.asymmetricKeyType!=='ed25519'||!crypto.verify(null,raw,key,signature))fail('SIGNATURE_INVALID');
  } catch {fail('SIGNATURE_INVALID');}
  let value;
  try {value=JSON.parse(raw.toString('utf8'));}catch {fail('MANIFEST_INVALID');}
  if(!keysAre(value,['schemaVersion','product','repository','version','npmVersion','channel','tag','commit','minimumOS','runtime','impact','assets']))fail('MANIFEST_INVALID');
  const version=normalizeVersion(value.version);
  if(value.version!==version||value.schemaVersion!==1||value.product!=='DSWhale'||value.repository!==REPOSITORY||value.npmVersion!==version.replace(/a(\d+)$/,'-alpha.$1')||value.tag!==`v${version}`||value.channel!==(version.includes('a')?'alpha':'stable')||!(/^[a-f0-9]{40}$/).test(value.commit))fail('MANIFEST_INVALID');
  if(expectedVersion!==undefined&&version!==normalizeVersion(expectedVersion))fail('MANIFEST_INVALID');
  if(!keysAre(value.runtime,Object.keys(MATRIX))||Object.entries(MATRIX).some(([key,wanted])=>value.runtime[key]!==wanted))fail('MANIFEST_INVALID');
  if(!keysAre(value.minimumOS,Object.keys(MINIMUM_OS))||value.minimumOS.win32!==MINIMUM_OS.win32||value.minimumOS.darwin!==MINIMUM_OS.darwin||!Array.isArray(value.minimumOS.linux)||value.minimumOS.linux.join(',')!==MINIMUM_OS.linux.join(','))fail('MANIFEST_INVALID');
  if(!keysAre(value.impact,['runtime','dataMigration','configuration','rollbackCompatible'])||Object.values(value.impact).some(flag=>typeof flag!=='boolean'))fail('MANIFEST_INVALID');
  if(!keysAre(value.assets,Object.keys(SUFFIXES)))fail('MANIFEST_INVALID');
  for(const [platform,suffix] of Object.entries(SUFFIXES)) {
    const asset=value.assets[platform], name=`DSWhale-${value.npmVersion}-${suffix}`;
    if(!keysAre(asset,['name','url','size','sha256'])||asset.name!==name||asset.url!==`${RELEASE_BASE}v${version}/${name}`||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>MAX_INSTALLER||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/.test(asset.sha256))fail('MANIFEST_INVALID');
  }
  return value;
}
function validBackup(value) {
  return keysAre(value,value?.fingerprint===undefined?['id']:['id','fingerprint'])&&typeof value.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value.id)&&!value.id.includes('..')&&(value.fingerprint===undefined||typeof value.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(value.fingerprint));
}
async function regularBytes(file,maxBytes) {
  const entry=await fs.lstat(file);
  if(!entry.isFile()||entry.isSymbolicLink()||entry.size>maxBytes)fail('STATE_INVALID');
  const handle=await fs.open(file,constants.O_RDONLY | (constants.O_NOFOLLOW||0));
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>maxBytes)fail('STATE_INVALID');
    return await handle.readFile();
  }finally {await handle.close();}
}
async function verifyInstaller(file,asset) {
  let handle;
  try {
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==asset.size)fail('INSTALLER_INVALID');
    handle=await fs.open(file,constants.O_RDONLY | (constants.O_NOFOLLOW||0));
    const opened=await handle.stat();
    if(!opened.isFile()||opened.size!==asset.size)fail('INSTALLER_INVALID');
    const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);
    let total=0;
    for(;;) {
      const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
      if(!bytesRead)break;
      total+=bytesRead;if(total>asset.size)fail('INSTALLER_INVALID');
      digest.update(buffer.subarray(0,bytesRead));
    }
    if(total!==asset.size||digest.digest('hex')!==asset.sha256)fail('INSTALLER_INVALID');
  }catch {fail('INSTALLER_INVALID');}
  finally {await handle?.close();}
}
const PHASES=['idle','up-to-date','available','downloading','downloaded','snapshotting','install-ready','install-launched','awaiting-verification','installed','rolling-back','rollback-launched','awaiting-rollback-verification','rolled-back','repair-required'];
function validState(value) {
  const allowed=['format','phase','channel','highestVersion','targetVersion','previousVersion','backup','preRollbackBackup','rollbackRecord','errorCode','failedAction','direction'];
  if(!isObject(value)||Object.keys(value).some(key=>!allowed.includes(key))||value.format!==1||!PHASES.includes(value.phase)||!['alpha','stable'].includes(value.channel))return false;
  for(const key of ['highestVersion','targetVersion','previousVersion'])if(value[key]!==undefined){try{if(normalizeVersion(value[key])!==value[key])return false;}catch{return false;}}
  for(const key of ['backup','preRollbackBackup'])if(value[key]!==undefined&&!validBackup(value[key]))return false;
  if(value.rollbackRecord!==undefined) {
    const record=value.rollbackRecord;
    if(!keysAre(record,['targetVersion','previousVersion','backup'])||!validBackup(record.backup))return false;
    try {if(normalizeVersion(record.targetVersion)!==record.targetVersion||normalizeVersion(record.previousVersion)!==record.previousVersion||compareVersions(record.targetVersion,record.previousVersion)<=0)return false;}catch{return false;}
  }
  if(value.errorCode!==undefined&&!Object.hasOwn(MESSAGES,value.errorCode))return false;
  if(value.failedAction!==undefined&&!['check','download','install','rollback','verify'].includes(value.failedAction))return false;
  if(value.direction!==undefined&&!['update','rollback'].includes(value.direction))return false;
  return true;
}

class AppUpdater {
  constructor({runtime,currentVersion,platform=process.platform,arch=process.arch,osRelease=os.release(),distro={},fetch:request=globalThis.fetch,download,trust=defaultTrust,stopServices,snapshot,launchInstaller,restoreSnapshot,onProgress=()=>{}}) {
    this.directory=path.join(path.resolve(runtime),'app-updates');
    this.currentVersion=normalizeVersion(currentVersion);this.platform=platform;this.arch=arch;this.osRelease=osRelease;this.distro=distro;
    this.request=request;this.downloader=download;this.trust=trust;this.stopServices=stopServices;this.snapshot=snapshot;this.launchInstaller=launchInstaller;this.restoreSnapshot=restoreSnapshot;this.onProgress=onProgress;
    this.state={format:1,phase:'idle',channel:this.currentVersion.includes('a')?'alpha':'stable'};
    this.loaded=false;this.corrupt=false;this.operation=null;this.controller=null;
  }
  _platform() {
    const release=this.osRelease.split('.').map(Number);
    const supported=this.platform==='darwin'&&this.arch==='arm64'&&release[0]>=22||this.platform==='win32'&&this.arch==='x64'&&release[0]===10&&release[1]===0&&release[2]>=19045||this.platform==='linux'&&this.arch==='x64'&&this.distro.ID==='ubuntu'&&['22.04','24.04'].includes(this.distro.VERSION_ID);
    if(!supported)fail('PLATFORM_UNSUPPORTED');
    return `${this.platform}-${this.arch}`;
  }
  async _directory(...parts) {
    let directory=this.directory;
    for(const part of ['',...parts]) {
      if(part)directory=path.join(directory,part);
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const stat=await fs.lstat(directory);
      if(!stat.isDirectory()||stat.isSymbolicLink())fail('STORAGE_FAILED');
    }
    return directory;
  }
  async _atomic(file,bytes) {
    const temporary=`${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
      handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
      try {if((await fs.lstat(file)).isSymbolicLink())fail('STORAGE_FAILED');}catch(error){if(error.code!=='ENOENT')throw error;}
      await fs.rename(temporary,file);
    }finally {await handle?.close();await fs.rm(temporary,{force:true});}
  }
  async _save() {await this._directory();await this._atomic(path.join(this.directory,'state.json'),Buffer.from(JSON.stringify(this.state)));}
  async _load() {
    if(this.loaded)return;
    this.loaded=true;
    try {
      // No directory creation or network request is needed for an idle status.
      const stat=await fs.lstat(this.directory);
      if(!stat.isDirectory()||stat.isSymbolicLink())fail('STATE_INVALID');
      const value=JSON.parse((await regularBytes(path.join(this.directory,'state.json'),MAX_STATE)).toString('utf8'));
      if(!validState(value))fail('STATE_INVALID');
      this.state=value;
      if(!value.rollbackRecord&&value.backup&&value.previousVersion&&value.targetVersion)value.rollbackRecord={targetVersion:value.targetVersion,previousVersion:value.previousVersion,backup:{...value.backup}};
      if(value.phase==='install-launched'&&value.targetVersion===this.currentVersion)this.state.phase='awaiting-verification';
      if(value.phase==='rollback-launched'&&value.previousVersion===this.currentVersion)this.state.phase='awaiting-rollback-verification';
    }catch(error) {
      if(error.code==='ENOENT')return;
      this.corrupt=true;this.state={format:1,phase:'repair-required',channel:this.state.channel,errorCode:'STATE_INVALID'};
    }
  }
  _abort() {if(this.controller?.signal.aborted)fail('CANCELLED');}
  _progress(phase) {try{this.onProgress({phase,step:phase==='downloading'?'下载并校验安装包':'准备应用更新'});}catch{}}
  _run(action,work) {
    if(this.operation)return Promise.reject(new UpdateError('UPDATER_BUSY'));
    this.controller=new AbortController();
    this.operation=(async()=>{
      await this._load();if(this.corrupt)fail('STATE_INVALID');
      try {
        const result=await work();return result;
      }catch(error) {
        const code=this.controller.signal.aborted?'CANCELLED':error instanceof UpdateError?error.code:'STORAGE_FAILED';
        this.state.errorCode=code;this.state.failedAction=action;
        try{await this._save();}catch{}
        throw new UpdateError(code);
      }
    })().finally(()=>{this.operation=null;this.controller=null;});
    return this.operation;
  }
  async _checkpoint(phase) {this._abort();this.state.phase=phase;delete this.state.errorCode;delete this.state.failedAction;await this._save();this._progress(phase);}
  async _metadata(url,maxBytes) {
    const signal=this.controller?.signal;
    const timeout=AbortSignal.timeout(30000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
    try {
      const response=await this.request(url,{signal:combined,redirect:'follow',credentials:'omit',headers:{'User-Agent':'DSWhale-Desktop','Accept':new URL(url).hostname==='api.github.com'?'application/vnd.github+json':'application/octet-stream'}});
      if(!response.ok||!response.body)fail('NETWORK_FAILED');
      if(response.url) {
        const final=new URL(response.url);
        if(final.protocol!=='https:'||final.username||final.password||final.port||!['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(final.hostname))fail('NETWORK_FAILED');
      }
      if(Number(response.headers.get('content-length'))>maxBytes)fail(maxBytes===MAX_MANIFEST?'MANIFEST_TOO_LARGE':'METADATA_TOO_LARGE');
      const chunks=[];let count=0;
      for await(const chunk of response.body) {
        combined.throwIfAborted();count+=chunk.length;
        if(count>maxBytes)fail(maxBytes===MAX_MANIFEST?'MANIFEST_TOO_LARGE':'METADATA_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }catch(error){if(error instanceof UpdateError)throw error;if(signal?.aborted)fail('CANCELLED');fail('NETWORK_FAILED');}
  }
  async _fetchManifest(version) {
    normalizeVersion(version);
    const url=`${RELEASE_BASE}v${version}/release-manifest`;
    const raw=await this._metadata(`${url}.json`,MAX_MANIFEST);
    const signature=await this._metadata(`${url}.sig`,64);
    const manifest=verifyManifest(raw,signature,{trust:this.trust,expectedVersion:version});
    const directory=await this._directory('manifests',version);
    await this._atomic(path.join(directory,'release-manifest.json'),raw);
    await this._atomic(path.join(directory,'release-manifest.sig'),signature);
    return manifest;
  }
  async _cachedManifest(version) {
    try {
      normalizeVersion(version);
      for(const directory of [this.directory,path.join(this.directory,'manifests'),path.join(this.directory,'manifests',version)]) {
        const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())fail('MANIFEST_INVALID');
      }
      const directory=path.join(this.directory,'manifests',version);
      return verifyManifest(await regularBytes(path.join(directory,'release-manifest.json'),MAX_MANIFEST),await regularBytes(path.join(directory,'release-manifest.sig'),64),{trust:this.trust,expectedVersion:version});
    }catch(error){if(error instanceof UpdateError)throw error;fail('MANIFEST_INVALID');}
  }
  _installerPath(manifest) {return path.join(this.directory,'installers',manifest.version,manifest.assets[`${this.platform}-${this.arch}`].name);}
  async _installerPresent(manifest) {
    if(!manifest?.assets[`${this.platform}-${this.arch}`])return false;
    try {
      for(const directory of [this.directory,path.join(this.directory,'installers'),path.join(this.directory,'installers',manifest.version)]) {
        const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())return false;
      }
      const stat=await fs.lstat(this._installerPath(manifest));
      return stat.isFile()&&!stat.isSymbolicLink()&&stat.size===manifest.assets[`${this.platform}-${this.arch}`].size;
    }catch{return false;}
  }
  async _verifyInstaller(manifest) {
    if(!await this._installerPresent(manifest))fail('INSTALLER_INVALID');
    await verifyInstaller(this._installerPath(manifest),manifest.assets[`${this.platform}-${this.arch}`]);
  }
  async _downloadInstaller(manifest) {
    const platform=this._platform(),asset=manifest.assets[platform];
    await this._directory('installers',manifest.version);
    const file=this._installerPath(manifest);
    try {await this._verifyInstaller(manifest);return;}catch{}
    // Remove a bad regular file, never write through a symlink.
    try {if((await fs.lstat(file)).isSymbolicLink())fail('INSTALLER_INVALID');await fs.rm(file);}catch(error){if(error.code!=='ENOENT')throw error;}
    const download=this.downloader||require('./runtime.cjs').downloadVerified;
    try {await download(asset,file,{fetch:this.request,maxBytes:asset.size,signal:this.controller.signal,onProgress:()=>this._progress('downloading')});}
    catch(error){if(error instanceof UpdateError)throw error;if(this.controller.signal.aborted)fail('CANCELLED');fail('NETWORK_FAILED');}
    await this._verifyInstaller(manifest);
  }
  async status() {
    await this._load();
    let target,previous,metadataError,rollbackTarget,rollbackPrevious,rollbackError;
    try{if(this.state.targetVersion)target=await this._cachedManifest(this.state.targetVersion);if(this.state.previousVersion)previous=await this._cachedManifest(this.state.previousVersion);}catch(error){metadataError=error instanceof UpdateError?error.code:'MANIFEST_INVALID';}
    const rollback=this.state.rollbackRecord;
    try{if(rollback){rollbackTarget=await this._cachedManifest(rollback.targetVersion);rollbackPrevious=await this._cachedManifest(rollback.previousVersion);}}catch(error){rollbackError=error instanceof UpdateError?error.code:'MANIFEST_INVALID';}
    const targetPresent=await this._installerPresent(target),previousPresent=await this._installerPresent(previous);
    const canDownload=!this.corrupt&&!metadataError&&Boolean(target)&&compareVersions(target.version,this.currentVersion)>0&&['available','downloading','downloaded','up-to-date'].includes(this.state.phase);
    const canInstall=!this.corrupt&&!metadataError&&targetPresent&&previousPresent&&compareVersions(target.version,this.currentVersion)>0&&previous.version===this.currentVersion&&['downloaded','snapshotting','install-ready','install-launched'].includes(this.state.phase);
    const canRollback=!this.corrupt&&!rollbackError&&Boolean(rollback)&&Boolean(rollbackTarget)&&await this._installerPresent(rollbackPrevious)&&[rollback.targetVersion,rollback.previousVersion].includes(this.currentVersion)&&this.state.phase!=='rolled-back';
    const code=metadataError||rollbackError||this.state.errorCode;
    const interrupted=Boolean(code)||['downloading','snapshotting','install-ready','install-launched','rolling-back','rollback-launched'].includes(this.state.phase);
    const actions=['check',...(canDownload?['download']:[]),...(canInstall?['install']:[]),...(canRollback?['rollback']:[]),...(['awaiting-verification','awaiting-rollback-verification'].includes(this.state.phase)?['verify']:[]),...(this.state.phase==='repair-required'?['repair']:[])];
    return {currentVersion:this.currentVersion,targetVersion:this.state.targetVersion||null,previousVersion:rollback?.previousVersion||this.state.previousVersion||null,channel:this.state.channel,phase:this.corrupt?'repair-required':this.state.phase,canDownload,canInstall,canRollback,actions,
      impact:target?{...target.impact}:null,matrix:target?{...target.runtime}:{...MATRIX},minimumOS:{...MINIMUM_OS,linux:[...MINIMUM_OS.linux]},
      error:code?{code,message:MESSAGES[code]||MESSAGES.STORAGE_FAILED}:null,
      recovery:{interrupted,continueAction:canInstall?'install':canDownload?'download':null,requiresHealthVerification:['awaiting-verification','awaiting-rollback-verification','repair-required'].includes(this.state.phase),servicesMustRemainStopped:['snapshotting','install-ready','install-launched','awaiting-verification','rolling-back','rollback-launched','awaiting-rollback-verification','repair-required'].includes(this.state.phase),rollbackRequiresDataRestore:Boolean(rollbackTarget&&(rollbackTarget.impact.dataMigration||!rollbackTarget.impact.rollbackCompatible)),guidance:code?MESSAGES[code]:this.state.phase==='install-launched'?'请完成系统安装并重新打开应用；保留的旧版安装包和备份可用于回退。':this.state.phase==='rollback-launched'?'请完成旧版系统安装，重新打开应用后检查环境。':interrupted?'操作尚未完成，可继续下载或安装；备份保留在本机。':'更新仅在你明确操作时进行。'}};
  }
  check({channel}={}) {
    return this._run('check',async()=>{
      channel=channel===undefined?this.state.channel:channel;
      this._platform();if(!['alpha','stable'].includes(channel))fail('CHANNEL_INVALID');
      if(['snapshotting','install-ready','install-launched','awaiting-verification','rolling-back','rollback-launched','awaiting-rollback-verification','repair-required'].includes(this.state.phase))fail('UPDATE_PENDING');
      let releases;try{releases=JSON.parse((await this._metadata(RELEASE_API,1024*1024)).toString('utf8'));}catch(error){if(error instanceof UpdateError)throw error;fail('MANIFEST_INVALID');}
      if(!Array.isArray(releases)||releases.length>100)fail('MANIFEST_INVALID');
      const versions=[];
      for(const release of releases) {
        if(!isObject(release)||release.draft!==false||typeof release.tag_name!=='string'||!release.tag_name.startsWith('v'))continue;
        let version;try{version=normalizeVersion(release.tag_name.slice(1));}catch{continue;}
        if(release.tag_name!==`v${version}`||release.prerelease!==version.includes('a')||channel==='stable'&&version.includes('a'))continue;
        versions.push(version);
      }
      versions.sort((a,b)=>compareVersions(b,a));this.state.channel=channel;
      if(!versions.length){if(!this.state.backup)await this._checkpoint('up-to-date');return this.status();}
      const version=versions[0];
      if(compareVersions(version,this.currentVersion)<0||this.state.highestVersion&&compareVersions(version,this.state.highestVersion)<0)fail('DOWNGRADE_BLOCKED');
      if(version===this.currentVersion){if(!this.state.backup)await this._checkpoint('up-to-date');return this.status();}
      await this._fetchManifest(version);
      this.state={...this.state,format:1,phase:'available',channel,highestVersion:version,targetVersion:version};
      await this._checkpoint('available');return this.status();
    });
  }
  download() {
    return this._run('download',async()=>{
      this._platform();if(compareVersions(this.currentVersion,'0.3.0a3')<0)fail('FIRST_MANUAL_INSTALL');
      if(!this.state.targetVersion)fail('CHECK_REQUIRED');
      if(['install-launched','awaiting-verification','installed','rollback-launched','awaiting-rollback-verification','repair-required'].includes(this.state.phase))fail('UPDATE_PENDING');
      const target=await this._cachedManifest(this.state.targetVersion);
      if(compareVersions(target.version,this.currentVersion)<=0||this.state.highestVersion&&compareVersions(target.version,this.state.highestVersion)<0)fail('DOWNGRADE_BLOCKED');
      await this._checkpoint('downloading');
      // An upgrade is blocked unless the running app's signed rollback installer
      // is already present and verified. a2 predates this protocol.
      const previous=await this._fetchManifest(this.currentVersion);
      await this._downloadInstaller(previous);this.state.previousVersion=previous.version;await this._save();
      await this._downloadInstaller(target);await this._checkpoint('downloaded');return this.status();
    });
  }
  async _stop() {
    if(typeof this.stopServices!=='function')fail('CALLBACK_REQUIRED');
    try {const stopped=await this.stopServices({signal:this.controller.signal});if(stopped===false)fail('STOP_FAILED');}
    catch {fail('STOP_FAILED');}
    this._abort();
  }
  async _snapshot(reason) {
    if(typeof this.snapshot!=='function')fail('CALLBACK_REQUIRED');
    let backup;
    try{const value=await this.snapshot({reason,signal:this.controller.signal});backup={id:value?.id,...(value?.fingerprint!==undefined?{fingerprint:value.fingerprint}:{})};if(!validBackup(backup))fail('BACKUP_FAILED');}
    catch {fail('BACKUP_FAILED');}
    return backup;
  }
  async _launch(manifest,rollback) {
    if(typeof this.launchInstaller!=='function')fail('CALLBACK_REQUIRED');
    this._abort();
    // Persist before handing control to an installer which may close this app.
    await this._checkpoint(rollback?'rollback-launched':'install-launched');
    try{await this.launchInstaller({file:this._installerPath(manifest),platform:this.platform,version:manifest.version,rollback,quitRequired:this.platform==='win32',signal:this.controller.signal});}
    catch {fail('INSTALLER_LAUNCH_FAILED');}
  }
  install() {
    return this._run('install',async()=>{
      this._platform();if(this.state.targetVersion===this.currentVersion)fail('VERSION_NOT_APPLIED');
      if(!['downloaded','snapshotting','install-ready','install-launched'].includes(this.state.phase)||!this.state.previousVersion)fail('DOWNLOAD_REQUIRED');
      const target=await this._cachedManifest(this.state.targetVersion),previous=await this._cachedManifest(this.state.previousVersion);
      if(compareVersions(target.version,this.currentVersion)<=0||previous.version!==this.currentVersion||this.state.highestVersion&&compareVersions(target.version,this.state.highestVersion)<0)fail('DOWNGRADE_BLOCKED');
      await this._verifyInstaller(target);await this._verifyInstaller(previous);
      if(typeof this.launchInstaller!=='function')fail('CALLBACK_REQUIRED');
      await this._stop();await this._checkpoint('snapshotting');
      // Each explicit handoff attempt gets a fresh backup: the user may have
      // continued chatting after an earlier cancelled or failed OS installation.
      this.state.backup=await this._snapshot('app-update');await this._save();
      this.state.rollbackRecord={targetVersion:target.version,previousVersion:previous.version,backup:{...this.state.backup}};
      this.state.direction='update';await this._checkpoint('install-ready');
      await this._verifyInstaller(target);await this._launch(target,false);return this.status();
    });
  }
  rollback({restoreData=false,confirmDataRestore=false}={}) {
    return this._run('rollback',async()=>{
      this._platform();
      if(typeof restoreData!=='boolean'||typeof confirmDataRestore!=='boolean')fail('RESTORE_CONFIRMATION_REQUIRED');
      const record=this.state.rollbackRecord;
      if(!record)fail('ROLLBACK_UNAVAILABLE');
      const target=await this._cachedManifest(record.targetVersion),previous=await this._cachedManifest(record.previousVersion);
      if(![target.version,previous.version].includes(this.currentVersion))fail('ROLLBACK_UNAVAILABLE');
      if((target.impact.dataMigration||!target.impact.rollbackCompatible)&&!restoreData)fail('DATA_RESTORE_REQUIRED');
      if(restoreData&&!confirmDataRestore)fail('RESTORE_CONFIRMATION_REQUIRED');
      if(restoreData&&typeof this.restoreSnapshot!=='function'||typeof this.launchInstaller!=='function')fail('CALLBACK_REQUIRED');
      this.state.targetVersion=record.targetVersion;this.state.previousVersion=record.previousVersion;this.state.backup={...record.backup};
      await this._verifyInstaller(previous);await this._stop();await this._checkpoint('rolling-back');
      const currentBackup=await this._snapshot('before-app-rollback');
      this.state.preRollbackBackup=currentBackup;this.state.direction='rollback';await this._save();this._abort();
      if(restoreData){try{await this.restoreSnapshot(this.state.backup.id,{currentBackupId:currentBackup.id,signal:this.controller.signal});}catch{fail('RESTORE_FAILED');}}
      await this._verifyInstaller(previous);await this._launch(previous,true);return this.status();
    });
  }
  completeVerification({healthy,version=this.currentVersion}={}) {
    return this._run('verify',async()=>{
      const expected=this.state.direction==='rollback'?this.state.previousVersion:this.state.targetVersion;
      if(typeof healthy!=='boolean'||!expected||normalizeVersion(version)!==expected||this.currentVersion!==expected||!['awaiting-verification','awaiting-rollback-verification','repair-required','installed','rolled-back'].includes(this.state.phase))fail('VERSION_NOT_APPLIED');
      if(healthy){await this._checkpoint(this.state.direction==='rollback'?'rolled-back':'installed');}
      else {this.state.phase='repair-required';this.state.errorCode='VERIFICATION_FAILED';await this._save();}
      return this.status();
    });
  }
  async cancel() {this.controller?.abort();if(this.operation)await this.operation.catch(()=>{});return this.status();}
}
module.exports={AppUpdater,UpdateError,verifyManifest,normalizeVersion,compareVersions};
