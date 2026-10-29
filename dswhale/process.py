"""Bound subprocess duration, output, disk usage and cancellation."""

import asyncio
import os
import signal
import subprocess
import sys
from pathlib import Path


class ProcessError(RuntimeError):
    pass


def owned_command(args):
    if os.name == "nt":
        return [sys.executable, str(Path(__file__).with_name("winjob.py")), *args]
    return args


async def run_process(
    args: list[str],
    *,
    timeout: float,  # noqa: ASYNC109 - bounded subprocess API, tested on cancellation
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    output_limit: int = 4 * 1024 * 1024,
    disk_limit: int | None = None,
) -> str:
    options = (
        {"start_new_session": True}
        if os.name != "nt"
        else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    )
    try:
        process = await asyncio.create_subprocess_exec(
            *owned_command(args),
            cwd=cwd,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **options,
        )
    except FileNotFoundError as error:
        raise ProcessError("缺少运行依赖，请先运行 dswhale doctor") from error
    output = bytearray()
    total = 0

    async def drain(stream, keep):
        nonlocal total
        while chunk := await stream.read(16384):
            total += len(chunk)
            if total > output_limit:
                raise ProcessError("工具输出超过限制")
            if keep:
                output.extend(chunk)

    async def monitor():
        while process.returncode is None:
            if cwd and disk_limit is not None:
                size = await asyncio.to_thread(
                    lambda: sum(p.stat().st_size for p in cwd.rglob("*") if p.is_file())
                )
                if size > disk_limit:
                    raise ProcessError("媒体占用空间超过限制")
            await asyncio.sleep(0.05)

    tasks = [
        asyncio.create_task(drain(process.stdout, True)),
        asyncio.create_task(drain(process.stderr, False)),
        asyncio.create_task(process.wait()),
        asyncio.create_task(monitor()),
    ]
    try:
        async with asyncio.timeout(timeout):
            await asyncio.gather(*tasks)
        if process.returncode:
            # Raw downloader output can contain cookies, signed URLs and private paths.
            raise ProcessError("媒体工具未能完成；可能需要登录、链接失效或格式不支持")
        return output.decode("utf-8", errors="replace")
    except TimeoutError as error:
        raise ProcessError("媒体处理超时") from error
    finally:
        # Children may outlive an already-exited wrapper (e.g. a timed-out Node CLI).
        # Every invocation owns its POSIX session, so this never targets the host.
        if os.name != "nt":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process.returncode is None:
            if os.name == "nt":
                killer = await asyncio.create_subprocess_exec(
                    "taskkill",
                    "/PID",
                    str(process.pid),
                    "/T",
                    "/F",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await killer.wait()
            # POSIX groups were signalled above, including when the wrapper
            # already exited. Repeating killpg before reaping races on Darwin.
            await process.wait()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
