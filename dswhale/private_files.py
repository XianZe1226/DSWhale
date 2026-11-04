"""Owner-only file writes for private local settings, archives and receipts.

POSIX mode bits are set before content is written. Windows mode bits do not
express per-user privacy, so the same protected-DACL policy already used for the
Bilibili control file is applied to the staging file before content is written;
the final replace keeps that DACL. A failed ACL step leaves the original file
untouched and never writes private content to the staging path.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
from pathlib import Path


class PrivateFileError(OSError):
    """A private write could not establish the required owner-only access."""


def _windows_acl_script():
    return (
        '$ErrorActionPreference = "Stop"; '
        "$path = $env:DSWHALE_PRIVATE_PATH; "
        "$target = Get-Item -LiteralPath $path -Force; "
        "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent(); "
        "$sid = $identity.User; "
        "$owner = (Get-Acl -LiteralPath $path).GetOwner("
        "[System.Security.Principal.SecurityIdentifier]); "
        "if ($owner.Value -ne $sid.Value -and $owner.Value -ne $identity.Owner.Value) "
        "{ throw 'Unexpected owner' }; "
        "if ($target.PSIsContainer) { "
        "$acl = New-Object System.Security.AccessControl.DirectorySecurity; "
        "$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' "
        "} else { "
        "$acl = New-Object System.Security.AccessControl.FileSecurity; "
        "$inherit = [System.Security.AccessControl.InheritanceFlags]::None }; "
        "$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); "
        "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new("
        "$sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, "
        "[System.Security.AccessControl.PropagationFlags]::None, "
        "[System.Security.AccessControl.AccessControlType]::Allow); "
        "$acl.AddAccessRule($rule); "
        "if ($target.PSIsContainer) { "
        "[System.IO.Directory]::SetAccessControl($path, $acl) "
        "} else { [System.IO.File]::SetAccessControl($path, $acl) }"
    )


def protect_windows_private(path):
    """Apply an owner-only protected DACL to one existing file or directory."""
    if os.name != "nt":
        return
    system = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
    try:
        subprocess.run(
            [
                str(system / "WindowsPowerShell/v1.0/powershell.exe"),
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                _windows_acl_script(),
            ],
            env={
                **{
                    key: value for key, value in os.environ.items() if key.upper() != "PSMODULEPATH"
                },
                "DSWHALE_PRIVATE_PATH": str(path),
            },
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=True,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise PrivateFileError("无法为 Windows 私密文件设置仅当前用户权限") from error


def ensure_private_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        protect_windows_private(path)
        return path
    try:
        os.chmod(path, 0o700)
        current = path.stat()
    except OSError as error:
        raise PrivateFileError("无法建立本机私密目录") from error
    if current.st_uid != os.getuid() or stat.S_IMODE(current.st_mode) & 0o077:
        raise PrivateFileError("本机私密目录必须仅由当前用户访问")
    return path


def _write_atomic(path, value, *, mode=None, private_directory=False):
    path = Path(path)
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    if private_directory:
        ensure_private_directory(parent)
    descriptor, name = tempfile.mkstemp(prefix=".dswhale-private-", dir=parent)
    temporary = Path(name)
    stream = None
    try:
        if os.name == "nt":
            # DACL first: private content must never exist before protection.
            protect_windows_private(temporary)
        elif mode is not None:
            os.chmod(temporary, mode)
        stream = os.fdopen(descriptor, "w", encoding="utf-8")
        descriptor = None  # ownership transferred to the stream
        with stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        stream = None
        os.replace(temporary, path)
        if os.name != "nt" and mode is not None:
            os.chmod(path, mode)
    except BaseException:
        # Deterministic close responsibility before cleanup: an open descriptor
        # would leak on POSIX and block deletion on Windows.
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if stream is not None:
            try:
                stream.close()
            except OSError:
                pass
        temporary.unlink(missing_ok=True)
        raise
    return path


def write_private_json(path, value, *, private_directory=False):
    """Atomically write JSON readable only by the current user."""
    return _write_atomic(path, value, mode=0o600, private_directory=private_directory)


def write_json_preserving_mode(path, value):
    """Atomically replace JSON while keeping the existing file mode."""
    path = Path(path)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    return _write_atomic(path, value, mode=mode)
