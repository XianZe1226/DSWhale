import asyncio
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
    with pytest.raises(ValueError):
        settings(qq_signature_enabled=True)
    with pytest.raises(ValueError):
        settings(qzone_enabled=True)


class Host:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.sent = []
        self.client = SimpleNamespace(_active_websockets=[])
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
    assert report["qqConnected"] is True
    assert "OPAQUE" not in file.read_text() and "GATEWAY" not in file.read_text()
    host.client._active_websockets[0]._session = {}
    c.write_health()
    assert json.loads(file.read_text())["qqConnected"] is False
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
