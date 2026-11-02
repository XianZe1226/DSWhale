"""Bridge process isolation and IPC robustness."""

import asyncio
import json
import stat
from types import SimpleNamespace

from dswhale.bili import BiliService, bridge_environment, write_control_file


def test_bridge_environment_drops_node_injection_and_keeps_owned_values(tmp_path):
    base = {
        "PATH": "/usr/bin",
        "HOME": "/home/test",
        "NODE_OPTIONS": "--require /tmp/evil.js",
        "NODE_PATH": "/tmp/evil",
        "ELECTRON_RUN_AS_NODE": "1",
    }
    env = bridge_environment(base, root=tmp_path, timezone="Asia/Shanghai")
    assert "NODE_OPTIONS" not in env
    assert "NODE_PATH" not in env
    assert "ELECTRON_RUN_AS_NODE" not in env
    assert env["PATH"] == "/usr/bin"
    assert env["HOME"] == "/home/test"
    assert env["DSWHALE_BILI_HOME"] == str(tmp_path.resolve())
    assert env["TZ"] == "Asia/Shanghai"


def test_control_file_is_created_private(tmp_path):
    path = tmp_path / "control.json"
    write_control_file(path, {"port": 1234, "token": "secret-token"})
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "port": 1234,
        "token": "secret-token",
    }
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


class FakeStdout:
    def __init__(self, lines):
        self.lines = list(lines)

    async def readline(self):
        return self.lines.pop(0) if self.lines else b""


async def test_malformed_bridge_output_does_not_stop_reader(tmp_path):
    service = object.__new__(BiliService)
    service.closed = False
    service.root = tmp_path
    service.token = "t" * 32
    service.port = None
    service.ready = asyncio.Event()
    service.process = SimpleNamespace(
        stdout=FakeStdout(
            [
                b"not-json\n",
                b"[1, 2, 3]\n",
                b'{"type": "ready", "port": "bad"}\n',
                json.dumps({"type": "ready", "port": 54321}).encode() + b"\n",
            ]
        )
    )
    service.companion = SimpleNamespace(last_error="")
    await service._read()
    assert service.ready.is_set()
    assert service.port == 54321
    control = json.loads((tmp_path / "control.json").read_text(encoding="utf-8"))
    assert control == {"port": 54321, "token": "t" * 32}
    assert stat.S_IMODE((tmp_path / "control.json").stat().st_mode) == 0o600
