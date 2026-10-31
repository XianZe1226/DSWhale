"""Independent updates use synthetic hosts; no account or personal data is loaded."""

import base64
import importlib
import io
import json
import os
import signal
import stat
import subprocess
import sys
import time
import zipfile

import httpx
import pytest
from filelock import FileLock


@pytest.fixture
def ext():
    assert importlib.util.find_spec("dswhale.extensions"), "independent updater is missing"
    return importlib.import_module("dswhale.extensions")


def package(version="2.8.2", *, extra=None):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        base = "astrbot_plugin_livingmemory-" + "a" * 40
        for name, data in {
            "main.py": "NEW_CODE = True\n",
            "metadata.yaml": f"name: astrbot_plugin_livingmemory\nversion: {version}\nrepo: https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory\n",
            "requirements.txt": "",
            **(extra or {}),
        }.items():
            archive.writestr(f"{base}/{name}", data)
    return buffer.getvalue()


@pytest.fixture
def upstream(ext, monkeypatch):
    requests = []
    archive = package()

    def handler(request):
        requests.append(str(request.url))
        path = request.url.path
        if path.endswith("/releases/latest"):
            return httpx.Response(
                200, json={"tag_name": "v2.8.2", "draft": False, "prerelease": False}
            )
        if "/commits/" in path:
            return httpx.Response(200, json={"sha": "a" * 40})
        if request.url.host == "codeload.github.com":
            return httpx.Response(200, content=archive)
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    real_client = httpx.Client
    monkeypatch.setattr(ext, "_client", lambda: real_client(transport=transport))
    return requests


@pytest.fixture
def host(tmp_path):
    code = tmp_path / "data/plugins/astrbot_plugin_livingmemory"
    code.mkdir(parents=True)
    (code / "main.py").write_text("OLD_CODE = True\n")
    (code / "metadata.yaml").write_text("name: astrbot_plugin_livingmemory\nversion: 2.7.1\n")
    for name, value in {
        "data/plugin_data/astrbot_plugin_livingmemory/memory.db": b"synthetic memory",
        "data/config/astrbot_plugin_livingmemory_config.json": b'{"embedding":"local-provider"}',
        "data/config/host.json": b'{"persona":"synthetic persona","key":"synthetic-secret"}',
        "data/personas/default.json": b"synthetic persona",
        "data/plugins/astrbot_plugin_livingmemory/local-data/notes.db": b"local memory",
    }.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)
    return tmp_path


def test_status_is_offline_and_never_exposes_configuration(ext, host, monkeypatch):
    monkeypatch.setattr(ext, "_client", lambda: pytest.fail("status contacted network"))
    result = ext.status(host)
    assert result["memory"]["version"] == "2.7.1"
    assert result["memory"]["installed"]
    assert not result["memes"]["installed"]
    assert not result["memory"]["canUpdate"]
    assert "synthetic" not in json.dumps(result)


def test_check_resolves_stable_tag_to_immutable_canonical_commit(ext, host, upstream):
    result = ext.check(host, "memory")
    assert result["memory"]["latest"] == "2.8.2"
    assert result["memory"]["canUpdate"]
    assert any("/commits/v2.8.2" in url for url in upstream)
    assert all(
        url.startswith(
            "https://api.github.com/repos/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/"
        )
        for url in upstream
    )


@pytest.mark.parametrize(
    "release",
    [
        {"tag_name": "v2.9.0rc1", "draft": False, "prerelease": False},
        {"tag_name": "v2.9.0", "draft": True, "prerelease": False},
        {"tag_name": "v2.9.0", "draft": False, "prerelease": True},
        {"tag_name": "../../evil", "draft": False, "prerelease": False},
    ],
)
def test_check_rejects_unstable_and_untrusted_tags(ext, host, monkeypatch, release):
    monkeypatch.setattr(ext, "_request_json", lambda url: release)
    with pytest.raises(ext.ExtensionError):
        ext.check(host, "memory")
    assert not ext.status(host)["memory"]["canUpdate"]


def test_update_requires_prior_check_and_fixed_id(ext, host):
    with pytest.raises(ext.ExtensionError):
        ext.update(host, "memory")
    with pytest.raises(ext.ExtensionError):
        ext.check(host, "https://evil.invalid/plugin")


def test_update_preserves_memory_persona_embedding_and_private_snapshot(ext, host, upstream):
    preserved = {
        p.relative_to(host): p.read_bytes()
        for p in (host / "data").rglob("*")
        if p.is_file() and p.name not in {"main.py", "metadata.yaml"}
    }
    ext.check(host, "memory")
    result = ext.update(host, "memory")
    assert result["memory"]["version"] == "2.8.2"
    assert result["memory"]["canRollback"]
    assert "NEW_CODE" in (host / "data/plugins/astrbot_plugin_livingmemory/main.py").read_text()
    for relative, content in preserved.items():
        assert (host / relative).read_bytes() == content
    snapshots = list((host / ".dswhale-extensions").rglob("*.zip"))
    assert len(snapshots) == 1
    with zipfile.ZipFile(snapshots[0]) as z:
        assert z.read("data/personas/default.json") == b"synthetic persona"
    # Windows chmod only toggles read-only; access follows the host directory ACL.
    if os.name != "nt":
        assert stat.S_IMODE(snapshots[0].stat().st_mode) & 0o077 == 0
    assert "synthetic" not in json.dumps(result)
    assert any(
        "https://codeload.github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/zip/"
        + "a" * 40
        == url
        for url in upstream
    )


def test_rollback_restores_code_without_overwriting_data(ext, host, upstream):
    ext.check(host, "memory")
    ext.update(host, "memory")
    result = ext.rollback(host, "memory")
    assert result["memory"]["version"] == "2.7.1"
    assert not result["memory"]["canRollback"]
    assert (
        host / "data/plugins/astrbot_plugin_livingmemory/main.py"
    ).read_text() == "OLD_CODE = True\n"
    assert (
        host / "data/plugin_data/astrbot_plugin_livingmemory/memory.db"
    ).read_bytes() == b"synthetic memory"


def test_rollback_refuses_when_new_memories_or_settings_exist(ext, host, upstream):
    ext.check(host, "memory")
    ext.update(host, "memory")
    path = host / "data/plugin_data/astrbot_plugin_livingmemory/memory.db"
    path.write_bytes(b"newer memory")
    assert not ext.status(host)["memory"]["canRollback"]
    with pytest.raises(ext.ExtensionError, match="变化|更改"):
        ext.rollback(host, "memory")
    assert path.read_bytes() == b"newer memory"
    assert "NEW_CODE" in (host / "data/plugins/astrbot_plugin_livingmemory/main.py").read_text()


@pytest.mark.parametrize("action", ["update", "rollback"])
def test_actions_refuse_running_host(ext, host, action):
    with FileLock(host / "astrbot.lock"):
        with pytest.raises(ext.ExtensionError, match="停止"):
            getattr(ext, action)(host, "memory")


def test_manual_check_can_run_while_host_is_running_without_modifying_data(ext, host, upstream):
    before = {
        p.relative_to(host): p.read_bytes() for p in (host / "data").rglob("*") if p.is_file()
    }
    with FileLock(host / "astrbot.lock"):
        cards = ext.check(host, "memory")
    assert cards["memory"]["latest"] == "2.8.2"
    assert {
        p.relative_to(host): p.read_bytes() for p in (host / "data").rglob("*") if p.is_file()
    } == before


def test_manual_check_serializes_with_other_extension_operations(ext, host, upstream):
    state = host / ".dswhale-extensions"
    state.mkdir()
    with FileLock(state / "updater.lock"):
        with pytest.raises(ext.ExtensionError):
            ext.check(host, "memory")
    assert upstream == []


def test_download_failure_retains_old_plugin(ext, host, upstream, monkeypatch):
    ext.check(host, "memory")
    monkeypatch.setattr(
        ext, "_download", lambda *a: (_ for _ in ()).throw(OSError("synthetic-secret"))
    )
    with pytest.raises(ext.ExtensionError):
        ext.update(host, "memory")
    assert "OLD_CODE" in (host / "data/plugins/astrbot_plugin_livingmemory/main.py").read_text()


def test_no_downgrade_even_if_candidate_saved_before_local_update(ext, host, upstream):
    ext.check(host, "memory")
    (host / "data/plugins/astrbot_plugin_livingmemory/metadata.yaml").write_text("version: 9.0.0\n")
    assert not ext.status(host)["memory"]["canUpdate"]
    with pytest.raises(ext.ExtensionError):
        ext.update(host, "memory")


@pytest.mark.parametrize("entry", ["../outside", "/absolute", "folder/link", "folder/C:bad"])
def test_archive_validation_rejects_paths_and_symlink(ext, tmp_path, entry):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as z:
        info = zipfile.ZipInfo(entry)
        if entry.endswith("link"):
            info.external_attr = 0o120777 << 16
        z.writestr(info, "bad")
    with pytest.raises(ext.ExtensionError):
        ext._extract(archive, tmp_path / "out")
    assert not (tmp_path / "outside").exists()


def test_archive_bomb_is_rejected_before_extraction(ext, tmp_path, monkeypatch):
    archive = tmp_path / "bomb.zip"
    archive.write_bytes(package(extra={"huge.txt": "x" * 5000}))
    monkeypatch.setattr(ext, "EXTRACT_LIMIT", 1024)
    with pytest.raises(ext.ExtensionError):
        ext._extract(archive, tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_candidate_tampering_cannot_choose_remote_source(ext, host, upstream):
    ext.check(host, "memory")
    candidate = host / ".dswhale-extensions/memory-candidate.json"
    data = json.loads(candidate.read_text())
    data["repo"] = "attacker/arbitrary"
    candidate.write_text(json.dumps(data))
    with pytest.raises(ext.ExtensionError):
        ext.update(host, "memory")
    assert not any("attacker" in url for url in upstream)


def test_dependency_conflict_refuses_before_code_replacement(ext, host, upstream, monkeypatch):
    ext.check(host, "memory")
    monkeypatch.setattr(
        ext,
        "_ensure_dependencies",
        lambda *a: (_ for _ in ()).throw(ext.ExtensionError("依赖不兼容")),
    )
    with pytest.raises(ext.ExtensionError, match="不兼容"):
        ext.update(host, "memory")
    assert "OLD_CODE" in (host / "data/plugins/astrbot_plugin_livingmemory/main.py").read_text()


def test_dependency_installer_pins_existing_packages_and_does_not_reinstall_satisfied(
    ext, tmp_path, monkeypatch
):
    class Dist:
        metadata = {"Name": "example"}
        version = "1.2.3"

    monkeypatch.setattr(ext.importlib.metadata, "distributions", lambda: [Dist()])
    req = tmp_path / "requirements.txt"
    req.write_text("example>=1\n")
    monkeypatch.setattr(
        ext,
        "_run_dependency_command",
        lambda *a, **kw: pytest.fail("satisfied dependency reinstalled"),
    )
    ext._ensure_dependencies(req, tmp_path)
    req.write_text("example>=2\n")
    with pytest.raises(ext.ExtensionError, match="依赖"):
        ext._ensure_dependencies(req, tmp_path)


def test_cli_json_errors_do_not_include_paths_or_exception_details(ext, tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "dswhale.extensions",
            "--host",
            str(tmp_path / "synthetic-secret"),
            "update",
            "--id",
            "memory",
        ],
        capture_output=True,
    )
    assert result.returncode == 1
    data = json.loads(result.stdout)
    assert data["ok"] is False
    assert "error" in data
    assert b"synthetic-secret" not in result.stdout + result.stderr
    assert result.stderr == b""


def test_https_and_origin_validation_rejects_redirects(ext, monkeypatch):
    transport = httpx.MockTransport(
        lambda request: httpx.Response(302, headers={"location": "https://evil.invalid/private"})
    )
    real_client = httpx.Client
    monkeypatch.setattr(ext, "_client", lambda: real_client(transport=transport))
    with pytest.raises(ext.ExtensionError):
        ext._request_json(
            "https://api.github.com/repos/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/releases/latest"
        )
    with pytest.raises(ext.ExtensionError):
        ext._request_json("http://api.github.com/unsafe")


def test_fresh_install_and_rollback_never_touches_other_extensions(ext, host, upstream):
    import shutil

    shutil.rmtree(host / "data/plugins/astrbot_plugin_livingmemory")
    other = host / "data/plugins/other/main.py"
    other.parent.mkdir()
    other.write_text("OTHER = True\n")
    ext.check(host, "memory")
    assert ext.update(host, "memory")["memory"]["installed"]
    result = ext.rollback(host, "memory")
    assert not result["memory"]["installed"]
    assert other.read_text() == "OTHER = True\n"
    assert (host / "data/personas/default.json").read_bytes() == b"synthetic persona"


def test_corrupted_backup_is_never_used_for_rollback(ext, host, upstream):
    ext.check(host, "memory")
    ext.update(host, "memory")
    snapshot = next((host / ".dswhale-extensions/backups").glob("*.zip"))
    with zipfile.ZipFile(snapshot, "a") as archive:
        archive.writestr("data/plugins/astrbot_plugin_livingmemory/tampered.py", "bad")
    assert not ext.status(host)["memory"]["canRollback"]
    with pytest.raises(ext.ExtensionError):
        ext.rollback(host, "memory")
    assert "NEW_CODE" in (host / "data/plugins/astrbot_plugin_livingmemory/main.py").read_text()


def test_failed_atomic_replace_restores_old_code(ext, host, upstream, monkeypatch):
    from pathlib import Path

    ext.check(host, "memory")
    original = Path.rename

    def rename(path, destination):
        if path.name == "replacement":
            raise OSError("synthetic-secret")
        return original(path, destination)

    monkeypatch.setattr(Path, "rename", rename)
    with pytest.raises(ext.ExtensionError):
        ext.update(host, "memory")
    assert "OLD_CODE" in (host / "data/plugins/astrbot_plugin_livingmemory/main.py").read_text()
    assert not ext.status(host)["memory"]["canRollback"]


def test_dependency_plan_uses_constraints_and_only_adds_missing_wheels(ext, tmp_path, monkeypatch):
    class Dist:
        metadata = {"Name": "existing"}
        version = "1.2.3"

    monkeypatch.setattr(ext.importlib.metadata, "distributions", lambda: [Dist()])
    req = tmp_path / "requirements.txt"
    req.write_text("existing>=1\nnew-package>=2\n")
    steps = []

    def run(arguments, *, cwd):
        steps.append(arguments)
        if "--report" in arguments:
            from pathlib import Path

            constraints = Path(arguments[arguments.index("--constraint") + 1])
            assert constraints.read_text() == "existing==1.2.3\n"
            Path(arguments[arguments.index("--report") + 1]).write_text(
                json.dumps({"install": [{"metadata": {"name": "new-package", "version": "2.0.0"}}]})
            )

    monkeypatch.setattr(ext, "_run_dependency_command", run)
    ext._ensure_dependencies(req, tmp_path)
    assert steps[0][:2] == ["install", "--dry-run"]
    assert "--only-binary=:all:" in steps[1]
    assert steps[2][:3] == ["install", "--no-index", "--no-deps"]
    assert steps[1][-1] == steps[2][-1] == "new-package==2.0.0"
    assert not any("existing==" in arg for command in steps for arg in command)


def test_all_dependency_conflicts_are_detected_before_install(ext, tmp_path, monkeypatch):
    class Dist:
        metadata = {"Name": "existing"}
        version = "1.2.3"

    monkeypatch.setattr(ext.importlib.metadata, "distributions", lambda: [Dist()])
    req = tmp_path / "requirements.txt"
    req.write_text("new-package>=2\nexisting>=9\n")
    monkeypatch.setattr(
        ext, "_run_dependency_command", lambda *a, **kw: pytest.fail("conflict changed environment")
    )
    with pytest.raises(ext.ExtensionError, match="依赖"):
        ext._ensure_dependencies(req, tmp_path)


def test_dependency_process_failure_cannot_expose_stderr(ext, tmp_path, monkeypatch):
    def fail(*args, **kwargs):
        raise subprocess.CalledProcessError(1, "pip", stderr=b"synthetic-secret")

    monkeypatch.setattr(ext.subprocess, "Popen", fail)
    with pytest.raises(ext.ExtensionError) as error:
        ext._run_dependency_command(["install", "example"], cwd=tmp_path)
    assert "synthetic-secret" not in str(error.value)


def test_source_version_mismatch_keeps_old_code(ext, host, upstream, monkeypatch):
    ext.check(host, "memory")
    monkeypatch.setattr(
        ext, "_download", lambda url, destination: destination.write_bytes(package(version="2.8.1"))
    )
    with pytest.raises(ext.ExtensionError):
        ext.update(host, "memory")
    assert "OLD_CODE" in (host / "data/plugins/astrbot_plugin_livingmemory/main.py").read_text()


def test_local_in_plugin_cloud_credentials_are_preserved(ext, host, upstream, monkeypatch):
    path = host / "data/plugins/astrbot_plugin_livingmemory/image_host/config.json"
    path.parent.mkdir()
    path.write_text('{"credential":"synthetic-secret"}')
    ext.check(host, "memory")
    monkeypatch.setattr(
        ext,
        "_download",
        lambda url, destination: destination.write_bytes(
            package(extra={"image_host/config.json": "{}"})
        ),
    )
    ext.update(host, "memory")
    assert path.read_text() == '{"credential":"synthetic-secret"}'


def test_symlinked_data_never_enters_staging_or_backup(ext, host, upstream, tmp_path):
    outside = tmp_path / "outside"
    outside.write_text("synthetic-secret")
    (host / "data/leak").symlink_to(outside)
    ext.check(host, "memory")
    with pytest.raises(ext.ExtensionError):
        ext.update(host, "memory")
    assert not list((host / ".dswhale-extensions").rglob("*.zip"))
    assert outside.read_text() == "synthetic-secret"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX termination contract")
def test_cancelled_dependency_worker_does_not_outlive_updater(ext, tmp_path):
    worker = tmp_path / "fake-python"
    pidfile = tmp_path / "worker.pid"
    worker.write_text(
        f"#!{sys.executable}\nimport os,time\nfrom pathlib import Path\nPath({str(pidfile)!r}).write_text(str(os.getpid()))\ntime.sleep(60)\n"
    )
    worker.chmod(0o700)
    script = (
        "from pathlib import Path; from dswhale import extensions as e; "
        f"e.sys.executable={str(worker)!r}; "
        f"e._run_dependency_command(['install','fixture'],cwd=Path({str(tmp_path)!r}))"
    )
    updater = subprocess.Popen(
        [sys.executable, "-c", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    worker_pid = None
    try:
        deadline = time.monotonic() + 5
        while not pidfile.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert pidfile.exists(), "synthetic dependency worker did not start"
        worker_pid = int(pidfile.read_text())
        updater.terminate()
        updater.wait(timeout=5)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                os.kill(worker_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.02)
        else:
            pytest.fail("dependency worker survived updater cancellation")
    finally:
        if updater.poll() is None:
            updater.kill()
            updater.wait()
        if worker_pid:
            try:
                os.kill(worker_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.parametrize("phase", ["old-moved", "new-moved"])
def test_status_recovers_code_after_abrupt_process_exit(ext, host, upstream, phase):
    ext.check(host, "memory")
    script = f"""
import base64, os
from pathlib import Path
from dswhale import extensions as e
e._download = lambda url, destination: destination.write_bytes(base64.b64decode({base64.b64encode(package()).decode()!r}))
e._ensure_dependencies = lambda *a: None
original_rename = Path.rename
original_write = e._write_json
def rename(path, destination):
    if {phase!r} == 'old-moved' and path.name == 'replacement':
        os._exit(97)
    return original_rename(path, destination)
def write(path, value):
    if {phase!r} == 'new-moved' and path.name == 'memory-receipt.json':
        os._exit(97)
    return original_write(path, value)
Path.rename = rename
e._write_json = write
e.update(Path({str(host)!r}), 'memory')
"""
    result = subprocess.run([sys.executable, "-c", script], capture_output=True)
    assert result.returncode == 97
    cards = ext.status(host)
    assert cards["memory"]["version"] == "2.7.1"
    assert "OLD_CODE" in (host / "data/plugins/astrbot_plugin_livingmemory/main.py").read_text()
    assert (host / "data/personas/default.json").read_bytes() == b"synthetic persona"
    assert not cards["memory"]["canRollback"]


def test_invalid_python_upstream_cannot_replace_working_plugin(ext, host, upstream, monkeypatch):
    ext.check(host, "memory")
    monkeypatch.setattr(
        ext,
        "_download",
        lambda url, destination: destination.write_bytes(
            package(extra={"main.py": "def broken(:\n"})
        ),
    )
    with pytest.raises(ext.ExtensionError):
        ext.update(host, "memory")
    assert "OLD_CODE" in (host / "data/plugins/astrbot_plugin_livingmemory/main.py").read_text()


def test_archive_original_member_name_cannot_hide_null_suffix(ext, tmp_path):
    archive = tmp_path / "nul.zip"
    # Replace a same-length byte in both local and central headers. ZipInfo.filename
    # truncates NUL whereas orig_filename retains it, including on Windows.
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("safeXevil", "bad")
    archive.write_bytes(archive.read_bytes().replace(b"safeXevil", b"safe\x00evil"))
    with pytest.raises(ext.ExtensionError):
        ext._extract(archive, tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_incompatible_host_requirement_cannot_replace_plugin(ext, host, upstream, monkeypatch):
    ext.check(host, "memory")
    metadata = 'name: astrbot_plugin_livingmemory\nversion: 2.8.2\nastrbot_version: ">=99.0.0"\n'
    monkeypatch.setattr(
        ext,
        "_download",
        lambda url, destination: destination.write_bytes(
            package(extra={"metadata.yaml": metadata})
        ),
    )
    with pytest.raises(ext.ExtensionError, match="AstrBot"):
        ext.update(host, "memory")
    assert "OLD_CODE" in (host / "data/plugins/astrbot_plugin_livingmemory/main.py").read_text()
