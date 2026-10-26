from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from dswhale.config import Settings


def test_defaults_do_not_enable_unsolicited_messages():
    settings = Settings.from_mapping({})
    assert not settings.proactive_enabled
    assert not settings.matches("123", "qq:FriendMessage:123", private=True)


def test_owner_requires_both_private_scope_and_sender():
    settings = Settings.from_mapping({"owner_qq": "123", "owner_umo": "qq:FriendMessage:123"})
    assert settings.matches("123", "qq:FriendMessage:123", private=True)
    assert not settings.matches("456", "qq:FriendMessage:123", private=True)
    assert not settings.matches("123", "other:FriendMessage:123", private=True)
    assert not settings.matches("123", "qq:FriendMessage:123", private=False)


@pytest.mark.parametrize(
    "hour,minute,want", [(22, 59, False), (23, 0, True), (0, 1, True), (7, 59, True), (8, 0, False)]
)
def test_quiet_hours_cross_midnight(hour, minute, want):
    now = datetime(2026, 10, 25, hour, minute, tzinfo=ZoneInfo("Asia/Shanghai"))
    assert Settings.from_mapping({}).is_quiet(now) is want


@pytest.mark.parametrize(
    "config",
    [
        {"proactive_enabled": "false"},
        {"daily_limit": -1},
        {"quiet_start": "24:30"},
        {"timezone": "Moon/Sea"},
        {"min_interval_minutes": 200, "max_interval_minutes": 100},
        {"owner_qq": "123", "owner_umo": "qq:GroupMessage:123"},
        {"owner_qq": "123", "owner_umo": "qq:FriendMessage:456"},
        {"max_video_seconds": 100000},
        {"frame_count": 100},
    ],
)
def test_invalid_configuration_is_rejected(config):
    with pytest.raises(ValueError):
        Settings.from_mapping(config)


def test_naive_clock_rejected_and_same_quiet_endpoints_disable_quiet():
    settings = Settings.from_mapping({"quiet_start": "00:00", "quiet_end": "00:00"})
    assert not settings.is_quiet(datetime(2026, 1, 1, tzinfo=ZoneInfo("UTC")))
    with pytest.raises(ValueError):
        settings.is_quiet(datetime(2026, 1, 1))
