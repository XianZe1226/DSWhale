"""Actual ResultDecorateStage regressions for conservative T2I ownership."""

from types import SimpleNamespace

from astrbot.core.message.components import Image, Plain
from astrbot.core.message.message_event_result import MessageEventResult, ResultContentType
from astrbot.core.pipeline.result_decorate import stage as stage_module
from astrbot.core.pipeline.result_decorate.stage import ResultDecorateStage
from astrbot.core.platform.message_type import MessageType

from dswhale.adapter import Companion


def host_config(*, t2i_threshold, segmented_threshold=150, segmented=True):
    return {
        "platform_settings": {
            "reply_prefix": "",
            "reply_with_mention": False,
            "reply_with_quote": False,
            "forward_threshold": 100000,
            "segmented_reply": {
                "enable": segmented,
                "only_llm_result": True,
                "interval": "0.8,1.5",
                "words_count_threshold": segmented_threshold,
                "split_mode": "regex",
                "regex": r".*?[。？！~…]+|.+$",
                "content_cleanup_rule": "",
            },
        },
        "t2i": True,
        "t2i_word_threshold": t2i_threshold,
        "t2i_strategy": "local",
        "t2i_active_template": "base",
        "t2i_use_file_service": False,
        "callback_api_base": "",
        "provider_tts_settings": {"enable": False, "trigger_probability": 0},
        "content_safety": {"also_use_in_response": False},
        "provider_settings": {"display_reasoning_text": False},
    }


class HostContext:
    def __init__(self, config):
        self.config = config

    def get_config(self, umo):
        return self.config

    async def get_using_tts_provider_async(self, umo):
        return None


def plugin(mode, config):
    value = Companion.__new__(Companion)
    value.settings = SimpleNamespace(reply_style_mode=mode, delivery_binding=None)
    value.context = HostContext(config)
    value.authorized = lambda event: True
    value.delivered = lambda event: event.set_extra("dswhale_delivered_called", True)
    return value


class StageEvent:
    def __init__(self, *texts):
        self.result = MessageEventResult([Plain(text) for text in texts])
        self.result.result_content_type = ResultContentType.LLM_RESULT
        self.result.use_t2i_ = None
        self.extra = {}
        self.sent = []
        self.cleared = False
        self.unified_msg_origin = "aiocqhttp:FriendMessage:1"
        self.plugins_name = None
        self.message_obj = SimpleNamespace(message_id="m1")

    def get_result(self):
        return self.result

    def clear_result(self):
        self.cleared = True
        self.result = None

    def get_extra(self, name, default=None):
        return self.extra.get(name, default)

    def set_extra(self, name, value):
        self.extra[name] = value

    def get_platform_name(self):
        return "aiocqhttp"

    def get_message_type(self):
        return MessageType.FRIEND_MESSAGE

    def get_sender_id(self):
        return "1"

    def get_sender_name(self):
        return "tester"

    def get_self_id(self):
        return "bot"

    def is_stopped(self):
        return False

    async def send(self, chain):
        self.sent.append(chain)
        raise AssertionError("the plugin must leave T2I to the host")


async def run_stage(event, config):
    context = SimpleNamespace(
        get_using_tts_provider_async=lambda umo: _no_tts(),
    )
    ctx = SimpleNamespace(
        plugin_manager=SimpleNamespace(context=context),
        astrbot_config=config,
    )
    stage = ResultDecorateStage()
    await stage.initialize(ctx)
    async for _ in stage.process(event):
        pass


async def _no_tts():
    return None


def one_image(event):
    chain = event.get_result().chain
    assert len(chain) == 1, [type(part).__name__ for part in chain]
    assert isinstance(chain[0], Image)
    return chain[0]


async def test_multi_plain_t2i_actual_stage_renders_one_image(monkeypatch):
    calls = []

    async def render(text, **kwargs):
        calls.append(text)
        return "https://img.example/t2i.png"

    monkeypatch.setattr(stage_module.html_renderer, "render_t2i", render)
    monkeypatch.setattr(
        stage_module.star_handlers_registry,
        "get_handlers_by_event_type",
        lambda *args, **kwargs: [],
    )

    expected = "\n\n" + "甲" * 24 + "\n\n" + "乙" * 23
    assert len(expected) == 51
    for segmented in (False, True):
        config = host_config(t2i_threshold=50, segmented=segmented)

        inherited = StageEvent("甲" * 24, "乙" * 23)
        await run_stage(inherited, config)
        one_image(inherited)
        assert calls[-1] == expected

        natural = StageEvent("甲" * 24, "乙" * 23)
        owned = await plugin("natural", config).deliver_reply_style(natural)
        assert owned is False
        assert natural.extra["dswhale_style_fallback"] == "t2i"
        assert natural.sent == []
        assert natural.cleared is False
        await run_stage(natural, config)
        one_image(natural)
        assert calls[-1] == expected


async def test_preserved_whitespace_t2i_actual_stage_renders_one_image(monkeypatch):
    calls = []

    async def render(text, **kwargs):
        calls.append(text)
        return "https://img.example/t2i.png"

    monkeypatch.setattr(stage_module.html_renderer, "render_t2i", render)
    monkeypatch.setattr(
        stage_module.star_handlers_registry,
        "get_handlers_by_event_type",
        lambda *args, **kwargs: [],
    )

    text = "  " + "甲" * 148 + "  "
    expected = "\n\n" + text
    assert len(expected) == 154
    config = host_config(t2i_threshold=150, segmented_threshold=150)

    inherited = StageEvent(text)
    await run_stage(inherited, config)
    one_image(inherited)
    assert calls[-1] == expected

    natural = StageEvent(text)
    owned = await plugin("natural", config).deliver_reply_style(natural)
    assert owned is False
    assert natural.extra["dswhale_style_fallback"] == "t2i"
    assert natural.sent == []
    assert natural.cleared is False
    assert natural.get_result().chain[0].text == text
    await run_stage(natural, config)
    one_image(natural)
    assert calls[-1] == expected
