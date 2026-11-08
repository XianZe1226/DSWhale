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


def test_invalid_custom_rules_are_still_rejected_before_spawning():
    with pytest.raises(StyleError, match="捕获组"):
        run(plan_async("文本", mode="custom", custom_regex=r"(.)"))
    with pytest.raises(StyleError, match="空字符串"):
        run(plan_async("文本", mode="custom", custom_regex=r"x*"))
    with pytest.raises(StyleError, match="200"):
        run(plan_async("文本", mode="custom", custom_regex="a" * 201))


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


def test_five_concurrent_calls_are_bounded_by_the_same_deadline(monkeypatch):
    async def slow(payload, limit):
        await asyncio.sleep(0.2)
        return {"ok": True, "value": {}}

    monkeypatch.setattr(reply_style_isolate, "_run_async", slow)

    async def scenario():
        return await asyncio.gather(
            *[reply_style_isolate.run({}, deadline_seconds=0.15) for _ in range(5)]
        )

    results = run(scenario())
    assert len(results) == 5
    assert sum(item.get("ok") is True for item in results) == 4
    assert [item.get("error") for item in results if item.get("ok") is not True] == ["unavailable"]
    assert reply_style_isolate.active_workers() == 0


def test_plan_maps_an_unavailable_worker_slot_to_custom_unavailable(monkeypatch):
    async def unavailable(request, deadline_seconds=0.75):
        return {"ok": False, "error": "unavailable"}

    monkeypatch.setattr(reply_style_isolate, "run", unavailable)
    result = run(plan_async("整段正文", mode="custom", custom_regex=r"[^\n]+"))
    assert result["degraded"] == "custom_unavailable"
    assert result["customExecuted"] is False
    assert result["bubbles"] == ["整段正文"]
