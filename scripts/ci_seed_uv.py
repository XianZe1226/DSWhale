#!/usr/bin/env python3
"""Download the pinned uv binary through the GitHub API for CI smoke tests.

GitHub's release-download hostname can return 504 from hosted runners while the
API and asset API remain available. The normal installer must keep using the
public release URL; this helper only seeds the CI-only seam in install-smoke.cjs
so package build and install coverage can continue during that outage. The
downloaded archive is still verified against desktop/lib/tool-assets.json.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import stat
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL_ASSETS = json.loads((ROOT / "desktop/lib/tool-assets.json").read_text())
RELEASE_API = "https://api.github.com/repos/astral-sh/uv/releases/tags/0.13.5"
TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")


def api_headers(accept: str) -> dict[str, str]:
    headers = {"Accept": accept, "User-Agent": "DSWhale-CI-Seed"}
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    return headers


def target_key() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "darwin":
        return "darwin-arm64" if machine in {"arm64", "aarch64"} else "darwin-x64"
    if system == "windows":
        return "win32-x64"
    if system == "linux":
        return "linux-x64"
    raise SystemExit(f"unsupported CI platform: {system}/{machine}")


def main() -> int:
    key = target_key()
    asset = TOOL_ASSETS["uv"][key]
    name = asset["url"].rsplit("/", 1)[-1]
    destination = (Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "ci-tools").resolve()
    destination.mkdir(parents=True, exist_ok=True)
    executable = destination / ("uv.exe" if key == "win32-x64" else "uv")

    request = urllib.request.Request(
        RELEASE_API,
        headers=api_headers("application/vnd.github+json"),
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        release = json.load(response)
    assets_url = release["assets_url"] + "?per_page=100"
    asset_request = urllib.request.Request(
        assets_url,
        headers=api_headers("application/vnd.github+json"),
    )
    with urllib.request.urlopen(asset_request, timeout=30) as response:
        assets = json.load(response)
    match = next((item for item in assets if item.get("name") == name), None)
    if match is None:
        raise SystemExit(f"uv asset not found in API response: {name}")

    with tempfile.TemporaryDirectory(prefix="dswhale-ci-uv-") as temporary:
        archive = Path(temporary) / name
        download = urllib.request.Request(
            match["url"],
            headers=api_headers("application/octet-stream"),
        )
        with (
            urllib.request.urlopen(download, timeout=120) as response,
            archive.open("wb") as stream,
        ):
            while chunk := response.read(1024 * 1024):
                stream.write(chunk)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if digest != asset["sha256"]:
            raise SystemExit(f"uv checksum mismatch: {digest} != {asset['sha256']}")
        if asset["url"].endswith(".zip"):
            with zipfile.ZipFile(archive) as bundle:
                with bundle.open(asset["member"]) as source, executable.open("wb") as target:
                    target.write(source.read())
        else:
            with tarfile.open(archive) as bundle:
                member = bundle.getmember(asset["member"])
                if not member.isfile():
                    raise SystemExit("uv archive member is not a regular file")
                with bundle.extractfile(member) as source, executable.open("wb") as target:
                    assert source is not None
                    target.write(source.read())
        executable.chmod(executable.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    print(f"Seeded verified uv {TOOL_ASSETS['uvVersion']} at {executable}")
    github_env = os.environ.get("GITHUB_ENV")
    if github_env:
        with open(github_env, "a", encoding="utf-8") as stream:
            stream.write(f"DSWHALE_CI_UV={executable}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
