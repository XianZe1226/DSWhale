"""Display-only normalization for AstrBot persona timestamps.

AstrBot stores ``DateTime(timezone=False)`` columns as naive UTC and serializes
them with ``datetime.isoformat()``. The dashboard then parses that string with
``new Date(...)``, which treats a naive value as local time, so a persona looks
eight hours older in UTC+8.

This module wraps ``PersonaService.serialize_persona`` so naive timestamps are
serialized as UTC with an explicit ``+00:00`` offset. It is display-only: the
database, historical persona rows and the upstream AstrBot package are never
modified. The wrapper is installed when the DSWhale plugin loads and is
idempotent, so calling ``install()`` more than once is harmless.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

_MARKER = "__dswhale_time_normalized__"
_TIMESTAMP_KEYS = ("created_at", "updated_at")


def normalize_persona_timestamp(value: Any) -> Any:
    """Return an ISO-8601 string with an explicit offset for persona timestamps.

    Naive datetimes are treated as UTC. Strings are parsed only when they look
    like ISO-8601; values that cannot be parsed are returned unchanged so the
    wrapper never breaks an unexpected upstream payload shape.
    """

    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.isoformat()
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.isoformat()
    return value


def _serialize(original, persona, empty_lists_for_tools: bool = False) -> Any:
    data = original(persona, empty_lists_for_tools)
    if isinstance(data, dict):
        for key in _TIMESTAMP_KEYS:
            if key in data:
                data[key] = normalize_persona_timestamp(data[key])
    return data


def install(service_class: type | None = None) -> bool:
    """Install the display shim on ``PersonaService`` (or a compatible class).

    Returns ``True`` when the shim is installed or was already installed, and
    ``False`` when AstrBot or the expected serializer is unavailable. Missing
    upstream modules are not an error for tests or non-desktop deployments.
    """

    if service_class is None:
        try:
            from astrbot.dashboard.services.persona_service import PersonaService
        except Exception:
            return False
        service_class = PersonaService

    descriptor = service_class.__dict__.get("serialize_persona")
    if descriptor is None:
        return False
    original = descriptor.__func__ if isinstance(descriptor, staticmethod) else descriptor
    if getattr(original, _MARKER, False):
        return True

    def serialize_persona(persona, empty_lists_for_tools: bool = False):
        return _serialize(original, persona, empty_lists_for_tools)

    setattr(serialize_persona, _MARKER, True)
    service_class.serialize_persona = staticmethod(serialize_persona)
    return True
