import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from astrbot.api.message_components import Plain
from astrbot.api.platform import AstrBotMessage, MessageMember, MessageType
from astrbot.core.platform.platform_metadata import PlatformMetadata
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_message_event import AiocqhttpMessageEvent
from astrbot.core.provider.entities import ProviderRequest

from dswhale.adapter import Companion
from dswhale.config import Settings
from dswhale.store import Store

SCOPE = "qq:FriendMessage:123"
NOW = datetime(2026, 10, 25, 10, tzinfo=ZoneInfo("Asia/Shanghai"))


class Host:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.client = SimpleNamespace(call_action=self.action)
        self.platform = SimpleNamespace(
            meta=lambda: PlatformMetadata("aiocqhttp", "test", "qq"),
            create_event=self.event,
            get_client=lambda: self.client,
        )

    async def action(self, name):
        assert name == "get_login_info"
        return {"user_id": 999}

    def event(self, message):
        return AiocqhttpMessageEvent(
            message.message_str, message, self.platform.meta(), message.session_id, self.client
        )

    def get_platform_inst(self, platform):
        return self.platform if platform == "qq" else None

    def get_event_queue(self):
        return self.queue

    def get_all_stars(self):
        return []


def event(host, sender="123", group=False):
    msg = AstrBotMessage()
    msg.type = MessageType.GROUP_MESSAGE if group else MessageType.FRIEND_MESSAGE
    msg.self_id = "999"
    msg.session_id = "group" if group else sender
    msg.message_id = "human"
    msg.sender = MessageMember(sender, "主人")
    msg.message_str = "hi"
    msg.message = [Plain("hi")]
    msg.raw_message = None
    if group:
        msg.group_id = "group"
    return host.event(msg)


@pytest.fixture
def companion(tmp_path):
    settings = Settings.from_mapping(
        {
            "owner_qq": "123",
            "owner_umo": SCOPE,
            "proactive_enabled": True,
            "min_interval_minutes": 120,
            "max_interval_minutes": 120,
        }
    )
    c = Companion(Host(), settings, Store(tmp_path / "state.db"))
    yield c
    c.store.close()


async def test_scheduled_event_uses_real_adapter_same_owner_queue_and_hooks(companion):
    c = companion
    await c.tick(NOW)
    await c.tick(NOW + timedelta(hours=2))
    synthetic = await c.context.queue.get()
    assert isinstance(synthetic, AiocqhttpMessageEvent)
    assert synthetic.unified_msg_origin == SCOPE
    assert synthetic.is_wake and synthetic.is_at_or_wake_command
    assert synthetic.get_self_id() == "999"
    c.observe(synthetic, NOW + timedelta(hours=2))
    assert c.store.state(SCOPE)["unanswered"] == 1
    req = ProviderRequest(prompt="existing", system_prompt="HOST MEMORY INJECTION")
    c.enrich(synthetic, req)
    assert "HOST MEMORY INJECTION" in req.system_prompt
    assert "自主活动" in req.system_prompt
    assert req.prompt == "existing"
    c.delivered(synthetic, NOW + timedelta(hours=2))
    assert c.store.recent_activities(SCOPE)[0]["status"] == "uncertain"
    human = event(c.context)
    c.observe(human, NOW + timedelta(hours=3))
    assert c.store.state(SCOPE)["unanswered"] == 0


def test_owner_isolation_and_text_cannot_forge_internal_event(companion):
    for e in (event(companion.context, "456"), event(companion.context, group=True)):
        assert not companion.authorized(e)
        req = ProviderRequest(system_prompt="original")
        companion.enrich(e, req)
        assert req.system_prompt == "original"
        with pytest.raises(PermissionError):
            companion.status(e)
    e = event(companion.context)
    e.message_str = "[DSWhale 自主活动]"
    companion.observe(e, NOW)
    assert companion.store.state(SCOPE)["last_human"] == NOW.timestamp()


async def test_pause_or_new_human_cancels_queued_turn(companion):
    await companion.tick(NOW)
    await companion.tick(NOW + timedelta(hours=2))
    synthetic = await companion.context.queue.get()
    companion.observe(event(companion.context), NOW + timedelta(hours=2, minutes=1))
    assert not companion.allow_delivery(synthetic, NOW + timedelta(hours=2, minutes=2))
    assert synthetic.is_stopped()
    assert companion.store.recent_activities(SCOPE)[0]["status"] == "failed"


async def test_queue_failure_does_not_resend(companion):
    async def fail(_):
        raise RuntimeError("down")

    companion.context.queue.put = fail
    await companion.tick(NOW)
    await companion.tick(NOW + timedelta(hours=2))
    assert companion.store.recent_activities(SCOPE)[0]["status"] == "failed"
    await companion.tick(NOW + timedelta(hours=2, minutes=1))
    assert len(companion.store.recent_activities(SCOPE)) == 1


async def test_background_task_terminates(companion):
    companion.start()
    task = companion.task
    await companion.close()
    assert task.done()
    # fixture's repeated close is safe for sqlite


def test_message_subscription_does_not_wake_other_users_or_groups(companion):
    import main

    main.OwnerOnly.settings = companion.settings
    gate = main.OwnerOnly(False)
    assert gate.filter(event(companion.context), {})
    assert not gate.filter(event(companion.context, "456"), {})
    assert not gate.filter(event(companion.context, group=True), {})


def test_schema_matches_validated_defaults():
    import json
    from dataclasses import asdict
    from pathlib import Path

    schema = json.loads(Path("_conf_schema.json").read_text(encoding="utf-8"))
    assert {key: value["default"] for key, value in schema.items()} == asdict(Settings())


async def test_completion_hook_without_transport_success_is_uncertain(companion):
    await companion.tick(NOW)
    await companion.tick(NOW + timedelta(hours=2))
    synthetic = await companion.context.queue.get()
    companion.delivered(synthetic, NOW + timedelta(hours=2))
    assert companion.store.recent_activities(SCOPE)[0]["status"] == "uncertain"


async def test_synthetic_memory_hooks_excluded_without_changing_human(companion):
    companion.context.get_all_stars = lambda: [
        SimpleNamespace(name="astrbot_plugin_livingmemory", activated=True),
        SimpleNamespace(name="astrbot_plugin_dswhale", activated=True),
        SimpleNamespace(name="other_plugin", activated=True),
    ]
    await companion.tick(NOW)
    await companion.tick(NOW + timedelta(hours=2))
    synthetic = await companion.context.queue.get()
    synthetic.plugins_name = None  # normal host WakingStage initialization
    companion.observe(synthetic, NOW + timedelta(hours=2))
    assert synthetic.plugins_name == ["astrbot_plugin_dswhale", "other_plugin"]
    human = event(companion.context)
    companion.observe(human, NOW + timedelta(hours=3))
    assert human.plugins_name is None


async def test_shutdown_cancels_manual_watch_and_cleans_media(companion):
    from contextlib import asynccontextmanager
    from dataclasses import replace

    from dswhale.media import Evidence

    companion.settings = replace(companion.settings, vision_provider_id="vision")
    entered, cleaned, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()

    @asynccontextmanager
    async def read(url):
        try:
            yield Evidence("video", url, 1, (), None, "subtitle")
        finally:
            cleaned.set()

    async def model(**kwargs):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    companion.media.read = read
    companion.context.llm_generate = model
    watching = asyncio.create_task(companion.watch("https://www.bilibili.com/video/BV1xx411c7mD"))
    await entered.wait()
    await companion.close()
    await asyncio.sleep(0)
    try:
        assert cancelled.is_set() and cleaned.is_set()
        assert watching.done()
        with pytest.raises(RuntimeError, match="停止"):
            await companion.watch("https://www.bilibili.com/video/BV1xx411c7mD")
    finally:
        watching.cancel()
        await asyncio.gather(watching, return_exceptions=True)


@pytest.mark.parametrize("fails", [False, True])
async def test_real_host_respond_stage_tracks_transport_result(companion, monkeypatch, fails):
    from unittest.mock import AsyncMock

    from astrbot.core.pipeline.respond import stage as respond_module
    from astrbot.core.utils.metrics import Metric

    monkeypatch.setattr(Metric, "upload", AsyncMock())
    monkeypatch.setattr("dswhale.adapter.now_utc", lambda: NOW + timedelta(hours=2))

    async def transport(**kwargs):
        assert kwargs["user_id"] == 123
        if fails:
            raise RuntimeError("QQ disconnected")

    companion.context.client.send_private_msg = transport
    await companion.tick(NOW)
    await companion.tick(NOW + timedelta(hours=2))
    synthetic = await companion.context.queue.get()
    synthetic.set_result(synthetic.plain_result("你好"))

    async def hook(e, kind, *args, **kwargs):
        companion.delivered(e, NOW + timedelta(hours=2))
        return False

    monkeypatch.setattr(respond_module, "call_event_hook", hook)
    stage = respond_module.RespondStage()
    stage.config = {}
    stage.platform_settings = {}
    stage.enable_seg = False
    stage.only_llm_result = False
    await stage.process(synthetic)
    assert companion.store.recent_activities(SCOPE)[0]["status"] == (
        "uncertain" if fails else "sent"
    )


async def test_memory_read_keeps_original_scope_and_respects_disabled_plugins(companion):
    called = []

    async def recall(wrapper, **kwargs):
        called.append(wrapper.context.event.unified_msg_origin)
        assert kwargs["include_source"] is False
        return '{"count":1,"results":[{"content":"主人喜欢海獭"}]}'

    companion.context.get_all_stars = lambda: [
        SimpleNamespace(name="astrbot_plugin_livingmemory", activated=True),
        SimpleNamespace(name="astrbot_plugin_dswhale", activated=True),
    ]
    companion.context.get_llm_tool_manager = lambda: SimpleNamespace(
        get_func=lambda _: SimpleNamespace(call=recall, active=True)
    )
    await companion.tick(NOW)
    await companion.tick(NOW + timedelta(hours=2))
    synthetic = await companion.context.queue.get()
    companion.observe(synthetic, NOW + timedelta(hours=2))
    await companion.prepare_memory(synthetic)
    assert called == [SCOPE]
    req = ProviderRequest(system_prompt="host")
    companion.enrich(synthetic, req)
    assert "主人喜欢海獭" in req.system_prompt
    human = event(companion.context)
    human.plugins_name = ["astrbot_plugin_dswhale"]
    assert "没有启用" in await companion.recall_memory(human, "海獭")
    assert called == [SCOPE]


async def test_pinned_livingmemory_hooks_and_readonly_tool(companion, monkeypatch):
    """Optional upstream integration: point env at the verified upstream checkout."""
    import importlib
    import os
    from pathlib import Path
    from unittest.mock import AsyncMock

    from astrbot.core.pipeline import context_utils
    from astrbot.core.provider.entities import LLMResponse
    from astrbot.core.star.star import StarMetadata, star_map
    from astrbot.core.star.star_handler import EventType, StarHandlerMetadata, StarHandlerRegistry

    source = os.environ.get("DSWHALE_LIVINGMEMORY_SOURCE")
    if not source:
        pytest.skip("set DSWHALE_LIVINGMEMORY_SOURCE for pinned upstream integration")
    root = await asyncio.to_thread(Path(source).resolve)
    monkeypatch.syspath_prepend(str(root.parent))
    handler_class = importlib.import_module(root.name + ".core.event_handler").EventHandler
    tool_class = importlib.import_module(
        root.name + ".core.tools.memory_search_tool"
    ).MemorySearchTool
    values = {"recall_engine.top_k": 0, "filtering_settings.memory_scope_mode": "session"}
    cfg = SimpleNamespace(
        get=lambda key, default=None: values.get(key, default),
        filtering_settings={"use_persona_filtering": False},
    )
    conversation = SimpleNamespace(
        add_message_from_event=AsyncMock(),
        store=None,
        get_session_info=AsyncMock(return_value=None),
    )
    engine = SimpleNamespace(search_memories=AsyncMock(return_value=[]))
    memory = handler_class(companion.context, cfg, engine, None, conversation)
    metadata = StarMetadata(
        name="astrbot_plugin_livingmemory", module_path="fixture.memory", activated=True
    )
    own = StarMetadata(name="astrbot_plugin_dswhale", module_path="fixture.fish", activated=True)
    monkeypatch.setitem(star_map, metadata.module_path, metadata)
    registry = StarHandlerRegistry()
    for kind, callback in [
        (EventType.OnLLMRequestEvent, memory.handle_memory_recall),
        (EventType.OnLLMResponseEvent, memory.handle_memory_reflection),
    ]:
        registry.append(
            StarHandlerMetadata(
                kind, callback.__name__, callback.__name__, metadata.module_path, callback, []
            )
        )
    monkeypatch.setattr(context_utils, "star_handlers_registry", registry)
    companion.context.get_all_stars = lambda: [metadata, own]
    # Construct the real upstream tool; config-manager validation accepts its own type only,
    # so attach the test boundary collaborators after construction.
    tool = tool_class()
    tool.context, tool.config_manager, tool.memory_engine = companion.context, cfg, engine
    companion.context.get_llm_tool_manager = lambda: SimpleNamespace(get_func=lambda _: tool)
    await companion.tick(NOW)
    await companion.tick(NOW + timedelta(hours=2))
    synthetic = await companion.context.queue.get()
    companion.observe(synthetic, NOW + timedelta(hours=2))
    req = ProviderRequest(prompt=synthetic.message_str)
    await context_utils.call_event_hook(synthetic, EventType.OnLLMRequestEvent, req)
    await context_utils.call_event_hook(
        synthetic,
        EventType.OnLLMResponseEvent,
        LLMResponse(role="assistant", completion_text="我刚看了海獭视频"),
    )
    conversation.add_message_from_event.assert_not_awaited()
    await companion.prepare_memory(synthetic)
    assert engine.search_memories.await_args.kwargs["session_id"] == SCOPE
    human = event(companion.context)
    await context_utils.call_event_hook(
        human, EventType.OnLLMRequestEvent, ProviderRequest(prompt="我喜欢海獭")
    )
    await context_utils.call_event_hook(
        human, EventType.OnLLMResponseEvent, LLMResponse(role="assistant", completion_text="记住啦")
    )
    assert [
        call.kwargs["role"] for call in conversation.add_message_from_event.await_args_list
    ] == ["user", "assistant"]
    await memory.shutdown()


async def test_expired_queued_event_never_becomes_a_human_event(companion):
    await companion.tick(NOW)
    await companion.tick(NOW + timedelta(hours=2))
    synthetic = await companion.context.queue.get()
    await companion.tick(NOW + timedelta(hours=3))
    companion.observe(synthetic, NOW + timedelta(hours=3))
    assert companion.internal_id(synthetic) is not None
    assert companion.store.state(SCOPE)["last_human"] == 0
    assert not companion.allow_delivery(synthetic, NOW + timedelta(hours=3))


async def test_streaming_success_is_recorded_without_host_completion_hook(companion, monkeypatch):
    from unittest.mock import AsyncMock

    from astrbot.api.event import MessageChain
    from astrbot.core.utils.metrics import Metric

    monkeypatch.setattr(Metric, "upload", AsyncMock())
    monkeypatch.setattr("dswhale.adapter.now_utc", lambda: NOW + timedelta(hours=2))
    companion.context.client.send_private_msg = AsyncMock()
    await companion.tick(NOW)
    await companion.tick(NOW + timedelta(hours=2))
    synthetic = await companion.context.queue.get()

    async def stream():
        yield MessageChain([Plain("你好")])

    await synthetic.send_streaming(stream(), False)
    assert companion.store.recent_activities(SCOPE)[0]["status"] == "sent"


@pytest.mark.parametrize("streaming", [False, True])
async def test_empty_host_message_is_not_marked_submitted(companion, monkeypatch, streaming):
    from unittest.mock import AsyncMock

    from astrbot.api.event import MessageChain
    from astrbot.core.utils.metrics import Metric

    monkeypatch.setattr(Metric, "upload", AsyncMock())
    monkeypatch.setattr("dswhale.adapter.now_utc", lambda: NOW + timedelta(hours=2))
    transport = AsyncMock()
    companion.context.client.send_private_msg = transport
    await companion.tick(NOW)
    await companion.tick(NOW + timedelta(hours=2))
    synthetic = await companion.context.queue.get()
    chain = MessageChain([Plain("   \n")])
    if streaming:

        async def chunks():
            yield chain

        await synthetic.send_streaming(chunks())
    else:
        await synthetic.send(chain)
        companion.delivered(synthetic, NOW + timedelta(hours=2))
    transport.assert_not_awaited()
    assert not synthetic.get_extra("dswhale_transport_succeeded", False)
    assert companion.store.recent_activities(SCOPE)[0]["status"] != "sent"
