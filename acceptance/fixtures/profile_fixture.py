#!/usr/bin/env python3
"""Synthetic a11/a12 SDK fixture driver for acceptance-only use."""
import argparse, asyncio, hashlib, json, os, sys
from pathlib import Path

SCENARIOS = ('small-only', 'official-only', 'dual-enabled', 'fresh-unconfigured')
MARKER = 'SYNTHETIC-DEVICE-DATA-NOT-AN-ACCOUNT'

class Embedding:
    def get_dim(self): return 8
    async def get_embedding(self, text): return [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
    async def get_embeddings_batch(self, contents, **kwargs): return [await self.get_embedding(c) for c in contents]

def load(path, default=None):
    try: return json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except FileNotFoundError: return {} if default is None else default

def atomic_json(path, value):
    p=Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    tmp=p.with_name(p.name+'.tmp'); tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8'); tmp.replace(p)

def official_c2c(host, scope):
    directory=Path(host)/'data/plugin_data/astrbot_plugin_dswhale'
    directory.mkdir(parents=True, exist_ok=True)
    atomic_json(directory/'official-c2c.json', [hashlib.sha256(scope.encode()).hexdigest()])

def platform(id, type, enable=True, **extra):
    value={'id':id,'type':type,'enable':enable}; value.update(extra); return value

def source():
    return {'id':'synthetic-source','provider':'openai','type':'openai_chat_completion','provider_type':'chat_completion','enable':True,'key':[],'api_base':'http://127.0.0.1:9/v1','timeout':2,'proxy':'','custom_headers':{}}

def model():
    return {'id':'synthetic-model','provider_source_id':'synthetic-source','model':'synthetic-chat','enable':True,'modalities':[],'custom_extra_body':{}}

async def build_config(host, scenario):
    from astrbot.core.config import AstrBotConfig
    host=Path(host); cfg=AstrBotConfig()
    cfg['provider_sources']=[source()]; cfg['provider']=[model()]
    cfg['provider_settings']={}
    cfg['agent_runner']={'config':{'model':{'provider_id':'synthetic-model'}}}
    cfg['platform']=[]
    if scenario in ('official-only','dual-enabled'):
        cfg['platform'].append(platform('synthetic-official','qq_official',True,appid='synthetic-appid',secret='synthetic-secret',token='synthetic-token'))
    cfg.save_config()
    from dswhale.desktop_settings import save_settings
    if scenario in ('small-only','dual-enabled'):
        save_settings(host, {'ownerQQ':'12345678','platformId':'synthetic-small','onebotPort':6199,'onebotToken':'synthetic-onebot-token-1234567890','qqConnectionMode':'napcat'})
    if scenario in ('official-only','dual-enabled'):
        scope='synthetic-official:FriendMessage:OPAQUE'
        official_c2c(host, scope)
        save_settings(host, {'officialOwnerUMO':scope,'qqConnectionMode':'official','defaultDelivery':'official'})
    if scenario=='official-only':
        cfg2=AstrBotConfig(); platforms=cfg2.setdefault('platform',[])
        if not any(p.get('id')=='synthetic-small' for p in platforms):
            platforms.append(platform('synthetic-small','aiocqhttp',False,ws_reverse_host='127.0.0.1',ws_reverse_port=6199,ws_reverse_token='synthetic-onebot-token-1234567890'))
        cfg2.save_config()
    if scenario=='dual-enabled':
        cfg2=AstrBotConfig()
        for p in cfg2.get('platform',[]):
            if p.get('id')=='synthetic-small': p['enable']=True
        cfg2.save_config()
    if scenario in ('small-only','dual-enabled'):
        cfg2=AstrBotConfig()
        for p in cfg2.get('platform',[]):
            if p.get('id')=='synthetic-small': p['enable']=True
        cfg2.save_config()
        if scenario=='small-only':
            save_settings(host, {'defaultDelivery':'napcat'})
    if scenario=='fresh-unconfigured':
        cfg2=AstrBotConfig(); cfg2['platform']=[]; cfg2.save_config()
    return cfg

async def seed(host, scenario):
    from astrbot.core.db.sqlite import SQLiteDatabase
    from astrbot.core.db.vec_db.faiss_impl.vec_db import FaissVecDB
    from astrbot_plugin_livingmemory.core.managers.memory_engine import MemoryEngine
    host=Path(host); data=host/'data'; cfg=await build_config(host, scenario)
    db=SQLiteDatabase(str(data/'data_v4.db')); await db.initialize()
    for pid,prompt in [('synthetic-persona-a','Synthetic persona A for acceptance only.'),('synthetic-persona-b','Synthetic persona B for acceptance only.')]:
        try: await db.insert_persona(pid,prompt,[])
        except Exception: pass
    await db.create_conversation('synthetic-user','synthetic-small',[{'role':'user','content':'synthetic conversation one'}],title='synthetic conversation',persona_id='synthetic-persona-a')
    await db.create_conversation('synthetic-user','synthetic-official',[{'role':'user','content':'synthetic conversation two'}],title='synthetic official conversation',persona_id='synthetic-persona-b')
    plugin_dir=data/'plugin_data/astrbot_plugin_livingmemory'; plugin_dir.mkdir(parents=True, exist_ok=True)
    provider=Embedding()
    doc=FaissVecDB(str(plugin_dir/'livingmemory.db'),str(plugin_dir/'livingmemory.index'),provider)
    graph=FaissVecDB(str(plugin_dir/'livingmemory_graph_documents.db'),str(plugin_dir/'livingmemory_graph.index'),provider)
    await doc.initialize(); await graph.initialize(); engine=MemoryEngine(str(plugin_dir/'livingmemory.db'),doc,graph_vector_db=graph,config={'recent_memory_count':0,'graph_memory_enabled':True}); await engine.initialize()
    for content,persona in [('synthetic acceptance memory one','synthetic-persona-a'),('synthetic acceptance memory two','synthetic-persona-b')]:
        await engine.add_memory(content=content,session_id='synthetic-session',persona_id=persona,importance=0.8,metadata={'canonical_summary':content})
    (data/'config').mkdir(parents=True, exist_ok=True)
    atomic_json(data/'config/astrbot_plugin_livingmemory_config.json', {'provider_settings':{'embedding_provider_id':'synthetic-embedding','llm_provider_id':'','llm_stream_mode':'auto'}})
    await readback(host, scenario, seed=True)

async def readback(host, scenario, seed=False):
    from astrbot.core.db.sqlite import SQLiteDatabase
    from astrbot.core.db.vec_db.faiss_impl.vec_db import FaissVecDB
    from astrbot_plugin_livingmemory.core.managers.memory_engine import MemoryEngine
    from dswhale.desktop_settings import read_settings
    host=Path(host); data=host/'data'; cfg=load(data/'cmd_config.json')
    db=SQLiteDatabase(str(data/'data_v4.db')); await db.initialize()
    personas=[p.persona_id for p in await db.get_personas()]
    conversations=await db.get_conversations(user_id='synthetic-user')
    plugin_dir=data/'plugin_data/astrbot_plugin_livingmemory'; provider=Embedding()
    doc=FaissVecDB(str(plugin_dir/'livingmemory.db'),str(plugin_dir/'livingmemory.index'),provider)
    graph=FaissVecDB(str(plugin_dir/'livingmemory_graph_documents.db'),str(plugin_dir/'livingmemory_graph.index'),provider)
    await doc.initialize(); await graph.initialize(); engine=MemoryEngine(str(plugin_dir/'livingmemory.db'),doc,graph_vector_db=graph,config={'recent_memory_count':0,'graph_memory_enabled':True}); await engine.initialize()
    hits=await engine.search_memories(query='synthetic acceptance memory',k=3,session_id='synthetic-session')
    result={
      'scenario':scenario,'action':'seed' if seed else 'verify','asr_version':os.environ.get('DSWHALE_FIXTURE_VERSION',''),
      'platforms':[{'id':p.get('id'),'type':p.get('type'),'enable':p.get('enable'),'hasAppid':bool(p.get('appid')),'hasSecret':bool(p.get('secret')),'hasWsToken':bool(p.get('ws_reverse_token'))} for p in cfg.get('platform',[])],
      'provider_sources':[{k:p.get(k) for k in ('id','type','enable','api_base')} for p in cfg.get('provider_sources',[])],
      'provider':[{k:p.get(k) for k in ('id','provider_source_id','model','enable')} for p in cfg.get('provider',[])],
      'settings':read_settings(host),'personas':personas,'conversations':[{'conversation_id':c.conversation_id,'persona_id':c.persona_id,'user_id':c.user_id,'platform_id':c.platform_id,'title':c.title,'content':c.content} for c in conversations],
      'memory_hits':[{'content':h.content,'doc_id':h.doc_id,'metadata':h.metadata} for h in hits],
      'marker':(data/'synthetic-device-marker.txt').read_text(encoding='utf-8') if (data/'synthetic-device-marker.txt').exists() else None,
    }
    print(json.dumps(result, ensure_ascii=False, default=str))

async def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--host',required=True); parser.add_argument('--scenario',choices=SCENARIOS,required=True); parser.add_argument('--action',choices=('seed','verify'),required=True); parser.add_argument('--out',required=True)
    a=parser.parse_args(); os.environ['ASTRBOT_ROOT']=str(Path(a.host)); addr=os.path.join(a.host,'data'); (Path(addr)/'synthetic-device-marker.txt').write_text(MARKER,encoding='utf-8')
    if a.action=='seed': await seed(a.host,a.scenario)
    else: await readback(a.host,a.scenario)
    sys.stdout.flush(); os._exit(0)

asyncio.run(main())
