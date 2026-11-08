"""Run user supplied regex work in a disposable child process.

The plugin process only ever executes pure string operations. Anything that
compiles or matches a user pattern goes through this module: a fresh Python
child, a hard 0.75 s deadline that includes spawn time, and an unconditional
kill + reap on timeout or cancellation. At most four workers run at once.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from weakref import WeakKeyDictionary

DEFAULT_TIMEOUT = 0.75
MAX_CONCURRENCY = 4
_PACKAGE_ROOT = Path(__file__).resolve().parent.parent
_WORKER = Path(__file__).resolve().with_name("reply_style_worker.py")
_active = 0
_semaphores: WeakKeyDictionary = WeakKeyDictionary()


def active_workers():
    return _active


def _semaphore():
    loop = asyncio.get_running_loop()
    value = _semaphores.get(loop)
    if value is None:
        value = asyncio.Semaphore(MAX_CONCURRENCY)
        _semaphores[loop] = value
    return value


def _environment():
    env = dict(os.environ)
    existing = env.get("PYTHONPATH", "")
    roots = [str(_PACKAGE_ROOT)]
    if existing:
        roots.append(existing)
    env["PYTHONPATH"] = os.pathsep.join(roots)
    env["PYTHONIOENCODING"] = "utf-8"
    env["DSWHALE_REPLY_STYLE_WORKER"] = "1"
    env.pop("PYTHONSTARTUP", None)
    return env


async def _kill(process):
    try:
        process.kill()
    except (ProcessLookupError, OSError):
        pass
    try:
        await asyncio.wait_for(process.wait(), 1.0)
    except (TimeoutError, ProcessLookupError, OSError):
        pass


async def _communicate(process, payload, limit):
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(payload), limit)
    except asyncio.CancelledError:
        await _kill(process)
        raise
    except TimeoutError:
        await _kill(process)
        return None
    return stdout


def _decode(stdout):
    if not stdout:
        return {"ok": False, "error": "unavailable"}
    try:
        value = json.loads(stdout.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return {"ok": False, "error": "unavailable"}
    return value if isinstance(value, dict) else {"ok": False, "error": "unavailable"}


async def _run_async(payload, limit):
    loop = asyncio.get_running_loop()
    started = loop.time()
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        process = await asyncio.wait_for(
            asyncio.create_subprocess_exec(
                sys.executable,
                str(_WORKER),
                cwd=str(_PACKAGE_ROOT),
                env=_environment(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                **kwargs,
            ),
            limit,
        )
    except TimeoutError:
        return {"ok": False, "error": "timeout"}
    except (NotImplementedError, OSError):
        return None
    remaining = max(0.05, limit - (loop.time() - started))
    stdout = await _communicate(process, payload, remaining)
    if stdout is None:
        return {"ok": False, "error": "timeout"}
    return _decode(stdout)


def _run_blocking(payload, timeout):
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        process = subprocess.Popen(
            [sys.executable, str(_WORKER)],
            cwd=str(_PACKAGE_ROOT),
            env=_environment(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            **kwargs,
        )
    except OSError:
        return {"ok": False, "error": "unavailable"}
    try:
        stdout, _ = process.communicate(payload, timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        return {"ok": False, "error": "timeout"}
    return _decode(stdout)


async def run(request, deadline_seconds=DEFAULT_TIMEOUT):
    """Return ``{"ok": True, "value": ...}`` or a bounded failure object."""
    global _active
    payload = json.dumps(request, ensure_ascii=False).encode("utf-8")
    async with _semaphore():
        _active += 1
        try:
            value = await _run_async(payload, deadline_seconds)
            if value is None:
                value = await asyncio.to_thread(_run_blocking, payload, deadline_seconds)
            return value
        finally:
            _active -= 1
