"""키셋 페이지네이션(전체-통합 §5 core.pagination).

커서 = base64url(JSON{v:1, sort, dir, key:[정렬값…, 고유키], fh: 필터 해시, g: generation(집계 순위 목록만)}).
- 서버는 limit+1 행을 읽어 다음 페이지 유무를 판정한다(keyset_page).
- 필터·정렬이 커서와 다르거나 변조·형식 오류면 422 cursor_invalid, generation 이 바뀌었으면 409 cursor_stale(첫 페이지부터 재조회).
- decode_cursor 는 정렬 열 명세 types(date·timestamptz·int4·int8·text·numeric·uuid·bool)를 필수로 받아 키 원소 형·범위를 대조한다.
- 결과 캐시가 없으므로(D8) 집계 목록은 페이지마다 재집계한다. 기본 limit 은 화면 요구(20~50)로 낮게 둔다.
- 정렬 열은 호출자가 화이트리스트에서 고른 SQL 식만 keyset_predicate 에 넘긴다. NULL 정렬값은 COALESCE 센티넬로 바꿔 넣는다.
"""
from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from app.core import errors
from app.core.sqlb import Binder

Dir = Literal["asc", "desc"]
MAX_LIMIT = 500


def _jsonable(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return {"$d": v.isoformat(), "$t": "dt" if isinstance(v, datetime) else "d"}
    if isinstance(v, UUID):
        return {"$u": str(v)}
    if isinstance(v, Decimal):
        return {"$n": str(v)}
    return v


def filter_hash(obj: Any) -> str:
    """필터·정렬 입력의 안정 해시(정렬된 JSON sha256 앞 16자). 커서가 다른 필터로 재사용되는 것을 막는다."""
    raw = json.dumps(obj, sort_keys=True, default=str, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class Cursor:
    sort: str
    dir: Dir
    key: tuple[Any, ...]
    fh: str
    g: int | None = None


def encode_cursor(c: Cursor) -> str:
    d = {"v": 1, "sort": c.sort, "dir": c.dir, "key": [_jsonable(x) for x in c.key], "fh": c.fh}
    if c.g is not None:
        d["g"] = c.g
    return base64.urlsafe_b64encode(json.dumps(d, separators=(",", ":")).encode()).rstrip(b"=").decode()


KeyType = Literal["date", "timestamptz", "int4", "int8", "text", "numeric", "uuid", "bool"]
NUMERIC_MAX_EXP = 1000        # 커서 numeric 지수 상한(|adjusted()| ≤ 1000): 1E±999999 류로 서버 계산을 부풀리지 못하게
_INT_RANGE = {"int4": (-(2 ** 31), 2 ** 31 - 1), "int8": (-(2 ** 63), 2 ** 63 - 1)}
TEXT_MAX = 512                # 커서 text 키 기본 길이 상한(decode_cursor text_max 로 넓힌다: 본문·URL 정렬 키)
KEY_YEAR_MIN, KEY_YEAR_MAX = 1900, 2999   # 커서 date·timestamptz 키 연도 범위(자리값 1900-01-01·2999-12-31 포함, ±infinity 인코딩 값 거부)


def _typed(raw: Any, typ: str, text_max: int = TEXT_MAX) -> Any:
    """커서 키 원소 1개를 정렬 열 형(typ)으로 복원. 형·범위가 맞지 않으면 ValueError(→ 422)."""
    if typ in _INT_RANGE:
        lo, hi = _INT_RANGE[typ]
        if not isinstance(raw, int) or isinstance(raw, bool) or not lo <= raw <= hi:
            raise ValueError(typ)
        return raw
    if typ == "bool":
        if not isinstance(raw, bool):
            raise ValueError(typ)
        return raw
    if typ == "text":
        if not isinstance(raw, str) or len(raw) > text_max or "\x00" in raw:
            raise ValueError(typ)
        raw.encode("utf-8")                                   # 짝 없는 서로게이트 등 PG 가 못 받는 값 → UnicodeError → 422
        return raw
    if not isinstance(raw, dict) or len(raw) > 2:
        raise ValueError(typ)
    if typ == "date" and raw.get("$t") == "d" and isinstance(raw.get("$d"), str):
        d = date.fromisoformat(raw["$d"])
        if not KEY_YEAR_MIN <= d.year <= KEY_YEAR_MAX:
            raise ValueError("date 범위 밖")
        return d
    if typ == "timestamptz" and raw.get("$t") == "dt" and isinstance(raw.get("$d"), str):
        v = datetime.fromisoformat(raw["$d"])
        if v.tzinfo is None:
            raise ValueError("timestamptz 는 시간대 필요")
        if not KEY_YEAR_MIN <= v.astimezone(UTC).year <= KEY_YEAR_MAX:   # UTC 로 옮겨 1~9999 밖이면 OverflowError → 422
            raise ValueError("timestamptz 범위 밖")
        return v
    if typ == "uuid" and set(raw) == {"$u"} and isinstance(raw["$u"], str):
        return UUID(raw["$u"])
    if typ == "numeric" and set(raw) == {"$n"} and isinstance(raw["$n"], str) and len(raw["$n"]) <= 64:
        v = Decimal(raw["$n"])
        if not v.is_finite() or (v != 0 and abs(v.adjusted()) > NUMERIC_MAX_EXP):
            raise ValueError("numeric 비유한·자릿수 범위 밖")
        return v
    raise ValueError(typ)


def decode_cursor(token: str | None, *, sort: str, dir: Dir, fh: str, types: Sequence[KeyType],
                  generation: int | None = None, text_max: int = TEXT_MAX) -> Cursor | None:
    """None/빈 값이면 첫 페이지(None). types = 정렬 열 명세(키 원소 순서대로, 필수). text_max = text 키 길이 상한(기본 512,
    긴 본문·URL 을 정렬 키로 쓰면 그 열의 입력 상한으로 넓힌다: 8192 까지).
    형식·형·범위·필터·정렬 불일치(변조 포함)는 전부 422 cursor_invalid, 세대 변경은 409 cursor_stale."""
    if not 1 <= text_max <= 8192:
        raise ValueError("text_max 는 1~8192")
    if not token:
        return None
    try:
        if not isinstance(token, str) or len(token) > 4096 + 8 * text_max:      # 비ASCII 는 JSON \uXXXX(6바이트) → base64 8자
            raise ValueError("길이")
        raw = base64.urlsafe_b64decode(token.encode("ascii") + b"=" * (-len(token) % 4))
        d = json.loads(raw)
        if not isinstance(d, dict) or d.get("v") != 1:
            raise ValueError("형식")
        key, g = d.get("key"), d.get("g")
        if not isinstance(key, list) or len(key) != len(types):
            raise ValueError("key 길이")
        if not isinstance(d.get("sort"), str) or d.get("dir") not in ("asc", "desc") or not isinstance(d.get("fh"), str):
            raise ValueError("sort·dir·fh")
        if g is not None and (not isinstance(g, int) or isinstance(g, bool)):
            raise ValueError("g")
        c = Cursor(sort=d["sort"], dir=d["dir"], key=tuple(_typed(x, t, text_max) for x, t in zip(key, types, strict=True)), fh=d["fh"], g=g)
    except (ValueError, KeyError, TypeError, UnicodeError, RecursionError, ArithmeticError) as e:   # decimal.InvalidOperation 포함
        raise errors.unprocessable("커서 형식 오류", code="cursor_invalid") from e
    if c.sort != sort or c.dir != dir or c.fh != fh:
        raise errors.unprocessable("커서가 현재 필터·정렬과 다르다", code="cursor_invalid")
    if generation is not None and c.g is not None and c.g != generation:
        raise errors.conflict("cursor_stale", "데이터 세대가 바뀌었다: 첫 페이지부터 다시 조회", {"generation": generation})
    return c


def clamp_limit(limit: int | None, default: int = 50) -> int:
    if limit is None:
        return default
    if limit < 1 or limit > MAX_LIMIT:
        raise errors.unprocessable(f"limit 은 1~{MAX_LIMIT}", details={"field": "limit"})
    return limit


def keyset_predicate(cols: Sequence[str], dir: Dir, cursor: Cursor | None, b: Binder) -> str | None:
    """(c1, c2, …) < (:k1, :k2, …)(desc) 또는 > (asc). 모든 열이 같은 방향일 때만(행 값 비교). cols 는 화이트리스트 SQL 식."""
    if cursor is None:
        return None
    if len(cols) != len(cursor.key):
        raise errors.unprocessable("커서 키 길이 불일치", code="cursor_invalid")
    op = "<" if dir == "desc" else ">"
    lhs = "(" + ", ".join(cols) + ")"
    rhs = "(" + ", ".join(b.v(k) for k in cursor.key) + ")"
    return f"{lhs} {op} {rhs}"


def keyset_page(rows: list[Any], limit: int, key_fn: Callable[[Any], Sequence[Any]], *, sort: str, dir: Dir, fh: str,
                generation: int | None = None) -> tuple[list[Any], str | None]:
    """limit+1 로 읽은 rows 에서 페이지와 다음 커서를 만든다."""
    has_more = len(rows) > limit
    page = rows[:limit]
    nxt = None
    if has_more and page:
        nxt = encode_cursor(Cursor(sort=sort, dir=dir, key=tuple(key_fn(page[-1])), fh=fh, g=generation))
    return page, nxt


def _is_data_error(e: BaseException) -> bool:
    """asyncpg DataError(SQLSTATE 22xxx 입력 값 오류·클라이언트 측 인코딩 범위 오류) 판별(SQLAlchemy 래핑 포함)."""
    cur: BaseException | None = e
    for _ in range(4):
        if cur is None:
            return False
        state = getattr(cur, "sqlstate", None) or getattr(cur, "pgcode", None)
        if (isinstance(state, str) and state.startswith("22")) or any(c.__name__ == "DataError" for c in type(cur).__mro__):
            return True
        cur = getattr(cur, "orig", None) or cur.__cause__
    return False


_ENCODING_STATES = frozenset({"22021", "22P05"})   # character_not_in_repertoire·untranslatable_character: 커서가 아니라 문자열 인자 탓


def _sqlstate(e: BaseException) -> str | None:
    cur: BaseException | None = e
    for _ in range(4):
        if cur is None:
            return None
        state = getattr(cur, "sqlstate", None) or getattr(cur, "pgcode", None)
        if isinstance(state, str):
            return state
        cur = getattr(cur, "orig", None) or cur.__cause__
    return None


async def fetch_keyset(conn: Any, sql: str, params: dict[str, Any], *, cursor: Cursor | None = None) -> list[dict[str, Any]]:
    """키셋 페이지 조회 실행. cursor = 이 요청이 decode_cursor 로 푼 커서(첫 페이지·미지정은 None).
    커서가 있고 그 값이 검증을 지나 DB 입력 오류(asyncpg DataError, SQLSTATE 22)를 내면 422 cursor_invalid(최후 방어).
    커서가 없거나 오류가 문자열 인코딩(22021·22P05: 검색어 등 문자열 인자 탓)이면 원래 오류를 그대로 올린다(원인과 다른 코드로 뭉개지 않는다:
    자유 문자열 인자는 기능이 core.filters.SAFE_TEXT 로 DB 전에 422 로 막는다)."""
    from sqlalchemy.exc import DBAPIError

    from app.core.db import fetch_all
    try:
        return await fetch_all(conn, sql, params)
    except DBAPIError as e:
        if cursor is not None and _is_data_error(e) and _sqlstate(e) not in _ENCODING_STATES:
            raise errors.unprocessable("커서 값이 정렬 열과 맞지 않음", code="cursor_invalid") from e
        raise
