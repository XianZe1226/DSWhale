"""Read host decoration and segmentation settings without importing AstrBot.

The plugin can only own a plain reply when the host would not decorate it
afterwards. These helpers mirror AstrBot 4.29.3's ``ResultDecorateStage``
semantics; the pin is intentional and must be re-tested on every upgrade.
"""

from __future__ import annotations

from dataclasses import dataclass, field

EXCLUDED_SEGMENT_PLATFORMS = {
    "qq_official_webhook",
    "weixin_official_account",
    "dingtalk",
}
DEFAULT_HOST_REGEX = r".*?[。？！~…]+|.+$"


def _mapping(value):
    return value if isinstance(value, dict) else {}


def _bool(value):
    return value is True


def _number(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class HostReplyConfig:
    profile_id: str = ""
    platform: str = ""
    reply_prefix: str = ""
    reply_with_quote: bool = False
    reply_with_mention: bool = False
    forward_threshold: int = 1500
    t2i: bool = False
    t2i_word_threshold: int = 150
    t2i_strategy: str = "local"
    tts_enabled: bool = False
    tts_probability: float = 1.0
    streaming: bool = False
    strategy: str = "realtime_segmenting"
    segmented: dict = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, config, platform="", profile_id=""):
        config = _mapping(config)
        platform_settings = _mapping(config.get("platform_settings"))
        tts = _mapping(config.get("provider_tts_settings"))
        segmented = _mapping(platform_settings.get("segmented_reply"))
        threshold = segmented.get("words_count_threshold", 150)
        try:
            threshold = max(0, int(threshold))
        except (TypeError, ValueError):
            threshold = 150
        t2i_threshold = config.get("t2i_word_threshold", 150)
        try:
            t2i_threshold = max(50, int(t2i_threshold))
        except (TypeError, ValueError):
            t2i_threshold = 150
        return cls(
            profile_id=str(profile_id or ""),
            platform=str(platform or ""),
            reply_prefix=str(platform_settings.get("reply_prefix") or ""),
            reply_with_quote=_bool(platform_settings.get("reply_with_quote")),
            reply_with_mention=_bool(platform_settings.get("reply_with_mention")),
            forward_threshold=max(
                0, int(_number(platform_settings.get("forward_threshold"), 1500))
            ),
            t2i=_bool(config.get("t2i")),
            t2i_word_threshold=t2i_threshold,
            t2i_strategy=str(config.get("t2i_strategy") or "local"),
            tts_enabled=_bool(tts.get("enable")),
            tts_probability=max(0.0, min(_number(tts.get("trigger_probability"), 1.0), 1.0)),
            streaming=_bool(_mapping(config.get("provider_settings")).get("streaming_response")),
            strategy=str(
                _mapping(config.get("provider_settings")).get("unsupported_streaming_strategy")
                or config.get("unsupported_streaming_strategy")
                or "realtime_segmenting"
            ),
            segmented={
                "enable": _bool(segmented.get("enable")),
                "only_llm_result": segmented.get("only_llm_result") is not False,
                "threshold": threshold,
                "split_mode": str(segmented.get("split_mode") or "regex"),
                "regex": str(segmented.get("regex") or DEFAULT_HOST_REGEX),
                "split_words": list(segmented.get("split_words") or ["。", "？", "！", "~", "…"]),
                "cleanup": str(segmented.get("content_cleanup_rule") or ""),
                "interval": str(segmented.get("interval") or ""),
            },
        )

    def host_preview(self, platform=None, streaming=None):
        """Full, safe input for the isolated host segmentation preview.

        ``streaming`` overrides the host-wide switch for the current event: a
        non-streaming reply must be segmented even when streaming_response is
        enabled globally.
        """
        return {
            "platform": platform or self.platform,
            "segmentPlatform": platform or self.platform,
            "streaming": self.streaming if streaming is None else bool(streaming),
            "strategy": self.strategy,
            "segmented": dict(self.segmented),
        }

    def host_source(self, streaming=None, platform=None):
        """A leak-free summary shown by the desktop preview."""
        return {
            "profileId": self.profile_id,
            "platform": platform or self.platform,
            "streaming": self.streaming if streaming is None else bool(streaming),
            "strategy": self.strategy,
            "segmented": {
                "enable": self.segmented.get("enable") is True,
                "threshold": self.segmented.get("threshold", 150),
                "interval": self.segmented.get("interval", ""),
                "splitMode": self.segmented.get("split_mode", "regex"),
            },
        }


def result_is_llm(result):
    """Only an explicit, callable host API answer may claim an LLM result."""
    probe = getattr(result, "is_llm_result", None)
    if not callable(probe):
        return False
    try:
        return probe() is True
    except Exception:
        return False


def decoration_reason(
    cfg, *, platform="", message_type="", plain_texts=(), use_t2i=None, t2i_blocks=None
):
    """Return the first host decoration that must keep the reply's ownership."""
    if cfg is None:
        return ""
    platform = str(platform or cfg.platform or "").lower()
    if cfg.reply_prefix:
        return "reply_prefix"
    if cfg.reply_with_quote:
        return "reply_with_quote"
    value = getattr(message_type, "value", message_type)
    if cfg.reply_with_mention and value != "FriendMessage":
        return "reply_with_mention"
    total = sum(len(text) for text in plain_texts if isinstance(text, str))
    if platform == "aiocqhttp" and total > cfg.forward_threshold:
        return "forward"
    wanted_t2i = (use_t2i is None and cfg.t2i) or use_t2i is True
    if t2i_blocks is not None:
        # The host splits first, adds two newlines around every Plain, then
        # compares the rendered length with the threshold.
        t2i_length = sum(len(block) + 2 for block in t2i_blocks)
    else:
        t2i_length = total + 2 * len(plain_texts)
    if wanted_t2i and t2i_length > cfg.t2i_word_threshold:
        return "t2i"
    if cfg.tts_enabled and cfg.tts_probability > 0:
        return "tts"
    return ""


def stream_decoration_reason(cfg, *, platform=""):
    """Streaming leaves the decorate stage before quote/T2I/forward/mention.

    Only the two decorations applied before that point, reply prefix and TTS,
    still require the host to own the final send.
    """
    if cfg is None:
        return ""
    if cfg.reply_prefix:
        return "reply_prefix"
    if cfg.tts_enabled and cfg.tts_probability > 0:
        return "tts"
    return ""


def host_owned_for_stream(cfg):
    """AstrBot returns before decoration for streaming, so it never decorates."""
    return False
