"""Normalize supported videos and read the documented OpenBiliClaw feed."""

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx


class ContentError(RuntimeError):
    pass


def canonical_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError("请提供 B 站或抖音的标准视频链接")
    parsed = urlsplit(value.strip())
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port:
        raise ValueError("视频链接必须是无账号信息、无自定义端口的 HTTPS 地址")
    host = parsed.hostname
    if host in {"www.bilibili.com", "bilibili.com", "m.bilibili.com"}:
        match = re.fullmatch(r"/video/(BV[0-9A-Za-z]{10}|av[0-9]+)/?", parsed.path)
        if match:
            return f"https://www.bilibili.com/video/{match[1]}"
    if host in {"www.douyin.com", "douyin.com"}:
        match = re.fullmatch(r"/video/([0-9]{5,30})/?", parsed.path)
        if match:
            return f"https://www.douyin.com/video/{match[1]}"
    raise ValueError("仅支持 bilibili.com/video/… 和 douyin.com/video/…；请先展开短链接")


@dataclass(frozen=True)
class Video:
    url: str
    title: str


class ContentClient:
    def __init__(self, base_url: str, *, token: str = "", transport=None):
        parts = urlsplit(base_url)
        if (
            parts.scheme not in {"http", "https"}
            or not parts.hostname
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
        ):
            raise ValueError("内容服务地址格式不正确")
        if parts.scheme == "http" and parts.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("远程内容服务必须使用 HTTPS")
        self.url = base_url.rstrip("/") + "/api/recommendations"
        self.token = token
        self.transport = transport

    async def recommend(self) -> list[Video]:
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        try:
            async with httpx.AsyncClient(
                transport=self.transport, timeout=15, follow_redirects=False, trust_env=False
            ) as client:
                async with client.stream("GET", self.url, headers=headers) as response:
                    if response.status_code in {401, 403}:
                        raise ContentError("内容服务拒绝访问，请检查 DSWHALE_OBC_TOKEN 环境变量")
                    response.raise_for_status()
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > 2 * 1024 * 1024:
                            raise ContentError("内容服务返回的数据过大")
            import json

            data = json.loads(body)
            if not isinstance(data, dict) or not isinstance(data.get("items"), list):
                raise ContentError("内容服务格式不兼容：需要包含 items 列表")
        except (httpx.HTTPError, ValueError) as error:
            raise ContentError("无法读取内容服务，请检查地址、连接和服务版本") from error
        result, seen = [], set()
        for item in data["items"][:100]:
            if not isinstance(item, dict):
                continue
            url = (
                item.get("content_url") or f"https://www.bilibili.com/video/{item.get('bvid', '')}"
            )
            try:
                url = canonical_url(url)
            except ValueError:
                continue
            if url in seen:
                continue
            seen.add(url)
            title = item.get("title", "未命名视频")
            result.append(Video(url, str(title)[:300]))
        return result[:20]
