"""Exercise the real fixed-SDK first read used by the desktop upgrade flow."""

import json
import os
import stat
from pathlib import Path

import pytest

from dswhale import config_migrations
from dswhale.upgrade_verify import VerifyError, verify_first_sdk_read

REPO = Path(__file__).parents[1]


def host_with_settings(tmp_path, fish, *, schema=True):
    host = tmp_path / "host"
    config = host / "data/config/astrbot_plugin_dswhale_config.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps(fish), encoding="utf-8")
    if schema:
        plugin = host / "data/plugins/astrbot_plugin_dswhale"
        plugin.mkdir(parents=True)
        (plugin / "_conf_schema.json").write_text(
            (REPO / "_conf_schema.json").read_text(encoding="utf-8"), encoding="utf-8"
        )
    return host, config


def support_settings(**extra):
    fish = {
        "owner_qq": "123456789",
        "owner_umo": "old-qq:FriendMessage:123456789",
        "proactive_enabled": False,
        "daily_limit": 0,
        "quiet_end": "",
        "persona": "SYNTHETIC-PRIVATE-PERSONA",
        "qq_default_delivery": "official",
        "config_migration_version": 1,
        **extra,
    }
    return fish


def test_first_sdk_read_preserves_values_archives_legacy_and_writes_receipt(tmp_path):
    fish = support_settings(
        legacy_unknown_field={"a": [1, 2, 3]}, legacy_empty_dict={}, legacy_empty_list=[]
    )
    host, config = host_with_settings(tmp_path, fish)
    result = verify_first_sdk_read(host)
    assert result["status"] == "verified"
    receipt = result["receipt"]
    assert receipt["migrationVersion"] == 1
    assert receipt["sdkVersion"] == "4.29.3"
    assert set(receipt["archivedFields"]) >= {
        "legacy_unknown_field",
        "legacy_empty_dict",
        "legacy_empty_list",
    }
    assert receipt["normalizedConfig"] is True
    saved = json.loads(config.read_text(encoding="utf-8"))
    assert saved["proactive_enabled"] is False
    assert saved["daily_limit"] == 0
    assert saved["quiet_end"] == ""
    assert saved["persona"] == fish["persona"]
    assert saved["qq_default_delivery"] == "official"
    assert saved["config_migration_version"] == 1
    assert "legacy_unknown_field" not in saved
    receipt_file = host / "data/plugin_data/astrbot_plugin_dswhale/config-migration-receipt.json"
    assert receipt_file.is_file()
    if os.name != "nt":
        assert stat.S_IMODE(receipt_file.stat().st_mode) == 0o600
    archive = host / receipt["archiveFile"]
    if os.name != "nt":
        assert stat.S_IMODE(archive.stat().st_mode) == 0o600
    archived = json.loads(archive.read_text(encoding="utf-8"))
    assert archived["fields"]["legacy_unknown_field"] == {"a": [1, 2, 3]}
    assert archived["fields"]["legacy_empty_dict"] == {}
    assert archived["fields"]["legacy_empty_list"] == []

    # The later real first read is now stable: repeated verification changes
    # nothing and does not create another archive.
    archives = list((host / "data/config/.dswhale-config-archives").glob("*.json"))
    second = verify_first_sdk_read(host)
    assert second["receipt"]["normalizedConfig"] is False
    assert list((host / "data/config/.dswhale-config-archives").glob("*.json")) == archives
    assert json.loads(config.read_text(encoding="utf-8")) == saved


def test_first_sdk_read_refuses_supported_value_changes_before_writing(tmp_path):
    fish = support_settings(official_owner_umo=None)
    host, config = host_with_settings(tmp_path, fish)
    before = config.read_bytes()
    with pytest.raises(VerifyError, match="受支持设置"):
        verify_first_sdk_read(host)
    assert config.read_bytes() == before
    assert not (host / "data/plugin_data/astrbot_plugin_dswhale").exists()
    assert not (host / "data/config/.dswhale-config-archives").exists()


def test_first_sdk_read_requires_settings_and_schema_but_skips_without_settings(tmp_path):
    host, _ = host_with_settings(tmp_path, support_settings(), schema=False)
    with pytest.raises(VerifyError, match="schema"):
        verify_first_sdk_read(host)
    empty = tmp_path / "empty-host"
    (empty / "data").mkdir(parents=True)
    assert verify_first_sdk_read(empty) == {
        "status": "skipped",
        "reason": "settings not present",
    }


def test_semantic_comparison_includes_empty_containers_and_types():
    before = {
        "empty_dict": {},
        "empty_list": [],
        "flag": False,
        "zero": 0,
        "nested": {"empty": []},
        "list": [1],
    }
    after = {"flag": 0, "zero": False, "nested": {}, "list": [1, 2]}
    problems = config_migrations.detect_unexpected_changes(before, after)
    kinds = {(item["path"], item["kind"]) for item in problems}
    assert ("empty_dict", "removed") in kinds
    assert ("empty_list", "removed") in kinds
    assert ("nested.empty", "removed") in kinds
    assert ("flag", "changed") in kinds
    assert ("zero", "changed") in kinds
    assert not any(item["path"].startswith("list[1]") for item in problems)


def _cli_environment(host):
    import os

    env = dict(os.environ)
    env["ASTRBOT_ROOT"] = str(host)
    env["PYTHONPATH"] = os.pathsep.join([str(REPO), env.get("PYTHONPATH", "")]).strip(os.pathsep)
    return env


def _run_isolated_cli(host):
    import subprocess
    import sys

    return subprocess.run(
        [sys.executable, "-m", "dswhale.upgrade_verify", "--host", str(host)],
        cwd=host,
        env=_cli_environment(host),
        capture_output=True,
        text=True,
        timeout=180,
    )


def _relative_key(host, path):
    return path.relative_to(host).as_posix()


def _host_files(host):
    return {_relative_key(host, path) for path in host.rglob("*") if path.is_file()}


def test_isolated_cli_success_and_refusal_leave_source_host_config_byte_identical(tmp_path):
    # The source host config must never be touched by the verification import,
    # even though the production child is started with ASTRBOT_ROOT=host.
    config = {
        "dashboard": {"host": "127.0.0.1", "port": 6185},
        "provider": [{"id": "synthetic-model", "model": "cloud"}],
        "custom_marker": {"keep": [1, 2]},
        "legacy_unknown": {"private": "synthetic"},
    }
    fish = support_settings(official_owner_umo=None, legacy_old={"a": 1})
    host, fish_file = host_with_settings(tmp_path / "refuse", fish)
    (host / "data/cmd_config.json").write_text(json.dumps(config), encoding="utf-8")
    before = {path: (host / path).read_bytes() for path in _host_files(host)}
    refused = _run_isolated_cli(host)
    assert refused.returncode != 0
    assert (host / "data/config/astrbot_plugin_dswhale_config.json").read_bytes() == before[
        "data/config/astrbot_plugin_dswhale_config.json"
    ]
    assert (host / "data/cmd_config.json").read_bytes() == before["data/cmd_config.json"]
    assert json.loads((host / "data/cmd_config.json").read_text())["legacy_unknown"] == {
        "private": "synthetic"
    }
    assert set(_host_files(host)) == set(before)

    host, fish_file = host_with_settings(
        tmp_path / "success", support_settings(legacy_old={"a": 1})
    )
    (host / "data/cmd_config.json").write_text(json.dumps(config), encoding="utf-8")
    before = {path: (host / path).read_bytes() for path in _host_files(host)}
    accepted = _run_isolated_cli(host)
    assert accepted.returncode == 0
    assert (host / "data/cmd_config.json").read_bytes() == before["data/cmd_config.json"]
    assert (host / "data/config/astrbot_plugin_dswhale_config.json").read_text()
    after_files = set(_host_files(host))
    added = after_files - set(before)
    assert all(
        path.startswith("data/config/.dswhale-config-archives/")
        or path == "data/plugin_data/astrbot_plugin_dswhale/config-migration-receipt.json"
        for path in added
    ), added
    assert not any(path.endswith("data_v4.db") or "logs/" in path for path in added)


def test_relative_keys_are_posix_on_windows_paths():
    from pathlib import PureWindowsPath

    host = PureWindowsPath(r"C:\host")
    assert _relative_key(host, host / "data/config/astrbot_plugin_dswhale_config.json") == (
        "data/config/astrbot_plugin_dswhale_config.json"
    )
