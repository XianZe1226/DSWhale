'use strict';
// Private routing settings contain endpoints only; credentials never enter this file.
const fs = require('node:fs/promises');
const path = require('node:path');
const MESSAGES = Object.freeze({
  NET_POLICY:'系统网络配置暂不可用，请检查 Clash 或系统代理',
  NET_PROXY:'代理连接失败，请检查 Clash 是否正在运行',
  NET_TIMEOUT:'网络请求超时，请检查网络后重试',
  NET_DNS:'下载来源无法解析，请检查 DNS 或网络设置',
  NET_TLS:'下载来源的安全连接失败，请检查系统时间和网络设置',
  NET_HTTP:'下载来源暂时不可用，请稍后重试，必要时检查 Clash',
  NET_INTERRUPTED:'下载连接中断，已保留进度，可重试继续',
  NET_CHECKSUM:'下载校验失败，已移除无效文件，请检查 Clash 或系统网络后重试',
  NET_SIZE:'下载大小超过限制，已停止下载',
  NET_RANGE:'下载来源返回的续传范围无效，请检查 Clash 或系统网络后重试',
  NET_CANCELLED:'下载已取消，已保留进度',
});
class NetworkError extends Error {
  constructor(code='NET_INTERRUPTED',source='other') {
    super(MESSAGES[code]||MESSAGES.NET_INTERRUPTED);
    this.name='NetworkError';this.code=Object.hasOwn(MESSAGES,code)?code:'NET_INTERRUPTED';
    this.source=['github','pypi','npm','nodejs','python','ffmpeg','mirror','other'].includes(source)?source:'other';
    this.hint=this.message;
  }
}
function endpoint(value,{proxy=false}={}) {
  if(typeof value!=='string'||value.length>2048||/[\s\x00-\x1f\x7f]/.test(value))throw new NetworkError('NET_POLICY');
  let url;try{url=new URL(value);}catch{throw new NetworkError('NET_POLICY');}
  if(!url.hostname||url.username||url.password||url.search||url.hash||!(['https:',...(proxy?['http:']:[])].includes(url.protocol))||(proxy&&url.pathname!=='/'))throw new NetworkError('NET_POLICY');
  return url.href;
}
function normalizeNetworkConfig(input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['mode','proxyUrl','noProxy','pypiIndex','npmRegistry','assetMirrors'].includes(key)))throw new NetworkError('NET_POLICY');
  const config={mode:input.mode??'system',proxyUrl:'',noProxy:'',pypiIndex:'',npmRegistry:'',assetMirrors:[]};
  if(!['system','direct','custom'].includes(config.mode))throw new NetworkError('NET_POLICY');
  if(input.proxyUrl)config.proxyUrl=endpoint(input.proxyUrl,{proxy:true});
  if(config.mode==='custom'&&!config.proxyUrl)throw new NetworkError('NET_POLICY');
  if(input.noProxy!==undefined){if(typeof input.noProxy!=='string'||input.noProxy.length>2048||!/^[\w.,:*\-\[\] ]*$/.test(input.noProxy))throw new NetworkError('NET_POLICY');config.noProxy=input.noProxy.trim();}
  for(const key of ['pypiIndex','npmRegistry'])if(input[key])config[key]=endpoint(input[key]);
  if(input.assetMirrors!==undefined){
    if(!Array.isArray(input.assetMirrors)||input.assetMirrors.length>16)throw new NetworkError('NET_POLICY');
    config.assetMirrors=input.assetMirrors.map(pair=>{
      if(!pair||typeof pair!=='object'||Object.keys(pair).some(key=>!['from','to'].includes(key)))throw new NetworkError('NET_POLICY');
      const from=endpoint(pair.from),to=endpoint(pair.to);
      if(!from.endsWith('/')||!to.endsWith('/'))throw new NetworkError('NET_POLICY');
      return {from,to};
    });
  }
  return config;
}
async function readNetworkConfig() {
  // Desktop routing always follows the operating system (including Clash).
  return normalizeNetworkConfig();
}
async function systemProxyURL(session) {
  if(typeof session?.resolveProxy!=='function')return '';
  let timer;
  try {
    const rules=await Promise.race([session.resolveProxy('https://github.com/'),new Promise(resolve=>{timer=setTimeout(()=>resolve('DIRECT'),3000);})]);
    const first=String(rules).split(';')[0].trim();
    if(first==='DIRECT')return '';
    const match=first.match(/^(PROXY|HTTPS)\s+([^\s;]+)$/i);
    if(!match)return '';
    return endpoint(`${match[1].toUpperCase()==='HTTPS'?'https':'http'}://${match[2]}`,{proxy:true});
  } catch {return '';}
  finally{clearTimeout(timer);}
}
async function writeNetworkConfig(runtime,input) {
  const config=normalizeNetworkConfig(input),file=path.join(runtime,'network.json'),temporary=path.join(runtime,'network.json.tmp');
  try{await fs.mkdir(runtime,{recursive:true});}catch{throw new NetworkError('NET_POLICY');}
  for(const target of [file,temporary])try{if((await fs.lstat(target)).isSymbolicLink())throw new NetworkError('NET_POLICY');}catch(error){if(error.code!=='ENOENT')throw new NetworkError('NET_POLICY');}
  try{await fs.writeFile(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600});await fs.chmod(temporary,0o600);await fs.rename(temporary,file);return config;}
  catch{throw new NetworkError('NET_POLICY');}
}
function networkEnvironment(input={},base=process.env) {
  const config=normalizeNetworkConfig(input),env={...base};
  if(config.mode!=='system')for(const key of Object.keys(env))if(/^(https?|all|no)_proxy$/i.test(key))delete env[key];
  if(config.mode==='custom')Object.assign(env,{HTTP_PROXY:config.proxyUrl,HTTPS_PROXY:config.proxyUrl,http_proxy:config.proxyUrl,https_proxy:config.proxyUrl});
  const bypass=config.noProxy||(config.mode==='custom'?'localhost,127.0.0.1,::1':'');
  if(bypass)Object.assign(env,{NO_PROXY:bypass,no_proxy:bypass});
  if(config.pypiIndex){for(const key of ['PIP_EXTRA_INDEX_URL','UV_EXTRA_INDEX_URL','UV_INDEX','UV_INDEX_URL'])delete env[key];Object.assign(env,{UV_DEFAULT_INDEX:config.pypiIndex,PIP_INDEX_URL:config.pypiIndex});}
  if(config.npmRegistry)Object.assign(env,{NPM_CONFIG_REGISTRY:config.npmRegistry,npm_config_registry:config.npmRegistry});
  return env;
}
function resolveAssetUrl(canonical,input={}) {
  const config=normalizeNetworkConfig(input),url=endpoint(canonical);
  const pair=[...config.assetMirrors].sort((a,b)=>b.from.length-a.from.length).find(item=>url.startsWith(item.from));
  return pair?pair.to+url.slice(pair.from.length):url;
}
function classifySource(value) {
  let host;try{host=new URL(value).hostname.toLowerCase();}catch{return 'other';}
  if(['github.com','api.github.com','objects.githubusercontent.com','release-assets.githubusercontent.com'].includes(host))return 'github';
  if(['pypi.org','files.pythonhosted.org'].includes(host))return 'pypi';
  if(host==='registry.npmjs.org')return 'npm';if(host==='nodejs.org')return 'nodejs';
  if(host==='python.org'||host.endsWith('.python.org'))return 'python';
  if(['ffmpeg.org','ffmpeg.martin-riedl.de','www.gyan.dev','evermeet.cx'].includes(host))return 'ffmpeg';
  return 'other';
}
function safeNetworkError(error,source='other') {
  if(error instanceof NetworkError)return new NetworkError(error.code,error.source==='other'?source:error.source);
  const code=String(error?.code||error?.cause?.code||'');
  const name=String(error?.name||'');
  if(name==='AbortError')return new NetworkError('NET_CANCELLED',source);
  if(name==='TimeoutError'||/TIMEOUT|TIMEDOUT/.test(code))return new NetworkError('NET_TIMEOUT',source);
  if(/PROXY|TUNNEL/.test(code))return new NetworkError('NET_PROXY',source);
  if(/ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED/.test(code))return new NetworkError('NET_DNS',source);
  if(/CERT|SSL|TLS/.test(code))return new NetworkError('NET_TLS',source);
  return new NetworkError('NET_INTERRUPTED',source);
}
function createElectronTransport(session,{env={}}={}) {
  if(typeof session?.setProxy!=='function'||typeof session?.fetch!=='function')throw new NetworkError('NET_POLICY');
  let previous='',queue=Promise.resolve();
  const chromium=typeof session.webRequest?.onBeforeRequest==='function';
  let activePolicy=null;
  if(chromium)session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    let safe=false;
    try{const target=new URL(details.url);safe=target.protocol==='https:'&&!target.username&&!target.password;}catch{}
    if(!safe||!activePolicy||++activePolicy.hops>6){if(activePolicy)activePolicy.error=new NetworkError(safe?'NET_HTTP':'NET_POLICY');callback({cancel:true});}
    else callback({cancel:false});
  });
  return (url,options={})=>{
    const execute=async()=>{
      const config=normalizeNetworkConfig(options.network||{});let routing={mode:config.mode==='direct'?'direct':'system'};
      let proxy=config.mode==='custom'?config.proxyUrl:'';
      if(config.mode==='system')try{const value=env.HTTPS_PROXY||env.https_proxy||env.HTTP_PROXY||env.http_proxy||env.ALL_PROXY||env.all_proxy;if(value)proxy=endpoint(value,{proxy:true});}catch{}
      if(proxy)routing={mode:'fixed_servers',proxyRules:proxy.replace(/\/$/,''),proxyBypassRules:config.noProxy||(config.mode==='custom'?'localhost,127.0.0.1,[::1]':env.NO_PROXY||env.no_proxy||'<local>')};
      const next=JSON.stringify(routing);if(next!==previous){if(previous)await session.closeAllConnections?.();await session.setProxy(routing);previous=next;}
      const {network:ignored,...fetchOptions}=options;
      let target;try{target=new URL(url);}catch{throw new NetworkError('NET_POLICY');}
      if(target.protocol!=='https:'||target.username||target.password)throw new NetworkError('NET_POLICY');
      // Chromium fetch cannot return manual redirects and Response.url is not
      // reliable. Guard every hop at the dedicated session's request boundary.
      if(chromium){
        const policy={hops:0,error:null};activePolicy=policy;
        try{return await session.fetch(target.href,{...fetchOptions,redirect:options.redirect||'follow'});}
        catch(error){throw policy.error||error;}
        finally{activePolicy=null;}
      }
      // Injected standards-compliant fetch implementations can inspect redirects.
      for(let hops=0;hops<=5;hops++){
        if(target.protocol!=='https:'||target.username||target.password)throw new NetworkError('NET_POLICY');
        const response=await session.fetch(target.href,{...fetchOptions,redirect:'manual'});
        if(![301,302,303,307,308].includes(response.status)||options.redirect==='manual')return response;
        if(options.redirect==='error'||hops===5)throw new NetworkError('NET_HTTP');
        const location=response.headers.get('location');if(!location)throw new NetworkError('NET_HTTP');
        await response.body?.cancel();
        try{target=new URL(location,target);}catch{throw new NetworkError('NET_POLICY');}
      }
    };
    const result=queue.then(execute).catch(error=>{throw safeNetworkError(error,classifySource(url));});
    queue=result.then(()=>{},()=>{});return result;
  };
}
module.exports={NetworkError,normalizeNetworkConfig,readNetworkConfig,writeNetworkConfig,networkEnvironment,resolveAssetUrl,classifySource,safeNetworkError,createElectronTransport,systemProxyURL};
