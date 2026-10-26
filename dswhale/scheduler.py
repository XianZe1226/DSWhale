"""Scheduling decisions are pure local policy, without model or network calls."""

import random
import uuid
from datetime import datetime

from .config import Settings
from .store import Activity, Store


class Scheduler:
    def __init__(self, settings: Settings, store: Store):
        self.settings, self.store = settings, store

    def _next_due(self, now: datetime) -> float:
        return now.timestamp() + 60 * random.randint(
            self.settings.min_interval_minutes,
            self.settings.max_interval_minutes,
        )

    def human_received(self, now: datetime):
        self.settings.local_time(now)
        scope = self.settings.owner_umo
        self.store.state(scope)
        self.store.db.execute(
            "UPDATE sessions SET last_human=?,unanswered=0,next_due=? WHERE scope=?",
            (now.timestamp(), self._next_due(now), scope),
        )

    def reserve(self, now: datetime) -> Activity | None:
        cfg = self.settings
        local = cfg.local_time(now)
        if not cfg.proactive_enabled or not cfg.owner_umo or cfg.is_quiet(now):
            return None
        ts, scope = now.timestamp(), cfg.owner_umo
        with self.store.transaction() as db:
            state = self.store.state(scope)
            if state["paused"] or state["unanswered"] >= cfg.unanswered_limit:
                return None
            if state["next_due"] is None:
                db.execute(
                    "UPDATE sessions SET next_due=? WHERE scope=?", (self._next_due(now), scope)
                )
                return None
            if ts < state["next_due"]:
                return None
            count = db.execute(
                "SELECT COUNT(*) FROM activities WHERE scope=? AND local_day=?",
                (scope, local.date().isoformat()),
            ).fetchone()[0]
            pending = db.execute(
                "SELECT 1 FROM activities WHERE scope=? AND status IN ('reserved','queued')",
                (scope,),
            ).fetchone()
            if count >= cfg.daily_limit or pending:
                return None
            item = Activity(
                uuid.uuid4().hex, scope, "video" if cfg.discover_enabled else "chat", "reserved", ts
            )
            db.execute(
                "INSERT INTO activities VALUES(?,?,?,?,?,?,?,?)",
                (item.id, scope, item.kind, local.date().isoformat(), item.status, ts, ts, ""),
            )
            db.execute(
                "UPDATE sessions SET next_due=?,unanswered=unanswered+1 WHERE scope=?",
                (self._next_due(now), scope),
            )
            return item
