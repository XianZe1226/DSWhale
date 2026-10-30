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
