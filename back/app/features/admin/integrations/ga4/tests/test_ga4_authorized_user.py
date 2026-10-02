"""D-3(core 9): GA4 자격증명 authorized_user(OAuth 리프레시 토큰) 형식. 네트워크 없이 가짜 토큰 서버(httpx.MockTransport)로 확인한다.

- 교환 = POST https://oauth2.googleapis.com/token, grant_type=refresh_token + client_id·client_secret·refresh_token(폼)
- 받은 access_token 으로 runReport. 비밀값(client_secret·refresh_token·access_token)은 예외 메시지·repr·API 응답·로그에 없다.
- 서비스 계정 JSON 은 그대로 동작(test_ad_ops_ga4.test_google_adapter), type 없는 JSON 은 키로 판정.
"""
from __future__ import annotations

import json
import logging
from urllib.parse import parse_qs

import httpx
import pytest
from pydantic import SecretStr

from app.core.config import Settings
from app.features.admin.integrations.ga4.adapters import OAUTH_TOKEN_URI, Ga4AccessError, GoogleGa4Access

SECRET = "cs-SECRET-do-not-log-7f3a"
REFRESH = "1//rt-REFRESH-do-not-log-9c2e"
ACCESS = "ya29.ACCESS-do-not-log-11aa"


def _au(**over) -> Settings:
    cred = {"type": "authorized_user", "client_id": "cid-123.apps.googleusercontent.com", "client_secret": SECRET,
            "refresh_token": REFRESH, **over}
    return Settings(env="test", ga4_credentials_json=SecretStr(json.dumps(cred)))


class FakeGoogle:
    """가짜 토큰 서버 + Data API. token_status·report_status 로 실패를 흉내 낸다."""

    def __init__(self, token_status: int = 200, report_status: int = 200, token_body: object | None = None):
        self.token_status, self.report_status, self.token_body = token_status, report_status, token_body
        self.seen: list[tuple[str, str]] = []
        self.token_form: dict[str, list[str]] = {}
        self.report_auth: str | None = None

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.seen.append((req.method, str(req.url)))
        if str(req.url) == OAUTH_TOKEN_URI:
            self.token_form = parse_qs(req.content.decode())
            if self.token_status != 200:
                return httpx.Response(self.token_status, json={"error": "invalid_grant", "error_description": f"bad {REFRESH}"})
            return httpx.Response(200, json=self.token_body if self.token_body is not None
                                  else {"access_token": ACCESS, "expires_in": 3599, "token_type": "Bearer"})
        self.report_auth = req.headers.get("authorization")
        return httpx.Response(self.report_status, json={"rows": []} if self.report_status == 200 else {"error": {"message": ACCESS}})


def _no_secret(text: str) -> None:
    for s in (SECRET, REFRESH, ACCESS):
        assert s not in text, s


async def test_authorized_user_refresh_exchange_and_report(caplog):
    g = FakeGoogle()
    a = GoogleGa4Access(_au(), transport=httpx.MockTransport(g))
    assert a.kind == "authorized_user"
    with caplog.at_level(logging.DEBUG):
        await a.check_access("123")
    assert g.seen == [("POST", "https://oauth2.googleapis.com/token"),
                      ("POST", "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport")]
    assert g.token_form == {"grant_type": ["refresh_token"], "client_id": ["cid-123.apps.googleusercontent.com"],
                            "client_secret": [SECRET], "refresh_token": [REFRESH]}
    assert g.report_auth == f"Bearer {ACCESS}"
    _no_secret(repr(a) + str(a) + caplog.text)


async def test_authorized_user_token_uri_is_fixed_and_type_inferred():
    """authorized_user 는 JSON 의 token_uri 를 쓰지 않는다(교환 주소 고정). type 이 없어도 refresh_token 이 있으면 authorized_user."""
    g = FakeGoogle()
    await GoogleGa4Access(_au(token_uri="https://evil.example/token"), transport=httpx.MockTransport(g)).check_access("9")
    assert g.seen[0] == ("POST", OAUTH_TOKEN_URI)
    cred = {"client_id": "c", "client_secret": SECRET, "refresh_token": REFRESH}
    a = GoogleGa4Access(Settings(env="test", ga4_credentials_json=SecretStr(json.dumps(cred))), transport=httpx.MockTransport(FakeGoogle()))
    assert a.kind == "authorized_user"
    await a.check_access("9")


@pytest.mark.parametrize(("token_status", "report_status", "token_body", "kind"), [
    (400, 200, None, "upstream"),                    # invalid_grant(리프레시 토큰 폐기·만료)
    (401, 200, None, "upstream"),                    # invalid_client
    (200, 403, None, "denied"),                      # 속성 권한 없음
    (200, 404, None, "denied"),
    (200, 500, None, "upstream"),
    (200, 200, {"token_type": "Bearer"}, "upstream"),  # access_token 없음
    (200, 200, ["not", "object"], "upstream"),
])
async def test_authorized_user_failures_carry_no_secret(token_status, report_status, token_body, kind):
    g = FakeGoogle(token_status, report_status, token_body)
    with pytest.raises(Ga4AccessError) as ei:
        await GoogleGa4Access(_au(), transport=httpx.MockTransport(g)).check_access("123")
    assert ei.value.kind == kind
    _no_secret(str(ei.value) + repr(ei.value) + str(ei.value.__cause__ or ""))


@pytest.mark.parametrize("cred", [
    {"type": "authorized_user", "client_id": "c", "client_secret": SECRET},                      # refresh_token 없음
    {"type": "authorized_user", "client_id": "c", "client_secret": "", "refresh_token": REFRESH},  # 빈 값
    {"type": "authorized_user", "client_id": 1, "client_secret": SECRET, "refresh_token": REFRESH},
    {"type": "external_account", "audience": "x"},                                              # 지원 밖 type
    ["authorized_user"],
])
def test_authorized_user_bad_json_is_unconfigured_without_secret(cred):
    with pytest.raises(Ga4AccessError) as ei:
        GoogleGa4Access(Settings(env="test", ga4_credentials_json=SecretStr(json.dumps(cred))))
    assert ei.value.kind == "unconfigured"
    _no_secret(str(ei.value) + repr(ei.value) + repr(ei.value.__cause__))


async def test_put_property_verify_with_authorized_user_hides_secret(monkeypatch):
    """서비스 경로(put_property verify=true): 토큰 교환 실패(400)는 502 upstream_ga4 이고 오류 본문에 비밀값이 없다."""
    from app.core.errors import ApiError
    from app.features.admin.integrations.ga4 import service as S
    from app.features.admin.integrations.ga4.schemas import PropertyPut

    async def no_pending(*_a, **_k):
        return {}

    class NoConn:
        async def __aenter__(self):
            return None

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(S, "_pending", no_pending)
    access = GoogleGa4Access(_au(), transport=httpx.MockTransport(FakeGoogle(token_status=400)))
    with pytest.raises(ApiError) as ei:
        await S.put_property(lambda: NoConn(), None, access, "123", PropertyPut.model_validate({"verify": True}))  # type: ignore[arg-type]
    assert ei.value.status == 502 and ei.value.code == "upstream_ga4"
    _no_secret(json.dumps(ei.value.body(), ensure_ascii=False))
