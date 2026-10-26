"""AstrBot plugin entry point; install this repository as astrbot_plugin_dswhale."""

from astrbot.api import AstrBotConfig
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import Record
from astrbot.api.star import Context, Star, StarTools
from astrbot.core.provider.entities import ProviderRequest

if __package__:
    from .dswhale.adapter import Companion
    from .dswhale.config import Settings
    from .dswhale.store import Store
else:  # local SDK smoke tests
    from dswhale.adapter import Companion
    from dswhale.config import Settings
    from dswhale.store import Store


class OwnerOnly(filter.CustomFilter):
    settings = Settings()

    def filter(self, event: AstrMessageEvent, cfg: AstrBotConfig) -> bool:
        return self.settings.matches(
            event.get_sender_id(), event.unified_msg_origin, private=event.is_private_chat()
        )


class DSWhale(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context, config)
        settings = Settings.from_mapping(dict(config))
        OwnerOnly.settings = settings
        self.companion = Companion(
            context, settings, Store(StarTools.get_data_dir("astrbot_plugin_dswhale") / "state.db")
        )

    async def initialize(self):
        self.companion.start()

    async def terminate(self):
        await self.companion.close()

    @filter.custom_filter(OwnerOnly, False, priority=100)
    async def observe(self, event: AstrMessageEvent):
        self.companion.observe(event)
        self.companion.allow_delivery(event)

    @filter.on_llm_request()
    async def enrich(self, event: AstrMessageEvent, req: ProviderRequest):
        await self.companion.prepare_memory(event)
        self.companion.enrich(event, req)

    @filter.on_decorating_result()
    async def before_send(self, event: AstrMessageEvent):
        self.companion.allow_delivery(event)

    @filter.after_message_sent()
    async def delivered(self, event: AstrMessageEvent):
        self.companion.delivered(event)

    @filter.command_group("fish")
    def fish(self):
        """DSWhale 管理。子命令：whoami/status/start/pause/watch/journal/voice。"""
        pass

    @fish.command("whoami")
    async def whoami(self, event: AstrMessageEvent):
        settings = self.companion.settings
        if event.is_private_chat() and (
            not settings.owner_qq or event.get_sender_id() == settings.owner_qq
        ):
            yield event.plain_result(
                f"你的 QQ：{event.get_sender_id()}\n本会话：{event.unified_msg_origin}\n请在插件配置填写 owner_qq 和 owner_umo，再重载插件。"
            )
        event.stop_event()

    @fish.command("status")
    async def status(self, event: AstrMessageEvent):
        try:
            text = self.companion.status(event)
        except PermissionError as error:
            text = str(error)
        yield event.plain_result(text)
        event.stop_event()

    @fish.command("start")
    async def start(self, event: AstrMessageEvent):
        if self.companion.authorized(event):
            self.companion.store.set_paused(event.unified_msg_origin, False)
            yield event.plain_result(
                "已解除暂停。"
                + (
                    "到达设定时间后会主动聊天。"
                    if self.companion.settings.proactive_enabled
                    else "请先在插件配置开启 proactive_enabled。"
                )
            )
        event.stop_event()

    @fish.command("pause")
    async def pause(self, event: AstrMessageEvent):
        if self.companion.authorized(event):
            self.companion.store.set_paused(event.unified_msg_origin, True)
            yield event.plain_result("主动聊天与自动看视频已暂停；普通聊天仍可使用。")
        event.stop_event()

    @fish.command("watch")
    async def watch(self, event: AstrMessageEvent, url: str):
        if self.companion.authorized(event):
            try:
                text = await self.companion.watch(url)
            except Exception as error:
                text = f"这次没能读取视频（{type(error).__name__}）。请检查标准链接、视频长度、登录和图片模型配置。"
            yield event.plain_result(text)
        event.stop_event()

    @fish.command("journal")
    async def journal(self, event: AstrMessageEvent):
        if self.companion.authorized(event):
            entries = self.companion.store.journal(event.unified_msg_origin, limit=3)
            yield event.plain_result(
                "\n\n".join(e["summary"] for e in entries)[:5000] or "还没有视频观察记录。"
            )
        event.stop_event()

    @fish.command("voice")
    async def voice(self, event: AstrMessageEvent, text: str):
        if self.companion.authorized(event):
            import asyncio

            provider = await self.context.get_using_tts_provider_async(event.unified_msg_origin)
            if provider:
                try:
                    async with asyncio.timeout(60):
                        path = await provider.get_audio(text[:300])
                    yield event.chain_result([Record.fromFileSystem(path)])
                except Exception:
                    yield event.plain_result("语音生成失败，请检查 AstrBot 的 TTS 配置。")
            else:
                yield event.plain_result("请先在 AstrBot 配置 TTS 语音服务。")
        event.stop_event()

    @filter.llm_tool(name="dswhale_watch_video")
    async def watch_tool(self, event: AstrMessageEvent, url: str) -> str:
        """读取 B 站或抖音标准视频链接，返回带证据范围的观察，不支持短链接。

        Args:
            url(string): HTTPS 标准视频页面地址。
        """
        self.companion.require_owner(event)
        try:
            return await self.companion.watch(url)
        except Exception as error:
            return f"视频未读取成功（{type(error).__name__}），不要声称已经看过。请检查标准链接、登录和图片模型。"

    @filter.llm_tool(name="dswhale_recall_memory")
    async def recall_tool(self, event: AstrMessageEvent, query: str) -> str:
        """只读查找同一会话的长期记忆，不会把自主活动写成主人发言。

        Args:
            query(string): 想查证的简短主题、偏好或约定。
        """
        self.companion.require_owner(event)
        try:
            return await self.companion.recall_memory(event, query)
        except Exception:
            return "记忆读取失败，没有新的可核实资料。"

    @filter.llm_tool(name="dswhale_find_videos")
    async def find_tool(self, event: AstrMessageEvent) -> str:
        """从主人配置的 OpenBiliClaw 获取候选视频；只有推荐信息，尚未观看。"""
        import json

        self.companion.require_owner(event)
        try:
            videos = await self.companion.content.recommend()
            return json.dumps(
                [{"url": v.url, "title": v.title, "watched": False} for v in videos],
                ensure_ascii=False,
            )
        except Exception:
            return "内容服务暂不可用，没有读取任何视频。"
