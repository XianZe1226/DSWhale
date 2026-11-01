'use strict';
// CI-only read access. Never shipped in app.asar or passed to installers.
const ENTRYPOINT=String.raw`
import os, sys, json
token = os.environ.pop('DSWHALE_SMOKE_GITHUB_TOKEN', '')
from dswhale import extensions
original = extensions._client
prefixes = ('/repos/anka-afk/astrbot_plugin_meme_manager/', '/repos/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/')
def authorize(request):
    if request.url.scheme == 'https' and request.url.host == 'api.github.com' and request.url.path.startswith(prefixes):
        request.headers['Authorization'] = 'Bearer ' + token
def report(response):
    if response.request.url.host == 'api.github.com' and response.status_code != 200:
        remaining = response.headers.get('x-ratelimit-remaining', '')
        print(json.dumps({'upstreamApiStatus': response.status_code, 'remainingRequests': int(remaining) if remaining.isdigit() else None}), file=sys.stderr)
def client():
    value = original()
    value.event_hooks['request'].append(authorize)
    value.event_hooks['response'].append(report)
    return value
extensions._client = client
raise SystemExit(extensions.main())
`;
function takeReadToken(environment=process.env){
 const value=environment.DSWHALE_SMOKE_GITHUB_TOKEN;delete environment.DSWHALE_SMOKE_GITHUB_TOKEN;
 return environment.GITHUB_ACTIONS==='true'&&typeof value==='string'&&/^[A-Za-z0-9_]{1,2048}$/.test(value)?value:'';
}
function extensionRunner(runner,token){
 return (command,args,options)=>token&&args[0]==='-m'&&args[1]==='dswhale.extensions'
  ?runner(command,['-c',ENTRYPOINT,...args.slice(2)],{...options,env:{...options.env,DSWHALE_SMOKE_GITHUB_TOKEN:token}})
  :runner(command,args,options);
}
module.exports={ENTRYPOINT,takeReadToken,extensionRunner};
