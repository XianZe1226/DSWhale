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
    assert streamed["computed"] is False
    assert streamed["hostPath"] == "host_stream_realtime"
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
    assert value["interval"] is None
