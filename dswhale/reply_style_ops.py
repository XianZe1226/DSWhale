"""Pure reply-style operations, safe to run in an isolated worker.

This module must stay stdlib-only. It is imported both by the plugin process
(for validation and protected-range calculation) and by the short-lived worker
that executes user supplied regular expressions. No code here may call the
network, the host event loop or any AstrBot module.
"""

from __future__ import annotations

import re

SENTENCE_END = "。！？!?…"
SENTENCE_CLOSERS = "」』”’\"')）】]}>"
MAX_CUSTOM_PATTERN = 2000
DEFAULT_HOST_REGEX = r".*?[。？！~…]+|.+$"
WORKER_MARKER = "DSWHALE_REPLY_STYLE_WORKER"


class CustomWorkerRequired(RuntimeError):
    """Raised when user regex work is attempted in the plugin process."""


def validate_rules(pattern, cleanup=""):
    """Validate user regexes without executing them outside the worker.

    The calling process may run this only inside ``reply_style_worker``. Shape
    checks (type, length, NUL) live elsewhere and never compile user input.
    """
    for label, value in (("自定义拆分规则", pattern), ("自定义清理规则", cleanup)):
        if not isinstance(value, str):
            raise ValueError(f"{label}必须是字符串")
        if len(value) > MAX_CUSTOM_PATTERN:
            raise ValueError(f"{label}不能超过 {MAX_CUSTOM_PATTERN} 个字符")
        if "\x00" in value:
            raise ValueError(f"{label}不能包含空字符")
        if not value.strip():
            continue
        try:
            compiled = re.compile(value, re.DOTALL | re.MULTILINE)
        except re.error as exc:
            raise ValueError(f"{label}语法无效：{exc}") from exc
        if compiled.groups:
            raise ValueError(f"{label}不能包含捕获组；请使用 (?:...) 非捕获分组")
        try:
            empty = compiled.search("")
        except re.error as exc:
            raise ValueError(f"{label}无法执行：{exc}") from exc
        if empty is not None:
            raise ValueError(f"{label}不能匹配空字符串")
    return True


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
    """Return (start, end, kind) spans that must never be reflowed or cleaned.

    Supports arbitrary backtick-run inline code (```` ``a`b`` ````), fenced
    blocks, URLs with query strings and untrusted-data envelopes. An unclosed
    inline-code run protects the whole line instead of guessing a boundary.
    """
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

    # Pair backtick runs of exactly the same length; shorter runs inside a
    # longer delimiter are content, not a boundary (CommonMark inline code).
    inline = re.compile(r"(?<!`)(`+)(?!`)([^\n]*?)(?<!`)\1(?!`)")
    for match in inline.finditer(text):
        if not any(start <= match.start() < end for start, end, _ in ranges):
            ranges.append((match.start(), match.end(), "inline_code"))

    for line in re.finditer(r"^.*$", text, re.M):
        if any(start <= line.start() < end for start, end, kind in ranges if kind == "fenced_code"):
            continue
        covered = [
            (max(start, line.start()), min(end, line.end()))
            for start, end, _ in ranges
            if start < line.end() and end > line.start()
        ]
        cursor = line.start()
        leftover = []
        for start, end in sorted(covered):
            if start > cursor:
                leftover.append(text[cursor:start])
            cursor = max(cursor, end)
        if cursor < line.end():
            leftover.append(text[cursor : line.end()])
        if any("`" in part for part in leftover):
            ranges.append((line.start(), line.end(), "inline_code_unclosed"))
    for match in re.finditer(r"https?://[^\s<>\"'`]+|www\.[^\s<>\"'`]+", text):
        if not any(start <= match.start() < end for start, end, _ in ranges):
            ranges.append((match.start(), match.end(), "url"))
    for match in re.finditer(r"<untrusted-data\b[^>]*>.*?</untrusted-data>", text, re.S):
        ranges.append((match.start(), match.end(), "untrusted"))
    return _merge(ranges)


def protected_warnings(text):
    kinds = {kind for _, _, kind in protected_ranges(text)}
    return ["inline_code_unclosed"] if "inline_code_unclosed" in kinds else []


def in_ranges(position, ranges):
    return any(start <= position < end for start, end, _ in ranges)


def map_outside(text, ranges, transform):
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


def strip_tail(bubble, punctuation):
    if punctuation != "sentence_end" or not bubble:
        return bubble
    position = len(bubble) - 1
    if bubble[position] in "。." and not in_ranges(position, protected_ranges(bubble)):
        trimmed = bubble[:position].rstrip()
        if trimmed:
            return trimmed
    return bubble


def custom_cleanup(text, pattern):
    """Remove matches outside protected ranges; empty results keep the text."""
    if not pattern:
        return text
    compiled = re.compile(pattern, re.DOTALL | re.MULTILINE)

    def transform(part):
        try:
            replaced = compiled.sub("", part)
        except re.error:
            return part
        return replaced if replaced.strip() else part

    return map_outside(text, protected_ranges(text), transform)


def merge_overflow(blocks, maximum):
    if len(blocks) <= maximum:
        return blocks, False
    if maximum <= 1:
        return ["\n".join(blocks)], True
    return [*blocks[: maximum - 1], "\n".join(blocks[maximum - 1 :])], True


def finish_bubbles(blocks, punctuation):
    result = []
    for block in blocks:
        value = block.strip()
        value = strip_tail(value, punctuation)
        if value.strip():
            result.append(value)
    return result


def _expand_protected(start, end, ranges):
    """Grow a custom match until its boundary no longer cuts protected text."""
    changed = True
    while changed:
        changed = False
        for range_start, range_end, _ in ranges:
            if range_start < start < range_end:
                start, changed = range_start, True
            if range_start < end < range_end:
                end, changed = range_end, True
    return start, end


def custom_spans(text, pattern):
    """Return non-empty match spans, expanded to whole protected ranges."""
    compiled = re.compile(pattern, re.DOTALL | re.MULTILINE)
    ranges = protected_ranges(text)
    spans = []
    for match in compiled.finditer(text):
        if match.end() <= match.start():
            continue
        start, end = _expand_protected(match.start(), match.end(), ranges)
        if spans and start < spans[-1][1]:
            spans[-1] = (spans[-1][0], max(spans[-1][1], end), spans[-1][2])
        else:
            spans.append((start, end, match.group(0)))
    return spans


def custom_plan(text, pattern, cleanup, maximum):
    """Execute user custom split/cleanup. Only the worker may call this."""
    from os import environ

    if environ.get(WORKER_MARKER) != "1":
        raise CustomWorkerRequired("custom regex must run in the isolated worker")
    validate_rules(pattern, cleanup)
    spans = custom_spans(text, pattern)
    warnings = []
    if spans:
        first_start, first_end, _ = spans[0]
        blocks = [text[:first_end]]
        cursor = first_end
        for start, end, _ in spans[1:]:
            blocks[-1] += text[cursor:start]
            blocks.append(text[start:end])
            cursor = end
        if cursor < len(text):
            blocks[-1] += text[cursor:]
    else:
        blocks = [text] if text.strip() else []
        warnings.append("custom_no_match")
    blocks = [block.strip("\n") for block in blocks if block.strip()]
    blocks, merged = merge_overflow(blocks, maximum)
    if merged:
        warnings.append("merged_overflow")
    if cleanup:
        try:
            blocks = [custom_cleanup(block, cleanup) for block in blocks]
        except re.error as error:
            raise ValueError(f"自定义清理规则无法执行：{error}") from error
    if not _protected_preserved(text, blocks):
        raise ValueError("自定义规则无法安全保留代码或链接")
    return {
        "blocks": finish_bubbles(blocks, "keep"),
        "warnings": warnings,
        "spans": [[start, end, kind] for start, end, kind in spans],
    }


def _protected_preserved(source, blocks):
    """Prove every protected source fragment survives at its ordered position.

    Searching from a moving cursor (rather than a global substring check) also
    catches a cleanup that collapses two identical protected fragments into one.
    """
    output = "\n".join(blocks)
    cursor = 0
    for start, end, _kind in protected_ranges(source):
        fragment = source[start:end]
        if not fragment:
            continue
        position = output.find(fragment, cursor)
        if position < 0:
            return False
        cursor = position + len(fragment)
    return True


def host_preview(text, host):
    """Simulate the host's own segmentation for the preview only."""
    segmented = (host or {}).get("segmented") or {}
    platform = str((host or {}).get("platform") or "aiocqhttp").lower()
    excluded = {"qq_official_webhook", "weixin_official_account", "dingtalk"}
    if not text.strip():
        return {"blocks": [], "warnings": [], "path": "host_single"}
    if (host or {}).get("streaming") is True:
        return {"blocks": [], "warnings": ["host_streaming"], "path": "host_stream"}
    if not segmented.get("enable") or platform in excluded:
        return {"blocks": [text], "warnings": [], "path": "host_single"}
    threshold = segmented.get("threshold")
    try:
        threshold = int(threshold)
    except (TypeError, ValueError):
        threshold = 0
    if threshold and len(text) > threshold:
        return {"blocks": [text], "warnings": [], "path": "host_segmented"}
    split_mode = segmented.get("split_mode") or "regex"
    warnings = []
    if split_mode == "words":
        words = segmented.get("split_words") or ["。", "？", "！", "~", "…"]
        escaped = sorted((re.escape(word) for word in words), key=len, reverse=True)
        pattern = re.compile(f"(.*?({'|'.join(escaped)})|.+$)", re.DOTALL)
        segments = pattern.findall(text)
        blocks = []
        for seg in segments:
            content = seg[0] if isinstance(seg, tuple) else seg
            if not isinstance(content, str):
                continue
            for word in words:
                if content.endswith(word):
                    content = content[: -len(word)]
                    break
            if content.strip():
                blocks.append(content)
        if not blocks:
            blocks = [text]
    else:
        pattern = segmented.get("regex") or DEFAULT_HOST_REGEX
        try:
            segments = re.findall(pattern, text, re.DOTALL | re.MULTILINE)
        except re.error:
            warnings.append("host_regex_invalid")
            segments = re.findall(DEFAULT_HOST_REGEX, text, re.DOTALL | re.MULTILINE)
        blocks = [seg for seg in segments if isinstance(seg, str) and seg.strip()]
        if not blocks:
            blocks = [text]
    cleanup = segmented.get("cleanup") or ""
    if cleanup:
        cleaned = []
        for seg in blocks:
            try:
                value = re.sub(cleanup, "", seg)
            except re.error:
                warnings.append("host_cleanup_invalid")
                value = seg
            value = value.strip()
            if value:
                cleaned.append(value)
        blocks = cleaned
    else:
        blocks = [seg.strip() for seg in blocks if seg.strip()]
    return {
        "blocks": blocks,
        "warnings": warnings,
        "path": "host_segmented",
    }
