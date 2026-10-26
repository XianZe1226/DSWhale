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
