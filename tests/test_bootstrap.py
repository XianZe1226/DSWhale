import importlib.util
import json
import zipfile
from pathlib import Path

import pytest


def bootstrap():
    spec = importlib.util.spec_from_file_location(
        "dswhale_bootstrap", Path(__file__).parents[1] / "scripts/bootstrap.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_explicit_runtime_is_outside_source_and_legacy_default_stays_local(tmp_path, monkeypatch):
    module = bootstrap()
    assert hasattr(module, "runtime_directory")
    monkeypatch.delenv("DSWHALE_RUNTIME_DIR", raising=False)
    assert module.runtime_directory(tmp_path / "source") == tmp_path / "source/.runtime"
    monkeypatch.setenv("DSWHALE_RUNTIME_DIR", str(tmp_path / "user data/runtime"))
    assert module.runtime_directory(tmp_path / "source") == tmp_path / "user data/runtime"


def test_new_desktop_dashboard_binds_loopback_and_preserves_existing_settings(tmp_path):
    module = bootstrap()
    assert hasattr(module, "configure_desktop_dashboard")
    config = tmp_path / "data/cmd_config.json"
    config.parent.mkdir()
    config.write_text(
        json.dumps(
            {
                "dashboard": {"host": "0.0.0.0", "port": 6185},
                "provider": [{"api_key": "private-fixture"}],
            }
        )
    )
    module.configure_desktop_dashboard(tmp_path)
    data = json.loads(config.read_text())
    assert data["dashboard"]["host"] == "127.0.0.1"
    assert data["dashboard"]["port"] == 6185
    assert data["disable_metrics"] is True
    assert data["provider"] == [{"api_key": "private-fixture"}]


def test_preupgrade_snapshot_works_without_old_python_and_rejects_symlinks(tmp_path):
    module = bootstrap()
    assert hasattr(module, "snapshot_data")
    host = tmp_path / "runtime/astrbot"
    (host / "data").mkdir(parents=True)
    (host / "data/memory.db").write_bytes(b"original data")
    archive = module.snapshot_data(host, host.parent)
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.read("data/memory.db") == b"original data"
        assert json.loads(bundle.read("manifest.json"))["project"] == "DSWhale"
    (host / "data/link").symlink_to(tmp_path)
    with pytest.raises(ValueError, match="符号链接"):
        module.snapshot_data(host, host.parent)


def test_repair_and_repeat_upgrade_keep_data_and_only_write_explicit_runtime(tmp_path, monkeypatch):
    module = bootstrap()
    source = tmp_path / "installed-source"
    (source / "scripts").mkdir(parents=True)
    (source / "pyproject.toml").write_text('[project]\nversion = "0.3.0a1"\n')
    monkeypatch.setattr(module, "__file__", str(source / "scripts/bootstrap.py"))
    runtime = tmp_path / "app-data/runtime"
    host = runtime / "astrbot"
    (host / "data").mkdir(parents=True)
    original = {"dashboard": {"host": "127.0.0.1", "port": 6301}, "provider": [{"id": "keep"}]}
    (host / "data/cmd_config.json").write_text(json.dumps(original))
    (host / "data/memory.db").write_bytes(b"keep")
    monkeypatch.setenv("DSWHALE_RUNTIME_DIR", str(runtime))
    monkeypatch.setenv("DSWHALE_DESKTOP", "1")
    monkeypatch.setenv("DSWHALE_UV", str(tmp_path / "uv"))
    assert hasattr(module, "output")
    commands = []

    def fake_run(args, **kwargs):
        commands.append([str(item) for item in args])
        for item in args:
            if str(item).endswith("[host]"):
                build_source = Path(str(item).removesuffix("[host]"))
                assert build_source.is_relative_to(runtime)
                assert (build_source / "pyproject.toml").is_file()
        if "venv" in args:
            python = runtime / (
                "venv/Scripts/python.exe" if __import__("os").name == "nt" else "venv/bin/python"
            )
            python.parent.mkdir(parents=True, exist_ok=True)
            python.touch()

    monkeypatch.setattr(module, "run", fake_run)

    def fake_output(args, **kwargs):
        if "--version" in args:
            return "Python 3.12.15"
        if "ensure_node" in str(args):
            return str(runtime / "tools/node/bin/node")
        return json.dumps(
            {
                "ffmpeg": str(runtime / "tools/media/ffmpeg"),
                "ffprobe": str(runtime / "tools/media/ffprobe"),
            }
        )

    monkeypatch.setattr(module, "output", fake_output)
    module.main()
    module.main()
    assert json.loads((host / "data/cmd_config.json").read_text()) == original
    assert (host / "data/memory.db").read_bytes() == b"keep"
    assert len(list((runtime / "backups").glob("before-upgrade-*.zip"))) == 2
    assert json.loads((runtime / "desktop-install.json").read_text())["version"] == "0.3.0a1"
    assert not (source / ".runtime").exists()
    assert sum("venv" in command for command in commands) == 1
    assert all("run" not in command or "astrbot.cli" not in command for command in commands)


def test_fresh_init_creates_sdk_config_before_loopback_patch_without_starting_host(
    tmp_path, monkeypatch
):
    module = bootstrap()
    assert hasattr(module, "initialize_host_config")
    host = tmp_path / "fresh-host"
    (host / "data").mkdir(parents=True)
    calls = []

    def sdk_config_only(args, **kwargs):
        calls.append([str(item) for item in args])
        assert "-c" in args
        assert "AstrBotConfig" in args[-1]
        assert kwargs["cwd"] == host
        import hashlib

        password = kwargs["env"]["ASTRBOT_DASHBOARD_INITIAL_PASSWORD"]
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex("01" * 16), 600000
        ).hex()
        # AstrBot CLI init creates directories only. The SDK creates full defaults
        # and its password hash without starting a host or any platform adapter.
        (host / "data/cmd_config.json").write_text(
            json.dumps(
                {
                    "dashboard": {
                        "host": "0.0.0.0",
                        "pbkdf2_password": f"pbkdf2_sha256$600000${'01' * 16}${digest}",
                        "password_change_required": True,
                    },
                    "provider": [],
                }
            )
        )

    monkeypatch.setattr(module, "run", sdk_config_only)
    module.initialize_host_config(host, "private-python", {"ASTRBOT_ROOT": str(host)}, desktop=True)
    config = json.loads((host / "data/cmd_config.json").read_text())
    assert config["dashboard"]["host"] == "127.0.0.1"
    assert config["dashboard"]["pbkdf2_password"].startswith("pbkdf2_sha256$600000$")
    assert config["dashboard"]["password_change_required"] is True
    assert config["provider"] == []
    assert len(calls) == 1


def test_fresh_desktop_credential_matches_sdk_hash_is_private_and_survives_repair(tmp_path, capfd):
    import hashlib
    import hmac
    import os
    import stat
    import sys

    pytest.importorskip("astrbot")
    module = bootstrap()
    host = tmp_path / "runtime/astrbot"
    (host / "data").mkdir(parents=True)
    env = {**os.environ, "ASTRBOT_ROOT": str(host), "PYTHONUTF8": "1"}
    module.initialize_host_config(host, sys.executable, env, desktop=True)
    credential_file = host.parent / "desktop-auth.json"
    assert credential_file.is_file()
    saved = credential_file.read_bytes()
    credential = json.loads(saved)
    config_file = host / "data/cmd_config.json"
    config = json.loads(config_file.read_text(encoding="utf-8-sig"))
    assert set(credential) == {"username", "password"}
    assert credential["username"] == config["dashboard"]["username"]
    password = credential["password"]
    assert len(password) >= 24
    assert any(char.isupper() for char in password)
    assert any(char.islower() for char in password)
    assert any(char.isdigit() for char in password)
    algorithm, iterations, salt, stored = config["dashboard"]["pbkdf2_password"].split("$")
    assert algorithm == "pbkdf2_sha256"
    calculated = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), int(iterations)
    )
    assert hmac.compare_digest(calculated, bytes.fromhex(stored))
    assert config["dashboard"]["password_change_required"] is True
    assert config["dashboard"]["host"] == "127.0.0.1"
    if os.name != "nt":
        assert stat.S_IMODE(credential_file.stat().st_mode) == 0o600
    original_config = config_file.read_bytes()
    module.initialize_host_config(host, "must-not-be-executed", env, desktop=True)
    assert credential_file.read_bytes() == saved
    assert config_file.read_bytes() == original_config
    captured = capfd.readouterr()
    assert password not in captured.out
    assert password not in captured.err


def test_legacy_init_does_not_store_desktop_credentials(tmp_path, monkeypatch):
    module = bootstrap()
    host = tmp_path / "runtime/astrbot"
    (host / "data").mkdir(parents=True)

    def sdk_config_only(args, **kwargs):
        assert "ASTRBOT_DASHBOARD_INITIAL_PASSWORD" not in kwargs["env"]
        (host / "data/cmd_config.json").write_text(json.dumps({"dashboard": {"host": "0.0.0.0"}}))

    monkeypatch.setattr(module, "run", sdk_config_only)
    module.initialize_host_config(host, "fixture-python", {}, desktop=False)
    assert not (host.parent / "desktop-auth.json").exists()


def test_desktop_initial_credential_refuses_symlink_destination(tmp_path, monkeypatch):
    module = bootstrap()
    host = tmp_path / "runtime/astrbot"
    (host / "data").mkdir(parents=True)
    outside = tmp_path / "outside.json"
    outside.write_bytes(b"keep")
    (host.parent / "desktop-auth.json").symlink_to(outside)

    def no_sdk(args, **kwargs):
        pytest.fail("SDK must not run for an unsafe credential destination")

    monkeypatch.setattr(module, "run", no_sdk)
    with pytest.raises(ValueError, match="符号链接"):
        module.initialize_host_config(host, "fixture-python", {}, desktop=True)
    assert outside.read_bytes() == b"keep"


@pytest.mark.parametrize("failure_point", ["before-sdk", "after-sdk"])
def test_interrupted_fresh_desktop_init_recovers_same_durable_password(
    tmp_path, monkeypatch, failure_point
):
    import hashlib
    import hmac
    import os
    import stat
    import sys

    pytest.importorskip("astrbot")
    module = bootstrap()
    host = tmp_path / "runtime/astrbot"
    (host / "data").mkdir(parents=True)
    env = {**os.environ, "ASTRBOT_ROOT": str(host), "PYTHONUTF8": "1"}
    sdk_run, configure = module.run, module.configure_desktop_dashboard
    sdk_calls = []

    def interrupted_sdk(args, **kwargs):
        sdk_calls.append(kwargs["env"]["ASTRBOT_DASHBOARD_INITIAL_PASSWORD"])
        if failure_point == "before-sdk":
            raise RuntimeError("injected before SDK")
        return sdk_run(args, **kwargs)

    def interrupted_configure(path):
        raise RuntimeError("injected after SDK")

    monkeypatch.setattr(module, "run", interrupted_sdk)
    if failure_point == "after-sdk":
        monkeypatch.setattr(module, "configure_desktop_dashboard", interrupted_configure)
    with pytest.raises(RuntimeError, match="injected"):
        module.initialize_host_config(host, sys.executable, env, desktop=True)
    pending_file = host.parent / ".desktop-auth.pending.json"
    assert pending_file.is_file()
    pending = json.loads(pending_file.read_text())
    password = pending["password"]
    assert password == sdk_calls[0]
    if os.name != "nt":
        assert stat.S_IMODE(pending_file.stat().st_mode) == 0o600
    config_file = host / "data/cmd_config.json"
    if failure_point == "after-sdk":
        assert config_file.is_file()
        config = json.loads(config_file.read_text(encoding="utf-8-sig"))
        config["desktopCrashFixture"] = "preserve-user-data"
        config_file.write_text(json.dumps(config))
    else:
        assert not config_file.exists()
    assert not (host.parent / "desktop-auth.json").exists()

    def resumed_sdk(args, **kwargs):
        if failure_point == "after-sdk":
            pytest.fail("Recovery must not rerun SDK initialization against existing config")
        assert kwargs["env"]["ASTRBOT_DASHBOARD_INITIAL_PASSWORD"] == password
        return sdk_run(args, **kwargs)

    monkeypatch.setattr(module, "run", resumed_sdk)
    monkeypatch.setattr(module, "configure_desktop_dashboard", configure)
    module.initialize_host_config(host, sys.executable, env, desktop=True)
    saved = json.loads((host.parent / "desktop-auth.json").read_text())
    assert saved["password"] == password
    config = json.loads(config_file.read_text(encoding="utf-8-sig"))
    if failure_point == "after-sdk":
        assert config["desktopCrashFixture"] == "preserve-user-data"
    _, iterations, salt, digest = config["dashboard"]["pbkdf2_password"].split("$")
    calculated = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), int(iterations)
    )
    assert hmac.compare_digest(calculated, bytes.fromhex(digest))
    assert config["dashboard"]["host"] == "127.0.0.1"
    assert not pending_file.exists()


def test_pending_initialization_never_resets_an_existing_changed_password(tmp_path, monkeypatch):
    module = bootstrap()
    host = tmp_path / "runtime/astrbot"
    (host / "data").mkdir(parents=True)
    config_file = host / "data/cmd_config.json"
    config_file.write_text(
        json.dumps(
            {
                "dashboard": {
                    "host": "0.0.0.0",
                    "username": "astrbot",
                    "pbkdf2_password": "changed-by-user",
                },
                "provider": [{"id": "keep"}],
            }
        )
    )
    original = config_file.read_bytes()
    (host.parent / ".desktop-auth.pending.json").write_text(
        json.dumps(
            {
                "format": 1,
                "purpose": "dswhale-desktop-initial-login",
                "username": "astrbot",
                "password": "SyntheticPendingPassword123",
            }
        )
    )

    def must_not_run(args, **kwargs):
        pytest.fail("Existing config must never rerun the SDK or reset its password")

    monkeypatch.setattr(module, "run", must_not_run)
    with pytest.raises(ValueError, match="登录|密码"):
        module.initialize_host_config(host, "must-not-run", {}, desktop=True)
    assert config_file.read_bytes() == original
    assert not (host.parent / "desktop-auth.json").exists()


def fake_bootstrap_entry(tmp_path, monkeypatch, *, desktop):
    """Exercise the real main/prepare flow while replacing external installers."""
    import os

    module = bootstrap()
    source = tmp_path / "source"
    (source / "scripts").mkdir(parents=True)
    (source / "pyproject.toml").write_text('[project]\nversion = "0.3.0a1"\n')
    monkeypatch.setattr(module, "__file__", str(source / "scripts/bootstrap.py"))
    runtime = tmp_path / "runtime"
    monkeypatch.setenv("DSWHALE_RUNTIME_DIR", str(runtime))
    monkeypatch.setenv("DSWHALE_UV", str(tmp_path / "fixture-uv"))
    if desktop:
        monkeypatch.setenv("DSWHALE_DESKTOP", "1")
    else:
        monkeypatch.delenv("DSWHALE_DESKTOP", raising=False)
    commands = []

    def external_installer(args, **kwargs):
        command = [str(item) for item in args]
        commands.append(command)
        if "venv" in command:
            python = runtime / ("venv/Scripts/python.exe" if os.name == "nt" else "venv/bin/python")
            python.parent.mkdir(parents=True, exist_ok=True)
            python.touch()
        if "astrbot.cli" in command:
            assert "init" in command and "run" not in command
            (runtime / "astrbot/data").mkdir(parents=True, exist_ok=True)
        if "-c" in command and "AstrBotConfig" in command[-1]:
            pytest.fail("This entry scenario must never initialize SDK config")

    def tool_output(args, **kwargs):
        if "--version" in args:
            return "Python 3.12.15"
        if "ensure_node" in str(args):
            return str(runtime / "tools/node/bin/node")
        return json.dumps(
            {
                "ffmpeg": str(runtime / "tools/media/ffmpeg"),
                "ffprobe": str(runtime / "tools/media/ffprobe"),
            }
        )

    monkeypatch.setattr(module, "run", external_installer)
    monkeypatch.setattr(module, "output", tool_output)
    return module, runtime, commands


def test_main_retry_recovers_pending_login_after_sdk_already_created_config(tmp_path, monkeypatch):
    import hashlib

    module, runtime, commands = fake_bootstrap_entry(tmp_path, monkeypatch, desktop=True)
    host = runtime / "astrbot"
    (host / "data").mkdir(parents=True)
    password = "SyntheticDurablePendingPassword123"
    salt = "01" * 16
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 600000).hex()
    config = {
        "dashboard": {
            "username": "astrbot",
            "host": "0.0.0.0",
            "pbkdf2_password": f"pbkdf2_sha256$600000${salt}${digest}",
        },
        "provider": [{"id": "preserve"}],
    }
    config_file = host / "data/cmd_config.json"
    config_file.write_text(json.dumps(config))
    pending_file = runtime / ".desktop-auth.pending.json"
    pending_file.write_text(
        json.dumps(
            {
                "format": 1,
                "purpose": "dswhale-desktop-initial-login",
                "username": "astrbot",
                "password": password,
            }
        )
    )
    pending_file.chmod(0o600)
    module.main()
    assert (runtime / "desktop-auth.json").is_file()
    assert json.loads((runtime / "desktop-auth.json").read_text()) == {
        "username": "astrbot",
        "password": password,
    }
    assert not pending_file.exists()
    final_config = json.loads(config_file.read_text())
    assert final_config["dashboard"]["host"] == "127.0.0.1"
    assert final_config["dashboard"]["pbkdf2_password"] == config["dashboard"]["pbkdf2_password"]
    assert final_config["provider"] == [{"id": "preserve"}]
    assert not any("astrbot.cli" in command for command in commands)


def test_legacy_main_leaves_sdk_password_creation_to_start(tmp_path, monkeypatch):
    module, runtime, commands = fake_bootstrap_entry(tmp_path, monkeypatch, desktop=False)
    module.main()
    assert any("astrbot.cli" in command and "init" in command for command in commands)
    assert not (runtime / "astrbot/data/cmd_config.json").exists()
    assert not (runtime / "desktop-auth.json").exists()
    assert not (runtime / ".desktop-auth.pending.json").exists()
