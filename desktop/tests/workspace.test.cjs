const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('workspace IPC is main-frame only and rejects update URLs and arbitrary backup paths',()=>{const {validateRequest}=require('../lib/security.cjs');const shell={mainFrame:{}},event={sender:shell,senderFrame:shell.mainFrame};for(const action of ['workspace-status','health-check','diagnostics-export','napcat-login-code'])assert.doesNotThrow(()=>validateRequest(event,shell,action));assert.doesNotThrow(()=>validateRequest(event,shell,'app-update-check',{channel:'alpha'}));assert.throws(()=>validateRequest(event,shell,'app-update-check',{channel:'alpha',url:'https://evil.test'}));assert.throws(()=>validateRequest(event,shell,'backup-restore',{id:'../../data'}));assert.throws(()=>validateRequest({sender:{},senderFrame:{}},shell,'workspace-status'));});
test('pending update recovery fences actual start dispatcher before any service start',async()=>{const file=path.resolve(__dirname,'../main.cjs'),native=require('node:module').createRequire(file);const app={setName(){},getVersion:()=> '0.3.0-alpha.3',requestSingleInstanceLock:()=>false,quit(){}};const box={require:id=>id==='electron'?{app,protocol:{registerSchemesAsPrivileged(){}}}:native(id),__dirname:path.dirname(file),process,module:{exports:{}},setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nglobalThis.testHarness={perform,set(){state.installed=true;appUpdater={status:async()=>({recovery:{servicesMustRemainStopped:true}})};supervisor={start:async()=>{throw Error("SHOULD_NOT_START")}};extensions={run:async()=>({})}}};',box);box.testHarness.set();await assert.rejects(box.testHarness.perform('start'),/更新|回退|修复/);});

test('wiring a logged-in managed QQ uses the hot-apply action without stopping the component',async()=>{
 const {Workspace}=require('../lib/workspace.cjs');const calls=[];
 const napcat={running:true,wire:async()=>{calls.push('wire');return {running:true};},stop:async()=>{calls.push('stop');napcat.running=false;},configure:async()=>{if(napcat.running)throw Error('still running');calls.push('configure');return {};},start:async()=>{calls.push('start');napcat.running=true;},status:async()=>({running:napcat.running})};
 const workspace=new Workspace({napcat,isClosing:()=>false});
 await workspace.perform('napcat-wire');assert.deepEqual(calls,['wire']);
});

test('explicit QQ disconnect is limited to the manager and accepts no process or connection payload', async () => {
 const {Workspace}=require('../lib/workspace.cjs'),{validateRequest}=require('../lib/security.cjs');
 const shell={mainFrame:{}},event={sender:shell,senderFrame:shell.mainFrame};
 assert.doesNotThrow(()=>validateRequest(event,shell,'napcat-stop'));
 assert.throws(()=>validateRequest(event,shell,'napcat-stop',{pid:1234}));
 assert.throws(()=>validateRequest({sender:{},senderFrame:{}},shell,'napcat-stop'));
 let stops=0;const workspace=new Workspace({napcat:{stop:async()=>{stops++;return {running:false,hasSavedLogin:true};}}});
 assert.deepEqual(await workspace.perform('napcat-stop'),{napcat:{running:false,hasSavedLogin:true}});
 assert.equal(stops,1);
});
