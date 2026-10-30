"""Project-local Node runtime; verified downloads without modifying system HOME."""

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath

import httpx
from filelock import FileLock

NODE_VERSION = "22.23.4"
NODE_HASHES = {
    "darwin-arm64.tar.gz": "c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428",
    "darwin-x64.tar.gz": "efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819",
    "win-x64.zip": "cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20",
    "linux-arm64.tar.gz": "f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9",
    "linux-x64.tar.gz": "b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406",
}


def select_node_asset(system=None, machine=None):
    system, machine = system or platform.system(), (machine or platform.machine()).lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine)
    os_name = {"Windows": "win", "Darwin": "darwin", "Linux": "linux"}.get(system)
    suffix = f"{os_name}-{arch}." + ("zip" if system == "Windows" else "tar.gz")
    if suffix not in NODE_HASHES:
        raise ValueError("暂支持 Windows 10/11 x64、macOS Intel/Apple Silicon 和 Linux x64/arm64")
    return f"node-v{NODE_VERSION}-{suffix}"


def validate_members(names):
    roots = set()
    for name in names:
        path = PurePosixPath(name)
        if (
            not path.parts
            or path.is_absolute()
            or ".." in path.parts
            or "\\" in name
            or ":" in name
        ):
            raise ValueError("运行库压缩包包含不安全路径")
        roots.add(path.parts[0])
    if len(roots) != 1:
        raise ValueError("运行库压缩包必须只有一个顶层目录")
    return roots.pop()


def npm_cli(node):
    node = Path(node).resolve()
    candidates = [
        node.parent / "node_modules/npm/bin/npm-cli.js",
        node.parent.parent / "lib/node_modules/npm/bin/npm-cli.js",
    ]
    npm = shutil.which("npm")
    if npm and Path(npm).resolve().name == "npm-cli.js":
        candidates.append(Path(npm).resolve())
    for file in candidates:
        if file.is_file():
            return file
    raise RuntimeError("Node.js 缺少 npm，请重新运行安装器")


def usable_node(node):
    try:
        version = subprocess.check_output([str(node), "--version"], timeout=10, text=True).strip()
        npm_cli(node)
        match = re.fullmatch(r"v(22)\.(\d+)\.(\d+)", version)
        return bool(
            match and tuple(map(int, match.groups())) >= tuple(map(int, NODE_VERSION.split(".")))
        )
    except (OSError, subprocess.SubprocessError, RuntimeError):
        return False


def ensure_node(runtime, *, reuse=True):
    tools = Path(runtime) / "tools"
    tools.mkdir(parents=True, exist_ok=True)
    with FileLock(tools / "node-install.lock", timeout=0):
        return _ensure_node(runtime, reuse=reuse)


def _ensure_node(runtime, *, reuse=True):
    system_node = shutil.which("node") if reuse else None
    if system_node and usable_node(system_node):
        return Path(system_node).resolve()
    asset = select_node_asset()
    tools = Path(runtime) / "tools"
    target = tools / f"node-v{NODE_VERSION}"
    relative = "node.exe" if os.name == "nt" else "bin/node"
    if usable_node(target / relative):
        return target / relative
    tools.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="node-stage-", dir=tools) as stage_name:
        stage = Path(stage_name)
        archive = stage / asset
        digest, count = hashlib.sha256(), 0
        with httpx.stream(
            "GET",
            f"https://nodejs.org/dist/v{NODE_VERSION}/{asset}",
            timeout=90,
            follow_redirects=True,
        ) as response:
            response.raise_for_status()
            with archive.open("wb") as output:
                for chunk in response.iter_bytes():
                    count += len(chunk)
                    if count > 300 * 1024**2:
                        raise ValueError("运行库下载超过预期大小")
                    digest.update(chunk)
                    output.write(chunk)
        expected = NODE_HASHES[asset.removeprefix(f"node-v{NODE_VERSION}-")]
        if digest.hexdigest() != expected:
            raise ValueError("Node.js 校验失败，未安装")
        unpacked = stage / "unpacked"
        if asset.endswith(".zip"):
            with zipfile.ZipFile(archive) as bundle:
                top = validate_members(bundle.namelist())
                if sum(m.file_size for m in bundle.infolist()) > 1024**3:
                    raise ValueError("运行库解压大小超过限制")
                bundle.extractall(unpacked)
        else:
            with tarfile.open(archive) as bundle:
                members = bundle.getmembers()
                top = validate_members(m.name for m in members)
                if sum(m.size for m in members) > 1024**3:
                    raise ValueError("运行库解压大小超过限制")
                bundle.extractall(unpacked, filter="data")
        if not usable_node(unpacked / top / relative):
            raise RuntimeError("下载的 Node.js 无法运行")
        if target.is_symlink():
            raise ValueError("运行库目标不能是符号链接")
        previous = tools / f".node-previous-{uuid.uuid4().hex}"
        if target.exists():
            target.rename(previous)
        try:
            (unpacked / top).rename(target)
        except BaseException:
            if previous.exists():
                previous.rename(target)
            raise
        if previous.exists():
            shutil.rmtree(previous)
    return target / relative


def prepare_bridge(bridge, node):
    subprocess.run(
        [
            str(node),
            str(npm_cli(node)),
            "ci",
            "--ignore-scripts",
            "--no-bin-links",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
        ],
        cwd=bridge,
        env={
            **os.environ,
            "PATH": str(Path(node).parent) + os.pathsep + os.environ.get("PATH", ""),
        },
        check=True,
        timeout=300,
    )


def launch_environment(runtime):
    runtime = Path(runtime).resolve()
    file = runtime / "tool-env.json"
    saved = json.loads(file.read_text(encoding="utf-8")) if file.exists() else {}
    tools = {}
    for key in ("node", "ffmpeg", "ffprobe"):
        if key in saved:
            value = saved[key]
            if not isinstance(value, str) or not Path(value).is_absolute() or "\0" in value:
                raise ValueError("环境记录损坏，请重新运行安装器")
            tools[key] = value
    common = []
    if platform.system() == "Darwin":
        common = ["/opt/homebrew/bin", "/usr/local/bin"]
    elif platform.system() == "Windows" and os.environ.get("LOCALAPPDATA"):
        common = [str(Path(os.environ["LOCALAPPDATA"]) / "Microsoft/WinGet/Links")]
    directories = list(
        dict.fromkeys(
            filter(
                None,
                [
                    *(str(Path(p).parent) for p in tools.values()),
                    *common,
                    *os.environ.get("PATH", "").split(os.pathsep),
                ],
            )
        )
    )
    return {
        **os.environ,
        "PYTHONUTF8": "1",
        "PATH": os.pathsep.join(directories),
        "ASTRBOT_ROOT": str(runtime / "astrbot"),
        "DSWHALE_RUNTIME_DIR": str(runtime),
        **({"DSWHALE_NODE": saved["node"]} if saved.get("node") else {}),
    }
