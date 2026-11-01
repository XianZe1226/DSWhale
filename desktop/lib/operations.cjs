'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createReadStream}=require('node:fs');
const {runBounded}=require('./runtime.cjs');
const {preflightPorts}=require('./services.cjs');
const COMPONENTS=new Set(['app','runtime','bilibili','qq','network','update','backup','plugin']);
const ACTIONS=new Set(['start','stop','install','check','download','restore','health','export','rollback','resume']);
const BACKUP=/^before-(import|upgrade|update|rollback|restore)-[a-zA-Z0-9._-]{1,120}\.zip$/;
class EventLog{
 constructor(runtime){this.directory=path.join(runtime,'logs');this.pending=Promise.resolve();}
 write(event){if(!COMPONENTS.has(event.component)||!ACTIONS.has(event.action)||!/^([A-Z]{2,8})-[0-9]{3}$/.test(event.code||''))return Promise.resolve();
  const line=JSON.stringify({at:new Date().toISOString(),component:event.component,action:event.action,code:event.code})+'\n';
  this.pending=this.pending.catch(()=>{}).then(async()=>{await fs.mkdir(this.directory,{recursive:true,mode:0o700});const file=path.join(this.directory,'events.jsonl');try{const stat=await fs.lstat(file);if(stat.isSymbolicLink())return;if(stat.size>262144)await fs.rename(file,path.join(this.directory,'events.previous.jsonl'));}catch(error){if(error.code!=='ENOENT')throw error;}await fs.appendFile(file,line,{mode:0o600});}).catch(()=>{});return this.pending;
 }
 close(){return this.pending;}
}
class Operations{
 constructor({manager,supervisor,snapshotTo,runner=runBounded}){this.manager=manager;this.supervisor=supervisor;this.snapshotTo=snapshotTo;this.runner=runner;this.events=new EventLog(manager.runtime);this.closed=false;this.pending=null;}
 async backend(args,timeout=15000){if(this.closed)throw new Error('应用正在退出');if(this.pending)throw new Error('体检或数据操作尚未完成');const controller=new AbortController();this.controller=controller;
  const work=(async()=>{const env=await this.manager.environment();if(this.closed||controller.signal.aborted)throw new Error('应用正在退出');const bytes=await this.runner(this.manager.python,['-m','dswhale.desktop_health','--host',this.manager.host,...args],{env,cwd:this.manager.host,signal:controller.signal,timeout,maxBytes:65536});let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('体检未完成，请修复环境后重试');}if(value.error)throw new Error('体检未完成，请修复环境后重试');return value;})();this.pending=work;try{return await work;}finally{this.pending=null;this.controller=null;}
 }
 async health(){const running=Boolean(this.supervisor?.running);const args=running?['--running','--started-after',String(this.supervisor.startedAt||0)]:[];const report=await this.backend(args);if(!running){try{const config=JSON.parse((await fs.readFile(path.join(this.manager.host,'data/cmd_config.json'),'utf8')).replace(/^\uFEFF/,''));const ports=await preflightPorts(config);report.checks.push({id:'ports',name:'连接端口',ok:ports.ok,code:ports.code||'',required:true,detail:ports.ok?'控制台和反向连接端口可用':`端口 ${ports.occupiedPorts.join('、')} 已被其他程序占用，请修改端口或手动停止旧服务`,fix:'connect'});report.summary.requiredFailures+=ports.ok?0:1;}catch{report.checks.push({id:'ports',name:'连接端口',ok:false,code:'PORT-001',required:true,detail:'端口配置无效，请检查连接设置',fix:'connect'});report.summary.requiredFailures++;}}
  for(const c of report.checks)if(c.code)await this.events.write({component:c.id.startsWith('bili')?'bilibili':'runtime',action:'health',code:c.code});return report;
 }
 async backups(){const folder=path.join(this.manager.runtime,'backups');let entries;try{entries=await fs.readdir(folder);}catch(e){if(e.code==='ENOENT')return [];throw e;}const result=[];for(const id of entries){const match=id.match(BACKUP);if(!match)continue;const stat=await fs.lstat(path.join(folder,id));if(stat.isSymbolicLink()||!stat.isFile())continue;result.push({id,source:match[1],created:stat.mtime.toISOString(),size:stat.size});}return result.sort((a,b)=>b.created.localeCompare(a.created)).slice(0,30);}
 async backupFile(id){if(typeof id!=='string'||!BACKUP.test(id))throw new Error('备份标识无效');const file=path.join(this.manager.runtime,'backups',id);const folder=await fs.lstat(path.dirname(file));const stat=await fs.lstat(file);if(folder.isSymbolicLink()||stat.isSymbolicLink()||!stat.isFile())throw new Error('备份目录不安全');return file;}
 async snapshot({reason='update'}={}){if(this.closed)throw new Error('应用正在退出');if(!['import','upgrade','update','restore','rollback'].includes(reason))throw new Error('备份类型无效');await this.supervisor.stop();const id=`before-${reason}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.zip`;const folder=path.join(this.manager.runtime,'backups');await fs.mkdir(folder,{recursive:true,mode:0o700});if((await fs.lstat(folder)).isSymbolicLink())throw new Error('备份目录不安全');await this.snapshotTo(path.join(folder,id));return {id,fingerprint:await this.dataFingerprint()};}
 async dataFingerprint(){const root=path.join(this.manager.host,'data'),hash=crypto.createHash('sha256');let bytes=0,count=0;
  const walk=async directory=>{for(const item of(await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(directory,item.name),rel=path.relative(root,file).split(path.sep).join('/');if(item.isSymbolicLink())throw new Error('数据目录包含链接，未自动恢复');if(['plugins','temp'].includes(rel.split('/')[0])||/(?:^|\/)(?:health\.json|control\.json)$/.test(rel)||rel.includes('/shots/')||rel.includes('/node_modules/'))continue;if(item.isDirectory()){await walk(file);continue;}if(!item.isFile())continue;const stat=await fs.stat(file);bytes+=stat.size;if(++count>20000||bytes>1024**3)throw new Error('数据过大，请先手动备份');hash.update(rel);for await(const chunk of createReadStream(file))hash.update(chunk);}};await walk(root);return hash.digest('hex');
 }
 async close(){this.closed=true;this.controller?.abort();await this.pending?.catch(()=>{});await this.events.close();}
}
module.exports={Operations,EventLog};
