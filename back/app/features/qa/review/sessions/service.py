"""qa.review.sessions 업무 규칙: 검수 게이트 입장(세션 발급)과 활동 갱신.

Q17(제품 책임자 2026-09-28): 외부 검수자는 계정 없이 이름 + 공유 비밀번호로 들어오고, 통과 증표는 core.auth 의 HMAC 서명 세션 쿠키다
(현행 app/api/qa/session/route.ts 이식). 세션 행(app.qa_review_session)이 곧 락 소유자·작성자 식별자이며, 행이 지워지면 쿠키가
유효해도 읽기·쓰기를 거부한다(core.auth.QaLiveConn·assert_qa_session: 서버 측 폐기 수단).
- 킬 스위치(HGH_QA_ENABLED) 꺼짐: 입장은 404(현행: 존재를 알리지 않는다), 그 밖의 QA 경로는 core 게이트의 401.
- 비밀번호 시도 상한: 해시한 IP 당 분당 10회(현행 계승) + 전역 분당 60회(IP 를 바꿔 가며 대입하는 경우의 상한).
  프로세스 메모리 버킷이다. 인스턴스 간 공유 상한(qa R4)은 보류(메인 결정: 현재 EC2 1대). IP 당 버킷 키는 core.auth.rate_key_ip
  (IPv6 /64 접두, IPv4·IPv4 사상 IPv6 는 IPv4 주소 그대로. N1: /64 안 주소 회전 우회 차단). 세션 행의 ip_hash 는 원래 주소 그대로다.
  남는 위험: 전역 상한은 모든 뷰어가 공유하므로, IP 여섯 개(IPv6 는 /64 여섯 개)로 분당 60회를 채우면 정상 검수자의 신규 입장도
  그 1분 동안 429 가 된다(이미 입장한 세션은 영향 없음). 공유 저장소 상한·WAF 속도 규칙·CAPTCHA 는 R4 와 함께 보류.
- 클라이언트 IP(D1): core.auth.client_ip(X-Forwarded-For 오른쪽에서 core.config.trusted_proxy_hops 번째 원소, 0 이거나 모자라면 소켓 주소).
  홉 수 = HGH_TRUSTED_PROXY_HOPS(옛 이름 HGH_QA_TRUSTED_PROXY_HOPS 도 읽음). 배포(CloudFront → ALB → 앱) 값 2 는 배포 문서가 정본.
  BFF(Vercel route)를 거치는 입장은 XFF 자리가 Vercel 출구 IP 라, 신뢰 중계 헤더를 쓴다(프론트 어댑터 결정 D2): X-HGH-Relay-Secret 이
  HGH_RELAY_SECRET 과 상수 시간 비교로 같을 때만 X-HGH-Client-IP 를 클라이언트 IP 로 쓴다(core.auth.relay_client_ip). 미설정·불일치면 무시.
- 원문 IP 는 저장하지 않는다(core.auth.hash_ip).
- 로그아웃(D2·N2): PATCH /v1/qa/sessions/{session_id} 본문 {"logout": true}. 한 트랜잭션에서 세션 행을 잠그고 이 세션의 락을 풀고,
  판정·노트의 session_id 를 NULL 로 끊은 뒤 세션 행을 지운다(서버 측 폐기). 판정·노트를 남긴 세션도 로그아웃 즉시 복사해 둔 쿠키가
  401 이 된다. 작성자는 reviewer_name 스냅샷으로 남는다. revoked_at 열(qa R7)·전용 DELETE 경로(qa R8)는 기각(메인 결정, 이유: DDL 없이
  같은 결과·경로 계약 고정).
- 읽기 경로도 세션 행을 확인한다(D3): 라우터는 core.auth.QaLiveConn 을 쓴다. 로그아웃만 QaConn(이미 폐기된 세션도 쿠키를 지울 수 있게).
"""
from __future__ import annotations

import time
import uuid
from collections import deque

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import (
    QaReviewer,
    assert_qa_session,
    check_qa_password,
    client_ip,
    hash_ip,
    normalize_reviewer_name,
    rate_key_ip,
    sign_qa_cookie,
)
from app.core.config import get_settings
from app.core.db import fetch_all, fetch_one, get_db
from app.features.qa.review.sessions import queries as Q
from app.features.qa.review.sessions.schemas import QaLogoutOut, QaSessionOut

ATTEMPTS_PER_MINUTE = 10
GLOBAL_ATTEMPTS_PER_MINUTE = 60                          # 전 IP 합산 상한(IP 를 돌려도 공유 비밀번호 대입 속도가 묶인다)
GLOBAL_KEY = "qa-pw:*"
_WINDOW_S = 60.0


class LoginLimiter:
    """키별 고정 창(최근 60초 시도 수) 상한. 프로세스 메모리(현행 lib/qa/rate-limit.ts 와 같은 범위)."""

    def __init__(self, limit: int = ATTEMPTS_PER_MINUTE, window_s: float = _WINDOW_S, max_keys: int = 10_000,
                 global_limit: int = GLOBAL_ATTEMPTS_PER_MINUTE):
        self.limit, self.window_s, self.max_keys, self.global_limit = limit, window_s, max_keys, global_limit
        self._hits: dict[str, deque[float]] = {}

    def _prune(self, q: deque[float], t: float) -> None:
        while q and t - q[0] >= self.window_s:
            q.popleft()

    def _make_room(self, t: float) -> None:
        """키 표가 가득 차면 창이 지난 키부터 지우고, 그래도 가득하면 마지막 시도가 가장 오래된 키 하나만 뺀다.
        표를 통째로 비우면 새 키를 대량으로 만들어 모든 버킷(전역 포함)을 초기화할 수 있다(D1). 전역 버킷은 빼지 않는다."""
        for k in [k for k, q in self._hits.items() if k != GLOBAL_KEY and (not q or t - q[-1] >= self.window_s)]:
            del self._hits[k]
        while len(self._hits) >= self.max_keys:
            others = [k for k in self._hits if k != GLOBAL_KEY]
            if not others:
                break
            del self._hits[min(others, key=lambda k: self._hits[k][-1] if self._hits[k] else float("-inf"))]

    def _bucket(self, key: str, t: float) -> deque[float]:
        q = self._hits.get(key)
        if q is None:
            if len(self._hits) >= self.max_keys:
                self._make_room(t)
            q = self._hits[key] = deque()
        self._prune(q, t)
        return q

    def hit(self, key: str, now: float | None = None) -> bool:
        """key 버킷과 전역 버킷을 함께 센다. 어느 쪽이든 차 있으면 거부(거부된 시도는 세지 않는다)."""
        t = time.monotonic() if now is None else now
        q = self._bucket(key, t)
        g = self._bucket(GLOBAL_KEY, t)
        if len(q) >= self.limit or len(g) >= self.global_limit:
            return False
        q.append(t)
        g.append(t)
        return True

    def reset(self) -> None:
        self._hits.clear()


limiter = LoginLimiter()


async def login(request: Request, name_raw: str, password: str) -> tuple[QaSessionOut, str]:
    """입장 → (세션, 서명 쿠키 값). 실패: 404(꺼짐)·429(시도 초과)·422(이름)·401(비밀번호)."""
    s = get_settings()
    if not s.qa_enabled:
        raise errors.not_found()
    ip = client_ip(request)                                 # 홉 수 = core.config.trusted_proxy_hops
    ip_h = hash_ip(ip, s)                                   # 세션 행 기록용(원래 주소)
    key_h = hash_ip(rate_key_ip(ip), s)                     # 시도 상한 버킷 키(IPv6 는 /64)
    if not limiter.hit(f"qa-pw:{key_h or 'unknown'}"):
        raise errors.ApiError(429, "rate_limited", "입장 시도 초과(분당 10회)")
    name = normalize_reviewer_name(name_raw)
    if name is None:
        raise errors.unprocessable("검수자 이름은 제어문자 제외 1~40자", code="bad_name", details={"field": "name"})
    if not check_qa_password(password, s):
        raise errors.unauthenticated("비밀번호 불일치", code="bad_credentials")
    ua = (request.headers.get("user-agent") or "")[:500] or None
    async with get_db().transaction("qa_gate") as conn:
        row = await fetch_one(conn, Q.INSERT_SESSION_SQL, {"name": name, "ua": ua, "ip": ip_h})
    out = QaSessionOut(**row)  # type: ignore[arg-type]
    cookie = sign_qa_cookie(QaReviewer(str(out.session_id), name, out.started_at.timestamp()), s)
    return out, cookie


async def current(conn: AsyncConnection, reviewer: QaReviewer) -> QaSessionOut:
    """쿠키의 세션(BG-45). 부작용 없음(last_seen_at 그대로). 행이 없거나(로그아웃·운영 폐기) id 형식이 틀리면 401 qa_unauthorized
    (core.auth.assert_qa_session: QaLiveConn 과 같은 판정·같은 문장)."""
    return QaSessionOut(**await assert_qa_session(conn, reviewer))


async def touch(conn: AsyncConnection, reviewer: QaReviewer, session_id: uuid.UUID) -> QaSessionOut:
    """본인 세션만 last_seen_at 갱신. 남의 세션 id 는 403, 행이 없으면 401."""
    if str(session_id) != reviewer.session_id:
        raise errors.forbidden("본인 세션만 갱신", code="session_forbidden")
    row = await fetch_one(conn, Q.TOUCH_SESSION_SQL, {"sid": session_id})
    if row is None:
        raise errors.unauthenticated("검수 세션 만료", code="qa_unauthorized")
    return QaSessionOut(**row)


async def touch_quiet(conn: AsyncConnection, reviewer: QaReviewer) -> None:
    """락 획득 등의 부수 호출: 활동 갱신(행이 없으면 아무 일도 없다)."""
    await fetch_one(conn, Q.TOUCH_SESSION_SQL, {"sid": uuid.UUID(reviewer.session_id)})


async def logout(conn: AsyncConnection, reviewer: QaReviewer, session_id: uuid.UUID) -> QaLogoutOut:
    """본인 세션 폐기: 세션 행 잠금 → 락 해제 → 판정·노트의 session_id 끊기 → 세션 행 삭제(한 트랜잭션, 문장 분리).
    남의 세션 id 는 403. 행이 이미 없어도 성공(쿠키 삭제는 라우터가 한다)."""
    if str(session_id) != reviewer.session_id:
        raise errors.forbidden("본인 세션만 종료", code="session_forbidden")
    sid = session_id
    existed = await fetch_one(conn, Q.LOCK_SESSION_SQL, {"sid": sid}) is not None
    locks = await fetch_all(conn, Q.RELEASE_SESSION_LOCKS_SQL, {"sid": sid})
    detached = deleted = 0
    if existed:
        detached = len(await fetch_all(conn, Q.DETACH_REVIEWS_SQL, {"sid": sid})) + len(await fetch_all(conn, Q.DETACH_NOTES_SQL, {"sid": sid}))
        deleted = await fetch_one(conn, Q.DELETE_SESSION_SQL, {"sid": sid}) is not None
    kept = existed and not deleted
    return QaLogoutOut(session_id=sid, locks_released=len(locks), session_deleted=bool(deleted), references_detached=detached,
                       session_kept_reason="referenced_by_reviews_or_notes" if kept else None)
