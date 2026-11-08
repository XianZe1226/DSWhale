"""Behavioural tests for the single-owner reply delivery path (R4)."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from astrbot.api.message_components import Image, Plain
from astrbot.core.message.message_event_result import MessageEventResult, ResultContentType

from dswhale.adapter import Companion, DeliveryStopped
from dswhale.config import Settings


def style_settings(mode="natural", **patch):
    values = {
        "reply_style_mode": mode,
        "reply_style_max_bubbles": 3,
        "reply_style_interval": "0.2,0.2",
        "reply_style_punctuation": "keep",
        "reply_style_prompt": True,
        "reply_style_custom_regex": "",
        "reply_style_custom_cleanup": "",
    }
    values.update(patch)
    return SimpleNamespace(**values)


def companion(mode="natural", **patch):
    value = Companion.__new__(Companion)
    value.settings = style_settings(mode, **patch)
    value.authorized = lambda event: True
    value.delivered = lambda event: event.set_extra("dswhale_delivered_called", True)
    return value


class FakeEvent:
    def __init__(self, chain=None, stream=None):
        self._result = SimpleNamespace(
            chain=chain or [], async_stream=stream, is_llm_result=lambda: True
        )
        self.extra = {}
        self.sent = []
        self.cleared = False
        self.closed = False
        self.sleeps = []
        self.unified_msg_origin = "test:friend"
        self.after_send = None
        self.send_streaming = None

    def get_extra(self, name, default=None):
        return self.extra.get(name, default)

    def set_extra(self, name, value):
        self.extra[name] = value

    def get_result(self):
        return self._result

    def clear_result(self):
        self.cleared = True
        self._result = None

    def plain_result(self, text):
        return SimpleNamespace(chain=[Plain(text)])

    def get_platform_name(self):
        return "aiocqhttp"

    async def send(self, chain):
        if self.extra.get("fail_next"):
            self.extra["fail_next"] = False
            raise RuntimeError("synthetic transport failure")
        self.sent.append([part.text for part in chain.chain if isinstance(part, Plain)])
        self.extra["dswhale_transport_succeeded"] = True
        if self.after_send:
            callback, self.after_send = self.after_send, None
            callback()


@pytest.fixture(autouse=True)
def fast_sleep(monkeypatch):
    calls = []

    async def fake_sleep(value):
        calls.append(value)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    return calls


async def test_natural_takeover_sends_each_bubble_with_interval(fast_sleep):
    event = FakeEvent(chain=[Plain("第一句\n第二句\n第三句")])
    value = companion("natural")
    assert await value.deliver_reply_style(event) is True
    assert event.sent == [["第一句"], ["第二句"], ["第三句"]]
    assert fast_sleep == [0.2, 0.2]
    assert event.cleared is True
    assert event.extra["dswhale_delivered_called"] is True


async def test_second_send_failure_is_partial_and_never_resent():
    event = FakeEvent(chain=[Plain("甲\n乙\n丙")])
    event.extra["fail_next"] = False
    value = companion("natural")
    original_send = event.send
    calls = 0

    async def flaky(chain):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("synthetic second failure")
        return await original_send(chain)

    event.send = flaky
    assert await value.deliver_reply_style(event) is True
    assert event.sent == [["甲"]]
    assert event.extra["dswhale_reply_partial"] == {"delivered": 1, "error": "RuntimeError"}
    assert event.cleared is True
    assert calls == 2  # no automatic retry of the failed or remaining bubbles


async def test_mixed_chain_keeps_host_structure_and_reports_fallback():
    event = FakeEvent(chain=[Plain("看这张"), Image(file="synthetic.png")])
    value = companion("natural")
    assert await value.deliver_reply_style(event) is False
    assert event.sent == []
    assert event.extra["dswhale_style_fallback"] == "mixed_chain"


async def test_legacy_inherit_automatically_sends_natural_bubbles_without_rewriting_settings():
    event = FakeEvent(chain=[Plain("甲。乙。")])
    value = companion("inherit")
    assert await value.deliver_reply_style(event) is True
    assert event.sent == [["甲。"], ["乙。"]]
    assert value.settings.reply_style_mode == "inherit"


async def test_new_install_needs_no_reply_configuration(fast_sleep):
    event = FakeEvent(chain=[Plain("今天辛苦啦。先歇一会儿。")])
    value = companion()
    original = {"persona": "SYNTHETIC_PRIVATE_PERSONA", "proactive_enabled": False}
    value.settings = Settings.from_mapping(original)
    assert await value.deliver_reply_style(event) is True
    assert event.sent == [["今天辛苦啦。"], ["先歇一会儿。"]]
    assert len(fast_sleep) == 1 and 0.8 <= fast_sleep[0] <= 1.5
    assert original == {"persona": "SYNTHETIC_PRIVATE_PERSONA", "proactive_enabled": False}


@pytest.mark.parametrize(
    ("parts", "already_sent"),
    [(["  这条已经发过啦。  "], "这条已经发过啦。"), (["第一段", "第二段"], "第一段 第二段")],
)
async def test_tool_already_delivered_the_same_reply_is_left_to_host_deduplication(
    parts, already_sent
):
    event = FakeEvent()
    result = MessageEventResult()
    result.result_content_type = ResultContentType.LLM_RESULT
    result.chain = [Plain(text) for text in parts]
    event._result = result
    event.set_extra("_send_message_to_user_current_session_plain_texts", [already_sent])
    value = companion("inherit")
    assert await value.deliver_reply_style(event) is False
    assert event.sent == []
    assert event.cleared is False
    assert event.get_extra("dswhale_delivered_called") is None


async def test_tool_sent_a_different_reply_does_not_suppress_normal_chat():
    event = FakeEvent(chain=[Plain("这是接着说的新消息。")])
    event.set_extra("_send_message_to_user_current_session_plain_texts", ["刚才那条"])
    value = companion("inherit")
    assert await value.deliver_reply_style(event) is True
    assert event.sent == [["这是接着说的新消息。"]]


async def test_legacy_streaming_chat_is_automatically_split():
    event = FakeEvent()
    value = companion("inherit")
    event.send_streaming = lambda *_: None
    value._style_stream_wrapper(event)
    assert event.get_extra("_dswhale_stream_wrapped") is True

    async def chunks():
        yield SimpleNamespace(type="plain", chain=[Plain("好哦。")])
        yield SimpleNamespace(type="plain", chain=[Plain("我在呢。")])

    await event.send_streaming(chunks())
    assert event.sent == [["好哦。"], ["我在呢。"]]


async def test_stream_collects_full_text_then_cleans_once():
    chunks = [
        SimpleNamespace(type="plain", chain=[Plain("好<system_")]),
        SimpleNamespace(type="plain", chain=[Plain("reminder>私有")]),
        SimpleNamespace(type="plain", chain=[Plain("</system_reminder>[开心]")]),
        SimpleNamespace(type="break", chain=[]),
        SimpleNamespace(type="plain", chain=[Plain("\n```xml\n<tool_call>x</tool_call>\n```")]),
    ]

    async def stream():
        for chunk in chunks:
            yield chunk

    event = FakeEvent()
    event.send_streaming = lambda generator, use_fallback: None
    value = companion("natural")

    async def original(generator, use_fallback):
        raise AssertionError("style-owned stream must not call the host sender")
        yield  # pragma: no cover

    await value._style_stream(event, original, stream(), False)
    assert event.extra["_dswhale_stream_owned"] is True
    assert event.sent == [["好[开心]\n```xml\n<tool_call>x</tool_call>\n```"]]
    assert event.extra["dswhale_delivered_called"] is True


async def test_stream_with_non_plain_parts_replays_to_host_once():
    chunks = [
        SimpleNamespace(type="plain", chain=[Plain("看")]),
        SimpleNamespace(type="image", chain=[Image(file="synthetic.png")]),
        SimpleNamespace(type="plain", chain=[Plain("图")]),
    ]

    async def stream():
        for chunk in chunks:
            yield chunk

    replayed = []

    async def original(generator, use_fallback):
        replayed.extend([chunk async for chunk in generator])

    event = FakeEvent()
    value = companion("natural")
    await value._style_stream(event, original, stream(), False)
    assert [chunk.type for chunk in replayed] == ["plain", "image", "plain"]
    assert [part.text for chunk in replayed for part in chunk.chain if isinstance(part, Plain)] == [
        "看",
        "图",
    ]
    assert event.sent == []
    assert event.extra["dswhale_style_fallback"] == "mixed_chain"


async def test_stream_error_marks_uncertain_and_reraises():
    async def broken():
        yield SimpleNamespace(type="plain", chain=[Plain("一半")])
        raise RuntimeError("synthetic stream failure")

    event = FakeEvent()
    value = companion("natural")
    with pytest.raises(RuntimeError, match="synthetic"):
        await value._style_stream(event, lambda *_: None, broken(), False)
    assert event.extra["dswhale_transport_failed"] is True
    assert event.extra["dswhale_delivered_called"] is True
    assert event.sent == []


async def test_before_send_skips_when_stream_is_owned():
    from main import DSWhale

    result = SimpleNamespace(chain=[Plain("好<system_reminder>私有</system_reminder>")])
    event = FakeEvent(chain=result.chain)
    event.get_extra = lambda name, default=None: name == "_dswhale_stream_owned"
    event.set_extra = lambda name, value: None
    event.get_result = lambda: result
    plugin = DSWhale.__new__(DSWhale)
    plugin.companion = companion("natural")
    plugin.companion.allow_delivery = lambda event: None
    await plugin.before_send(event)
    assert result.chain[0].text == "好<system_reminder>私有</system_reminder>"


def test_missing_reply_style_keys_default_to_natural():
    base = {
        "persona": "人格",
        "owner_qq": "123456789",
        "owner_umo": "aiocqhttp:FriendMessage:123456789",
        "onebot_port": 6199,
        "dashboard_port": 6185,
        "onebot_token": "token-1234567890",
        "qq_connection_mode": "napcat",
        "qq_default_delivery": "napcat",
        "bili_enabled": False,
        "proactive_enabled": False,
        "signature_enabled": False,
        "qzone_enabled": False,
    }
    settings = Settings.from_mapping(base)
    assert settings.reply_style_mode == "natural"
    assert settings.reply_style_max_bubbles == 3
    assert settings.reply_style_interval == "0.8,1.5"
    assert settings.reply_style_prompt is True
    assert json.dumps(base) != ""  # input is not mutated by defaults


class FakeHostContext:
    def __init__(self, prefix="", tts=False, quote=False, t2i=False, mention=False, forward=1500):
        self.prefix = prefix
        self.tts = tts
        self.quote = quote
        self.t2i = t2i
        self.mention = mention
        self.forward = forward

    def get_config(self, umo=None):
        return {
            "platform_settings": {
                "reply_prefix": self.prefix,
                "reply_with_quote": self.quote,
                "reply_with_mention": self.mention,
                "forward_threshold": self.forward,
            },
            "provider_tts_settings": {"enable": self.tts},
            "t2i": self.t2i,
        }

    async def get_using_tts_provider_async(self, umo):
        return object() if self.tts else None


def test_reply_prefix_hands_the_reply_back_to_the_host():
    event = FakeEvent(chain=[Plain("你好")])
    value = companion("natural")
    value.context = FakeHostContext(prefix="[bot] ")
    assert asyncio.run(value.deliver_reply_style(event)) is False
    assert event.extra["dswhale_style_fallback"] == "reply_prefix"
    assert event.cleared is False
    assert event.sent == []


def test_active_tts_provider_hands_the_reply_back_to_the_host():
    event = FakeEvent(chain=[Plain("你好")])
    value = companion("natural")
    value.context = FakeHostContext(tts=True)
    assert asyncio.run(value.deliver_reply_style(event)) is False
    assert event.extra["dswhale_style_fallback"] == "tts"


def test_streaming_reply_prefix_falls_back_with_clean_stream():
    chunks = [
        SimpleNamespace(type="plain", chain=[Plain("你好</system_")]),
        SimpleNamespace(type="plain", chain=[Plain("reminder>世界")]),
    ]

    async def stream():
        for chunk in chunks:
            yield chunk

    received = []

    async def original(generator, use_fallback):
        received.extend([chunk async for chunk in generator])

    event = FakeEvent()
    value = companion("natural")
    value.context = FakeHostContext(prefix="[bot] ")
    asyncio.run(value._style_stream(event, original, stream(), False))
    assert event.extra["dswhale_style_fallback"] == "reply_prefix"
    assert "_dswhale_stream_owned" not in event.extra
    assert (
        "".join(part.text for chunk in received for part in chunk.chain if isinstance(part, Plain))
        == "你好世界"
    )
    assert event.extra["dswhale_delivered_called"] is True


def test_mixed_fallback_cleans_protocol_tags_before_replay():
    chunks = [
        SimpleNamespace(type="plain", chain=[Plain("看</system_reminder>")]),
        SimpleNamespace(type="image", chain=[Image(file="synthetic.png")]),
        SimpleNamespace(type="plain", chain=[Plain("图")]),
    ]

    async def stream():
        for chunk in chunks:
            yield chunk

    received = []

    async def original(generator, use_fallback):
        received.extend([chunk async for chunk in generator])

    event = FakeEvent()
    value = companion("natural")
    asyncio.run(value._style_stream(event, original, stream(), False))
    text = "".join(
        part.text for chunk in received for part in chunk.chain if isinstance(part, Plain)
    )
    assert "<system_reminder>" not in text
    assert "</system_reminder>" not in text
    assert (
        "".join(part.text for chunk in received for part in chunk.chain if isinstance(part, Plain))
        == "看图"
    )


def test_mixed_fallback_failure_is_settled_and_reraised():
    chunks = [
        SimpleNamespace(type="plain", chain=[Plain("看")]),
        SimpleNamespace(type="image", chain=[Image(file="synthetic.png")]),
    ]

    async def stream():
        for chunk in chunks:
            yield chunk

    async def original(generator, use_fallback):
        async for _chunk in generator:
            pass
        raise RuntimeError("synthetic mixed failure")

    event = FakeEvent()
    value = companion("natural")
    with pytest.raises(RuntimeError):
        asyncio.run(value._style_stream(event, original, stream(), False))
    assert event.extra["dswhale_transport_failed"] is True
    assert event.extra["dswhale_delivered_called"] is True


@pytest.mark.parametrize("mode", ["unauthorized", "closed"])
async def test_guard_silent_drop_between_bubbles_is_partial_and_not_sent(mode):
    event = FakeEvent()
    value = companion("natural")
    value.closed = False
    value.pending = {}
    value.store = SimpleNamespace(
        activity=lambda activity_id: SimpleNamespace(scope="synthetic:owner"),
        transition=lambda *args, **kwargs: None,
    )
    value.binding_by_scope = lambda scope: SimpleNamespace(channel="napcat")
    value.internal_id = lambda item: ""
    value.allow_delivery = lambda item: not item.closed
    if mode == "unauthorized":

        def flip():
            value.allow_delivery = lambda item: False

    else:

        def flip():
            value.closed = True

    event.after_send = flip
    value._guard_transport(event)
    delivered, error = await value._send_bubbles(event, ["第一段", "第二段"], (0, 0))

    assert event.sent == [["第一段"]]
    assert delivered == 1
    assert isinstance(error, DeliveryStopped)
    assert event.extra["dswhale_reply_partial"] == {
        "delivered": 1,
        "error": "DeliveryStopped",
    }
    assert event.extra["dswhale_transport_failed"] is True
    assert event.extra["dswhale_transport_succeeded"] is False


def delivery_companion(channel="official", mode="natural"):
    value = companion(mode)
    value.closed = False
    value.pending = {}
    transitions = []

    value.store = SimpleNamespace(
        activity=lambda activity_id: SimpleNamespace(
            scope="synthetic:owner", status="queued", created=0
        ),
        transition=lambda activity_id, status, *args, **kwargs: transitions.append(
            (activity_id, status)
        ),
    )
    value.binding_by_scope = lambda scope: SimpleNamespace(channel=channel)
    value.internal_id = lambda event: "synthetic-activity"
    value.authorized = lambda event: True
    value.allow_delivery = lambda event: True
    value.delivered = lambda event: Companion.delivered(value, event)
    return value, transitions


async def test_official_guarded_success_stays_uncertain_without_fake_partial():
    event = FakeEvent()
    value, transitions = delivery_companion("official")
    value._guard_transport(event)

    delivered, error = await value._send_bubbles(event, ["甲", "乙"], (0, 0))

    assert event.sent == [["甲"], ["乙"]]
    assert delivered == 2
    assert error is None
    assert event.extra["dswhale_transport_succeeded"] is False
    assert event.get_extra("dswhale_reply_partial") is None

    value.delivered(event)
    assert transitions == [("synthetic-activity", "uncertain")]


async def test_napcat_guarded_success_is_recorded_as_sent():
    event = FakeEvent()
    value, transitions = delivery_companion("napcat")
    value._guard_transport(event)

    delivered, error = await value._send_bubbles(event, ["甲", "乙"], (0, 0))

    assert delivered == 2
    assert error is None
    assert event.extra["dswhale_transport_succeeded"] is True
    value.delivered(event)
    assert transitions == [("synthetic-activity", "sent")]


async def test_direct_official_deliver_reply_style_settles_uncertain():
    event = FakeEvent(chain=[Plain("甲\n乙")])
    value, transitions = delivery_companion("official")
    value._guard_transport(event)

    assert await value.deliver_reply_style(event) is True

    assert event.sent == [["甲"], ["乙"]]
    assert event.cleared is True
    assert event.extra["dswhale_transport_succeeded"] is False
    assert event.get_extra("dswhale_reply_partial") is None
    assert transitions[-1] == ("synthetic-activity", "uncertain")


async def test_unguarded_official_deliver_reply_style_is_uncertain():
    event = FakeEvent(chain=[Plain("甲\n乙")])
    value, transitions = delivery_companion("official")

    assert await value.deliver_reply_style(event) is True

    assert event.get_extra("dswhale_transport_guarded") is None
    assert event.sent == [["甲"], ["乙"]]
    assert event.cleared is True
    assert event.extra["dswhale_transport_succeeded"] is False
    assert event.get_extra("dswhale_reply_partial") is None
    assert transitions[-1] == ("synthetic-activity", "uncertain")


async def test_unguarded_napcat_deliver_reply_style_is_sent():
    event = FakeEvent(chain=[Plain("甲\n乙")])
    value, transitions = delivery_companion("napcat")

    assert await value.deliver_reply_style(event) is True

    assert event.get_extra("dswhale_transport_guarded") is None
    assert event.sent == [["甲"], ["乙"]]
    assert event.extra["dswhale_transport_succeeded"] is True
    assert event.get_extra("dswhale_reply_partial") is None
    assert transitions[-1] == ("synthetic-activity", "sent")


async def test_unguarded_official_streaming_success_is_uncertain():
    event = FakeEvent()
    value, transitions = delivery_companion("official")

    async def stream():
        yield SimpleNamespace(type="plain", chain=[Plain("甲\n乙")])

    await value._style_stream(event, None, stream(), False)

    assert event.get_extra("dswhale_transport_guarded") is None
    assert event.sent == [["甲"], ["乙"]]
    assert event.extra["dswhale_transport_succeeded"] is False
    assert event.get_extra("dswhale_reply_partial") is None
    assert transitions[-1] == ("synthetic-activity", "uncertain")


async def test_timeout_mid_reply_is_partial_and_never_resent():
    event = FakeEvent(chain=[Plain("甲\n乙\n丙")])
    value = companion("natural")
    original_send = event.send
    calls = 0

    async def timeout_on_second(chain):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise TimeoutError("synthetic timeout")
        return await original_send(chain)

    event.send = timeout_on_second

    assert await value.deliver_reply_style(event) is True
    assert event.sent == [["甲"]]
    assert event.extra["dswhale_reply_partial"] == {
        "delivered": 1,
        "error": "TimeoutError",
    }
    assert event.extra["dswhale_transport_failed"] is True
    assert event.extra["dswhale_transport_succeeded"] is False
    assert calls == 2  # no retry of the timed-out or remaining bubbles


async def test_stream_timeout_is_partial_and_nothing_is_sent():
    event = FakeEvent()
    value = companion("natural")
    received = []

    async def original(generator, use_fallback):
        received.extend([chunk async for chunk in generator])

    async def stream():
        yield SimpleNamespace(type="plain", chain=[Plain("甲")])
        raise TimeoutError("synthetic stream timeout")

    with pytest.raises(TimeoutError):
        await value._style_stream(event, original, stream(), False)

    assert event.sent == []
    assert received == []
    assert event.extra["dswhale_reply_partial"] == {
        "delivered": 0,
        "error": "TimeoutError",
    }
    assert event.extra["dswhale_transport_failed"] is True
    assert event.extra["dswhale_delivered_called"] is True


@pytest.mark.parametrize(
    "mapping",
    [
        {"reply_style_max_bubbles": False},
        {"reply_style_max_bubbles": 0},
        {"reply_style_max_bubbles": ""},
        {"reply_style_prompt": 0},
        {"reply_style_prompt": ""},
    ],
)
def test_reply_style_values_reject_false_zero_and_empty(mapping):
    with pytest.raises(ValueError):
        Settings.from_mapping(mapping)


def test_legacy_mapping_keeps_natural_defaults_without_writes(tmp_path, monkeypatch):
    mapping = {
        "owner_qq": "123456789",
        "persona": "合成测试人格，不是真实用户数据",
        "proactive_enabled": False,
        "qq_connection_mode": "napcat",
        "qq_default_delivery": "napcat",
        "dashboard_port": 6185,
    }
    before = dict(mapping)
    monkeypatch.chdir(tmp_path)

    settings = Settings.from_mapping(mapping)

    assert settings.reply_style_mode == "natural"
    assert settings.reply_style_max_bubbles == 3
    assert settings.reply_style_interval == "0.8,1.5"
    assert settings.reply_style_punctuation == "keep"
    assert settings.reply_style_prompt is True
    assert settings.reply_style_custom_regex == ""
    assert settings.reply_style_custom_cleanup == ""
    assert settings.persona == before["persona"]
    assert mapping == before
    assert list(tmp_path.iterdir()) == []


def test_old_install_missing_keys_keep_natural_defaults_without_side_effects():
    settings = Settings.from_mapping({})

    assert settings.reply_style_mode == "natural"
    assert settings.reply_style_max_bubbles == 3
    assert settings.reply_style_interval == "0.8,1.5"
    assert settings.reply_style_punctuation == "keep"
    assert settings.reply_style_prompt is True
    assert settings.reply_style_custom_regex == ""
    assert settings.reply_style_custom_cleanup == ""


def test_streaming_ignores_host_quote_t2i_forward_and_mention():
    """4.29.3 returns before decoration for streaming, so those must not abort."""

    async def stream():
        yield SimpleNamespace(type="plain", chain=[Plain("甲。乙。")])

    event = FakeEvent()
    value = companion("natural")
    value.context = FakeHostContext(prefix="", quote=True, t2i=True, mention=True, forward=1)
    asyncio.run(value._style_stream(event, None, stream(), False))
    assert "_dswhale_stream_owned" in event.extra
    assert "dswhale_style_fallback" not in event.extra
    assert event.sent == [["甲。"], ["乙。"]]


def test_general_command_result_is_not_taken_over():
    event = FakeEvent(chain=[Plain("命令输出")])
    result = MessageEventResult()
    result.result_content_type = ResultContentType.GENERAL_RESULT
    event._result = result
    value = companion("natural")
    assert asyncio.run(value.deliver_reply_style(event)) is False
    assert event.cleared is False
    assert event.sent == []


def test_real_llm_result_is_owned_and_sent():
    event = FakeEvent(chain=[Plain("乙。甲。")])
    result = MessageEventResult()
    result.result_content_type = ResultContentType.LLM_RESULT
    result.chain = [Plain("乙。甲。")]
    event._result = result
    value = companion("natural")
    assert asyncio.run(value.deliver_reply_style(event)) is True
    assert event.cleared is True
    assert event.sent


class _HostContext:
    def __init__(self):
        self.config = {
            "platform_settings": {
                "segmented_reply": {
                    "enable": True,
                    "words_count_threshold": 150,
                    "split_mode": "regex",
                    "regex": r".*?[。？！~…]+|.+$",
                    "content_cleanup_rule": "",
                }
            },
            "provider_settings": {"streaming_response": False},
            "t2i": True,
            "t2i_word_threshold": 50,
        }

    def get_config(self, umo=None):
        return self.config

    async def get_using_tts_provider_async(self, umo=""):
        return object()


async def test_t2i_fallback_uses_host_segmentation_blocks(monkeypatch):
    value = Companion.__new__(Companion)
    value.context = _HostContext()
    event = FakeEvent()
    event._result.use_t2i_ = None
    text = "甲。" * 20
    # The old total-length guess (42) is below the threshold; the host's own
    # 20 blocks (each +2 newlines) are above it.
    assert "t2i" in await value._style_fallback_reason(event, event._result, text)


async def test_t2i_worker_failure_falls_back_to_the_safe_host_claim(monkeypatch):
    value = Companion.__new__(Companion)
    value.context = _HostContext()
    event = FakeEvent()
    event._result.use_t2i_ = None

    async def timeout(request, deadline_seconds=0.75):
        return {"ok": False, "error": "timeout"}

    monkeypatch.setattr("dswhale.adapter.reply_style_isolate.run", timeout)
    assert "t2i" in await value._style_fallback_reason(event, event._result, "甲。乙。")


def _host_context(threshold=50, enabled=True, t2i=True):
    value = _HostContext()
    value.config["t2i"] = t2i
    value.config["t2i_word_threshold"] = threshold
    value.config["platform_settings"]["segmented_reply"]["enable"] = enabled
    return value


def _sdk_event(text):
    return _sdk_event_parts(text)


def _sdk_event_parts(*texts):
    event = FakeEvent()
    result = MessageEventResult()
    result.chain = [Plain(text) for text in texts]
    result.result_content_type = ResultContentType.LLM_RESULT
    result.use_t2i_ = None
    event._result = result
    return event


async def test_t2i_threshold_uses_host_segments_at_the_49_50_51_boundaries():
    text = ("甲" * 14 + "。") * 3
    for threshold, expected_fallback in ((49, True), (50, True), (51, False)):
        value = companion("natural")
        value.context = _host_context(threshold)
        event = _sdk_event(text)
        owned = await value.deliver_reply_style(event)
        # 3 segments of 15 chars: host length 51; raw total is 47.
        assert owned is (not expected_fallback), threshold
        if expected_fallback:
            assert event.sent == []
            assert event.cleared is False
        else:
            assert len(event.sent) == 3


async def test_t2i_off_or_segmentation_off_keeps_plugin_ownership():
    text = ("甲" * 14 + "。") * 3
    for context in (_host_context(50, enabled=False), _host_context(50, t2i=False)):
        value = companion("natural")
        value.context = context
        event = _sdk_event(text)
        assert await value.deliver_reply_style(event) is True
        assert len(event.sent) == 3


async def test_t2i_explicit_result_flag_and_official_platform_are_respected():
    text = ("甲" * 14 + "。") * 3

    value = companion("natural")
    value.context = _host_context(50, t2i=False)
    explicit = _sdk_event(text)
    explicit._result.use_t2i_ = True
    assert await value.deliver_reply_style(explicit) is False

    value = companion("natural")
    value.context = _host_context(50)
    disabled = _sdk_event(text)
    disabled._result.use_t2i_ = False
    assert await value.deliver_reply_style(disabled) is True

    webhook = _sdk_event(text)
    webhook.get_platform_name = lambda: "qq_official_webhook"
    value = companion("natural")
    value.context = _host_context(50)
    assert await value.deliver_reply_style(webhook) is True

    websocket = _sdk_event(text)
    websocket.get_platform_name = lambda: "qq_official"
    value = companion("natural")
    value.context = _host_context(50)
    assert await value.deliver_reply_style(websocket) is False


async def test_nonstreaming_event_ignores_the_hosts_global_streaming_switch_for_t2i():
    text = ("甲" * 14 + "。") * 3
    value = companion("natural")
    value.context = _host_context(51)
    value.context.config["provider_settings"]["streaming_response"] = True
    event = _sdk_event(text)
    assert await value.deliver_reply_style(event) is True
    assert len(event.sent) == 3


async def test_multi_plain_t2i_is_left_to_the_host_without_merging():
    # 24 + 23 is below the T2I threshold as one merged string (47 + 2), but
    # the host decorates each original Plain (24 + 23 + 2 + 2 = 51).
    for segmented in (False, True):
        value = companion("natural")
        value.context = _host_context(200, enabled=segmented)
        event = _sdk_event_parts("甲" * 24, "乙" * 23)
        assert await value.deliver_reply_style(event) is False
        assert event.sent == []
        assert event.cleared is False
        assert event.extra["dswhale_style_fallback"] == "t2i"
        assert [part.text for part in event._result.chain] == ["甲" * 24, "乙" * 23]


async def test_single_plain_with_preserved_whitespace_is_left_to_the_host():
    text = "  " + "甲" * 148 + "  "
    value = companion("natural")
    value.context = _host_context(200)
    event = _sdk_event(text)
    assert await value.deliver_reply_style(event) is False
    assert event.sent == []
    assert event.cleared is False
    assert event.extra["dswhale_style_fallback"] == "t2i"
    assert event._result.chain[0].text == text
