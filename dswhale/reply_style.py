"""Reply-style planning shared by the runtime, desktop preview and CLI.

The planner is deliberately dependency-free: the desktop app shells out to
``python -m dswhale.reply_style preview`` so what the user previews is exactly
what the plugin sends. No model or network call happens here.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
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
    """Compile a user regex and reject forms whose output is ambiguous."""
    if not isinstance(pattern, str):
        raise StyleError(f"{label}必须是字符串")
    pattern = pattern.strip()
    if not pattern:
        return None
    if len(pattern) > MAX_CUSTOM_PATTERN:
        raise StyleError(f"{label}不能超过 {MAX_CUSTOM_PATTERN} 个字符")
    try:
        compiled = re.compile(pattern, re.DOTALL | re.MULTILINE)
    except re.error as exc:
        raise StyleError(f"{label}语法无效：{exc}") from exc
    if compiled.groups:
        raise StyleError(f"{label}不能包含捕获组；请使用 (?:...) 非捕获分组")
    try:
        empty = compiled.search("")
    except re.error as exc:  # defensive: some patterns fail only at match time
        raise StyleError(f"{label}无法执行：{exc}") from exc
    if empty is not None:
        raise StyleError(f"{label}不能匹配空字符串")
    return compiled


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
    if max_bubbles not in (1, 2, 3) or isinstance(max_bubbles, bool):
        raise StyleError("目标条数应在 1–3 之间")
    if punctuation not in PUNCTUATION:
        raise StyleError("标点处理方式无效")
    if validate_custom(custom_regex, "自定义拆分规则") is None:
        raise StyleError("请先填写自定义拆分规则")
    validate_custom(custom_cleanup, "自定义清理规则")
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
    if mode == "custom":
        validate_custom(custom_regex, "自定义拆分规则")
        validate_custom(custom_cleanup, "自定义清理规则")
    host = host if isinstance(host, dict) else {}
    host_computed = host.get("computed") is True
    profile = host.get("host") if isinstance(host.get("host"), dict) else {}
    host_source = host.get("hostSource") if isinstance(host.get("hostSource"), dict) else None
    decoration = ""
    if mode != "inherit" and host_computed:
        from .host_config import HostReplyConfig, decoration_reason

        cfg = HostReplyConfig.from_mapping(
            profile.get("config") or {}, platform=profile.get("platform") or platform
        )
        decoration = decoration_reason(
            cfg,
            platform=cfg.platform or platform,
            message_type=payload.get("messageType", "FriendMessage"),
            plain_texts=[text],
            use_t2i=payload.get("useT2i"),
        )
    elif mode != "inherit" and (payload.get("hostReplyPrefix") or payload.get("hostTtsEnabled")):
        decoration = "reply_prefix" if payload.get("hostReplyPrefix") else "tts"
    if decoration:
        base = plan(text, mode="single", platform=platform)
        base.update(
            path="host",
            hostPath=f"host_fallback_{decoration}",
            warnings=[*base["warnings"], "host_decoration"],
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
        if streaming:
            value.update(
                hostPath="host_stream_realtime",
                computed=False,
                uncomputedReason="host_owned",
                warnings=[*value["warnings"], "host_streaming"],
            )
            return value
        from .host_config import HostReplyConfig, decoration_reason

        cfg = HostReplyConfig.from_mapping(
            profile.get("config") or {}, platform=profile.get("platform") or platform
        )
        decoration = decoration_reason(
            cfg,
            platform=cfg.platform or platform,
            message_type=payload.get("messageType", "FriendMessage"),
            plain_texts=[text],
            use_t2i=payload.get("useT2i"),
        )
        if decoration:
            value.update(
                hostPath=f"host_decorated_{decoration}",
                computed=False,
                uncomputedReason="host_owned",
                warnings=[*value["warnings"], "host_decoration"],
                decorationReason=decoration,
            )
            return value
        host_data = {
            "platform": platform,
            "segmentPlatform": profile.get("platform") or platform,
            "segmented": profile.get("segmented") or {},
        }
        if (
            str(platform).lower() not in {"aiocqhttp", "onebot", "napcat"}
            or profile.get("strategy", "realtime_segmenting") != "realtime_segmenting"
            or not (profile.get("segmented") or {}).get("enable")
        ):
            value.update(
                hostPath="host_single",
                bubbles=[text.strip()] if text.strip() else [],
                count=1 if text.strip() else 0,
                warnings=[*value["warnings"], "host_single"],
            )
            return value
        outcome = await reply_style_isolate.run({"op": "host", "text": text, "host": host_data})
        if outcome.get("ok") is not True or not isinstance(outcome.get("value"), dict):
            degraded = (
                "host_regex_timeout"
                if outcome.get("error") == "timeout"
                else "host_regex_unavailable"
            )
            value.update(
                bubbles=[text.strip()] if text.strip() else [],
                count=1 if text.strip() else 0,
                warnings=[*value["warnings"], degraded],
                computed=False,
                uncomputedReason=degraded,
            )
            return value
        result = outcome["value"]
        value.update(
            hostPath=result.get("path") or "host_segmented",
            bubbles=result.get("blocks") or [],
            count=len(result.get("blocks") or []),
            warnings=[*value["warnings"], *(result.get("warnings") or [])],
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
