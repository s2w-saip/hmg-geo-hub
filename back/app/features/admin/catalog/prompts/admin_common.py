"""admin 기능 입력 도우미(AD-1·AD-1b·AD-2 가 같이 쓴다).

- 무시한 공통 필터 축(meta.ignored_filters)은 core 가 한 벌로 계산한다: core.envelope.crud_meta(request.query_params, support=…)
  또는 core.filters.ignored_axes. 이 파일에는 두지 않는다(메인 처분 2026-09-28: core 는 무시 축만, 도메인 입력 규칙은 기능).
- 여기 남는 것은 관리 원천 편집의 입력 규칙이다: 목록 필터 값 형식(check_values), 트림·빈 값 규칙(clean_text), ILIKE 패턴,
  쓰기 전 브랜드 FK 사전 검증(brand_codes). 자유 문자열의 NUL·서로게이트·제어 문자 거부는 스키마의 core.filters.PgText·PgLine 이 먼저 한다.
- 값 형식 규칙은 core.filters 와 같다(제어 문자 없음, 1~100자).
"""
from __future__ import annotations

import re
from collections.abc import Iterable

from app.core import errors

VALUE_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,100}$")


def check_values(name: str, values: Iterable[str]) -> list[str]:
    """목록 필터 값 형식 검사(core.filters 와 같은 규칙). 틀리면 422."""
    out = []
    for v in values:
        if not VALUE_RE.match(v):
            raise errors.unprocessable(f"{name} 값 형식 오류", details={"field": name})
        out.append(v)
    return out


def clean_text(v: str | None, *, field: str, max_len: int, required: bool = False) -> str | None:
    """앞뒤 공백 제거, 빈 문자열은 None(현행 `x?.trim() || null`). 필수인데 비면 422."""
    if v is None:
        if required:
            raise errors.unprocessable(f"{field} 필수", details={"field": field})
        return None
    s = v.strip()
    if not s:
        if required:
            raise errors.unprocessable(f"{field} 는 비울 수 없다", details={"field": field})
        return None
    if len(s) > max_len or "\x00" in s:
        raise errors.unprocessable(f"{field} 길이·형식 오류(≤ {max_len}자)", details={"field": field})
    return s


def like_pattern(q: str) -> str:
    """ILIKE 부분일치 패턴(%, _, \\ 이스케이프). 값은 바인드로만 넣는다."""
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


async def brand_codes(conn) -> dict[str, bool]:
    """app.brand 코드 → is_umbrella. 쓰기 전 FK 사전 검증용(기능 코드 unknown_brand·invalid_brand 로 돌려주려고).
    검증과 쓰기 사이에 브랜드가 사라지는 경쟁은 DB FK(23503)가 막고 core 전역 처리기가 422 constraint_violation 으로 바꾼다."""
    from app.core.db import fetch_all
    rows = await fetch_all(conn, "SELECT brand_code, is_umbrella FROM app.brand")
    return {r["brand_code"]: bool(r["is_umbrella"]) for r in rows}
