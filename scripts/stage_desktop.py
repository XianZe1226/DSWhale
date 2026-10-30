"""Stage the public backend from the Git source inventory, never a directory copy.

Only curated source formats are eligible. A second denylist protects builds from
accidentally tracked credentials, databases, runtime state and dependency caches.
Run with Python 3.12+: python -m scripts.stage_desktop.
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path, PurePosixPath

ROOT_FILES = {
    "pyproject.toml",
    "setup.py",
    "MANIFEST.in",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "SECURITY.md",
    "main.py",
    "metadata.yaml",
    "_conf_schema.json",
    "requirements.txt",
}
SCRIPT_FILES = {"scripts/bootstrap.py", "scripts/launch.py"}
# Exact new resources may be staged before the first development commit.
NEW_RESOURCES = {
    "dswhale/media_assets.json",
    "dswhale/desktop_settings.py",
    "dswhale/media_runtime.py",
}
SOURCE_SUFFIXES = {".py", ".js", ".mjs", ".cjs", ".json", ".html", ".css", ".md", ".txt"}
PRIVATE_PARTS = {
    ".private",
    ".runtime",
    ".git",
    ".venv",
    ".superpowers",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "node_modules",
    "data",
    "user-data",
    "userdata",
    "runtime",
    "secrets",
    "credentials",
    "cache",
    "caches",
    "logs",
    "backups",
    "dist",
    "build",
    "desktop-dist",
    "desktop-resources",
}
PRIVATE_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".pem", ".key", ".log", ".pyc", ".pyo"}


def eligible(name: str) -> bool:
    path = PurePosixPath(name)
    parts = [part.lower() for part in path.parts]
    leaf = parts[-1] if parts else ""
    if any(part in PRIVATE_PARTS or part.startswith(".") for part in parts):
        return False
    if leaf.startswith(("cookie", "credential", "token", "secret", "desktop-auth")):
        return False
    if path.suffix.lower() in PRIVATE_SUFFIXES:
        return False
    return name in ROOT_FILES | SCRIPT_FILES or (
        parts[0] == "dswhale" and (path.suffix.lower() in SOURCE_SUFFIXES or leaf == "license")
    )


def stage_backend(source: Path, destination: Path, *, tracked_files=None) -> dict[str, str]:
    source = Path(source).resolve(strict=True)
    destination = Path(destination).absolute()
    if destination.is_symlink() or any(parent.is_symlink() for parent in destination.parents):
        raise ValueError("Symlink staging destination is not allowed")
    destination = destination.resolve()
    if (
        destination == source
        or destination in source.parents
        or (
            source in destination.parents
            and destination != source / "desktop-resources" / "backend"
        )
    ):
        raise ValueError("Staging must not replace source directories")
    if tracked_files is None:
        result = subprocess.run(
            ["git", "-C", str(source), "ls-files", "-z"],
            check=True,
            capture_output=True,
        )
        tracked_files = set(result.stdout.decode("utf-8").split("\0")) - {""}
    names = set(tracked_files) | {name for name in NEW_RESOURCES if (source / name).is_file()}
    files = []
    for name in sorted(names):
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name:
            raise ValueError("Unsafe path in source inventory")
        if not eligible(name):
            continue
        local = source / name
        if any(parent.is_symlink() for parent in [local, *local.parents] if parent != source):
            raise ValueError(f"Symlink source is not allowed: {name}")
        if not local.is_file():
            raise ValueError(f"Missing source file: {name}")
        files.append((name, local))
    destination.parent.mkdir(parents=True, exist_ok=True)
    manifest = {}
    with tempfile.TemporaryDirectory(prefix=".backend-stage-", dir=destination.parent) as temporary:
        stage = Path(temporary) / "backend"
        stage.mkdir()
        for name, local in files:
            output = stage / name
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(local, output)
            manifest[name] = hashlib.sha256(output.read_bytes()).hexdigest()
        if destination.exists():
            shutil.rmtree(destination)
        stage.rename(destination)
    (destination.parent / "backend-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--destination", type=Path)
    args = parser.parse_args()
    destination = args.destination or args.source / "desktop-resources" / "backend"
    manifest = stage_backend(args.source, destination)
    print(f"Staged {len(manifest)} public backend files in {destination}")


if __name__ == "__main__":
    main()
