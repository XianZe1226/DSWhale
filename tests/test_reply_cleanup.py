from copy import deepcopy


def test_clean_reply_removes_accidental_protocol_text_preserves_code_and_meme_tags():
    from dswhale.reply_cleanup import clean_text

    assert clean_text("好哦<system_reminder>User ID: 12345</system_reminder>[开心]") == "好哦[开心]"
    assert (
        clean_text(
            '喔<｜DSML｜function_calls><｜DSML｜invoke name="x">secret</｜DSML｜invoke></｜DSML｜function_calls>'
        )
        == "喔"
    )
    code = "示例：\n```xml\n<system_reminder>example</system_reminder>\n```\n[开心]"
    assert clean_text(code) == code
    assert (
        clean_text("system_reminder 是字段名，链接 https://example.test/tool_call")
        == "system_reminder 是字段名，链接 https://example.test/tool_call"
    )
    assert clean_text("收到<system_reminder>internal\n明天聊") == "收到\n明天聊"
    outer = "````markdown\n```xml\n<system_reminder>literal example</system_reminder>\n```\n````"
    assert clean_text(outer) == outer
    unclosed = "```xml\n<tool_call>literal example</tool_call>"
    assert clean_text(unclosed) == unclosed


def test_history_cleanup_only_changes_assistant_text_without_mutating_user_or_tool_protocol():
    from dswhale.reply_cleanup import clean_history

    contexts = [
        {"role": "user", "content": "<system_reminder>user example</system_reminder>"},
        {
            "role": "assistant",
            "content": "好<tool_call>bad</tool_call>",
            "tool_calls": [{"id": "keep", "function": {"arguments": '{"text":"keep"}'}}],
        },
        {"role": "tool", "content": "<tool_call>tool output</tool_call>", "tool_call_id": "keep"},
    ]
    old = deepcopy(contexts)
    result = clean_history(contexts)
    assert contexts == old
    assert result[0] == old[0] and result[2] == old[2]
    assert result[1]["content"] == "好"
    assert result[1]["tool_calls"] == old[1]["tool_calls"]


async def test_sdk_hooks_clean_before_memory_and_outgoing_while_preserving_other_accounts():
    from types import SimpleNamespace

    from astrbot.api.message_components import Plain

    from main import DSWhale

    plugin = DSWhale.__new__(DSWhale)
    plugin.companion = SimpleNamespace(
        authorized=lambda event: event.owner, allow_delivery=lambda event: True
    )
    response = SimpleNamespace(completion_text="好<system_reminder>internal</system_reminder>")
    await plugin.clean_response(SimpleNamespace(owner=True), response)
    assert response.completion_text == "好"
    other = SimpleNamespace(completion_text="<tool_call>example</tool_call>")
    await plugin.clean_response(SimpleNamespace(owner=False), other)
    assert other.completion_text == "<tool_call>example</tool_call>"
    result = SimpleNamespace(chain=[Plain("收到<tool_call>internal</tool_call>[开心]")])
    await plugin.before_send(SimpleNamespace(owner=True, get_result=lambda: result))
    assert result.chain[0].text == "收到[开心]"


async def test_streaming_hook_cleans_fragmented_protocol_and_preserves_fences_and_controls():
    from types import SimpleNamespace

    from astrbot.api.event import MessageChain

    from main import DSWhale

    frames = [
        MessageChain().message(part)
        for part in [
            "好<system_",
            "reminder>private",
            "</system_reminder>[开心]",
            "\n```xml\n<tool_",
            "call>example</tool_call>\n```",
        ]
    ]
    control = MessageChain(type="tool_call").message("structured call")
    frames.append(control)

    async def stream():
        for frame in frames:
            yield frame

    result = SimpleNamespace(chain=[], async_stream=stream())
    plugin = DSWhale.__new__(DSWhale)
    plugin.companion = SimpleNamespace(
        authorized=lambda event: True, allow_delivery=lambda event: True
    )
    await plugin.before_send(SimpleNamespace(get_result=lambda: result))
    output = [frame async for frame in result.async_stream]
    assert (
        "".join(part.text for frame in output if frame.type != "tool_call" for part in frame.chain)
        == "好[开心]\n```xml\n<tool_call>example</tool_call>\n```"
    )
    assert output[-1] is control


async def test_social_command_keeps_original_whitespace_and_newlines():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from main import DSWhale

    plugin = DSWhale.__new__(DSWhale)
    social = SimpleNamespace(
        signature=AsyncMock(return_value="ok"), draft=AsyncMock(return_value="ok")
    )
    plugin.companion = SimpleNamespace(social=social)
    for command, method, callback in [
        ("signature", plugin.signature, social.signature),
        ("qzone-draft", plugin.qzone_draft, social.draft),
    ]:
        original = "Hello  world" if command == "signature" else "Hello  world\n第二行"
        event = SimpleNamespace(
            message_str=f"/fish {command} {original}",
            plain_result=lambda value: value,
            stop_event=lambda: None,
        )
        assert [value async for value in method(event, "Hello")] == ["ok"]
        callback.assert_awaited_once_with(event, original)
