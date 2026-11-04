"""Immutable owner bindings for the two QQ channels.

The two channels are independent identities: OneBot (NapCat, ``aiocqhttp``) and
QQ official C2C (``qq_official``).  Passive authorization always resolves the
binding for the incoming event; the default delivery binding only chooses which
bound identity receives proactive messages.
"""

from __future__ import annotations

from dataclasses import dataclass

CHANNELS = ("napcat", "official")
ADAPTERS = {"napcat": "aiocqhttp", "official": "qq_official"}


@dataclass(frozen=True)
class OwnerBinding:
    channel: str
    adapter_name: str
    platform_id: str
    user_id: str
    umo: str


def parse_umo(value):
    """Return ``(platform_id, user_id)`` for a bound private FriendMessage UMO."""
    parts = str(value or "").split(":")
    if len(parts) != 3 or not parts[0] or parts[1] != "FriendMessage" or not parts[2]:
        return None
    return parts[0], parts[2]


def build_bindings(*, owner_qq, owner_umo, official_owner_umo):
    """Collect the bindings that are actually present and internally consistent."""
    bindings = []
    parsed = parse_umo(owner_umo)
    if owner_qq and parsed and parsed[1] == str(owner_qq):
        bindings.append(
            OwnerBinding(
                channel="napcat",
                adapter_name=ADAPTERS["napcat"],
                platform_id=parsed[0],
                user_id=str(owner_qq),
                umo=str(owner_umo),
            )
        )
    parsed = parse_umo(official_owner_umo)
    if parsed:
        bindings.append(
            OwnerBinding(
                channel="official",
                adapter_name=ADAPTERS["official"],
                platform_id=parsed[0],
                user_id=parsed[1],
                umo=str(official_owner_umo),
            )
        )
    return tuple(bindings)


def select_delivery(bindings, *, default="", legacy_mode="napcat"):
    """Resolve the explicit default channel, falling back to the legacy mode."""
    channel = default if default in CHANNELS else legacy_mode
    for binding in bindings:
        if binding.channel == channel:
            return binding
    return None


def match_binding(bindings, sender, scope, *, private, platform_type):
    """Return the binding for a passive event, or ``None``.

    Adapter name, platform instance, full private UMO and sender identity must all
    match exactly; official user IDs are opaque and compared case-sensitively.
    """
    if not private:
        return None
    for binding in bindings:
        if (
            binding.adapter_name == platform_type
            and binding.umo == scope
            and binding.user_id == str(sender)
        ):
            return binding
    return None


def resolve_binding(bindings, umo):
    """Find the binding captured by a durable task; never guess another channel."""
    for binding in bindings:
        if binding.umo == str(umo or ""):
            return binding
    return None
