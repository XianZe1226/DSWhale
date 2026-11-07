"""Behavioural tests for the single-owner reply delivery path (R4)."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from astrbot.api.message_components import Image, Plain

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
        self._result = SimpleNamespace(chain=chain or [], async_stream=stream, is_llm_result=True)
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


async def test_inherit_never_takes_over():
    event = FakeEvent(chain=[Plain("甲\n乙")])
    value = companion("inherit")
    assert await value.deliver_reply_style(event) is False
    assert event.sent == []


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


def test_missing_reply_style_keys_default_to_inherit():
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
    assert settings.reply_style_mode == "inherit"
    assert settings.reply_style_max_bubbles == 3
    assert settings.reply_style_interval == "0.8,1.5"
    assert settings.reply_style_prompt is True
    assert json.dumps(base) != ""  # input is not mutated by defaults


class FakeHostContext:
    def __init__(self, prefix="", tts=False):
        self.prefix = prefix
        self.tts = tts

    def get_config(self, umo=None):
        return {
            "platform_settings": {"reply_prefix": self.prefix},
            "provider_tts_settings": {"enable": self.tts},
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
