"""Durable activity ledger. User memories remain owned by LivingMemory."""

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Activity:
    id: str
    scope: str
    kind: str
    status: str
    created: float


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                scope TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0,
                next_due REAL, last_human REAL NOT NULL DEFAULT 0,
                unanswered INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS activities (
                id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL,
                local_day TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL,
                updated REAL NOT NULL, error TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS activities_scope_day ON activities(scope, local_day);
            CREATE TABLE IF NOT EXISTS journals (
                id INTEGER PRIMARY KEY, scope TEXT NOT NULL, url TEXT NOT NULL,
                title TEXT NOT NULL, summary TEXT NOT NULL, evidence TEXT NOT NULL,
                created REAL NOT NULL, UNIQUE(scope, url)
            );
            CREATE TABLE IF NOT EXISTS attempts (
                scope TEXT NOT NULL, url TEXT NOT NULL, created REAL NOT NULL,
                PRIMARY KEY(scope, url)
            );
        """)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        self.db.close()

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield self.db
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def state(self, scope: str) -> dict:
        self.db.execute("INSERT OR IGNORE INTO sessions(scope) VALUES (?)", (scope,))
        return dict(self.db.execute("SELECT * FROM sessions WHERE scope=?", (scope,)).fetchone())

    def set_paused(self, scope: str, paused: bool):
        self.state(scope)
        self.db.execute("UPDATE sessions SET paused=? WHERE scope=?", (paused, scope))

    def activity(self, activity_id: str) -> Activity | None:
        row = self.db.execute("SELECT * FROM activities WHERE id=?", (activity_id,)).fetchone()
        return Activity(**{key: row[key] for key in Activity.__dataclass_fields__}) if row else None

    def transition(self, activity_id: str, status: str, now: float, error: str = "") -> bool:
        permitted = {
            "queued": ("reserved",),
            "sent": ("queued",),
            "failed": ("reserved", "queued"),
            "uncertain": ("reserved", "queued"),
        }
        if status not in permitted:
            raise ValueError("Invalid activity state")
        placeholders = ",".join("?" for _ in permitted[status])
        cursor = self.db.execute(
            f"UPDATE activities SET status=?,updated=?,error=? WHERE id=? "
            f"AND status IN ({placeholders})",
            (status, now, error[:200], activity_id, *permitted[status]),
        )
        return cursor.rowcount == 1

    def recover_pending(self, now: float):
        self.db.execute(
            "UPDATE activities SET status='uncertain', updated=?, error='运行中断，投递未确认' "
            "WHERE status IN ('reserved','queued')",
            (now,),
        )

    def expire_pending(self, before: float, now: float):
        self.db.execute(
            "UPDATE activities SET status='uncertain',updated=?,error='投递等待超时' "
            "WHERE status IN ('reserved','queued') AND created<?",
            (now, before),
        )

    def recent_activities(self, scope: str, limit: int = 5) -> list[dict]:
        return [
            dict(r)
            for r in self.db.execute(
                "SELECT * FROM activities WHERE scope=? ORDER BY created DESC LIMIT ?",
                (scope, max(1, min(limit, 50))),
            )
        ]

    def record_video(self, scope, url, title, summary, evidence, now):
        self.db.execute(
            "INSERT INTO journals(scope,url,title,summary,evidence,created) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(scope,url) DO UPDATE SET title=excluded.title,summary=excluded.summary,"
            "evidence=excluded.evidence,created=excluded.created",
            (
                scope,
                url,
                title[:300],
                summary[:8000],
                json.dumps(evidence, ensure_ascii=False),
                now,
            ),
        )

    def journal(self, scope: str, limit: int = 5) -> list[dict]:
        return [
            dict(r)
            for r in self.db.execute(
                "SELECT * FROM journals WHERE scope=? ORDER BY created DESC,id DESC LIMIT ?",
                (scope, max(1, min(limit, 50))),
            )
        ]

    def claim_video(self, scope: str, url: str, now: float) -> bool:
        with self.transaction() as db:
            db.execute("DELETE FROM attempts WHERE created<?", (now - 7 * 86400,))
            result = db.execute("INSERT OR IGNORE INTO attempts VALUES(?,?,?)", (scope, url, now))
            return result.rowcount == 1

    def backup(self, destination: Path):
        destination = Path(destination)
        if destination.resolve() == self.path.resolve():
            raise ValueError("备份不能覆盖运行中的数据库")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(destination) as target:
            self.db.backup(target)
