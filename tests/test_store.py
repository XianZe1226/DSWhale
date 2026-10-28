from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from dswhale.config import Settings
from dswhale.scheduler import Scheduler
from dswhale.store import Store

SCOPE = "qq:FriendMessage:123"
NOW = datetime(2026, 10, 25, 10, tzinfo=ZoneInfo("Asia/Shanghai"))


def settings(**changes):
    return Settings.from_mapping(
        {
            "owner_qq": "123",
            "owner_umo": SCOPE,
            "proactive_enabled": True,
            "min_interval_minutes": 120,
            "max_interval_minutes": 120,
            **changes,
        }
    )


def test_restart_preserves_unanswered_budget_and_human_resets_it(tmp_path):
    path = tmp_path / "state.db"
    with Store(path) as store:
        scheduler = Scheduler(settings(), store)
        assert scheduler.reserve(NOW) is None
        first = scheduler.reserve(NOW + timedelta(hours=2))
        assert first is not None
        store.transition(first.id, "queued", NOW.timestamp())
        store.transition(first.id, "sent", NOW.timestamp())
    with Store(path) as store:
        scheduler = Scheduler(settings(), store)
        second = scheduler.reserve(NOW + timedelta(hours=4))
        assert second is not None
        store.transition(second.id, "queued", (NOW + timedelta(hours=4)).timestamp())
        store.transition(second.id, "sent", (NOW + timedelta(hours=4)).timestamp())
        assert scheduler.reserve(NOW + timedelta(hours=6)) is None
        scheduler.human_received(NOW + timedelta(hours=6))
        assert scheduler.reserve(NOW + timedelta(hours=8)) is not None
        scheduler.human_received(NOW + timedelta(hours=8))
        assert scheduler.reserve(NOW + timedelta(hours=10)) is None  # daily budget survives


def test_atomic_reservation_across_independent_connections(tmp_path):
    path = tmp_path / "state.db"
    with Store(path) as store:
        Scheduler(settings(), store).reserve(NOW)

    def run():
        with Store(path) as store:
            return Scheduler(settings(), store).reserve(NOW + timedelta(hours=2))

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: run(), range(4)))
    assert sum(item is not None for item in results) == 1


def test_pause_and_unknown_delivery_survive_restart(tmp_path):
    path = tmp_path / "state.db"
    with Store(path) as store:
        scheduler = Scheduler(settings(), store)
        scheduler.reserve(NOW)
        item = scheduler.reserve(NOW + timedelta(hours=2))
        store.transition(item.id, "queued", (NOW + timedelta(hours=2)).timestamp())
    with Store(path) as store:
        store.recover_pending((NOW + timedelta(hours=3)).timestamp())
        assert store.activity(item.id).status == "uncertain"
        assert not store.transition(item.id, "queued", NOW.timestamp())
        store.set_paused(SCOPE, True)
    with Store(path) as store:
        assert Scheduler(settings(), store).reserve(NOW + timedelta(hours=4)) is None


def test_quiet_period_never_catches_up_with_burst(tmp_path):
    with Store(tmp_path / "s.db") as store:
        scheduler = Scheduler(settings(), store)
        scheduler.reserve(NOW.replace(hour=22))
        assert scheduler.reserve(NOW.replace(hour=23)) is None
        morning = (NOW + timedelta(days=1)).replace(hour=8)
        assert scheduler.reserve(morning) is not None
        assert scheduler.reserve(morning) is None


def test_journals_are_scoped_deduplicated_and_survive_backup(tmp_path):
    with Store(tmp_path / "s.db") as store:
        store.record_video(
            SCOPE,
            "https://www.bilibili.com/video/BV1234567890",
            "海獭",
            "观察到海獭",
            {"frames": 2},
            NOW.timestamp(),
        )
        store.record_video(
            SCOPE,
            "https://www.bilibili.com/video/BV1234567890",
            "海獭",
            "更新观察",
            {"frames": 3},
            NOW.timestamp(),
        )
        assert len(store.journal(SCOPE)) == 1
        assert store.journal("other") == []
        store.backup(tmp_path / "copy.db")
    with Store(tmp_path / "copy.db") as store:
        assert store.journal(SCOPE)[0]["summary"] == "更新观察"


def test_activity_does_not_count_as_human_and_failure_is_not_sent(tmp_path):
    with Store(tmp_path / "s.db") as store:
        scheduler = Scheduler(settings(), store)
        scheduler.reserve(NOW)
        item = scheduler.reserve(NOW + timedelta(hours=2))
        store.transition(item.id, "failed", NOW.timestamp(), "provider unavailable")
        assert store.activity(item.id).status == "failed"
        assert not store.transition(item.id, "sent", NOW.timestamp())
        assert store.state(SCOPE)["unanswered"] == 1


def test_bili_share_uses_same_quiet_daily_and_unanswered_budget(tmp_path):
    from dataclasses import replace
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from dswhale.config import Settings
    from dswhale.scheduler import Scheduler
    from dswhale.store import Store

    cfg = replace(
        Settings(),
        owner_qq="123",
        owner_umo="qq:FriendMessage:123",
        proactive_enabled=True,
        daily_limit=1,
    )
    store = Store(tmp_path / "state.db")
    scheduler = Scheduler(cfg, store)
    noon = datetime(2026, 10, 26, 12, tzinfo=ZoneInfo("Asia/Shanghai"))
    quiet = noon.replace(hour=23)
    assert scheduler.reserve(quiet, external_kind="bili-share") is None
    activity = scheduler.reserve(noon, external_kind="bili-share")
    assert activity and activity.kind == "bili-share"
    store.transition(activity.id, "failed", noon.timestamp())
    assert scheduler.reserve(noon, external_kind="bili-share") is None
    store.close()
