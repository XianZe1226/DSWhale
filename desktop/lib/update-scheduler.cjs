'use strict';
// Checks release metadata only. Downloading, installing and stopping services
// remain explicit user actions owned by AppUpdater and the main process.
const STARTUP_DELAY=30_000, INTERVAL=6*60*60*1000, BUSY_DELAY=60_000;
class UpdateScheduler {
  constructor({check,shouldRun=()=>true,onResult=()=>{},cancelCheck=async()=>{},now=Date.now,setTimeout:setTimer=globalThis.setTimeout,clearTimeout:clearTimer=globalThis.clearTimeout}) {
    this.check=check;this.shouldRun=shouldRun;this.onResult=onResult;this.cancelCheck=cancelCheck;
    this.now=now;this.setTimer=setTimer;this.clearTimer=clearTimer;
    this.stopped=true;this.timer=null;this.inFlight=null;this.generation=0;this.lastResult=null;this.nextDue=0;
  }
  _schedule(delay) {
    if(this.stopped)return;
    this.clearTimer(this.timer);this.nextDue=this.now()+delay;
    this.timer=this.setTimer(()=>{this.timer=null;void this.runNow();},delay);this.timer?.unref?.();
  }
  start() {if(!this.stopped)return;this.stopped=false;this._schedule(STARTUP_DELAY);}
  resume() {if(!this.stopped&&!this.inFlight)this._schedule(Math.max(STARTUP_DELAY,this.nextDue-this.now()));}
  runNow() {
    if(this.inFlight)return this.inFlight;
    if(this.stopped)return Promise.resolve();
    this.clearTimer(this.timer);this.timer=null;
    const generation=this.generation;let delay=INTERVAL;
    this.inFlight=Promise.resolve().then(async()=>{
      if(this.stopped||generation!==this.generation)return;
      if(!this.shouldRun()){delay=BUSY_DELAY;return;}
      const result=await this.check();
      if(this.stopped||generation!==this.generation){delay=BUSY_DELAY;return;}
      if(!result){delay=BUSY_DELAY;return;}
      const key=JSON.stringify(result);
      if(key!==this.lastResult){this.onResult(result);this.lastResult=key;}
    }).catch(error=>{
      if(error?.code==='UPDATER_BUSY')delay=BUSY_DELAY;
      // Background failures are intentionally quiet. Manual checks keep their
      // explicit errors, and the next scheduled metadata check can try again.
    }).finally(()=>{this.inFlight=null;this._schedule(generation===this.generation?delay:BUSY_DELAY);});
    return this.inFlight;
  }
  async cancel() {
    this.generation++;
    if(this.inFlight){await this.cancelCheck();await this.inFlight;}
  }
  stop() {this.stopped=true;this.generation++;this.clearTimer(this.timer);this.timer=null;}
}
module.exports={UpdateScheduler};
