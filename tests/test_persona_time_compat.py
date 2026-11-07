from datetime import datetime, timedelta, timezone

import pytest

from dswhale.persona_time_compat import install, normalize_persona_timestamp

NAIVE_UTC = datetime(2026, 11, 7, 9, 30)


class FakePersona:
    def __init__(self, created_at=NAIVE_UTC, updated_at=None):
        self.created_at = created_at
        self.updated_at = updated_at


class FakePersonaService:
    @staticmethod
    def serialize_persona(persona, empty_lists_for_tools: bool = False) -> dict:
        return {
            "persona_id": "persona-a",
            "created_at": persona.created_at.isoformat() if persona.created_at else None,
            "updated_at": persona.updated_at.isoformat() if persona.updated_at else None,
        }


def test_install_normalizes_naive_persona_timestamps_as_utc():
    assert install(FakePersonaService) is True
    data = FakePersonaService.serialize_persona(FakePersona())
    assert data["created_at"] == "2026-11-07T09:30:00+00:00"
    assert data["updated_at"] is None


def test_install_is_idempotent_and_preserves_the_rest_of_the_payload():
    assert install(FakePersonaService) is True
    first = FakePersonaService.serialize_persona(FakePersona(), True)
    assert install(FakePersonaService) is True
    second = FakePersonaService.serialize_persona(FakePersona(), True)
    assert second == first
    assert second["persona_id"] == "persona-a"


def test_install_refuses_a_class_without_the_upstream_serializer():
    class Empty:
        pass

    assert install(Empty) is False


def test_aware_datetimes_keep_their_own_offset():
    value = datetime(2026, 11, 7, 17, 30, tzinfo=timezone(timedelta(hours=8)))
    assert normalize_persona_timestamp(value) == "2026-11-07T17:30:00+08:00"


@pytest.mark.parametrize("value", [None, "", "not-a-timestamp", 42])
def test_unparseable_values_are_returned_unchanged(value):
    assert normalize_persona_timestamp(value) == value


def test_naive_iso_strings_are_marked_as_utc_and_z_is_normalized():
    assert normalize_persona_timestamp("2026-11-07T09:30:00") == "2026-11-07T09:30:00+00:00"
    assert normalize_persona_timestamp("2026-11-07T09:30:00Z") == "2026-11-07T09:30:00+00:00"
    assert normalize_persona_timestamp("2026-11-07T09:30:00+00:00") == "2026-11-07T09:30:00+00:00"


def test_normalization_does_not_depend_on_the_process_time_zone(monkeypatch):
    import os
    import time

    if not hasattr(time, "tzset"):
        pytest.skip("time.tzset is unavailable on this platform")

    class TimeZoneIndependentPersonaService:
        @staticmethod
        def serialize_persona(persona, empty_lists_for_tools: bool = False) -> dict:
            return {
                "persona_id": "persona-tz",
                "created_at": persona.created_at.isoformat() if persona.created_at else None,
                "updated_at": persona.updated_at.isoformat() if persona.updated_at else None,
            }

    # Do not rely on another test having installed the shim: this test must pass
    # on its own as well as in the full file.
    assert install(TimeZoneIndependentPersonaService) is True
    original = os.environ.get("TZ")
    results = []
    try:
        for name in ("UTC", "Asia/Shanghai"):
            monkeypatch.setenv("TZ", name)
            time.tzset()
            results.append(
                TimeZoneIndependentPersonaService.serialize_persona(FakePersona())["created_at"]
            )
    finally:
        if original is None:
            monkeypatch.delenv("TZ", raising=False)
        else:
            monkeypatch.setenv("TZ", original)
        time.tzset()
    assert results == ["2026-11-07T09:30:00+00:00", "2026-11-07T09:30:00+00:00"]
