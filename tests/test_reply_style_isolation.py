"""F2: custom regex work is confined to a disposable worker process."""

import asyncio
import time

import pytest

from dswhale import reply_style_isolate
from dswhale.reply_style import StyleError, plan, plan_async, preview
from dswhale.reply_style_ops import CustomWorkerRequired, custom_plan


def run(coro):
    return asyncio.run(coro)


def test_parent_process_refuses_to_execute_custom_rules(monkeypatch):
    monkeypatch.delenv("DSWHALE_REPLY_STYLE_WORKER", raising=False)
    with pytest.raises(CustomWorkerRequired):
        custom_plan("甲\n乙", r"[^\n]+", "", 3)
    with pytest.raises(RuntimeError, match="隔离进程"):
        plan("甲\n乙", mode="custom", custom_regex=r"[^\n]+")


def test_custom_plan_runs_in_a_worker_and_keeps_protected_text():
    result = run(
        plan_async("甲。 看 https://a.example/x?q=1。\n乙。", mode="custom", custom_regex=r"[^\n]+")
    )
    assert result["customExecuted"] is True
    assert result["degraded"] is None
    assert "https://a.example/x?q=1。" in "".join(result["bubbles"])
    assert reply_style_isolate.active_workers() == 0


def test_catastrophic_pattern_hits_the_hard_deadline_and_falls_back_whole():
    started = time.monotonic()
    result = run(plan_async("a" * 33 + "!", mode="custom", custom_regex=r"(?:a+)+$"))
    elapsed = time.monotonic() - started
    assert result["degraded"] == "custom_timeout"
    assert result["customExecuted"] is False
    assert result["bubbles"] == ["a" * 33 + "!"]
    assert result["count"] == 1
    assert "custom_timeout" in result["warnings"]
    assert elapsed < 3.0
    assert reply_style_isolate.active_workers() == 0


def test_event_loop_keeps_ticking_while_the_worker_runs():
    ticks = []

    async def scenario():
        async def ticker():
            for _ in range(5):
                await asyncio.sleep(0.05)
                ticks.append(1)

        task = asyncio.create_task(ticker())
        value = await plan_async("甲\n乙\n丙", mode="custom", custom_regex=r"[^\n]+")
        await task
        return value

    value = asyncio.run(scenario())
    assert value["count"] >= 1
    assert len(ticks) == 5


def test_spawn_failure_degrades_to_whole_text(monkeypatch):
    import dswhale.reply_style_isolate as isolate

    monkeypatch.setattr(isolate.sys, "executable", "/nonexistent/python-for-test")
    result = run(plan_async("整段正文", mode="custom", custom_regex=r"[^\n]+"))
    assert result["degraded"] in {"custom_unavailable", "custom_timeout"}
    assert result["bubbles"] == ["整段正文"]
    assert result["customExecuted"] is False


def test_invalid_custom_rules_are_rejected_by_the_worker():
    with pytest.raises(StyleError, match="捕获组"):
        run(plan_async("文本", mode="custom", custom_regex=r"(.)"))
    with pytest.raises(StyleError, match="空字符串"):
        run(plan_async("文本", mode="custom", custom_regex=r"x*"))
    with pytest.raises(StyleError, match="2000"):
        run(plan_async("文本", mode="custom", custom_regex="a" * 2001))


def test_preview_custom_also_uses_the_isolated_worker():
    value = preview({"text": "甲\n乙", "mode": "custom", "customRegex": r"[^\n]+"})
    assert value["customExecuted"] is True
    assert value["count"] == 2


def test_installed_namespace_worker_imports_stdlib_only():
    # The installed directory name is provided by AstrBot. The worker must import
    # dswhale through its parent path instead of relying on the checkout name.
    source = reply_style_isolate._WORKER.read_text(encoding="utf-8")
    assert "import astrbot" not in source
    assert "reply_style_ops" in source


def test_preview_inherit_without_host_context_does_not_fabricate_host_profile():
    value = preview({"text": "甲。乙。", "mode": "inherit"})
    assert value["computed"] is False
    assert value["uncomputedReason"] == "profile_unknown"
    assert value["interval"] is None


def test_five_concurrent_calls_are_bounded_by_the_same_deadline():
    text = "a" * 33 + "!"

    async def one():
        started = time.monotonic()
        value = await plan_async(text, mode="custom", custom_regex=r"(?:a+)+$", max_bubbles=3)
        return value, time.monotonic() - started

    async def scenario():
        return await asyncio.gather(*(one() for _ in range(5)))

    wall_started = time.monotonic()
    rows = run(scenario())
    wall = time.monotonic() - wall_started
    elapsed = [item[1] for item in rows]
    assert len(rows) == 5
    assert max(elapsed) <= 0.75
    assert wall <= 0.75
    # A queued call may either wait out the deadline (unavailable) or acquire a
    # just-released slot and hit the same deadline as timeout. Both are bounded
    # failures; do not require an exact 4+1 split under scheduler load.
    assert all(value["degraded"] in {"custom_timeout", "custom_unavailable"} for value, _ in rows)
    assert all(value["customExecuted"] is False for value, _ in rows)
    assert all(value["bubbles"] == [text] for value, _ in rows)
    assert reply_style_isolate.active_workers() == 0


def test_all_worker_slots_busy_returns_unavailable_without_spawning():
    text = "甲\n乙"

    async def scenario():
        semaphore = reply_style_isolate._semaphore()
        held = 0
        try:
            for _ in range(reply_style_isolate.MAX_CONCURRENCY):
                await semaphore.acquire()
                held += 1
            started = time.monotonic()
            value = await plan_async(text, mode="custom", custom_regex=r"[^\n]+")
            return value, time.monotonic() - started
        finally:
            # Always release, even if the assertion path changes or the worker
            # path unexpectedly raises; otherwise later tests would starve.
            for _ in range(held):
                semaphore.release()

    value, elapsed = run(scenario())
    assert value["degraded"] == "custom_unavailable"
    assert value["customExecuted"] is False
    assert value["bubbles"] == [text]
    assert value["count"] == 1
    assert "custom_unavailable" in value["warnings"]
    assert elapsed <= 0.75
    assert reply_style_isolate.active_workers() == 0


def test_plan_maps_an_unavailable_worker_slot_to_custom_unavailable(monkeypatch):
    async def unavailable(request, deadline_seconds=0.75):
        return {"ok": False, "error": "unavailable"}

    monkeypatch.setattr(reply_style_isolate, "run", unavailable)
    result = run(plan_async("整段正文", mode="custom", custom_regex=r"[^\n]+"))
    assert result["degraded"] == "custom_unavailable"
    assert result["customExecuted"] is False
    assert result["bubbles"] == ["整段正文"]


def test_shape_validation_never_executes_a_pathological_user_pattern():
    from dswhale.reply_style import validate_custom

    pattern = r"(?:a?|b?){30}(?!$)"
    started = time.monotonic()
    assert validate_custom(pattern) == pattern
    assert time.monotonic() - started < 0.1


def test_sync_validation_uses_the_same_worker(monkeypatch):
    calls = []

    def fake_sync(request, deadline_seconds=0.75):
        calls.append(request)
        return {"ok": True, "value": True}

    monkeypatch.setattr(reply_style_isolate, "run_sync", fake_sync)
    from dswhale.config import Settings

    value = Settings.from_mapping(
        {"reply_style_custom_regex": r"(?:a?|b?){30}(?!$)", "reply_style_custom_cleanup": ""}
    )
    assert value.reply_style_custom_regex.startswith("(?:")
    assert calls and calls[0]["op"] == "validate"
    assert calls[0]["regex"].startswith("(?:")


def test_cancelling_the_blocking_fallback_kills_and_reaps_the_child(monkeypatch):
    import sys

    records = []
    original_command = reply_style_isolate._worker_command
    original_holder = reply_style_isolate._BlockingWorker

    class RecordingWorker(original_holder):
        def _start(self):
            process = super()._start()
            records.append(process)
            return process

    async def no_async(request, limit):
        return None

    monkeypatch.setattr(reply_style_isolate, "_BlockingWorker", RecordingWorker)
    monkeypatch.setattr(reply_style_isolate, "_run_async", no_async)
    monkeypatch.setattr(
        reply_style_isolate,
        "_worker_command",
        lambda: [sys.executable, "-c", "import time; time.sleep(30)"],
    )

    async def scenario():
        for _ in range(5):
            task = asyncio.create_task(reply_style_isolate.run({"op": "custom"}, 5.0))
            await asyncio.sleep(0.2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert reply_style_isolate.active_workers() == 0

    asyncio.run(scenario())
    assert len(records) == 5
    assert all(process.returncode is not None for process in records)

    monkeypatch.setattr(reply_style_isolate, "_worker_command", original_command)
    outcome = asyncio.run(reply_style_isolate.run({"op": "validate", "regex": r"[^\n]+"}, 0.75))
    assert outcome.get("ok") is True


def test_preview_custom_keeps_ticks_and_deadline():
    from dswhale.reply_style import preview_async

    ticks = []

    async def scenario():
        async def ticker():
            for _ in range(5):
                await asyncio.sleep(0.05)
                ticks.append(1)

        task = asyncio.create_task(ticker())
        started = time.monotonic()
        value = await preview_async(
            {"text": "a" * 33 + "!", "mode": "custom", "customRegex": r"(?:a+)+$"}
        )
        await task
        return value, time.monotonic() - started

    value, elapsed = asyncio.run(scenario())
    assert len(ticks) == 5
    assert value["degraded"] == "custom_timeout"
    assert value["customExecuted"] is False
    assert value["bubbles"] == ["a" * 33 + "!"]
    assert elapsed < 3.0


def test_settings_load_validation_is_bounded_and_fails_closed():
    from dswhale.config import Settings

    started = time.monotonic()
    with pytest.raises(ValueError, match="校验超时"):
        Settings.from_mapping({"reply_style_custom_regex": r"(?:a?|b?){30}(?!$)"})
    elapsed = time.monotonic() - started
    assert elapsed <= 1.5
