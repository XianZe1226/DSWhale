import importlib
import json
import zipfile
from pathlib import Path

import pytest

SENTINEL = "PRIVATE-PERSONA-KEY-TOKEN-CHAT-123456789"


@pytest.fixture
def host(tmp_path):
    host = tmp_path / "host"
    config = host / "data/config"
    config.mkdir(parents=True)
    (host / "data/cmd_config.json").write_text(
        json.dumps(
            {
                "provider": [{"enable": True, "model": SENTINEL}],
                "provider_sources": [{"key": SENTINEL}],
                "platform": [
                    {
                        "type": "aiocqhttp",
                        "enable": True,
                        "ws_reverse_port": 6199,
                        "ws_reverse_token": SENTINEL,
                    }
                ],
                "dashboard": {"host": "127.0.0.1", "port": 6185},
            }
        )
    )
    (config / "astrbot_plugin_dswhale_config.json").write_text(
        json.dumps(
            {
                "persona": SENTINEL,
                "owner_qq": "123456789",
                "owner_umo": "qq:FriendMessage:123456789",
                "bili_enabled": True,
            }
        )
    )
    (config / "astrbot_plugin_livingmemory_config.json").write_text(
        json.dumps({"basic_settings": {"embedding_provider_id": SENTINEL}})
    )
    code = host / "data/plugins/astrbot_plugin_dswhale/dswhale/bili_bridge/upstream/lib"
    code.mkdir(parents=True)
    original = (
        Path(__file__).resolve().parents[1] / "dswhale/bili_bridge/upstream/lib/credentials.js"
    )
    (code / "credentials.js").write_bytes(original.read_bytes())
    return host


def test_health_reports_missing_public_component_without_private_values(host):
    module = importlib.import_module("dswhale.desktop_health")
    result = module.inspect_host(host)
    assert SENTINEL not in json.dumps(result) and "123456789" not in json.dumps(result)
    package = next(c for c in result["checks"] if c["id"] == "bili-files")
    assert package["ok"] is True
    (
        host / "data/plugins/astrbot_plugin_dswhale/dswhale/bili_bridge/upstream/lib/credentials.js"
    ).unlink()
    result = module.inspect_host(host)
    package = next(c for c in result["checks"] if c["id"] == "bili-files")
    assert package["ok"] is False and package["code"] == "PKG-001"
    assert result["summary"]["requiredFailures"] > 0


def test_diagnostic_export_positive_fields_only(host, tmp_path):
    module = importlib.import_module("dswhale.desktop_health")
    runtime = host.parent
    events = runtime / "logs/events.jsonl"
    events.parent.mkdir()
    events.write_text(
        json.dumps(
            {
                "code": "PKG-001",
                "component": "bilibili",
                "action": "health",
                "at": "2026-11-01T10:00:00.000Z",
                "secret": SENTINEL,
            }
        )
        + "\n"
        + json.dumps({"code": SENTINEL, "component": SENTINEL, "action": SENTINEL, "at": SENTINEL})
    )
    output = tmp_path / "diagnostics.zip"
    module.export_diagnostics(host, output)
    with zipfile.ZipFile(output) as z:
        assert set(z.namelist()) == {"health.json", "events.json", "versions.json", "README.txt"}
        body = b"\n".join(z.read(n) for n in z.namelist())
        assert SENTINEL.encode() not in body and b"123456789" not in body
        assert str(tmp_path).encode() not in body
        assert b"PKG-001" in body
    with pytest.raises(ValueError):
        module.export_diagnostics(host, output)
