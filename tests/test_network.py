import hashlib
import json

import pytest

try:
    from dswhale import network
except ImportError:
    network = None


def test_source_classification_uses_exact_pinned_vendor_domains():
    assert network is not None
    assert network.classify_source("https://ffmpeg.martin-riedl.de/download/asset") == "ffmpeg"
    assert network.classify_source("https://github.com.evil.test/asset") == "other"


def test_policy_rejects_secrets_and_sets_install_environment(tmp_path):
    assert network is not None
    for config in [
        {"mode": "custom", "proxyUrl": "http://user:PRIVATE@localhost:7890"},
        {"pypiIndex": "https://mirror.test/simple?token=PRIVATE"},
        {"assetMirrors": [{"from": "https://nodejs.org/", "to": "http://bad.test/"}]},
        {"password": "PRIVATE"},
    ]:
        with pytest.raises(network.NetworkError) as failure:
            network.normalize_network_config(config)
        assert failure.value.code == "NET_POLICY"
        assert "PRIVATE" not in str(failure.value)
    config = {
        "mode": "custom",
        "proxyUrl": "http://127.0.0.1:7890",
        "pypiIndex": "https://mirror.test/simple",
        "npmRegistry": "https://npm.test/",
    }
    (tmp_path / "network.json").write_text(json.dumps(config))
    saved = network.read_network_config(tmp_path)
    env = network.network_environment(
        saved,
        {
            "PATH": "keep",
            "ALL_PROXY": "socks5://old.test:90",
            "PIP_EXTRA_INDEX_URL": "https://old.test/",
        },
    )
    assert env["HTTPS_PROXY"] == "http://127.0.0.1:7890/"
    assert env["UV_DEFAULT_INDEX"] == env["PIP_INDEX_URL"] == "https://mirror.test/simple"
    assert env["NPM_CONFIG_REGISTRY"] == "https://npm.test/"
    assert "ALL_PROXY" not in env and "PIP_EXTRA_INDEX_URL" not in env
    assert "127.0.0.1" in env.get("NO_PROXY", "")
    assert "HTTPS_PROXY" not in network.network_environment({"mode": "direct"}, env)


class Response:
    def __init__(self, chunks, *, status=200, headers=None, url="https://nodejs.org/dist/asset"):
        self.chunks, self.status_code = chunks, status
        self.headers, self.url = headers or {}, url

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def iter_bytes(self):
        for chunk in self.chunks:
            if isinstance(chunk, Exception):
                raise chunk
            yield chunk


def test_download_retains_partial_then_resumes_verified_bytes(tmp_path):
    assert network is not None
    import httpx

    file = tmp_path / "asset"
    asset = {
        "url": "https://nodejs.org/dist/asset",
        "sha256": hashlib.sha256(b"abcdef").hexdigest(),
    }

    def interrupted(*args, **kwargs):
        return Response(
            [b"abc", httpx.ReadError("PRIVATE /synthetic-home/private proxy")],
            headers={"content-length": "6"},
        )

    with pytest.raises(network.NetworkError) as failure:
        network.download_verified(asset, file, stream=interrupted, retries=0)
    assert failure.value.code == "NET_INTERRUPTED"
    assert "PRIVATE" not in str(failure.value)
    assert file.with_name("asset.part").read_bytes() == b"abc"

    def resumed(*args, **kwargs):
        assert kwargs["headers"]["Range"] == "bytes=3-"
        return Response(
            [b"def"], status=206, headers={"content-range": "bytes 3-5/6", "content-length": "3"}
        )

    network.download_verified(asset, file, stream=resumed, retries=0)
    assert file.read_bytes() == b"abcdef"
    assert not file.with_name("asset.part").exists()


def test_download_restarts_ignored_ranges_but_rejects_invalid_range_and_hash(tmp_path):
    assert network is not None
    file = tmp_path / "asset"
    partial = tmp_path / "asset.part"
    asset = {
        "url": "https://nodejs.org/dist/asset",
        "sha256": hashlib.sha256(b"abcdef").hexdigest(),
    }
    partial.write_bytes(b"abc")
    network.download_verified(asset, file, stream=lambda *a, **k: Response([b"abcdef"]), retries=0)
    assert file.read_bytes() == b"abcdef"
    file.unlink()
    partial.write_bytes(b"abc")
    with pytest.raises(network.NetworkError, match="范围"):
        network.download_verified(
            asset,
            file,
            stream=lambda *a, **k: Response(
                [b"def"], status=206, headers={"content-range": "bytes 2-4/6"}
            ),
            retries=0,
        )
    assert not partial.exists() and not file.exists()
    with pytest.raises(network.NetworkError, match="校验"):
        network.download_verified(asset, file, stream=lambda *a, **k: Response([b"bad"]), retries=0)
    assert not partial.exists() and not file.exists()


def test_mirror_changes_transport_only_and_explicit_proxy_reaches_httpx(tmp_path):
    assert network is not None
    asset = {"url": "https://nodejs.org/dist/asset", "sha256": hashlib.sha256(b"abc").hexdigest()}
    config = {
        "mode": "custom",
        "proxyUrl": "http://127.0.0.1:7890",
        "assetMirrors": [{"from": "https://nodejs.org/dist/", "to": "https://mirror.test/node/"}],
    }

    def stream(method, url, **kwargs):
        assert url == "https://mirror.test/node/asset"
        assert kwargs["proxy"] == "http://127.0.0.1:7890/"
        assert kwargs["trust_env"] is False
        return Response([b"abc"], url=url)

    network.download_verified(asset, tmp_path / "asset", config=config, stream=stream)


def test_launcher_reuses_saved_network_policy(tmp_path, monkeypatch):
    from dswhale.runtime import launch_environment

    (tmp_path / "network.json").write_text(json.dumps({"mode": "direct"}))
    monkeypatch.setenv("HTTPS_PROXY", "http://old.test:90")
    assert launch_environment(tmp_path).get("HTTPS_PROXY") is None


def test_complete_partial_is_verified_without_network(tmp_path):
    assert network is not None
    (tmp_path / "asset.part").write_bytes(b"abc")

    def unreachable(*args, **kwargs):
        pytest.fail("Completed content must be verified before another request")

    network.download_verified(
        {"url": "https://nodejs.org/asset", "sha256": hashlib.sha256(b"abc").hexdigest()},
        tmp_path / "asset",
        stream=unreachable,
        retries=0,
    )
    assert (tmp_path / "asset").read_bytes() == b"abc"


def test_download_checks_each_redirect_before_following_it(tmp_path):
    assert network is not None
    asset = {
        "url": "https://github.com/example/asset",
        "sha256": hashlib.sha256(b"abc").hexdigest(),
    }
    requested = []

    def stream(method, url, **kwargs):
        requested.append(url)
        assert kwargs.get("follow_redirects") is False
        if len(requested) == 1:
            return Response(
                [],
                status=302,
                headers={"location": "https://cdn.test/asset?signature=synthetic"},
                url=url,
            )
        return Response([b"abc"], url=url)

    network.download_verified(asset, tmp_path / "asset", stream=stream)
    assert len(requested) == 2
    with pytest.raises(network.NetworkError) as failure:
        network.download_verified(
            asset,
            tmp_path / "other",
            retries=0,
            stream=lambda *a, **k: Response(
                [], status=302, headers={"location": "http://insecure.test/asset"}
            ),
        )
    assert failure.value.code == "NET_POLICY"
