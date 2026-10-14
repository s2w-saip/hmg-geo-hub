"""Supabase Auth Admin 얇은 어댑터(주입 가능). 계정 생성·삭제·최근 로그인 조회만.

- 설정은 core.config(get_settings): supabase_url(https://<ref>.supabase.co)·supabase_service_role_key(SecretStr, 로그·응답·argv 에
  싣지 않는다)·supabase_timeout_s(기본 10). env 이름은 HGH_SUPABASE_URL·HGH_SUPABASE_SERVICE_ROLE_KEY·HGH_SUPABASE_TIMEOUT_S.
- 외부 호출 함수는 DB 커넥션을 인자로 받지 않는다(core.db 규약, 핸들러는 CurrentUserDetached). 실패는 AuthAdminError(kind) 하나로 올린다.
- 테스트는 get_auth_admin 의존성을 가짜로 바꾸거나(app.dependency_overrides) SupabaseAuthAdmin(settings, transport=httpx.MockTransport) 를 쓴다.
- 최근 로그인 전체 목록 스캔은 프로세스 안에 짧게(SCAN_TTL_S) 남긴다. 계정 목록 화면은 limit 200 페이지를 끝까지 이어 부르므로
  이어지는 페이지(reuse=True, 커서 있음)는 첫 페이지가 시작한 스캔의 읽은 행·다음 페이지 위치를 이어 쓴다(페이지마다 처음부터 재스캔하지 않음).
  첫 페이지(reuse=False)는 늘 새로 스캔한다. 생성·삭제는 스캔을 버린다.
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Any, Literal, Protocol

import httpx
from fastapi import Depends

from app.core.config import Settings, get_settings

log = logging.getLogger("hgh.admin.users")

ErrorKind = Literal["conflict", "not_found", "upstream", "unconfigured"]


class AuthAdminError(Exception):
    def __init__(self, kind: ErrorKind, message: str = ""):
        super().__init__(f"{kind}: {message}")
        self.kind = kind


def configured(s: Settings) -> bool:
    return bool(s.supabase_url and s.supabase_service_role_key)


class AuthAdmin(Protocol):
    async def create_user(self, email: str, password: str) -> uuid.UUID: ...
    async def delete_user(self, user_id: uuid.UUID) -> None: ...
    async def last_sign_in(self, user_ids: list[uuid.UUID], *, reuse: bool = False) -> dict[uuid.UUID, datetime | None]: ...


def _ts(v: Any) -> datetime | None:
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


@dataclass
class _Scan:
    """전체 목록 스캔 진행분: 읽은 사용자(id → 최근 로그인)와 다음에 읽을 페이지(0 = 끝까지 읽음)."""
    started: float
    seen: dict[uuid.UUID, datetime | None] = field(default_factory=dict)
    next_page: int = 1


_SCANS: dict[str, _Scan] = {}          # 기준 URL → 스캔(프로세스 안, 요청 간 공유)


def clear_scans() -> None:
    _SCANS.clear()


def _now() -> float:
    return time.monotonic()


class SupabaseAuthAdmin:
    """GoTrue Admin REST(/auth/v1/admin/users). 서비스 롤 키는 헤더로만 보낸다."""

    PER_PAGE = 1000
    MAX_PAGES = 50
    SCAN_TTL_S = 30.0

    def __init__(self, settings: Settings | None = None, *, transport: httpx.AsyncBaseTransport | None = None):
        s = settings or get_settings()
        if not configured(s):
            raise AuthAdminError("unconfigured", "Supabase Admin 설정 없음")
        self._base = f"{(s.supabase_url or '').rstrip('/')}/auth/v1/admin/users"
        key = s.supabase_service_role_key.get_secret_value()  # type: ignore[union-attr]
        self._headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        self._timeout = s.supabase_timeout_s
        self._transport = transport

    def __repr__(self) -> str:                               # 키·헤더를 로그에 남기지 않는다
        return "SupabaseAuthAdmin(key=set)"

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(headers=self._headers, timeout=self._timeout, transport=self._transport)

    async def _call(self, method: str, url: str, **kw: Any) -> httpx.Response:
        try:
            async with self._client() as c:
                return await c.request(method, url, **kw)
        except httpx.HTTPError as e:                      # 연결·타임아웃: 원문(URL·키)을 싣지 않는다
            raise AuthAdminError("upstream", type(e).__name__) from e

    async def create_user(self, email: str, password: str) -> uuid.UUID:
        _SCANS.pop(self._base, None)                              # 목록이 바뀐다: 이어 쓰던 스캔을 버린다
        r = await self._call("POST", self._base, json={"email": email, "password": password, "email_confirm": True})
        if r.status_code in (200, 201):
            try:
                return uuid.UUID(str(r.json()["id"]))
            except (KeyError, ValueError, TypeError) as e:
                raise AuthAdminError("upstream", "응답에 id 없음") from e
        body = r.text.lower()
        if r.status_code in (409, 422) or "already" in body or "email_exists" in body:
            raise AuthAdminError("conflict", "이미 등록된 이메일")
        raise AuthAdminError("upstream", f"create HTTP {r.status_code}")

    async def delete_user(self, user_id: uuid.UUID) -> None:
        _SCANS.pop(self._base, None)
        r = await self._call("DELETE", f"{self._base}/{user_id}")
        if r.status_code in (200, 204):
            return
        if r.status_code == 404:
            raise AuthAdminError("not_found", "auth 사용자 없음")
        raise AuthAdminError("upstream", f"delete HTTP {r.status_code}")

    async def last_sign_in(self, user_ids: list[uuid.UUID], *, reuse: bool = False) -> dict[uuid.UUID, datetime | None]:
        """id → 최근 로그인. 없는 id 는 키가 없다. reuse=True(이어지는 페이지)면 SCAN_TTL_S 안의 스캔 진행분을 이어 쓴다."""
        want = set(user_ids)
        out: dict[uuid.UUID, datetime | None] = {}
        if not want:
            return out
        if len(want) == 1:
            (uid,) = want
            r = await self._call("GET", f"{self._base}/{uid}")
            if r.status_code == 404:
                return {uid: None}
            if r.status_code != 200:
                raise AuthAdminError("upstream", f"get HTTP {r.status_code}")
            return {uid: _ts(r.json().get("last_sign_in_at"))}
        scan = _SCANS.get(self._base) if reuse else None
        if scan is None or _now() - scan.started > self.SCAN_TTL_S:
            scan = _SCANS[self._base] = _Scan(started=_now())
        out = {uid: scan.seen[uid] for uid in want if uid in scan.seen}
        while scan.next_page and len(out) < len(want):
            page = scan.next_page
            r = await self._call("GET", self._base, params={"page": page, "per_page": self.PER_PAGE})
            if r.status_code != 200:
                raise AuthAdminError("upstream", f"list HTTP {r.status_code}")
            users = r.json().get("users") or []
            for u in users:
                try:
                    uid = uuid.UUID(str(u.get("id")))
                except ValueError:
                    continue
                scan.seen[uid] = _ts(u.get("last_sign_in_at"))
                if uid in want:
                    out[uid] = scan.seen[uid]
            scan.next_page = 0 if len(users) < self.PER_PAGE or page >= self.MAX_PAGES else page + 1
        return out


class UnconfiguredAuthAdmin:
    """설정이 없을 때(로컬·CI): 생성·삭제는 503, 최근 로그인은 억제 사유로 드러낸다."""

    async def create_user(self, email: str, password: str) -> uuid.UUID:
        raise AuthAdminError("unconfigured", "Supabase Admin 설정 없음")

    async def delete_user(self, user_id: uuid.UUID) -> None:
        raise AuthAdminError("unconfigured", "Supabase Admin 설정 없음")

    async def last_sign_in(self, user_ids: list[uuid.UUID], *, reuse: bool = False) -> dict[uuid.UUID, datetime | None]:
        raise AuthAdminError("unconfigured", "Supabase Admin 설정 없음")


def get_auth_admin() -> AuthAdmin:
    s = get_settings()
    return SupabaseAuthAdmin(s) if configured(s) else UnconfiguredAuthAdmin()


AuthAdminDep = Annotated[AuthAdmin, Depends(get_auth_admin)]
