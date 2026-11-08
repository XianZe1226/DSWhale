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
import threading
import time
from pathlib import Path
from weakref import WeakKeyDictionary

DEFAULT_TIMEOUT = 0.75
MAX_CONCURRENCY = 4
# Reserved for kill+reap and event-loop bookkeeping. Subtracting it keeps the
# whole call (queue wait, spawn, matching, cleanup) inside the requested budget.
DEADLINE_MARGIN = 0.05
MIN_WORKER_BUDGET = 0.01
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


def _worker_command():
    return [sys.executable, str(_WORKER)]


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
    remaining = limit - (loop.time() - started)
    if remaining <= 0:
        await _kill(process)
        return {"ok": False, "error": "timeout"}
    stdout = await _communicate(process, payload, remaining)
    if stdout is None:
        return {"ok": False, "error": "timeout"}
    return _decode(stdout)


class _BlockingWorker:
    """Own a blocking worker so cancellation can kill and reap it.

    A thread cannot be cancelled directly. The holder starts the child inside
    the executor thread, exposes ``terminate`` to the event-loop thread and
    ``wait`` so the slot is released only after the child has been collected.
    """

    def __init__(self, payload, timeout):
        self.payload = payload
        self.timeout = timeout
        self._process = None
        self._cancelled = False
        self._lock = threading.Lock()

    def _start(self):
        kwargs = {}
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        with self._lock:
            if self._cancelled:
                return None
            if self._process is not None:
                return self._process
            self._process = subprocess.Popen(
                _worker_command(),
                cwd=str(_PACKAGE_ROOT),
                env=_environment(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                **kwargs,
            )
            return self._process

    def run(self):
        try:
            process = self._start()
        except OSError:
            return {"ok": False, "error": "unavailable"}
        if process is None:
            return {"ok": False, "error": "unavailable"}
        try:
            stdout, _ = process.communicate(self.payload, timeout=self.timeout)
        except subprocess.TimeoutExpired:
            self.terminate()
            try:
                process.communicate(timeout=1)
            except (subprocess.TimeoutExpired, OSError):
                pass
            return {"ok": False, "error": "timeout"}
        return _decode(stdout)

    def terminate(self):
        with self._lock:
            self._cancelled = True
            process = self._process
        if process is not None and process.poll() is None:
            try:
                process.kill()
            except (ProcessLookupError, OSError):
                pass

    def wait(self):
        with self._lock:
            process = self._process
        if process is None:
            return
        try:
            process.wait(timeout=1.0)
        except (subprocess.TimeoutExpired, OSError):
            pass


async def _finish_future(future):
    """Wait for an executor future even while the surrounding task is cancelled."""
    while not future.done():
        try:
            await asyncio.shield(future)
        except asyncio.CancelledError:
            continue
    return future.result()


def run_sync(request, deadline_seconds=DEFAULT_TIMEOUT):
    """Run one worker synchronously, e.g. while loading or saving settings."""
    started = time.monotonic()

    def remaining():
        return max(0.0, deadline_seconds - DEADLINE_MARGIN - (time.monotonic() - started))

    if remaining() <= MIN_WORKER_BUDGET:
        return {"ok": False, "error": "unavailable"}
    payload = json.dumps(request, ensure_ascii=False).encode("utf-8")
    holder = _BlockingWorker(payload, remaining())
    return holder.run()


def validate_sync(pattern, cleanup=""):
    """Validate custom regexes in a worker for settings load/save paths."""
    outcome = run_sync({"op": "validate", "regex": pattern, "cleanup": cleanup})
    if outcome.get("ok") is True:
        return True
    if outcome.get("error") in {"timeout", "unavailable"}:
        raise ValueError("自定义规则校验超时，请简化规则后重试")
    message = outcome.get("message") or "自定义规则无法执行"
    raise ValueError(str(message))


async def run(request, deadline_seconds=DEFAULT_TIMEOUT):
    """Return ``{"ok": True, "value": ...}`` or a bounded failure object."""
    global _active
    payload = json.dumps(request, ensure_ascii=False).encode("utf-8")
    loop = asyncio.get_running_loop()
    started = loop.time()

    def remaining():
        # The margin is subtracted, never added: it protects the hard deadline
        # from cleanup overhead instead of extending the execution window.
        return max(0.0, deadline_seconds - DEADLINE_MARGIN - (loop.time() - started))

    if remaining() <= 0:
        return {"ok": False, "error": "unavailable"}

    semaphore = _semaphore()
    try:
        await asyncio.wait_for(semaphore.acquire(), remaining())
    except TimeoutError:
        # Waiting for a slot is part of the same hard budget. The caller maps
        # this to custom_unavailable, never to a successful execution.
        return {"ok": False, "error": "unavailable"}
    try:
        budget = remaining()
        if budget <= MIN_WORKER_BUDGET:
            # The slot arrived after the budget was exhausted (or so close to
            # the deadline that starting a worker would necessarily overrun).
            return {"ok": False, "error": "unavailable"}
        _active += 1
        try:
            value = await _run_async(payload, budget)
            if value is None:
                budget = remaining()
                if budget <= MIN_WORKER_BUDGET:
                    return {"ok": False, "error": "unavailable"}
                holder = _BlockingWorker(payload, budget)
                future = loop.run_in_executor(None, holder.run)
                try:
                    value = await asyncio.shield(future)
                except asyncio.CancelledError:
                    holder.terminate()
                    await _finish_future(future)
                    holder.wait()
                    raise
            return value
        finally:
            _active -= 1
    finally:
        semaphore.release()
