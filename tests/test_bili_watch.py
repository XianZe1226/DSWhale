"""Exercise real queue/budget/evidence boundaries; transports and model are fixtures."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from test_plugin import Host, event

from dswhale.adapter import Companion
from dswhale.bili import BiliService
from dswhale.config import Settings
from dswhale.store import Store


@pytest.fixture
def watching(tmp_path):
    settings = Settings.from_mapping(
        {
            "owner_qq": "123",
            "owner_umo": "qq:FriendMessage:123",
            "bili_enabled": True,
            "proactive_enabled": True,
            "quiet_start": "00:00",
            "quiet_end": "00:00",
            "daily_limit": 2,
        }
    )
    host = Host()
    host.client.send_private_msg = AsyncMock(return_value={"message_id": 1})
    c = Companion(host, settings, Store(tmp_path / "state.db"))
    service = BiliService(c)
    service.ready.set()
    service.process = SimpleNamespace(returncode=None)
    c.bili = service
    (service.root / ".dsh").mkdir()
    (service.root / ".dsh/bili-whale.config.json").write_text(
        json.dumps(
            {
                "share": {"via": "qq", "enabled": True, "minScore": 13},
                "diary": {"push": False},
                "night": {"maxVideos": 5},
            }
        )
    )
    yield c, service
    service.ledger.close()
    c.store.close()


def test_chat_admission_is_immediate_durable_and_deduplicated(watching):
    c, service = watching
    e = event(c.context)
    first = c.request_bili_watch(e, "AI")
    assert "去看看" in first
    assert "已经" in c.request_bili_watch(e, "AI")
    e.message_obj.message_id = "second"
    assert "正在" in c.request_bili_watch(e, "AI")
    job = service.ledger.next_job()
    assert job["source"] == "qq-watch"
    assert "AI" in json.dumps(job["content"], ensure_ascii=False)
    assert service.ledger.next_job() is None
    assert len(c.store.recent_activities(c.settings.owner_umo)) == 1
    assert c.store.activity(job["activity_id"]).kind == "bili-watch"


def test_chat_gate_cannot_bypass_owner_quiet_budget_or_stopped_host(watching):
    c, service = watching
    with pytest.raises(PermissionError):
        c.request_bili_watch(event(c.context, "456"), "")
    c.store.set_paused(c.settings.owner_umo, True)
    assert "暂停" in c.request_bili_watch(event(c.context), "")
    c.store.set_paused(c.settings.owner_umo, False)
    service.process.returncode = 1
    assert "未运行" in c.request_bili_watch(event(c.context), "")
    service.process.returncode = None
    c.settings = service.settings = Settings.from_mapping(
        {**vars(c.settings), "quiet_start": "00:00", "quiet_end": "23:59"}
    )
    assert "安静时段" in c.request_bili_watch(event(c.context), "")
    c.settings = service.settings = Settings.from_mapping(
        {**vars(c.settings), "quiet_end": "00:00"}
    )
    c.scheduler.settings = c.settings
    c.store.db.execute("update sessions set unanswered=100")
    assert "额度" in c.request_bili_watch(event(c.context), "")
    assert service.ledger.next_job() is None


def test_chat_request_during_scheduled_work_does_not_create_second_watch(watching):
    c, service = watching
    service.ledger.enqueue({"requestId": "scheduled", "content": []})
    service.ledger.next_job()
    assert "正在" in c.request_bili_watch(event(c.context), "")
    assert service.ledger.next_job() is None
    assert not c.store.recent_activities(c.settings.owner_umo)


async def test_completion_uses_one_reserved_budget_and_never_replays(watching):
    from dswhale.bili_watch import finish_watch

    c, service = watching
    c.request_bili_watch(event(c.context), "")
    job = service.ledger.next_job()
    outcome = {
        "text": "这条讲的是声音传播",
        "evidence": {
            "BV1234567890": {
                "title": "声音实验",
                "metadata": True,
                "subtitles": True,
                "comments": False,
                "frames": False,
            }
        },
        "recommendation": None,
    }
    await finish_watch(service, job, outcome)
    await finish_watch(service, job, outcome)
    sent = c.context.client.send_private_msg
    assert sent.await_count == 1
    text = sent.await_args.kwargs["message"][0]["data"]["text"]
    assert "声音实验" in text and "字幕" in text and "未读" in text
    assert "https://" not in text
    assert len(c.store.recent_activities(c.settings.owner_umo)) == 1
    assert c.store.activity(job["activity_id"]).status == "sent"
    assert service.ledger.result(job["requestId"]) == text
    service.ledger.finish(job["requestId"], "done")
    e = event(c.context)
    e.message_obj.message_id = "new"
    assert "稍等" in c.request_bili_watch(e, "")


async def test_no_evidence_cannot_turn_hallucinated_completion_into_viewing(watching):
    from dswhale.bili_watch import finish_watch

    c, service = watching
    c.request_bili_watch(event(c.context), "")
    job = service.ledger.next_job()
    await finish_watch(
        service, job, {"text": "我完整看过啦", "evidence": {}, "recommendation": None}
    )
    text = service.ledger.result(job["requestId"])
    assert "完整看过" not in text and "没拿到" in text


async def test_report_paused_or_uncertain_is_saved_without_resend(watching):
    from dswhale.bili_watch import finish_watch

    c, service = watching
    c.request_bili_watch(event(c.context), "")
    job = service.ledger.next_job()
    c.store.set_paused(c.settings.owner_umo, True)
    await finish_watch(service, job, None, error="这次读取超时了，没有重试")
    assert service.ledger.result(job["requestId"])
    assert c.store.activity(job["activity_id"]).status == "failed"
    assert c.context.client.send_private_msg.await_count == 0


async def test_explicit_link_cannot_overlap_queue(watching):
    c, service = watching
    c.request_bili_watch(event(c.context), "")
    with pytest.raises(RuntimeError, match="正在"):
        await c.watch("https://www.bilibili.com/video/BV1234567890")


def test_evidence_requires_successful_reads_and_consumed_images(tmp_path):
    from dswhale.bili_watch import WatchEvidence, completion_text

    ev = WatchEvidence(tmp_path)
    ev.record(["debrief", "BV1234567890"], {"ok": False, "error": "cookie 未登录"})
    assert not ev.videos
    assert "登录" in completion_text({"evidence": ev.videos, "errors": ev.errors})
    folder = tmp_path / ".dsh/shots"
    folder.mkdir(parents=True)
    frame = folder / "BV1234567890-3x3.jpg"
    frame.write_bytes(b"fixture")
    ev.record(
        ["debrief", "BV1234567890"],
        {
            "ok": True,
            "out": "标题: 声音实验\n✗ 无官方字幕轨道\n（没取到热评）\nSHEET: " + str(frame),
        },
    )
    assert ev.videos["BV1234567890"]["frames"] is False
    ev.consumed(frame, vision=True)
    assert ev.videos["BV1234567890"]["frames"] is True
    assert ev.videos["BV1234567890"]["subtitles"] is False


async def test_agent_captures_evidence_defers_share_and_returns_outcome(watching, monkeypatch):
    import dswhale.bili_agent as agent

    c, service = watching
    monkeypatch.setattr(agent, "owner_event", AsyncMock(return_value=event(c.context)))
    c.context.get_using_provider_async = AsyncMock(
        return_value=SimpleNamespace(meta=lambda: SimpleNamespace(id="fixture"))
    )
    service.command = AsyncMock(
        return_value={"ok": True, "out": "标题: 声音实验\n✗ 无官方字幕轨道"}
    )

    async def model(**kwargs):
        tools = {t.name: t for t in kwargs["tools"].tools}
        await tools["bili_command"].call(None, args_json='["debrief","BV1234567890","--no-frames"]')
        assert "合并" in await tools["share_to_owner_qq"].call(
            None,
            text="这条有意思",
            bvid="BV1234567890",
            reason="声音实验适合主人喜欢的主题",
            score=16,
            rank=1,
        )
        return SimpleNamespace(completion_text="声音原来这样传播")

    c.context.tool_loop_agent = model
    c.request_bili_watch(event(c.context), "")
    job = service.ledger.next_job()
    result = await agent.run_agent(service, job)
    assert result["evidence"]["BV1234567890"]["metadata"]
    assert result["recommendation"]["bvid"] == "BV1234567890"
    assert c.context.client.send_private_msg.await_count == 0


async def test_unqualified_recommendation_cannot_smuggle_link_in_report(watching):
    from dswhale.bili_watch import finish_watch

    c, service = watching
    c.request_bili_watch(event(c.context), "")
    job = service.ledger.next_job()
    await finish_watch(
        service,
        job,
        {
            "text": "看看 https://www.bilibili.com/video/BV1234567890",
            "evidence": {"BV1234567890": {"title": "实验", "metadata": True}},
            "recommendation": {
                "bvid": "BV1234567890",
                "score": 1,
                "rank": 1,
                "reason": "这是一个没有达到评分门槛的例子",
            },
        },
    )
    assert "https://" not in service.ledger.result(job["requestId"])


async def test_qualified_share_uses_one_message_and_quota_before_transport(watching):
    from dswhale.bili_watch import finish_watch

    c, service = watching
    c.request_bili_watch(event(c.context), "")
    job = service.ledger.next_job()
    calls = []

    async def quota(args, **kwargs):
        calls.append(args[:2])
        assert c.context.client.send_private_msg.await_count == 0
        return {"ok": True}

    service.command = quota
    result = {
        "text": "这个实验有意思",
        "evidence": {"BV1234567890": {"title": "声音实验", "metadata": True}},
        "recommendation": {
            "bvid": "BV1234567890",
            "score": 16,
            "rank": 1,
            "reason": "声音实验贴合主人喜欢的科学主题",
        },
    }
    await finish_watch(service, job, result)
    assert calls == [["quota", "check"], ["quota", "record"]]
    assert c.context.client.send_private_msg.await_count == 1
    assert "https://www.bilibili.com/video/BV1234567890" in service.ledger.result(job["requestId"])
    assert len(c.store.recent_activities(c.settings.owner_umo)) == 1


async def test_failed_transport_is_uncertain_without_second_attempt(watching):
    from dswhale.bili_watch import finish_watch

    c, service = watching
    c.request_bili_watch(event(c.context), "")
    job = service.ledger.next_job()
    c.context.client.send_private_msg.side_effect = TimeoutError()
    with pytest.raises(TimeoutError):
        await finish_watch(service, job, None, error="没有读到视频")
    assert c.store.activity(job["activity_id"]).status == "uncertain"
    await finish_watch(service, job, None, error="不要重新发送")
    assert c.context.client.send_private_msg.await_count == 1


def test_plugin_tool_uses_queue_and_exposes_result_to_owner(watching):
    c, service = watching
    c.request_bili_watch(event(c.context), "")
    job = service.ledger.next_job()
    service.ledger.save_result(job["requestId"], "这次只读到了字幕")
    assert "只读到了字幕" in c.status(event(c.context))


async def test_raw_video_read_blocks_link_watch_and_chat_admission(watching):
    import asyncio

    import main

    c, service = watching
    started, release = asyncio.Event(), asyncio.Event()

    async def command(args):
        started.set()
        await release.wait()
        return {"ok": True, "out": "标题: 实验"}

    service.command = command
    plugin = SimpleNamespace(companion=c)
    task = asyncio.create_task(
        main.DSWhale.bili_read(plugin, event(c.context), '["video","BV1234567890"]')
    )
    await asyncio.wait_for(started.wait(), 1)
    try:
        assert c.video_busy
        assert "正在" in c.request_bili_watch(event(c.context), "")
        with pytest.raises(RuntimeError, match="正在"):
            await c.watch("https://www.bilibili.com/video/BV1234567890")
    finally:
        release.set()
        await task
    assert not c.video_busy


def test_disabled_qq_push_is_declined_before_budget_or_promise(watching):
    c, service = watching
    c.settings = service.settings = Settings.from_mapping(
        {**vars(c.settings), "bili_qq_recommendations": False}
    )
    assert "推送" in c.request_bili_watch(event(c.context), "")
    assert service.ledger.next_job() is None
    assert not c.store.recent_activities(c.settings.owner_umo)


@pytest.mark.parametrize(
    "out",
    [
        "评论「实验」\nBV=BV1234567890  本页 0 条\n（这一页没有评论：可能关了评论区，或页码超了）",
        '{"ok":true,"title":"实验","count":0,"items":[]}',
    ],
)
def test_empty_comment_page_is_not_comment_evidence(tmp_path, out):
    from dswhale.bili_watch import WatchEvidence

    ev = WatchEvidence(tmp_path)
    ev.record(["comments", "BV1234567890"], {"ok": True, "out": out})
    assert not ev.videos["BV1234567890"]["comments"]


@pytest.mark.parametrize(
    "out",
    [
        "评论「实验」\nBV=BV1234567890  本页 1 条\n[1] ♥3  用户  rpid=42\n    看懂了",
        '{"ok":true,"title":"实验","count":1,"items":[{"text":"看懂了","rpid":"42"}]}',
    ],
)
def test_actual_comment_page_counts_as_evidence(tmp_path, out):
    from dswhale.bili_watch import WatchEvidence

    ev = WatchEvidence(tmp_path)
    ev.record(["comments", "BV1234567890"], {"ok": True, "out": out})
    assert ev.videos["BV1234567890"]["comments"]


def test_owner_chat_sees_saved_bili_notes_without_new_work(watching):
    from astrbot.core.provider.entities import ProviderRequest

    c, service = watching
    service.ledger.enqueue({"requestId": "qq-watch-old", "content": []})
    service.ledger.finish("qq-watch-old", "done")
    service.ledger.save_result("qq-watch-old", "《声音实验》简介已读，字幕未读")
    (service.root / ".dsh/whale-diary.md").write_text(
        "实验通过水中扬声器解释声波传播，不是主人的经历"
    )
    req = ProviderRequest(system_prompt="original")
    c.enrich(event(c.context), req)
    assert "水中扬声器" in req.system_prompt
    assert "字幕未读" in req.system_prompt
    assert not service.ledger.busy()
    outsider = ProviderRequest(system_prompt="original")
    c.enrich(event(c.context, "456"), outsider)
    assert outsider.system_prompt == "original"


async def test_owner_can_read_notes_without_bili_network_or_private_diary(watching):
    import main

    c, service = watching
    (service.root / ".dsh/whale-diary.md").write_text("public-note: 声音传播")
    (service.root / ".dsh/whale-diary-private.md").write_text("private-secret")
    plugin = SimpleNamespace(companion=c)
    text = await main.DSWhale.bili_notes(plugin, event(c.context))
    assert "public-note" in text and "private-secret" not in text
    with pytest.raises(PermissionError):
        await main.DSWhale.bili_notes(plugin, event(c.context, "456"))


def test_consumed_debrief_transcript_counts_as_subtitle_evidence(tmp_path):
    from dswhale.bili_watch import WatchEvidence

    ev = WatchEvidence(tmp_path)
    folder = tmp_path / ".dsh/shots"
    folder.mkdir(parents=True)
    transcript = folder / "BV1234567890-debrief.txt"
    transcript.write_text("[00:00] 这是字幕原文")
    ev.record(["debrief", "BV1234567890"], {"ok": True, "out": "标题: 实验"})
    assert not ev.videos["BV1234567890"]["subtitles"]
    ev.consumed(transcript)
    assert ev.videos["BV1234567890"]["subtitles"]


async def test_automatic_debrief_is_light_and_long_video_is_not_downloaded(watching, monkeypatch):
    import dswhale.bili_agent as agent

    c, service = watching
    monkeypatch.setattr(agent, "owner_event", AsyncMock(return_value=event(c.context)))
    c.context.get_using_provider_async = AsyncMock(
        return_value=SimpleNamespace(meta=lambda: SimpleNamespace(id="fixture"))
    )
    calls = []

    async def command(args, **kwargs):
        calls.append(args)
        return {"ok": True, "out": "标题: 长视频\nUP: 作者   时长: 57:15   分区: 科技"}

    service.command = command

    async def model(**kwargs):
        tools = {t.name: t for t in kwargs["tools"].tools}
        await tools["bili_command"].call(None, args_json='["debrief","BV1234567890"]')
        reply = await tools["bili_command"].call(None, args_json='["watch-video","BV1234567890"]')
        assert "时长" in reply and "下载" in reply
        return SimpleNamespace(completion_text="只能说明文字资料")

    c.context.tool_loop_agent = model
    c.request_bili_watch(event(c.context), "")
    await agent.run_agent(service, service.ledger.next_job())
    assert calls == [["debrief", "BV1234567890", "--no-frames"]]


async def test_failed_frame_read_is_not_repeated_in_same_activity(watching, monkeypatch):
    import dswhale.bili_agent as agent

    c, service = watching
    monkeypatch.setattr(agent, "owner_event", AsyncMock(return_value=event(c.context)))
    c.context.get_using_provider_async = AsyncMock(
        return_value=SimpleNamespace(meta=lambda: SimpleNamespace(id="fixture"))
    )
    calls = []

    async def command(args, **kwargs):
        calls.append(args)
        return (
            {"ok": False, "error": "timeout"}
            if args[0] == "watch-video"
            else {"ok": True, "out": "标题: 实验\nUP: 作者   时长: 01:30   分区: 科技"}
        )

    service.command = command

    async def model(**kwargs):
        tools = {t.name: t for t in kwargs["tools"].tools}
        run = tools["bili_command"]
        await run.call(None, args_json='["debrief","BV1234567890"]')
        await run.call(None, args_json='["watch-video","BV1234567890"]')
        reply = await run.call(None, args_json='["watch-video","BV1234567890"]')
        assert "重复" in reply
        return SimpleNamespace(completion_text="抽帧没成功")

    c.context.tool_loop_agent = model
    c.request_bili_watch(event(c.context), "")
    await agent.run_agent(service, service.ledger.next_job())
    assert sum(a[0] == "watch-video" for a in calls) == 1
    assert "--uniform" in calls[-1]


async def test_chat_read_debrief_cannot_implicitly_download_frames(watching):
    import main

    c, service = watching
    service.command = AsyncMock(return_value={"ok": True, "out": "标题: 测试"})
    await main.DSWhale.bili_read(
        SimpleNamespace(companion=c), event(c.context), '["debrief","BV1234567890"]'
    )
    assert service.command.await_args.args[0] == ["debrief", "BV1234567890", "--no-frames"]


async def test_raw_chat_frames_require_the_duration_checked_link_tool(watching):
    import main

    c, service = watching
    service.command = AsyncMock(return_value={"ok": True, "out": "unbounded"})
    reply = await main.DSWhale.bili_read(
        SimpleNamespace(companion=c), event(c.context), '["watch-video","BV1234567890"]'
    )
    assert "dswhale_watch_video" in reply
    assert service.command.await_count == 0


def test_status_reports_the_installed_version(watching):
    from dswhale import __version__

    c, _ = watching
    assert f"DSWhale {__version__}" in c.status(event(c.context))
