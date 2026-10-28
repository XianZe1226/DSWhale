import pytest

from dswhale.bili import BiliLedger


def test_durable_jobs_deduplicate_and_do_not_replay_uncertain_actions(tmp_path):
    path = tmp_path / "bili.db"
    ledger = BiliLedger(path)
    request = {
        "requestId": "event-1",
        "sessionId": "fish",
        "content": [{"type": "text", "text": "wake"}],
    }
    assert ledger.enqueue(request)
    assert not ledger.enqueue(request)
    assert ledger.next_job()["requestId"] == "event-1"
    ledger.close()
    ledger = BiliLedger(path)
    assert ledger.next_job() is None
    assert ledger.status("event-1") == "uncertain"
    ledger.close()


def test_public_actions_need_one_time_owner_approval(tmp_path):
    ledger = BiliLedger(tmp_path / "state.db")
    proposal = ledger.propose(["comment", "--oid", "123", "--message", "hello", "--go"])
    assert ledger.claim_proposal(proposal)[0] == "comment"
    with pytest.raises(ValueError):
        ledger.claim_proposal(proposal)
    ledger.close()


def test_queue_is_bounded_and_rejects_oversized_untrusted_prompts(tmp_path):
    ledger = BiliLedger(tmp_path / "state.db")
    with pytest.raises(ValueError):
        ledger.enqueue({"requestId": "a", "content": [{"text": "x" * 100001}]})
    for n in range(50):
        assert ledger.enqueue({"requestId": str(n), "content": [{"text": "wake"}]})
    with pytest.raises(ValueError):
        ledger.enqueue({"requestId": "over-limit", "content": [{"text": "wake"}]})
    ledger.close()


def test_generated_artifact_access_cannot_escape_media_directory(tmp_path):
    from dswhale.bili_agent import artifact_path

    media = tmp_path / ".dsh/shots"
    media.mkdir(parents=True)
    (media / "frame.jpg").write_bytes(b"fixture")
    (tmp_path / "credentials.json").write_text("private")
    assert artifact_path(tmp_path, ".dsh/shots/frame.jpg") == media / "frame.jpg"
    for name in ["credentials.json", ".dsh/shots/../../credentials.json", "/etc/passwd"]:
        with pytest.raises(ValueError):
            artifact_path(tmp_path, name)


async def test_python_sidecar_roundtrip_is_local_and_stops_cleanly(tmp_path):
    import json
    import shutil
    from types import SimpleNamespace

    import httpx

    from dswhale.bili import BRIDGE, BiliService
    from dswhale.config import Settings
    from dswhale.store import Store

    if not shutil.which("node") or not (BRIDGE / "node_modules/react").exists():
        pytest.skip("Node bridge dependencies required")
    store = Store(tmp_path / "state.db")
    c = SimpleNamespace(
        settings=Settings.from_mapping({"owner_qq": "123", "owner_umo": "qq:FriendMessage:123"}),
        store=store,
        closed=False,
        last_error="",
    )
    service = BiliService(c)
    try:
        await service.start()
        async with httpx.AsyncClient() as client:
            url = f"http://127.0.0.1:{service.port}"
            assert (await client.get(url + "/dsh-bili/api/settings")).status_code == 403
            response = await client.post(
                url + "/dswhale/api/command",
                headers={"Authorization": "Bearer " + service.token},
                json={"args": ["help"]},
            )
            assert response.json()["result"]["ok"]
            assert "ai-share" in response.json()["result"]["out"]
        assert json.loads((service.root / "control.json").read_text())["port"] == service.port
    finally:
        await service.close()
        store.close()
    assert service.process.returncode is not None
    assert not (service.root / "control.json").exists()


async def test_agent_uses_astrbot_tools_and_does_not_send_without_owner_grant(
    tmp_path, monkeypatch
):
    import json
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from astrbot.core.agent.tool import ToolSet

    import dswhale.bili_agent as agent
    from dswhale.config import Settings

    (tmp_path / ".dsh").mkdir()
    (tmp_path / ".dsh/bili-whale.config.json").write_text('{"share":{"via":"qq"}}')
    ledger = BiliLedger(tmp_path / "state.db")

    async def loop(**kwargs):
        assert isinstance(kwargs["tools"], ToolSet)
        assert kwargs["chat_provider_id"] == "chat-fixture"
        tools = {t.name: t for t in kwargs["tools"].tools}
        command = tools["bili_command"]
        # A misleading dry flag cannot disguise a committing action.
        result = await command.call(None, args_json=json.dumps(["comment", "--dry", "--go=true"]))
        assert "尚未发送" in result
        await command.call(None, args_json='["feed","--n","3"]')
        assert await tools["recall_owner_memory"].call(None, query="偏好") == "owner memory"
        return SimpleNamespace(completion_text="本轮没有实际发消息")

    context = SimpleNamespace(
        tool_loop_agent=loop,
        get_using_provider_async=AsyncMock(
            return_value=SimpleNamespace(meta=lambda: SimpleNamespace(id="chat-fixture"))
        ),
    )
    c = SimpleNamespace(
        context=context, settings=Settings(), recall_memory=AsyncMock(return_value="owner memory")
    )
    service = SimpleNamespace(
        root=tmp_path,
        companion=c,
        settings=c.settings,
        ledger=ledger,
        allowed=lambda: True,
        command=AsyncMock(return_value={"ok": True, "out": "fixture"}),
    )
    monkeypatch.setattr(agent, "owner_event", AsyncMock(return_value=object()))
    try:
        await agent.run_agent(
            service, {"sessionId": "fixture", "content": [{"type": "text", "text": "read a video"}]}
        )
        service.command.assert_awaited_once_with(["feed", "--n", "3"], write=False)
        assert len(ledger.proposals()) == 1
        assert (tmp_path / ".dsh/whale-diary.md").exists()
        assert (tmp_path / ".dsh/whale-diary-private.md").exists()
    finally:
        ledger.close()


async def test_qq_recommendation_only_targets_owner_and_respects_shared_budget(tmp_path):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from dswhale.bili_agent import share_qq
    from dswhale.config import Settings
    from dswhale.scheduler import Scheduler
    from dswhale.store import Store

    cfg = Settings.from_mapping(
        {
            "owner_qq": "123",
            "owner_umo": "qq:FriendMessage:123",
            "proactive_enabled": True,
            "quiet_start": "00:00",
            "quiet_end": "00:00",
            "daily_limit": 1,
        }
    )
    store = Store(tmp_path / "state.db")
    client = SimpleNamespace(send_private_msg=AsyncMock(return_value={"message_id": 1}))
    platform = SimpleNamespace(
        meta=lambda: SimpleNamespace(name="aiocqhttp"), get_client=lambda: client
    )
    context = SimpleNamespace(get_platform_inst=lambda ident: platform if ident == "qq" else None)
    c = SimpleNamespace(settings=cfg, store=store, scheduler=Scheduler(cfg, store), context=context)
    (tmp_path / ".dsh").mkdir()
    (tmp_path / ".dsh/bili-whale.config.json").write_text(
        '{"share":{"via":"qq","enabled":true},"diary":{"push":true}}'
    )
    service = SimpleNamespace(
        settings=cfg,
        companion=c,
        root=tmp_path,
        allowed=lambda: True,
        command=AsyncMock(return_value={"ok": True}),
    )
    try:
        result = await share_qq(
            service, "这个你应该会喜欢", "BV1234567890", "实际内容贴合主人喜欢的主题", 16, 1
        )
        assert "已提交" in result
        assert client.send_private_msg.await_args.kwargs["user_id"] == 123
        assert (
            "https://www.bilibili.com/video/BV1234567890"
            in client.send_private_msg.await_args.kwargs["message"][0]["data"]["text"]
        )
        assert store.recent_activities(cfg.owner_umo)[0]["status"] == "sent"
        assert "预算" in await share_qq(service, "第二次摘要")
        assert client.send_private_msg.await_count == 1
    finally:
        store.close()
