"""Idempotent setup for source launchers and the desktop's private runtime."""

import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import stat
import string
import subprocess
import tempfile
import zipfile
from datetime import datetime
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

from filelock import FileLock, Timeout

# This file also runs before DSWhale is installed. Load the bundled, standard-
# library-only policy directly, without relying on cwd or an installed package.
_network_spec = spec_from_file_location(
    "dswhale_bootstrap_network", Path(__file__).resolve().parents[1] / "dswhale/network.py"
)
_network = module_from_spec(_network_spec)
_network_spec.loader.exec_module(_network)


def run(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, timeout=1800, **kwargs)


def output(args, **kwargs):
    try:
        return subprocess.check_output(
            [str(a) for a in args],
            text=True,
            encoding="utf-8",
            errors="replace",
            stderr=subprocess.DEVNULL,
            timeout=900,
            **kwargs,
        )
    except subprocess.CalledProcessError as error:
        for line in (error.output or "").splitlines():
            if line.startswith("DSWHALE_NETWORK_ERROR "):
                try:
                    event = json.loads(line.removeprefix("DSWHALE_NETWORK_ERROR "))
                    safe = _network.NetworkError(event.get("code"), event.get("source"))
                except (ValueError, TypeError, AttributeError):
                    continue
                raise safe from None
        raise


def network_command(script):
    return (
        "import json,sys\nfrom dswhale.network import NetworkError\ntry:\n"
        f"    exec({script!r})\n"
        "except NetworkError as error:\n"
        "    print('DSWHALE_NETWORK_ERROR '+json.dumps({'code':error.code,'source':error.source}),flush=True)\n"
        "    sys.exit(1)\n"
    )


def progress(step, value):
    print("DSWHALE_PROGRESS " + json.dumps({"step": step, "progress": value}), flush=True)


def runtime_receipt(version, python, node, ffmpeg, env):
    script = """
import importlib.metadata as metadata, json, re, subprocess, sys
def probe(command, flag, pattern):
    result = subprocess.check_output([command, flag], text=True, stderr=subprocess.DEVNULL, timeout=10)
    match = re.match(pattern, result)
    return match[1] if match else ''
print(json.dumps({
    'dswhale': metadata.version('dswhale'), 'astrbot': metadata.version('astrbot'),
    'python': '.'.join(str(p) for p in sys.version_info[:3]),
    'node': probe(sys.argv[1], '--version', r'^v(\\d+\\.\\d+\\.\\d+)'),
    'ffmpeg': probe(sys.argv[2], '-version', r'^ffmpeg version (\\d+\\.\\d+(?:\\.\\d+)?(?:[-\\w.]*)?)'),
}))
"""
    data = json.loads(output([python, "-c", script, node, ffmpeg], env=env))
    versions = {}
    for key in ("dswhale", "astrbot", "python", "node", "ffmpeg"):
        value = data.get(key, "")
        versions[key] = (
            value
            if isinstance(value, str) and re.fullmatch(r"[0-9][0-9a-zA-Z.+_-]{0,119}", value)
            else ""
        )
    channel = "alpha" if re.search(r"[ab]|rc", version) else "stable"
    expected = {
        "dswhale": version,
        "astrbot": "4.29.3",
        "python": "3.12",
        "node": "22.23.4",
        "ffmpeg": "9.0.2",
        "channel": channel,
    }
    return {
        "version": version,
        "format": 2,
        "versions": versions,
        "expected": expected,
        "channel": channel,
    }


def runtime_directory(source):
    return (
        Path(os.environ.get("DSWHALE_RUNTIME_DIR", str(Path(source) / ".runtime")))
        .expanduser()
        .resolve()
    )


def snapshot_data(host, runtime):
    """Take a restore-compatible snapshot even if the old interpreter is broken."""
    data = host / "data"
    paths = list(data.rglob("*"))
    if data.is_symlink() or any(path.is_symlink() for path in paths):
        raise ValueError("data 内存在符号链接，请先单独备份其目标")
    files = [path for path in paths if path.is_file()]
    if sum(path.stat().st_size for path in files) > 1024**3:
        raise ValueError("data 超过 1 GiB，请先手动备份")
    backups = runtime / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    archive = backups / (
        "before-upgrade-"
        + datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        + "-"
        + secrets.token_hex(16)
        + ".zip"
    )
    handle, temporary_name = tempfile.mkstemp(dir=backups, suffix=".zip")
    os.close(handle)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("manifest.json", json.dumps({"project": "DSWhale", "format": 1}))
            bundle.writestr("data/", "")
            for file in files:
                bundle.write(file, file.relative_to(host).as_posix())
        # Publish the complete, private ZIP without replacing an existing backup.
        os.link(temporary, archive)
    finally:
        temporary.unlink(missing_ok=True)
    return archive


def configure_desktop_dashboard(host):
    file = host / "data/cmd_config.json"
    config = json.loads(file.read_text(encoding="utf-8-sig"))
    config.setdefault("dashboard", {})["host"] = "127.0.0.1"
    config["disable_metrics"] = True
    temporary = file.with_suffix(".desktop.tmp")
    temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(file)


def _sync_directory(directory):
    if os.name == "nt":
        return  # Windows does not support opening a directory for fsync.
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _private_record(path, value):
    """Publish a complete, durable mode-0600 record without replacing any file."""
    descriptor, name = tempfile.mkstemp(prefix=".desktop-auth-stage-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        # link() atomically creates a new name and refuses an existing symlink/file.
        os.link(temporary, path)
        _sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _read_login_record(path, *, pending=False):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("初始登录记录必须是普通文件")
        value = json.load(stream)
    fields = {"username", "password", "format", "purpose"} if pending else {"username", "password"}
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or not all(
            isinstance(value.get(key), str) and value[key] for key in ("username", "password")
        )
        or pending
        and (value.get("format") != 1 or value.get("purpose") != "dswhale-desktop-initial-login")
    ):
        raise ValueError("初始登录记录损坏，请先检查数据目录")
    return {key: value[key] for key in ("username", "password")}


def _login_matches(config, credential):
    dashboard = config.get("dashboard", {})
    if dashboard.get("username", "astrbot") != credential["username"]:
        return False
    try:
        algorithm, iterations, salt, expected = dashboard["pbkdf2_password"].split("$")
        iterations = int(iterations)
        if algorithm != "pbkdf2_sha256" or not 100_000 <= iterations <= 5_000_000:
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256", credential["password"].encode(), bytes.fromhex(salt), iterations
        )
        return hmac.compare_digest(actual, bytes.fromhex(expected))
    except (KeyError, ValueError, TypeError):
        return False


def _complete_initial_login(host, credential, pending_file, credential_file):
    config = json.loads((host / "data/cmd_config.json").read_text(encoding="utf-8-sig"))
    if not _login_matches(config, credential):
        raise ValueError("现有登录密码与待完成的初始登录记录不匹配，未更改现有配置")
    if credential_file.exists() and _read_login_record(credential_file) != credential:
        raise ValueError("现有初始登录记录不匹配，未更改现有配置")
    configure_desktop_dashboard(host)
    if not credential_file.exists():
        _private_record(credential_file, credential)
    pending_file.unlink()
    _sync_directory(pending_file.parent)


def initialize_host_config(host, python, env, *, desktop=False):
    config_file = host / "data/cmd_config.json"
    credential_file = host.parent / "desktop-auth.json"
    pending_file = host.parent / ".desktop-auth.pending.json"
    for candidate in (host.parent, host, host / "data", config_file, credential_file, pending_file):
        if candidate.is_symlink():
            raise ValueError("初始化配置不能包含符号链接")
    # Only our durable pending marker authorizes recovery of an interrupted fresh
    # setup. A genuine existing configuration never enters SDK initialization.
    if config_file.is_file():
        if desktop and pending_file.exists():
            credential = _read_login_record(pending_file, pending=True)
            _complete_initial_login(host, credential, pending_file, credential_file)
        return
    if desktop:
        if pending_file.exists():
            credential = _read_login_record(pending_file, pending=True)
        else:
            if credential_file.exists():
                credential = _read_login_record(credential_file)
            else:
                alphabet = string.ascii_letters + string.digits
                chars = [
                    secrets.choice(string.ascii_uppercase),
                    secrets.choice(string.ascii_lowercase),
                    secrets.choice(string.digits),
                    *(secrets.choice(alphabet) for _ in range(29)),
                ]
                secrets.SystemRandom().shuffle(chars)
                credential = {"username": "astrbot", "password": "".join(chars)}
            _private_record(
                pending_file,
                {"format": 1, "purpose": "dswhale-desktop-initial-login", **credential},
            )
        env = {**env, "ASTRBOT_DASHBOARD_INITIAL_PASSWORD": credential["password"]}
    # The pending credential is durable before the SDK can persist its hash.
    run(
        [python, "-c", "from astrbot.core.config import AstrBotConfig; AstrBotConfig()"],
        cwd=host,
        env=env,
    )
    if desktop:
        _complete_initial_login(host, credential, pending_file, credential_file)


def main():
    source = Path(__file__).resolve().parents[1]
    runtime = runtime_directory(source)
    runtime.mkdir(parents=True, exist_ok=True)
    try:
        with FileLock(runtime / "setup.lock", timeout=0):
            prepare(source, runtime)
    except Timeout:
        raise SystemExit(
            "AstrBot 或另一个安装正在运行，请先停止服务再准备环境；QQ 无需退出。"
        ) from None
    except _network.NetworkError as error:
        print(
            "DSWHALE_NETWORK_ERROR " + json.dumps({"code": error.code, "source": error.source}),
            flush=True,
        )
        raise SystemExit(error.hint) from None


def prepare(source, runtime):
    host = runtime / "astrbot"
    host.mkdir(parents=True, exist_ok=True)
    uv = os.environ.get("DSWHALE_UV") or shutil.which("uv")
    if not uv:
        raise SystemExit("请从桌面应用或项目根目录的 Install 启动安装。")
    environment = runtime / "venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    env = {
        **_network.network_environment(_network.read_network_config(runtime)),
        "PYTHONUTF8": "1",
        "DSWHALE_RUNTIME_DIR": str(runtime),
        "DSWHALE_NETWORK_CONFIG": str(runtime / "network.json"),
        "ASTRBOT_ROOT": str(host),
        "UV_PYTHON_INSTALL_DIR": str(runtime / "tools/python"),
        "UV_CACHE_DIR": str(runtime / "cache/uv"),
        "UV_TOOL_DIR": str(runtime / "tools/uv-tools"),
        "UV_NO_MODIFY_PATH": "1",
    }
    # Check before changing packages, files, or the install receipt.
    lock = FileLock(host / "astrbot.lock", timeout=0)
    lock.acquire()
    try:
        if (host / "data").exists():
            progress("backup", 0.16)
            snapshot_data(host, runtime)
        (runtime / "desktop-install.json").unlink(missing_ok=True)
        progress("python", 0.2)
        compatible = False
        if python.exists():
            try:
                compatible = bool(
                    re.fullmatch(r"Python 3\.12\.\d+", output([python, "--version"]).strip())
                )
            except (OSError, subprocess.SubprocessError):
                pass
        if not compatible:
            run([uv, "venv", "--python", "3.12", "--clear", environment], env=env)
        progress("dependencies", 0.28)
        # Setuptools builds may write egg-info/build; installed app resources are read-only.
        cache = runtime / "cache"
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="backend-build-", dir=cache) as directory:
            build_source = Path(directory) / "source"
            shutil.copytree(
                source,
                build_source,
                ignore=shutil.ignore_patterns(
                    ".runtime",
                    ".private",
                    ".git",
                    ".superpowers",
                    "node_modules",
                    "__pycache__",
                    ".pytest_cache",
                    ".ruff_cache",
                    "desktop-dist",
                    "desktop-resources",
                    "build",
                    "dist",
                    "*.egg-info",
                    ".venv",
                ),
            )
            run([uv, "pip", "install", "--python", python, str(build_source) + "[host]"], env=env)
        progress("node", 0.52)
        node = (
            output(
                [
                    python,
                    "-c",
                    network_command(
                        "from pathlib import Path; from dswhale.runtime import ensure_node; import sys; print(ensure_node(Path(sys.argv[1])))"
                    ),
                    runtime,
                ],
                cwd=host,
                env=env,
            )
            .strip()
            .splitlines()[-1]
        )
        progress("media", 0.66)
        media = json.loads(
            output(
                [
                    python,
                    "-c",
                    network_command(
                        "from pathlib import Path; from dswhale.media_runtime import ensure_media; import sys,json; print(json.dumps({k:str(v) for k,v in ensure_media(Path(sys.argv[1])).items()}))"
                    ),
                    runtime,
                ],
                cwd=host,
                env=env,
            )
            .strip()
            .splitlines()[-1]
        )
        settings = {"node": node, "ffmpeg": media["ffmpeg"], "ffprobe": media["ffprobe"]}
        temporary = runtime / "tool-env.json.tmp"
        temporary.write_text(json.dumps(settings, ensure_ascii=False), encoding="utf-8")
        temporary.replace(runtime / "tool-env.json")
        env.update(
            {
                "DSWHALE_NODE": node,
                "PATH": os.pathsep.join(
                    [
                        *dict.fromkeys(str(Path(value).parent) for value in settings.values()),
                        env.get("PATH", ""),
                    ]
                ),
            }
        )
        if not (host / "data/cmd_config.json").is_file():
            progress("initialize", 0.76)
            lock.release()
            run([python, "-m", "astrbot.cli", "init", "--yes"], cwd=host, env=env)
            lock.acquire()
        # Run desktop recovery even when an interrupted SDK init already wrote
        # cmd_config.json. Legacy launchers defer SDK password creation to Start.
        if os.environ.get("DSWHALE_DESKTOP") == "1":
            initialize_host_config(host, python, env, desktop=True)
        progress("plugins", 0.82)
        lock.release()
        run(
            [
                python,
                "-m",
                "dswhale",
                "install",
                "--astrbot-dir",
                host,
                "--with-memory",
                "--node",
                node,
            ],
            cwd=host,
            env=env,
        )
        lock.acquire()
        run(
            [
                uv,
                "pip",
                "install",
                "--python",
                python,
                "-r",
                host / "data/plugins/astrbot_plugin_livingmemory/requirements.txt",
            ],
            env=env,
        )
        project = (source / "pyproject.toml").read_text(encoding="utf-8")
        version = re.search(r'^version\s*=\s*"([^"]+)"', project, re.MULTILINE)[1]
        receipt = runtime / "desktop-install.json.tmp"
        receipt.write_text(
            json.dumps(runtime_receipt(version, python, node, media["ffmpeg"], env)),
            encoding="utf-8",
        )
        receipt.replace(runtime / "desktop-install.json")
        progress("complete", 0.99)
    finally:
        lock.release()
    print("环境准备完成。请从桌面应用或项目根目录 Start 启动。")
    print("QQ 登录、模型密钥和 B站扫码需要本人操作，请按设置说明配置。")


if __name__ == "__main__":
    main()
