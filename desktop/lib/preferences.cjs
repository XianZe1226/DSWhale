'use strict';
const fs=require('node:fs/promises'),{constants}=require('node:fs');
const path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const FLAGS=['tray','startAtLogin','resumeAfterWake'];
const DEFAULTS=Object.freeze({tray:false,startAtLogin:false,resumeAfterWake:false});
const MESSAGES={PREF_INVALID:'应用偏好格式无效，请重新选择后保存',PREF_PATH:'偏好或启动项目录不安全，未更改设置',PREF_FOREIGN:'此启动项由其他程序管理，未覆盖现有文件',PREF_STARTUP:'系统未能保存登录启动设置，请检查系统设置后重试',PREF_SAVE:'应用偏好未保存，已恢复原有启动设置',PREF_ROLLBACK:'应用偏好未保存，系统启动项恢复未完成，请检查系统设置'};
class PreferencesError extends Error{constructor(code){super(MESSAGES[code]||MESSAGES.PREF_SAVE);this.name='PreferencesError';this.code=Object.hasOwn(MESSAGES,code)?code:'PREF_SAVE';}}
const fail=code=>{throw new PreferencesError(code);};
function normalize(value){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==FLAGS.length||Object.keys(value).some(key=>!FLAGS.includes(key))||FLAGS.some(key=>typeof value[key]!=='boolean'))fail('PREF_INVALID');return Object.fromEntries(FLAGS.map(key=>[key,value[key]]));}
async function safePath(file){
  const absolute=path.resolve(file),root=path.parse(absolute).root;let current=root;
  for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    try{if((await fs.lstat(current)).isSymbolicLink())fail('PREF_PATH');}catch(error){if(error.code==='ENOENT')return;throw error;}
  }
}
async function boundedFile(file,maxBytes){
  await safePath(file);let handle;
  try{
    handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const stat=await handle.stat();
    if(!stat.isFile()||stat.size>maxBytes)fail('PREF_PATH');
    const bytes=Buffer.alloc(maxBytes);let length=0;
    while(length<maxBytes){const result=await handle.read(bytes,length,maxBytes-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}
    return bytes.subarray(0,length);
  }catch(error){if(error.code==='ENOENT')return null;throw error;}finally{await handle?.close();}
}
async function stage(file,bytes){
  await safePath(file);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await safePath(file);
  const temporary=path.join(path.dirname(file),`.dswhale-preferences-${crypto.randomBytes(12).toString('hex')}.tmp`);let handle;
  try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();return temporary;}
  catch(error){await handle?.close();await fs.rm(temporary,{force:true}).catch(()=>{});throw error;}
}
async function replace(file,bytes){const temporary=await stage(file,bytes);try{await safePath(file);await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}}
function managedEntry(bytes){
  let group='';for(const line of bytes.toString('utf8').split(/\r?\n/)){const section=line.match(/^\[([^\]]+)\]$/);if(section)group=section[1];if(group==='Desktop Entry'&&line==='X-DSWhale-Managed=true')return true;}return false;
}
function desktopArgument(value){
  if(typeof value!=='string'||!path.posix.isAbsolute(value)||/[=\x00-\x1f\x7f]/.test(value))fail('PREF_STARTUP');
  // Desktop-entry string escaping precedes Exec argument unquoting.
  const quoted=value.replace(/[\\"$`]/g,char=>'\\'+char).replaceAll('\\','\\\\').replaceAll('%','%%');
  return `"${quoted}"`;
}
class Preferences{
  constructor({userData,app,platform=process.platform,home=os.homedir(),env=process.env,execPath=process.execPath}){this.file=path.join(path.resolve(userData),'desktop-preferences.json');this.app=app;this.platform=platform;this.home=path.resolve(home);this.env=env;this.execPath=execPath;this.pending=Promise.resolve();}
  async _read(){try{const bytes=await boundedFile(this.file,4096);return bytes===null?{...DEFAULTS}:normalize(JSON.parse(bytes.toString('utf8')));}catch(error){if(error instanceof PreferencesError)throw error;fail('PREF_INVALID');}}
  async read(){await this.pending.catch(()=>{});return this._read();}
  _loginOptions(value){return {openAtLogin:value.startAtLogin,...(this.platform==='win32'?{path:this.execPath,args:['--dswhale-startup',...(value.tray?['--hidden']:[])]}:{})};}
  async _native(previous,next){
    if(typeof this.app?.setLoginItemSettings!=='function'||typeof this.app?.getLoginItemSettings!=='function')fail('PREF_STARTUP');
    const before=this._loginOptions(previous),after=this._loginOptions(next);
    let actual;try{actual=await this.app.getLoginItemSettings(before);}catch{fail('PREF_STARTUP');}
    if(typeof actual?.openAtLogin!=='boolean')fail('PREF_STARTUP');before.openAtLogin=actual.openAtLogin;
    const undo=async()=>{await this.app.setLoginItemSettings(before);if((await this.app.getLoginItemSettings(before))?.openAtLogin!==before.openAtLogin)fail('PREF_ROLLBACK');};
    try{await this.app.setLoginItemSettings(after);if((await this.app.getLoginItemSettings(after))?.openAtLogin!==after.openAtLogin)fail('PREF_STARTUP');}
    catch{try{await undo();}catch{fail('PREF_ROLLBACK');}fail('PREF_STARTUP');}
    return undo;
  }
  async _linux(next){
    const config=this.env.XDG_CONFIG_HOME||path.join(this.home,'.config');
    if(!path.isAbsolute(config)||path.relative(this.home,config).split(path.sep).includes('..'))fail('PREF_PATH');
    const file=path.join(config,'autostart/dswhale.desktop');let before;
    try{before=await boundedFile(file,16384);}catch(error){if(error instanceof PreferencesError)throw error;fail('PREF_PATH');}
    if(before!==null&&!managedEntry(before)){if(next.startAtLogin)fail('PREF_FOREIGN');return async()=>{};}
    const undo=async()=>{const current=await boundedFile(file,16384);if(current!==null&&!managedEntry(current))fail('PREF_ROLLBACK');if(before!==null)await replace(file,before);else await fs.rm(file,{force:true});};
    try{
      if(next.startAtLogin){
        const body=`[Desktop Entry]\nType=Application\nName=DSWhale\nExec=${desktopArgument(this.execPath)} --dswhale-startup${next.tray?' --hidden':''}\nTerminal=false\nX-DSWhale-Managed=true\n`;
        await replace(file,Buffer.from(body));
      }else if(before!==null)await fs.unlink(file);
    }catch(error){if(error instanceof PreferencesError)throw error;try{await undo();}catch{fail('PREF_ROLLBACK');}fail('PREF_STARTUP');}
    return undo;
  }
  save(value){
    const work=this.pending.catch(()=>{}).then(async()=>{
      const next=normalize(value),previous=await this._read();let temporary,undo;
      try{
        temporary=await stage(this.file,Buffer.from(JSON.stringify(next)+'\n'));
        // Reconcile our own OS entry even if local preference history was lost.
        if(this.platform==='linux')undo=await this._linux(next);else if(['darwin','win32'].includes(this.platform))undo=await this._native(previous,next);else if(next.startAtLogin)fail('PREF_STARTUP');
        await safePath(this.file);await fs.rename(temporary,this.file);return next;
      }catch(error){
        if(undo)try{await undo();}catch{fail('PREF_ROLLBACK');}
        if(error instanceof PreferencesError)throw error;fail('PREF_SAVE');
      }finally{if(temporary)await fs.rm(temporary,{force:true}).catch(()=>{});}
    });this.pending=work;return work;
  }
}
module.exports={Preferences,PreferencesError};
