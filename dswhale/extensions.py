"""Explicit, independent updates of allowlisted AstrBot extensions.

Nothing contacts upstream from status or application startup. Checked immutable
commits, receipts and complete pre-update data snapshots stay inside the host.
"""

import argparse
import hashlib
import importlib.metadata
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlsplit

import httpx
from filelock import FileLock, Timeout

from .install import InstallError, offline_host

SOURCES = {
    "memory": {
        "repo": "lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory",
        "directory": "astrbot_plugin_livingmemory",
        "name": "astrbot_plugin_livingmemory",
    },
    "memes": {
        "repo": "anka-afk/astrbot_plugin_meme_manager",
        "directory": "astrbot_plugin_meme_manager",
        "name": "meme_manager",
    },
}
DOWNLOAD_LIMIT = 64 * 1024**2
EXTRACT_LIMIT = 256 * 1024**2
SNAPSHOT_LIMIT = 1024**3
FILE_LIMIT = 20000
CANDIDATE_AGE = 24 * 3600
VERSION = re.compile(r"v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")


class ExtensionError(RuntimeError):
    """Only fixed, user-safe messages may cross the CLI boundary."""


def _source(extension_id):
    try:
        return SOURCES[extension_id]
    except (KeyError, TypeError):
        raise ExtensionError("请选择记忆或表情插件") from None


def _version(value):
    match = VERSION.fullmatch(str(value))
    if not match:
        raise ExtensionError("插件版本不是受支持的稳定版本")
    return tuple(int(p) for p in match.groups())


def _normal_version(value):
    return ".".join(str(p) for p in _version(value))


def _host(root):
    root = Path(root).expanduser().resolve()
    for relative in ("data", "data/plugins", ".dswhale-extensions"):
        path = root / relative
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise ExtensionError("宿主目录结构不安全，请先检查目录")
    return root


def _state(root):
    directory = root / ".dswhale-extensions"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink():
        raise ExtensionError("更新记录目录不安全")
    directory.chmod(0o700)
    return directory


@contextmanager
def _state_lock(root):
    try:
        with FileLock(_state(root) / "updater.lock", timeout=0):
            yield
    except Timeout:
        raise ExtensionError("另一项插件操作正在进行，请稍后重试") from None
    except ExtensionError:
        raise
    except Exception:
        raise ExtensionError("插件操作未完成，请检查网络和可用空间后重试") from None


@contextmanager
def _offline(root):
    try:
        with offline_host(root), _state_lock(root):
            yield
    except InstallError:
        raise ExtensionError("请先停止 AstrBot，再更新、回退或恢复插件") from None
    except ExtensionError:
        raise
    except Exception:
        raise ExtensionError("插件操作未完成，原有数据保留，请检查网络和可用空间后重试") from None


def _read_json(path):
    if path.is_symlink() or not path.is_file():
        return None
    try:
        if path.stat().st_size > 1024 * 1024:
            return None
        result = json.loads(path.read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else None
    except (OSError, ValueError):
        return None


def _write_json(path, value):
    handle, filename = tempfile.mkstemp(prefix=".record-", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        Path(filename).replace(path)
    finally:
        Path(filename).unlink(missing_ok=True)


def _metadata(directory):
    path = directory / "metadata.yaml"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        return {}
    values = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        match = re.match(r"^(name|version|repo|astrbot_version):\s*([^#]*?)(?:\s+#.*)?$", line)
        if match:
            values[match[1]] = match[2].strip().strip("\"'")
    return values


def _validate_host(metadata):
    specification = metadata.get("astrbot_version")
    if specification is None:
        return
    from packaging.specifiers import InvalidSpecifier, SpecifierSet
    from packaging.version import InvalidVersion, Version

    try:
        required = SpecifierSet(specification)
        current = Version(importlib.metadata.version("astrbot"))
        compatible = bool(specification.strip()) and current in required
    except (InvalidSpecifier, InvalidVersion, importlib.metadata.PackageNotFoundError):
        raise ExtensionError("无法确认 AstrBot 版本兼容性，未修改现有插件") from None
    if not compatible:
        raise ExtensionError("插件要求不同版本的 AstrBot，请先检查宿主版本；未修改现有插件")


def _client():
    return httpx.Client(
        timeout=httpx.Timeout(60, connect=15),
        follow_redirects=False,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "DSWhale-manual-updater"},
    )


def _validate_url(url, *, archive=False):
    parsed = urlsplit(url)
    host = "codeload.github.com" if archive else "api.github.com"
    if parsed.scheme != "https" or parsed.netloc != host or parsed.fragment or parsed.query:
        raise ExtensionError("更新源地址不安全")
    allowed = any(
        parsed.path.startswith(f"/{s['repo']}/zip/")
        if archive
        else parsed.path.startswith(f"/repos/{s['repo']}/")
        for s in SOURCES.values()
    )
    if not allowed:
        raise ExtensionError("只支持官方指定的插件来源")


def _request_json(url):
    _validate_url(url)
    try:
        with _client() as client, client.stream("GET", url) as response:
            if response.status_code != 200:
                raise ExtensionError("无法检查上游稳定版本，请稍后重试")
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > 1024 * 1024:
                    raise ExtensionError("上游版本响应超过限制")
            result = json.loads(body)
            if not isinstance(result, dict):
                raise ExtensionError("上游版本信息无效")
            return result
    except ExtensionError:
        raise
    except Exception:
        raise ExtensionError("无法检查上游稳定版本，请检查网络后重试") from None


def _download(url, destination):
    _validate_url(url, archive=True)
    try:
        with _client() as client, client.stream("GET", url) as response:
            if response.status_code != 200:
                raise ExtensionError("插件下载失败，请重新检查版本后重试")
            size = 0
            with destination.open("xb") as output:
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > DOWNLOAD_LIMIT:
                        raise ExtensionError("插件下载超过大小限制")
                    output.write(chunk)
    except ExtensionError:
        raise
    except Exception:
        raise ExtensionError("插件下载失败，请检查网络后重试") from None


def _extract(archive, destination, *, limit=None):
    """Validate every member before creating any output file."""
    limit = EXTRACT_LIMIT if limit is None else limit
    try:
        with zipfile.ZipFile(archive) as z:
            infos = z.infolist()
            if len(infos) > FILE_LIMIT or sum(i.file_size for i in infos) > limit:
                raise ExtensionError("插件解压大小或文件数超过限制")
            seen = set()
            files = set()
            for info in infos:
                name = info.orig_filename
                path = PurePosixPath(name)
                mode = info.external_attr >> 16
                if (
                    not name
                    or path.is_absolute()
                    or ".." in path.parts
                    or "\\" in name
                    or ":" in name
                    or "\x00" in name
                    or stat.S_ISLNK(mode)
                    or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))
                    or info.flag_bits & 1
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
                    raise ExtensionError("压缩包包含不安全路径")
                normalized = path.as_posix().rstrip("/").casefold()
                if normalized in seen:
                    raise ExtensionError("压缩包包含重名路径")
                seen.add(normalized)
                if not info.is_dir():
                    files.add(normalized)
                if any(
                    parent.as_posix().casefold() in files
                    for parent in path.parents
                    if str(parent) != "."
                ):
                    raise ExtensionError("压缩包路径相互冲突")
            if any(
                parent.as_posix().casefold() in files
                for member in seen
                for parent in PurePosixPath(member).parents
                if str(parent) != "."
            ):
                raise ExtensionError("压缩包路径相互冲突")
            if destination.exists():
                raise ExtensionError("解压目标必须为空")
            destination.mkdir(parents=True)
            for info in infos:
                target = destination.joinpath(*PurePosixPath(info.orig_filename).parts)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(info) as source, target.open("xb") as output:
                        shutil.copyfileobj(source, output, 1024 * 1024)
    except ExtensionError:
        raise
    except Exception:
        raise ExtensionError("插件压缩包验证失败") from None


def _files(data):
    if not data.exists():
        return []
    paths = sorted(data.rglob("*"))
    if len(paths) > FILE_LIMIT or any(p.is_symlink() for p in paths):
        raise ExtensionError("宿主数据包含链接或文件过多，请先手动备份")
    files = [
        p for p in paths if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"
    ]
    if any(not p.is_file() and not p.is_dir() for p in paths):
        raise ExtensionError("宿主数据包含不支持的特殊文件")
    if sum(p.stat().st_size for p in files) > SNAPSHOT_LIMIT:
        raise ExtensionError("宿主数据超过 1 GiB，请先关闭程序并手动完整备份")
    return files


def _fingerprint(root, *, replacement=None):
    digest = hashlib.sha256()
    files = []
    for path in _files(root / "data"):
        if replacement and path.is_relative_to(replacement[0]):
            continue
        files.append((path.relative_to(root).as_posix(), path))
    if replacement and replacement[1] is not None:
        destination, source = replacement
        for path in _files(source):
            name = (destination / path.relative_to(source)).relative_to(root).as_posix()
            files.append((name, path))
    for name, path in sorted(files):
        digest.update(name.encode())
        digest.update(b"\0")
        with path.open("rb") as stream:
            digest.update(hashlib.file_digest(stream, "sha256").digest())
        digest.update(b"\0")
    return digest.hexdigest()


def _recover_transaction(root, extension_id):
    """Undo an interrupted replacement before reporting or starting more work."""
    directory = root / ".dswhale-extensions"
    journal_path = directory / f"{extension_id}-transaction.json"
    if not journal_path.exists():
        return
    journal = _read_json(journal_path)
    if (
        not journal
        or journal.get("format") != 1
        or journal.get("id") != extension_id
        or not re.fullmatch(r"[0-9a-f]{32}", str(journal.get("transaction", "")))
        or journal.get("phase") not in {"prepared", "committed"}
        or not DIGEST.fullmatch(str(journal.get("beforeFingerprint", "")))
        or not DIGEST.fullmatch(str(journal.get("afterFingerprint", "")))
    ):
        raise ExtensionError("更新恢复记录损坏，请保留备份并手动检查")
    transaction = directory / "transactions" / journal["transaction"]
    if transaction.parent.is_symlink() or transaction.is_symlink() or not transaction.is_dir():
        raise ExtensionError("更新恢复目录不安全，请保留备份并手动检查")
    destination = root / "data/plugins" / _source(extension_id)["directory"]
    previous = transaction / "previous"
    if journal["phase"] == "prepared":
        if destination.is_symlink() or previous.is_symlink():
            raise ExtensionError("更新恢复目录包含链接，请先手动检查")
        current = _fingerprint(root)
        old_installed = journal.get("previousInstalled") is True
        if destination.exists():
            if current not in {journal["beforeFingerprint"], journal["afterFingerprint"]}:
                raise ExtensionError("更新中断后数据已有变化，请手动审查备份后恢复")
            if previous.exists() or not old_installed:
                destination.rename(transaction / "discarded")
        elif old_installed:
            if (
                not previous.is_dir()
                or _fingerprint(root, replacement=(destination, previous))
                != journal["beforeFingerprint"]
            ):
                raise ExtensionError("更新中断后数据已有变化，请手动审查备份后恢复")
        elif current != journal["beforeFingerprint"]:
            raise ExtensionError("更新中断后数据已有变化，请手动审查备份后恢复")
        if previous.exists():
            previous.rename(destination)
        receipt_path = directory / f"{extension_id}-receipt.json"
        if isinstance(journal.get("previousReceipt"), dict):
            _write_json(receipt_path, journal["previousReceipt"])
        else:
            receipt_path.unlink(missing_ok=True)
    journal_path.unlink()
    shutil.rmtree(transaction)


def _recover_pending(root):
    if any(
        (root / ".dswhale-extensions" / f"{extension_id}-transaction.json").exists()
        for extension_id in SOURCES
    ):
        with _offline(root):
            for extension_id in SOURCES:
                _recover_transaction(root, extension_id)


def _transaction_replace(root, extension_id, replacement, receipt):
    """A private durable journal survives termination between either rename."""
    directory = _state(root)
    destination = root / "data/plugins" / _source(extension_id)["directory"]
    transactions = directory / "transactions"
    if transactions.is_symlink():
        raise ExtensionError("更新事务目录不安全")
    transactions.mkdir(mode=0o700, exist_ok=True)
    transaction = transactions / uuid.uuid4().hex
    transaction.mkdir(mode=0o700)
    journal = {
        "format": 1,
        "id": extension_id,
        "transaction": transaction.name,
        "phase": "prepared",
        "previousInstalled": destination.exists(),
        "previousReceipt": _receipt(root, extension_id),
        "beforeFingerprint": _fingerprint(root),
        "afterFingerprint": _fingerprint(root, replacement=(destination, replacement)),
    }
    journal_path = directory / f"{extension_id}-transaction.json"
    _write_json(journal_path, journal)
    try:
        if destination.exists():
            destination.rename(transaction / "previous")
        if replacement is not None:
            replacement.rename(destination)
        if receipt is not None:
            receipt["postFingerprint"] = journal["afterFingerprint"]
            _write_json(directory / f"{extension_id}-receipt.json", receipt)
        else:
            (directory / f"{extension_id}-receipt.json").unlink(missing_ok=True)
        journal["phase"] = "committed"
        _write_json(journal_path, journal)
    except BaseException:
        _recover_transaction(root, extension_id)
        raise
    _recover_transaction(root, extension_id)


def _candidate(root, extension_id):
    source = _source(extension_id)
    candidate = _read_json(root / ".dswhale-extensions" / f"{extension_id}-candidate.json")
    try:
        if (
            not candidate
            or candidate.get("format") != 1
            or candidate.get("repo") != source["repo"]
            or not SHA.fullmatch(candidate.get("commit", ""))
            or _normal_version(candidate.get("version")) != candidate.get("version")
            or not (0 <= time.time() - candidate["checkedAt"] <= CANDIDATE_AGE)
        ):
            return None
    except (TypeError, ValueError, ExtensionError, KeyError):
        return None
    return candidate


def _receipt(root, extension_id):
    receipt = _read_json(root / ".dswhale-extensions" / f"{extension_id}-receipt.json")
    if not receipt:
        return None
    if receipt.get("format") != 1 or receipt.get("repo") != _source(extension_id)["repo"]:
        return None
    return receipt


def _rollback_available(root, extension_id, receipt):
    if not receipt or not re.fullmatch(r"[0-9a-f]{32}\.zip", str(receipt.get("backup", ""))):
        return False
    path = root / ".dswhale-extensions" / "backups" / receipt["backup"]
    if (
        path.parent.is_symlink()
        or path.is_symlink()
        or not path.is_file()
        or not DIGEST.fullmatch(str(receipt.get("postFingerprint", "")))
        or not DIGEST.fullmatch(str(receipt.get("backupSha256", "")))
    ):
        return False
    try:
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != receipt["backupSha256"]:
                return False
        return _fingerprint(root) == receipt["postFingerprint"]
    except (ExtensionError, OSError):
        return False


def status(root):
    root = _host(root)
    _recover_pending(root)
    result = {}
    for extension_id, source in SOURCES.items():
        directory = root / "data/plugins" / source["directory"]
        if directory.is_symlink():
            raise ExtensionError("插件目录不能是链接")
        metadata = _metadata(directory)
        version = metadata.get("version")
        try:
            version = _normal_version(version) if version else None
        except ExtensionError:
            version = None
        installed = directory.is_dir()
        candidate = _candidate(root, extension_id)
        receipt = _receipt(root, extension_id)
        latest = candidate["version"] if candidate else None
        result[extension_id] = {
            "installed": installed,
            "version": version,
            "latest": latest,
            "canUpdate": bool(
                candidate and (not installed or (version and _version(latest) > _version(version)))
            ),
            "canRollback": _rollback_available(root, extension_id, receipt),
            "checkedAt": candidate["checkedAt"] if candidate else None,
        }
        if receipt and receipt.get("backup") and not result[extension_id]["canRollback"]:
            result[extension_id]["rollbackBlocked"] = "更新后数据已有变化，需手动审查备份后恢复"
    return result


def check(root, extension_id):
    source = _source(extension_id)
    root = _host(root)
    _recover_pending(root)
    with _state_lock(root):
        directory = _state(root)
        # A failed re-check must not leave an earlier candidate available.
        candidate_path = directory / f"{extension_id}-candidate.json"
        candidate_path.unlink(missing_ok=True)
        api = f"https://api.github.com/repos/{source['repo']}"
        release = _request_json(f"{api}/releases/latest")
        tag = release.get("tag_name", "")
        version = _normal_version(tag)
        if release.get("draft") is not False or release.get("prerelease") is not False:
            raise ExtensionError("上游尚未提供可用的稳定版本")
        commit = _request_json(f"{api}/commits/{quote(tag, safe='')}").get("sha", "")
        if not isinstance(commit, str) or not SHA.fullmatch(commit):
            raise ExtensionError("上游版本无法解析为固定提交")
        _write_json(
            candidate_path,
            {
                "format": 1,
                "repo": source["repo"],
                "version": version,
                "commit": commit,
                "checkedAt": time.time(),
            },
        )
        return status(root)


def _snapshot(root, directory):
    path = directory / "backups" / f"{uuid.uuid4().hex}.zip"
    path.parent.mkdir(mode=0o700, exist_ok=True)
    if path.parent.is_symlink():
        raise ExtensionError("备份目录不安全")
    path.parent.chmod(0o700)
    files = _files(root / "data")
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with (
            os.fdopen(descriptor, "wb") as stream,
            zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive,
        ):
            archive.writestr("data/", "")
            for file in files:
                archive.write(file, file.relative_to(root).as_posix())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return path


def _run_dependency_command(arguments, *, cwd):
    process = None
    previous_handler = None
    handler_installed = False

    def cancel(signum, frame):
        raise SystemExit(128 + signum)

    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "pip", "--disable-pip-version-check", "--no-input", *arguments],
            cwd=cwd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if threading.current_thread() is threading.main_thread():
            previous_handler = signal.signal(signal.SIGTERM, cancel)
            handler_installed = True
        if process.wait(timeout=300):
            raise ExtensionError("依赖安装未完成或与现有环境不兼容；原插件尚未替换")
    except Exception:
        raise ExtensionError("依赖安装未完成或与现有环境不兼容；原插件尚未替换") from None
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if handler_installed:
            signal.signal(signal.SIGTERM, previous_handler)


def _ensure_dependencies(requirements, directory):
    if not requirements.is_file():
        return
    from packaging.requirements import InvalidRequirement, Requirement
    from packaging.utils import canonicalize_name
    from packaging.version import InvalidVersion, Version

    installed = {}
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name", "")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name):
            continue
        try:
            Version(distribution.version)
        except InvalidVersion:
            raise ExtensionError("现有依赖版本无法安全固定，请先检查运行环境") from None
        installed[canonicalize_name(name)] = distribution.version
    missing = False
    for line in requirements.read_text(encoding="utf-8-sig").splitlines():
        line = re.split(r"\s+#", line, maxsplit=1)[0].strip()
        if not line or line.startswith("#"):
            continue
        try:
            requirement = Requirement(line)
        except InvalidRequirement:
            raise ExtensionError("插件依赖声明不受支持，未修改现有插件") from None
        if requirement.url:
            raise ExtensionError("不允许从自定义地址安装插件依赖")
        if requirement.marker and not requirement.marker.evaluate():
            continue
        current = installed.get(canonicalize_name(requirement.name))
        if current and not requirement.specifier.contains(current, prereleases=True):
            raise ExtensionError("插件依赖与现有版本不兼容，未修改现有插件")
        if not current or requirement.extras:
            missing = True
    if not missing:
        return
    constraints = directory / "constraints.txt"
    constraints.write_text(
        "".join(f"{name}=={version}\n" for name, version in sorted(installed.items())),
        encoding="utf-8",
    )
    report = directory / "dependency-plan.json"
    _run_dependency_command(
        [
            "install",
            "--dry-run",
            "--report",
            str(report),
            "--only-binary=:all:",
            "--constraint",
            str(constraints),
            "--requirement",
            str(requirements),
        ],
        cwd=directory,
    )
    plan = _read_json(report)
    if not plan or not isinstance(plan.get("install"), list):
        raise ExtensionError("依赖检查未生成可验证的安装计划")
    additions = []
    for item in plan["install"]:
        metadata = item.get("metadata", {})
        name, version = metadata.get("name", ""), metadata.get("version", "")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name):
            raise ExtensionError("依赖安装计划无效")
        try:
            Version(version)
        except InvalidVersion:
            raise ExtensionError("依赖安装计划无效") from None
        if canonicalize_name(name) in installed:
            if installed[canonicalize_name(name)] != version:
                raise ExtensionError("插件依赖要求更改现有版本，已停止更新")
            continue
        additions.append(f"{name}=={version}")
    if additions:
        wheels = directory / "wheels"
        wheels.mkdir()
        _run_dependency_command(
            ["download", "--only-binary=:all:", "--no-deps", "--dest", str(wheels), *additions],
            cwd=directory,
        )
        _run_dependency_command(
            ["install", "--no-index", "--no-deps", "--find-links", str(wheels), *additions],
            cwd=directory,
        )


def _merge(source, destination):
    """Retain files not shipped upstream, including local plugin state."""
    for item in source.rglob("*"):
        relative = item.relative_to(source)
        target = destination / relative
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if target.exists() and (
            item.suffix.lower() in {".db", ".sqlite", ".sqlite3"}
            or item.name in {".env", "config.json", "settings.json", "credentials.json"}
            or relative.parts[0] in {"data", "plugin_data", "personas", "memories", "local-data"}
        ):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, target)


def update(root, extension_id):
    source_info = _source(extension_id)
    root = _host(root)
    _recover_pending(root)
    with _offline(root):
        directory = _state(root)
        candidate = _candidate(root, extension_id)
        if not candidate:
            raise ExtensionError("请先手动检查稳定版本，再更新插件")
        if not status(root)[extension_id]["canUpdate"]:
            raise ExtensionError("当前版本无需更新，或无法安全确认版本；不会降级插件")
        destination = root / "data/plugins" / source_info["directory"]
        old_receipt = _receipt(root, extension_id)
        with tempfile.TemporaryDirectory(prefix=".stage-", dir=directory) as temp:
            stage = Path(temp)
            archive = stage / "upstream.zip"
            _download(
                f"https://codeload.github.com/{source_info['repo']}/zip/{candidate['commit']}",
                archive,
            )
            _extract(archive, stage / "extracted")
            entries = list((stage / "extracted").iterdir())
            expected = f"{source_info['directory']}-{candidate['commit']}"
            if len(entries) != 1 or entries[0].name != expected or not entries[0].is_dir():
                raise ExtensionError("插件压缩包与固定提交不匹配")
            source = entries[0]
            metadata = _metadata(source)
            if (
                not (source / "main.py").is_file()
                or metadata.get("name") != source_info["name"]
                or _normal_version(metadata.get("version")) != candidate["version"]
            ):
                raise ExtensionError("插件名称或版本与检查结果不匹配")
            if (
                metadata.get("repo", f"https://github.com/{source_info['repo']}").rstrip("/")
                != f"https://github.com/{source_info['repo']}"
            ):
                raise ExtensionError("插件声明的来源与指定仓库不一致")
            _validate_host(metadata)
            try:
                for module in source.rglob("*.py"):
                    compile(module.read_bytes(), str(module), "exec")
            except (SyntaxError, ValueError):
                raise ExtensionError("插件代码与当前 Python 不兼容，未修改现有插件") from None
            # Check local tree before copying, backing up, or resolving dependencies.
            _files(root / "data")
            replacement = stage / "replacement"
            existed = destination.exists()
            if existed:
                shutil.copytree(
                    destination, replacement, ignore=shutil.ignore_patterns("__pycache__", "*.pyc")
                )
            else:
                replacement.mkdir()
            _merge(source, replacement)
            _ensure_dependencies(source / "requirements.txt", stage)
            snapshot = _snapshot(root, directory)
            with snapshot.open("rb") as stream:
                backup_digest = hashlib.file_digest(stream, "sha256").hexdigest()
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            destination.parent.mkdir(parents=True, exist_ok=True)
            receipt = {
                "format": 1,
                "repo": source_info["repo"],
                "version": candidate["version"],
                "commit": candidate["commit"],
                "sha256": digest,
                "backup": snapshot.name,
                "backupSha256": backup_digest,
                "previousInstalled": existed,
                "previousReceipt": old_receipt,
                "updatedAt": time.time(),
            }
            _transaction_replace(root, extension_id, replacement, receipt)
        return status(root)


def rollback(root, extension_id):
    source = _source(extension_id)
    root = _host(root)
    _recover_pending(root)
    with _offline(root):
        directory = _state(root)
        receipt = _receipt(root, extension_id)
        if not _rollback_available(root, extension_id, receipt):
            raise ExtensionError("没有可安全回退的更新，或更新后数据已有变化；请先手动审查备份")
        archive = directory / "backups" / receipt["backup"]
        with tempfile.TemporaryDirectory(prefix=".rollback-", dir=directory) as temp:
            stage = Path(temp)
            _extract(archive, stage / "snapshot", limit=SNAPSHOT_LIMIT)
            previous = stage / "snapshot/data/plugins" / source["directory"]
            if receipt.get("previousInstalled") and not previous.is_dir():
                raise ExtensionError("备份缺少原插件，已停止回退")
            # Retain a second full snapshot for manual recovery of the newer code.
            _snapshot(root, directory)
            prior_receipt = receipt.get("previousReceipt")
            _transaction_replace(
                root,
                extension_id,
                previous if receipt.get("previousInstalled") else None,
                prior_receipt if isinstance(prior_receipt, dict) else None,
            )
        return status(root)


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ExtensionError("更新命令参数无效")


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        parser = _Parser(description="手动管理记忆和表情插件")
        parser.add_argument("--host", required=True, type=Path)
        parser.add_argument("action", choices=("status", "check", "update", "rollback"))
        parser.add_argument("--id", choices=tuple(SOURCES))
        args = parser.parse_args(argv)
        if args.action == "status":
            result = status(args.host)
        elif not args.id:
            raise ExtensionError("请选择要管理的插件")
        else:
            result = {"check": check, "update": update, "rollback": rollback}[args.action](
                args.host, args.id
            )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ExtensionError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1
    except Exception:
        print(
            json.dumps(
                {"ok": False, "error": "插件操作未完成，请检查网络、目录权限和可用空间后重试"},
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
