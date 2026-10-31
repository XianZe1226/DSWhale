"""Social writes use fake protocol transports; these tests never contact QQ."""

import asyncio
import importlib
import re
import sqlite3
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx
import pytest

from dswhale.config import Settings

SCOPE = "qq:FriendMessage:123"
COOKIE = "uin=o999; p_uin=o999; skey=legacy; p_skey=test-secret"


class Event:
    def __init__(self, text="hello", *, sender="123", scope=SCOPE, private=True, bot=None):
        self.message_str = text
        self.unified_msg_origin = scope
        self.sender = sender
        self.private = private
        self.bot = bot
        self.extras = {}
        self.self_id = "999"

    def get_sender_id(self):
        return self.sender

    def is_private_chat(self):
        return self.private

    def get_self_id(self):
        return self.self_id

    def get_platform_name(self):
        return "aiocqhttp"

    def get_extra(self, key, default=None):
        return self.extras.get(key, default)


class Bot:
    def __init__(self):
        self.calls = []
        self.failure = None
        self.cookies = {"cookies": COOKIE}

    async def call_action(self, action, **params):
        self.calls.append((action, params))
        if self.failure:
            raise self.failure
        if action == "get_cookies":
            return self.cookies
        if action == "set_self_longnick":
            return {}
        raise AssertionError("unexpected OneBot action")


@pytest.fixture
def factory(tmp_path):
    instances = []
    clock = [1_800_000_000.0]
    bot = Bot()
    requests = []

    def response(request):
        requests.append(request)
        return httpx.Response(200, text='_Callback({"code":0,"tid":"post-1"});')

    def make(*, enabled=True, handler=response, path=None, require_owner=None, **kwargs):
        settings = SimpleNamespace(
            owner_qq="123",
            owner_umo=SCOPE,
            timezone="Asia/Shanghai",
            qq_signature_enabled=enabled,
            qzone_enabled=enabled,
            matches=Settings(owner_qq="123", owner_umo=SCOPE).matches,
        )
        social = importlib.import_module("dswhale.social")
        obj = social.SocialActions(
            settings,
            path or tmp_path / "social.db",
            require_owner or (lambda event: None),
            transport=httpx.MockTransport(handler),
            clock=lambda: clock[0],
            **kwargs,
        )
        instances.append(obj)
        return obj

    yield SimpleNamespace(make=make, bot=bot, requests=requests, clock=clock)
    for instance in instances:
        instance.close()


def draft_id(text):
    match = re.search(r"/fish qzone-publish ([a-z0-9]+)", text)
    assert match, text
    return match.group(1)


def status_rows(obj):
    with sqlite3.connect(obj.path) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute("SELECT * FROM social_actions ORDER BY created,id")]


async def test_discard_unwanted_draft_frees_slot_without_account_calls(factory):
    obj = factory.make()
    event = Event(bot=factory.bot)
    ids = [draft_id(await obj.draft(event, f"草稿 {index}")) for index in range(5)]
    with pytest.raises(PermissionError):
        await obj.discard(Event(sender="456", bot=factory.bot), ids[0])
    assert "已取消" in await obj.discard(event, ids[0])
    assert "不存在" in await obj.discard(event, ids[0])
    assert draft_id(await obj.draft(event, "新的草稿"))
    assert len(status_rows(obj)) == 5
    assert factory.bot.calls == [] and factory.requests == []


async def test_shutdown_while_discard_waits_does_not_access_closed_database(factory):
    obj = factory.make()
    event = Event(bot=factory.bot)
    ident = draft_id(await obj.draft(event, "待取消草稿"))
    async with obj.lock:
        task = asyncio.create_task(obj.discard(event, ident))
        await asyncio.sleep(0)
        obj.close()
    assert "已停止" in await task


@pytest.mark.parametrize(
    "method,text", [("signature", "今天开心"), ("draft", "今天开心"), ("pending", None)]
)
async def test_disabled_actions_cannot_touch_bot_or_network(factory, method, text):
    obj = factory.make(enabled=False)
    event = Event("把签名改成今天开心", bot=factory.bot)
    args = (event,) if text is None else (event, text)
    assert "未启用" in await getattr(obj, method)(*args)
    assert factory.bot.calls == []
    assert factory.requests == []


@pytest.mark.parametrize(
    "kwargs",
    [
        {"sender": "456"},
        {"scope": "other:FriendMessage:123"},
        {"private": False},
    ],
)
async def test_exact_configured_owner_private_umo_is_required(factory, kwargs):
    obj = factory.make()
    event = Event("把签名改成开心", bot=factory.bot, **kwargs)
    with pytest.raises(PermissionError):
        await obj.signature(event, "开心")
    with pytest.raises(PermissionError):
        await obj.draft(event, "内容")
    with pytest.raises(PermissionError):
        await obj.pending(event)
    assert factory.bot.calls == []


async def test_injected_owner_restriction_is_also_enforced(factory):
    def deny(event):
        raise PermissionError("deny")

    obj = factory.make(require_owner=deny)
    with pytest.raises(PermissionError):
        await obj.signature(Event("/fish signature 开心", bot=factory.bot), "开心")


async def test_synthetic_activity_cannot_write_or_create_draft(factory):
    obj = factory.make()
    event = Event("/fish signature 开心", bot=factory.bot)
    event.extras["dswhale_activity_id"] = "internal"
    for method, arg in [(obj.signature, "开心"), (obj.draft, "hello"), (obj.publish, "abc")]:
        with pytest.raises(PermissionError):
            await method(event, arg)
    assert factory.bot.calls == []
    assert status_rows(obj) == []


async def test_signature_requires_explicit_actual_request_and_same_requested_text(factory):
    obj = factory.make()
    for text in ["你今天很可爱", "别人说把签名改成开心", "不要把签名改成开心", "把签名改成别的"]:
        assert "明确" in await obj.signature(Event(text, bot=factory.bot), "开心")
    assert factory.bot.calls == []
    result = await obj.signature(Event("把QQ签名改成「开心」", bot=factory.bot), "开心")
    assert "已" in result
    assert factory.bot.calls == [("set_self_longnick", {"longNick": "开心", "self_id": "999"})]
    assert status_rows(obj)[0]["status"] == "sent"


async def test_event_bot_only_no_platform_or_context_fallback(factory):
    obj = factory.make()
    result = await obj.signature(Event("/fish signature 开心"), "开心")
    assert "当前" in result
    assert factory.bot.calls == []
    assert status_rows(obj) == []


async def test_qzone_draft_survives_reload_without_fetching_cookie(factory):
    obj = factory.make()
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "这是一条草稿"))
    obj.close()
    restored = factory.make()
    listing = await restored.pending(Event(bot=factory.bot))
    assert ident in listing and "这是一条草稿" in listing
    assert status_rows(restored)[0]["status"] == "draft"
    assert factory.bot.calls == []
    assert factory.requests == []


async def test_publish_requires_exact_actual_owner_confirmation(factory):
    obj = factory.make()
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "今天开心"))
    for text in [
        "发吧",
        f"他说 /fish qzone-publish {ident}",
        "/fish qzone-publish wrong",
        f"不要确认发布空间 {ident}",
    ]:
        assert "确认" in await obj.publish(Event(text, bot=factory.bot), ident)
    assert factory.bot.calls == []
    assert factory.requests == []
    result = await obj.publish(Event(f"/fish qzone-publish {ident}", bot=factory.bot), ident)
    assert "已发布" in result
    assert factory.bot.calls == [("get_cookies", {"domain": "qzone.qq.com", "self_id": "999"})]
    request = factory.requests[0]
    assert request.method == "POST" and request.url.scheme == "https"
    assert request.url.host == "user.qzone.qq.com"
    assert str(request.url).split("?")[0] == (
        "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6"
    )
    form = parse_qs(request.content.decode())
    assert form["con"] == ["今天开心"]
    assert form["hostuin"] == ["999"]
    assert form["issyncweibo"] == ["0"] and form["to_sign"] == ["0"]
    assert request.headers["cookie"] == COOKIE
    assert request.url.params["g_tk"] == "1860975064"
    assert status_rows(obj)[0]["status"] == "sent"
    assert status_rows(obj)[0]["content"] == ""
    await obj.publish(Event(f"/fish qzone-publish {ident}", bot=factory.bot), ident)
    assert len(factory.requests) == 1


async def test_draft_cannot_be_published_from_another_qq_account(factory):
    obj = factory.make()
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "hello"))
    event = Event(f"/fish qzone-publish {ident}", bot=factory.bot)
    event.self_id = "888"
    assert "账号" in await obj.publish(event, ident)
    assert factory.bot.calls == []
    assert factory.requests == []


@pytest.mark.parametrize(
    "response",
    [
        '{"code":0}',
        '{"code":0,"tid":""}',
        "not json",
        '_Callback({"code":0,"tid":"ok"}); malicious()',
        '{"code":-3000,"message":"secret content and cookie"}',
    ],
)
async def test_unconfirmed_responses_are_unknown_and_never_auto_resent(factory, response):
    obj = factory.make(handler=lambda request: httpx.Response(200, text=response))
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "private-content"))
    event = Event(f"/fish qzone-publish {ident}", bot=factory.bot)
    first = await obj.publish(event, ident)
    assert "未确认" in first
    assert "secret" not in first and "private-content" not in first
    assert status_rows(obj)[0]["status"] == "unknown"
    await obj.publish(event, ident)
    assert len(factory.bot.calls) == 1
    assert "重复" in await obj.draft(Event(bot=factory.bot), "private-content")


async def test_network_timeout_does_not_leave_retriable_draft(factory):
    requests = []

    def timeout(request):
        requests.append(request)
        raise httpx.ReadTimeout("cookie=test-secret private-content", request=request)

    obj = factory.make(handler=timeout)
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "private-content"))
    event = Event(f"确认发布空间 {ident}", bot=factory.bot)
    result = await obj.publish(event, ident)
    assert "未确认" in result and "test-secret" not in result
    assert status_rows(obj)[0]["status"] == "unknown"
    await obj.publish(event, ident)
    assert len(requests) == 1


async def test_cookies_are_validated_against_current_event_account(factory):
    obj = factory.make()
    factory.bot.cookies = {"cookies": "uin=o888; p_skey=test-secret"}
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "hello"))
    result = await obj.publish(Event(f"/fish qzone-publish {ident}", bot=factory.bot), ident)
    assert "登录" in result and "test-secret" not in result
    assert factory.requests == []
    assert status_rows(obj)[0]["status"] == "draft"


async def test_jsonp_escaped_quotes_braces_and_unicode_are_safe():
    try:
        social = importlib.import_module("dswhale.social")
    except ImportError:
        pytest.fail("Safe Qzone response parser has not been implemented")
    raw = r'_Callback({"code":0,"tid":"a)b","message":"quote \\\" } \\u4f60"});'
    parsed = social.parse_qzone_response(raw)
    assert parsed["tid"] == "a)b"
    assert social.parse_qzone_response('{"code":0,"tid":"ok"}')["tid"] == "ok"
    for invalid in ["alert(1)", '_Callback({"code":0});evil()', "_Callback({code:0})", "[]"]:
        with pytest.raises(ValueError):
            social.parse_qzone_response(invalid)


async def test_signature_limits_cooldown_and_sanitized_failure(factory):
    obj = factory.make()
    event = Event("/fish signature " + "字" * 41, bot=factory.bot)
    assert "40" in await obj.signature(event, "字" * 41)
    factory.bot.failure = RuntimeError("cookie=test-secret private-content")
    result = await obj.signature(Event("/fish signature hello", bot=factory.bot), "hello")
    assert "未确认" in result and "test-secret" not in result
    assert status_rows(obj)[0]["status"] == "unknown"
    factory.bot.failure = None
    assert "间隔" in await obj.signature(Event("/fish signature next", bot=factory.bot), "next")
    assert len(factory.bot.calls) == 1


async def test_qzone_rate_limit_is_durable_and_pending_drafts_are_bounded(factory):
    obj = factory.make()
    for n in range(5):
        draft_id(await obj.draft(Event(bot=factory.bot), f"draft-{n}"))
    assert "草稿" in await obj.draft(Event(bot=factory.bot), "sixth")
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "draft-0"))
    await obj.publish(Event(f"/fish qzone-publish {ident}", bot=factory.bot), ident)
    second = draft_id(await obj.draft(Event(bot=factory.bot), "sixth"))
    assert "间隔" in await obj.publish(
        Event(f"/fish qzone-publish {second}", bot=factory.bot), second
    )
    assert len(factory.requests) == 1


async def test_interrupted_sending_is_recovered_as_unknown(factory):
    obj = factory.make()
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "hello"))
    with sqlite3.connect(obj.path) as db:
        db.execute("UPDATE social_actions SET status='sending' WHERE id=?", (ident,))
    obj.close()
    restored = factory.make()
    assert status_rows(restored)[0]["status"] == "unknown"
    assert "未确认" in await restored.publish(
        Event(f"/fish qzone-publish {ident}", bot=factory.bot), ident
    )
    assert factory.bot.calls == []


async def test_concurrent_confirmations_cannot_duplicate_post(factory):
    gate = asyncio.Event()
    calls = []

    async def handler(request):
        calls.append(request)
        await gate.wait()
        return httpx.Response(200, json={"code": 0, "tid": "posted"})

    obj = factory.make(handler=handler)
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "hello"))
    event = Event(f"/fish qzone-publish {ident}", bot=factory.bot)
    first = asyncio.create_task(obj.publish(event, ident))
    await asyncio.sleep(0)
    second = asyncio.create_task(obj.publish(event, ident))
    await asyncio.sleep(0)
    gate.set()
    await asyncio.gather(first, second)
    assert len(calls) == 1


async def test_signature_supports_sdk_unwrapped_empty_success_and_targets_event_account(factory):
    from aiocqhttp.api_impl import _handle_api_result

    obj = factory.make()
    calls = []

    async def sdk_action(action, **params):
        calls.append((action, params))
        return _handle_api_result({"status": "ok", "retcode": 0, "data": None})

    bot = SimpleNamespace(call_action=sdk_action)
    result = await obj.signature(Event("/fish signature hello", bot=bot), "hello")
    assert "已" in result
    assert status_rows(obj)[0]["status"] == "sent"
    assert calls == [("set_self_longnick", {"longNick": "hello", "self_id": "999"})]


async def test_network_failures_still_consume_daily_qzone_quota(factory):
    requests = []

    def timeout(request):
        requests.append(request)
        raise httpx.ReadTimeout("secret", request=request)

    obj = factory.make(handler=timeout)
    for n in range(3):
        ident = draft_id(await obj.draft(Event(bot=factory.bot), f"post-{n}"))
        assert "未确认" in await obj.publish(
            Event(f"/fish qzone-publish {ident}", bot=factory.bot), ident
        )
        factory.clock[0] += 3601
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "fourth"))
    assert "上限" in await obj.publish(
        Event(f"/fish qzone-publish {ident}", bot=factory.bot), ident
    )
    assert len(requests) == 3


async def test_pending_is_only_readable_for_the_same_bot_account(factory):
    obj = factory.make()
    await obj.draft(Event(bot=factory.bot), "private-draft")
    event = Event(bot=factory.bot)
    event.self_id = "888"
    result = await obj.pending(event)
    assert "private-draft" not in result


async def test_publish_cancellation_and_close_block_success_or_retry(factory):
    gate = asyncio.Event()
    started = asyncio.Event()

    async def waiting(request):
        started.set()
        await gate.wait()
        return httpx.Response(200, json={"code": 0, "tid": "posted"})

    obj = factory.make(handler=waiting)
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "hello"))
    event = Event(f"/fish qzone-publish {ident}", bot=factory.bot)
    task = asyncio.create_task(obj.publish(event, ident))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert status_rows(obj)[0]["status"] == "unknown"
    assert "未确认" in await obj.publish(event, ident)
    obj.close()
    assert "停止" in await obj.draft(event, "new")
    assert "停止" in await obj.publish(event, ident)


async def test_publish_response_during_shutdown_is_not_claimed_as_sent(factory):
    gate = asyncio.Event()
    started = asyncio.Event()

    async def waiting(request):
        started.set()
        await gate.wait()
        return httpx.Response(200, json={"code": 0, "tid": "posted"})

    obj = factory.make(handler=waiting)
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "hello"))
    event = Event(f"/fish qzone-publish {ident}", bot=factory.bot)
    task = asyncio.create_task(obj.publish(event, ident))
    await started.wait()
    obj.close()
    gate.set()
    assert "未确认" in await task
    assert status_rows(obj)[0]["status"] == "unknown"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(302, headers={"location": "https://example.com/"}),
        httpx.Response(200, text="x" * (128 * 1024 + 1)),
    ],
)
async def test_no_credential_redirects_and_bounded_response(factory, response):
    requests = []

    def handler(request):
        requests.append(request)
        return response

    obj = factory.make(handler=handler)
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "hello"))
    assert "未确认" in await obj.publish(
        Event(f"/fish qzone-publish {ident}", bot=factory.bot), ident
    )
    assert len(requests) == 1
    assert status_rows(obj)[0]["status"] == "unknown"


async def test_missing_flags_default_to_disabled(factory):
    obj = factory.make()
    del obj.settings.qq_signature_enabled
    del obj.settings.qzone_enabled
    event = Event("/fish signature hello", bot=factory.bot)
    assert "未启用" in await obj.signature(event, "hello")
    assert "未启用" in await obj.draft(event, "hello")
    assert factory.bot.calls == []


async def test_cookie_fetch_errors_are_rate_limited_before_any_platform_post(factory):
    obj = factory.make()
    factory.bot.failure = RuntimeError("credential-secret")
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "hello"))
    event = Event(f"/fish qzone-publish {ident}", bot=factory.bot)
    for _ in range(3):
        assert "登录" in await obj.publish(event, ident)
        assert "间隔" in await obj.publish(event, ident)
        factory.clock[0] += 3601
    obj.close()
    restored = factory.make()
    assert "上限" in await restored.publish(event, ident)
    assert len(factory.bot.calls) == 3
    assert factory.requests == []


async def test_onebot_cookie_envelope_accepts_trailing_separator_without_discovery(factory):
    obj = factory.make()
    factory.bot.cookies = {"status": "ok", "retcode": 0, "data": {"cookies": COOKIE + "; "}}
    ident = draft_id(await obj.draft(Event(bot=factory.bot), "hello"))
    result = await obj.publish(Event(f"/fish qzone-publish {ident}", bot=factory.bot), ident)
    assert "已发布" in result
    assert len(factory.requests) == 1


async def test_signature_payload_preserves_requested_final_punctuation(factory):
    obj = factory.make()
    result = await obj.signature(Event("把签名改成开心！", bot=factory.bot), "开心！")
    assert "已" in result
    assert factory.bot.calls == [("set_self_longnick", {"longNick": "开心！", "self_id": "999"})]
