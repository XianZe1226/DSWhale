import json

import pytest
from filelock import FileLock


def host_files(tmp_path):
    host = tmp_path / "中文 空格"
    data = host / "data"
    (data / "config").mkdir(parents=True)
    (data / "cmd_config.json").write_text(
        json.dumps(
            {
                "dashboard": {"port": 6185},
                "platform": [],
                "provider": [{"id": "retain", "model": "cloud", "enable": True}],
                "provider_sources": [{"api_key": "test-only-secret"}],
                "admins_id": [],
            }
        ),
        encoding="utf-8",
    )
    (data / "config/astrbot_plugin_dswhale_config.json").write_text(
        json.dumps({"persona": "a custom private persona", "owner_qq": "", "owner_umo": ""}),
        encoding="utf-8",
    )
    return host


def test_save_preserves_models_persona_and_creates_loopback_onebot(tmp_path):
    from dswhale.desktop_settings import read_settings, save_settings

    host = host_files(tmp_path)
    original = json.loads((host / "data/cmd_config.json").read_text())
    save_settings(
        host,
        {
            "ownerQQ": "123456789",
            "platformId": "dswhale-qq",
            "onebotPort": 6199,
            "onebotToken": "",
            "biliEnabled": True,
            "proactiveEnabled": False,
        },
    )
    config = json.loads((host / "data/cmd_config.json").read_text())
    assert config["provider"] == original["provider"]
    assert config["provider_sources"] == original["provider_sources"]
    platform = config["platform"][0]
    assert platform["type"] == "aiocqhttp"
    assert platform["ws_reverse_host"] == "127.0.0.1"
    assert len(platform["ws_reverse_token"]) >= 32
    fish = json.loads((host / "data/config/astrbot_plugin_dswhale_config.json").read_text())
    assert fish["persona"] == "a custom private persona"
    assert fish["owner_umo"] == "dswhale-qq:FriendMessage:123456789"
    assert read_settings(host)["ownerQQ"] == "123456789"
    assert "api_key" not in str(read_settings(host))
    assert "test-only-secret" not in str(read_settings(host))


def test_settings_refuse_running_host_and_invalid_input(tmp_path):
    from dswhale.desktop_settings import save_settings

    host = host_files(tmp_path)
    before = (host / "data/cmd_config.json").read_bytes()
    for patch in (
        {"ownerQQ": "not QQ"},
        {"onebotPort": 6185},
        {"platformId": "evil:scope"},
        {"arbitraryCommand": "no"},
    ):
        with pytest.raises(ValueError):
            save_settings(host, patch)
        assert (host / "data/cmd_config.json").read_bytes() == before
    with FileLock(host / "astrbot.lock"), pytest.raises(ValueError, match="停止"):
        save_settings(host, {"ownerQQ": "123456789"})


def test_setup_status_contains_no_credentials_and_existing_platform_id_retained(tmp_path):
    from dswhale.desktop_settings import read_settings, save_settings, setup_status

    host = host_files(tmp_path)
    fish = host / "data/config/astrbot_plugin_dswhale_config.json"
    fish.write_text(
        json.dumps({"owner_qq": "123456789", "owner_umo": "original:FriendMessage:123456789"})
    )
    config = host / "data/cmd_config.json"
    value = json.loads(config.read_text())
    value["platform"] = [
        {
            "id": "original",
            "type": "aiocqhttp",
            "enable": True,
            "ws_reverse_port": 6199,
            "ws_reverse_token": "keep-existing-token",
        }
    ]
    config.write_text(json.dumps(value))
    assert read_settings(host)["platformId"] == "original"
    save_settings(host, {"proactiveEnabled": False})
    assert read_settings(host)["platformId"] == "original"
    status = setup_status(host)
    assert status["qqConfigured"] and status["ownerConfigured"] and status["modelConfigured"]
    assert "keep-existing-token" not in str(status)


def test_import_prepares_loopback_and_clears_only_unavailable_tool_paths(tmp_path):
    from dswhale.desktop_settings import prepare_import

    host = host_files(tmp_path)
    config_file = host / "data/cmd_config.json"
    config = json.loads(config_file.read_text())
    config["dashboard"] = {
        "host": "0.0.0.0",
        "port": 6301,
        "ssl": {"enable": True},
        "pbkdf2_password": "keep-password-hash",
    }
    config_file.write_text(json.dumps(config))
    fish_file = host / "data/config/astrbot_plugin_dswhale_config.json"
    fish = json.loads(fish_file.read_text())
    fish.update(
        bili_node_path=str(tmp_path / "old-machine/node"),
        cookies_path=str(tmp_path / "old-machine/cookies.txt"),
    )
    fish_file.write_text(json.dumps(fish))
    prepare_import(host)
    result = json.loads(config_file.read_text())
    assert result["dashboard"]["host"] == "127.0.0.1"
    assert result["dashboard"]["port"] == 6301
    assert result["dashboard"]["ssl"]["enable"] is False
    assert result["dashboard"]["pbkdf2_password"] == "keep-password-hash"
    assert (
        result["provider"] == config["provider"]
        and result["provider_sources"] == config["provider_sources"]
    )
    result = json.loads(fish_file.read_text())
    assert result["bili_node_path"] == result["cookies_path"] == ""
    assert result["persona"] == fish["persona"]


def test_desktop_backup_restores_pending_first_login_on_another_machine(tmp_path):
    import hashlib

    from dswhale.desktop_settings import finish_backup, prepare_backup, prepare_import
    from dswhale.install import backup, restore

    host = host_files(tmp_path / "old-device")
    password, salt = "Synthetic-initial-password-123456789", "11" * 16
    config_file = host / "data/cmd_config.json"
    config = json.loads(config_file.read_text())
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 100000).hex()
    config["dashboard"].update(
        username="astrbot",
        password_change_required=True,
        pbkdf2_password=f"pbkdf2_sha256$100000${salt}${digest}",
    )
    config_file.write_text(json.dumps(config))
    login = {"username": "astrbot", "password": password}
    (host.parent / "desktop-auth.json").write_text(json.dumps(login))
    prepare_backup(host)
    archive = tmp_path / "private-backup.zip"
    backup(host, archive)
    finish_backup(host)
    assert not (host / "data/.dswhale-desktop-login.json").exists()
    new_host = tmp_path / "new-device/host"
    restore(new_host, archive)
    prepare_import(new_host)
    assert json.loads((new_host.parent / "desktop-auth.json").read_text()) == login
    assert not (new_host / "data/.dswhale-desktop-login.json").exists()
    result = json.loads((new_host / "data/cmd_config.json").read_text())
    assert result["dashboard"]["pbkdf2_password"] == config["dashboard"]["pbkdf2_password"]
