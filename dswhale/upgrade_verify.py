"""Verify the first fixed-SDK read of an upgraded plugin configuration.

AstrBot's config loader drops keys that are not declared by the installed
plugin schema.  Immediately after installation, before the upgrade is marked
complete, this module performs that exact read in an isolated ASTRBOT_ROOT,
checks that every supported value survived semantically, archives legacy values
that the schema cannot represent, and persists the normalized candidate so the
later real first read is stable.  No platform, network or host process starts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import time
import uuid
from pathlib import Path

from . import config_migrations
from .private_files import write_json_preserving_mode, write_private_json

FISH_RELATIVE = Path("data/config/astrbot_plugin_dswhale_config.json")
SCHEMA_RELATIVE = Path("data/plugins/astrbot_plugin_dswhale/_conf_schema.json")
RECEIPT_RELATIVE = Path("data/plugin_data/astrbot_plugin_dswhale/config-migration-receipt.json")
ARCHIVE_RELATIVE = Path("data/config/.dswhale-config-archives")


class VerifyError(ValueError):
    """The first SDK read did not preserve supported settings; install aborts."""


def _load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def _write_private(path, value, *, private_directory=False):
    return write_private_json(path, value, private_directory=private_directory)


def _replace_config(path, value):
    """Atomically persist the normalized config, keeping the original mode."""
    return write_json_preserving_mode(path, value)


def _schema_paths(schema, prefix=""):
    paths = set()
    if not isinstance(schema, dict):
        return paths
    for key, node in schema.items():
        if not isinstance(node, dict):
            continue
        path = f"{prefix}.{key}" if prefix else str(key)
        paths.add(path)
        if node.get("type") == "object" and isinstance(node.get("items"), dict):
            paths |= _schema_paths(node["items"], path)
    return paths


def _is_supported(path, supported):
    return any(
        path == item or path.startswith(item + ".") or path.startswith(item + "[")
        for item in supported
    )


def _top_level(path):
    return path.split(".", 1)[0].split("[", 1)[0]


def _parse_isolated(root):
    """Run the pinned SDK in a fresh process whose ASTRBOT_ROOT is isolated."""
    root = Path(root)
    os.environ["ASTRBOT_ROOT"] = str(root)
    from astrbot.core.config.astrbot_config import AstrBotConfig

    target = root / "data/config" / FISH_RELATIVE.name
    schema = _load(root / "schema.json")
    AstrBotConfig(config_path=str(target), schema=schema)


def _sdk_first_read(fish, schema, isolated):
    """Perform the fixed SDK read in a dedicated, already-isolated process."""
    import subprocess
    import sys

    isolated = Path(isolated)
    target = isolated / "data/config" / FISH_RELATIVE.name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(fish, ensure_ascii=False), encoding="utf-8")
    (isolated / "schema.json").write_text(json.dumps(schema, ensure_ascii=False), encoding="utf-8")
    environment = dict(os.environ)
    environment["ASTRBOT_ROOT"] = str(isolated)
    source = str(Path(__file__).resolve().parents[1])
    environment["PYTHONPATH"] = os.pathsep.join([source, environment.get("PYTHONPATH", "")]).strip(
        os.pathsep
    )
    try:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "dswhale.upgrade_verify",
                "--parse-isolated",
                "--root",
                str(isolated),
            ],
            cwd=isolated,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=120,
            check=True,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise VerifyError("固定版本 SDK 的隔离读取未完成，升级已中止") from error
    return _load(target)


def _sdk_version():
    try:
        import importlib.metadata

        return importlib.metadata.version("astrbot")
    except Exception:
        return ""


def verify_first_sdk_read(host, *, schema_path=None, now=None):
    """Perform and persist the fixed-SDK first read for an upgraded install."""
    host = Path(host)
    fish_file = host / FISH_RELATIVE
    schema_file = Path(schema_path) if schema_path else host / SCHEMA_RELATIVE
    if not fish_file.is_file():
        return {"status": "skipped", "reason": "settings not present"}
    if not schema_file.is_file():
        raise VerifyError("未找到安装后的插件配置 schema，无法验证升级结果")
    before = _load(fish_file)
    schema = _load(schema_file)
    if not isinstance(before, dict) or not isinstance(schema, dict):
        raise VerifyError("插件配置或 schema 格式不正确，无法验证升级结果")
    version = before.get(config_migrations.VERSION_KEY)
    if isinstance(version, bool) or not isinstance(version, int) or version < 0:
        raise VerifyError("配置迁移版本无效，无法验证升级结果")

    with tempfile.TemporaryDirectory(prefix="dswhale-upgrade-") as root:
        after = _sdk_first_read(before, schema, Path(root))
    if not isinstance(after, dict):
        raise VerifyError("固定版本 SDK 读取结果格式不正确")

    supported = _schema_paths(schema)
    problems = config_migrations.detect_unexpected_changes(before, after)
    supported_problems = []
    unknown_fields = set()
    for problem in problems:
        if problem["path"] == config_migrations.VERSION_KEY or _is_supported(
            problem["path"], supported
        ):
            supported_problems.append(problem)
        else:
            unknown_fields.add(_top_level(problem["path"]))
    if after.get(config_migrations.VERSION_KEY) != version:
        supported_problems.append({"path": config_migrations.VERSION_KEY, "kind": "changed"})
    if supported_problems:
        paths = "、".join(sorted({item["path"] for item in supported_problems}))[:200]
        raise VerifyError(
            f"升级后固定版本 SDK 读取改变了受支持设置（{paths}）；已中止，原配置未改写"
        )

    archive_file = ""
    if unknown_fields:
        archive = {
            "format": 1,
            "reason": "schema-read-removed-legacy-fields",
            "fields": {key: before[key] for key in sorted(unknown_fields) if key in before},
        }
        archive_file = str(ARCHIVE_RELATIVE / f"config-{int(time.time())}-{uuid.uuid4().hex}.json")
        _write_private(host / archive_file, archive, private_directory=True)

    normalized = after != before
    if normalized:
        _replace_config(fish_file, after)

    receipt = {
        "format": 1,
        "verifiedAt": time.time() if now is None else now,
        "sdkVersion": _sdk_version(),
        "schemaSha256": hashlib.sha256(schema_file.read_bytes()).hexdigest(),
        "migrationVersion": version,
        "supportedFields": sorted(key for key in before if _is_supported(str(key), supported)),
        "archivedFields": sorted(unknown_fields),
        "archiveFile": archive_file,
        "normalizedConfig": normalized,
    }
    _write_private(host / RECEIPT_RELATIVE, receipt)
    return {"status": "verified", "receipt": receipt}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="")
    parser.add_argument("--schema", default="")
    parser.add_argument("--parse-isolated", action="store_true")
    parser.add_argument("--root", default="")
    try:
        args = parser.parse_args(argv)
        if args.parse_isolated:
            if not args.root:
                raise VerifyError("隔离根目录无效")
            _parse_isolated(args.root)
            return 0
        if not args.host:
            raise VerifyError("宿主目录无效")
        value = verify_first_sdk_read(args.host, schema_path=args.schema or None)
        print(json.dumps(value, ensure_ascii=False))
        return 0
    except (VerifyError, OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
