"""Offline, reversible installation and complete AstrBot data snapshots."""

import hashlib
import importlib.metadata
import json
import os
import shutil
import stat
import sys
import tempfile
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

import httpx
from filelock import FileLock, Timeout

from . import __version__
from .config import Settings

PLUGIN = "astrbot_plugin_dswhale"
PLUGIN_FILES = (
    "main.py",
    "metadata.yaml",
    "_conf_schema.json",
    "requirements.txt",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
)
MEMORY_COMMIT = "b8aaaec2c1232ec2c86fce22cec066a0069018e0"
MEMORY_URL = f"https://codeload.github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/zip/{MEMORY_COMMIT}"
MEMORY_SHA256 = "9f75add262ebd514112c5c0fa8bc75ea402578f814c70360939b02337acef44a"
ARCHIVE_LIMIT = 1024**3


class InstallError(RuntimeError):
    pass


@contextmanager
def offline_host(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    try:
        with FileLock(root / "astrbot.lock", timeout=0):
            yield
    except Timeout as error:
        raise InstallError("请先停止 AstrBot，再安装、备份或恢复") from error


def _replace(source: Path, destination: Path, root: Path):
    """Retain old files and roll back a failed rename; all paths are on one volume."""
    if destination.is_symlink():
        raise InstallError("目标目录不能是符号链接")
    previous = None
    if destination.exists():
        previous = root / ".dswhale-backups" / f"{destination.name}-{uuid.uuid4().hex}"
        previous.parent.mkdir(parents=True, exist_ok=True)
        destination.rename(previous)
    try:
        source.rename(destination)
    except BaseException:
        if previous:
            previous.rename(destination)
        raise


def install_plugin(root: Path, *, node=None) -> Path:
    root = root.expanduser().resolve()
    with offline_host(root):
        plugin_parent = root / "data" / "plugins"
        plugin_parent.mkdir(parents=True, exist_ok=True)
        code = Path(__file__).resolve().parent
        assets = code.parent if (code.parent / "metadata.yaml").is_file() else code / "_plugin"
        if not all((assets / name).is_file() for name in PLUGIN_FILES):
            raise InstallError("安装包缺少插件资源，请使用完整源代码或发布的 wheel")
        with tempfile.TemporaryDirectory(prefix=".dswhale-stage-", dir=root) as directory:
            stage = Path(directory) / PLUGIN
            stage.mkdir()
            for name in PLUGIN_FILES:
                shutil.copy2(assets / name, stage / name)
            (stage / "dswhale").mkdir()
            for module in code.glob("*.py"):
                shutil.copy2(module, stage / "dswhale" / module.name)
            shutil.copytree(
                code / "bili_bridge",
                stage / "dswhale/bili_bridge",
                ignore=shutil.ignore_patterns("node_modules", "__pycache__", ".DS_Store"),
            )
            if node:
                from .runtime import prepare_bridge

                prepare_bridge(stage / "dswhale/bili_bridge", node)
            destination = plugin_parent / PLUGIN
            _replace(stage, destination, root)
        return destination


def extract_archive(archive: Path, destination: Path, *, sha256: str):
    if archive.stat().st_size > ARCHIVE_LIMIT:
        raise InstallError("压缩包过大")
    with archive.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != sha256:
        raise InstallError("压缩包校验失败，请重新下载")
    with zipfile.ZipFile(archive) as z:
        infos = z.infolist()
        if len(infos) > 20000 or sum(i.file_size for i in infos) > ARCHIVE_LIMIT:
            raise InstallError("解压大小或文件数超过限制")
        seen = set()
        for info in infos:
            name = info.filename
            path = PurePosixPath(name)
            if (
                path.is_absolute()
                or ".." in path.parts
                or "\\" in name
                or ":" in name
                or stat.S_ISLNK(info.external_attr >> 16)
                or not path.parts
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
                raise InstallError("压缩包包含不安全路径")
            normalized = name.rstrip("/").casefold()
            if normalized in seen:
                raise InstallError("压缩包包含重名路径")
            seen.add(normalized)
        if destination.exists():
            raise InstallError("解压目标必须不存在")
        destination.mkdir(parents=True)
        for info in infos:
            target = destination.joinpath(*PurePosixPath(info.filename).parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)


def install_memory(root: Path) -> Path:
    root = root.expanduser().resolve()
    with offline_host(root):
        destination = root / "data/plugins/astrbot_plugin_livingmemory"
        # Never downgrade or replace the user's separately managed memory plugin.
        if destination.exists():
            return destination
        with tempfile.TemporaryDirectory(prefix=".dswhale-memory-", dir=root) as directory:
            stage = Path(directory)
            archive = stage / "memory.zip"
            with httpx.stream("GET", MEMORY_URL, timeout=60, follow_redirects=True) as response:
                response.raise_for_status()
                total = 0
                with archive.open("wb") as output:
                    for chunk in response.iter_bytes():
                        total += len(chunk)
                        if total > 20 * 1024**2:
                            raise InstallError("记忆插件下载超过预期大小")
                        output.write(chunk)
            extract_archive(archive, stage / "extracted", sha256=MEMORY_SHA256)
            source = stage / "extracted" / f"astrbot_plugin_livingmemory-{MEMORY_COMMIT}"
            if not (source / "main.py").is_file():
                raise InstallError("记忆插件结构不正确")
            destination.parent.mkdir(parents=True, exist_ok=True)
            _replace(source, destination, root)
        return destination


def backup(root: Path, destination: Path):
    root, destination = root.resolve(), destination.resolve()
    data = root / "data"
    if destination.exists() or destination.is_relative_to(data):
        raise InstallError("备份目标必须是 data 目录外的新文件")
    with offline_host(root):
        if not data.is_dir():
            raise InstallError("没有可备份的 AstrBot data 目录")
        paths = list(data.rglob("*"))
        if any(p.is_symlink() for p in paths):
            raise InstallError("data 内存在符号链接，请先单独备份其目标")
        files = [p for p in paths if p.is_file()]
        if sum(p.stat().st_size for p in files) > ARCHIVE_LIMIT:
            raise InstallError("data 超过 1 GiB，请关闭程序后手动复制整个目录备份")
        destination.parent.mkdir(parents=True, exist_ok=True)
        handle, temp_name = tempfile.mkstemp(dir=destination.parent, suffix=".zip")
        os.close(handle)
        temporary = Path(temp_name)
        try:
            with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as z:
                z.writestr(
                    "manifest.json",
                    json.dumps({"project": "DSWhale", "version": __version__, "format": 1}),
                )
                z.writestr("data/", "")
                for path in files:
                    z.write(path, path.relative_to(root).as_posix())
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)


def restore(root: Path, archive: Path):
    root = root.resolve()
    with offline_host(root):
        with tempfile.TemporaryDirectory(prefix=".dswhale-restore-", dir=root) as directory:
            extracted = Path(directory) / "snapshot"
            with archive.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            extract_archive(archive, extracted, sha256=digest)
            manifest_path = extracted / "manifest.json"
            if not manifest_path.is_file() or not (extracted / "data").is_dir():
                raise InstallError("这不是 DSWhale 备份")
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if (
                manifest.get("project") != "DSWhale"
                or manifest.get("format") != 1
                or {p.name for p in extracted.iterdir()} != {"data", "manifest.json"}
            ):
                raise InstallError("备份格式不兼容")
            _replace(extracted / "data", root / "data", root)


def doctor(root: Path) -> dict:
    checks = []

    def add(name, ok, detail, required=True):
        checks.append({"name": name, "ok": bool(ok), "required": required, "detail": detail})

    add("python", sys.version_info[:2] == (3, 12), "使用 Python 3.12")
    try:
        version = importlib.metadata.version("astrbot")
    except importlib.metadata.PackageNotFoundError:
        version = "未安装"
    add("astrbot", version == "4.29.3", f"当前：{version}；验证版本：4.29.3")
    for program in ("ffmpeg", "ffprobe"):
        add(program, shutil.which(program), "视频读取需要此工具")
    add("plugin", (root / "data/plugins" / PLUGIN / "main.py").is_file(), "DSWhale 插件文件")
    config = root / "data/config" / f"{PLUGIN}_config.json"
    try:
        settings = Settings.from_mapping(json.loads(config.read_text(encoding="utf-8-sig")))
        add("owner", settings.owner_umo, "主人 QQ 私聊绑定")
        add("vision", settings.vision_provider_id, "图片模型 ID（未调用远程模型）")
        if settings.cookies_path:
            add(
                "cookies",
                Path(settings.cookies_path).expanduser().is_file(),
                "仅检查文件存在，不显示内容",
            )
    except (OSError, ValueError, TypeError):
        add("config", False, "启动 AstrBot 并保存有效的 DSWhale 插件配置")
    add(
        "memory",
        (root / "data/plugins/astrbot_plugin_livingmemory/main.py").is_file(),
        "记忆插件文件；仍需在 AstrBot 设置 Embedding 模型",
    )
    return {
        "ready": all(c["ok"] for c in checks if c["required"]),
        "checks": checks,
        "note": "这是本地配置检查；QQ、视频平台和模型联网状态需实际测试。",
    }
