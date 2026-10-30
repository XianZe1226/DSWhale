"""Remove build-machine ownership and timestamps from distributable tar files."""

import copy
import gzip
import os
import subprocess
import tarfile
import tempfile
from pathlib import Path


def release_epoch(root: Path) -> int:
    explicit = os.environ.get("SOURCE_DATE_EPOCH")
    if explicit:
        return int(explicit)
    if (Path(root) / ".git").exists():
        try:
            return int(
                subprocess.check_output(
                    ["git", "show", "-s", "--format=%ct", "HEAD"],
                    cwd=root,
                    text=True,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                ).strip()
            )
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    return 946684800


def normalize_tar(archive: Path, *, epoch: int = 946684800) -> None:
    archive = Path(archive)
    handle, name = tempfile.mkstemp(prefix=".normalized-", suffix=".tar.gz", dir=archive.parent)
    os.close(handle)
    temporary = Path(name)
    try:
        with tarfile.open(archive, "r:gz") as source, temporary.open("wb") as raw:
            with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=epoch) as zipped:
                with tarfile.open(fileobj=zipped, mode="w") as output:
                    for member in source:
                        normalized = copy.copy(member)
                        normalized.uid = normalized.gid = 0
                        normalized.uname = normalized.gname = "root"
                        normalized.mtime = epoch
                        normalized.pax_headers = {}
                        data = source.extractfile(member) if member.isfile() else None
                        try:
                            output.addfile(normalized, data)
                        finally:
                            if data:
                                data.close()
            raw.flush()
            os.fsync(raw.fileno())
        temporary.replace(archive)
    finally:
        temporary.unlink(missing_ok=True)
