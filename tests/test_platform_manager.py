"""Platform enable/disable through the pinned SDK config, with no credentials exposed."""

import json
from pathlib import Path

import pytest
from filelock import FileLock

from dswhale.platform_manager import read_platforms, set_platform_enabled


def host_files(tmp_path):
    host = tmp_path / "平台 主机"
    (host / "data").mkdir(parents=True)
    config = {
        "dashboard": {"port": 6185},
        "platform": [
            {
                "id": "old-qq",
                "type": "aiocqhttp",
                "enable": True,
                "ws_reverse_port": 6199,
                "ws_reverse_token": "SYNTHETIC-ONEBOT-TOKEN",
            },
            {
                "id": "official-test",
                "type": "qq_official",
                "enable": False,
                "appid": "SYNTHETIC-APPID",
                "secret": "SYNTHETIC-SECRET",
            },
            {"id": "other", "type": "webchat", "enable": True},
        ],
        "unknown": {"keep": True},
    }
    (host / "data/cmd_config.json").write_text(json.dumps(config), encoding="utf-8")
    return host, config


def test_status_returns_only_supported_public_fields(tmp_path):
    host, _ = host_files(tmp_path)
    value = read_platforms(host)
    assert [item["id"] for item in value["platforms"]] == ["old-qq", "official-test"]
    text = json.dumps(value)
    for secret in ("SYNTHETIC-ONEBOT-TOKEN", "SYNTHETIC-APPID", "SYNTHETIC-SECRET"):
        assert secret not in text
    assert value["platforms"][1]["configured"] is True
    assert value["platforms"][1]["enable"] is False


def test_toggle_changes_only_enable_and_preserves_unknown_fields(tmp_path):
    host, config = host_files(tmp_path)
    before = (host / "data/cmd_config.json").read_bytes()
    set_platform_enabled(host, "official-test", True)
    updated = json.loads((host / "data/cmd_config.json").read_text())
    assert updated["platform"][1]["enable"] is True
    assert updated["platform"][1]["appid"] == "SYNTHETIC-APPID"
    assert updated["platform"][0] == config["platform"][0]
    assert updated["unknown"] == {"keep": True}
    assert before != (host / "data/cmd_config.json").read_bytes()
    current = (host / "data/cmd_config.json").read_bytes()
    set_platform_enabled(host, "official-test", True)
    assert (host / "data/cmd_config.json").read_bytes() == current


def test_invalid_platform_config_and_running_lock_are_rejected(tmp_path):
    host, _ = host_files(tmp_path)
    before = (host / "data/cmd_config.json").read_bytes()
    for target in ("missing", "other"):
        with pytest.raises(ValueError):
            set_platform_enabled(host, target, False)
    assert (host / "data/cmd_config.json").read_bytes() == before
    with FileLock(host / "astrbot.lock"):
        with pytest.raises(ValueError, match="停止"):
            set_platform_enabled(host, "old-qq", False)
    assert (host / "data/cmd_config.json").read_bytes() == before
    (host / "data/cmd_config.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError):
        read_platforms(host)


def test_duplicate_platform_ids_are_rejected_instead_of_guessing(tmp_path):
    host, config = host_files(tmp_path)
    duplicate = dict(config["platform"][1])
    config["platform"].append(duplicate)
    (host / "data/cmd_config.json").write_text(json.dumps(config), encoding="utf-8")
    before = (host / "data/cmd_config.json").read_bytes()
    with pytest.raises(ValueError, match="重复"):
        set_platform_enabled(host, "official-test", True)
    assert (host / "data/cmd_config.json").read_bytes() == before


def _pending_state(host):
    return host / "data/plugin_data/astrbot_plugin_dswhale/state.db"


def test_pending_activity_missing_database_is_explicit_fresh_install(tmp_path):
    from dswhale.platform_manager import pending_activity

    host, _ = host_files(tmp_path)
    assert pending_activity(host) == {"pending": False, "database": "missing"}


def test_pending_activity_read_failures_are_unknown_not_empty(tmp_path):
    import sqlite3

    from dswhale.platform_manager import pending_activity

    host, _ = host_files(tmp_path)
    state = _pending_state(host)
    state.parent.mkdir(parents=True)
    # Corrupt file.
    state.write_bytes(b"not a sqlite database")
    with pytest.raises(ValueError, match="无法确认"):
        pending_activity(host)
    # Valid sqlite file without the activities table.
    state.write_bytes(b"")
    with sqlite3.connect(state) as db:
        db.execute("CREATE TABLE other(value TEXT)")
    with pytest.raises(ValueError, match="无法确认"):
        pending_activity(host)
    # Real write lock while reading.
    state.unlink()
    with sqlite3.connect(state) as db:
        db.execute("CREATE TABLE activities(status TEXT)")
        db.execute("INSERT INTO activities VALUES('reserved')")
        db.commit()
    writer = sqlite3.connect(state, timeout=1)
    try:
        writer.execute("BEGIN EXCLUSIVE")
        with pytest.raises(ValueError, match="无法确认"):
            pending_activity(host)
    finally:
        writer.rollback()
        writer.close()


def test_pending_activity_cli_propagates_unknown_as_failure(tmp_path):
    import os
    import subprocess
    import sys

    host, _ = host_files(tmp_path)
    state = _pending_state(host)
    state.parent.mkdir(parents=True)
    state.write_bytes(b"not a sqlite database")
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(Path(__file__).parents[1]), env.get("PYTHONPATH", "")]
    ).strip(os.pathsep)
    completed = subprocess.run(
        [sys.executable, "-m", "dswhale.platform_manager", "pending", "--host", str(host)],
        cwd=Path(__file__).parents[1],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode != 0
    assert "无法确认" in completed.stdout
