import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from filelock import FileLock

from dswhale.install import (
    InstallError,
    backup,
    extract_archive,
    install_memory,
    install_plugin,
    restore,
)

ROOT = Path(__file__).resolve().parents[1]


def test_app_upgrade_preserves_separately_updated_memory_plugin(tmp_path, monkeypatch):
    memory = tmp_path / "data/plugins/astrbot_plugin_livingmemory"
    memory.mkdir(parents=True)
    (memory / "metadata.yaml").write_text("version: 99.0.0\n")
    (memory / "state.db").write_bytes(b"synthetic memory")
    monkeypatch.setattr("httpx.stream", lambda *a, **kw: pytest.fail("must not download"))
    install_plugin(tmp_path)
    assert install_memory(tmp_path) == memory
    assert (memory / "metadata.yaml").read_text() == "version: 99.0.0\n"
    assert (memory / "state.db").read_bytes() == b"synthetic memory"


def test_install_update_preserves_data_and_previous_code(tmp_path):
    host = tmp_path / "中文 目录" / "AstrBot"
    plugin = install_plugin(host)
    assert (plugin / "main.py").is_file()
    assert (plugin / "dswhale" / "adapter.py").is_file()
    assert (plugin / "dswhale/media_assets.json").is_file()
    assert (plugin / "dswhale/bili_bridge/server.mjs").is_file()
    assert (plugin / "dswhale/bili_bridge/upstream/LICENSE").is_file()
    assert (plugin / "dswhale/bili_bridge/upstream/tools/bili.mjs").is_file()
    assert not (plugin / "dswhale/bili_bridge/node_modules").exists()
    assert not (plugin / ".venv").exists()
    assert not (plugin / "tests").exists()
    config = host / "data/config/user.json"
    config.parent.mkdir(parents=True)
    config.write_text('{"secret":"local-only"}')
    db = host / "data/plugin_data/astrbot_plugin_dswhale/state.db"
    db.parent.mkdir(parents=True)
    db.write_bytes(b"user data")
    (plugin / "old-marker").write_text("old")
    install_plugin(host)
    assert config.read_text() == '{"secret":"local-only"}'
    assert db.read_bytes() == b"user data"
    assert list((host / ".dswhale-backups").rglob("old-marker"))


def test_install_refuses_running_host(tmp_path):
    with FileLock(tmp_path / "astrbot.lock"):
        with pytest.raises(InstallError, match="停止"):
            install_plugin(tmp_path)


@pytest.mark.parametrize(
    "name",
    [
        "../outside",
        "/absolute",
        "data/../../escape",
        "data/..\\escape",
        "data/C:escape",
        "data/link",
    ],
)
def test_archive_rejects_traversal_and_symlinks(tmp_path, name):
    path = tmp_path / "bad.zip"
    with zipfile.ZipFile(path, "w") as z:
        info = zipfile.ZipInfo(name)
        if name == "data/link":
            info.external_attr = 0o120777 << 16
        z.writestr(info, "bad")
    with pytest.raises(InstallError):
        extract_archive(
            path, tmp_path / "out", sha256=hashlib.sha256(path.read_bytes()).hexdigest()
        )
    assert not (tmp_path / "outside").exists()


def test_checksum_failure_does_not_extract(tmp_path):
    path = tmp_path / "x.zip"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("a/file", "ok")
    with pytest.raises(InstallError, match="校验"):
        extract_archive(path, tmp_path / "out", sha256="0" * 64)
    assert not (tmp_path / "out").exists()


def test_full_backup_restore_keeps_memory_config_and_old_state(tmp_path):
    host = tmp_path / "host"
    install_plugin(host)
    memory = host / "data/plugin_data/astrbot_plugin_livingmemory/notes.json"
    memory.parent.mkdir(parents=True)
    memory.write_text("remember me")
    archive = tmp_path / "backup.zip"
    backup(host, archive)
    memory.write_text("changed")
    restore(host, archive)
    assert memory.read_text() == "remember me"
    assert list((host / ".dswhale-backups").rglob("notes.json"))
    with pytest.raises(InstallError):
        backup(host, archive)  # no overwrite


def test_cli_help_and_invalid_directory_exit(tmp_path):
    result = subprocess.run(
        [sys.executable, "-m", "dswhale", "--help"], capture_output=True, encoding="utf-8"
    )
    assert result.returncode == 0
    assert "doctor" in result.stdout
    result = subprocess.run(
        [sys.executable, "-m", "dswhale", "doctor", "--astrbot-dir", str(tmp_path), "--json"],
        capture_output=True,
        encoding="utf-8",
    )
    assert result.returncode == 1
    assert not json.loads(result.stdout)["ready"]


def test_doctor_accepts_astrbot_bom_config_without_revealing_identity(tmp_path):
    from dswhale.install import doctor

    config = tmp_path / "data/config/astrbot_plugin_dswhale_config.json"
    config.parent.mkdir(parents=True)
    config.write_text(
        json.dumps(
            {
                "owner_qq": "987654321",
                "owner_umo": "fixture:FriendMessage:987654321",
                "vision_provider_id": "test-vision",
            }
        ),
        encoding="utf-8-sig",
    )
    result = doctor(tmp_path)
    checks = {item["name"]: item for item in result["checks"]}
    assert checks["owner"]["ok"] and checks["vision"]["ok"]
    assert "987654321" not in json.dumps(result)
    assert "test-vision" not in json.dumps(result)


def test_cli_outputs_utf8_under_legacy_windows_pipe_encoding(tmp_path):
    import os
    import subprocess
    import sys

    result = subprocess.run(
        [sys.executable, "-m", "dswhale", "install", "--astrbot-dir", str(tmp_path / "安装 host")],
        env={**os.environ, "PYTHONIOENCODING": "ascii"},
        capture_output=True,
    )
    assert result.returncode == 0
    assert "已安装" in result.stdout.decode("utf-8")


def test_repeated_upgrade_preserves_full_settings_unknown_fields_and_database(tmp_path):
    from dswhale.desktop_settings import migrate_settings

    host = tmp_path / "升级 主机"
    data = host / "data"
    (data / "config").mkdir(parents=True)
    config = {
        "dashboard": {"host": "127.0.0.1", "port": 6185},
        "platform": [
            {
                "id": "old-qq",
                "type": "aiocqhttp",
                "enable": True,
                "ws_reverse_port": 6199,
                "ws_reverse_token": "SYNTHETIC-ONEBOT-TOKEN",
            }
        ],
        "provider_sources": [{"id": "source", "key": ["SYNTHETIC-KEY"]}],
        "provider": [{"id": "model", "model": "cloud-model", "enable": True}],
        "admins_id": ["123456789"],
        "unknown_top_level": {"keep": [{"x": None}]},
    }
    fish = {
        "owner_qq": "123456789",
        "owner_umo": "old-qq:FriendMessage:123456789",
        "proactive_enabled": True,
        "bili_enabled": True,
        "qq_signature_enabled": True,
        "qzone_enabled": True,
        "discover_enabled": True,
        "daily_limit": 0,
        "quiet_end": "",
        "persona": "SYNTHETIC-PRIVATE-PERSONA",
        "legacy_unknown": {"a": [1, 2]},
    }
    config_file = data / "cmd_config.json"
    fish_file = data / "config/astrbot_plugin_dswhale_config.json"
    config_file.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    fish_file.write_text(json.dumps(fish, ensure_ascii=False), encoding="utf-8")
    database = data / "state.db"
    database.write_bytes(b"SYNTHETIC-DATABASE-SENTINEL")
    config_bytes = config_file.read_bytes()

    install_plugin(host)
    install_plugin(host)
    assert config_file.read_bytes() == config_bytes
    assert database.read_bytes() == b"SYNTHETIC-DATABASE-SENTINEL"
    first = migrate_settings(host)
    assert first["changed"] is True
    migrated = json.loads(fish_file.read_text(encoding="utf-8"))
    for key, value in fish.items():
        assert migrated[key] == value, key
    assert migrated["qq_default_delivery"] == ""
    assert migrated["config_migration_version"] == 1
    assert config_file.read_bytes() == config_bytes
    assert database.read_bytes() == b"SYNTHETIC-DATABASE-SENTINEL"
    assert migrate_settings(host)["changed"] is False
