"""Clean accidentally visible model protocol; never rewrite real tool messages.

Protocol patterns adapted from zexuanw958-svg/dafeiyu-config-pack's
astrbot_plugin_dafeiyu_clean (MIT). Attribution and license in THIRD_PARTY_NOTICES.
"""

import copy
import re

_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)", re.M)
_PATTERNS = [
    re.compile(r"<\s*system_reminder\s*>.*?<\s*/\s*system_reminder\s*>", re.S | re.I),
    re.compile(r"<\s*system_reminder\s*>[^\n]*", re.I),
    re.compile(r"<\s*/\s*system_reminder\s*>", re.I),
    re.compile(
        r"<\s*[|｜]+DSML[|｜]+function_calls\s*>.*?(?:<\s*/\s*[|｜]+DSML[|｜]+function_calls\s*>|$)",
        re.S | re.I,
    ),
    re.compile(r"<\s*/?\s*[|｜]+DSML[|｜]+[^>]*>", re.I),
    re.compile(r"<｜tool▁calls▁begin｜>.*?(?:<｜tool▁calls▁end｜>|$)", re.S),
    re.compile(r"<\s*tool_call\s*>.*?(?:<\s*/\s*tool_call\s*>|$)", re.S | re.I),
]


def clean_text(text):
    if not isinstance(text, str):
        return text

    def strip_protocol(part):
        for pattern in _PATTERNS:
            part = pattern.sub("", part)
        return part

    parts = []
    cursor = 0
    while opening := _FENCE.search(text, cursor):
        parts.append(strip_protocol(text[cursor : opening.start()]))
        delimiter = opening[1]
        closing = re.compile(
            rf"^ {{0,3}}{re.escape(delimiter[0])}{{{len(delimiter)},}}[ \t]*(?:\n|$)", re.M
        ).search(text, opening.end())
        end = closing.end() if closing else len(text)
        parts.append(text[opening.start() : end])
        cursor = end
    parts.append(strip_protocol(text[cursor:]))
    return "".join(parts)


def clean_content(content):
    if isinstance(content, str):
        return clean_text(content)
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                part["text"] = clean_text(part["text"])
            elif isinstance(getattr(part, "text", None), str):
                part.text = clean_text(part.text)
    return content


def clean_history(contexts):
    result = copy.deepcopy(contexts)
    for message in result or []:
        if isinstance(message, dict) and message.get("role") == "assistant":
            message["content"] = clean_content(message.get("content"))
    return result


async def clean_stream(stream):
    """Buffer each text segment so protocol tags split across chunks stay private.

    Typed control/tool/reasoning frames retain their original objects. Text is
    delivered at a segment boundary or completion; one segment is limited to
    1 MiB so a malformed endless response cannot grow memory without a bound.
    """
    from astrbot.api.message_components import Plain

    first = None
    fragments = []
    size = 0

    def flush():
        if first is None:
            return None
        text = clean_text("".join(fragments))
        if not text:
            return None
        result = copy.copy(first)
        result.chain = [Plain(text)]
        return result

    iterator = stream.__aiter__()
    try:
        async for chunk in iterator:
            control = chunk.type in {
                "break",
                "reasoning",
                "audio_chunk",
                "tool_call",
                "agent_stats",
            }
            if control or any(not isinstance(part, Plain) for part in chunk.chain):
                pending = flush()
                if pending is not None:
                    yield pending
                first, fragments, size = None, [], 0
                if not control:
                    chunk = copy.deepcopy(chunk)
                    for part in chunk.chain:
                        if isinstance(part, Plain):
                            part.text = clean_text(part.text)
                yield chunk
                continue
            if first is None:
                first = chunk
            for part in chunk.chain:
                size += len(part.text.encode("utf-8"))
                if size > 1024 * 1024:
                    raise ValueError("回复过长，请缩小本次请求")
                fragments.append(part.text)
        pending = flush()
        if pending is not None:
            yield pending
    finally:
        closer = getattr(iterator, "aclose", None)
        if closer:
            await closer()
