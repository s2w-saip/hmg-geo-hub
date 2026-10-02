"""엔티티 버전(DB-v2.17) DB 오류 → API 오류. 불변·전이는 DB 트리거가 최종 강제하고(경쟁·우회 대비), 서비스는 사전 검사로 같은 코드를 먼저 낸다.

- 유일 색인 ecat_version_one_draft → 409 ECAT_DRAFT_EXISTS, ecat_apply_one_running → 409 ECAT_APPLY_RUNNING
- 트리거 예외 문구 접두(RAISE EXCEPTION 'CODE: …', SQLSTATE P0001): ECAT_IMMUTABLE·ECAT_APPLY_TRANSITION·ECAT_LEGACY_WRITE·ECAT_CUTOVER_DONE → 409,
  ECAT_MERGE_CHAIN·ECAT_SURFACE_ADD_GLOBAL → 422. 응답 message 는 코드별 고정 문구(DB 원문·값을 싣지 않는다).
"""
from __future__ import annotations

import contextlib
from collections.abc import Iterator

from sqlalchemy.exc import DBAPIError

from app.core import errors
from app.core.errors import db_error_info

UNIQUE = {"ecat_version_one_draft": ("ECAT_DRAFT_EXISTS", "초안이 이미 있다(초안 1개)"),
          "ecat_apply_one_running": ("ECAT_APPLY_RUNNING", "다른 반영이 진행 중이다")}
RAISED = {"ECAT_IMMUTABLE": (409, "활성·보관·폐기 버전과 닫힌 반영은 바꿀 수 없다(초안만 편집)"),
          "ECAT_APPLY_TRANSITION": (409, "반영 상태 전이 불가"),
          "ECAT_LEGACY_WRITE": (409, "활성 엔티티 버전이 있어 명부는 초안 편집으로만 바꾼다"),
          "ECAT_CUTOVER_DONE": (409, "v1 이관은 이미 끝났다"),
          "ECAT_MERGE_CHAIN": (422, "병합 사슬 금지(대상이 다시 병합 원본이거나 이 엔티티를 대상으로 삼는 병합이 있다)"),
          "ECAT_SURFACE_ADD_GLOBAL": (422, "전역 표면은 block 만 된다")}


def _messages(e: BaseException) -> Iterator[str]:
    cur: BaseException | None = e
    for _ in range(6):
        if cur is None:
            return
        for a in getattr(cur, "args", ()) or ():
            if isinstance(a, str):
                yield a
        m = getattr(cur, "message", None)
        if isinstance(m, str):
            yield m
        nxt = getattr(cur, "orig", None)
        cur = nxt if isinstance(nxt, BaseException) and nxt is not cur else cur.__cause__


def map_ecat_error(e: BaseException) -> errors.ApiError | None:
    state, constraint = db_error_info(e)
    if state == "23505" and constraint in UNIQUE:
        code, msg = UNIQUE[constraint]
        return errors.conflict(code, msg)
    if state == "P0001":
        for m in _messages(e):
            for code, (status, msg) in RAISED.items():
                if code in m:
                    return errors.ApiError(status, code, msg)
    return None


@contextlib.contextmanager
def ecat_db_errors() -> Iterator[None]:
    """블록 안 DB 오류 중 엔티티 버전 계약 오류만 API 오류로 바꾼다(그 밖은 그대로: 전역 처리기)."""
    try:
        yield
    except DBAPIError as e:
        mapped = map_ecat_error(e)
        if mapped is None:
            raise
        raise mapped from None
