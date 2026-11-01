'use strict';
// Positive fields only. Never inspect host configuration, raw logs, chat or keys.
const fs=require('node:fs/promises'),{constants}=require('node:fs');
const path=require('node:path'),crypto=require('node:crypto');
const DIAGNOSTIC_FILES=Object.freeze(['health.json','events.json','versions.json','README.txt']);
const CHECKS=new Set(['config','bili-files','owner','qq-config','models','memory','qq-connection','bili-service','ports','napcat-isolation']);
const COMPONENTS=new Set(['app','runtime','bilibili','qq','network','update','backup','plugin']);
const ACTIONS=new Set(['start','stop','install','check','download','restore','health','export','rollback','resume']);
const CODES=new Set(['APP-000','APP-001','NET-001','UPD-001','NAP-001','PORT-001','CFG-001','PKG-001','BILI-001']);
const PHASES=new Set(['idle','up-to-date','available','downloading','downloaded','snapshotting','install-ready','install-launched','awaiting-verification','installed','rolling-back','rollback-launched','awaiting-rollback-verification','rolled-back','repair-required']);
const VERSION=/^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5}))?(?:a(?:0|[1-9]\d{0,5})|-alpha\.(?:0|[1-9]\d{0,5}))?$/;
const MAX_EVENTS=1024*1024,MAX_ZIP=128*1024;
const MESSAGES={DIAG_OUTPUT:'诊断包未保存，请选择尚不存在的文件并检查目录权限',DIAG_FAILED:'诊断包未保存，请检查可用空间后重试'};
class DiagnosticsError extends Error{constructor(code){super(MESSAGES[code]||MESSAGES.DIAG_FAILED);this.name='DiagnosticsError';this.code=Object.hasOwn(MESSAGES,code)?code:'DIAG_FAILED';}}
async function noLinks(file){const absolute=path.resolve(file),root=path.parse(absolute).root;let current=root;for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)){current=path.join(current,part);try{if((await fs.lstat(current)).isSymbolicLink())throw new DiagnosticsError('DIAG_OUTPUT');}catch(error){if(error.code==='ENOENT')return;throw error;}}}
function healthReport(value){
  const checks=[],seen=new Set();
  if(Array.isArray(value?.checks))for(const check of value.checks.slice(0,100)){
    if(!CHECKS.has(check?.id)||seen.has(check.id)||typeof check.ok!=='boolean'||typeof check.required!=='boolean')continue;
    seen.add(check.id);checks.push({id:check.id,ok:check.ok,required:check.required,...(CODES.has(check.code)?{code:check.code}:{})});
  }
  const summary={};for(const key of ['requiredFailures','warnings']){const count=value?.summary?.[key];summary[key]=Number.isSafeInteger(count)&&count>=0&&count<=1000?count:checks.filter(check=>!check.ok&&(key==='requiredFailures'?check.required:!check.required)).length;}
  return {format:1,checks,summary};
}
function versionsReport(matrix,update){
  const result={expected:{},actual:{},appUpdate:{}};
  for(const section of ['expected','actual'])for(const key of ['dswhale','astrbot','python','node','ffmpeg','channel']){const value=matrix?.[section]?.[key];if(typeof value==='string'&&(key==='channel'?['alpha','stable'].includes(value):VERSION.test(value)))result[section][key]=value;}
  if(PHASES.has(update?.phase))result.appUpdate.phase=update.phase;
  for(const key of ['currentVersion','targetVersion','previousVersion'])if(typeof update?.[key]==='string'&&VERSION.test(update[key]))result.appUpdate[key]=update[key];
  return result;
}
async function eventsReport(runtime){
  if(typeof runtime!=='string')return [];let handle;
  try{
    const file=path.join(path.resolve(runtime),'logs/events.jsonl');await noLinks(file);
    handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_EVENTS)return [];
    const buffer=Buffer.alloc(Math.min(stat.size,MAX_EVENTS));let size=0;
    while(size<buffer.length){const {bytesRead}=await handle.read(buffer,size,buffer.length-size,null);if(!bytesRead)break;size+=bytesRead;}
    const lines=buffer.subarray(0,size).toString('utf8').split(/\r?\n/);if(lines.at(-1)==='')lines.pop();
    const result=[];
    for(const line of lines.slice(-100))try{
      const event=JSON.parse(line);
      if(!COMPONENTS.has(event?.component)||!ACTIONS.has(event?.action)||!CODES.has(event?.code)||typeof event.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(event.at)||Number.isNaN(Date.parse(event.at)))continue;
      result.push({at:event.at,component:event.component,action:event.action,code:event.code});
    }catch{}
    return result;
  }catch{return [];}finally{await handle?.close();}
}
function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function zipStored(documents){
  const locals=[],central=[];let offset=0;
  for(const name of DIAGNOSTIC_FILES){
    const filename=Buffer.from(name),bytes=Buffer.from(documents[name]),crc=crc32(bytes);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
    const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(0x314,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt16LE(33,14);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(bytes.length,20);entry.writeUInt32LE(bytes.length,24);entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE((0o100600<<16)>>>0,38);entry.writeUInt32LE(offset,42);
    locals.push(local,filename,bytes);central.push(entry,filename);offset+=local.length+filename.length+bytes.length;if(offset>MAX_ZIP)throw new DiagnosticsError('DIAG_FAILED');
  }
  const table=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(DIAGNOSTIC_FILES.length,8);end.writeUInt16LE(DIAGNOSTIC_FILES.length,10);end.writeUInt32LE(table.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,table,end]);
}
async function writeDiagnostics({runtime,health,versionMatrix,appUpdate}={},output){
  let temporary,handle;
  try{
    if(typeof output!=='string'||!path.isAbsolute(output)||output.includes('\0'))throw new DiagnosticsError('DIAG_OUTPUT');
    await noLinks(output);try{await fs.lstat(output);throw new DiagnosticsError('DIAG_OUTPUT');}catch(error){if(error.code!=='ENOENT')throw error;}
    const folder=path.dirname(output);if(!(await fs.stat(folder)).isDirectory())throw new DiagnosticsError('DIAG_OUTPUT');
    const json=value=>JSON.stringify(value,null,2)+'\n';
    const bytes=zipStored({'health.json':json(healthReport(health)),'events.json':json(await eventsReport(runtime)),'versions.json':json(versionsReport(versionMatrix,appUpdate)),'README.txt':'DSWhale diagnostic metadata only. Includes allowlisted checks, version identifiers and fixed event codes. An absent check or version is unavailable, not successful. No configuration values, account IDs, paths, URLs, proxy settings, keys, tokens, persona, chat, memory or raw logs. Model, QQ and Bilibili availability requires user verification.\n'});
    temporary=path.join(folder,`.dswhale-diagnostics-${crypto.randomBytes(12).toString('hex')}.tmp`);
    handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
    await noLinks(output);await fs.link(temporary,output);return {saved:true};
  }catch(error){if(error instanceof DiagnosticsError)throw error;throw new DiagnosticsError(['EEXIST','ENOENT','ENOTDIR','EACCES','EPERM','ELOOP'].includes(error.code)?'DIAG_OUTPUT':'DIAG_FAILED');}
  finally{await handle?.close().catch(()=>{});if(temporary)await fs.rm(temporary,{force:true}).catch(()=>{});}
}
module.exports={writeDiagnostics,DIAGNOSTIC_FILES,DiagnosticsError};
