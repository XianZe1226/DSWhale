"""Synthetic upgrade preservation: additive migrations, no default overwrites."""

import json

import pytest

from dswhale.config_migrations import (
    MIGRATION_VERSION,
    VERSION_KEY,
    detect_unexpected_changes,
    plan_migration,
)

REALISTIC_FISH = {
    "owner_qq": "123456789",
    "owner_umo": "old-qq:FriendMessage:123456789",
    "qq_connection_mode": "napcat",
    "official_owner_umo": "",
    "proactive_enabled": True,
    "bili_enabled": True,
    "qq_signature_enabled": True,
    "qzone_enabled": True,
    "discover_enabled": True,
    "timezone": "Asia/Shanghai",
    "quiet_start": "00:00",
    "quiet_end": "",
    "daily_limit": 0,
    "unanswered_limit": 2,
    "persona": "SYNTHETIC-PRIVATE-PERSONA",
    "custom": {"nested": [1, {"keep": None}], "empty": {}},
    "legacy_unknown_field": {"a": [1, 2, 3]},
    "explicit_null": None,
    "explicit_false": False,
    "explicit_zero": 0,
    "explicit_empty_list": [],
}

REALISTIC_CONFIG = {
    "dashboard": {"host": "127.0.0.1", "port": 6185, "ssl": {"enable": False}},
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
            "enable": True,
            "appid": "SYNTHETIC-APPID",
            "secret": "SYNTHETIC-SECRET",
        },
    ],
    "provider_sources": [{"id": "source-1", "key": ["SYNTHETIC-KEY"]}],
    "provider": [{"id": "model-1", "model": "cloud-model", "enable": True}],
    "admins_id": ["123456789"],
    "unknown_top_level": {"keep": [{"x": 1}]},
}


@pytest.mark.parametrize("skip_default", [False, True])
def test_plan_migration_preserves_every_existing_value_and_is_idempotent(skip_default):
    fish = dict(REALISTIC_FISH)
    if skip_default:
        fish["qq_default_delivery"] = "official"
    candidate, changes = plan_migration({"config": REALISTIC_CONFIG, "fish": fish})
    assert candidate["config"] == REALISTIC_CONFIG
    for key, value in fish.items():
        assert candidate["fish"][key] == value, key
    if not skip_default:
        assert candidate["fish"]["qq_default_delivery"] == ""
    assert candidate["fish"][VERSION_KEY] == MIGRATION_VERSION
    assert changes
    again, second_changes = plan_migration(candidate)
    assert second_changes == []
    assert again == candidate


def test_plan_migration_does_not_treat_falsey_values_as_missing():
    fish = {
        "proactive_enabled": False,
        "daily_limit": 0,
        "quiet_start": "",
        "persona": "",
        "empty_list": [],
        "empty_dict": {},
        "nullable": None,
    }
    candidate, changes = plan_migration({"config": {}, "fish": fish})
    for key, value in fish.items():
        assert candidate["fish"][key] == value, key
    assert [change["field"] for change in changes] == ["qq_default_delivery", VERSION_KEY]


def test_plan_migration_rejects_invalid_documents_and_version_rollback():
    with pytest.raises(ValueError):
        plan_migration([])
    with pytest.raises(ValueError):
        plan_migration({"config": [], "fish": {}})
    with pytest.raises(ValueError):
        plan_migration({"config": {}, "fish": {}}, from_version=9, to_version=1)
    with pytest.raises(ValueError):
        plan_migration({"config": {}, "fish": {VERSION_KEY: "one"}})


def test_detect_unexpected_changes_flags_trimmed_unknown_and_changed_flags():
    before = {"proactive_enabled": True, "unknown": {"x": 1}, "nested": {"keep": 2}}
    after = {"proactive_enabled": False, "nested": {"keep": 2}}
    problems = detect_unexpected_changes(before, after)
    assert {"path": "proactive_enabled", "kind": "changed"} in problems
    assert {"path": "unknown", "kind": "removed"} in problems
    assert not any(item["path"].startswith("nested") for item in problems)


def test_detect_unexpected_changes_ignores_additions_and_allowlisted_paths():
    before = {"proactive_enabled": True}
    after = {"proactive_enabled": True, "qq_default_delivery": "", "config_migration_version": 1}
    assert detect_unexpected_changes(before, after) == []
    before = {"old": 1}
    after = {}
    assert detect_unexpected_changes(before, after, allowed_added=()) == [
        {"path": "old", "kind": "removed"}
    ]


def test_migrate_settings_preserves_values_database_and_unknown_fields(tmp_path):
    from dswhale.desktop_settings import migrate_settings, read_settings

    host = _host(tmp_path)
    fish_file = host / "data/config/astrbot_plugin_dswhale_config.json"
    fish_file.write_text(json.dumps(REALISTIC_FISH), encoding="utf-8")
    database = host / "data/state.db"
    database.write_bytes(b"SYNTHETIC-DATABASE-SENTINEL")
    config_bytes = (host / "data/cmd_config.json").read_bytes()
    result = migrate_settings(host)
    assert result["changed"] is True
    assert result["migrationVersion"] == MIGRATION_VERSION
    migrated = json.loads(fish_file.read_text(encoding="utf-8"))
    for key, value in REALISTIC_FISH.items():
        assert migrated[key] == value, key
    assert migrated["qq_default_delivery"] == ""
    assert (host / "data/cmd_config.json").read_bytes() == config_bytes
    assert database.read_bytes() == b"SYNTHETIC-DATABASE-SENTINEL"
    revision = read_settings(host)["configRevision"]
    backups = list((host / ".desktop-settings-backups").iterdir())
    assert len(backups) == 1
    second = migrate_settings(host)
    assert second["changed"] is False and second["changes"] == []
    assert read_settings(host)["configRevision"] == revision
    assert len(list((host / ".desktop-settings-backups").iterdir())) == 1
    assert detect_unexpected_changes(REALISTIC_FISH, migrated) == []


def test_migrate_settings_missing_file_is_noop_and_corrupt_file_is_preserved(tmp_path):
    from dswhale.desktop_settings import migrate_settings

    host = _host(tmp_path)
    fish_file = host / "data/config/astrbot_plugin_dswhale_config.json"
    fish_file.unlink(missing_ok=True)
    assert migrate_settings(host) == {"changed": False, "migrationVersion": 0, "changes": []}
    assert not fish_file.exists()
    fish_file.write_bytes(b"{not valid json")
    with pytest.raises(ValueError):
        migrate_settings(host)
    assert fish_file.read_bytes() == b"{not valid json"


def _host(tmp_path):
    host = tmp_path / "升级 主机"
    data = host / "data"
    (data / "config").mkdir(parents=True)
    (data / "cmd_config.json").write_text(json.dumps(REALISTIC_CONFIG), encoding="utf-8")
    return host


def _scenario_host(tmp_path, scenario):
    host = tmp_path / f"迁移-{scenario}"
    data = host / "data"
    (data / "config").mkdir(parents=True)
    np_platform = {
        "id": "old-qq",
        "type": "aiocqhttp",
        "enable": scenario in {"napcat", "both"},
        "ws_reverse_host": "127.0.0.1",
        "ws_reverse_port": 6199,
        "ws_reverse_token": "SYNTHETIC-ONEBOT-TOKEN",
    }
    official_platform = {
        "id": "official-test",
        "type": "qq_official",
        "enable": scenario in {"official", "both"},
        "appid": "SYNTHETIC-APPID",
        "secret": "SYNTHETIC-SECRET",
    }
    config = {
        "dashboard": {"port": 6185},
        "platform": [np_platform, official_platform],
        "provider": [],
        "provider_sources": [],
    }
    fish = {"persona": "SYNTHETIC-PERSONA"}
    if scenario in {"napcat", "both"}:
        fish.update(owner_qq="123456789", owner_umo="old-qq:FriendMessage:123456789")
    if scenario in {"official", "both"}:
        fish.update(official_owner_umo="official-test:FriendMessage:OPAQUE")
    if scenario == "both":
        fish["qq_default_delivery"] = "official"
    (data / "cmd_config.json").write_text(json.dumps(config), encoding="utf-8")
    if scenario != "fresh":
        (data / "config/astrbot_plugin_dswhale_config.json").write_text(
            json.dumps(fish), encoding="utf-8"
        )
    return host, config, fish


@pytest.mark.parametrize("scenario", ["napcat", "official", "both", "fresh"])
def test_upgrade_scenarios_preserve_channels_bindings_and_default_delivery(tmp_path, scenario):
    from dswhale.desktop_settings import migrate_settings, read_settings, save_settings

    host, config, fish = _scenario_host(tmp_path, scenario)
    before = json.loads((host / "data/cmd_config.json").read_text())
    migrate_settings(host)
    result = migrate_settings(host)
    assert result["changed"] is False
    after = json.loads((host / "data/cmd_config.json").read_text())
    assert after["platform"] == before["platform"]
    settings = read_settings(host)
    if scenario in {"napcat", "both"}:
        assert settings["napcatBound"] is True
        assert settings["napcatConfigured"] is True
    if scenario in {"official", "both"}:
        assert settings["officialBound"] is True
        assert settings["officialConfigured"] is True
    if scenario == "both":
        assert settings["defaultDelivery"] == "official"
    if scenario != "fresh":
        save_settings(host, {"dashboardPort": 6285})
        saved = json.loads((host / "data/config/astrbot_plugin_dswhale_config.json").read_text())
        for key, value in fish.items():
            assert saved[key] == value, key
        after_save = json.loads((host / "data/cmd_config.json").read_text())
        assert after_save["platform"] == before["platform"]
    else:
        assert read_settings(host)["defaultDelivery"] == ""
