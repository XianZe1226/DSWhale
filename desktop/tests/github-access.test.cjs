const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
let helper={};try{helper=require('./github-access.cjs');}catch{}
test('CI read token is removed before installers and scoped only to extension checks',async()=>{
 assert.equal(typeof helper.takeReadToken,'function');
 const environment={GITHUB_ACTIONS:'true',DSWHALE_SMOKE_GITHUB_TOKEN:'synthetic_ci_read_token'};
 const token=helper.takeReadToken(environment);assert.equal(environment.DSWHALE_SMOKE_GITHUB_TOKEN,undefined);
 let call;const runner=helper.extensionRunner(async(...args)=>{call=args;return Buffer.from('ok');},token);
 await runner('python',['-m','other'],{env:{PATH:'fixture'}});assert.equal(call[2].env.DSWHALE_SMOKE_GITHUB_TOKEN,undefined);
 await runner('python',['-m','dswhale.extensions','--host','fixture','check','--id','memes'],{env:{PATH:'fixture'}});
 assert.equal(call[1][0],'-c');assert.equal(call[2].env.DSWHALE_SMOKE_GITHUB_TOKEN,token);assert.equal(call[2].env.PATH,'fixture');
 const outside={DSWHALE_SMOKE_GITHUB_TOKEN:'synthetic_ci_read_token'};assert.equal(helper.takeReadToken(outside),'');assert.equal(outside.DSWHALE_SMOKE_GITHUB_TOKEN,undefined);
});
test('Python test adapter authenticates only allowlisted API reads and removes token before plugin work',()=>{
 assert.equal(typeof helper.ENTRYPOINT,'string');
 const prelude=`import sys,types,os,json,httpx\nseen=[]\ndef handler(request):\n    seen.append(request.headers.get('authorization')=='Bearer synthetic_ci_read_token')\n    assert 'DSWHALE_SMOKE_GITHUB_TOKEN' not in os.environ\n    return httpx.Response(200,json={})\nfake=types.ModuleType('dswhale.extensions')\nfake._client=lambda:httpx.Client(transport=httpx.MockTransport(handler))\ndef main():\n    assert 'DSWHALE_SMOKE_GITHUB_TOKEN' not in os.environ\n    with fake._client() as client:\n        for url in ['https://api.github.com/repos/anka-afk/astrbot_plugin_meme_manager/releases/latest','https://api.github.com/repos/unrelated/repository/releases/latest','https://codeload.github.com/anka-afk/astrbot_plugin_meme_manager/zip/fake']:\n            client.get(url)\n    print(json.dumps(seen))\n    return 0\nfake.main=main\nsys.modules['dswhale.extensions']=fake\n`;
 const python=process.env.DSWHALE_BUILD_PYTHON||(process.platform==='win32'?'python':'python3');
 const result=spawnSync(python,['-c',prelude+helper.ENTRYPOINT],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,DSWHALE_SMOKE_GITHUB_TOKEN:'synthetic_ci_read_token'},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),[true,false,false]);assert.ok(!result.stdout.includes('synthetic_ci_read_token'));
});
test('CI upstream diagnostics preserve only numeric response details without leaking response data',async()=>{
 const reports=[];
 const raw=Buffer.from(JSON.stringify({ok:false,error:'fixed safe error',_ciUpstream:[{status:404,remaining:4999,endpoint:'release',token:'synthetic_secret'},{status:502,remaining:null,endpoint:'commit'},{status:'raw secret',remaining:-1,endpoint:'https://private/path'}]}));
 const runner=helper.extensionRunner(async()=>raw,'synthetic_ci_read_token',value=>reports.push(value));
 const value=JSON.parse((await runner('python',['-m','dswhale.extensions'],{env:{}})).toString());
 assert.deepEqual(value,{ok:false,error:'fixed safe error'});
 assert.deepEqual(reports,[{status:404,remaining:4999,endpoint:'release'},{status:502,remaining:null,endpoint:'commit'}]);
 assert.ok(!JSON.stringify(reports).includes('synthetic_secret'));
});
