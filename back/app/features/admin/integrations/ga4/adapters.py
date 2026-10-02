"""GA4 Data API 접근 확인 얇은 어댑터(주입 가능). 속성 등록 시 verify=true 일 때만 부른다(현행 verifyGa4Mapping 이식).

- 설정은 core.config(get_settings): ga4_credentials_json(SecretStr, 로그·응답에 싣지 않는다)·ga4_timeout_s(기본 10).
  env 이름은 HGH_GA4_CREDENTIALS_JSON·HGH_GA4_TIMEOUT_S. JSON 두 형식(D-3, 2026-09-30):
    service_account  {"type":"service_account","client_email","private_key","token_uri"?}  → 서비스 계정 JWT(RS256, PyJWT) 교환
    authorized_user  {"type":"authorized_user","client_id","client_secret","refresh_token"}  → OAuth 리프레시 토큰 교환
                     (운영 hmg-geo 의 GA4_OAUTH_CLIENT_ID·CLIENT_SECRET·REFRESH_TOKEN 과 같은 값. 교환 주소는 고정
                     https://oauth2.googleapis.com/token: JSON 의 token_uri 는 이 형식에서 쓰지 않는다)
  type 이 없으면 키로 판정한다(refresh_token → authorized_user, client_email·private_key → service_account). 그 밖 type 은 unconfigured.
- 토큰 → properties/{id}:runReport 최소 1행(현행 runReport activeUsers limit 1).
- 비밀값(키·client_secret·refresh_token·access_token)은 예외 메시지·repr·로그에 싣지 않는다(상태 코드·예외 종류만).
- 외부 호출 함수는 DB 커넥션을 인자로 받지 않는다(핸들러는 CurrentUserDetached). 실패는 Ga4AccessError(kind) 하나로 올린다.
"""
from __future__ import annotations

import json
import time
from typing import Annotated, Any, Literal, Protocol

import httpx
import jwt
from fastapi import Depends

from app.core.config import Settings, get_settings

ErrorKind = Literal["denied", "upstream", "unconfigured"]
SCOPE = "https://www.googleapis.com/auth/analytics.readonly"
DATA_API = "https://analyticsdata.googleapis.com/v1beta"


class Ga4AccessError(Exception):
    def __init__(self, kind: ErrorKind, message: str = ""):
        super().__init__(f"{kind}: {message}")
        self.kind = kind


def configured(s: Settings) -> bool:
    return s.ga4_credentials_json is not None


class Ga4Access(Protocol):
    async def check_access(self, property_id: str) -> None: ...


CredentialKind = Literal["service_account", "authorized_user"]
OAUTH_TOKEN_URI = "https://oauth2.googleapis.com/token"     # authorized_user 리프레시 토큰 교환(고정)


def _text(cred: dict[str, Any], key: str) -> str:
    v = cred.get(key)
    if not isinstance(v, str) or not v.strip():
        raise KeyError(key)                                  # 키 이름만(값 없음)
    return v.strip()


class GoogleGa4Access:
    """서비스 계정 또는 OAuth 리프레시 토큰(authorized_user)으로 GA4 Data API 에 최소 보고서를 요청해 읽기 권한을 확인한다."""

    def __init__(self, settings: Settings | None = None, *, transport: httpx.AsyncBaseTransport | None = None):
        s = settings or get_settings()
        if not configured(s):
            raise Ga4AccessError("unconfigured", "GA4 자격증명 설정 없음")
        try:
            cred = json.loads(s.ga4_credentials_json.get_secret_value())  # type: ignore[union-attr]
            if not isinstance(cred, dict):
                raise TypeError("not an object")
            kind = cred.get("type")
            if kind is None:
                kind = "authorized_user" if "refresh_token" in cred else "service_account"
            if kind == "authorized_user":
                self.kind: CredentialKind = "authorized_user"
                self._client_id = _text(cred, "client_id")
                self._client_secret = _text(cred, "client_secret")
                self._refresh_token = _text(cred, "refresh_token")
                self._token_uri = OAUTH_TOKEN_URI
            elif kind == "service_account":
                self.kind = "service_account"
                self._email = _text(cred, "client_email")
                self._key = _text(cred, "private_key")
                self._token_uri = str(cred.get("token_uri") or OAUTH_TOKEN_URI)
            else:
                raise Ga4AccessError("unconfigured", "GA4 자격증명 type 은 service_account 또는 authorized_user")
        except (ValueError, KeyError, TypeError) as e:
            raise Ga4AccessError("unconfigured", "GA4 자격증명 JSON 형식 오류") from e
        self._timeout = s.ga4_timeout_s
        self._transport = transport

    def __repr__(self) -> str:                               # 키·client_secret·refresh_token 을 로그에 남기지 않는다
        return f"GoogleGa4Access(kind={self.kind}, credentials=set)"

    def _assertion(self) -> str:
        now = int(time.time())
        return jwt.encode({"iss": self._email, "scope": SCOPE, "aud": self._token_uri, "iat": now, "exp": now + 600},
                          self._key, algorithm="RS256")

    def _token_form(self) -> dict[str, str]:
        if self.kind == "authorized_user":
            return {"grant_type": "refresh_token", "client_id": self._client_id, "client_secret": self._client_secret,
                    "refresh_token": self._refresh_token}
        return {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": self._assertion()}

    async def check_access(self, property_id: str) -> None:
        try:
            form = self._token_form()                        # 서비스 계정은 여기서 서명한다(키 형식 오류 = 설정 문제)
        except (jwt.PyJWTError, ValueError, TypeError) as e:
            raise Ga4AccessError("unconfigured", "서비스 계정 키로 서명 실패") from e
        try:
            async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as c:
                t = await c.post(self._token_uri, data=form)
                if t.status_code != 200:                    # 본문(오류 설명)은 싣지 않는다
                    raise Ga4AccessError("upstream", f"token HTTP {t.status_code}")
                token = t.json().get("access_token")
                if not isinstance(token, str) or not token:
                    raise Ga4AccessError("upstream", "token 응답에 access_token 없음")
                body: dict[str, Any] = {"dateRanges": [{"startDate": "yesterday", "endDate": "yesterday"}],
                                        "metrics": [{"name": "activeUsers"}], "limit": 1}
                r = await c.post(f"{DATA_API}/properties/{property_id}:runReport", json=body,
                                 headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError as e:
            raise Ga4AccessError("upstream", type(e).__name__) from e
        except (ValueError, AttributeError) as e:           # 토큰 응답이 JSON 객체가 아님
            raise Ga4AccessError("upstream", f"token 응답 형식 오류 {type(e).__name__}") from e
        if r.status_code == 200:
            return
        if r.status_code in (400, 403, 404):
            raise Ga4AccessError("denied", f"runReport HTTP {r.status_code}")
        raise Ga4AccessError("upstream", f"runReport HTTP {r.status_code}")


class UnconfiguredGa4Access:
    async def check_access(self, property_id: str) -> None:
        raise Ga4AccessError("unconfigured", "GA4 자격증명 설정 없음")


def get_ga4_access() -> Ga4Access:
    s = get_settings()
    return GoogleGa4Access(s) if configured(s) else UnconfiguredGa4Access()


Ga4AccessDep = Annotated[Ga4Access, Depends(get_ga4_access)]
