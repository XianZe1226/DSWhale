#!/usr/bin/env python3
"""Actual SDK/storage preservation with deterministic test embeddings, no providers/UI."""

import argparse
import asyncio
import hashlib
import json
import os
import sqlite3
import sys
import time
import traceback
import uuid
from importlib.metadata import version
from pathlib import Path

from profile_contract import (
    MEMORIES,
    PERSONAS,
    SCENARIOS,
    assert_same,
    authorize_paths,
    canonical,
    deny_fixture_network,
    digest,
    ensure_marker,
    protect,
    require_existing_storage,
    validate_index,
    validate_records,
    validate_scenario,
)


class Embedding:
    """Deliberate storage test double, never reported as a real model provider."""

    def get_dim(self):
        return 8

    async def get_embedding(self, text):
        return [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

    async def get_embeddings_batch(self, contents, **kwargs):
        return [await self.get_embedding(c) for c in contents]


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, value, *, exclusive=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x" if exclusive else "w", encoding="utf-8") as stream:
        stream.write(canonical(value))


async def build_config(host, scenario):
    from astrbot.core.config import AstrBotConfig

    from dswhale.desktop_settings import save_settings

    cfg = AstrBotConfig()
    cfg["provider_sources"] = [
        {
            "id": "synthetic-source",
            "provider": "openai",
            "type": "openai_chat_completion",
            "provider_type": "chat_completion",
            "enable": True,
            "key": [],
            "api_base": "http://127.0.0.1:9/v1",
            "timeout": 2,
            "proxy": "",
            "custom_headers": {},
        }
    ]
    cfg["provider"] = [
        {
            "id": "synthetic-model",
            "provider_source_id": "synthetic-source",
            "model": "synthetic-chat",
            "enable": True,
            "modalities": [],
            "custom_extra_body": {"acceptance": {"flag": False, "zero": 0, "empty": ""}},
        }
    ]
    cfg["agent_runner"] = {"config": {"model": {"provider_id": "synthetic-model"}}}
    cfg["platform"] = []
    if scenario in ("official-only", "dual-enabled"):
        cfg["platform"].append(
            {
                "id": "synthetic-official",
                "type": "qq_official",
                "enable": True,
                "appid": "synthetic-appid",
                "secret": "synthetic-secret",
                "token": "synthetic-token",
            }
        )
    cfg.save_config()
    if scenario in ("small-only", "dual-enabled"):
        save_settings(
            host,
            {
                "ownerQQ": "12345678",
                "platformId": "synthetic-small",
                "onebotPort": 6199,
                "onebotToken": "synthetic-onebot-token-1234567890",
                "qqConnectionMode": "napcat",
            },
        )
    if scenario in ("official-only", "dual-enabled"):
        scope = "synthetic-official:FriendMessage:OPAQUE"

        write_json(
            Path(host) / "data/plugin_data/astrbot_plugin_dswhale/official-c2c.json",
            [hashlib.sha256(scope.encode()).hexdigest()],
        )
        save_settings(
            host,
            {
                "officialOwnerUMO": scope,
                "qqConnectionMode": "official",
                "defaultDelivery": "official",
            },
        )
    if scenario == "official-only":
        cfg = AstrBotConfig()
        cfg["platform"].append(
            {
                "id": "synthetic-small",
                "type": "aiocqhttp",
                "enable": False,
                "ws_reverse_host": "127.0.0.1",
                "ws_reverse_port": 6199,
                "ws_reverse_token": "synthetic-onebot-token-1234567890",
            }
        )
        cfg.save_config()
    if scenario in ("small-only", "dual-enabled"):
        cfg = AstrBotConfig()
        for platform in cfg.get("platform", []):
            if platform.get("id") == "synthetic-small":
                platform["enable"] = True
        cfg.save_config()
        if scenario == "small-only":
            save_settings(host, {"defaultDelivery": "napcat"})
    fish_path = Path(host) / "data/config/astrbot_plugin_dswhale_config.json"
    fish = load(fish_path) if fish_path.exists() else {}
    for key, default in {
        "owner_qq": "",
        "owner_umo": "",
        "official_owner_umo": "",
        "qq_connection_mode": "napcat",
        "qq_default_delivery": "",
        "proactive_enabled": False,
        "qq_signature_enabled": False,
        "qzone_enabled": False,
        "bili_enabled": False,
    }.items():
        fish.setdefault(key, default)
    write_json(fish_path, fish)
    memory = Path(host) / "data/config/astrbot_plugin_livingmemory_config.json"
    # Storage-only fixture: no dangling or fake claim of a configured provider.
    write_json(
        memory,
        {
            "provider_settings": {
                "embedding_provider_id": "",
                "llm_provider_id": "",
                "llm_stream_mode": "auto",
            }
        },
    )


async def storage(host, seed):
    import faiss
    from astrbot.core.config import AstrBotConfig
    from astrbot.core.db.sqlite import SQLiteDatabase
    from astrbot.core.db.vec_db.faiss_impl.vec_db import FaissVecDB
    from astrbot_plugin_livingmemory.core.managers.memory_engine import MemoryEngine

    from dswhale.desktop_settings import read_settings

    data = host / "data"
    # Real SDK first read, not merely json.load of the config file.
    cfg = AstrBotConfig()
    db = SQLiteDatabase(str(data / "data_v4.db"))
    await db.initialize()
    directory = data / "plugin_data/astrbot_plugin_livingmemory"
    directory.mkdir(parents=True, exist_ok=True)
    doc = FaissVecDB(
        str(directory / "livingmemory.db"), str(directory / "livingmemory.index"), Embedding()
    )
    graph = FaissVecDB(
        str(directory / "livingmemory_graph_documents.db"),
        str(directory / "livingmemory_graph.index"),
        Embedding(),
    )
    engine = None
    try:
        await doc.initialize()
        await graph.initialize()
        engine = MemoryEngine(
            str(directory / "livingmemory.db"),
            doc,
            graph_vector_db=graph,
            config={"recent_memory_count": 0, "graph_memory_enabled": False},
        )
        await engine.initialize()
        if seed:
            for persona in PERSONAS:
                await db.insert_persona(**persona)
            for cid, pid, platform, body in [
                (
                    "synthetic-conversation-a",
                    "synthetic-persona-a",
                    "synthetic-small",
                    "synthetic conversation one",
                ),
                (
                    "synthetic-conversation-b",
                    "synthetic-persona-b",
                    "synthetic-official",
                    "synthetic conversation two",
                ),
            ]:
                await db.create_conversation(
                    "synthetic-user",
                    platform,
                    [{"role": "user", "content": body}],
                    title=body,
                    persona_id=pid,
                    cid=cid,
                )
            for body, pid in MEMORIES:
                await engine.add_memory(
                    content=body,
                    session_id="synthetic-session",
                    persona_id=pid,
                    importance=0.8,
                    metadata={"canonical_summary": body},
                )
        personas = [{key: getattr(p, key) for key in PERSONAS[0]} for p in await db.get_personas()]
        conversations = [
            {
                key: getattr(c, key)
                for key in (
                    "conversation_id",
                    "persona_id",
                    "user_id",
                    "platform_id",
                    "title",
                    "content",
                )
            }
            for c in await db.get_conversations(user_id="synthetic-user")
        ]
        documents = await doc.document_storage.get_documents({})
        selected = []
        for d in documents:
            metadata = d.get("metadata") or {}
            if isinstance(metadata, str):
                metadata = json.loads(metadata)
            selected.append(
                {
                    "id": int(d["id"]),
                    "doc_id": d["doc_id"],
                    "text": d["text"],
                    "metadata": {
                        k: metadata.get(k)
                        for k in (
                            "persona_id",
                            "session_id",
                            "status",
                            "importance",
                            "canonical_summary",
                        )
                    },
                }
            )
        direct = await doc.retrieve("synthetic acceptance memory", k=2)
        index = doc.embedding_storage.index
        index_state = {
            "dimension": int(index.d),
            "count": int(index.ntotal),
            "ids": sorted(map(int, faiss.vector_to_array(index.id_map))),
            "fileSha256": hashlib.sha256(
                (directory / "livingmemory.index").read_bytes()
            ).hexdigest(),
        }
        validate_index(index_state, selected, [r.data["doc_id"] for r in direct])
        settings = read_settings(host)
        settings.pop("configRevision", None)  # Raw-byte revision may change during valid migration.
        return protect(
            {
                "platforms": sorted(cfg.get("platform", []), key=lambda p: p["id"]),
                "provider_sources": cfg.get("provider_sources", []),
                "provider": cfg.get("provider", []),
                "agent_runner": cfg.get("agent_runner"),
                "settings": settings,
                "raw_bindings": {
                    key: load(data / "config/astrbot_plugin_dswhale_config.json")[key]
                    for key in (
                        "owner_qq",
                        "owner_umo",
                        "official_owner_umo",
                        "qq_connection_mode",
                        "qq_default_delivery",
                        "proactive_enabled",
                        "qq_signature_enabled",
                        "qzone_enabled",
                        "bili_enabled",
                    )
                },
                "memory_config": load(data / "config/astrbot_plugin_livingmemory_config.json"),
                "personas": sorted(personas, key=lambda p: p["persona_id"]),
                "conversations": sorted(conversations, key=lambda c: c["conversation_id"]),
                "documents": sorted(selected, key=lambda d: d["doc_id"]),
                "index": index_state,
                "marker": ensure_marker(data, seed=False),
            }
        )
    finally:
        if engine is not None:
            await engine.close()
        else:
            await graph.close()
        await doc.close()
        await db.engine.dispose()


def integrity(host):
    for rel in ["data/data_v4.db", "data/plugin_data/astrbot_plugin_livingmemory/livingmemory.db"]:
        with sqlite3.connect((host / rel).as_uri() + "?mode=ro", uri=True) as db:
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("synthetic SQLite integrity check failed")


def refuse_existing_baseline(path):
    if Path(path).exists():
        raise ValueError("refusing to overwrite an existing seed baseline")


def parse_args():
    parser = argparse.ArgumentParser()
    for name in ("host", "root", "baseline", "out"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--scenario", choices=SCENARIOS, required=True)
    parser.add_argument(
        "--action",
        choices=(
            "seed",
            "verify",
            "acl-probe",
            "acl-probe-no-audit",
            "acl-probe-sync",
            "acl-probe-no-audit-sync",
            "acl-probe-idle-loop",
        ),
        required=True,
    )
    return parser.parse_args()


def prepare_fixture(args):
    root, host = Path(args.root), Path(args.host)
    authorize_paths(root, host, args.baseline, args.out, args.scenario)
    seed = args.action == "seed"
    if seed:
        refuse_existing_baseline(args.baseline)
    if args.action == "verify":
        require_existing_storage(host)  # Fail before SDK constructors can recreate a missing file.
        ensure_marker(host / "data", seed=False)
    os.environ["ASTRBOT_ROOT"] = str(host)
    os.chdir(host)
    network = (
        {"mode": "diagnostic-api-only-no-python-audit"}
        if args.action in ("acl-probe-no-audit", "acl-probe-no-audit-sync")
        else deny_fixture_network(
            data_root=host / "data", backup_root=host / ".desktop-settings-backups"
        )
    )
    return host, network


def run_acl_probe(args, host, network):
    if os.name != "nt":
        raise ValueError("ACL diagnostic is Windows-only")
    import ctypes
    import msvcrt

    from dswhale import private_files

    ensure_private_directory = private_files.ensure_private_directory

    stdin_type = int(ctypes.windll.kernel32.GetFileType(ctypes.c_void_p(msvcrt.get_osfhandle(0))))
    try:
        asyncio.get_running_loop()
        loop_active = True
    except RuntimeError:
        loop_active = False
    started = time.monotonic()
    try:
        ensure_private_directory(
            host / ".desktop-settings-backups" / ("acl-probe-" + uuid.uuid4().hex)
        )
    except Exception as error:
        error.stdinType = stdin_type
        error.eventLoopActive = loop_active
        raise
    result = {
        "kind": "DSWhaleSyntheticAclProbe",
        "apiCompleted": True,
        "stdinType": stdin_type,
        "pythonVersion": list(sys.version_info[:3]),
        "privateApiSha256": hashlib.sha256(Path(private_files.__file__).read_bytes()).hexdigest(),
        "eventLoopActive": loop_active,
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "networkGuard": network,
    }
    write_json(args.out, result)
    print(canonical(result), flush=True)


async def main(args):
    host, network = prepare_fixture(args)
    if args.action.startswith("acl-probe"):
        run_acl_probe(args, host, network)
        return
    seed = args.action == "seed"
    if seed:
        ensure_marker(host / "data", seed=True)
        await build_config(host, args.scenario)
    snapshot = await storage(host, seed)
    validate_records(snapshot)
    validate_scenario(snapshot, args.scenario)
    integrity(host)
    if seed:
        write_json(
            args.baseline,
            {"schemaVersion": 1, "scenario": args.scenario, "snapshot": snapshot},
            exclusive=True,
        )
    else:
        baseline = load(args.baseline)
        if baseline.get("schemaVersion") != 1 or baseline.get("scenario") != args.scenario:
            raise ValueError("baseline identity mismatch")
        assert_same(baseline["snapshot"], snapshot)
    result = {
        "schemaVersion": 2,
        "sdkVersion": version("astrbot"),
        "backendVersion": version("dswhale"),
        "kind": "DSWhaleSyntheticStorageReadback",
        "scenario": args.scenario,
        "action": args.action,
        "embeddingMode": "deterministic-storage-test-double",
        "snapshotSha256": digest(snapshot),
        "counts": {
            "personas": len(snapshot["personas"]),
            "conversations": len(snapshot["conversations"]),
            "memories": len(snapshot["documents"]),
            "vectors": snapshot["index"]["count"],
        },
        "baselineMatched": not seed,
        "sqliteIntegrity": "ok",
        "markerPreserved": True,
        "networkGuard": network,
    }
    write_json(args.out, result)
    print(canonical(result), flush=True)


if __name__ == "__main__":
    try:
        arguments = parse_args()
        if arguments.action in ("acl-probe-sync", "acl-probe-no-audit-sync"):
            synthetic_host, guard = prepare_fixture(arguments)
            run_acl_probe(arguments, synthetic_host, guard)
        elif arguments.action == "acl-probe-idle-loop":
            idle_loop = asyncio.new_event_loop()
            try:
                synthetic_host, guard = prepare_fixture(arguments)
                run_acl_probe(arguments, synthetic_host, guard)
            finally:
                idle_loop.close()
        else:
            asyncio.run(main(arguments))
    except Exception as error:
        frames = traceback.extract_tb(error.__traceback__)[-5:]
        causes = []
        cause = error.__cause__
        for _ in range(3):
            if cause is None:
                break
            causes.append(
                {
                    "errorClass": type(cause).__name__,
                    "timeoutSeconds": getattr(cause, "timeout", None)
                    if isinstance(getattr(cause, "timeout", None), (int, float))
                    else None,
                    "errno": getattr(cause, "errno", None)
                    if isinstance(getattr(cause, "errno", None), int)
                    else None,
                    "returncode": getattr(cause, "returncode", None)
                    if isinstance(getattr(cause, "returncode", None), int)
                    else None,
                }
            )
            cause = cause.__cause__
        diagnostic = {
            "kind": "DSWhaleFixtureFailure",
            "stdinType": getattr(error, "stdinType", None),
            "eventLoopActive": getattr(error, "eventLoopActive", None),
            "causes": causes,
            "errorClass": type(error).__name__,
            "code": getattr(error, "code", "FIXTURE_REJECTED"),
            "fields": getattr(error, "fields", []),
            "frames": [
                {"file": Path(frame.filename).name, "line": frame.lineno, "function": frame.name}
                for frame in frames
            ],
        }
        print(canonical(diagnostic), file=sys.stderr, flush=True)
        raise SystemExit(1) from None
