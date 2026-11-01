"""Offline, positive-field desktop checks and privacy-preserving diagnostics."""

import argparse
import hashlib
import importlib.metadata
import json
import os
import re
import tempfile
import time
import zipfile
from pathlib import Path

from . import __version__

CREDENTIALS_SHA256 = "00905567a2661eddc429d2598eb4cb208ce7097541a662ffffd4945546e69ce8"
EVENT_COMPONENTS = {"app", "runtime", "bilibili", "qq", "network", "update", "backup", "plugin"}
EVENT_ACTIONS = {
    "start",
    "stop",
    "install",
    "check",
    "download",
    "restore",
    "health",
    "export",
    "rollback",
    "resume",
}


def _load(path, root):
    path, root = Path(path), Path(root)
    for candidate in (path, *path.parents):
        if candidate == root:
            break
        if candidate.is_symlink():
            raise ValueError("配置目录不安全")
    if not path.exists():
        return {}
    if path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("配置大小不正确")
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("配置格式不正确")
    return value


def inspect_host(host, *, running=False, started_after=0):
    host = Path(host).resolve()
    checks = []

    def add(ident, name, ok, detail, *, code="", required=False, fix=""):
        checks.append(
            {
                "id": ident,
                "name": name,
                "ok": bool(ok),
                "detail": detail,
                "code": code,
                "required": required,
                "fix": fix,
            }
        )

    try:
        config = _load(host / "data/cmd_config.json", host)
        fish = _load(host / "data/config/astrbot_plugin_dswhale_config.json", host)
        memory = _load(host / "data/config/astrbot_plugin_livingmemory_config.json", host)
    except (OSError, ValueError, TypeError):
        add(
            "config",
            "本地配置",
            False,
            "配置无法读取，请检查备份后修复环境",
            code="CFG-001",
            required=True,
            fix="install",
        )
        config, fish, memory = {}, {}, {}
    else:
        add(
            "config",
            "本地配置",
            bool(config),
            "配置可读取" if config else "请先准备运行环境",
            required=True,
            code="" if config else "CFG-001",
            fix="install",
        )
    source = (
        host / "data/plugins/astrbot_plugin_dswhale/dswhale/bili_bridge/upstream/lib/credentials.js"
    )
    try:
        package_ok = (
            not source.is_symlink()
            and hashlib.sha256(source.read_bytes()).hexdigest() == CREDENTIALS_SHA256
        )
    except OSError:
        package_ok = False
    add(
        "bili-files",
        "B站桥接组件",
        package_ok,
        "公开源码组件校验通过" if package_ok else "桥接组件缺失或不完整，请修复环境",
        code="" if package_ok else "PKG-001",
        required=True,
        fix="install",
    )
    add(
        "owner",
        "私聊绑定",
        bool(fish.get("owner_qq") and fish.get("owner_umo")),
        "仅检查绑定是否存在，不显示账号",
        fix="connect",
    )
    platforms = [
        p
        for p in config.get("platform", [])
        if isinstance(p, dict) and p.get("type") == "aiocqhttp" and p.get("enable")
    ]
    add(
        "qq-config",
        "QQ 连接配置",
        bool(platforms and all(p.get("ws_reverse_token") for p in platforms)),
        "请核对反向连接端口；令牌不会显示在诊断中",
        fix="connect",
    )
    models = [
        p
        for p in config.get("provider", [])
        if isinstance(p, dict) and p.get("enable", True) and p.get("model")
    ]
    add(
        "models",
        "对话模型配置",
        bool(models),
        "仅检查配置存在，实际模型可用性需发送测试消息",
        fix="models",
    )
    basic = memory.get("basic_settings", memory.get("provider_settings", {}))
    basic = basic if isinstance(basic, dict) else {}
    embedding = basic.get("embedding_provider_id") or memory.get("embedding_provider_id")
    add(
        "memory",
        "长期记忆配置",
        bool(embedding),
        "保留原 Embedding 模型与维度，避免迁移期间重建索引",
        fix="memory",
    )
    try:
        runtime = _load(host / "data/plugin_data/astrbot_plugin_dswhale/health.json", host)
    except (OSError, ValueError, TypeError):
        runtime = {}
    fresh = isinstance(runtime.get("updatedAt"), (int, float)) and runtime["updatedAt"] >= max(
        started_after / 1000, time.time() - 90
    )
    add(
        "qq-connection",
        "QQ 协议连接",
        bool(running and fresh and runtime.get("qqConnected") is True),
        "协议在线仅代表连接已建立；请用 QQ 私聊完成收发验收",
        fix="connect",
    )
    enabled = fish.get("bili_enabled") is True
    ready = bool(running and fresh and runtime.get("biliReady") is True)
    add(
        "bili-service",
        "B站桥接服务",
        ready or not enabled,
        "未启用，可按需配置"
        if not enabled
        else "桥接已就绪；登录状态请在 B站页面确认"
        if ready
        else "服务未启动或仍在准备，可重新检查；组件不完整时请修复环境",
        code="BILI-001" if enabled and not ready else "",
        fix="bilibili",
    )
    return {
        "format": 1,
        "checks": checks,
        "summary": {
            "requiredFailures": sum(c["required"] and not c["ok"] for c in checks),
            "warnings": sum(not c["required"] and not c["ok"] for c in checks),
        },
    }


def safe_events(host):
    path = Path(host).parent / "logs/events.jsonl"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
        return []
    result = []
    for line in path.read_text(encoding="utf-8").splitlines()[-100:]:
        try:
            event = json.loads(line)
            if (
                event.get("component") not in EVENT_COMPONENTS
                or event.get("action") not in EVENT_ACTIONS
                or not re.fullmatch(r"[A-Z]{2,8}-[0-9]{3}", str(event.get("code", "")))
            ):
                continue
            date = str(event.get("at", ""))
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", date):
                continue
            result.append({key: event[key] for key in ("at", "code", "component", "action")})
        except (ValueError, TypeError, AttributeError):
            continue
    return result


def versions():
    result = {
        "dswhale": __version__,
        "python": ".".join(map(str, __import__("sys").version_info[:3])),
    }
    try:
        version = importlib.metadata.version("astrbot")
        result["astrbot"] = version if re.fullmatch(r"\d+\.\d+\.\d+", version) else "unknown"
    except importlib.metadata.PackageNotFoundError:
        result["astrbot"] = "not-installed"
    return result


def export_diagnostics(host, output):
    host, output = Path(host).resolve(), Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("请选择一个尚不存在的诊断包文件")
    docs = {
        "health.json": inspect_host(host),
        "events.json": safe_events(host),
        "versions.json": versions(),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(dir=output.parent, suffix=".diagnostic-tmp")
    try:
        with (
            os.fdopen(fd, "wb") as stream,
            zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive,
        ):
            for entry_name, document in docs.items():
                archive.writestr(entry_name, json.dumps(document, ensure_ascii=False, indent=2))
            archive.writestr(
                "README.txt",
                "DSWhale diagnostic metadata only. No account IDs, paths, configuration values, chat, memory, persona, keys, tokens or raw logs are included. Model/QQ/Bilibili availability requires user verification.",
            )
        Path(temp_name).replace(output)
    finally:
        Path(temp_name).unlink(missing_ok=True)
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True, type=Path)
    parser.add_argument("--running", action="store_true")
    parser.add_argument("--started-after", type=float, default=0)
    parser.add_argument("--export", type=Path)
    args = parser.parse_args()
    try:
        if args.export:
            export_diagnostics(args.host, args.export)
            result = {"saved": True}
        else:
            result = inspect_host(args.host, running=args.running, started_after=args.started_after)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception:
        print(
            json.dumps(
                {"error": "体检未完成，请检查配置文件和磁盘权限", "code": "CFG-001"},
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
