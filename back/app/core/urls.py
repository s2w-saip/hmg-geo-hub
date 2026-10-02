"""URL 정규화(API·적재기 판정 한 벌).

- normalize_url_for_match: 현행 lib/scope/url-match.ts normalizeUrlForMatch 1:1 이식. 적재기 판정 SQL 의 pg_temp.cit_norm
  (back/migration/seed/seed-3x-common.sql §1)과 글자 단위로 같아야 한다(프로젝트 추적 URL url_norm ↔ 인용 url_norm 대조).
  대조 테스트: tests/core/test_round6.py(골든 URL 세트를 두 쪽에 통과시켜 비교).
- normalize_url_base_for_match: 적재기 pg_temp.cit_base_norm(seed-3x-common.sql §1, 미러 0052 citation_url_base_norm)의 이식.
  rd.dim_url.url_base_norm 과 글자 단위로 같아야 한다(검수 상세 비서빙 인용의 url_base_norm, BG-46 보강). 대조 테스트는 위와 같은 방식.
- canonical_http_url: 등록용 http(s) URL 검증·정규화(현행 new URL(x).toString() 대응). 실패는 422 invalid_url.
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit

from app.core import errors

__all__ = ["TRACKING_PARAMS", "canonical_http_url", "normalize_url_base_for_match", "normalize_url_for_match"]

TRACKING_PARAMS = r"(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)"
_TRACK_MID = re.compile(rf"&{TRACKING_PARAMS}=[^&]*")
_TRACK_HEAD = re.compile(rf"\?{TRACKING_PARAMS}=[^&]*&")
_TRACK_ONLY = re.compile(rf"\?{TRACKING_PARAMS}=[^&]*$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f\s\ud800-\udfff]")


def normalize_url_for_match(raw: str | None) -> str:
    """trim → lower → scheme → www. → fragment → 트래킹 파라미터 3패스 → 끝 슬래시. 빈 값이면 ''."""
    if not raw:
        return ""
    s = raw.strip().lower()
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"^www\.", "", s)
    s = re.sub(r"#.*$", "", s, flags=re.S)
    s = _TRACK_MID.sub("", s)
    s = _TRACK_HEAD.sub("?", s, count=1)
    s = _TRACK_ONLY.sub("", s, count=1)
    return re.sub(r"/+$", "", s)


# btrim($1, E' \t\n\r\f\013') 의 문자 집합(파이썬 str.strip() 기본 공백보다 좁다)
_BASE_TRIM = " \t\n\r\f\v"


def normalize_url_base_for_match(raw: str | None) -> str | None:
    """trim(ASCII 공백 6종) → lower → scheme → www. → '?' 앞 → '#' 앞 → 끝 슬래시. 입력 NULL 이면 None(SQL STRICT), 빈 값이면 ''."""
    if raw is None:
        return None
    s = raw.strip(_BASE_TRIM).lower()
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"^www\.", "", s)
    s = s.split("?", 1)[0].split("#", 1)[0]
    return s.rstrip("/")


def canonical_http_url(raw: str | None, *, field: str) -> str:
    """http(s) URL 검증·정규화(scheme·host 소문자, 빈 경로는 '/'). 자격증명·제어 문자·2048자 초과는 422 invalid_url."""
    s = (raw or "").strip()
    if not s:
        raise errors.unprocessable("URL 을 입력해야 한다", code="invalid_url", details={"field": field})
    if len(s) > 2048 or _CONTROL.search(s):
        raise errors.unprocessable("URL 형식 오류", code="invalid_url", details={"field": field})
    try:
        u = urlsplit(s)
        host = u.hostname
        port = u.port
    except ValueError as e:
        raise errors.unprocessable("URL 형식 오류", code="invalid_url", details={"field": field}) from e
    if u.scheme.lower() not in ("http", "https") or not host:
        raise errors.unprocessable("http(s):// URL 만 등록할 수 있다", code="invalid_url", details={"field": field})
    netloc = host.lower() + (f":{port}" if port else "")
    if u.username or u.password:
        raise errors.unprocessable("URL 에 자격증명을 넣을 수 없다", code="invalid_url", details={"field": field})
    return urlunsplit((u.scheme.lower(), netloc, u.path or "/", u.query, u.fragment))
