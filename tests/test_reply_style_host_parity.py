"""F3/F6: match AstrBot 4.29.3 decoration decisions and preview their real config."""

import json

from astrbot.core.message.message_event_result import MessageEventResult, ResultContentType

from dswhale.desktop_settings import read_host_reply_context
from dswhale.host_config import (
    HostReplyConfig,
    decoration_reason,
    result_is_llm,
    stream_decoration_reason,
)
from dswhale.reply_style import preview
from dswhale.reply_style_ops import host_preview


def config(**patch):
    value = {
        "platform_settings": {
            "reply_prefix": "",
            "reply_with_quote": False,
            "reply_with_mention": False,
            "forward_threshold": 1500,
            "segmented_reply": {
                "enable": True,
                "only_llm_result": True,
                "interval": "0.8,1.5",
                "words_count_threshold": 150,
                "split_mode": "regex",
                "regex": r".*?[。？！~…]+|.+$",
                "content_cleanup_rule": "",
            },
        },
        "provider_settings": {
            "streaming_response": True,
            "unsupported_streaming_strategy": "realtime_segmenting",
        },
        "provider_tts_settings": {"enable": False, "trigger_probability": 0},
        "t2i": False,
        "t2i_word_threshold": 150,
        "t2i_strategy": "local",
    }
    for key, next_value in patch.items():
        if isinstance(next_value, dict):
            value[key] = {**value.get(key, {}), **next_value}
        else:
            value[key] = next_value
    return value


def test_real_astrbot_result_api_is_the_only_llm_proof():
    result = MessageEventResult()
    result.result_content_type = ResultContentType.LLM_RESULT
    assert result_is_llm(result) is True
    result.result_content_type = ResultContentType.GENERAL_RESULT
    assert result_is_llm(result) is False
    assert result_is_llm(object()) is False
    assert result_is_llm(type("Legacy", (), {"is_llm_result": True})()) is False


def test_host_config_reads_platform_segmentation_and_provider_streaming_keys():
    cfg = HostReplyConfig.from_mapping(config(), platform="aiocqhttp", profile_id="qq")
    assert cfg.streaming is True
    assert cfg.strategy == "realtime_segmenting"
    assert cfg.segmented["enable"] is True
    assert cfg.segmented["interval"] == "0.8,1.5"
    assert cfg.segmented["threshold"] == 150
    assert cfg.segmented["regex"] == r".*?[。？！~…]+|.+$"
    # The source summary intentionally omits regex/cleanup; host_preview carries them.
    assert "regex" not in cfg.host_source()["segmented"]
    assert cfg.host_preview()["segmented"]["regex"] == r".*?[。？！~…]+|.+$"


def test_decoration_order_matches_the_host_stage():
    base = HostReplyConfig.from_mapping(config(), platform="aiocqhttp")
    assert decoration_reason(base, platform="aiocqhttp", plain_texts=["短"]) == ""
    prefix = HostReplyConfig.from_mapping(
        config(platform_settings={"reply_prefix": "[鱼]"}), platform="aiocqhttp"
    )
    assert decoration_reason(prefix, platform="aiocqhttp", plain_texts=["短"]) == "reply_prefix"
    quote = HostReplyConfig.from_mapping(
        config(platform_settings={"reply_with_quote": True}), platform="aiocqhttp"
    )
    assert decoration_reason(quote, platform="aiocqhttp", plain_texts=["短"]) == "reply_with_quote"
    mention = HostReplyConfig.from_mapping(
        config(platform_settings={"reply_with_mention": True}), platform="aiocqhttp"
    )
    assert (
        decoration_reason(mention, platform="aiocqhttp", message_type="GroupMessage")
        == "reply_with_mention"
    )
    assert decoration_reason(mention, platform="aiocqhttp", message_type="FriendMessage") == ""
    forward = HostReplyConfig.from_mapping(
        config(platform_settings={"forward_threshold": 3}), platform="aiocqhttp"
    )
    assert decoration_reason(forward, platform="aiocqhttp", plain_texts=["abcd"]) == "forward"
    assert decoration_reason(forward, platform="qq_official_webhook", plain_texts=["abcd"]) == ""
    t2i = HostReplyConfig.from_mapping(
        config(t2i=True, t2i_word_threshold=50), platform="aiocqhttp"
    )
    assert decoration_reason(t2i, platform="aiocqhttp", plain_texts=["长" * 60]) == "t2i"
    assert decoration_reason(t2i, platform="aiocqhttp", plain_texts=["短"], use_t2i=False) == ""
    tts = HostReplyConfig.from_mapping(
        config(provider_tts_settings={"enable": True, "trigger_probability": 0.2}),
        platform="aiocqhttp",
    )
    assert decoration_reason(tts, platform="aiocqhttp") == "tts"


def test_streaming_does_not_apply_quote_t2i_forward_or_mention():
    cfg = HostReplyConfig.from_mapping(
        config(
            platform_settings={
                "reply_with_quote": True,
                "reply_with_mention": True,
                "forward_threshold": 1,
            },
            t2i=True,
            t2i_word_threshold=50,
        ),
        platform="aiocqhttp",
    )
    assert stream_decoration_reason(cfg) == ""
    prefixed = HostReplyConfig.from_mapping(
        config(platform_settings={"reply_prefix": "[鱼]"}), platform="aiocqhttp"
    )
    assert stream_decoration_reason(prefixed) == "reply_prefix"
    tts = HostReplyConfig.from_mapping(
        config(provider_tts_settings={"enable": True, "trigger_probability": 0.2}),
        platform="aiocqhttp",
    )
    assert stream_decoration_reason(tts) == "tts"


def make_host(tmp_path, **config_patch):
    host = tmp_path / "host"
    (host / "data/config").mkdir(parents=True)
    document = {
        "platform": [{"id": "qq", "type": "aiocqhttp", "enable": True}],
        "platform_settings": {
            "reply_prefix": "",
            "reply_with_quote": False,
            "reply_with_mention": False,
            "forward_threshold": 1500,
            "segmented_reply": {
                "enable": True,
                "interval": "0.8,1.5",
                "words_count_threshold": 150,
                "split_mode": "regex",
                "regex": r".*?[。？！~…]+|.+$",
                "content_cleanup_rule": "",
            },
        },
        "provider_settings": {
            "streaming_response": False,
            "unsupported_streaming_strategy": "realtime_segmenting",
        },
        "provider_tts_settings": {"enable": False, "trigger_probability": 0},
        "t2i": False,
        "t2i_word_threshold": 150,
        "t2i_strategy": "local",
    }
    for key, value in config_patch.items():
        document[key] = value
    (host / "data/cmd_config.json").write_text(json.dumps(document), encoding="utf-8")
    (host / "data/config/astrbot_plugin_dswhale_config.json").write_text(
        json.dumps({"owner_umo": "qq:FriendMessage:1"}), encoding="utf-8"
    )
    return host


def test_inherit_preview_uses_the_real_profile_and_segmentation(tmp_path):
    host = read_host_reply_context(make_host(tmp_path), "aiocqhttp")
    assert host["computed"] is True
    value = preview({"text": "甲。乙。丙。", "mode": "inherit", "platform": "aiocqhttp"}, host)
    assert value["computed"] is True
    assert value["effectivePath"] == "host"
    assert value["hostPath"] == "host_segmented"
    assert value["bubbles"] == ["甲。", "乙。", "丙。"]
    assert value["count"] == 3
    assert value["interval"] is None
    assert value["hostSource"]["profileId"] == "qq"


def test_inherit_preview_reports_host_owned_paths_without_fake_counts(tmp_path):
    host = read_host_reply_context(make_host(tmp_path), "aiocqhttp")
    streamed = preview(
        {"text": "甲。乙。", "mode": "inherit", "platform": "aiocqhttp", "streaming": True}, host
    )
    assert streamed["computed"] is True
    assert streamed["hostPath"] == "host_segmented"

    streaming_host = read_host_reply_context(
        make_host(
            tmp_path / "streaming",
            provider_settings={
                "streaming_response": True,
                "unsupported_streaming_strategy": "realtime_segmenting",
            },
        ),
        "aiocqhttp",
    )
    streamed = preview(
        {"text": "甲。乙。", "mode": "inherit", "platform": "aiocqhttp"}, streaming_host
    )
    assert streamed["computed"] is False
    assert streamed["hostPath"] == "host_stream_realtime"
    assert streamed["count"] is None
    assert streamed["bubbles"] == []
    assert streamed["interval"] is None
    assert streamed["uncomputedReason"] == "host_owned"

    decorated_host = read_host_reply_context(
        make_host(tmp_path / "decorated", **{"platform_settings": {"reply_prefix": "[鱼]"}}),
        "aiocqhttp",
    )
    decorated = preview({"text": "短", "mode": "inherit", "platform": "aiocqhttp"}, decorated_host)
    assert decorated["hostPath"] == "host_decorated_reply_prefix"
    assert decorated["computed"] is False
    assert decorated["uncomputedReason"] == "host_owned"


def test_unknown_profile_is_honest(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    host = read_host_reply_context(empty, "aiocqhttp")
    assert host == {"computed": False, "reason": "config_missing"}
    value = preview({"text": "甲。", "mode": "inherit", "platform": "aiocqhttp"}, host)
    assert value["computed"] is False
    assert value["uncomputedReason"] == "config_missing"
    assert value["hostPath"] == "host_unknown"
    assert value["count"] is None
    assert value["bubbles"] == []
    assert value["interval"] is None


def _fish(host, **values):
    path = host / "data/config/astrbot_plugin_dswhale_config.json"
    fish = json.loads(path.read_text(encoding="utf-8"))
    fish.update(values)
    path.write_text(json.dumps(fish), encoding="utf-8")


def test_official_family_resolves_the_bound_profile_actual_type(tmp_path):
    platforms = [
        {"id": "official-ws", "type": "qq_official", "enable": True},
        {"id": "official-hook", "type": "qq_official_webhook", "enable": True},
    ]
    host = make_host(
        tmp_path,
        platform=platforms,
        provider_settings={
            "streaming_response": True,
            "unsupported_streaming_strategy": "realtime_segmenting",
        },
    )
    _fish(host, official_owner_umo="official-hook:FriendMessage:1")
    webhook = read_host_reply_context(host, "qq_official")
    assert webhook["computed"] is True
    assert webhook["host"]["platform"] == "qq_official_webhook"
    assert webhook["hostSource"]["platform"] == "qq_official_webhook"
    assert webhook["hostSource"]["streaming"] is True
    assert webhook["hostSource"]["strategy"] == "realtime_segmenting"
    assert read_host_reply_context(host, "qq_official_webhook")["host"]["platform"] == (
        "qq_official_webhook"
    )

    _fish(host, official_owner_umo="official-ws:FriendMessage:1")
    websocket = read_host_reply_context(host, "qq_official")
    assert websocket["host"]["platform"] == "qq_official"
    assert read_host_reply_context(host, "qq_official_webhook") == {
        "computed": False,
        "reason": "profile_unknown",
    }


def test_nonstream_host_preview_ignores_strategy_and_reports_streaming_honestly(tmp_path):
    host = read_host_reply_context(
        make_host(
            tmp_path,
            provider_settings={
                "streaming_response": False,
                "unsupported_streaming_strategy": "full",
            },
        ),
        "aiocqhttp",
    )
    value = preview({"text": "甲。乙。丙。", "mode": "inherit", "platform": "aiocqhttp"}, host)
    assert value["computed"] is True
    assert value["hostPath"] == "host_segmented"
    assert value["count"] == 3
    assert value["bubbles"] == ["甲。", "乙。", "丙。"]

    from dswhale.reply_style_ops import host_preview

    streamed = host_preview("甲。乙。", {**host["host"], "streaming": True})
    assert streamed == {"blocks": [], "warnings": ["host_streaming"], "path": "host_stream"}


def test_host_worker_failure_never_fabricates_a_count(tmp_path, monkeypatch):
    from dswhale import reply_style_isolate

    async def timeout(request, deadline_seconds=0.75):
        return {"ok": False, "error": "timeout"}

    monkeypatch.setattr(reply_style_isolate, "run", timeout)
    host = read_host_reply_context(make_host(tmp_path), "aiocqhttp")
    value = preview({"text": "甲。乙。", "mode": "inherit", "platform": "aiocqhttp"}, host)
    assert value["computed"] is False
    assert value["hostPath"] == "host_unknown"
    assert value["count"] is None
    assert value["bubbles"] == []
    assert value["interval"] is None
    assert "host_regex_timeout" in value["warnings"]


def test_t2i_uses_host_blocks_instead_of_a_total_length_guess():
    cfg = HostReplyConfig.from_mapping(
        config(t2i=True, t2i_word_threshold=50), platform="aiocqhttp"
    )
    text = "甲。" * 20
    assert decoration_reason(cfg, platform="aiocqhttp", plain_texts=[text]) == ""
    blocks = ["甲。"] * 20
    assert (
        decoration_reason(cfg, platform="aiocqhttp", plain_texts=[text], t2i_blocks=blocks) == "t2i"
    )


def test_official_webhook_and_websocket_previews_use_their_real_paths(tmp_path):
    webhook_host = make_host(
        tmp_path / "webhook",
        platform=[{"id": "hook", "type": "qq_official_webhook", "enable": True}],
    )
    _fish(webhook_host, official_owner_umo="hook:FriendMessage:1")
    webhook = read_host_reply_context(webhook_host, "qq_official")
    single = preview(
        {"text": "甲。乙。丙。", "mode": "inherit", "platform": "qq_official"}, webhook
    )
    assert single["computed"] is True
    assert single["hostPath"] == "host_single"
    assert single["count"] == 1

    ws_host = make_host(
        tmp_path / "ws", platform=[{"id": "ws", "type": "qq_official", "enable": True}]
    )
    _fish(ws_host, official_owner_umo="ws:FriendMessage:1")
    websocket = read_host_reply_context(ws_host, "qq_official")
    segmented = preview(
        {"text": "甲。乙。丙。", "mode": "inherit", "platform": "qq_official"}, websocket
    )
    assert segmented["computed"] is True
    assert segmented["hostPath"] == "host_segmented"
    assert segmented["count"] == 3


def test_preview_t2i_uses_the_hosts_post_segmentation_length(tmp_path):
    host = make_host(tmp_path, t2i=True, t2i_word_threshold=50)
    context = read_host_reply_context(host, "aiocqhttp")
    text = ("甲" * 14 + "。") * 3
    inherit = preview({"text": text, "mode": "inherit", "platform": "aiocqhttp"}, context)
    assert inherit["hostPath"] == "host_decorated_t2i"
    assert inherit["computed"] is False
    assert inherit["count"] is None
    assert inherit["bubbles"] == []

    natural = preview({"text": text, "mode": "natural", "platform": "aiocqhttp"}, context)
    assert natural["hostPath"] == "host_decorated_t2i"
    assert natural["computed"] is False
    assert natural["count"] is None
    assert natural["bubbles"] == []


def test_plugin_owned_preview_ignores_host_quote_and_t2i_while_streaming(tmp_path):
    platform_settings = {
        "reply_prefix": "",
        "reply_with_quote": True,
        "reply_with_mention": False,
        "forward_threshold": 1500,
        "segmented_reply": {
            "enable": True,
            "interval": "0.8,1.5",
            "words_count_threshold": 150,
            "split_mode": "regex",
            "regex": r".*?[。？！~…]+|.+$",
            "content_cleanup_rule": "",
        },
    }
    host = make_host(
        tmp_path,
        platform_settings=platform_settings,
        provider_settings={
            "streaming_response": True,
            "unsupported_streaming_strategy": "realtime_segmenting",
        },
        t2i=True,
        t2i_word_threshold=50,
    )
    context = read_host_reply_context(host, "aiocqhttp")
    text = ("甲" * 14 + "。") * 3
    natural = preview({"text": text, "mode": "natural", "platform": "aiocqhttp"}, context)
    assert natural["path"] != "host"
    assert natural["computed"] is True
    assert natural["count"] == 3

    inherit = preview({"text": text, "mode": "inherit", "platform": "aiocqhttp"}, context)
    assert inherit["hostPath"] == "host_stream_realtime"
    assert inherit["computed"] is False
    assert inherit["count"] is None


def test_host_preview_preserves_unsplit_whitespace_exactly():
    host = {
        "platform": "aiocqhttp",
        "segmented": {"enable": False, "threshold": 150},
    }
    assert host_preview("  " + "甲" * 148 + "  ", host)["blocks"] == ["  " + "甲" * 148 + "  "]

    host["segmented"] = {"enable": True, "threshold": 150}
    assert host_preview("  " + "甲" * 148 + "  ", host)["blocks"] == ["  " + "甲" * 148 + "  "]
