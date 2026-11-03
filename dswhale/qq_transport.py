"""Bound-owner delivery for OneBot and QQ's official C2C adapter."""

import asyncio
import copy

from astrbot.api.event import MessageChain
from astrbot.api.message_components import Plain
from astrbot.api.platform import AstrBotMessage, MessageMember, MessageType


def owner_platform(companion):
    settings = companion.settings
    if not settings.owner_scope:
        raise RuntimeError("尚未绑定主人私聊")
    platform = companion.context.get_platform_inst(settings.owner_scope.split(":", 1)[0])
    if not platform or platform.meta().name != settings.adapter_name:
        raise RuntimeError("绑定的 QQ 接入方式不可用")
    return platform


def owner_connected(companion):
    platform = owner_platform(companion)
    client = platform.get_client()
    if companion.settings.qq_connection_mode == "napcat":
        return bool(getattr(client, "_wsr_api_clients", {}))
    for socket in getattr(client, "_active_websockets", ()):
        connection = getattr(socket, "_conn", None)
        session = getattr(socket, "_session", {})
        if (
            connection is not None
            and getattr(connection, "closed", True) is False
            and isinstance(session, dict)
            and session.get("session_id")
        ):
            return True
    return False


async def send_owner_chain(companion, chain):
    """True means OneBot acknowledged the call; official submission is uncertain.

    The official Context API reports routing, not a message receipt, and its SDK
    may swallow a rejected send. Never turn that bool into verified delivery or
    retry an uncertain submission at the application layer.
    """
    platform = owner_platform(companion)
    if companion.closed:
        raise RuntimeError("服务已关闭")
    if companion.settings.qq_connection_mode == "official":
        matched = await companion.context.send_message(companion.settings.owner_scope, chain)
        if matched is not True:
            raise RuntimeError("官方机器人投递未确认")
        return False
    await platform.get_client().send_private_msg(
        user_id=int(companion.settings.owner_id),
        message=[
            {
                "type": "text",
                "data": {
                    "text": "".join(p.text for p in chain.chain if isinstance(p, Plain))[:4000]
                },
            }
        ],
    )
    return True


async def send_owner_text(companion, text):
    return await send_owner_chain(companion, MessageChain([Plain(text[:4000])]))


async def owner_event(companion, prompt, activity_id):
    platform = owner_platform(companion)
    message = AstrBotMessage()
    message.type = MessageType.FRIEND_MESSAGE
    message.self_id = "unknown_selfid"
    if companion.settings.qq_connection_mode == "napcat":
        async with asyncio.timeout(15):
            login = await platform.get_client().call_action("get_login_info")
        message.self_id = str(login["user_id"])
    message.session_id = companion.settings.owner_id
    message.sender = MessageMember(companion.settings.owner_id, "DSWhale 内部活动")
    message.message = [Plain(prompt)]
    message.message_str = prompt
    message.message_id = activity_id
    message.raw_message = None
    event = platform.create_event(message)
    if companion.settings.qq_connection_mode == "official":
        event._dswhale_official_owner_event = companion
    if event.unified_msg_origin != companion.settings.owner_scope or not companion.authorized(
        event
    ):
        raise RuntimeError("主人私聊会话不匹配")
    if companion.settings.qq_connection_mode == "official":

        async def send(chain):
            await send_owner_chain(companion, chain)
            event._has_send_oper = True

        async def send_streaming(generator, use_fallback=False):
            combined = None
            async for chain in generator:
                if chain.type != "break":
                    if combined is None:
                        combined = chain.derive([])
                    combined.chain.extend(copy.deepcopy(chain.chain))
            if combined and combined.chain:
                await event.send(combined)

        event.send = send
        event.send_streaming = send_streaming
    return event
