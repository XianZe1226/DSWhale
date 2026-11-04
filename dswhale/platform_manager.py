"""Host platform enable/disable through the pinned SDK config, offline-locked.

Only the two supported platform adapters are exposed and credentials are never
returned to callers. The host's own platform manager applies a reload/restart;
this helper never starts a host, imports astrbot.core or kills a process.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

from .desktop_settings import _replace_documents
from .install import InstallError, offline_host

SUPPORTED = {
    "aiocqhttp": "napcat",
    "qq_official": "official",
}


def _files(host):
    return Path(host) / "data/cmd_config.json"


def _load(host):
    file = _files(host)
    if not file.is_file():
        raise ValueError("尚未准备运行环境")
    try:
        value = json.loads(file.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        raise ValueError("配置无法读取，请检查数据目录") from error
    if not isinstance(value, dict) or not isinstance(value.get("platform", []), list):
        raise ValueError("配置格式不正确，请检查数据目录")
    return value


def _public(platform):
    """Return safe fields only: no tokens, secrets or provider credentials."""
    kind = platform.get("type")
    if kind not in SUPPORTED:
        return None
    configured = (
        bool(platform.get("ws_reverse_token") and platform.get("ws_reverse_port"))
        if kind == "aiocqhttp"
        else bool(platform.get("appid") and platform.get("secret"))
    )
    return {
        "id": str(platform.get("id", "")),
        "type": kind,
        "channel": SUPPORTED[kind],
        "enable": platform.get("enable") is True,
        "configured": configured,
    }


def read_platforms(host):
    config = _load(host)
    platforms = [item for item in (_public(p) for p in config["platform"]) if item]
    return {"platforms": platforms}


def set_platform_enabled(host, platform_id, enabled):
    host = Path(host)
    if not isinstance(platform_id, str) or not platform_id or not isinstance(enabled, bool):
        raise ValueError("平台参数无效")
    try:
        with offline_host(host):
            config = _load(host)
            matches = [
                p
                for p in config["platform"]
                if isinstance(p, dict) and p.get("id") == platform_id and p.get("type") in SUPPORTED
            ]
            if not matches:
                raise ValueError("找不到对应的 QQ 连接平台")
            if len(matches) > 1:
                raise ValueError("平台 ID 重复，请先在 AstrBot 平台设置中修正")
            target = matches[0]
            if target.get("enable") is enabled:
                return read_platforms(host)
            target["enable"] = enabled
            _replace_documents(host, [(_files(host), config)])
            return read_platforms(host)
    except (InstallError, TimeoutError):
        raise ValueError("请先在应用内停止对话服务，再修改连接平台") from None


def pending_activity(host):
    """Read-only check for autonomy already committed to a channel.

    A missing database is a fresh install and means no pending activity. A read
    failure (corrupt file, missing table, lock timeout) is unknown, never an
    empty result: the caller must refuse destructive changes.
    """
    file = Path(host) / "data/plugin_data/astrbot_plugin_dswhale/state.db"
    if not file.is_file():
        return {"pending": False, "database": "missing"}
    try:
        with sqlite3.connect(f"file:{file}?mode=ro", uri=True, timeout=2) as db:
            row = db.execute(
                "SELECT 1 FROM activities WHERE status IN ('reserved','queued') LIMIT 1"
            ).fetchone()
        return {"pending": row is not None, "database": "present"}
    except sqlite3.Error as error:
        raise ValueError("无法确认待处理任务状态，请先修复本地数据后再试") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "set-enable", "pending"))
    parser.add_argument("--host", required=True)
    parser.add_argument("--platform", default="")
    parser.add_argument("--enable", choices=("true", "false"), default="")
    try:
        args = parser.parse_args(argv)
        if args.action == "status":
            value = read_platforms(args.host)
        elif args.action == "pending":
            value = pending_activity(args.host)
        else:
            if not args.platform or not args.enable:
                raise ValueError("平台参数无效")
            value = set_platform_enabled(args.host, args.platform, args.enable == "true")
        print(json.dumps(value, ensure_ascii=False))
        return 0
    except (ValueError, OSError, TypeError) as error:
        print(json.dumps({"error": str(error) or "连接平台操作未完成"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
