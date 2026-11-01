'use strict';
// CI-only read access. Never shipped in app.asar or passed to installers.
const ENTRYPOINT=String.raw`
import os, sys, json, io, contextlib
token = os.environ.pop('DSWHALE_SMOKE_GITHUB_TOKEN', '')
from dswhale import extensions
original = extensions._client
prefixes = ('/repos/anka-afk/astrbot_plugin_meme_manager/', '/repos/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/')
def authorize(request):
    if request.url.scheme == 'https' and request.url.host == 'api.github.com' and request.url.path.startswith(prefixes):
        request.headers['Authorization'] = 'Bearer ' + token
diagnostics = []
def report(response):
    if response.request.url.host == 'api.github.com' and response.status_code != 200:
        remaining = response.headers.get('x-ratelimit-remaining', '')
        diagnostics.append({'status': response.status_code, 'remaining': int(remaining) if remaining.isdigit() else None, 'endpoint': 'release' if response.request.url.path.endswith('/releases/latest') else 'commit'})
def client():
    value = original()
    value.event_hooks['request'].append(authorize)
    value.event_hooks['response'].append(report)
    return value
extensions._client = client
output = io.StringIO()
with contextlib.redirect_stdout(output):
    result = extensions.main()
value = json.loads(output.getvalue())
if isinstance(value, dict):
    value['_ciUpstream'] = diagnostics[:4]
print(json.dumps(value, ensure_ascii=False))
raise SystemExit(result)
`;
function takeReadToken(environment=process.env){
 const value=environment.DSWHALE_SMOKE_GITHUB_TOKEN;delete environment.DSWHALE_SMOKE_GITHUB_TOKEN;
 return environment.GITHUB_ACTIONS==='true'&&typeof value==='string'&&/^[A-Za-z0-9_]{1,2048}$/.test(value)?value:'';
}
function extensionRunner(runner,token,report=value=>console.error('CI upstream API:',JSON.stringify(value))){
 return async(command,args,options)=>{
  if(!token||args[0]!=='-m'||args[1]!=='dswhale.extensions')return runner(command,args,options);
  const raw=await runner(command,['-c',ENTRYPOINT,...args.slice(2)],{...options,env:{...options.env,DSWHALE_SMOKE_GITHUB_TOKEN:token}});
  let value;try{value=JSON.parse(raw.toString('utf8'));}catch{return raw;}
  if(!value||typeof value!=='object'||Array.isArray(value))return raw;
  if(Array.isArray(value._ciUpstream))for(const item of value._ciUpstream.slice(0,4)){
   if(item&&Number.isInteger(item.status)&&item.status>=100&&item.status<=599&&(item.remaining===null||Number.isSafeInteger(item.remaining)&&item.remaining>=0)&&['release','commit'].includes(item.endpoint))report({status:item.status,remaining:item.remaining,endpoint:item.endpoint});
  }
  delete value._ciUpstream;return Buffer.from(JSON.stringify(value));
 };
}
module.exports={ENTRYPOINT,takeReadToken,extensionRunner};
