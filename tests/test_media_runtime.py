import hashlib
import io
import os
import stat
import zipfile

import pytest

try:
    from dswhale import media_runtime
except ImportError:
    media_runtime = None


def archive_bytes(members):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle:
        for name, content in members.items():
            info = zipfile.ZipInfo(name)
            # Keep hostile raw ZIP names even on Windows, where ZipInfo's
            # constructor otherwise normalizes backslashes before writing.
            info.filename = name
            bundle.writestr(info, content)
    return output.getvalue()


def test_portable_media_selects_only_supported_desktop_targets():
    assert media_runtime is not None
    assert media_runtime.select_media_assets("Darwin", "arm64")["ffmpeg"]["url"].startswith(
        "https://"
    )
    assert media_runtime.select_media_assets("Windows", "AMD64")["ffprobe"]["url"].endswith(".zip")
    for system, machine in [("Darwin", "x86_64"), ("Linux", "aarch64"), ("Windows", "x86")]:
        with pytest.raises(ValueError):
            media_runtime.select_media_assets(system, machine)


def test_extracts_only_safe_regular_executable_with_verified_checksum(tmp_path):
    assert media_runtime is not None
    archive = tmp_path / "media.zip"
    content = archive_bytes({"root/bin/ffmpeg": b"binary", "root/LICENSE": b"license"})
    archive.write_bytes(content)
    output = tmp_path / "ffmpeg"
    media_runtime.extract_media_archive(
        archive, output, "ffmpeg", hashlib.sha256(content).hexdigest()
    )
    assert output.read_bytes() == b"binary"
    if os.name != "nt":
        assert output.stat().st_mode & stat.S_IXUSR
    with pytest.raises(ValueError, match="校验"):
        media_runtime.extract_media_archive(archive, tmp_path / "wrong", "ffmpeg", "0" * 64)
    assert not (tmp_path / "wrong").exists()


@pytest.mark.parametrize(
    "name", ["../escape", "/absolute", "C:/escape", r"root\escape", "root/CON"]
)
def test_rejects_hostile_archive_paths_before_writing(tmp_path, name):
    assert media_runtime is not None
    content = archive_bytes({"bin/ffmpeg": b"good", name: b"bad"})
    file = tmp_path / "hostile.zip"
    file.write_bytes(content)
    with pytest.raises(ValueError, match="路径"):
        media_runtime.extract_media_archive(
            file, tmp_path / "binary", "ffmpeg", hashlib.sha256(content).hexdigest()
        )
    assert not (tmp_path / "binary").exists()


def test_rejects_archive_symlinks_and_expansion_limit(tmp_path, monkeypatch):
    assert media_runtime is not None
    file = tmp_path / "symlink.zip"
    with zipfile.ZipFile(file, "w") as bundle:
        info = zipfile.ZipInfo("ffmpeg")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        bundle.writestr(info, "/outside")
    with pytest.raises(ValueError):
        media_runtime.extract_media_archive(
            file, tmp_path / "binary", "ffmpeg", hashlib.sha256(file.read_bytes()).hexdigest()
        )
    content = archive_bytes({"ffmpeg": b"1234"})
    file.write_bytes(content)
    monkeypatch.setattr(media_runtime, "UNPACKED_LIMIT", 3)
    with pytest.raises(ValueError, match="大小"):
        media_runtime.extract_media_archive(
            file, tmp_path / "binary", "ffmpeg", hashlib.sha256(content).hexdigest()
        )


def test_raw_zip_name_is_checked_before_windows_normalization(tmp_path, monkeypatch):
    content = archive_bytes({"bin/ffmpeg": b"good", r"root\escape": b"bad"})
    file = tmp_path / "windows-normalized.zip"
    file.write_bytes(content)
    original = zipfile.ZipFile.infolist

    def normalized(bundle):
        infos = original(bundle)
        for info in infos:
            info.filename = info.filename.replace("\\", "/")
        return infos

    monkeypatch.setattr(zipfile.ZipFile, "infolist", normalized)
    with pytest.raises(ValueError, match="路径"):
        media_runtime.extract_media_archive(
            file, tmp_path / "binary", "ffmpeg", hashlib.sha256(content).hexdigest()
        )
    assert not (tmp_path / "binary").exists()


def test_media_requires_both_ffmpeg_and_ffprobe_compatible_versions(tmp_path):
    assert media_runtime is not None
    if os.name == "nt":
        pytest.skip("POSIX fixture executable")
    executable = tmp_path / "ffmpeg"
    executable.write_text('#!/bin/sh\nprintf "ffmpeg version 6.1.1 Copyright\\n"\n')
    executable.chmod(0o755)
    assert media_runtime.usable_media(executable, "ffmpeg")
    executable.write_text('#!/bin/sh\nprintf "ffmpeg version 5.1 Copyright\\n"\n')
    assert not media_runtime.usable_media(executable, "ffmpeg")
    executable.write_text('#!/bin/sh\nprintf "ffmpeg version N-1000 Copyright\\n"\n')
    assert not media_runtime.usable_media(executable, "ffmpeg")


def test_managed_media_repairs_only_private_tools_and_reuses_on_repeat(tmp_path, monkeypatch):
    assert media_runtime is not None
    if os.name == "nt":
        pytest.skip("POSIX fixture executables")
    runtime = tmp_path / "external-runtime"
    data = runtime / "astrbot/data"
    data.mkdir(parents=True)
    (data / "memory.db").write_bytes(b"keep me")
    target = runtime / "tools/ffmpeg-9.0.2"
    target.mkdir(parents=True)
    (target / "ffmpeg").write_bytes(b"broken")
    downloads = []
    content = archive_bytes(
        {
            tool: f'#!/bin/sh\nprintf "{tool} version 9.0.2 Copyright\\n"\n'.encode()
            for tool in ["ffmpeg", "ffprobe"]
        }
    )
    manifest = {
        tool: {
            "url": "https://vendor.test/media.zip",
            "sha256": hashlib.sha256(content).hexdigest(),
        }
        for tool in ["ffmpeg", "ffprobe"]
    }
    monkeypatch.setattr(media_runtime, "select_media_assets", lambda *args: manifest)

    def download(asset, file):
        downloads.append(asset["url"])
        file.write_bytes(content)

    monkeypatch.setattr(media_runtime, "download_asset", download)
    first = media_runtime.ensure_media(runtime, reuse=False)
    assert first == {"ffmpeg": target / "ffmpeg", "ffprobe": target / "ffprobe"}
    assert media_runtime.ensure_media(runtime, reuse=False) == first
    assert len(downloads) == 1
    assert (data / "memory.db").read_bytes() == b"keep me"


def test_download_rejects_checksum_oversize_and_http(tmp_path, monkeypatch):
    assert media_runtime is not None

    class Response:
        headers = {}
        url = "https://vendor.test/media.zip"

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def raise_for_status(self):
            pass

        def iter_bytes(self):
            yield b"abc"

    monkeypatch.setattr(media_runtime.httpx, "stream", lambda *args, **kwargs: Response())
    file = tmp_path / "download.zip"
    with pytest.raises(ValueError, match="HTTPS"):
        media_runtime.download_asset(
            {"url": "http://vendor.test/media.zip", "sha256": "0" * 64}, file
        )
    with pytest.raises(ValueError, match="校验"):
        media_runtime.download_asset({"url": Response.url, "sha256": "0" * 64}, file)
    assert not file.exists()
    monkeypatch.setattr(media_runtime, "DOWNLOAD_LIMIT", 2)
    with pytest.raises(ValueError, match="大小"):
        media_runtime.download_asset(
            {"url": Response.url, "sha256": hashlib.sha256(b"abc").hexdigest()}, file
        )
    assert not file.exists()
