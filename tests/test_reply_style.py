import asyncio
import json
import subprocess
import sys

import pytest

from dswhale.reply_style import (
    StyleError,
    host_path,
    parse_interval,
    plan,
    plan_async,
    preview,
    prompt_hint,
    protected_ranges,
    validate_custom,
)


def plan_custom(text, **kwargs):
    return asyncio.run(plan_async(text, mode="custom", **kwargs))


def test_natural_splits_three_lines_without_punctuation():
    result = plan("第一句\n第二句\n第三句", mode="natural")
    assert result["bubbles"] == ["第一句", "第二句", "第三句"]
    assert result["count"] == 3


def test_natural_single_line_without_punctuation_stays_one_bubble():
    result = plan("就这一句没有标点", mode="natural")
    assert result["count"] == 1
    assert result["bubbles"] == ["就这一句没有标点"]


def test_natural_two_lines_become_two_complete_bubbles():
    result = plan("第一句\n第二句", mode="natural")
    assert result["bubbles"] == ["第一句", "第二句"]


def test_natural_ignores_blank_lines_and_crlf():
    result = plan("第一句\r\n\r\n  \n第二句\r\n", mode="natural")
    assert result["bubbles"] == ["第一句", "第二句"]


def test_natural_five_lines_merge_tail_and_keep_all_text():
    text = "一行\n二行\n三行\n四行\n五行"
    result = plan(text, mode="natural", max_bubbles=3)
    assert result["count"] == 3
    assert result["bubbles"][0] == "一行"
    assert result["bubbles"][1] == "二行"
    assert {"三行", "四行", "五行"} <= set(result["bubbles"][2].splitlines())
    assert "merged_overflow" in result["warnings"]


def test_natural_sentence_end_fallback_when_no_newline():
    result = plan("甲。乙！丙？丁", mode="natural", max_bubbles=3)
    assert result["bubbles"] == ["甲。", "乙！", "丙？\n丁"]


def test_natural_max_one_merges_everything_without_truncation():
    result = plan("甲。乙。丙。", mode="natural", max_bubbles=1)
    assert result["count"] == 1
    assert {"甲", "乙", "丙"} <= set(result["bubbles"][0].replace("\n", "").replace("。", ""))


def test_natural_max_three_keeps_url_number_and_version():
    text = "访问 https://example.com/a~ 看看 v1.2.3 和 3.5 版"
    result = plan(text, mode="natural")
    assert result["count"] == 1
    assert "https://example.com/a~" in result["bubbles"][0]
    assert "v1.2.3" in result["bubbles"][0]
    assert "3.5" in result["bubbles"][0]
    assert result["protected"] == ["url"]


def test_closing_quote_stays_with_the_sentence_it_closes():
    value = plan("他说：“你好。”下句", mode="natural")
    assert value["bubbles"] == ["他说：“你好。”", "下句"]


def test_natural_does_not_split_on_decimal_point_or_domain_dot():
    result = plan("版本 1.2.3 已发布。请更新", mode="natural")
    assert result["bubbles"][0] == "版本 1.2.3 已发布。"


def test_natural_protects_inline_code_punctuation():
    result = plan("执行 `a。b` 即可。然后重启", mode="natural")
    assert result["bubbles"] == ["执行 `a。b` 即可。", "然后重启"]
    assert "inline_code" in result["protected"]


def test_natural_fenced_code_falls_back_to_one_bubble():
    text = "看代码：\n```python\nprint('a。b')\n```\n完成。"
    result = plan(text, mode="natural")
    assert result["count"] == 1
    assert "```python" in result["bubbles"][0]
    assert "code_fallback" in result["warnings"]


def test_natural_long_text_falls_back_without_truncation():
    text = "甲" * 12001
    result = plan(text, mode="natural")
    assert result["count"] == 1
    assert result["bubbles"][0] == text
    assert "long_text_fallback" in result["warnings"]


def test_punctuation_keep_does_not_touch_question_or_tilde():
    result = plan("真的吗？\n好~", mode="natural", punctuation="keep")
    assert result["bubbles"] == ["真的吗？", "好~"]


def test_punctuation_sentence_end_removes_one_period_only():
    result = plan("第一句。\n第二句.\n第三句！", mode="natural", punctuation="sentence_end")
    assert result["bubbles"] == ["第一句", "第二句", "第三句！"]


def test_punctuation_sentence_end_leaves_protected_tail_alone():
    result = plan(
        "见 https://example.com/a. 和 `code.`", mode="natural", punctuation="sentence_end"
    )
    assert "https://example.com/a." in result["bubbles"][0]
    assert "`code.`" in result["bubbles"][0]


def test_single_mode_never_splits_and_cleans_protocol():
    text = "第一句。第二句。<system_reminder>ignore</system_reminder>第三句。"
    result = plan(text, mode="single")
    assert result["count"] == 1
    assert "system_reminder" not in result["bubbles"][0]
    assert "第一句。第二句。" in result["bubbles"][0]


def test_inherit_mode_keeps_text_untouched_and_reports_host_path():
    text = "甲。\n乙。"
    result = plan(text, mode="inherit", platform="aiocqhttp", segmented=True)
    assert result["bubbles"] == [text.strip()]
    assert result["hostPath"] == "host_segmented"
    assert host_path("inherit", "aiocqhttp", streaming=True) == "host_stream_realtime"
    assert host_path("inherit", "qq_official_webhook") == "host_single"
    assert host_path("natural") == "plugin_owned"


def test_custom_regex_splits_and_merges_tail():
    result = plan_custom("甲\n乙\n丙\n丁", custom_regex=r"[^\n]+", max_bubbles=2)
    assert result["bubbles"] == ["甲", "乙\n丙\n丁"]
    assert "merged_overflow" in result["warnings"]


def test_custom_regex_must_not_have_capture_groups_or_match_empty():
    with pytest.raises(StyleError, match="捕获组"):
        validate_custom(r"(甲|乙)")
    with pytest.raises(StyleError, match="空字符串"):
        validate_custom(r"x*")
    with pytest.raises(StyleError, match="语法"):
        validate_custom("(")
    with pytest.raises(StyleError, match="200"):
        validate_custom("a" * 201)


def test_custom_cleanup_does_not_touch_protected_spans():
    result = plan_custom(
        "看 https://example.com/a。 和 `x。` 好。",
        custom_regex=r"[^\n]+",
        custom_cleanup=r"。",
    )
    assert "https://example.com/a。" in result["bubbles"][0]
    assert "`x。`" in result["bubbles"][0]
    assert result["bubbles"][0].endswith("好")


def test_custom_no_match_falls_back_to_whole_text():
    result = plan_custom("没有匹配", custom_regex=r"Z+")
    assert result["count"] == 1
    assert result["bubbles"] == ["没有匹配"]
    assert "custom_no_match" in result["warnings"]


def test_interval_validation():
    assert parse_interval("0.8,1.5") == (0.8, 1.5)
    with pytest.raises(StyleError, match="0.2–5"):
        parse_interval("0.1,1")
    with pytest.raises(StyleError, match="最小值"):
        parse_interval("2,1")
    with pytest.raises(StyleError, match="数字"):
        parse_interval("快,慢")
    with pytest.raises(StyleError, match="1–3"):
        plan("文本", max_bubbles=4)
    with pytest.raises(StyleError, match="捕获组"):
        plan_custom("文本", custom_regex=r"(.)")


def test_protected_ranges_cover_urls_code_and_untrusted_blocks():
    text = "看 https://a.example/x 和 `b`\n<untrusted-data>e。f</untrusted-data>\n```\nc。d\n```"
    kinds = {kind for _, _, kind in protected_ranges(text)}
    assert {"url", "inline_code", "fenced_code", "untrusted"} <= kinds


def test_preview_returns_runtime_identical_bubbles():
    payload = {
        "text": "甲。乙。丙。",
        "mode": "natural",
        "maxBubbles": 2,
        "interval": "1,2",
        "punctuation": "sentence_end",
        "platform": "aiocqhttp",
    }
    value = preview(payload)
    runtime = plan(
        payload["text"],
        mode="natural",
        max_bubbles=2,
        punctuation="sentence_end",
    )
    assert value["bubbles"] == runtime["bubbles"]
    assert value["interval"] == [1.0, 2.0]
    assert value["path"] == "plugin"
    assert value["hostPath"] == "plugin_owned"


def test_preview_rejects_long_text_and_bad_mode():
    with pytest.raises(StyleError, match="8192"):
        preview({"text": "甲" * 8193, "mode": "natural"})
    with pytest.raises(StyleError, match="回复方式"):
        preview({"text": "甲", "mode": "unknown"})
    with pytest.raises(StyleError, match="预览请求"):
        preview([])


def test_cli_preview_round_trip():
    runtime = "甲。乙。丙。"
    # The CLI contract is exercised through a direct main() call so no
    # platform-specific subprocess encoding is involved.
    import io

    from dswhale import reply_style

    source = json.dumps({"text": runtime, "mode": "natural", "maxBubbles": 2})
    old_stdin, old_stdout = sys.stdin, sys.stdout
    sys.stdin, sys.stdout = io.StringIO(source), io.StringIO()
    try:
        assert reply_style.main(["preview"]) == 0
        value = json.loads(sys.stdout.getvalue())
    finally:
        sys.stdin, sys.stdout = old_stdin, old_stdout
    assert value["bubbles"] == plan(runtime, mode="natural", max_bubbles=2)["bubbles"]
    assert host_path("natural") == "plugin_owned"


def test_cli_module_is_discoverable_and_empty_stdin_is_safe():
    completed = subprocess.run(
        [sys.executable, "-m", "dswhale.reply_style", "preview"],
        input="",
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["count"] == 0


def test_prompt_hint_states_soft_limit_and_single_mode():
    assert "1–3" in prompt_hint("natural")
    assert "一条" in prompt_hint("single")
    assert prompt_hint("inherit") == ""


def test_preview_marks_host_fallback_for_reply_prefix():
    value = preview({"text": "甲。乙。", "mode": "natural", "hostReplyPrefix": True})
    assert value["path"] == "host"
    assert value["hostPath"] == "host_fallback_reply_prefix"
    assert value["bubbles"] == ["甲。乙。"]
    assert "host_decoration" in value["warnings"]


def test_preview_marks_host_fallback_for_tts():
    value = preview({"text": "甲", "mode": "single", "hostTtsEnabled": True})
    assert value["path"] == "host"
    assert value["hostPath"] == "host_fallback_tts"
