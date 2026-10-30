"""Checksum-pinned, private FFmpeg tools; never invoke a system package manager."""

import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import tempfile
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

import httpx
from filelock import FileLock

DOWNLOAD_LIMIT = 300 * 1024**2
UNPACKED_LIMIT = 1024**3
MEDIA_VERSION = "9.0.2"


def select_media_assets(system=None, machine=None):
    system = system or platform.system()
    machine = (machine or platform.machine()).lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine)
    os_name = {"Windows": "win", "Darwin": "darwin", "Linux": "linux"}.get(system)
    assets = json.loads(Path(__file__).with_name("media_assets.json").read_text(encoding="utf-8"))
    key = f"{os_name}-{arch}"
    if key not in assets:
        raise ValueError("专用 FFmpeg 支持 Windows x64、macOS Apple Silicon 和 Linux x64")
    return assets[key]


def usable_media(executable, tool):
    try:
        result = subprocess.run(
            [str(executable), "-version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=True,
        )
        version = re.match(rf"^{tool} version (\d+)\.\d+(?:\.\d+)?(?:[-\s]|$)", result.stdout)
        return bool(version and int(version[1]) >= 6)
    except (OSError, subprocess.SubprocessError):
        return False


def download_asset(asset, destination):
    destination = Path(destination)
    partial = destination.with_suffix(destination.suffix + ".part")
    if urlparse(asset["url"]).scheme != "https" or not re.fullmatch(
        r"[a-f0-9]{64}", asset["sha256"]
    ):
        raise ValueError("下载必须使用 HTTPS 和 SHA256 校验")
    started = time.monotonic()
    try:
        digest, total = hashlib.sha256(), 0
        with httpx.stream(
            "GET",
            asset["url"],
            timeout=90,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 DSWhale-Desktop"},
        ) as response:
            response.raise_for_status()
            if urlparse(str(response.url)).scheme != "https":
                raise ValueError("下载重定向必须使用 HTTPS")
            if int(response.headers.get("content-length", "0")) > DOWNLOAD_LIMIT:
                raise ValueError("媒体工具下载大小超过限制")
            with partial.open("wb") as output:
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > DOWNLOAD_LIMIT or time.monotonic() - started > 600:
                        raise ValueError("媒体工具下载大小或时间超过限制")
                    digest.update(chunk)
                    output.write(chunk)
        if digest.hexdigest() != asset["sha256"]:
            raise ValueError("FFmpeg 下载校验失败，未安装")
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)


def extract_media_archive(archive, destination, tool, sha256):
    archive, destination = Path(archive), Path(destination)
    if archive.stat().st_size > DOWNLOAD_LIMIT:
        raise ValueError("媒体工具压缩包大小超过限制")
    with archive.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != sha256:
            raise ValueError("媒体工具压缩包校验失败")
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        if len(infos) > 20000 or sum(info.file_size for info in infos) > UNPACKED_LIMIT:
            raise ValueError("媒体工具解压大小超过限制")
        wanted, seen = [], set()
        for info in infos:
            # ZipInfo normalizes Windows separators in filename. Validate the
            # original archive member as well, before trusting the canonical one.
            name, mode = info.orig_filename, info.external_attr >> 16
            path = PurePosixPath(name)
            if (
                not path.parts
                or path.is_absolute()
                or ".." in path.parts
                or "\\" in name
                or "\x00" in name
                or ":" in name
                or stat.S_ISLNK(mode)
                or any(
                    p.rstrip(" .") != p
                    or p.split(".")[0].upper()
                    in {
                        "CON",
                        "PRN",
                        "AUX",
                        "NUL",
                        *(f"COM{i}" for i in range(1, 10)),
                        *(f"LPT{i}" for i in range(1, 10)),
                    }
                    for p in path.parts
                )
            ):
                raise ValueError("媒体工具压缩包包含不安全路径")
            normalized = name.rstrip("/").casefold()
            if normalized in seen:
                raise ValueError("媒体工具压缩包包含重复路径")
            seen.add(normalized)
            if not info.is_dir() and path.name in {tool, f"{tool}.exe"}:
                wanted.append(info)
        if len(wanted) != 1:
            raise ValueError("媒体工具压缩包结构不正确")
        with bundle.open(wanted[0]) as source, destination.open("xb") as output:
            shutil.copyfileobj(source, output, length=1024 * 1024)
        destination.chmod(0o755)


def ensure_media(runtime, *, reuse=True):
    runtime = Path(runtime).expanduser().resolve()
    names = {tool: f"{tool}.exe" if os.name == "nt" else tool for tool in ("ffmpeg", "ffprobe")}
    existing = {tool: shutil.which(tool) if reuse else None for tool in names}
    if all(value and usable_media(value, tool) for tool, value in existing.items()):
        return {tool: Path(value).resolve() for tool, value in existing.items()}
    tools = runtime / "tools"
    tools.mkdir(parents=True, exist_ok=True)
    with FileLock(tools / "media-install.lock", timeout=0):
        target = tools / f"ffmpeg-{MEDIA_VERSION}"
        result = {tool: target / filename for tool, filename in names.items()}
        if all(usable_media(value, tool) for tool, value in result.items()):
            return result
        assets = select_media_assets()
        with tempfile.TemporaryDirectory(prefix="media-stage-", dir=tools) as directory:
            stage = Path(directory)
            binaries = stage / "bin"
            binaries.mkdir()
            downloaded = {}
            for tool, filename in names.items():
                asset = assets[tool]
                key = (asset["url"], asset["sha256"])
                if key not in downloaded:
                    archive = stage / f"media-{len(downloaded)}.zip"
                    download_asset(asset, archive)
                    downloaded[key] = archive
                extract_media_archive(downloaded[key], binaries / filename, tool, asset["sha256"])
                if not usable_media(binaries / filename, tool):
                    raise RuntimeError("下载的媒体工具与当前系统不兼容")
            if target.is_symlink():
                raise ValueError("媒体工具目标不能是符号链接")
            previous = tools / f".ffmpeg-previous-{uuid.uuid4().hex}"
            if target.exists():
                target.rename(previous)
            try:
                binaries.rename(target)
            except BaseException:
                if previous.exists():
                    previous.rename(target)
                raise
            if previous.exists():
                shutil.rmtree(previous)
        return result
