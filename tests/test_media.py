import asyncio
import json
import shutil
import sys

import pytest

from dswhale.config import Settings
from dswhale.media import MediaError, MediaReader, parse_subtitles
from dswhale.process import ProcessError, run_process


async def test_process_output_and_timeout():
    assert (
        await run_process([sys.executable, "-c", "print('hello')"], timeout=5)
    ).strip() == "hello"
    with pytest.raises(ProcessError, match="超时"):
        await run_process([sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.1)


async def test_cancel_kills_process(tmp_path):
    marker = tmp_path / "should-not-exist"
    task = asyncio.create_task(
        run_process(
            [
                sys.executable,
                "-c",
                "import time,pathlib;time.sleep(1);pathlib.Path(" + repr(str(marker)) + ").touch()",
            ],
            timeout=5,
        )
    )
    await asyncio.sleep(0.15)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(1)
    assert not marker.exists()


async def test_process_limits_output_and_disk(tmp_path):
    with pytest.raises(ProcessError, match="输出"):
        await run_process([sys.executable, "-c", "print('x'*100000)"], timeout=5, output_limit=1000)
    with pytest.raises(ProcessError, match="空间"):
        await run_process(
            [
                sys.executable,
                "-c",
                "import pathlib,time;pathlib.Path('big').write_bytes(b'x'*20000);time.sleep(1)",
            ],
            timeout=5,
            cwd=tmp_path,
            disk_limit=1000,
        )


def test_subtitle_formats(tmp_path):
    path = tmp_path / "a.json3"
    path.write_text(
        json.dumps(
            {
                "events": [
                    {"segs": [{"utf8": "你好"}, {"utf8": "世界"}]},
                    {"segs": [{"utf8": "你好世界"}]},
                ]
            }
        )
    )
    assert parse_subtitles(path) == "你好世界"
    path = tmp_path / "a.vtt"
    path.write_text(
        "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<b>hello</b>\n\n00:00:02.000 --> 00:00:03.000\nworld\n"
    )
    assert parse_subtitles(path) == "hello\nworld"


async def test_unknown_and_oversized_duration_rejected_before_download():
    reader = MediaReader(Settings())
    for data in (
        {},
        {"duration": 301},
        {"duration": 10, "is_live": True},
        {"duration": 10, "filesize": 100 * 1024 * 1024},
    ):
        with pytest.raises(MediaError):
            reader.validate_metadata(data)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
async def test_real_frame_audio_extraction_and_cleanup(tmp_path):
    source = tmp_path / "sample.mp4"
    await run_process(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=160x120:d=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-c:v",
            "mpeg4",
            "-c:a",
            "aac",
            "-shortest",
            str(source),
        ],
        timeout=15,
    )
    reader = MediaReader(Settings(frame_count=2))
    async with reader.inspect_local(
        source, title="测试", source_url="https://www.bilibili.com/video/BV1xx411c7mD"
    ) as evidence:
        assert len(evidence.frames) == 2
        assert evidence.audio.is_file()
        assert evidence.duration == pytest.approx(2, abs=0.1)
        directory = evidence.frames[0].parent
        from PIL import Image

        with Image.open(evidence.frames[0]) as picture:
            r, g, b = picture.getpixel((20, 20))
            assert b > 200 and r < 20
    assert not directory.exists()
    assert source.exists()


async def test_bilibili_srt_reaches_evidence_in_download_pipeline(monkeypatch):
    import dswhale.media as media_module
    from dswhale.media import Evidence

    reader = MediaReader(Settings())

    async def process(args, **kwargs):
        if "--dump-single-json" in args:
            return json.dumps({"title": "Bili SRT", "duration": 10})
        root = kwargs["cwd"]
        (root / "media.mp4").write_bytes(b"fixture")
        (root / "media.zh-Hans.srt").write_text(
            "1\n00:00:00,000 --> 00:00:02,000\n你好，海獭\n", encoding="utf-8"
        )
        return ""

    async def extract(source, root, *, title, source_url, subtitles):
        return Evidence(title, source_url, 10, (), None, subtitles)

    monkeypatch.setattr(media_module, "run_process", process)
    reader._extract = extract
    async with reader.read("https://www.bilibili.com/video/BV1xx411c7mD") as evidence:
        assert evidence.subtitles == "你好，海獭"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process group contract")
async def test_successful_parent_does_not_leave_detached_helper(tmp_path):
    import os
    import signal

    pidfile = tmp_path / "helper.pid"
    program = "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); open(sys.argv[1],'w').write(str(p.pid))"
    await run_process([sys.executable, "-c", program, str(pidfile)], timeout=5)
    pid = int(pidfile.read_text())
    try:
        await asyncio.sleep(0.1)
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Job Object kernel contract")
async def test_windows_wrapper_exit_kills_orphaned_descendant(tmp_path):
    import ctypes
    from ctypes import wintypes

    pidfile = tmp_path / "helper.pid"
    program = "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); open(sys.argv[1],'w').write(str(p.pid))"
    await run_process([sys.executable, "-c", program, str(pidfile)], timeout=5)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x00100000, False, int(pidfile.read_text()))
    if handle:
        try:
            assert kernel.WaitForSingleObject(handle, 2000) == 0
        finally:
            kernel.CloseHandle(handle)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")
async def test_timeout_does_not_signal_an_already_killed_group_twice(monkeypatch):
    import os

    import dswhale.process as process_tools

    original = os.killpg
    signalled = set()

    def kill_once(pid, sig):
        if pid in signalled:
            # Darwin can report EPERM for a group already killed but not reaped.
            raise PermissionError("group has already exited")
        signalled.add(pid)
        return original(pid, sig)

    monkeypatch.setattr(process_tools.os, "killpg", kill_once)
    with pytest.raises(ProcessError, match="超时"):
        await run_process([sys.executable, "-c", "import time;time.sleep(30)"], timeout=0.1)
