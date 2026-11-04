"""Pure, additive configuration planning for upgrades.

This module never reads or writes files, imports AstrBot, starts a platform or
contacts the network.  Callers load the current documents inside their existing
lock and transaction, ask for a plan, compare it with the on-disk values and
apply it atomically.  Planning is idempotent: running it again on the produced
document returns no changes.
"""

from __future__ import annotations

import copy

MIGRATION_VERSION = 1
VERSION_KEY = "config_migration_version"

# New settings are only added when the key is completely absent.  A stored
# false, 0, empty string, empty list/dict or explicit null is an existing value
# and must never be replaced by a default.
FISH_DEFAULTS = {
    "qq_default_delivery": "",
}


class MigrationError(ValueError):
    """Configuration cannot be planned safely; the original file is untouched."""


def _version(value):
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise MigrationError("配置迁移版本字段无效")
    return value


def plan_migration(documents, from_version=None, to_version=MIGRATION_VERSION):
    """Return ``(candidate_documents, redacted_changes)``.

    ``documents`` is a mapping with optional ``config`` and ``fish`` dictionaries.
    Unknown fields are copied verbatim.  The change list records file/key/action
    only; values are never included.
    """
    if not isinstance(documents, dict):
        raise MigrationError("配置文档无效")
    config = copy.deepcopy(documents.get("config", {}))
    fish = copy.deepcopy(documents.get("fish", {}))
    if not isinstance(config, dict) or not isinstance(fish, dict):
        raise MigrationError("配置文档必须是对象")
    current = _version(fish.get(VERSION_KEY) if from_version is None else from_version)
    target = _version(to_version)
    if target < current:
        raise MigrationError("配置迁移版本不能回退")
    changes = []
    for key, default in FISH_DEFAULTS.items():
        if key not in fish:
            fish[key] = copy.deepcopy(default)
            changes.append({"file": "fish", "field": key, "action": "add_default"})
    if current < target:
        fish[VERSION_KEY] = target
        changes.append(
            {
                "file": "fish",
                "field": VERSION_KEY,
                "action": "set_version",
                "from": current,
                "to": target,
            }
        )
    return {"config": config, "fish": fish}, changes


def detect_unexpected_changes(before, after, *, allowed_added=()):
    """List semantic paths that were removed or changed between two documents.

    Unknown-field trimming by a schema loader or a default overwrite is reported
    here.  Type changes (for example ``False`` becoming ``0``) and removal of
    empty dicts/lists are semantic changes too.  Additions are ignored by
    default; ``allowed_added`` exempts specific paths from reporting.
    Values are never returned.
    """
    allowed = set(allowed_added)
    problems: list[dict] = []

    def walk(before_value, after_value, path):
        if path in allowed:
            return
        if type(before_value) is not type(after_value):
            problems.append({"path": path, "kind": "changed"})
            return
        if isinstance(before_value, dict):
            for key in before_value:
                child = f"{path}.{key}" if path else str(key)
                if child in allowed:
                    continue
                if key not in after_value:
                    problems.append({"path": child, "kind": "removed"})
                else:
                    walk(before_value[key], after_value[key], child)
        elif isinstance(before_value, list):
            for index, item in enumerate(before_value):
                child = f"{path}[{index}]"
                if child in allowed:
                    continue
                if index >= len(after_value):
                    problems.append({"path": child, "kind": "removed"})
                else:
                    walk(item, after_value[index], child)
        elif before_value != after_value:
            problems.append({"path": path, "kind": "changed"})

    walk(before, after, "")
    return problems
