"""Bound-owner delivery for OneBot and QQ's official C2C adapter."""

import asyncio
import copy

from astrbot.api.event import MessageChain
from astrbot.api.message_components import Plain
from astrbot.api.platform import AstrBotMessage, MessageMember, MessageType


def owner_binding(companion, binding=None):
    """Resolve an explicit binding; default delivery is only for autonomy."""
    binding = binding or companion.settings.delivery_binding
    if binding is None:
        raise RuntimeError("尚未绑定主人私聊或默认主动渠道不可用")
    return binding


def owner_platform(companion, binding=None):
    binding = owner_binding(companion, binding)
    platform = companion.context.get_platform_inst(binding.platform_id)
    if not platform or platform.meta().name != binding.adapter_name:
        raise RuntimeError("绑定的 QQ 接入方式不可用")
    return platform


def owner_connected(companion, binding=None):
    binding = owner_binding(companion, binding)
    platform = owner_platform(companion, binding)
    client = platform.get_client()
    if binding.channel == "napcat":
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


async def send_owner_chain(companion, chain, binding=None):
    """True means OneBot acknowledged the call; official submission is uncertain.

    The official Context API reports routing, not a message receipt, and its SDK
    may swallow a rejected send. Never turn that bool into verified delivery or
    retry an uncertain submission at the application layer.
    """
    binding = owner_binding(companion, binding)
    platform = owner_platform(companion, binding)
    if companion.closed:
        raise RuntimeError("服务已关闭")
    if binding.channel == "official":
        matched = await companion.context.send_message(binding.umo, chain)
        if matched is not True:
            raise RuntimeError("官方机器人投递未确认")
        return False
    await platform.get_client().send_private_msg(
        user_id=int(binding.user_id),
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


async def send_owner_text(companion, text, binding=None):
    return await send_owner_chain(companion, MessageChain([Plain(text[:4000])]), binding)


async def owner_event(companion, prompt, activity_id, binding=None):
    binding = owner_binding(companion, binding)
    platform = owner_platform(companion, binding)
    message = AstrBotMessage()
    message.type = MessageType.FRIEND_MESSAGE
    message.self_id = "unknown_selfid"
    if binding.channel == "napcat":
        async with asyncio.timeout(15):
            login = await platform.get_client().call_action("get_login_info")
        message.self_id = str(login["user_id"])
    message.session_id = binding.user_id
    message.sender = MessageMember(binding.user_id, "DSWhale 内部活动")
    message.message = [Plain(prompt)]
    message.message_str = prompt
    message.message_id = activity_id
    message.raw_message = None
    event = platform.create_event(message)
    if binding.channel == "official":
        event._dswhale_official_owner_event = companion
    if event.unified_msg_origin != binding.umo or not companion.authorized(event):
        raise RuntimeError("主人私聊会话不匹配")
    if binding.channel == "official":

        async def send(chain):
            await send_owner_chain(companion, chain, binding)
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
