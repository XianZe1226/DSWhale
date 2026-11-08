"""Validated settings shared by the installer and AstrBot plugin."""

import re
from dataclasses import dataclass, fields
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import qq_routing
from .reply_style import MODES as REPLY_STYLE_MODES
from .reply_style import PUNCTUATION as REPLY_STYLE_PUNCTUATION
from .reply_style import parse_interval, validate_custom
from .reply_style_isolate import validate_sync


@dataclass(frozen=True)
class Settings:
    owner_qq: str = ""
    owner_umo: str = ""
    qq_connection_mode: str = "napcat"
    official_owner_umo: str = ""
    qq_default_delivery: str = ""
    config_migration_version: int = 0
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
    reply_style_mode: str = "inherit"
    reply_style_max_bubbles: int = 3
    reply_style_interval: str = "0.8,1.5"
    reply_style_punctuation: str = "keep"
    reply_style_prompt: bool = True
    reply_style_custom_regex: str = ""
    reply_style_custom_cleanup: str = ""
    bili_enabled: bool = False
    bili_node_path: str = ""
    bili_allow_dm: bool = False
    bili_allow_public: bool = False
    bili_qq_recommendations: bool = True
    qq_signature_enabled: bool = False
    qzone_enabled: bool = False

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
        if self.qq_connection_mode not in {"napcat", "official"}:
            raise ValueError("QQ 接入方式无效")
        if self.official_owner_umo:
            parts = self.official_owner_umo.split(":")
            if (
                len(parts) != 3
                or not re.fullmatch(r"[^\s:\x00-\x1f\x7f]{1,128}", parts[0])
                or parts[1] != "FriendMessage"
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", parts[2])
            ):
                raise ValueError("官方机器人绑定必须是 /fish whoami 返回的完整私聊会话 ID")
        if self.qq_default_delivery not in {"", *qq_routing.CHANNELS}:
            raise ValueError("主动消息默认渠道无效")
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
        if self.proactive_enabled and not self.owner_scope:
            raise ValueError("开启主动聊天前请先配置主人 QQ 和私聊 /sid")
        if self.bili_enabled and not self.owner_scope:
            raise ValueError("开启 B站整合前请先配置主人 QQ 和私聊 /sid")
        if self.reply_style_mode not in REPLY_STYLE_MODES:
            raise ValueError("回复方式无效")
        if isinstance(self.reply_style_max_bubbles, bool) or not (
            0 <= self.reply_style_max_bubbles
        ):
            raise ValueError("目标条数必须是 1–3 的整数")
        if not 1 <= self.reply_style_max_bubbles <= 3:
            raise ValueError("目标条数应在 1–3 之间")
        parse_interval(self.reply_style_interval)
        if self.reply_style_punctuation not in REPLY_STYLE_PUNCTUATION:
            raise ValueError("标点处理方式无效")
        if not isinstance(self.reply_style_prompt, bool):
            raise ValueError("排版提示开关无效")
        regex = validate_custom(self.reply_style_custom_regex, "自定义拆分规则") or ""
        cleanup = validate_custom(self.reply_style_custom_cleanup, "自定义清理规则") or ""
        if regex or cleanup:
            validate_sync(regex, cleanup)

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

    @property
    def owner_bindings(self):
        """All valid bindings, independent of which channel is the default."""
        return qq_routing.build_bindings(
            owner_qq=self.owner_qq,
            owner_umo=self.owner_umo,
            official_owner_umo=self.official_owner_umo,
        )

    @property
    def delivery_binding(self):
        """The binding used for proactive activity, or None when unavailable."""
        return qq_routing.select_delivery(
            self.owner_bindings,
            default=self.qq_default_delivery,
            legacy_mode=self.qq_connection_mode,
        )

    @property
    def owner_scope(self):
        binding = self.delivery_binding
        return binding.umo if binding else ""

    @property
    def owner_id(self):
        binding = self.delivery_binding
        return binding.user_id if binding else ""

    @property
    def adapter_name(self):
        binding = self.delivery_binding
        return binding.adapter_name if binding else "aiocqhttp"

    def binding_for(self, sender, scope, *, private, platform_type):
        """Resolve a passive event's binding; default delivery is irrelevant here."""
        return qq_routing.match_binding(
            self.owner_bindings,
            sender,
            scope,
            private=private,
            platform_type=platform_type,
        )

    def matches(
        self, sender: str, scope: str, *, private: bool, platform_type: str = "aiocqhttp"
    ) -> bool:
        return (
            self.binding_for(sender, scope, private=private, platform_type=platform_type)
            is not None
        )
