"""Bridge process isolation and IPC robustness."""

import asyncio
import json
import stat
from types import SimpleNamespace

import pytest

from dswhale.bili import BiliService, bridge_environment, write_control_file


def test_bridge_environment_drops_node_injection_and_keeps_owned_values(tmp_path):
    base = {
        "PATH": "/usr/bin",
        "HOME": "/home/test",
        "NODE_OPTIONS": "--require /tmp/evil.js",
        "node_options": "--require /tmp/also-evil.js",
        "Node_Path": "/tmp/also-evil",
        "Electron_Run_As_Node": "1",
        "HTTPS_PROXY": "http://127.0.0.1:7890",
        "NO_PROXY": "localhost",
        "NODE_PATH": "/tmp/evil",
        "ELECTRON_RUN_AS_NODE": "1",
    }
    env = bridge_environment(base, root=tmp_path, timezone="Asia/Shanghai")
    assert "NODE_OPTIONS" not in env
    assert "NODE_PATH" not in env
    assert "ELECTRON_RUN_AS_NODE" not in env
    assert not any(
        key.lower() in {"node_options", "node_path", "electron_run_as_node"} for key in env
    )
    assert env["HTTPS_PROXY"] == "http://127.0.0.1:7890"
    assert env["NO_PROXY"] == "localhost"
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
    if __import__("os").name != "nt":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


async def reader_service(tmp_path, data, *, limit=1024 * 1024, eof=True):
    import sys

    from dswhale.bili import BiliLedger

    service = object.__new__(BiliService)
    service.closed = False
    service.root = tmp_path
    service.token = "t" * 32
    service.port = None
    service.ready = asyncio.Event()
    service.tasks = set()
    service.write_lock = asyncio.Lock()
    service.ledger = BiliLedger(tmp_path / "test-ledger.db")
    service.allowed = lambda: True
    service.companion = SimpleNamespace(last_error="")
    # A harmless owned child proves reader shutdown reaps a process and worker.
    service.process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "import sys; sys.stdin.buffer.read()",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        start_new_session=__import__("os").name != "nt",
    )
    reader = asyncio.StreamReader(limit=limit)
    reader.feed_data(data)
    if eof:
        reader.feed_eof()
    service.process.stdout = reader
    return service


async def test_malformed_bridge_output_does_not_stop_reader(tmp_path):
    data = (
        b'not-json\n[1, 2, 3]\n{"type":"ready","port":"bad"}\n'
        b'{"type":"prompt"}\n{"type":"manual"}\n'
        b'{"type":"ready","port":54321}\n'
    )
    service = await reader_service(tmp_path, data)
    try:
        await asyncio.wait_for(service._read(), 3)
        assert service.ready.is_set()
        assert service.port == 54321
        assert service.closed
        assert service.process.returncode is not None
        assert not (tmp_path / "control.json").exists()
        assert service.companion.last_error == "B站整合进程已退出，请检查依赖并重载插件。"
    finally:
        await service.close()


@pytest.mark.parametrize(
    "data",
    [b"x" * (1024 * 1024 + 1) + b"\n", b"x" * (1024 * 1024 + 1), b'{"type":"prompt"', b""],
    ids=["oversized-line", "oversized-no-newline", "truncated-json", "eof"],
)
async def test_reader_failure_or_eof_stops_owned_child_and_worker(tmp_path, data):
    service = await reader_service(tmp_path, data)
    cancelled = asyncio.Event()

    async def worker():
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    service.spawn(worker())
    await asyncio.sleep(0)
    task = service.spawn(service._read())
    try:
        await asyncio.wait_for(task, 3)
        assert service.closed
        assert service.process.returncode is not None
        assert cancelled.is_set()
        assert service.companion.last_error == "B站整合进程已退出，请检查依赖并重载插件。"
        assert not (tmp_path / "control.json").exists()
        assert all(t.done() for t in service.tasks)
    finally:
        await service.close()


async def test_reader_rejects_invalid_packets_and_accepts_valid_followup(tmp_path):
    from unittest.mock import AsyncMock

    invalid = [
        None,
        [],
        3,
        {},
        {"type": []},
        {"type": {}},
        {"type": "unknown", "id": "unknown"},
        {"type": "prompt"},
        {"type": "manual"},
        {"type": "prompt", "id": [], "request": {"requestId": "bad"}},
        {"type": "prompt", "id": "invalid-request", "request": []},
        {
            "type": "prompt",
            "id": "invalid-content",
            "request": {"requestId": "bad", "content": "text"},
        },
        {
            "type": "prompt",
            "id": "invalid-part",
            "request": {"requestId": "bad", "content": [None]},
        },
        {"type": "manual", "id": "invalid-args", "args": "dynamic"},
        {"type": "manual", "id": "invalid-item", "args": ["dynamic", {}]},
        {"type": "manual", "id": "invalid-control", "args": ["dynamic", "bad\nargs"]},
    ]
    valid = {
        "type": "prompt",
        "id": "valid",
        "request": {
            "requestId": "synthetic-request",
            "content": [{"type": "text", "text": "hello"}],
        },
    }
    data = b"\n".join(json.dumps(p).encode() for p in [*invalid, valid]) + b"\n"
    service = await reader_service(tmp_path, data, eof=False)
    replies = []
    accepted = asyncio.Event()
    service.command = AsyncMock()

    async def reply(ident, ok, result=None):
        replies.append((ident, ok))
        if ident == "valid":
            accepted.set()

    service._reply = reply
    task = service.spawn(service._read())
    try:
        await asyncio.wait_for(accepted.wait(), 3)
        assert ("valid", True) in replies
        assert all(not ok for ident, ok in replies if ident != "valid")
        assert service.ledger.status("synthetic-request") == "queued"
        assert service.ledger.status("bad") is None
        service.command.assert_not_awaited()
        assert not service.closed
        service.process.stdout.feed_eof()
        await asyncio.wait_for(task, 3)
        assert service.closed and service.process.returncode is not None
    finally:
        await service.close()


def test_control_file_replaces_existing_inode_privately(tmp_path, monkeypatch):
    import os

    path = tmp_path / "control.json"
    path.write_text("old token")
    path.chmod(0o644)
    old = tmp_path / "old-hardlink"
    os.link(path, old)
    original_dump = json.dump

    def inspect_write(payload, stream):
        assert old.read_text() == "old token"
        assert path.read_text() == "old token"
        assert stat.S_ISREG(os.fstat(stream.fileno()).st_mode)
        if os.name != "nt":
            assert stat.S_IMODE(os.fstat(stream.fileno()).st_mode) == 0o600
        original_dump(payload, stream)

    monkeypatch.setattr(json, "dump", inspect_write)
    write_control_file(path, {"token": "synthetic replacement"})
    assert old.read_text() == "old token"
    assert json.loads(path.read_text())["token"] == "synthetic replacement"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["control.json", "old-hardlink"]


def test_control_file_failure_preserves_old_inode_and_cleans_temp(tmp_path, monkeypatch):
    path = tmp_path / "control.json"
    path.write_text("old token")

    def fail(*args):
        raise OSError("synthetic write failure")

    monkeypatch.setattr(json, "dump", fail)
    with pytest.raises(OSError):
        write_control_file(path, {"token": "replacement"})
    assert path.read_text() == "old token"
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.parametrize("kind", ["symlink", "directory", "fifo"])
def test_control_file_rejects_nonregular_targets_without_blocking(tmp_path, kind):
    import os
    import subprocess
    import sys
    from pathlib import Path

    path = tmp_path / "control.json"
    if kind == "symlink":
        if os.name == "nt":
            pytest.skip("symlink creation can require Windows privileges")
        target = tmp_path / "target"
        target.write_text("old token")
        path.symlink_to(target)
    elif kind == "fifo":
        if not hasattr(os, "mkfifo"):
            pytest.skip("POSIX FIFO")
        os.mkfifo(path)
    else:
        path.mkdir()
    script = """
import sys
from dswhale.bili import write_control_file
try:
    write_control_file(sys.argv[1], {"token": "synthetic"})
except (OSError, ValueError):
    pass
else:
    raise AssertionError("nonregular target accepted")
"""
    try:
        result = subprocess.run(
            [sys.executable, "-c", script, str(path)],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            timeout=3,
        )
    except subprocess.TimeoutExpired:
        pytest.fail("nonregular target blocked the writer")
    assert result.returncode == 0, result.stderr
    assert not list(tmp_path.glob("*.tmp"))


def test_control_file_rejects_untrusted_parent(tmp_path):
    import os

    if os.name == "nt":
        pytest.skip("POSIX ownership and mode; native Windows ACL test covers Windows")
    tmp_path.chmod(0o777)
    with pytest.raises((OSError, ValueError)):
        write_control_file(tmp_path / "control.json", {"token": "synthetic"})
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("fail_acl", [False, "directory", "file", "identity", "timeout"])
def test_windows_control_acl_is_restricted_before_any_secret_write(tmp_path, monkeypatch, fail_acl):
    import os
    import subprocess

    import dswhale.bili as bili

    calls = []
    path = tmp_path / "control.json"
    path.write_text("old token")
    os_proxy = SimpleNamespace(**vars(os))
    os_proxy.name = "nt"
    monkeypatch.setattr(bili, "os", os_proxy)

    def run(args, **kwargs):
        calls.append(args)
        assert kwargs["timeout"] <= 10
        assert kwargs["stderr"] == subprocess.DEVNULL
        assert kwargs["stdout"] == subprocess.DEVNULL
        assert kwargs["check"] is True
        assert path.read_text() == "old token"
        assert args[0].lower().endswith("powershell.exe")
        assert "SetAccessControl" in args[-1]
        assert "SetAccessRuleProtection($true, $false)" in args[-1]
        target = __import__("pathlib").Path(kwargs["env"]["DSWHALE_ACL_PATH"])
        if target.is_file():
            assert target.read_bytes() == b""
        if fail_acl == "timeout":
            raise subprocess.TimeoutExpired(args, 10)
        if (
            fail_acl == "identity"
            or (fail_acl == "directory" and target.is_dir())
            or (fail_acl == "file" and target.is_file())
        ):
            raise subprocess.CalledProcessError(1, args, stderr=b"private diagnostic")
        return SimpleNamespace(stdout="", returncode=0)

    monkeypatch.setattr(subprocess, "run", run)
    if fail_acl:
        with pytest.raises(OSError, match="Windows") as error:
            write_control_file(path, {"token": "replacement"})
        assert "private diagnostic" not in str(error.value)
        assert path.read_text() == "old token"
    else:
        write_control_file(path, {"token": "replacement"})
        assert json.loads(path.read_text())["token"] == "replacement"
        assert len(calls) == 2  # Directory secured before empty staging file.

    assert calls
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.skipif(__import__("os").name != "nt", reason="native Windows DACL validation")
def test_windows_control_file_native_owner_only_dacl(tmp_path, monkeypatch):
    import os
    import subprocess

    path = tmp_path / "control.json"
    original_dump = json.dump

    def check_acl(payload, stream):
        script = (
            '$ErrorActionPreference = "Stop"; '
            "$acl = [System.IO.File]::GetAccessControl($env:WHALE_TEST_ACL_FILE); "
            "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; "
            "sids = @($acl.GetAccessRules($true, $true, "
            "[System.Security.Principal.SecurityIdentifier]) | "
            "ForEach-Object { $_.IdentityReference.Value }); "
            "current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } "
            "| ConvertTo-Json -Compress"
        )
        acl = json.loads(
            subprocess.check_output(
                ["powershell.exe", "-NoProfile", "-Command", script],
                env={**os.environ, "WHALE_TEST_ACL_FILE": str(stream.name)},
                text=True,
                timeout=10,
            )
        )
        assert acl["protected"] is True
        assert acl["sids"] == [acl["current"]]
        assert __import__("pathlib").Path(stream.name).stat().st_size == 0
        original_dump(payload, stream)

    monkeypatch.setattr(json, "dump", check_acl)
    write_control_file(path, {"token": "synthetic"})


async def test_reader_failure_before_ready_fails_start_promptly(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    service = await reader_service(tmp_path, b"x" * (1024 * 1024 + 1) + b"\n")
    service.settings = SimpleNamespace(timezone="Asia/Shanghai")
    service.node = "unused-synthetic-node"
    service._work = AsyncMock()
    process = service.process

    original_create = asyncio.create_subprocess_exec

    async def create(*args, **kwargs):
        if args[0] == "taskkill":
            return await original_create(*args, **kwargs)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
    try:
        with pytest.raises(RuntimeError, match="B站整合进程"):
            await asyncio.wait_for(service.start(), 3)
        assert service.closed and process.returncode is not None
        service._work.assert_not_awaited()
    finally:
        await service.close()


async def test_failed_manual_reply_reaps_child_and_retrieves_task_error(tmp_path):
    from unittest.mock import AsyncMock

    service = await reader_service(tmp_path, b"", eof=False)
    service.command = AsyncMock(return_value={"ok": True})
    service._reply = AsyncMock(side_effect=BrokenPipeError("synthetic private diagnostic"))
    loop = asyncio.get_running_loop()
    unhandled = []
    previous = loop.get_exception_handler()
    stopped = asyncio.Event()
    original_close = service.close

    async def close():
        await original_close()
        stopped.set()

    service.close = close
    loop.set_exception_handler(lambda loop, context: unhandled.append(context))
    try:
        service.spawn(service._manual({"id": "synthetic", "args": ["help"]}))
        await asyncio.wait_for(stopped.wait(), 2)
        assert service.closed and service.process.returncode is not None
        assert not unhandled
        assert service.companion.last_error == "B站整合进程已退出，请检查依赖并重载插件。"
    finally:
        await service.close()
        loop.set_exception_handler(previous)


def test_windows_acl_apply_failure_keeps_populated_directory_private(tmp_path, monkeypatch):
    import os
    import subprocess

    import dswhale.bili as bili

    path = tmp_path / "control.json"
    path.write_text("old token")
    credentials = tmp_path / "credentials.json"
    credentials.write_text("synthetic credentials")
    directory_private = True
    os_proxy = SimpleNamespace(**vars(os))
    os_proxy.name = "nt"
    monkeypatch.setattr(bili, "os", os_proxy)

    def fail_apply(args, **kwargs):
        nonlocal directory_private
        if args[0].lower().endswith("powershell.exe"):
            if "SetAccessControl" in args[-1]:
                raise subprocess.CalledProcessError(1, args)
            return SimpleNamespace(stdout="S-1-5-21-12345", returncode=0)
        if "/reset" in args:
            # Model the real inherited broad ACL restored by icacls /reset.
            directory_private = False
            return SimpleNamespace(stdout="", returncode=0)
        raise subprocess.CalledProcessError(1, args)

    monkeypatch.setattr(subprocess, "run", fail_apply)
    with pytest.raises(OSError, match="Windows"):
        write_control_file(path, {"token": "replacement"})
    assert directory_private
    assert credentials.read_text() == "synthetic credentials"
    assert path.read_text() == "old token"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["control.json", "credentials.json"]


@pytest.mark.skipif(
    __import__("os").name != "nt", reason="native Windows failed-ACL privacy validation"
)
def test_windows_failed_acl_application_preserves_prior_private_dacl(tmp_path, monkeypatch):
    import os
    import subprocess

    path = tmp_path / "control.json"
    write_control_file(path, {"token": "old synthetic token"})
    credentials = tmp_path / "credentials.json"
    credentials.write_text("synthetic credentials")

    def directory_dacl():
        return subprocess.check_output(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-Acl -LiteralPath $env:WHALE_TEST_ACL_FILE).Sddl",
            ],
            env={**os.environ, "WHALE_TEST_ACL_FILE": str(tmp_path)},
            text=True,
            timeout=10,
        ).strip()

    before = directory_dacl()
    original_run = subprocess.run

    def fail_mutation(args, **kwargs):
        if args[0].lower().endswith("powershell.exe") and "SetAccessControl" in args[-1]:
            # Exercise the real owner checks and ACL construction, then fail at
            # application. No permission-reset operation may precede that point.
            args = [
                *args[:-1],
                args[-1].replace(
                    "[System.IO.Directory]::SetAccessControl($path, $acl)",
                    "throw 'Synthetic ACL apply failure'",
                ),
            ]
        elif "/inheritance:r" in args:
            raise subprocess.CalledProcessError(1, args)
        return original_run(args, **kwargs)

    monkeypatch.setattr(subprocess, "run", fail_mutation)
    with pytest.raises(OSError, match="Windows"):
        write_control_file(path, {"token": "replacement synthetic token"})
    assert directory_dacl() == before
    assert json.loads(path.read_text())["token"] == "old synthetic token"
    assert credentials.read_text() == "synthetic credentials"
