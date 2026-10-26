import httpx
import pytest

from dswhale.content import ContentClient, ContentError, canonical_url

BILI = "https://www.bilibili.com/video/BV1xx411c7mD"


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1",
        "https://bilibili.com.evil.org/video/BV1xx411c7mD",
        "file:///tmp/a",
        "https://user:pass@www.bilibili.com/video/BV1xx411c7mD",
        "https://www.douyin.com/video/nope",
        "https://www.bilibili.com:444/video/BV1xx411c7mD",
    ],
)
def test_untrusted_url_rejected(url):
    with pytest.raises(ValueError):
        canonical_url(url)


def test_canonicalization_removes_tracking():
    assert canonical_url(BILI + "/?share=secret#foo") == BILI
    assert (
        canonical_url("https://www.douyin.com/video/123456789?foo=bar")
        == "https://www.douyin.com/video/123456789"
    )


async def test_recommendation_contract_auth_dedup_and_filter():
    def handler(req):
        assert req.headers["Authorization"] == "Bearer secret"
        assert req.url.path == "/api/recommendations"
        return httpx.Response(
            200,
            json={
                "items": [
                    {"bvid": "BV1xx411c7mD", "title": "海獭"},
                    {"content_url": BILI, "title": "重复"},
                    {"content_url": "https://www.douyin.com/video/123456789", "title": "猫"},
                    {"content_url": "https://evil.org/a"},
                    "bad",
                    {},
                ]
            },
        )

    client = ContentClient(
        "http://127.0.0.1:8420", token="secret", transport=httpx.MockTransport(handler)
    )
    items = await client.recommend()
    assert [v.title for v in items] == ["海獭", "猫"]
    assert items[0].url == BILI


@pytest.mark.parametrize(
    "status,body", [(401, {}), (500, {}), (200, []), (200, {"items": "wrong"})]
)
async def test_api_failure_is_readable_and_does_not_leak_token(status, body):
    client = ContentClient(
        "http://localhost:8420",
        token="SENSITIVE",
        transport=httpx.MockTransport(lambda _: httpx.Response(status, json=body)),
    )
    with pytest.raises(ContentError) as error:
        await client.recommend()
    assert "SENSITIVE" not in str(error.value)
