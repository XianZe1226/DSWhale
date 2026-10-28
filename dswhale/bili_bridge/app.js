(()=>{
  const key='dswhale-local-token';
  const token=new URLSearchParams(location.hash.slice(1)).get('token')||sessionStorage.getItem(key)||'';
  if(token){sessionStorage.setItem(key,token);history.replaceState(null,'',location.pathname);}
  const originalFetch=window.fetch.bind(window);
  window.fetch=(input,options={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.origin);
    if(url.origin!==location.origin)throw Error('Only local API requests are allowed');
    const headers=new Headers(options.headers);headers.set('Authorization','Bearer '+token);
    return originalFetch(input,{...options,headers});
  };
  window.__ModuleLoader__={load({factory}){
    const mod=factory(name=>{if(name==='react')return window.React;throw Error('Unsupported module');});
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(mod.BiliWhaleSection));
  }};
  document.getElementById('execute').onclick=async()=>{
    const out=document.getElementById('result');out.textContent='处理中…';
    try{const args=JSON.parse(document.getElementById('command').value);const r=await fetch('/dswhale/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({args})});out.textContent=JSON.stringify(await r.json(),null,2);}catch{out.textContent='请检查参数 JSON 格式与本机连接。';}
  };
})();
