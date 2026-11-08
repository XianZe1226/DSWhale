"""F4: protected ranges survive arbitrary backtick runs and URL punctuation."""

import asyncio

from dswhale.reply_style import plan_async, protected_ranges
from dswhale.reply_style_ops import custom_spans


def run(text, pattern=r"[^\n]+", cleanup=""):
    return asyncio.run(
        plan_async(text, mode="custom", custom_regex=pattern, custom_cleanup=cleanup)
    )


def test_inline_code_uses_the_matching_backtick_run():
    text = "前 ``a`b。c`` 后 `d。e` 尾"
    ranges = protected_ranges(text)
    inline = [
        value for start, end, kind in ranges if kind == "inline_code" for value in [text[start:end]]
    ]
    assert "``a`b。c``" in inline
    assert "`d。e`" in inline


def test_unclosed_inline_code_protects_the_rest_of_that_line():
    text = "前 `未闭合。仍在这一行\n下一行。"
    value = run(text)
    assert "`未闭合。仍在这一行" in value["bubbles"][0]
    assert "inline_code_unclosed" in value["warnings"] or "unclosed" in " ".join(value["warnings"])


def test_url_query_and_code_punctuation_are_never_cleanup_targets():
    text = "看 https://a.example/x?q=1。 和 `x。` 好。"
    value = run(text, cleanup="。")
    joined = "".join(value["bubbles"])
    assert "https://a.example/x?q=1。" in joined
    assert "`x。`" in joined
    assert joined.endswith("好")


def test_custom_spans_merge_a_boundary_that_cuts_the_protected_range():
    text = "甲。`乙。丙`。丁"
    spans = custom_spans(text, r"[^。]+。?")
    assert any("`乙。丙`" in text[start:end] for start, end, _kind in spans)


def test_protected_content_is_byte_identical_and_overflow_keeps_tail():
    text = "```\n甲。\n乙。\n```\n" + "尾" * 20
    value = run(text, pattern=r"尾+")
    assert "```\n甲。\n乙。\n```" in "".join(value["bubbles"])
    assert value["bubbles"][-1].endswith("尾" * 20)


def test_preview_and_runtime_share_protected_warnings():
    from dswhale.reply_style import preview

    value = preview({"text": "前 `未闭合。\n后。", "mode": "natural"})
    assert "inline_code_unclosed" in value["warnings"]


def test_protected_proof_rejects_a_missing_fragment():
    from dswhale.reply_style_ops import _protected_preserved

    source = "前 `代码。` 后"
    assert _protected_preserved(source, ["前 `代码。` 后"]) is True
    assert _protected_preserved(source, ["前 代码。 后"]) is False
