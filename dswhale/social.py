"""Owner-approved QQ writes, with a durable ledger and no automatic send retries.

Text form protocol reviewed against diaomin66/astrbot_plugin_qzone_ultra at
4221713b508bf2a88e43e75d1719458d2f69764f (qzone_bridge/client.py).
This is an independent, limited client; no upstream plugin code is executed.
"""

import asyncio
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

PUBLISH_URL = (
    "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6"
)
UNKNOWN = "发布结果未确认；请先到 QQ 空间核对。这条操作不会再次发送。"
SIGNATURE_UNKNOWN = "签名修改结果未确认；请先在 QQ 核对，不会自动重试。"


def parse_qzone_response(raw: str) -> dict:
    """Accept JSON or a single JSONP callback, never executable JavaScript."""
    if not isinstance(raw, str) or len(raw) > 128 * 1024:
        raise ValueError("QQ 空间响应无效")
    text = raw.strip()
    if not text.startswith("{"):
        match = re.fullmatch(
            r"[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\(\s*(\{.*\})\s*\)\s*;?",
            text,
            re.S,
        )
        if match is None:
            raise ValueError("QQ 空间响应无效")
        text = match.group(1)
    try:
        value = json.loads(text)
    except (ValueError, RecursionError):
        raise ValueError("QQ 空间响应无效") from None
    if not isinstance(value, dict):
        raise ValueError("QQ 空间响应无效")
    return value


class SocialActions:
    """Only the incoming owner event's own OneBot client may perform writes.

    Public methods return user-facing Chinese text; authorization failures raise
    PermissionError. ``require_owner`` is the host's additional owner gate and
    may raise or return False. ``is_synthetic`` can additionally check event
    identity; the DSWhale activity marker is always rejected independently.
    ``transport`` exists for isolated protocol tests, never credential discovery.
    """

    def __init__(
        self,
        settings,
        path: Path,
        require_owner,
        *,
        is_synthetic=None,
        transport=None,
        clock=time.time,
    ):
        self.settings = settings
        self.path = Path(path)
        self.require_owner = require_owner
        self.is_synthetic = is_synthetic
        self.transport = transport
        self.clock = clock
        self.closed = False
        self.lock = asyncio.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        os.chmod(self.path, 0o600)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS social_actions (
                id TEXT PRIMARY KEY, scope TEXT NOT NULL, bot_id TEXT NOT NULL,
                kind TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('draft','sending','sent','unknown')),
                created REAL NOT NULL, updated REAL NOT NULL, attempted REAL,
                local_day TEXT NOT NULL, remote_id TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS social_owner_kind ON social_actions(scope,bot_id,kind);
            CREATE TABLE IF NOT EXISTS social_attempts (
                id INTEGER PRIMARY KEY, scope TEXT NOT NULL, bot_id TEXT NOT NULL,
                kind TEXT NOT NULL, attempted REAL NOT NULL, local_day TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS social_attempt_owner ON social_attempts(scope,bot_id,kind);
        """)
        self.db.execute(
            "UPDATE social_actions SET status='unknown',updated=? WHERE status='sending'",
            (self.clock(),),
        )

    def close(self):
        if not self.closed:
            self.closed = True
            self.db.execute(
                "UPDATE social_actions SET status='unknown',updated=? WHERE status='sending'",
                (self.clock(),),
            )
            self.db.close()

    @contextmanager
    def _transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def _authorize(self, event):
        if not self.settings.matches(
            event.get_sender_id(), event.unified_msg_origin, private=event.is_private_chat()
        ):
            raise PermissionError("此功能仅限已绑定主人的 QQ 私聊")
        if self.require_owner(event) is False:
            raise PermissionError("此功能仅限已绑定主人的 QQ 私聊")
        if event.get_extra("dswhale_activity_id") is not None or (
            self.is_synthetic and self.is_synthetic(event)
        ):
            raise PermissionError("内部自主活动不能批准 QQ 账号操作")

    def _bot(self, event):
        if event.get_platform_name() != "aiocqhttp":
            return None, ""
        bot = getattr(event, "bot", None)
        bot_id = str(event.get_self_id())
        if (
            not bot
            or not callable(getattr(bot, "call_action", None))
            or not re.fullmatch(r"[1-9][0-9]{0,19}", bot_id)
        ):
            return None, ""
        return bot, bot_id

    def _day(self):
        return (
            datetime.fromtimestamp(self.clock(), UTC)
            .astimezone(ZoneInfo(self.settings.timezone))
            .date()
            .isoformat()
        )

    @staticmethod
    def _digest(text):
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    @staticmethod
    def _text(text, maximum):
        if not isinstance(text, str):
            return None
        text = text.strip()
        if not text or len(text) > maximum or len(text.encode("utf-8")) > maximum * 6:
            return None
        if any(ord(char) < 32 and char not in "\n\t" for char in text):
            return None
        return text

    def _rate_limit(self, scope, bot_id, kind):
        cooldown, limit = (300, 10) if kind == "signature" else (3600, 3)
        rows = self.db.execute(
            "SELECT attempted,local_day FROM social_attempts WHERE scope=? AND bot_id=? AND kind=?",
            (scope, bot_id, kind),
        ).fetchall()
        if rows and self.clock() - max(row["attempted"] for row in rows) < cooldown:
            return "操作间隔尚未到，请稍后再提交。"
        if sum(row["local_day"] == self._day() for row in rows) >= limit:
            return "今天的操作次数已达上限，请明天再提交。"
        return ""

    def _record_attempt(self, scope, bot_id, kind):
        self.db.execute(
            "INSERT INTO social_attempts(scope,bot_id,kind,attempted,local_day) VALUES(?,?,?,?,?)",
            (scope, bot_id, kind, self.clock(), self._day()),
        )

    def _insert(self, scope, bot_id, kind, text, status):
        ident = secrets.token_hex(8)
        now = self.clock()
        self.db.execute(
            "INSERT INTO social_actions(id,scope,bot_id,kind,content,content_hash,status,"
            "created,updated,attempted,local_day) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                ident,
                scope,
                bot_id,
                kind,
                text if kind == "qzone" else "",
                self._digest(text),
                status,
                now,
                now,
                now if status == "sending" else None,
                self._day(),
            ),
        )
        if status == "sending":
            self._record_attempt(scope, bot_id, kind)
        return ident

    def _duplicate(self, scope, bot_id, kind, text):
        return self.db.execute(
            "SELECT * FROM social_actions WHERE scope=? AND bot_id=? AND kind=? AND content_hash=? "
            "AND (status IN ('draft','sending','unknown') OR updated>?) ORDER BY created DESC LIMIT 1",
            (scope, bot_id, kind, self._digest(text), self.clock() - 86400),
        ).fetchone()

    def _finish(self, ident, status, remote_id=""):
        if self.closed:
            return False
        cursor = self.db.execute(
            "UPDATE social_actions SET status=?,updated=?,remote_id=?,"
            "content=CASE WHEN ?='sent' THEN '' ELSE content END WHERE id=? AND status='sending'",
            (status, self.clock(), remote_id, status, ident),
        )
        return cursor.rowcount == 1

    @staticmethod
    def _signature_requested(event, text):
        incoming = event.message_str.strip()
        command = re.fullmatch(r"/?fish\s+signature\s+(.+)", incoming, re.S)
        if command:
            return command.group(1).strip() == text
        request = re.fullmatch(
            r"(?:请)?(?:帮我)?(?:把|将)?(?:你的|自己的)?(?:QQ\s*)?(?:个性)?签名"
            r"(?:改成|改为|换成|换为|设置为|设为|写成|写上)\s*(.+)",
            incoming,
            re.S | re.I,
        )
        if not request:
            request = re.fullmatch(
                r"(?:请)?(?:帮我)?(?:修改|更改|设置|改|换)(?:一下)?(?:你的|自己的)?"
                r"(?:QQ\s*)?(?:个性)?签名(?:为|成|是|：|:)\s*(.+)",
                incoming,
                re.S | re.I,
            )
        return bool(request and request.group(1).strip().strip("「」“”\"'") == text)

    @staticmethod
    def _draft_message(row):
        return (
            f"QQ 空间文字草稿 {row['id']}（尚未发布，发布后 QQ 空间所有人可见）：\n"
            f"{row['content']}\n\n确认发布请单独发送：/fish qzone-publish {row['id']}"
        )

    async def signature(self, event, text):
        self._authorize(event)
        if not getattr(self.settings, "qq_signature_enabled", False):
            return "QQ 签名修改未启用，请先在设置中开启。"
        if self.closed:
            return "DSWhale 已停止，未开始修改签名。"
        text = self._text(text, 40)
        if text is None or "\n" in text or "\t" in text:
            return "签名需为 1–40 个字的单行文本。"
        if not self._signature_requested(event, text):
            return "需要主人在当前消息中明确要求修改，并给出相同的签名文字。"
        bot, bot_id = self._bot(event)
        if bot is None:
            return "当前消息没有可用的 QQ 连接，签名未修改。"
        async with self.lock:
            if self.closed:
                return "DSWhale 已停止，未开始修改签名。"
            with self._transaction():
                warning = self._rate_limit(event.unified_msg_origin, bot_id, "signature")
                if warning:
                    return warning
                if self._duplicate(event.unified_msg_origin, bot_id, "signature", text):
                    return "这条签名已有记录，未重复提交；请先在 QQ 核对。"
                ident = self._insert(event.unified_msg_origin, bot_id, "signature", text, "sending")
            try:
                async with asyncio.timeout(10):
                    result = await bot.call_action(
                        "set_self_longnick", longNick=text, self_id=bot_id
                    )
                if result is not None and (
                    not isinstance(result, dict)
                    or result.get("status", "ok") != "ok"
                    or result.get("retcode", 0) != 0
                ):
                    raise ValueError("signature result unconfirmed")
            except asyncio.CancelledError:
                self._finish(ident, "unknown")
                raise
            except Exception:
                self._finish(ident, "unknown")
                return SIGNATURE_UNKNOWN
            if not self._finish(ident, "sent"):
                return SIGNATURE_UNKNOWN
            return f"QQ 已接受签名修改请求：「{text}」。"

    async def discard(self, event, ident):
        self._authorize(event)
        if self.closed:
            return "DSWhale 已停止，未取消草稿。"
        _, bot_id = self._bot(event)
        if not isinstance(ident, str) or not re.fullmatch(r"[0-9a-f]{16}", ident):
            return "请填写有效的空间草稿 ID。"
        async with self.lock:
            if self.closed:
                return "DSWhale 已停止，未取消草稿。"
            with self._transaction():
                cursor = self.db.execute(
                    "DELETE FROM social_actions WHERE id=? AND scope=? AND bot_id=? "
                    "AND kind='qzone' AND status='draft'",
                    (ident, event.unified_msg_origin, bot_id),
                )
            return (
                "已取消这条空间草稿，未发布。"
                if cursor.rowcount
                else "草稿不存在或已进入发布流程，未取消任何操作。"
            )

    async def draft(self, event, text):
        self._authorize(event)
        if not getattr(self.settings, "qzone_enabled", False):
            return "QQ 空间文字发布未启用，请先在设置中开启。"
        if self.closed:
            return "DSWhale 已停止，未创建草稿。"
        text = self._text(text, 1000)
        if text is None:
            return "空间文字草稿需为 1–1000 个字的纯文本。"
        bot, bot_id = self._bot(event)
        if bot is None:
            return "当前消息没有可用的 QQ 连接，草稿未创建。"
        scope = event.unified_msg_origin
        with self._transaction():
            duplicate = self._duplicate(scope, bot_id, "qzone", text)
            if duplicate:
                if duplicate["status"] == "draft":
                    return self._draft_message(duplicate)
                return "相同内容已有发送记录，未重复创建；请先到 QQ 空间核对。"
            count = self.db.execute(
                "SELECT COUNT(*) FROM social_actions WHERE scope=? AND bot_id=? "
                "AND kind='qzone' AND status='draft'",
                (scope, bot_id),
            ).fetchone()[0]
            if count >= 5:
                return "最多保留 5 条待发布草稿；请先处理已有草稿。"
            ident = self._insert(scope, bot_id, "qzone", text, "draft")
            row = self.db.execute("SELECT * FROM social_actions WHERE id=?", (ident,)).fetchone()
        return self._draft_message(row)

    async def pending(self, event):
        self._authorize(event)
        if not getattr(self.settings, "qzone_enabled", False):
            return "QQ 空间文字发布未启用，请先在设置中开启。"
        if self.closed:
            return "DSWhale 已停止，不能读取待发布草稿。"
        _, bot_id = self._bot(event)
        if not bot_id:
            return "当前消息没有可用的 QQ 连接，不能读取本账号草稿。"
        rows = self.db.execute(
            "SELECT * FROM social_actions WHERE scope=? AND bot_id=? AND kind='qzone' "
            "AND status!='sent' ORDER BY created DESC LIMIT 10",
            (event.unified_msg_origin, bot_id),
        ).fetchall()
        return (
            "\n\n".join(
                self._draft_message(row) if row["status"] == "draft" else f"{row['id']}：{UNKNOWN}"
                for row in rows
            )
            or "没有待发布的空间草稿。"
        )

    @staticmethod
    def _cookies(result, bot_id):
        if (
            not isinstance(result, dict)
            or result.get("status", "ok") != "ok"
            or result.get("retcode", 0) != 0
        ):
            raise ValueError("invalid cookie response")
        data = result.get("data", result)
        raw = data.get("cookies") if isinstance(data, dict) else None
        if (
            not isinstance(raw, str)
            or len(raw) > 8192
            or not raw.isascii()
            or any(ord(c) < 32 or ord(c) == 127 for c in raw)
        ):
            raise ValueError("invalid cookie response")
        cookies = {}
        for pair in raw.split(";"):
            if not pair.strip():
                continue
            name, sep, value = pair.strip().partition("=")
            if not sep or not re.fullmatch(r"[A-Za-z0-9_]+", name) or name in cookies:
                raise ValueError("invalid cookie response")
            cookies[name] = value
        identities = [cookies[key].removeprefix("o") for key in ("uin", "p_uin") if key in cookies]
        if not identities or any(identity.lstrip("0") != bot_id for identity in identities):
            raise ValueError("cookie account mismatch")
        key = cookies.get("p_skey") or cookies.get("skey")
        if not key:
            raise ValueError("missing cookie key")
        gtk = 5381
        for char in key:
            gtk = (gtk * 33 + ord(char)) & 0x7FFFFFFF
        return raw, gtk

    async def _post(self, bot_id, text, cookie, gtk):
        form = {
            "syn_tweet_verson": "1",
            "paramstr": "1",
            "who": "1",
            "con": text,
            "feedversion": "1",
            "ver": "1",
            "ugc_right": "1",
            "to_sign": "0",
            "hostuin": bot_id,
            "code_version": "1",
            "richval": "",
            "issyncweibo": "0",
            "format": "json",
            "qzreferrer": f"https://user.qzone.qq.com/{bot_id}",
        }
        async with httpx.AsyncClient(
            transport=self.transport,
            timeout=httpx.Timeout(15, connect=5),
            follow_redirects=False,
            trust_env=False,
        ) as client:
            async with client.stream(
                "POST",
                PUBLISH_URL,
                params={"g_tk": str(gtk)},
                data=form,
                headers={
                    "Cookie": cookie,
                    "Referer": f"https://user.qzone.qq.com/{bot_id}",
                    "Origin": "https://user.qzone.qq.com",
                    "User-Agent": "Mozilla/5.0",
                },
            ) as response:
                if response.status_code != 200:
                    raise ValueError("QQ 空间发布未确认")
                chunks = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > 128 * 1024:
                        raise ValueError("QQ 空间响应超过限制")
                    chunks.append(chunk)
                payload = parse_qzone_response(b"".join(chunks).decode("utf-8"))
        code = payload.get("code", payload.get("ret"))
        data = payload.get("data", payload)
        ident = data.get("tid", data.get("fid")) if isinstance(data, dict) else None
        if (
            type(code) is not int
            or code != 0
            or not isinstance(ident, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", ident)
        ):
            raise ValueError("QQ 空间发布未确认")
        return ident

    async def publish(self, event, ident):
        self._authorize(event)
        if not getattr(self.settings, "qzone_enabled", False):
            return "QQ 空间文字发布未启用，请先在设置中开启。"
        if self.closed:
            return "DSWhale 已停止，未开始发布。"
        if not isinstance(ident, str) or not re.fullmatch(r"[a-f0-9]{16}", ident):
            return "草稿编号无效；请先查看待发布草稿。"
        incoming = event.message_str.strip()
        if incoming not in {
            f"/fish qzone-publish {ident}",
            f"fish qzone-publish {ident}",
            f"确认发布空间 {ident}",
        }:
            return f"需要主人单独确认：/fish qzone-publish {ident}"
        bot, bot_id = self._bot(event)
        if bot is None:
            return "当前消息没有可用的 QQ 连接，空间未发布。"
        async with self.lock:
            if self.closed:
                return "DSWhale 已停止，未开始发布。"
            row = self.db.execute(
                "SELECT * FROM social_actions WHERE id=? AND scope=? AND kind='qzone'",
                (ident, event.unified_msg_origin),
            ).fetchone()
            if row is None:
                return "没有找到这条空间草稿。"
            if row["bot_id"] != bot_id:
                return "当前 QQ 账号与草稿创建时不同，未发布。"
            if row["status"] != "draft":
                return "这条草稿已发布，不会重复发送。" if row["status"] == "sent" else UNKNOWN
            with self._transaction():
                warning = self._rate_limit(event.unified_msg_origin, bot_id, "qzone")
                if warning:
                    return warning
                self._record_attempt(event.unified_msg_origin, bot_id, "qzone")
            try:
                async with asyncio.timeout(5):
                    cookies = await bot.call_action(
                        "get_cookies", domain="qzone.qq.com", self_id=bot_id
                    )
                cookie, gtk = self._cookies(cookies, bot_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                return "当前 QQ 空间登录信息不可用，尚未提交发布；请检查协议端登录与 Cookie 权限。"
            if self.closed:
                return "DSWhale 已停止，未开始发布。"
            with self._transaction():
                cursor = self.db.execute(
                    "UPDATE social_actions SET status='sending',attempted=?,updated=?,local_day=? "
                    "WHERE id=? AND status='draft'",
                    (self.clock(), self.clock(), self._day(), ident),
                )
                if cursor.rowcount != 1:
                    return UNKNOWN
            try:
                async with asyncio.timeout(20):
                    remote_id = await self._post(bot_id, row["content"], cookie, gtk)
            except asyncio.CancelledError:
                self._finish(ident, "unknown")
                raise
            except Exception:
                self._finish(ident, "unknown")
                return UNKNOWN
            if not self._finish(ident, "sent", remote_id):
                return UNKNOWN
            return "QQ 空间已发布文字说说；平台已返回发布编号。"
