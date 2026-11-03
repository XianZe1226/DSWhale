"""C2C provenance and local evidence for explicit official-owner binding."""

import hashlib
import json
import os
import tempfile
from pathlib import Path


def is_official_c2c(event):
    from botpy.message import C2CMessage

    raw = event.message_obj.raw_message
    return (
        event.get_platform_name() == "qq_official"
        and event.is_private_chat()
        and isinstance(raw, C2CMessage)
        and getattr(raw.author, "user_openid", None) == event.get_sender_id()
    )


def _scope_hash(scope):
    return hashlib.sha256(scope.encode("utf-8")).hexdigest()


def _observed(directory):
    try:
        value = json.loads((Path(directory) / "official-c2c.json").read_text(encoding="utf-8"))
        if isinstance(value, list) and len(value) <= 32:
            return [v for v in value if isinstance(v, str) and len(v) == 64]
    except (OSError, ValueError):
        pass
    return []


def confirmed_c2c_scope(directory, scope):
    return _scope_hash(scope) in _observed(directory)


def remember_c2c_scope(directory, event):
    if not is_official_c2c(event):
        return False
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    digest = _scope_hash(event.unified_msg_origin)
    values = [v for v in _observed(directory) if v != digest][-31:] + [digest]
    fd, name = tempfile.mkstemp(prefix=".official-c2c-", dir=directory)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(values, stream)
        temporary.replace(directory / "official-c2c.json")
    finally:
        temporary.unlink(missing_ok=True)
    return True
