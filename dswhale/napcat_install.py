"""Extract the pinned independent component privately; never execute QQ or NapCat."""

import argparse
import hashlib
import json
import re
import tempfile
from pathlib import Path, PurePosixPath

from .install import InstallError, extract_archive


def _safe_path(path):
    path = Path(path).absolute()
    for item in [path, *path.parents]:
        if item.is_symlink() or (item.is_file() and item.stat().st_nlink > 1):
            raise ValueError("独立组件目录包含不安全链接")
    return path


def install_archive(archive: Path, private_root: Path, metadata: dict) -> Path:
    """Verify the ZIP and every shipped program file before the final rename."""
    archive = _safe_path(archive)
    private_root = _safe_path(private_root)
    version = metadata.get("version", "")
    expected = metadata.get("files", {})
    digest = metadata.get("asset", {}).get("sha256", "")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("独立组件发布信息无效")
    if not isinstance(expected, dict) or not expected or len(expected) > 20000:
        raise ValueError("独立组件文件清单无效")
    for name, checksum in expected.items():
        path = PurePosixPath(name)
        if (
            path.is_absolute()
            or ".." in path.parts
            or "\\" in name
            or not re.fullmatch(r"[a-f0-9]{64}", checksum)
        ):
            raise ValueError("独立组件文件清单无效")
    destination = private_root / f"package-{version}"
    _safe_path(destination)
    if destination.exists():
        raise ValueError("独立组件目标已存在，请选择现有组件；不会覆盖已有文件")
    private_root.mkdir(parents=True, mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".napcat-stage-", dir=private_root) as temporary:
        staged = Path(temporary) / "package"
        try:
            extract_archive(archive, staged, sha256=digest)
        except (InstallError, OSError, ValueError) as error:
            raise ValueError("独立组件压缩包校验失败或路径不安全") from error
        for file in staged.rglob("*"):
            if not file.is_file():
                continue
            name = file.relative_to(staged).as_posix()
            if name not in expected and not (
                name.startswith("napcat/config/")
                and (file.suffix == ".json" or file.name == ".env")
            ):
                raise ValueError("独立组件包含未审定文件")
        for name, checksum in expected.items():
            file = staged / name
            if not file.is_file():
                raise ValueError("独立组件缺少官方文件")
            with file.open("rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != checksum:
                raise ValueError("独立组件官方文件校验失败")
        _safe_path(private_root)
        if destination.exists():
            raise ValueError("独立组件目标已存在")
        staged.rename(destination)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--private-root", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()
    try:
        metadata_file = _safe_path(args.metadata)
        if metadata_file.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("独立组件发布信息过大")
        metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
        install_archive(args.archive, args.private_root, metadata)
        print(json.dumps({"installed": True, "version": metadata["version"]}))
        return 0
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"error": "独立组件校验或安装失败；原有文件未被替换"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
