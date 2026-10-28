import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';

test('actual sidecar hosts upstream settings with authenticated API and local-only assets', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'dswhale-bridge-'));
  const token='test-token-never-a-real-secret';
  const child=spawn(process.execPath,['dswhale/bili_bridge/server.mjs'],{env:{...process.env,DSWHALE_BILI_HOME:dir,DSWHALE_BILI_TOKEN:token},stdio:['pipe','pipe','pipe']});
  try {
    const ready=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('sidecar not ready')),8000);
      child.once('exit',()=>{clearTimeout(timer);reject(Error('sidecar exited'));});
      createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.type==='ready'){clearTimeout(timer);resolve(m);}});
    });
    const base=`http://127.0.0.1:${ready.port}`;
    assert.equal((await fetch(base+'/dsh-bili/api/settings')).status,403);
    const headers={authorization:'Bearer '+token};
    const data=await (await fetch(base+'/dsh-bili/api/settings',{headers})).json();
    assert.equal(data.ok,true); assert.equal(data.config.owner.mid,'');
    assert.equal(data.config.listen.dm,false); assert.equal(data.config.listen.comment,false);
    assert.equal((await fetch(base+'/dsh-bili/api/settings',{headers:{...headers,origin:'https://untrusted.example'}})).status,403);
    assert.equal((await fetch(base+'/assets/react.js')).status,200);
    assert.equal((await fetch(base+'/../credentials.json',{headers})).status,404);
  } finally {child.stdin.end();child.kill();await new Promise(r=>child.once('close',r));await rm(dir,{recursive:true,force:true});}
});
