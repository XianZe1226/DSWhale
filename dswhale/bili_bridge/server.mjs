/** Local DSH host compatibility for the preserved MIT upstream plugin. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {trustedRequest,isolatedEnvironment} from './policy.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=process.env.DSWHALE_BILI_HOME, token=process.env.DSWHALE_BILI_TOKEN;
if(!root||!path.isAbsolute(root)||!token||token.length<16) throw Error('Local bridge configuration required');
Object.assign(process.env,isolatedEnvironment(process.env,root,process.execPath));
const configFile=process.env.BILI_WHALE_CONFIG;
fs.mkdirSync(path.join(root,'.bili-ai'),{recursive:true,mode:0o700});
fs.mkdirSync(path.join(root,'.dsh'),{recursive:true,mode:0o700});
if(!fs.existsSync(configFile)) fs.writeFileSync(configFile,JSON.stringify({
  owner:{mid:'',name:''},listen:{comment:false,dm:false,live:false,allDay:false},
  share:{via:'qq',enabled:true},notify:{type:'none'},diary:{enabled:true,push:true},
  night:{windows:[{start:'20:00',end:'24:00',wakes:1}],skipChance:0.3,minGapMin:10,maxVideos:5},
  quota:{shareDaily:3},
},null,2),{mode:0o600,flag:'wx'});
const emit=data=>process.stdout.write(JSON.stringify(data)+'\n');
// Upstream human-readable console output must never corrupt the private IPC stream.
console.log=()=>{}; console.warn=()=>{}; console.error=()=>{};
const routes=new Map(), disposers=[], requests=new Map();
let port=0;
function askParent(kind,payload){
  const id=randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{requests.delete(id);reject(Error('Host acknowledgement timed out'));},kind==='manual'?240000:20000);
    requests.set(id,{resolve,reject,timer});emit({type:kind,id,...payload});
  });
}
const input=createInterface({input:process.stdin});
input.on('line',line=>{
  if(line.length>1024*1024)return;
  try { const msg=JSON.parse(line); const p=requests.get(msg.id); if(!p)return;
    requests.delete(msg.id); clearTimeout(p.timer); msg.ok?p.resolve(msg.result):p.reject(Error('Host did not accept request'));
  }catch{}
});
const ctx={
  sessionController:{
    create:async({sessionId})=>({sessionId}),
    prompt:async(request,signal)=>{signal?.throwIfAborted();return askParent('prompt',{request});},
  },
  connection:{isTrusted:()=>true,requestRejection:req=>trustedRequest(req,port,token)?null:403},
  webServer:{register:({path:route,handler})=>{routes.set(route,handler);return()=>routes.delete(route);}},
  get(name){return this[name];},
  effect(effect){const cleanup=effect();if(typeof cleanup==='function')disposers.push(cleanup);},
};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const assets=new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/assets/app.js',['app.js','text/javascript; charset=utf-8']],
  ['/assets/client.js',['upstream/lib/client.js','text/javascript; charset=utf-8']],
  ['/assets/react.js',['node_modules/react/umd/react.production.min.js','text/javascript; charset=utf-8']],
  ['/assets/react-dom.js',['node_modules/react-dom/umd/react-dom.production.min.js','text/javascript; charset=utf-8']],
]);
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  if(req.headers.host!==`127.0.0.1:${port}`){json(res,403,{ok:false});return;}
  const url=new URL(req.url,'http://127.0.0.1');
  const asset=assets.get(url.pathname);
  if(asset && req.method==='GET'){
    try{res.setHeader('Content-Type',asset[1]);res.end(fs.readFileSync(path.join(here,asset[0])));}catch{json(res,404,{ok:false});}return;
  }
  if(!trustedRequest(req,port,token)){json(res,403,{ok:false,error:'请从本机启动入口打开设置页。'});return;}
  const handler=routes.get(url.pathname);
  if(handler){await handler(req,res);return;}
  if(url.pathname==='/dswhale/api/command'&&req.method==='POST'){
    try{
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)throw Error();}
      const {args}=JSON.parse(body);const result=await askParent('manual',{args});json(res,200,{ok:true,result});
    }catch{json(res,400,{ok:false,error:'操作未被接受，请检查参数或宿主状态。'});}return;
  }
  json(res,404,{ok:false});
});
server.requestTimeout=15000;server.headersTimeout=10000;
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
port=server.address().port;
const plugin=(await import('./upstream/lib/index.js')).default;
plugin.apply(ctx);
emit({type:'ready',port});
let closing=false;
async function close(){if(closing)return;closing=true;for(const dispose of disposers.reverse()){try{dispose();}catch{}}
  for(const p of requests.values()){clearTimeout(p.timer);p.reject(Error('Closed'));}requests.clear();server.closeAllConnections();server.close();input.close();process.exit(0);}
input.on('close',close);process.on('SIGTERM',close);process.on('SIGINT',close);
