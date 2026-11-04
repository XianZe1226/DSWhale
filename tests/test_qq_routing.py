"""Channel bindings: passive authorization never follows the default delivery."""

import pytest

from dswhale.config import Settings
from dswhale.qq_routing import (
    OwnerBinding,
    build_bindings,
    match_binding,
    select_delivery,
)

NAP_SCOPE = "qq:FriendMessage:123456789"
OFF_SCOPE = "official-test:FriendMessage:Opaque_Case_001"


def dual(**extra):
    return Settings.from_mapping(
        {
            "owner_qq": "123456789",
            "owner_umo": NAP_SCOPE,
            "official_owner_umo": OFF_SCOPE,
            "qq_connection_mode": "napcat",
            **extra,
        }
    )


def test_both_bindings_exist_and_default_delivery_only_chooses_the_proactive_channel():
    settings = dual()
    assert {binding.channel for binding in settings.owner_bindings} == {"napcat", "official"}
    assert settings.delivery_binding.channel == "napcat"
    settings = dual(qq_default_delivery="official")
    assert settings.delivery_binding.channel == "official"
    for default in ("official", "napcat", ""):
        current = dual(qq_default_delivery=default)
        assert current.binding_for("123456789", NAP_SCOPE, private=True, platform_type="aiocqhttp")
        assert current.binding_for(
            "Opaque_Case_001", OFF_SCOPE, private=True, platform_type="qq_official"
        )


@pytest.mark.parametrize(
    ("sender", "scope", "private", "platform_type"),
    [
        ("123456789", NAP_SCOPE, False, "aiocqhttp"),
        ("123456789", NAP_SCOPE, True, "qq_official"),
        ("123456789", OFF_SCOPE, True, "qq_official"),
        ("Opaque_Case_001", OFF_SCOPE, True, "aiocqhttp"),
        ("opaque_case_001", OFF_SCOPE, True, "qq_official"),
        ("Opaque_Case_001", OFF_SCOPE.replace("official-test", "other"), True, "qq_official"),
        ("123456789", "qq:FriendMessage:987654321", True, "aiocqhttp"),
    ],
)
def test_binding_matrix_rejects_wrong_identity_scope_adapter_or_channel(
    sender, scope, private, platform_type
):
    assert dual().binding_for(sender, scope, private=private, platform_type=platform_type) is None


def test_incomplete_or_inconsistent_bindings_are_ignored_not_guessed():
    assert not Settings.from_mapping({"owner_qq": "123456789"}).owner_bindings
    assert not build_bindings(
        owner_qq="123456789", owner_umo="qq:FriendMessage:999999999", official_owner_umo=""
    )
    with pytest.raises(ValueError):
        Settings.from_mapping({"owner_qq": "123456789", "owner_umo": "qq:FriendMessage:999999999"})
    with pytest.raises(ValueError):
        dual(qq_default_delivery="maybe")
    assert select_delivery((), default="official") is None


def test_pure_helpers_do_not_depend_on_settings_order():
    bindings = build_bindings(
        owner_qq="123456789", owner_umo=NAP_SCOPE, official_owner_umo=OFF_SCOPE
    )
    assert [binding.channel for binding in bindings] == ["napcat", "official"]
    assert isinstance(bindings[0], OwnerBinding)
    assert match_binding(bindings, "123456789", NAP_SCOPE, private=True, platform_type="aiocqhttp")
    assert select_delivery(bindings, legacy_mode="official").channel == "official"


def test_legacy_install_without_new_field_keeps_working():
    settings = Settings.from_mapping({"owner_qq": "123456789", "owner_umo": NAP_SCOPE})
    assert settings.qq_default_delivery == ""
    assert settings.owner_scope == NAP_SCOPE
    assert settings.delivery_binding.channel == "napcat"


def _scheduler(tmp_path, **extra):
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from dswhale.scheduler import Scheduler
    from dswhale.store import Store

    settings = Settings.from_mapping(
        {
            "owner_qq": "123456789",
            "owner_umo": NAP_SCOPE,
            "official_owner_umo": OFF_SCOPE,
            "qq_connection_mode": "napcat",
            "qq_default_delivery": "",
            "proactive_enabled": True,
            "quiet_start": "00:00",
            "quiet_end": "00:00",
            "min_interval_minutes": 5,
            "max_interval_minutes": 5,
            "daily_limit": 3,
            "unanswered_limit": 2,
            **extra,
        }
    )
    store = Store(tmp_path / "state.db")
    return (
        Scheduler(settings, store),
        store,
        datetime(2026, 11, 3, 12, tzinfo=ZoneInfo("Asia/Shanghai")),
    )


def _finish_activity(activity, store, now):
    store.transition(activity.id, "queued", now.timestamp())
    store.transition(activity.id, "sent", now.timestamp())


def test_proactive_budget_is_shared_across_both_channels(tmp_path):
    scheduler, store, now = _scheduler(tmp_path)
    first = scheduler.reserve(now, external_kind="bili-note")
    assert first is not None and first.scope == NAP_SCOPE
    _finish_activity(first, store, now)
    second = scheduler.reserve(now, external_kind="bili-note")
    assert second is not None
    _finish_activity(second, store, now)
    assert scheduler.reserve(now, external_kind="bili-note") is None
    store.close()


def test_a_pending_activity_on_either_channel_blocks_new_autonomy(tmp_path):
    scheduler, store, now = _scheduler(tmp_path)
    activity = scheduler.reserve(now, external_kind="bili-watch", scopes=[OFF_SCOPE, NAP_SCOPE])
    assert activity is not None and activity.scope == OFF_SCOPE
    assert scheduler.reserve(now, external_kind="bili-note", scopes=[NAP_SCOPE, OFF_SCOPE]) is None
    store.close()


def test_any_channel_human_message_resets_the_shared_budget(tmp_path):
    scheduler, store, now = _scheduler(tmp_path)
    for _ in range(2):
        activity = scheduler.reserve(now, external_kind="bili-note")
        assert activity is not None
        _finish_activity(activity, store, now)
    assert scheduler.reserve(now, external_kind="bili-note") is None
    scheduler.human_received(now, scopes=[OFF_SCOPE, NAP_SCOPE])
    for scope in (OFF_SCOPE, NAP_SCOPE):
        assert store.state(scope)["unanswered"] == 0
        assert store.state(scope)["last_human"] == now.timestamp()
    activity = scheduler.reserve(now, external_kind="bili-note")
    assert activity is not None and activity.scope == NAP_SCOPE
    store.close()


def test_quiet_hours_and_pause_apply_to_the_shared_budget(tmp_path):
    scheduler, store, now = _scheduler(tmp_path, quiet_start="11:00", quiet_end="13:00")
    assert scheduler.reserve(now, external_kind="bili-note") is None
    store.set_paused(OFF_SCOPE, True)
    scheduler.settings = Settings.from_mapping(
        {**vars(scheduler.settings), "quiet_start": "00:00", "quiet_end": "00:00"}
    )
    assert scheduler.reserve(now, external_kind="bili-note") is None
    store.set_paused(OFF_SCOPE, False)
    assert scheduler.reserve(now, external_kind="bili-note") is not None
    store.close()
