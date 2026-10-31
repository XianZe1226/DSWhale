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
import uuid
from pathlib import Path

from filelock import Timeout

from .install import InstallError, offline_host

FIELDS = {
    "ownerQQ",
    "platformId",
    "onebotPort",
    "onebotToken",
    "biliEnabled",
    "proactiveEnabled",
    "signatureEnabled",
    "qzoneEnabled",
}


def _load(path, default):
    return json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else default


def _files(host):
    data = Path(host) / "data"
    return data / "cmd_config.json", data / "config/astrbot_plugin_dswhale_config.json"


def read_settings(host):
    config_file, fish_file = _files(host)
    config, fish = _load(config_file, {}), _load(fish_file, {})
    platform_id = str(fish.get("owner_umo", "")).split(":")[0]
    platforms = [p for p in config.get("platform", []) if p.get("type") == "aiocqhttp"]
    platform = next(
        (p for p in platforms if p.get("id") == platform_id), platforms[0] if platforms else {}
    )
    return {
        "ownerQQ": str(fish.get("owner_qq", "")),
        "platformId": platform.get("id", "dswhale-qq"),
        "onebotPort": platform.get("ws_reverse_port", 6199),
        "onebotToken": platform.get("ws_reverse_token", ""),
        "biliEnabled": bool(fish.get("bili_enabled", False)),
        "proactiveEnabled": bool(fish.get("proactive_enabled", False)),
        "signatureEnabled": bool(fish.get("qq_signature_enabled", False)),
        "qzoneEnabled": bool(fish.get("qzone_enabled", False)),
        "hasModels": any(
            p.get("enable", True) and p.get("model") for p in config.get("provider", [])
        ),
    }


def setup_status(host):
    config_file, fish_file = _files(host)
    config, fish = _load(config_file, {}), _load(fish_file, {})
    value = read_settings(host)
    memory = _load(Path(host) / "data/config/astrbot_plugin_livingmemory_config.json", {})
    providers = memory.get("provider_settings", {})
    # LivingMemory keeps provider selection inside basic settings in some releases.
    providers = memory.get("basic_settings", providers)
    return {
        "ownerConfigured": bool(value["ownerQQ"] and fish.get("owner_umo")),
        "qqConfigured": any(
            p.get("enable") and p.get("type") == "aiocqhttp" and p.get("ws_reverse_token")
            for p in config.get("platform", [])
        ),
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
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


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


def save_settings(host, patch):
    host = Path(host)
    if not isinstance(patch, dict) or set(patch) - FIELDS:
        raise ValueError("包含不支持的配置项")
    try:
        with offline_host(host):
            config_file, fish_file = _files(host)
            if not config_file.is_file():
                raise ValueError("请先完成环境安装")
            for path in (config_file, fish_file, host / ".desktop-settings-backups"):
                _safe_file(path, host)
            config, fish = _load(config_file, {}), _load(fish_file, {})
            value = {**read_settings(host), **patch}
            owner, ident, token = value["ownerQQ"], value["platformId"], value["onebotToken"]
            if not isinstance(owner, str) or owner and not re.fullmatch(r"[1-9]\d{4,19}", owner):
                raise ValueError("请输入有效的数字 QQ 号")
            if not isinstance(ident, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", ident):
                raise ValueError("平台 ID 仅支持字母、数字、下划线和短横线")
            port = value["onebotPort"]
            if (
                isinstance(port, bool)
                or not isinstance(port, int)
                or not 1024 <= port <= 65535
                or port == config.get("dashboard", {}).get("port", 6185)
            ):
                raise ValueError("QQ 端口无效或与管理页面冲突")
            if not isinstance(token, str) or len(token) > 256 or any(c.isspace() for c in token):
                raise ValueError("访问令牌不能包含空白，长度不能超过 256 字符")
            switches = ("biliEnabled", "proactiveEnabled", "signatureEnabled", "qzoneEnabled")
            if any(not isinstance(value[k], bool) for k in switches):
                raise ValueError("开关值无效")
            if not owner and any(value[k] for k in switches):
                raise ValueError("请先绑定 QQ 用户，再启用主动功能")
            old_ident = read_settings(host)["platformId"]
            platforms = config.setdefault("platform", [])
            platform = next(
                (p for p in platforms if p.get("id") == old_ident and p.get("type") == "aiocqhttp"),
                None,
            )
            if any(p.get("id") == ident and p is not platform for p in platforms):
                raise ValueError("平台 ID 已被其他连接使用")
            if platform is None:
                platform = {}
                platforms.append(platform)
            platform.update(
                id=ident,
                type="aiocqhttp",
                enable=True,
                ws_reverse_host="127.0.0.1",
                ws_reverse_port=port,
                ws_reverse_token=token or secrets.token_urlsafe(32),
            )
            fish.update(
                owner_qq=owner,
                owner_umo=f"{ident}:FriendMessage:{owner}" if owner else "",
                bili_enabled=value["biliEnabled"],
                proactive_enabled=value["proactiveEnabled"],
                qq_signature_enabled=value["signatureEnabled"],
                qzone_enabled=value["qzoneEnabled"],
            )
            if owner:
                admins = config.setdefault("admins_id", [])
                if owner not in admins:
                    admins.append(owner)
            backup = host / ".desktop-settings-backups" / uuid.uuid4().hex
            backup.mkdir(parents=True)
            os.chmod(backup, 0o700)
            changes = [(config_file, config), (fish_file, fish)]
            replaced = []
            try:
                for index, (path, document) in enumerate(changes):
                    path.parent.mkdir(parents=True, exist_ok=True)
                    if path.exists():
                        shutil.copyfile(path, backup / str(index))
                    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
                    try:
                        temp.write_text(
                            json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
                        )
                        os.chmod(temp, 0o600)
                        temp.replace(path)
                        replaced.append((path, backup / str(index)))
                    finally:
                        temp.unlink(missing_ok=True)
            except BaseException:
                for path, original in reversed(replaced):
                    if original.exists():
                        original.replace(path)
                    else:
                        path.unlink(missing_ok=True)
                raise
            return read_settings(host)
    except (Timeout, InstallError):
        raise ValueError("请先停止机器人，再保存连接设置") from None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=("read", "save", "status", "prepare-import", "prepare-backup", "finish-backup"),
    )
    parser.add_argument("--host", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == "save":
            value = save_settings(args.host, json.loads(sys.stdin.read(16_384)))
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
