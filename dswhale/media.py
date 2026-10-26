"""Temporary, bounded video evidence. Downloaded content is never executable input."""

import asyncio
import html
import json
import math
import re
import shutil
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

from .config import Settings
from .content import canonical_url
from .process import ProcessError, run_process


class MediaError(RuntimeError):
    pass


def parse_subtitles(path: Path) -> str:
    if path.stat().st_size > 2 * 1024 * 1024:
        raise MediaError("字幕文件超过限制")
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    if path.suffix == ".json3":
        data = json.loads(text)
        lines = [
            "".join(str(s.get("utf8", "")) for s in e.get("segs", []) if isinstance(s, dict))
            for e in data.get("events", [])
            if isinstance(e, dict)
        ]
    else:
        lines = [
            re.sub(r"<[^>]*>", "", line.strip())
            for line in text.splitlines()
            if line.strip()
            and "-->" not in line
            and not line.startswith(("WEBVTT", "NOTE", "Kind:", "Language:"))
            and not line.strip().isdigit()
        ]
    unique = list(dict.fromkeys(html.unescape(line).strip() for line in lines if line.strip()))
    return "\n".join(unique)[:16000]


@dataclass(frozen=True)
class Evidence:
    title: str
    source_url: str
    duration: float
    frames: tuple[Path, ...]
    audio: Path | None
    subtitles: str


class MediaReader:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.lock = asyncio.Lock()

    def validate_metadata(self, data: dict) -> float:
        duration = data.get("duration")
        if (
            isinstance(duration, bool)
            or not isinstance(duration, (int, float))
            or not math.isfinite(duration)
            or duration <= 0
            or duration > self.settings.max_video_seconds
        ):
            raise MediaError(f"视频时长未知或超过 {self.settings.max_video_seconds} 秒")
        if data.get("is_live") or data.get("live_status") in {
            "is_live",
            "is_upcoming",
            "post_live",
        }:
            raise MediaError("暂不支持直播")
        size = data.get("filesize") or data.get("filesize_approx") or 0
        if not isinstance(size, (int, float)) or size > self.settings.max_media_mb * 1024**2:
            raise MediaError("视频文件超过大小限制")
        return float(duration)

    def downloader_args(self) -> list[str]:
        args = [
            sys.executable,
            "-m",
            "yt_dlp",
            "--ignore-config",
            "--no-playlist",
            "--no-progress",
            "--no-warnings",
            "--socket-timeout",
            "15",
            "--retries",
            "1",
            "--extractor-retries",
            "1",
            "--use-extractors",
            "BiliBili,Douyin",
            "--format",
            "bv*[height<=480]+ba/b[height<=480]/worst",
        ]
        if self.settings.cookies_path:
            path = Path(self.settings.cookies_path).expanduser().resolve()
            if not path.is_file():
                raise MediaError("配置的 cookies 文件不存在")
            args += ["--cookies", str(path)]
        return args

    @asynccontextmanager
    async def read(self, url: str):
        url = canonical_url(url)
        if not self.settings.video_enabled:
            raise MediaError("视频读取未启用")
        try:
            async with asyncio.timeout(self.settings.media_timeout_seconds):
                async with self.lock:
                    with TemporaryDirectory(prefix="dswhale-") as folder:
                        root = Path(folder)
                        # yt-dlp may refresh the cookie jar; use a private copy.
                        args = self.downloader_args()
                        if "--cookies" in args:
                            index = args.index("--cookies") + 1
                            copied = root / "cookies.txt"
                            shutil.copyfile(args[index], copied)
                            args[index] = str(copied)
                        raw = await run_process(
                            args + ["--skip-download", "--dump-single-json", "--", url],
                            timeout=40,
                            cwd=root,
                        )
                        metadata = json.loads(raw)
                        if not isinstance(metadata, dict):
                            raise MediaError("无法读取视频信息")
                        self.validate_metadata(metadata)
                        await run_process(
                            args
                            + [
                                "--max-filesize",
                                f"{self.settings.max_media_mb}M",
                                "--write-subs",
                                "--write-auto-subs",
                                "--sub-langs",
                                "zh.*,en.*",
                                "--sub-format",
                                "json3/vtt/srt",
                                "--merge-output-format",
                                "mp4",
                                "--output",
                                "media.%(ext)s",
                                "--",
                                url,
                            ],
                            timeout=self.settings.media_timeout_seconds,
                            cwd=root,
                            disk_limit=self.settings.max_media_mb * 1024**2,
                        )
                        sources = [
                            p
                            for p in await asyncio.to_thread(lambda: list(root.glob("media.*")))
                            if p.suffix in {".mp4", ".webm", ".mkv", ".flv"}
                        ]
                        if len(sources) != 1:
                            raise MediaError("没有得到可读取的视频文件（可能超过大小限制）")
                        subtitle_files = await asyncio.to_thread(
                            lambda: (
                                sorted(root.glob("*.json3"))
                                + sorted(root.glob("*.vtt"))
                                + sorted(root.glob("*.srt"))
                            )
                        )
                        subtitles = parse_subtitles(subtitle_files[0]) if subtitle_files else ""
                        evidence = await self._extract(
                            sources[0],
                            root,
                            title=str(metadata.get("title", "未命名视频"))[:300],
                            source_url=url,
                            subtitles=subtitles,
                        )
                        yield evidence
        except (TimeoutError, ProcessError, ValueError, OSError) as error:
            if isinstance(error, TimeoutError):
                raise MediaError("视频读取超时，已停止处理") from error
            raise MediaError("视频读取失败：请检查 ffmpeg、登录状态和视频是否可访问") from error

    @asynccontextmanager
    async def inspect_local(self, source: Path, *, title: str, source_url: str):
        """Offline extraction path for integration checks; does not delete the input."""
        async with asyncio.timeout(self.settings.media_timeout_seconds):
            with TemporaryDirectory(prefix="dswhale-") as folder:
                yield await self._extract(source, Path(folder), title=title, source_url=source_url)

    async def _extract(
        self, source: Path, root: Path, *, title: str, source_url: str, subtitles: str = ""
    ) -> Evidence:
        if (await asyncio.to_thread(source.stat)).st_size > self.settings.max_media_mb * 1024**2:
            raise MediaError("下载的视频超过大小限制")
        raw = await run_process(
            ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(source)],
            timeout=15,
        )
        info = json.loads(raw)
        duration = self.validate_metadata(
            {"duration": float(info.get("format", {}).get("duration", 0))}
        )
        frames = []
        for index in range(self.settings.frame_count):
            target = root / f"frame-{index}.jpg"
            offset = duration * (index + 0.5) / self.settings.frame_count
            await run_process(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-nostdin",
                    "-ss",
                    str(offset),
                    "-i",
                    str(source),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=640:-2",
                    "-threads",
                    "1",
                    str(target),
                ],
                timeout=20,
            )
            if target.is_file():
                frames.append(target)
        if not frames:
            raise MediaError("视频中没有可读取的画面")
        audio = None
        if not subtitles and any(s.get("codec_type") == "audio" for s in info.get("streams", [])):
            audio = root / "audio.wav"
            await run_process(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-nostdin",
                    "-i",
                    str(source),
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-t",
                    str(self.settings.max_video_seconds),
                    str(audio),
                ],
                timeout=30,
            )
        return Evidence(title, source_url, duration, tuple(frames), audio, subtitles)
