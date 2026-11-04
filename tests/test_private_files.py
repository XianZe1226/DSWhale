"""Owner-only private writes: POSIX modes, simulated Windows failure paths and
native Windows DACL verification."""

import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from dswhale import private_files


def test_posix_private_file_and_directory_modes(tmp_path):
    if os.name == "nt":
        pytest.skip("POSIX mode test; native Windows DACL test covers Windows")
    directory = tmp_path / "archives"
    target = directory / "receipt.json"
    private_files.write_private_json(target, {"ok": True}, private_directory=True)
    assert target.read_text(encoding="utf-8")
    assert directory.stat().st_mode & 0o777 == 0o700
    assert target.stat().st_mode & 0o777 == 0o600


def test_simulated_windows_acl_is_applied_before_private_content(tmp_path, monkeypatch):
    calls = []
    directory = tmp_path / "archive"
    target = directory / "receipt.json"
    os_proxy = SimpleNamespace(**vars(os))
    os_proxy.name = "nt"
    monkeypatch.setattr(private_files, "os", os_proxy)

    def run(args, **kwargs):
        assert kwargs["check"] is True
        assert kwargs["timeout"] <= 10
        candidate = Path(kwargs["env"]["DSWHALE_PRIVATE_PATH"])
        assert candidate.is_file() or candidate.is_dir()
        if candidate.is_file():
            assert candidate.read_bytes() == b""
        calls.append((candidate.is_dir(), candidate.is_file()))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(private_files.subprocess, "run", run)
    private_files.write_private_json(target, {"secret": "synthetic"}, private_directory=True)
    assert json.loads(target.read_text(encoding="utf-8"))["secret"] == "synthetic"
    assert calls == [(True, False), (False, True)]


def test_simulated_windows_acl_failure_keeps_original_and_no_content(tmp_path, monkeypatch):
    target = tmp_path / "receipt.json"
    target.write_text("original", encoding="utf-8")
    os_proxy = SimpleNamespace(**vars(os))
    os_proxy.name = "nt"
    monkeypatch.setattr(private_files, "os", os_proxy)

    def run(args, **kwargs):
        candidate = Path(kwargs["env"]["DSWHALE_PRIVATE_PATH"])
        if candidate.is_file():
            assert candidate.read_bytes() == b""
            raise subprocess.CalledProcessError(1, args, stderr=b"private diagnostic")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(private_files.subprocess, "run", run)
    with pytest.raises(private_files.PrivateFileError) as error:
        private_files.write_private_json(target, {"secret": "synthetic"})
    assert "private diagnostic" not in str(error.value)
    assert target.read_text(encoding="utf-8") == "original"
    assert not list(tmp_path.glob(".dswhale-private-*"))


@pytest.mark.skipif(os.name != "nt", reason="native Windows DACL validation")
def test_native_windows_private_dacl_is_owner_only(tmp_path):
    target = tmp_path / "archive/receipt.json"
    private_files.write_private_json(target, {"secret": "synthetic"}, private_directory=True)
    script = (
        '$ErrorActionPreference = "Stop"; '
        "$path = $env:PRIVATE_ACL_FILE; "
        "$acl = [System.IO.File]::GetAccessControl($path); "
        "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "
        "$rules = @($acl.GetAccessRules($true, $true, "
        "[System.Security.Principal.SecurityIdentifier])); "
        "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; "
        "currentUserOnly = @($rules | Where-Object { $_.IdentityReference.Value -ne $current }).Count -eq 0; "
        "ownerIsCurrent = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $current } "
        "| ConvertTo-Json -Compress"
    )
    completed = subprocess.run(
        [
            str(
                Path(os.environ.get("SystemRoot", r"C:\Windows"))
                / "System32/WindowsPowerShell/v1.0/powershell.exe"
            ),
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ],
        env={**os.environ, "PRIVATE_ACL_FILE": str(target)},
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    acl = json.loads(completed.stdout)
    assert acl["protected"] is True
    assert acl["currentUserOnly"] is True
    assert acl["ownerIsCurrent"] is True


def test_windows_acl_failure_closes_descriptor_and_leaves_no_staging(tmp_path, monkeypatch):
    target = tmp_path / "receipt.json"
    target.write_text("original", encoding="utf-8")
    closed = []
    real_close = os.close
    os_proxy = SimpleNamespace(**vars(os))
    os_proxy.name = "nt"
    os_proxy.close = lambda fd: (closed.append(fd), real_close(fd))[1]
    monkeypatch.setattr(private_files, "os", os_proxy)

    def run(args, **kwargs):
        candidate = Path(kwargs["env"]["DSWHALE_PRIVATE_PATH"])
        if candidate.is_file():
            raise subprocess.CalledProcessError(1, args)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(private_files.subprocess, "run", run)
    with pytest.raises(private_files.PrivateFileError):
        private_files.write_private_json(target, {"secret": "synthetic"})
    assert closed, "the mkstemp descriptor must be closed before cleanup"
    assert target.read_text(encoding="utf-8") == "original"
    assert not list(tmp_path.glob(".dswhale-private-*"))


def test_posix_chmod_failure_closes_descriptor_and_keeps_original(tmp_path, monkeypatch):
    if os.name == "nt":
        pytest.skip("POSIX chmod failure path")
    target = tmp_path / "receipt.json"
    target.write_text("original", encoding="utf-8")
    closed = []
    real_close = os.close
    os_proxy = SimpleNamespace(**vars(os))
    os_proxy.name = "posix"
    os_proxy.close = lambda fd: (closed.append(fd), real_close(fd))[1]

    def chmod(*args, **kwargs):
        raise OSError("synthetic chmod failure")

    os_proxy.chmod = chmod
    monkeypatch.setattr(private_files, "os", os_proxy)
    with pytest.raises(OSError, match="synthetic chmod failure"):
        private_files.write_private_json(target, {"secret": "synthetic"})
    assert closed
    assert target.read_text(encoding="utf-8") == "original"
    assert not list(tmp_path.glob(".dswhale-private-*"))
