const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('automatic backup inventory validates ids and refuses symlinks or arbitrary restore paths',async()=>{
 const {Operations}=require('../lib/operations.cjs');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-ops-'));
 try{const manager={runtime:dir,host:path.join(dir,'astrbot')};const folder=path.join(dir,'backups');await fs.mkdir(folder);await fs.writeFile(path.join(folder,'before-import-123.zip'),'synthetic snapshot');await fs.writeFile(path.join(folder,'private-persona.txt'),'PRIVATE');
 const ops=new Operations({manager});const list=await ops.backups();assert.equal(list.length,1);assert.equal(list[0].source,'import');assert.equal(JSON.stringify(list).includes(dir),false);await assert.rejects(ops.backupFile('../private-persona.txt'));assert.equal(await ops.backupFile(list[0].id),path.join(folder,'before-import-123.zip'));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('event metadata excludes unknown fields and no raw failure text is persisted',async()=>{
 const {EventLog}=require('../lib/operations.cjs');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dswhale-events-'));
 try{const log=new EventLog(dir);await log.write({component:'runtime',action:'health',code:'PKG-001',message:'PRIVATE-KEY',owner:'123456789'});await log.write({component:'PRIVATE-KEY',action:'health',code:'PKG-001'});const raw=await fs.readFile(path.join(dir,'logs/events.jsonl'),'utf8');assert.ok(raw.includes('PKG-001'));assert.ok(!raw.includes('PRIVATE-KEY')&&!raw.includes('123456789'));await log.close();}finally{await fs.rm(dir,{recursive:true,force:true});}
});
