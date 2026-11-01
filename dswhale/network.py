"""Credential-free install routing and checksum-pinned resumable downloads.

Keep imports standard-library-only: bootstrap loads this policy before installing
the application or httpx. System proxy secrets stay in process environment only.
"""

import hashlib
import json
import os
import re
import socket
import ssl
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import proxy_bypass_environment

MESSAGES = {
    "NET_POLICY": "系统网络配置暂不可用，请检查 Clash 或系统代理",
    "NET_PROXY": "代理连接失败，请检查 Clash 是否正在运行",
    "NET_TIMEOUT": "网络请求超时，请检查网络后重试",
    "NET_DNS": "下载来源无法解析，请检查 DNS 或网络设置",
    "NET_TLS": "下载来源的安全连接失败，请检查系统时间和网络设置",
    "NET_HTTP": "下载来源暂时不可用，请稍后重试，必要时检查 Clash",
    "NET_INTERRUPTED": "下载连接中断，已保留进度，可重试继续",
    "NET_CHECKSUM": "下载校验失败，已移除无效文件，请检查 Clash 或系统网络后重试",
    "NET_SIZE": "下载大小超过限制，已停止下载",
    "NET_RANGE": "下载来源返回的续传范围无效，请检查 Clash 或系统网络后重试",
}
SOURCES = {"github", "pypi", "npm", "nodejs", "python", "ffmpeg", "mirror", "other"}


class NetworkError(ValueError):
    def __init__(self, code="NET_INTERRUPTED", source="other"):
        self.code = code if code in MESSAGES else "NET_INTERRUPTED"
        self.source = source if source in SOURCES else "other"
        self.hint = MESSAGES[self.code]
        super().__init__(self.hint)


def _endpoint(value, *, proxy=False):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\s\x00-\x1f\x7f]", value):
        raise NetworkError("NET_POLICY")
    try:
        url = urlsplit(value)
        _ = url.port
        if (
            not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.scheme not in ({"https", "http"} if proxy else {"https"})
            or (proxy and url.path not in ("", "/"))
        ):
            raise ValueError
        return urlunsplit((url.scheme, url.netloc.lower(), url.path or "/", "", ""))
    except ValueError:
        raise NetworkError("NET_POLICY") from None


def normalize_network_config(value=None):
    value = {} if value is None else value
    allowed = {"mode", "proxyUrl", "noProxy", "pypiIndex", "npmRegistry", "assetMirrors"}
    if not isinstance(value, dict) or set(value) - allowed:
        raise NetworkError("NET_POLICY")
    result = {
        "mode": value.get("mode", "system"),
        "proxyUrl": "",
        "noProxy": "",
        "pypiIndex": "",
        "npmRegistry": "",
        "assetMirrors": [],
    }
    if result["mode"] not in ("system", "direct", "custom"):
        raise NetworkError("NET_POLICY")
    if value.get("proxyUrl"):
        result["proxyUrl"] = _endpoint(value["proxyUrl"], proxy=True)
    if result["mode"] == "custom" and not result["proxyUrl"]:
        raise NetworkError("NET_POLICY")
    bypass = value.get("noProxy", "")
    if (
        not isinstance(bypass, str)
        or len(bypass) > 2048
        or not re.fullmatch(r"[\w.,:*\-\[\] ]*", bypass, flags=re.ASCII)
    ):
        raise NetworkError("NET_POLICY")
    result["noProxy"] = bypass.strip()
    for key in ("pypiIndex", "npmRegistry"):
        if value.get(key):
            result[key] = _endpoint(value[key])
    mirrors = value.get("assetMirrors", [])
    if not isinstance(mirrors, list) or len(mirrors) > 16:
        raise NetworkError("NET_POLICY")
    for pair in mirrors:
        if not isinstance(pair, dict) or set(pair) != {"from", "to"}:
            raise NetworkError("NET_POLICY")
        pair = {key: _endpoint(item) for key, item in pair.items()}
        if not all(item.endswith("/") for item in pair.values()):
            raise NetworkError("NET_POLICY")
        result["assetMirrors"].append(pair)
    return result


def read_network_config(runtime=None):
    if os.environ.get("DSWHALE_AUTO_SYSTEM_NETWORK") == "1":
        return normalize_network_config()
    file = (
        Path(runtime) / "network.json"
        if runtime is not None
        else Path(
            os.environ.get("DSWHALE_NETWORK_CONFIG")
            or Path(os.environ.get("DSWHALE_RUNTIME_DIR", ".runtime")) / "network.json"
        )
    )
    try:
        if file.is_symlink() or file.stat().st_size > 32768:
            raise NetworkError("NET_POLICY")
        return normalize_network_config(json.loads(file.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return normalize_network_config()
    except (OSError, ValueError, TypeError):
        raise NetworkError("NET_POLICY") from None


def network_environment(config=None, base=None):
    config = normalize_network_config(config)
    env = dict(os.environ if base is None else base)
    if config["mode"] != "system":
        env = {
            key: value
            for key, value in env.items()
            if not re.fullmatch(r"(https?|all|no)_proxy", key, re.I)
        }
    if config["mode"] == "custom":
        env.update(
            {
                key: config["proxyUrl"]
                for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")
            }
        )
    bypass = config["noProxy"] or ("localhost,127.0.0.1,::1" if config["mode"] == "custom" else "")
    if bypass:
        env.update(NO_PROXY=bypass, no_proxy=bypass)
    if config["pypiIndex"]:
        for key in ("PIP_EXTRA_INDEX_URL", "UV_EXTRA_INDEX_URL", "UV_INDEX", "UV_INDEX_URL"):
            env.pop(key, None)
        env.update(UV_DEFAULT_INDEX=config["pypiIndex"], PIP_INDEX_URL=config["pypiIndex"])
    if config["npmRegistry"]:
        env.update(
            NPM_CONFIG_REGISTRY=config["npmRegistry"], npm_config_registry=config["npmRegistry"]
        )
    return env


def resolve_asset_url(canonical, config=None):
    config, url = normalize_network_config(config), _endpoint(canonical)
    for pair in sorted(config["assetMirrors"], key=lambda pair: -len(pair["from"])):
        if url.startswith(pair["from"]):
            return pair["to"] + url[len(pair["from"]) :]
    return url


def classify_source(url):
    host = urlsplit(url).hostname
    if host in {
        "github.com",
        "api.github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    }:
        return "github"
    if host in {"pypi.org", "files.pythonhosted.org"}:
        return "pypi"
    return {
        "registry.npmjs.org": "npm",
        "nodejs.org": "nodejs",
        "python.org": "python",
        "www.python.org": "python",
        "www.gyan.dev": "ffmpeg",
        "ffmpeg.org": "ffmpeg",
        "ffmpeg.martin-riedl.de": "ffmpeg",
        "evermeet.cx": "ffmpeg",
    }.get(host, "other")


def safe_network_error(error, source="other"):
    if isinstance(error, NetworkError):
        return NetworkError(error.code, source if error.source == "other" else error.source)
    name = type(error).__name__
    if "Proxy" in name:
        return NetworkError("NET_PROXY", source)
    if "Timeout" in name:
        return NetworkError("NET_TIMEOUT", source)
    # Inspect types/codes only; exception text can contain proxy credentials.
    cause = error
    for _ in range(5):
        if isinstance(cause, socket.gaierror):
            return NetworkError("NET_DNS", source)
        if isinstance(cause, ssl.SSLError):
            return NetworkError("NET_TLS", source)
        cause = getattr(cause, "__cause__", None)
        if cause is None:
            break
    return NetworkError("NET_INTERRUPTED", source)


@contextmanager
def _https_response(stream, url, headers, options):
    for _ in range(6):
        try:
            parsed = urlsplit(url)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
            ):
                raise ValueError
        except ValueError:
            raise NetworkError("NET_POLICY") from None
        with stream("GET", url, headers=headers, **options) as response:
            if getattr(response, "status_code", 200) not in (301, 302, 303, 307, 308):
                yield response
                return
            location = response.headers.get("location")
            if not location:
                raise NetworkError("NET_HTTP")
            url = urljoin(url, location)
    raise NetworkError("NET_HTTP")


def download_verified(
    asset, destination, *, config=None, stream=None, max_bytes=300 * 1024**2, retries=2
):
    import httpx

    config = read_network_config() if config is None else normalize_network_config(config)
    if not re.fullmatch(r"[a-f0-9]{64}", asset.get("sha256", "")):
        raise ValueError("下载必须使用 HTTPS 和 SHA256 校验")
    try:
        url = resolve_asset_url(asset["url"], config)
    except NetworkError:
        raise ValueError("下载必须使用 HTTPS 和 SHA256 校验") from None
    source = classify_source(url) if url == asset["url"] else "mirror"
    destination = Path(destination)
    partial = destination.with_name(destination.name + ".part")
    stream = stream or httpx.stream
    started = time.monotonic()
    options = {"timeout": 90, "follow_redirects": False, "trust_env": config["mode"] == "system"}
    if config["mode"] == "custom" and not proxy_bypass_environment(
        urlsplit(url).hostname, {"no": config["noProxy"]}
    ):
        options["proxy"] = config["proxyUrl"]
    attempts = max(0, min(3, retries)) + 1
    for attempt in range(attempts):
        try:
            if partial.is_symlink() or destination.is_symlink():
                raise NetworkError("NET_POLICY", source)
            offset = partial.stat().st_size if partial.exists() else 0
            if offset > max_bytes:
                raise NetworkError("NET_SIZE", source)
            if offset:
                with partial.open("rb") as content:
                    complete = hashlib.file_digest(content, "sha256").hexdigest() == asset["sha256"]
                if complete:
                    partial.replace(destination)
                    return
            headers = {"User-Agent": "Mozilla/5.0 DSWhale-Desktop", "Accept-Encoding": "identity"}
            if offset:
                headers["Range"] = f"bytes={offset}-"
            with _https_response(stream, url, headers, options) as response:
                if urlsplit(str(getattr(response, "url", url))).scheme != "https":
                    raise NetworkError("NET_POLICY", source)
                status = getattr(response, "status_code", 200)
                if status not in (200, 206):
                    raise NetworkError("NET_HTTP", source)
                length_header = getattr(response, "headers", {}).get("content-length")
                try:
                    length = int(length_header) if length_header is not None else None
                except ValueError:
                    raise NetworkError("NET_RANGE", source) from None
                if length is not None and length < 0:
                    raise NetworkError("NET_RANGE", source)
                total = length
                if status == 206:
                    match = re.fullmatch(
                        r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("content-range", "")
                    )
                    if not match:
                        raise NetworkError("NET_RANGE", source)
                    start, end, total = map(int, match.groups())
                    if (
                        start != offset
                        or end < start
                        or end >= total
                        or (length is not None and length != end - start + 1)
                    ):
                        raise NetworkError("NET_RANGE", source)
                else:
                    offset = 0
                if total is not None and total > max_bytes:
                    raise NetworkError("NET_SIZE", source)
                count, received = offset, 0
                with partial.open("ab" if offset else "wb") as output:
                    for chunk in response.iter_bytes():
                        count += len(chunk)
                        received += len(chunk)
                        if count > max_bytes or (total is not None and count > total):
                            raise NetworkError("NET_SIZE", source)
                        if time.monotonic() - started > 600:
                            raise NetworkError("NET_TIMEOUT", source)
                        output.write(chunk)
                if (length is not None and received != length) or (
                    total is not None and count != total
                ):
                    raise NetworkError("NET_INTERRUPTED", source)
            with partial.open("rb") as content:
                if hashlib.file_digest(content, "sha256").hexdigest() != asset["sha256"]:
                    raise NetworkError("NET_CHECKSUM", source)
            partial.replace(destination)
            return
        except (OSError, httpx.HTTPError, NetworkError) as error:
            safe = safe_network_error(error, source)
            terminal = safe.code in {
                "NET_CHECKSUM",
                "NET_SIZE",
                "NET_RANGE",
                "NET_POLICY",
                "NET_TLS",
            }
            if terminal:
                try:
                    partial.unlink(missing_ok=True)
                except OSError:
                    pass
            if terminal or attempt == attempts - 1 or time.monotonic() - started > 600:
                raise safe from None
            time.sleep(min(0.05 * 2**attempt, 0.2))
