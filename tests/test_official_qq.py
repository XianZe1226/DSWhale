import asyncio
from dataclasses import replace
from datetime import datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from astrbot.api.message_components import Plain
from astrbot.core.message.message_event_result import MessageChain
from astrbot.core.platform.platform_metadata import PlatformMetadata
from astrbot.core.platform.sources.qqofficial.qqofficial_message_event import QQOfficialMessageEvent

from dswhale.adapter import Companion
from dswhale.config import Settings
from dswhale.store import Store

SCOPE = "official-test:FriendMessage:OPAQUE_CaseSensitive_001"
NOW = datetime(2026, 10, 25, 10, tzinfo=ZoneInfo("Asia/Shanghai"))


def dual_settings(**extra):
    return Settings.from_mapping(
        {
            "owner_qq": "12345678",
            "owner_umo": "old-qq:FriendMessage:12345678",
            "official_owner_umo": SCOPE,
            "qq_connection_mode": "napcat",
            "qq_default_delivery": "official",
            **extra,
        }
    )


def settings(**extra):
    return Settings.from_mapping(
        {"qq_connection_mode": "official", "official_owner_umo": SCOPE, **extra}
    )


def test_official_identity_is_private_adapter_and_instance_scoped_without_rewriting_onebot_binding():
    cfg = settings(owner_qq="12345678", owner_umo="old-qq:FriendMessage:12345678")
    assert cfg.owner_scope == SCOPE and cfg.owner_id == "OPAQUE_CaseSensitive_001"
    assert cfg.owner_qq == "12345678" and cfg.owner_umo == "old-qq:FriendMessage:12345678"
    assert cfg.matches(cfg.owner_id, SCOPE, private=True, platform_type="qq_official")
    for sender, scope, private, kind in [
        (cfg.owner_id, SCOPE, False, "qq_official"),
        (cfg.owner_id, SCOPE, True, "aiocqhttp"),
        ("opaque_casesensitive_001", SCOPE, True, "qq_official"),
        (cfg.owner_id, SCOPE.replace("official-test", "other"), True, "qq_official"),
    ]:
        assert not cfg.matches(sender, scope, private=private, platform_type=kind)
    for scope in [
        "official-test:GroupMessage:123",
        "official-test:FriendMessage:a:b",
        "official-test:FriendMessage:bad\nid",
    ]:
        with pytest.raises(ValueError):
            settings(official_owner_umo=scope)
    dual = settings(
        owner_qq="12345678",
        owner_umo="old-qq:FriendMessage:12345678",
        qq_signature_enabled=True,
        qzone_enabled=True,
    )
    assert {binding.channel for binding in dual.owner_bindings} == {"napcat", "official"}
    assert dual.delivery_binding.channel == "official"
    napcat_binding = dual.binding_for(
        "12345678", "old-qq:FriendMessage:12345678", private=True, platform_type="aiocqhttp"
    )
    assert napcat_binding is not None and napcat_binding.channel == "napcat"
    official_binding = dual.binding_for(
        dual.owner_id, SCOPE, private=True, platform_type="qq_official"
    )
    assert official_binding is not None and official_binding.channel == "official"
    assert not dual.matches(cfg.owner_id, SCOPE, private=True, platform_type="aiocqhttp")
    switched = replace(dual, qq_default_delivery="napcat")
    assert switched.delivery_binding.channel == "napcat"
    assert (
        switched.binding_for(dual.owner_id, SCOPE, private=True, platform_type="qq_official")
        is not None
    )


class Host:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.sent = []
        self.client = SimpleNamespace(
            _active_websockets=[
                SimpleNamespace(
                    _conn=SimpleNamespace(closed=False),
                    _session={"session_id": "SYNTHETIC-GATEWAY"},
                )
            ]
        )
        self.platform = SimpleNamespace(
            meta=lambda: PlatformMetadata("qq_official", "test", "official-test"),
            get_client=lambda: self.client,
            create_event=self.event,
        )

    def event(self, message):
        return QQOfficialMessageEvent(
            message.message_str, message, self.platform.meta(), message.session_id, self.client
        )

    def get_platform_inst(self, ident):
        assert ident == "official-test"
        return self.platform

    def get_event_queue(self):
        return self.queue

    async def send_message(self, scope, chain):
        self.sent.append((scope, chain))
        return True


@pytest.mark.asyncio
async def test_official_proactive_event_uses_bound_context_transport_and_records_uncertainty(
    tmp_path, monkeypatch
):
    monkeypatch.setattr("dswhale.adapter.now_utc", lambda: NOW + timedelta(minutes=241))
    host = Host()
    c = Companion(host, settings(proactive_enabled=True), Store(tmp_path / "state.db"))
    try:
        c.scheduler.human_received(NOW)
        await c.tick(NOW + timedelta(minutes=241))
        assert host.queue.qsize() == 1
        event = await host.queue.get()
        assert event.unified_msg_origin == SCOPE
        assert c.authorized(event)
        await event.send(MessageChain([Plain("给你留句话")]))
        c.delivered(event, NOW + timedelta(minutes=241))
        assert len(host.sent) == 1 and host.sent[0][0] == SCOPE
        assert c.store.activity(c.internal_id(event)).status == "uncertain"
        await c.tick(NOW + timedelta(minutes=242))
        assert host.queue.empty() and len(host.sent) == 1
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_official_streaming_collects_one_submission_without_using_missing_raw_message(
    tmp_path,
):
    from dswhale.qq_transport import owner_event

    host = Host()
    c = Companion(host, settings(), Store(tmp_path / "state.db"))
    try:
        event = await owner_event(c, "synthetic prompt", "synthetic-id")

        async def chunks():
            yield MessageChain([Plain("你好")])
            yield MessageChain([Plain("，大肥鱼")])

        await event.send_streaming(chunks())
        assert len(host.sent) == 1 and host.sent[0][0] == SCOPE
        assert "".join(p.text for p in host.sent[0][1].chain) == "你好，大肥鱼"
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_official_health_requires_a_live_gateway_session_and_exposes_no_openid(tmp_path):
    import json

    host = Host()
    c = Companion(host, settings(), Store(tmp_path / "state.db"))
    host.client._active_websockets = [
        SimpleNamespace(
            _conn=SimpleNamespace(closed=False),
            _session={"session_id": "SYNTHETIC-GATEWAY-SESSION"},
        )
    ]
    c.write_health()
    file = tmp_path / "health.json"
    report = json.loads(file.read_text())
    assert report["format"] == 2
    assert report["channels"]["official"]["bound"] is True
    assert report["channels"]["official"]["platformReady"] is True
    assert report["channels"]["official"]["protocolConnected"] is True
    assert report["channels"]["napcat"]["bound"] is False
    assert "OPAQUE" not in file.read_text() and "GATEWAY" not in file.read_text()
    host.client._active_websockets[0]._session = {}
    c.write_health()
    assert json.loads(file.read_text())["channels"]["official"]["protocolConnected"] is False
    await c.close()


@pytest.mark.asyncio
async def test_official_stream_fallback_copies_reused_deltas(tmp_path):
    from dswhale.qq_transport import owner_event

    host = Host()
    c = Companion(host, settings(), Store(tmp_path / "state.db"))
    try:
        event = await owner_event(c, "synthetic", "stream-copy")
        part = Plain("你")

        async def chunks():
            yield MessageChain([part])
            part.text = "好"
            yield MessageChain([part])

        await event.send_streaming(chunks())
        assert "".join(p.text for p in host.sent[0][1].chain) == "你好"
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_official_real_events_require_c2c_provenance_and_binding_evidence(tmp_path):
    from botpy.message import C2CMessage, DirectMessage

    from dswhale.qq_identity import confirmed_c2c_scope, remember_c2c_scope

    host = Host()
    c = Companion(host, settings(), Store(tmp_path / "state.db"))
    try:
        from astrbot.api.platform import AstrBotMessage, MessageMember, MessageType

        msg = AstrBotMessage()
        msg.message_str = "synthetic"
        msg.message = []
        msg.type = MessageType.FRIEND_MESSAGE
        msg.sender = MessageMember(c.settings.owner_id, "synthetic")
        msg.session_id = c.settings.owner_id
        event = host.event(msg)
        msg.raw_message = object.__new__(DirectMessage)
        assert not c.authorized(event)
        assert not remember_c2c_scope(tmp_path, event)
        assert not confirmed_c2c_scope(tmp_path, SCOPE)
        msg.raw_message = C2CMessage(
            None, "synthetic", {"author": {"user_openid": c.settings.owner_id}}
        )
        assert c.authorized(event)
        assert remember_c2c_scope(tmp_path, event)
        assert confirmed_c2c_scope(tmp_path, SCOPE)
        assert c.settings.owner_id not in (tmp_path / "official-c2c.json").read_text()
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_both_bindings_authorize_independently_of_the_default_delivery(tmp_path):
    from astrbot.api.platform import AstrBotMessage, MessageMember, MessageType
    from botpy.message import C2CMessage

    host = Host()
    companion = Companion(host, dual_settings(), Store(tmp_path / "state.db"))
    try:
        message = AstrBotMessage()
        message.message_str = "synthetic"
        message.message = []
        message.type = MessageType.FRIEND_MESSAGE
        message.sender = MessageMember(companion.settings.owner_id, "synthetic")
        message.session_id = companion.settings.owner_id
        event = host.event(message)
        message.raw_message = C2CMessage(
            None, "synthetic", {"author": {"user_openid": companion.settings.owner_id}}
        )
        assert companion.authorized(event)
        for default in ("official", "napcat", ""):
            companion.settings = replace(companion.settings, qq_default_delivery=default)
            assert companion.authorized(event)
        message.raw_message = None
        assert not companion.authorized(event)
    finally:
        await companion.close()


@pytest.mark.asyncio
async def test_dual_official_tick_ledger_matches_event_and_stays_uncertain(tmp_path, monkeypatch):
    monkeypatch.setattr("dswhale.adapter.now_utc", lambda: NOW)
    host = Host()
    dual = dual_settings(
        proactive_enabled=True,
        quiet_start="00:00",
        quiet_end="00:00",
        daily_limit=5,
        min_interval_minutes=120,
        max_interval_minutes=120,
    )
    c = Companion(host, dual, Store(tmp_path / "state.db"))
    try:
        # A due budget for both bound scopes; the default (official) is the target.
        for binding in dual.owner_bindings:
            c.store.state(binding.umo)
            c.store.db.execute(
                "UPDATE sessions SET next_due=?, paused=0 WHERE scope=?",
                (NOW.timestamp() - 1, binding.umo),
            )
        await c.tick(NOW)
        assert host.queue.qsize() == 1
        event = await host.queue.get()
        activity = c.store.activity(c.internal_id(event))
        assert activity is not None
        assert activity.scope == SCOPE
        assert event.unified_msg_origin == SCOPE
        await event.send(MessageChain([Plain("给你留句话")]))
        assert len(host.sent) == 1 and host.sent[0][0] == SCOPE
        assert event.get_extra("dswhale_transport_succeeded") is False
        c.delivered(event, NOW)
        assert c.store.activity(activity.id).status == "uncertain"
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_official_tick_waits_when_default_gateway_is_known_offline(tmp_path):
    host = Host()
    c = Companion(
        host,
        settings(
            proactive_enabled=True,
            quiet_start="00:00",
            quiet_end="00:00",
            daily_limit=3,
            min_interval_minutes=120,
            max_interval_minutes=120,
        ),
        Store(tmp_path / "state.db"),
    )
    try:
        scope = c.settings.owner_scope
        local_day = c.settings.local_time(NOW).date().isoformat()
        c.store.state(scope)
        c.store.db.execute(
            "UPDATE sessions SET next_due=?,unanswered=0 WHERE scope=?",
            (NOW.timestamp() - 1, scope),
        )
        host.client._active_websockets = []
        await c.tick(NOW)
        assert c.store.recent_activities(scope) == []
        assert c.store.count_local_day([scope], local_day) == 0
        assert c.store.state(scope)["unanswered"] == 0
        host.client._active_websockets = [
            SimpleNamespace(
                _conn=SimpleNamespace(closed=False),
                _session={"session_id": "SYNTHETIC-GATEWAY"},
            )
        ]
        await c.tick(NOW)
        assert len(c.store.recent_activities(scope)) == 1
        assert c.store.count_local_day([scope], local_day) == 1
    finally:
        await c.close()
