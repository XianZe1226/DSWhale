'use strict';
const {DIAGNOSTIC_FILES,writeDiagnostics}=require('./diagnostics.cjs');
const ACTIONS=new Set(['workspace-status','health-check','backup-list','backup-restore','backup-delete','diagnostics-export','app-update-check','app-update-start','app-update-download','app-update-install','app-update-rollback','napcat-install','napcat-configure','napcat-wire','napcat-stop','napcat-guide','napcat-login-code','preferences-save']);
class Workspace{
 constructor(options){Object.assign(this,options);this.healthReport=null;}
 async health(){if(!this.isInstalled())return null;this.healthReport=await this.operations.health();return this.healthReport;}
 async status(){return {health:await this.health(),backups:await this.operations.backups(),appUpdate:await this.appUpdater.status(),napcat:this.getQQStatus?await this.getQQStatus():await this.napcat.status(),preferences:await this.preferences.read(),diagnosticFiles:DIAGNOSTIC_FILES};}
 async perform(action,payload){
  if(action==='workspace-status')return this.status();
  if(action==='health-check')return {health:await this.health()};
  if(action==='backup-list')return {backups:await this.operations.backups()};
  if(action==='backup-restore'){const file=await this.operations.backupFile(payload.id);await this.restoreFile(file);return {health:await this.health(),backups:await this.operations.backups()};}
  if(action==='backup-delete'){const file=await this.operations.backupFile(payload.id);await this.trash(file);return {backups:await this.operations.backups()};}
  if(action==='diagnostics-export'){const file=await this.chooseDiagnostic();if(!file)return {canceled:true};const report={runtime:this.manager.runtime,health:this.healthReport,versionMatrix:this.getState().versionMatrix,appUpdate:await this.appUpdater.status()};return writeDiagnostics(report,file);}
  if(action==='preferences-save'){const value=await this.preferences.save(payload);await this.applyPreferences(value);return {preferences:value};}
  if(action==='napcat-guide'){await this.openGuide();return {};}
  if(action==='napcat-login-code'){await this.showLoginInfo(await this.napcat.loginInfo());return {};}
  if(['napcat-install','napcat-configure','napcat-wire'].includes(action)&&this.getQQMode?.()==='official')throw new Error('官方模式无需 NapCat，请先切换接入方式');
  if(action==='napcat-install'){if(!this.isInstalled())throw new Error('请先准备运行环境');await this.stopServices();return {napcat:await this.napcat.install()};}
  if(action==='napcat-configure'){const folder=await this.chooseNapCat();if(!folder)return {canceled:true};await this.napcat.stop();return {napcat:await this.napcat.configure(folder)};}
  if(action==='napcat-wire')return {napcat:await this.napcat.wire()};
  if(action==='napcat-stop')return {napcat:await this.napcat.stop()};
  if(action==='app-update-check')return {appUpdate:await this.appUpdater.check(payload)};
  if(action==='app-update-start'){
   const open=()=>{if(this.isClosing?.())throw new Error('应用正在退出，更新已取消');};
   open();if(!this.isInstalled())throw new Error('请先准备运行环境');
   let status=await this.appUpdater.status();open();const target=status.targetVersion;
   if(status.canDownload){await this.appUpdater.download();status=await this.appUpdater.status();open();}else if(!status.canInstall)throw new Error('请先检查应用更新');
   if(!status.canInstall||status.targetVersion!==target)throw new Error('更新版本已变化，请重新检查');
   if(typeof this.confirmUpdate!=='function')throw new Error('安装确认尚未准备好');
   const confirmed=await this.confirmUpdate(target);open();
   if(!confirmed)return {canceled:true,appUpdate:status};
   status=await this.appUpdater.status();open();
   if(!status.canInstall||status.targetVersion!==target)throw new Error('更新版本已变化，请重新检查');
   await this.appUpdater.install();await this.afterInstaller();return {appUpdate:await this.appUpdater.status()};
  }
  if(action==='app-update-download')return {appUpdate:await this.appUpdater.download()};
  if(action==='app-update-install'){if(!this.isInstalled())throw new Error('请先准备运行环境');await this.appUpdater.install();await this.afterInstaller();return {appUpdate:await this.appUpdater.status()};}
  if(action==='app-update-rollback'){await this.appUpdater.rollback(payload);await this.afterInstaller();return {appUpdate:await this.appUpdater.status()};}
  throw new Error('操作无效');
 }
}
module.exports={Workspace,WORKSPACE_ACTIONS:ACTIONS};
