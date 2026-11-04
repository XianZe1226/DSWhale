"""Small, offline connection settings interface for the desktop application."""

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sys
import time
import uuid
from pathlib import Path

from filelock import Timeout

from . import config_migrations
from .install import InstallError, offline_host
from .private_files import (
    ensure_private_directory,
    protect_windows_private,
)
from .private_files import (
    write_private_json as _shared_private_json,
)

FIELDS = {
    "qqConnectionMode",
    "officialOwnerUMO",
    "dashboardPort",
    "ownerQQ",
    "platformId",
    "onebotPort",
    "onebotToken",
    "biliEnabled",
    "proactiveEnabled",
    "signatureEnabled",
    "qzoneEnabled",
    "defaultDelivery",
}


def _load(path, default):
    return json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else default


def _files(host):
    data = Path(host) / "data"
    return data / "cmd_config.json", data / "config/astrbot_plugin_dswhale_config.json"


def config_revision(host):
    """Stable digest of both settings documents for optimistic concurrency."""
    config_file, fish_file = _files(host)
    digest = hashlib.sha256()
    for path in (config_file, fish_file):
        try:
            payload = path.read_bytes()
        except FileNotFoundError:
            payload = b""
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()[:32]


def read_settings(host):
    config_file, fish_file = _files(host)
    config, fish = _load(config_file, {}), _load(fish_file, {})
    platform_id = str(fish.get("owner_umo", "")).split(":")[0]
    platforms = [p for p in config.get("platform", []) if p.get("type") == "aiocqhttp"]
    platform = next(
        (p for p in platforms if p.get("id") == platform_id), platforms[0] if platforms else {}
    )
    return {
        "dashboardPort": config.get("dashboard", {}).get("port", 6185),
        "ownerQQ": str(fish.get("owner_qq", "")),
        "qqConnectionMode": fish.get("qq_connection_mode", "napcat"),
        "officialOwnerUMO": fish.get("official_owner_umo", ""),
        "officialConfigured": any(
            p.get("type") == "qq_official"
            and p.get("enable")
            and p.get("appid")
            and p.get("secret")
            for p in config.get("platform", [])
            if isinstance(p, dict)
        ),
        "platformId": platform.get("id", "dswhale-qq"),
        "onebotPort": platform.get("ws_reverse_port", 6199),
        "onebotToken": platform.get("ws_reverse_token", ""),
        "biliEnabled": bool(fish.get("bili_enabled", False)),
        "proactiveEnabled": bool(fish.get("proactive_enabled", False)),
        "signatureEnabled": bool(fish.get("qq_signature_enabled", False)),
        "qzoneEnabled": bool(fish.get("qzone_enabled", False)),
        "defaultDelivery": fish.get("qq_default_delivery", ""),
        "napcatBound": bool(fish.get("owner_qq") and fish.get("owner_umo")),
        "officialBound": bool(fish.get("official_owner_umo")),
        "napcatBoundPlatformId": platform_id if fish.get("owner_umo") else "",
        "officialBoundPlatformId": (
            str(fish.get("official_owner_umo", "")).split(":", 1)[0]
            if fish.get("official_owner_umo")
            else ""
        ),
        "napcatConfigured": any(
            p.get("enable") and p.get("type") == "aiocqhttp" and p.get("ws_reverse_token")
            for p in config.get("platform", [])
            if isinstance(p, dict)
        ),
        "hasModels": any(
            p.get("enable", True) and p.get("model") for p in config.get("provider", [])
        ),
        "configRevision": config_revision(host),
    }


def setup_status(host):
    _, fish_file = _files(host)
    fish = _load(fish_file, {})
    value = read_settings(host)
    memory = _load(Path(host) / "data/config/astrbot_plugin_livingmemory_config.json", {})
    providers = memory.get("provider_settings", {})
    # LivingMemory keeps provider selection inside basic settings in some releases.
    providers = memory.get("basic_settings", providers)
    return {
        "qqConnectionMode": value["qqConnectionMode"],
        "ownerConfigured": bool(
            (value["ownerQQ"] and fish.get("owner_umo")) or value["officialOwnerUMO"]
        ),
        "qqConfigured": bool(value["napcatConfigured"] or value["officialConfigured"]),
        "modelConfigured": value["hasModels"],
        "memoryConfigured": bool(
            providers.get("embedding_provider_id") or memory.get("embedding_provider_id")
        ),
        "biliEnabled": value["biliEnabled"],
    }


def _safe_file(path, host):
    for candidate in [path, *path.parents]:
        if candidate == Path(host).parent:
            break
        if candidate.is_symlink():
            raise ValueError("配置目录包含符号链接，请先检查数据目录")


def _valid_initial_login(config, credential):
    dashboard = config.get("dashboard", {})
    try:
        if not dashboard.get("password_change_required") or credential.get(
            "username"
        ) != dashboard.get("username", "astrbot"):
            return False
        password = credential["password"]
        if not isinstance(password, str) or not 1 <= len(password) <= 256:
            return False
        algorithm, iterations, salt, expected = dashboard["pbkdf2_password"].split("$")
        iterations = int(iterations)
        if algorithm != "pbkdf2_sha256" or not 100_000 <= iterations <= 5_000_000:
            return False
        return hmac.compare_digest(
            hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), iterations),
            bytes.fromhex(expected),
        )
    except (KeyError, ValueError, TypeError, AttributeError):
        return False


def _write_private_json(path, value):
    return _shared_private_json(path, value)


def prepare_backup(host):
    """Include a still-valid initial credential in a private desktop export."""
    host = Path(host)
    with offline_host(host):
        config_file, _ = _files(host)
        auth = host.parent / "desktop-auth.json"
        attachment = host / "data/.dswhale-desktop-login.json"
        for path in (config_file, auth, attachment):
            _safe_file(path, host)
        config, credential = _load(config_file, {}), _load(auth, {})
        if _valid_initial_login(config, credential):
            _write_private_json(
                attachment, {key: credential[key] for key in ("username", "password")}
            )
        else:
            attachment.unlink(missing_ok=True)
    return {"prepared": True}


def finish_backup(host):
    host = Path(host)
    with offline_host(host):
        attachment = host / "data/.dswhale-desktop-login.json"
        _safe_file(attachment, host)
        attachment.unlink(missing_ok=True)
    return {"finished": True}


def prepare_import(host):
    """Adapt imported local settings without changing identity, models or memory."""
    host = Path(host)
    with offline_host(host):
        config_file, fish_file = _files(host)
        auth = host.parent / "desktop-auth.json"
        attachment = host / "data/.dswhale-desktop-login.json"
        for path in (config_file, fish_file, auth, attachment):
            _safe_file(path, host)
        config, fish = _load(config_file, {}), _load(fish_file, {})
        dashboard = config.setdefault("dashboard", {})
        dashboard.update(enable=True, host="127.0.0.1")
        dashboard.setdefault("port", 6185)
        dashboard.setdefault("ssl", {})["enable"] = False
        for key in ("bili_node_path", "cookies_path"):
            if fish.get(key) and not Path(fish[key]).expanduser().is_file():
                fish[key] = ""
        for path, document in ((config_file, config), (fish_file, fish)):
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name + ".import-" + uuid.uuid4().hex)
            try:
                temporary.write_text(
                    json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                os.chmod(temporary, 0o600)
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        imported_login = _load(attachment, {})
        if _valid_initial_login(config, imported_login):
            _write_private_json(
                auth, {key: imported_login[key] for key in ("username", "password")}
            )
        elif not _valid_initial_login(config, _load(auth, {})):
            auth.unlink(missing_ok=True)
        attachment.unlink(missing_ok=True)
    return {"prepared": True}


def _validated_patch(patch):
    """Validate only the fields the caller actually supplied.

    Missing fields are never synthesized here: a settings save carries user
    intent for the edited fields only, not defaults for everything else.
    """
    if not isinstance(patch, dict) or set(patch) - FIELDS:
        raise ValueError("包含不支持的配置项")
    for key, value in patch.items():
        if key in {"dashboardPort", "onebotPort"}:
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError("端口需要为 1024–65535 的整数")
        elif key in {"biliEnabled", "proactiveEnabled", "signatureEnabled", "qzoneEnabled"}:
            if not isinstance(value, bool):
                raise ValueError("开关值无效")
        elif not isinstance(value, str):
            raise ValueError("配置项类型无效")
    return dict(patch)


NAPCAT_FIELDS = {"ownerQQ", "platformId", "onebotPort", "onebotToken"}
OFFICIAL_FIELDS = {"officialOwnerUMO"}
SWITCH_FIELDS = {"biliEnabled", "proactiveEnabled", "signatureEnabled", "qzoneEnabled"}


def _validated_official_binding(host, config, fish, official):
    """Validate an official binding independently of the legacy connection mode."""
    from .config import Settings

    official = str(official).strip()
    Settings.from_mapping({"qq_connection_mode": "napcat", "official_owner_umo": official})
    if not official:
        return ""
    ident = official.split(":", 1)[0]
    platform = next(
        (
            item
            for item in config.get("platform", [])
            if isinstance(item, dict)
            and item.get("id") == ident
            and item.get("type") == "qq_official"
        ),
        None,
    )
    if not platform or not (
        platform.get("enable") and platform.get("appid") and platform.get("secret")
    ):
        raise ValueError("请先创建并启用对应的 QQ 官方机器人，再复制其私聊会话 ID")
    if official != str(fish.get("official_owner_umo", "")):
        from .qq_identity import confirmed_c2c_scope

        if not confirmed_c2c_scope(host / "data/plugin_data/astrbot_plugin_dswhale", official):
            raise ValueError(
                "请先在 QQ 消息列表私聊发送 /fish whoami，再复制本会话；不接受频道私信"
            )
    return official


def _apply_napcat_patch(config, fish, patch, value):
    """Apply only the edited OneBot fields; never enable a platform implicitly."""
    platforms = config.setdefault("platform", [])
    if not isinstance(platforms, list):
        raise ValueError("平台配置格式不正确，请先检查数据目录")
    old_ident = str(fish.get("owner_umo", "")).split(":", 1)[0] if fish.get("owner_umo") else ""
    explicit = patch.get("platformId")
    target = None
    if explicit:
        target = next(
            (
                item
                for item in platforms
                if isinstance(item, dict)
                and item.get("id") == explicit
                and item.get("type") == "aiocqhttp"
            ),
            None,
        )
        if target is None and old_ident and old_ident != explicit:
            target = next(
                (
                    item
                    for item in platforms
                    if isinstance(item, dict)
                    and item.get("id") == old_ident
                    and item.get("type") == "aiocqhttp"
                ),
                None,
            )
            if target is not None:
                if any(isinstance(item, dict) and item.get("id") == explicit for item in platforms):
                    raise ValueError("平台 ID 已被其他连接使用")
                target["id"] = explicit
    if target is None and old_ident:
        target = next(
            (
                item
                for item in platforms
                if isinstance(item, dict)
                and item.get("id") == old_ident
                and item.get("type") == "aiocqhttp"
            ),
            None,
        )
    created = False
    if target is None:
        new_ident = explicit or value["platformId"]
        if any(isinstance(item, dict) and item.get("id") == new_ident for item in platforms):
            raise ValueError("平台 ID 已被其他连接使用")
        target = {
            "id": new_ident,
            "type": "aiocqhttp",
            "enable": False,
            "ws_reverse_host": "127.0.0.1",
        }
        platforms.append(target)
        created = True
    if "onebotPort" in patch:
        target["ws_reverse_port"] = value["onebotPort"]
    if created:
        target.setdefault("ws_reverse_port", value["onebotPort"])
        token = patch.get("onebotToken")
        target.setdefault(
            "ws_reverse_token",
            token if token else secrets.token_urlsafe(32),
        )
    elif "onebotToken" in patch and patch["onebotToken"]:
        target["ws_reverse_token"] = patch["onebotToken"]
    if "ownerQQ" in patch:
        owner = str(value["ownerQQ"])
        fish["owner_qq"] = owner
        fish["owner_umo"] = f"{target['id']}:FriendMessage:{owner}" if owner else ""
        if owner:
            admins = config.setdefault("admins_id", [])
            if not isinstance(admins, list):
                raise ValueError("管理员配置格式不正确，请先检查数据目录")
            if owner not in admins:
                admins.append(owner)
    elif "platformId" in patch and fish.get("owner_qq"):
        fish["owner_umo"] = f"{target['id']}:FriendMessage:{fish['owner_qq']}"


def _validate_delivery_target(config, probe, target):
    binding = next((binding for binding in probe.owner_bindings if binding.channel == target), None)
    if binding is None:
        raise ValueError("请先完成该渠道的主人绑定，再选择主动消息渠道")
    adapter = "aiocqhttp" if target == "napcat" else "qq_official"
    platform = next(
        (
            item
            for item in config.get("platform", [])
            if isinstance(item, dict)
            and item.get("id") == binding.platform_id
            and item.get("type") == adapter
        ),
        None,
    )
    ready = bool(platform and platform.get("enable"))
    if ready and target == "napcat":
        ready = bool(
            platform.get("ws_reverse_token")
            and isinstance(platform.get("ws_reverse_port"), int)
            and platform.get("ws_reverse_host")
        )
    if ready and target == "official":
        ready = bool(platform.get("appid") and platform.get("secret"))
    if not ready:
        raise ValueError("该渠道的 QQ 连接尚未启用或配置不完整，请先在连接管理中检查")


def _validate_active_switches(fish, value):
    """Validate enabled features against the bindings present after the patch."""
    from .config import Settings

    probe = Settings.from_mapping(
        {
            "owner_qq": str(fish.get("owner_qq", "")),
            "owner_umo": str(fish.get("owner_umo", "")),
            "official_owner_umo": str(fish.get("official_owner_umo", "")),
            "qq_connection_mode": str(fish.get("qq_connection_mode", "napcat")),
            "qq_default_delivery": str(fish.get("qq_default_delivery", "")),
        }
    )
    if (value["proactiveEnabled"] or value["biliEnabled"]) and not probe.owner_scope:
        raise ValueError("请先绑定 QQ 用户，再启用主动功能")
    if (value["signatureEnabled"] or value["qzoneEnabled"]) and not any(
        binding.channel == "napcat" for binding in probe.owner_bindings
    ):
        raise ValueError("请先绑定普通 QQ 小号，再启用签名或空间功能")


HISTORY_RELATIVE = Path("data/config/.dswhale-settings-history")
HISTORY_LIMIT = 20
HISTORY_FIELDS = tuple(sorted(FIELDS - {"onebotToken"}))
RECEIPT_RELATIVE = Path("data/plugin_data/astrbot_plugin_dswhale/config-migration-receipt.json")


def _record_settings_change(host, before, after):
    """Record a bounded, secret-free local change history for field restore."""
    changes = []
    for field in HISTORY_FIELDS:
        old, new = before.get(field), after.get(field)
        if old != new or type(old) is not type(new):
            changes.append({"field": field, "before": old, "after": new})
    if not changes:
        return None
    history = Path(host) / HISTORY_RELATIVE
    ensure_private_directory(history)
    identifier = f"{time.time_ns()}-{uuid.uuid4().hex[:8]}"
    record = {
        "format": 1,
        "changedAt": time.time(),
        "revisionBefore": before.get("configRevision", ""),
        "revisionAfter": after.get("configRevision", ""),
        "changes": changes,
    }
    _write_private_json(history / f"{identifier}.json", record)
    for stale in sorted(history.glob("*.json"))[:-HISTORY_LIMIT]:
        stale.unlink(missing_ok=True)
    return identifier


def list_settings_history(host):
    host = Path(host)
    history = host / HISTORY_RELATIVE
    records = []
    if history.is_dir():
        for file in sorted(history.glob("*.json"), reverse=True)[:HISTORY_LIMIT]:
            try:
                value = json.loads(file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if (
                not isinstance(value, dict)
                or value.get("format") != 1
                or not isinstance(value.get("changes"), list)
            ):
                continue
            records.append(
                {
                    "id": file.stem,
                    "changedAt": value.get("changedAt", 0),
                    "changes": [
                        {
                            "field": change.get("field", ""),
                            "before": change.get("before"),
                            "after": change.get("after"),
                        }
                        for change in value["changes"]
                        if isinstance(change, dict) and change.get("field") in HISTORY_FIELDS
                    ],
                }
            )
    receipt = None
    receipt_file = host / RECEIPT_RELATIVE
    if receipt_file.is_file():
        try:
            value = json.loads(receipt_file.read_text(encoding="utf-8"))
            if isinstance(value, dict) and value.get("format") == 1:
                receipt = {
                    key: value.get(key)
                    for key in (
                        "migrationVersion",
                        "archivedFields",
                        "archiveFile",
                        "verifiedAt",
                        "normalizedConfig",
                    )
                }
        except (OSError, ValueError):
            receipt = None
    return {"format": 1, "records": records, "migrationReceipt": receipt}


def restore_setting(host, record_id, field, expected_revision=None):
    """Restore one recorded field value with optimistic revision protection."""
    host = Path(host)
    if not isinstance(record_id, str) or not re.fullmatch(r"[0-9]{10,20}-[a-f0-9]{8}", record_id):
        raise ValueError("设置修改记录无效")
    if field not in HISTORY_FIELDS:
        raise ValueError("该设置项不支持恢复")
    record_file = host / HISTORY_RELATIVE / f"{record_id}.json"
    if not record_file.is_file():
        raise ValueError("找不到该设置修改记录")
    record = json.loads(record_file.read_text(encoding="utf-8"))
    changes = record.get("changes", []) if isinstance(record, dict) else []
    change = next(
        (item for item in changes if isinstance(item, dict) and item.get("field") == field),
        None,
    )
    if change is None or "before" not in change:
        raise ValueError("该设置修改记录不包含此项")
    current = read_settings(host)
    if expected_revision is not None and expected_revision != current["configRevision"]:
        raise ValueError("设置已在另一处更新，请刷新并核对本次修改后重试")
    restored = save_settings(host, {field: change["before"]}, current["configRevision"])
    return {**restored, "restoredField": field, "restoredFrom": record_id}


def _replace_documents(host, entries):
    """Atomically replace the listed documents with one recoverable backup."""
    backup = Path(host) / ".desktop-settings-backups" / uuid.uuid4().hex
    ensure_private_directory(backup)
    replaced = []
    try:
        for index, (path, document) in enumerate(entries):
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists():
                shutil.copyfile(path, backup / str(index))
            temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
            try:
                if os.name == "nt":
                    temporary.touch()
                    protect_windows_private(temporary)
                temporary.write_text(
                    json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                if os.name != "nt":
                    os.chmod(temporary, 0o600)
                temporary.replace(path)
                replaced.append((path, backup / str(index)))
            finally:
                temporary.unlink(missing_ok=True)
    except BaseException:
        for path, original in reversed(replaced):
            if original.exists():
                original.replace(path)
            else:
                path.unlink(missing_ok=True)
        raise


def save_settings(host, patch, expected_revision=None):
    host = Path(host)
    patch = _validated_patch(patch)
    if expected_revision is not None and (
        not isinstance(expected_revision, str)
        or not re.fullmatch(r"[a-f0-9]{8,64}", expected_revision)
    ):
        raise ValueError("设置修订标识无效")
    if not patch:
        return read_settings(host)
    try:
        with offline_host(host):
            config_file, fish_file = _files(host)
            if not config_file.is_file():
                raise ValueError("请先完成环境安装")
            for path in (config_file, fish_file, host / ".desktop-settings-backups"):
                _safe_file(path, host)
            if expected_revision is not None and expected_revision != config_revision(host):
                raise ValueError("设置已在另一处更新，请刷新并核对本次修改后重试")
            original_config, original_fish = _load(config_file, {}), _load(fish_file, {})
            if not isinstance(original_config, dict) or not isinstance(original_fish, dict):
                raise ValueError("配置文件格式不正确，请先检查数据目录")
            config = json.loads(json.dumps(original_config))
            fish = json.loads(json.dumps(original_fish))
            before_settings = read_settings(host)
            value = {**before_settings, **patch}
            switches = ("biliEnabled", "proactiveEnabled", "signatureEnabled", "qzoneEnabled")
            for key in switches:
                if key in patch and not isinstance(patch[key], bool):
                    raise ValueError("开关值无效")
            if "ownerQQ" in patch:
                owner = value["ownerQQ"]
                if not isinstance(owner, str) or (
                    owner and not re.fullmatch(r"[1-9]\d{4,19}", owner)
                ):
                    raise ValueError("请输入有效的数字 QQ 号")
            if "platformId" in patch and (
                not isinstance(value["platformId"], str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", value["platformId"])
            ):
                raise ValueError("平台 ID 仅支持字母、数字、下划线和短横线")
            port = value["onebotPort"]
            dashboard_port = value["dashboardPort"]
            if "dashboardPort" in patch and (
                isinstance(dashboard_port, bool)
                or not isinstance(dashboard_port, int)
                or not 1024 <= dashboard_port <= 65535
            ):
                raise ValueError("控制台端口需要为 1024–65535 的整数")
            if "onebotPort" in patch and (
                isinstance(port, bool)
                or not isinstance(port, int)
                or not 1024 <= port <= 65535
                or port == dashboard_port
            ):
                raise ValueError("QQ 端口无效或与管理页面冲突")
            if {"dashboardPort", "onebotPort"} & set(patch) and port == dashboard_port:
                raise ValueError("QQ 端口无效或与管理页面冲突")
            token = value["onebotToken"]
            if "onebotToken" in patch and (
                not isinstance(token, str) or len(token) > 256 or any(c.isspace() for c in token)
            ):
                raise ValueError("访问令牌不能包含空白，长度不能超过 256 字符")
            if "defaultDelivery" in patch and value["defaultDelivery"] not in {
                "",
                "napcat",
                "official",
            }:
                raise ValueError("主动消息默认渠道无效")
            mode = value["qqConnectionMode"]
            if "qqConnectionMode" in patch and (
                not isinstance(mode, str) or mode not in {"napcat", "official"}
            ):
                raise ValueError("QQ 接入方式无效")
            if "dashboardPort" in patch:
                config.setdefault("dashboard", {}).update(port=dashboard_port)
            if "officialOwnerUMO" in patch:
                fish["official_owner_umo"] = _validated_official_binding(
                    host, config, fish, value["officialOwnerUMO"]
                )
            if NAPCAT_FIELDS & set(patch):
                _apply_napcat_patch(config, fish, patch, value)
            if "qqConnectionMode" in patch:
                fish["qq_connection_mode"] = mode
            switches_touched = bool(
                (NAPCAT_FIELDS | OFFICIAL_FIELDS | {"qqConnectionMode"} | SWITCH_FIELDS)
                & set(patch)
            )
            for key, fish_key in (
                ("biliEnabled", "bili_enabled"),
                ("proactiveEnabled", "proactive_enabled"),
                ("signatureEnabled", "qq_signature_enabled"),
                ("qzoneEnabled", "qzone_enabled"),
            ):
                if key in patch:
                    fish[fish_key] = value[key]
            if "defaultDelivery" in patch:
                target = value["defaultDelivery"]
                if not target and (value["proactiveEnabled"] or value["biliEnabled"]):
                    raise ValueError("开启主动功能时请选择一个有效的主动消息渠道")
                if target:
                    from .config import Settings as _Settings

                    probe = _Settings.from_mapping(
                        {
                            "owner_qq": str(fish.get("owner_qq", "")),
                            "owner_umo": str(fish.get("owner_umo", "")),
                            "official_owner_umo": str(fish.get("official_owner_umo", "")),
                            "qq_default_delivery": target,
                            "proactive_enabled": False,
                        }
                    )
                    _validate_delivery_target(config, probe, target)
                fish["qq_default_delivery"] = target
            if switches_touched and any(value[key] for key in SWITCH_FIELDS):
                _validate_active_switches(fish, value)
            writes = []
            for index, (path, document, original) in enumerate(
                (
                    (config_file, config, original_config),
                    (fish_file, fish, original_fish),
                )
            ):
                if document != original:
                    writes.append((index, path, document))
            if not writes:
                return read_settings(host)
            _replace_documents(host, [(path, document) for _, path, document in writes])
            after = read_settings(host)
            try:
                _record_settings_change(host, before_settings, after)
            except OSError:
                # The settings write is authoritative; a full disk must not turn
                # a successful save into an apparent failure.
                pass
            return after
    except (Timeout, InstallError):
        raise ValueError("请先停止机器人，再保存连接设置") from None


def migrate_settings(host):
    """Apply additive config migrations inside the existing offline lock.

    Missing files are a no-op (a fresh install lets the plugin create defaults);
    corrupt files are rejected and left untouched.
    """
    host = Path(host)
    try:
        with offline_host(host):
            config_file, fish_file = _files(host)
            if not fish_file.is_file():
                return {"changed": False, "migrationVersion": 0, "changes": []}
            for path in (config_file, fish_file, host / ".desktop-settings-backups"):
                _safe_file(path, host)
            config, fish = _load(config_file, {}), _load(fish_file, {})
            if not isinstance(config, dict) or not isinstance(fish, dict):
                raise ValueError("配置文件格式不正确，请先检查数据目录")
            candidate, changes = config_migrations.plan_migration({"config": config, "fish": fish})
            version = fish.get(config_migrations.VERSION_KEY, 0)
            if not changes:
                return {"changed": False, "migrationVersion": version, "changes": []}
            _replace_documents(host, [(fish_file, candidate["fish"])])
            return {
                "changed": True,
                "migrationVersion": candidate["fish"][config_migrations.VERSION_KEY],
                "changes": changes,
            }
    except (Timeout, InstallError):
        raise ValueError("请先停止机器人，再迁移设置") from None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=(
            "read",
            "save",
            "status",
            "migrate",
            "prepare-import",
            "prepare-backup",
            "finish-backup",
            "history",
            "restore-field",
        ),
    )
    parser.add_argument("--host", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == "save":
            request = json.loads(sys.stdin.read(16_384))
            if isinstance(request, dict) and set(request) == {"patch", "expectedRevision"}:
                value = save_settings(args.host, request["patch"], request["expectedRevision"])
            else:
                # Legacy CLI callers may still send the bare settings object.
                value = save_settings(args.host, request)
        elif args.action == "history":
            value = list_settings_history(args.host)
        elif args.action == "restore-field":
            request = json.loads(sys.stdin.read(16_384))
            if not isinstance(request, dict):
                raise ValueError("恢复请求无效")
            value = restore_setting(
                args.host,
                request.get("recordId"),
                request.get("field"),
                request.get("expectedRevision"),
            )
        elif args.action == "migrate":
            value = migrate_settings(args.host)
        elif args.action == "prepare-import":
            value = prepare_import(args.host)
        elif args.action == "prepare-backup":
            value = prepare_backup(args.host)
        elif args.action == "finish-backup":
            value = finish_backup(args.host)
        else:
            value = (read_settings if args.action == "read" else setup_status)(args.host)
        print(json.dumps(value, ensure_ascii=False))
        return 0
    except (ValueError, OSError, TypeError, InstallError):
        print(
            json.dumps(
                {"error": "配置未完成，请检查输入、文件权限，并停止机器人后重试"},
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
