"""Validated settings shared by the installer and AstrBot plugin."""

from dataclasses import dataclass, fields
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


@dataclass(frozen=True)
class Settings:
    owner_qq: str = ""
    owner_umo: str = ""
    proactive_enabled: bool = False
    timezone: str = "Asia/Shanghai"
    quiet_start: str = "23:00"
    quiet_end: str = "08:00"
    min_interval_minutes: int = 120
    max_interval_minutes: int = 240
    daily_limit: int = 3
    unanswered_limit: int = 2
    content_url: str = "http://127.0.0.1:8420"
    content_token_env: str = "DSWHALE_OBC_TOKEN"
    discover_enabled: bool = False
    video_enabled: bool = True
    vision_provider_id: str = ""
    max_video_seconds: int = 300
    max_media_mb: int = 80
    frame_count: int = 6
    media_timeout_seconds: int = 180
    cookies_path: str = ""
    persona: str = ""

    @classmethod
    def from_mapping(cls, mapping):
        known = {field.name: field for field in fields(cls)}
        values = {}
        defaults = cls()
        for key, value in mapping.items():
            if key not in known:
                continue
            expected = type(getattr(defaults, key))
            if type(value) is not expected:
                raise ValueError(f"{key} 必须是 {expected.__name__}")
            values[key] = value.strip() if expected is str else value
        result = cls(**values)
        result.validate()
        return result

    def validate(self):
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("无效的时区") from exc
        self._minutes(self.quiet_start)
        self._minutes(self.quiet_end)
        bounds = {
            "min_interval_minutes": (5, 1440),
            "max_interval_minutes": (5, 1440),
            "daily_limit": (0, 10),
            "unanswered_limit": (1, 5),
            "max_video_seconds": (5, 600),
            "max_media_mb": (5, 200),
            "frame_count": (1, 12),
            "media_timeout_seconds": (15, 600),
        }
        for key, (low, high) in bounds.items():
            if not low <= getattr(self, key) <= high:
                raise ValueError(f"{key} 应在 {low}–{high} 之间")
        if self.min_interval_minutes > self.max_interval_minutes:
            raise ValueError("最短间隔不能超过最长间隔")
        if self.owner_qq and not self.owner_qq.isascii():
            raise ValueError("主人 QQ 必须为数字")
        if self.owner_qq and not self.owner_qq.isdigit():
            raise ValueError("主人 QQ 必须为数字")
        if self.owner_umo:
            parts = self.owner_umo.split(":")
            if (
                len(parts) != 3
                or not parts[0]
                or parts[1] != "FriendMessage"
                or not self.owner_qq
                or parts[2] != self.owner_qq
            ):
                raise ValueError("owner_umo 必须是主人 QQ 的完整私聊 /sid")
        if self.proactive_enabled and not self.owner_umo:
            raise ValueError("开启主动聊天前请先配置主人 QQ 和私聊 /sid")

    @staticmethod
    def _minutes(value: str) -> int:
        try:
            hour, minute = value.split(":")
            if len(hour) != 2 or len(minute) != 2:
                raise ValueError
            h, m = int(hour), int(minute)
            if not 0 <= h < 24 or not 0 <= m < 60:
                raise ValueError
            return h * 60 + m
        except (ValueError, AttributeError) as exc:
            raise ValueError("安静时段应为 HH:MM，例如 23:00") from exc

    def local_time(self, now: datetime) -> datetime:
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("时间必须包含时区")
        return now.astimezone(ZoneInfo(self.timezone))

    def is_quiet(self, now: datetime) -> bool:
        local = self.local_time(now)
        minute = local.hour * 60 + local.minute
        start, end = self._minutes(self.quiet_start), self._minutes(self.quiet_end)
        if start == end:
            return False
        return start <= minute < end if start < end else minute >= start or minute < end

    def matches(self, sender: str, scope: str, *, private: bool) -> bool:
        return bool(
            self.owner_umo and private and str(sender) == self.owner_qq and scope == self.owner_umo
        )
