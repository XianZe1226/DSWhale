"""Reply-style planning shared by the runtime, desktop preview and CLI.

The planner is deliberately dependency-free: the desktop app shells out to
``python -m dswhale.reply_style preview`` so what the user previews is exactly
what the plugin sends. No model or network call happens here.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

from .reply_cleanup import clean_text

MODES = ("inherit", "natural", "single", "custom")
PUNCTUATION = ("keep", "sentence_end")
DEFAULT_MAX_BUBBLES = 3
DEFAULT_INTERVAL = "0.8,1.5"
MAX_TEXT = 12000
PREVIEW_TEXT = 8192
MAX_CUSTOM_PATTERN = 200
SENTENCE_END = "。！？!?…"
SENTENCE_CLOSERS = "」』”’\"')）】]}>"


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


def _merge(ranges):
    ordered = sorted((start, end, kind) for start, end, kind in ranges if end > start)
    merged = []
    for start, end, kind in ordered:
        if merged and start <= merged[-1][1]:
            previous = merged[-1]
            merged[-1] = (previous[0], max(previous[1], end), previous[2])
        else:
            merged.append((start, end, kind))
    return merged


def protected_ranges(text):
    """Return (start, end, kind) spans that must never be reflowed or cleaned."""
    ranges = []
    cursor = 0
    opener = re.compile(r"^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)", re.M)
    while True:
        opening = opener.search(text, cursor)
        if not opening:
            break
        delimiter = opening.group(1)
        closing = re.compile(
            rf"^ {{0,3}}{re.escape(delimiter[0])}{{{len(delimiter)},}}[ \t]*(?:\n|$)", re.M
        ).search(text, opening.end())
        end = closing.end() if closing else len(text)
        ranges.append((opening.start(), end, "fenced_code"))
        cursor = end
    for match in re.finditer(r"(?<!`)`(?:[^`\n]+)`(?!`)", text):
        if not any(start <= match.start() < end for start, end, _ in ranges):
            ranges.append((match.start(), match.end(), "inline_code"))
    for line in re.finditer(r"^.*$", text, re.M):
        value = line.group(0)
        if value.count("`") % 2 and not any(
            start <= line.start() < end for start, end, _ in ranges
        ):
            ranges.append((line.start(), line.end(), "inline_code"))
    for match in re.finditer(r"https?://[^\s<>\"'`]+|www\.[^\s<>\"'`]+", text):
        if not any(start <= match.start() < end for start, end, _ in ranges):
            ranges.append((match.start(), match.end(), "url"))
    for match in re.finditer(r"<untrusted-data\b[^>]*>.*?</untrusted-data>", text, re.S):
        ranges.append((match.start(), match.end(), "untrusted"))
    return _merge(ranges)


def _in_ranges(position, ranges):
    return any(start <= position < end for start, end, _ in ranges)


def _map_outside(text, ranges, transform):
    parts = []
    cursor = 0
    for start, end, _ in ranges:
        if start > cursor:
            parts.append(transform(text[cursor:start]))
        parts.append(text[start:end])
        cursor = end
    if cursor < len(text):
        parts.append(transform(text[cursor:]))
    return "".join(parts)


def _strip_tail(bubble, ranges, punctuation):
    if punctuation != "sentence_end" or not bubble:
        return bubble
    position = len(bubble) - 1
    if bubble[position] in "。." and not _in_ranges(position, ranges):
        trimmed = bubble[:position].rstrip()
        if trimmed:
            return trimmed
    return bubble


def _custom_cleanup(text, compiled, ranges):
    if compiled is None:
        return text

    def transform(part):
        replaced = compiled.sub("", part)
        return replaced if replaced.strip() else part

    return _map_outside(text, ranges, transform)


def _merge_overflow(blocks, maximum):
    if len(blocks) <= maximum:
        return blocks, False
    if maximum <= 1:
        return ["\n".join(blocks)], True
    return [*blocks[: maximum - 1], "\n".join(blocks[maximum - 1 :])], True


def _split_sentences(text, ranges):
    blocks = []
    start = 0
    index = 0
    while index < len(text):
        if text[index] in SENTENCE_END and not _in_ranges(index, ranges):
            end = index + 1
            while end < len(text) and text[end] in SENTENCE_END:
                end += 1
            # Keep a closing quote/bracket with the sentence it closes:
            # 他说：“你好。” must not put the closing quote on the next bubble.
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


def _finish_bubbles(blocks, punctuation):
    result = []
    for block in blocks:
        value = block.strip()
        value = _strip_tail(value, protected_ranges(value), punctuation)
        if value.strip():
            result.append(value)
    return result


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
    warnings = []

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
            _finish_bubbles(blocks, punctuation),
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
        compiled = validate_custom(custom_regex, "自定义拆分规则")
        if compiled is None:
            raise StyleError("请先填写自定义拆分规则")
        cleanup = validate_custom(custom_cleanup, "自定义清理规则")
        try:
            blocks = [value for value in compiled.findall(cleaned) if value.strip()]
        except re.error as exc:
            raise StyleError(f"自定义拆分规则无法执行：{exc}") from exc
        if not blocks:
            blocks = [cleaned] if cleaned.strip() else []
            warnings.append("custom_no_match")
        blocks, merged = _merge_overflow(blocks, max_bubbles)
        if merged:
            warnings.append("merged_overflow")
        if cleanup is not None:
            blocks = [_custom_cleanup(value, cleanup, protected_ranges(value)) for value in blocks]
        return _result(
            mode,
            _finish_bubbles(blocks, punctuation),
            punctuation,
            kinds,
            warnings,
            (low, high),
            platform,
            streaming,
            segmented,
            original,
        )

    blocks = _natural_blocks(cleaned, ranges)
    blocks, merged = _merge_overflow(blocks, max_bubbles)
    if merged:
        warnings.append("merged_overflow")
    if len(_natural_blocks(cleaned, ranges)) == 1 and not merged and cleaned.strip():
        warnings.append("single_block")
    return _result(
        mode,
        _finish_bubbles(blocks, punctuation),
        punctuation,
        kinds,
        warnings,
        (low, high),
        platform,
        streaming,
        segmented,
        original,
    )


def _result(
    mode, bubbles, punctuation, kinds, warnings, interval, platform, streaming, segmented, original
):
    return {
        "mode": mode,
        "path": "host" if mode == "inherit" else "plugin",
        "hostPath": host_path(mode, platform, streaming, segmented),
        "bubbles": bubbles,
        "count": len(bubbles),
        "interval": [interval[0], interval[1]],
        "punctuation": punctuation,
        "protected": kinds,
        "warnings": warnings,
        "textLength": len(original),
        "removedCount": max(0, len(original) - sum(len(value) for value in bubbles)),
    }


def preview(payload):
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
    if mode != "inherit" and (payload.get("hostReplyPrefix") or payload.get("hostTtsEnabled")):
        fallback = "reply_prefix" if payload.get("hostReplyPrefix") else "tts"
        base = plan(text, mode="single", platform=platform)
        base.update(
            path="host",
            hostPath=f"host_fallback_{fallback}",
            warnings=[*base["warnings"], "host_decoration"],
            interval=[0.0, 0.0],
        )
        return base
    value = plan(
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
    parser.parse_args(argv)
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        result = preview(payload)
    except (StyleError, ValueError, json.JSONDecodeError) as error:
        message = str(error) if isinstance(error, StyleError) else "预览请求无效"
        print(json.dumps({"error": message}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
