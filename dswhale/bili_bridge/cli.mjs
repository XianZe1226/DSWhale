/** Fixed executable + argument array; never invokes a shell. */
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {isolatedEnvironment,validateCommand,redact} from './policy.mjs';
const root=process.env.DSWHALE_BILI_HOME;
if(!root||!path.isAbsolute(root))throw Error('Isolated data directory required');
const args=JSON.parse(process.argv[2]||'[]');
const mode=process.argv[3]||'read';
try {
  validateCommand(args,{manual:mode==='manual',allowWrite:mode==='write'});
  const env=isolatedEnvironment(process.env,root,process.execPath);
  fs.mkdirSync(path.join(root,'work'),{recursive:true});
  const cli=path.join(path.dirname(fileURLToPath(import.meta.url)),'upstream/tools/bili.mjs');
  const r=spawnSync(process.execPath,[cli,...args],{env,cwd:path.join(root,'work'),encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,windowsHide:true});
  let secrets=[];try{secrets=Object.values(JSON.parse(fs.readFileSync(path.join(root,'.bili-ai/credentials.json'),'utf8'))).filter(v=>typeof v==='string'&&v);}catch{}
  const clean=s=>redact(s||'',{root,secrets});
  process.stdout.write(JSON.stringify({ok:r.status===0,code:r.status??-1,out:clean(r.stdout),error:clean(r.stderr)}));
} catch {process.stdout.write(JSON.stringify({ok:false,code:-1,error:'操作不受支持，或需要主人确认。'}));}
