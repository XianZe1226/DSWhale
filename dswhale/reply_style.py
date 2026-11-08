"""Reply-style planning shared by the runtime, desktop preview and CLI.

The planner is deliberately dependency-free: the desktop app shells out to
``python -m dswhale.reply_style preview`` so what the user previews is exactly
what the plugin sends. No model or network call happens here.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from . import reply_style_isolate
from .reply_cleanup import clean_text
from .reply_style_ops import (
    MAX_CUSTOM_PATTERN,
    SENTENCE_CLOSERS,
    SENTENCE_END,
    finish_bubbles,
    merge_overflow,
    protected_ranges,
    protected_warnings,
)

MODES = ("inherit", "natural", "single", "custom")
PUNCTUATION = ("keep", "sentence_end")
DEFAULT_MAX_BUBBLES = 3
DEFAULT_INTERVAL = "0.8,1.5"
MAX_TEXT = 12000
PREVIEW_TEXT = 8192


class StyleError(ValueError):
    """User-facing reply-style validation or planning error."""


def normalize_text(value):
    if not isinstance(value, str):
        return ""
    return value.replace("\r\n", "\n").replace("\r", "\n")


def parse_interval(value):
    """Parse ``"0.8,1.5"`` into a (min, max) pair with 0.2–5.0 bounds."""
    if isinstance(value, (list, tuple)) and len(value) == 2:
        parts = list(value)
    else:
        parts = str(value or DEFAULT_INTERVAL).split(",")
    if len(parts) != 2:
        raise StyleError("发送间隔应为“最小,最大”，例如 0.8,1.5")
    try:
        low, high = float(parts[0]), float(parts[1])
    except (TypeError, ValueError) as exc:
        raise StyleError("发送间隔必须是数字") from exc
    if not (0.2 <= low <= 5.0 and 0.2 <= high <= 5.0):
        raise StyleError("发送间隔应在 0.2–5 秒之间")
    if low > high:
        raise StyleError("发送间隔的最小值不能大于最大值")
    return (low, high)


def validate_custom(pattern, label="自定义规则"):
    """Shape-check a user regex without compiling or running it.

    Compilation, capture-group rejection and the empty-match check happen in
    the worker (``reply_style_ops.validate_rules``). The parent process must
    never touch user input with ``re``; a pathological pattern could otherwise
    block the host event loop before the worker deadline exists.
    """
    if not isinstance(pattern, str):
        raise StyleError(f"{label}必须是字符串")
    pattern = pattern.strip()
    if not pattern:
        return None
    if len(pattern) > MAX_CUSTOM_PATTERN:
        raise StyleError(f"{label}不能超过 {MAX_CUSTOM_PATTERN} 个字符")
    if "\x00" in pattern:
        raise StyleError(f"{label}不能包含空字符")
    return pattern


def _split_sentences(text, ranges):
    blocks = []
    start = 0
    index = 0
    while index < len(text):
        if text[index] in SENTENCE_END and not any(
            begin <= index < end for begin, end, _ in ranges
        ):
            end = index + 1
            while end < len(text) and text[end] in SENTENCE_END:
                end += 1
            while end < len(text) and text[end] in SENTENCE_CLOSERS:
                end += 1
            blocks.append(text[start:end])
            start = end
            index = end
            continue
        index += 1
    if start < len(text):
        blocks.append(text[start:])
    return blocks


def _natural_blocks(text, ranges):
    if "\n" in text:
        return [line for line in text.split("\n") if line.strip()]
    return _split_sentences(text, ranges)


def host_path(mode, platform="aiocqhttp", streaming=False, segmented=True):
    if mode != "inherit":
        return "plugin_owned"
    platform = str(platform or "").lower()
    if platform in {"aiocqhttp", "onebot", "napcat"}:
        if streaming:
            return "host_stream_realtime"
        return "host_segmented" if segmented else "host_single"
    if platform.startswith("qq_official"):
        return "host_stream_realtime" if streaming else "host_single"
    return "host_single"


def prompt_hint(mode):
    """Short runtime style hint; never written back to the user's persona."""
    if mode == "natural":
        return (
            "回复排版：像日常聊天一样，通常一句一条、合计 1–3 条；每条是完整的一句话或一个意思，"
            "不要出现半句或空白消息；不要为了凑条数硬拆；代码、链接、数字和长技术内容保持完整。"
        )
    if mode == "single":
        return "回复排版：本轮把完整回复作为一条消息发送，不要自行拆成多条，不要发送空白消息。"
    if mode == "custom":
        return "回复排版：遵循用户配置的拆分规则，保持每句完整，不要发送空白消息。"
    return ""


def plan(
    text,
    *,
    mode="natural",
    max_bubbles=DEFAULT_MAX_BUBBLES,
    punctuation="keep",
    custom_regex="",
    custom_cleanup="",
    platform="aiocqhttp",
    streaming=False,
    segmented=True,
):
    """Plan the exact bubbles for a complete reply.

    ``inherit`` never touches the text: the host keeps ownership. The other
    modes return the bubbles DSWhale must send, in order.
    """
    if mode not in MODES:
        raise StyleError("回复方式无效")
    if isinstance(max_bubbles, bool) or not isinstance(max_bubbles, int):
        raise StyleError("目标条数必须是 1–3 的整数")
    if not 1 <= max_bubbles <= 3:
        raise StyleError("目标条数应在 1–3 之间")
    if punctuation not in PUNCTUATION:
        raise StyleError("标点处理方式无效")
    low, high = parse_interval(DEFAULT_INTERVAL)
    original = normalize_text(text)
    warnings = protected_warnings(original)

    if mode == "inherit":
        bubbles = [original.strip()] if original.strip() else []
        return _result(
            mode,
            bubbles,
            punctuation,
            [],
            warnings,
            (low, high),
            platform,
            streaming,
            segmented,
            original,
        )

    cleaned = clean_text(original)
    ranges = protected_ranges(cleaned)
    kinds = sorted({kind for _, _, kind in ranges})
    if len(cleaned) > MAX_TEXT:
        bubbles = [cleaned.strip()] if cleaned.strip() else []
        warnings.append("long_text_fallback")
        return _result(
            mode,
            bubbles,
            punctuation,
            kinds,
            warnings,
            (low, high),
            platform,
            streaming,
            segmented,
            original,
        )
    has_fenced = "fenced_code" in kinds

    if mode == "single" or has_fenced:
        if has_fenced:
            warnings.append("code_fallback")
        blocks = [cleaned] if cleaned.strip() else []
        return _result(
            mode,
            finish_bubbles(blocks, punctuation),
            punctuation,
            kinds,
            warnings,
            (low, high),
            platform,
            streaming,
            segmented,
            original,
        )

    if mode == "custom":
        raise RuntimeError("自定义规则只能在隔离进程中执行")

    blocks = _natural_blocks(cleaned, ranges)
    blocks, merged = merge_overflow(blocks, max_bubbles)
    if merged:
        warnings.append("merged_overflow")
    if len(_natural_blocks(cleaned, ranges)) == 1 and not merged and cleaned.strip():
        warnings.append("single_block")
    return _result(
        mode,
        finish_bubbles(blocks, punctuation),
        punctuation,
        kinds,
        warnings,
        (low, high),
        platform,
        streaming,
        segmented,
        original,
    )


async def plan_async(
    text,
    *,
    mode="natural",
    max_bubbles=DEFAULT_MAX_BUBBLES,
    punctuation="keep",
    custom_regex="",
    custom_cleanup="",
    platform="aiocqhttp",
    streaming=False,
    segmented=True,
):
    """Plan a reply, moving custom regex work into a disposable worker."""
    if mode != "custom":
        return plan(
            text,
            mode=mode,
            max_bubbles=max_bubbles,
            punctuation=punctuation,
            custom_regex=custom_regex,
            custom_cleanup=custom_cleanup,
            platform=platform,
            streaming=streaming,
            segmented=segmented,
        )
    if isinstance(max_bubbles, bool) or max_bubbles not in (1, 2, 3):
        raise StyleError("目标条数应在 1–3 之间")
    if punctuation not in PUNCTUATION:
        raise StyleError("标点处理方式无效")
    custom_regex = validate_custom(custom_regex, "自定义拆分规则")
    if custom_regex is None:
        raise StyleError("请先填写自定义拆分规则")
    custom_cleanup = validate_custom(custom_cleanup, "自定义清理规则") or ""
    low, high = parse_interval(DEFAULT_INTERVAL)
    original = normalize_text(text)
    cleaned = clean_text(original)
    kinds = sorted({kind for _, _, kind in protected_ranges(cleaned)})
    request = {
        "op": "custom",
        "text": cleaned,
        "regex": custom_regex,
        "cleanup": custom_cleanup,
        "maxBubbles": max_bubbles,
    }
    outcome = await reply_style_isolate.run(request)
    if outcome.get("ok") is True and isinstance(outcome.get("value"), dict):
        value = outcome["value"]
        return _result(
            mode,
            finish_bubbles(value.get("blocks") or [], punctuation),
            punctuation,
            kinds,
            [*protected_warnings(original), *(value.get("warnings") or [])],
            (low, high),
            platform,
            streaming,
            segmented,
            original,
            custom_executed=True,
        )
    if outcome.get("error") == "ValueError":
        raise StyleError(str(outcome.get("message") or "自定义规则无法安全执行"))
    degraded = "custom_timeout" if outcome.get("error") == "timeout" else "custom_unavailable"
    bubbles = [cleaned.strip()] if cleaned.strip() else []
    return _result(
        mode,
        bubbles,
        punctuation,
        kinds,
        [*protected_warnings(original), degraded],
        (low, high),
        platform,
        streaming,
        segmented,
        original,
        custom_executed=False,
        degraded=degraded,
    )


def _result(
    mode,
    bubbles,
    punctuation,
    kinds,
    warnings,
    interval,
    platform,
    streaming,
    segmented,
    original,
    *,
    custom_executed=None,
    degraded=None,
    computed=None,
    uncomputed_reason=None,
    host_source=None,
):
    host = mode == "inherit"
    value = {
        "mode": mode,
        "path": "host" if host else "plugin",
        "hostPath": host_path(mode, platform, streaming, segmented),
        "bubbles": bubbles,
        "count": len(bubbles),
        "interval": [interval[0], interval[1]],
        "punctuation": punctuation,
        "protected": kinds,
        "warnings": warnings,
        "textLength": len(original),
        "removedCount": max(0, len(original) - sum(len(value) for value in bubbles)),
        "degraded": degraded,
        "customExecuted": (mode == "custom") if custom_executed is None else custom_executed,
        "computed": (not host) if computed is None else computed,
        "uncomputedReason": ("host_owned" if host else None)
        if uncomputed_reason is None
        else uncomputed_reason,
        "effectivePath": "host" if host else "plugin",
        "hostSource": host_source,
    }
    return value


def preview(payload, host=None):
    """Synchronous preview used by tests; the CLI awaits preview_async."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(preview_async(payload, host))
    raise StyleError("预览需要在没有运行事件循环时调用")


async def _host_blocks(cfg, platform, text):
    """Return the host's own segmentation blocks, or a conservative failure.

    The host splits first, adds two newlines around every Plain, and only then
    applies the T2I threshold. Calling this before ``decoration_reason`` keeps
    the preview consistent with the real ResultDecorateStage.
    """
    actual = str(platform or "").lower()
    if (
        actual in {"qq_official_webhook", "weixin_official_account", "dingtalk"}
        or cfg.segmented.get("enable") is not True
    ):
        return ([text] if text.strip() else []), None, "host_single"
    outcome = await reply_style_isolate.run(
        {"op": "host", "text": text, "host": cfg.host_preview(platform, streaming=False)}
    )
    value = outcome.get("value")
    if outcome.get("ok") is not True or not isinstance(value, dict):
        return (
            None,
            (
                "host_regex_timeout"
                if outcome.get("error") == "timeout"
                else "host_regex_unavailable"
            ),
            None,
        )
    if value.get("warnings"):
        return None, str(value["warnings"][0]), None
    return list(value.get("blocks") or []), None, value.get("path") or "host_segmented"


def _wants_t2i(cfg, use_t2i):
    return (use_t2i is None and cfg.t2i) or use_t2i is True


async def preview_async(payload, host=None):
    """Validate a desktop preview request and return the plan the runtime uses."""
    if not isinstance(payload, dict):
        raise StyleError("预览请求无效")
    text = payload.get("text", "")
    if not isinstance(text, str):
        raise StyleError("预览文本无效")
    text = normalize_text(text)
    if len(text) > PREVIEW_TEXT:
        raise StyleError("预览文本过长，请控制在 8192 个字符以内")
    mode = payload.get("mode", "natural")
    if mode not in MODES:
        raise StyleError("回复方式无效")
    max_bubbles = payload.get("maxBubbles", DEFAULT_MAX_BUBBLES)
    if isinstance(max_bubbles, str) and max_bubbles.isdigit():
        max_bubbles = int(max_bubbles)
    punctuation = payload.get("punctuation", "keep")
    interval = payload.get("interval", DEFAULT_INTERVAL)
    custom_regex = payload.get("customRegex", "")
    custom_cleanup = payload.get("customCleanup", "")
    platform = payload.get("platform", "aiocqhttp")
    streaming = payload.get("streaming", False) is True
    segmented = payload.get("segmented", True) is not False
    low, high = parse_interval(interval)
    host = host if isinstance(host, dict) else {}
    host_computed = host.get("computed") is True
    profile = host.get("host") if isinstance(host.get("host"), dict) else {}
    host_source = host.get("hostSource") if isinstance(host.get("hostSource"), dict) else None
    decoration = ""
    if mode != "inherit" and host_computed:
        from .host_config import HostReplyConfig, decoration_reason, stream_decoration_reason

        cfg = HostReplyConfig.from_mapping(
            profile.get("config") or {}, platform=profile.get("platform") or platform
        )
        actual_platform = cfg.platform or platform
        use_t2i = payload.get("useT2i")
        if cfg.streaming:
            # The host returns before decoration in streaming mode. Only the
            # prefix and TTS survive upstream, so quote/T2I/forward/mention must
            # not make this plugin-owned preview look host-owned.
            decoration = stream_decoration_reason(cfg, platform=actual_platform)
        else:
            decoration = decoration_reason(
                cfg,
                platform=actual_platform,
                message_type=payload.get("messageType", "FriendMessage"),
                plain_texts=[text],
                use_t2i=use_t2i,
                t2i_blocks=[],
            )
            if not decoration and _wants_t2i(cfg, use_t2i):
                blocks, failure, _path = await _host_blocks(cfg, actual_platform, text)
                decoration = (
                    "t2i"
                    if failure
                    else decoration_reason(
                        cfg,
                        platform=actual_platform,
                        message_type=payload.get("messageType", "FriendMessage"),
                        plain_texts=[text],
                        use_t2i=use_t2i,
                        t2i_blocks=blocks,
                    )
                )
    elif mode != "inherit" and (payload.get("hostReplyPrefix") or payload.get("hostTtsEnabled")):
        decoration = "reply_prefix" if payload.get("hostReplyPrefix") else "tts"
    if decoration:
        base = plan(text, mode="single", platform=platform)
        base.update(
            path="host",
            hostPath=(
                f"host_decorated_{decoration}"
                if decoration == "t2i"
                else f"host_fallback_{decoration}"
            ),
            warnings=[*base["warnings"], "host_decoration"],
            count=None if host_computed else base["count"],
            bubbles=[] if host_computed else base["bubbles"],
            interval=None,
            computed=False,
            uncomputedReason="host_owned",
            effectivePath="host",
            hostSource=host_source,
            decorationReason=decoration,
        )
        return base
    if mode == "custom":
        value = await plan_async(
            text,
            mode=mode,
            max_bubbles=max_bubbles,
            punctuation=punctuation,
            custom_regex=custom_regex,
            custom_cleanup=custom_cleanup,
            platform=platform,
            streaming=streaming,
            segmented=segmented,
        )
        value["interval"] = [low, high]
        value["removedPreview"] = ""
        return value
    if mode == "inherit" and not host_computed:
        value = plan(
            text, mode="inherit", platform=platform, streaming=streaming, segmented=segmented
        )
        value.update(
            path="host",
            hostPath="host_unknown",
            bubbles=[],
            count=None,
            interval=None,
            computed=False,
            uncomputedReason=host.get("reason") or "profile_unknown",
            effectivePath="host",
            hostSource=None,
        )
        return value
    if mode == "inherit" and host_computed:
        value = plan(
            text, mode="inherit", platform=platform, streaming=streaming, segmented=segmented
        )
        value["computed"] = True
        value["uncomputedReason"] = None
        value["effectivePath"] = "host"
        value["hostSource"] = host_source
        value["interval"] = None
        from .host_config import HostReplyConfig, decoration_reason

        cfg = HostReplyConfig.from_mapping(
            profile.get("config") or {},
            platform=profile.get("platform") or platform,
            profile_id=str(profile.get("id") or ""),
        )
        actual_platform = cfg.platform or str(profile.get("platform") or platform)
        if cfg.streaming:
            # The host streams without decoration. Guessing a bubble count or a
            # send interval here would be fabricated evidence.
            value.update(
                hostPath="host_stream_realtime",
                computed=False,
                uncomputedReason="host_owned",
                count=None,
                bubbles=[],
                warnings=[*value["warnings"], "host_streaming"],
            )
            return value
        use_t2i = payload.get("useT2i")
        message_type = payload.get("messageType", "FriendMessage")
        decoration = decoration_reason(
            cfg,
            platform=actual_platform,
            message_type=message_type,
            plain_texts=[text],
            use_t2i=use_t2i,
            t2i_blocks=[],
        )
        blocks = None
        path = None
        failure = None
        if not decoration and _wants_t2i(cfg, use_t2i):
            blocks, failure, path = await _host_blocks(cfg, actual_platform, text)
            if failure:
                # The host may split differently. Claiming the host's plain
                # path here could drop a T2I decoration, so stay conservative.
                value.update(
                    hostPath="host_decorated_t2i",
                    computed=False,
                    uncomputedReason="host_owned",
                    count=None,
                    bubbles=[],
                    interval=None,
                    warnings=[*value["warnings"], failure, "host_decoration"],
                    decorationReason="t2i",
                )
                return value
            decoration = decoration_reason(
                cfg,
                platform=actual_platform,
                message_type=message_type,
                plain_texts=[text],
                use_t2i=use_t2i,
                t2i_blocks=blocks,
            )
        if decoration:
            value.update(
                hostPath=f"host_decorated_{decoration}",
                computed=False,
                uncomputedReason="host_owned",
                count=None,
                bubbles=[],
                interval=None,
                warnings=[*value["warnings"], "host_decoration"],
                decorationReason=decoration,
            )
            return value
        if (
            actual_platform.lower()
            in {
                "qq_official_webhook",
                "weixin_official_account",
                "dingtalk",
            }
            or cfg.segmented.get("enable") is not True
        ):
            value.update(
                hostPath="host_single",
                bubbles=[text.strip()] if text.strip() else [],
                count=1 if text.strip() else 0,
                computed=True,
                uncomputedReason=None,
                warnings=[*value["warnings"], "host_single"],
            )
            return value
        if blocks is None:
            blocks, failure, path = await _host_blocks(cfg, actual_platform, text)
        if blocks is None:
            value.update(
                hostPath="host_unknown",
                bubbles=[],
                count=None,
                interval=None,
                warnings=[
                    *value["warnings"],
                    failure or "host_regex_unavailable",
                    "host_unavailable",
                ],
                computed=False,
                uncomputedReason=failure or "host_regex_unavailable",
            )
            return value
        value.update(
            hostPath=path or "host_segmented",
            bubbles=blocks,
            count=len(blocks),
            computed=True,
            uncomputedReason=None,
            warnings=[*value["warnings"]],
        )
        return value
    value = await plan_async(
        text,
        mode=mode,
        max_bubbles=max_bubbles,
        punctuation=punctuation,
        custom_regex=custom_regex,
        custom_cleanup=custom_cleanup,
        platform=platform,
        streaming=streaming,
        segmented=segmented,
    )
    value["interval"] = [low, high]
    value["removedPreview"] = ""
    return value


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(prog="dswhale.reply_style")
    parser.add_argument("command", choices=("preview",))
    parser.add_argument("--host", default="")
    options = parser.parse_args(argv)
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        host = None
        if options.host:
            from .desktop_settings import read_host_reply_context

            host = read_host_reply_context(options.host, payload.get("platform", ""))
        result = asyncio.run(preview_async(payload, host))
    except (StyleError, ValueError, json.JSONDecodeError) as error:
        message = str(error) if isinstance(error, StyleError) else "预览请求无效"
        print(json.dumps({"error": message}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
