"""intent.keywords.tracked 업무 규칙: 프로젝트 추적 키워드 목록·추가·삭제.

- 권한: 목록 = core.auth.resolve_project(member), 추가·삭제 = resolve_project(operate)(canOperateProject 이식, 비용 액션 게이트).
- 쓰기는 api_rw(app 만), 모든 쓰기 SQL 에 project_id 조건(클라이언트가 준 id 로 남의 행을 건드리지 못한다, 현행 _actions.ts:445-455).
- 추적 키워드는 판정 입력이 아니다(judgment_change 없음). 추가해도 수집은 하지 않는다: 화면이 추가 직후 POST /v1/intent/fetches 를 부른다.
- 유효 국가 = 저장 국가, 없으면 프로젝트 국가. 추가 시 프로젝트 국가와 같은 국가는 NULL 로 저장하고,
  term_norm·유효 국가가 같은 행이 있으면 409 duplicate_keyword(검증 D6). 판정은 DB 유니크
  project_tracked_keyword_norm_uq(project_id, term_norm, coalesce(country_code, ''), DB-v2.6 P44)가 하고 INSERT … ON CONFLICT DO NOTHING
  으로 받는다(동시 추가·다른 쓰기 경로도 같은 제약에 걸린다).
- 최신 월 검색량은 그 국가 프리셋(location·language)으로 rd.kw_volume_monthly 1행. include_volume=false(키워드 탭)면 읽지 않고 null.
- 다건 추가(items[] 본문)는 행마다 단건과 같은 검증·판정을 요청 순서대로 적용하고 행별 결과를 준다(단건 N회와 같은 결과).
"""
from __future__ import annotations

import uuid

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.db import fetch_all, fetch_one
from app.core.errors import ErrorDetail
from app.core.kw import clean_term, preset_by_id, preset_of
from app.features.intent.keywords.tracked import queries as q
from app.features.intent.keywords.tracked.schemas import TrackedAddResult, TrackedKeyword, TrackedKeywordIn, TrackedKeywordItem

MAX_DELETE = 100


async def list_keywords(conn: AsyncConnection, project_id: uuid.UUID, project_country: str, *,
                        include_volume: bool = True) -> list[TrackedKeyword]:
    rows = await fetch_all(conn, q.LIST, {"pid": project_id})
    eff = {r["keyword_id"]: preset_by_id(r["country_code"] or project_country) for r in rows}
    probe = [(r["keyword_id"], r["term_norm"], eff[r["keyword_id"]]) for r in rows if eff[r["keyword_id"]] is not None]   # DB 정본 정규화
    latest: dict[uuid.UUID, dict] = {}
    if probe and include_volume:
        vs = await fetch_all(conn, q.LATEST_VOLUME, {
            "ids": [str(i) for i, _, _ in probe], "norms": [n for _, n, _ in probe],
            "locs": [p.location_code for _, _, p in probe], "langs": [p.language_code for _, _, p in probe]})  # type: ignore[union-attr]
        latest = {v["keyword_id"]: v for v in vs}
    out = []
    for r in rows:
        lv = latest.get(r["keyword_id"])
        p = eff[r["keyword_id"]]
        out.append(TrackedKeyword(keyword_id=r["keyword_id"], term=r["term"], country_code=r["country_code"],
                                  country=p.id if p else None, created_at=r["created_at"],
                                  latest_month=lv["month"] if lv else None, latest_volume=lv["search_volume"] if lv else None))
    return out


async def add_keyword(rw: AsyncConnection, project_id: uuid.UUID, project_country: str, term: str, country: str | None, *,
                      in_batch: bool = False) -> TrackedKeyword:
    """중복이면 409 duplicate_keyword. 중복 = 같은 프로젝트에 term_norm 과 유효 국가가 같은 행(검증 D6).
    국가는 app.project.country_code 와 같은 ISO 대문자로 저장한다(검증 m-4, DB CHECK ptk_country_upper). 프로젝트 국가와 같으면
    NULL 로 정규화한다(NULL = 프로젝트 국가): DB 유니크가 coalesce(country_code, '') 로 걸려 있어 'KR' 프로젝트에 NULL 과 'KR' 을 따로
    넣으면 다른 행이 되기 때문이다. 대소문자·NFC·앞뒤 공백은 DB 생성 열 term_norm(app.term_norm)이 같게 본다."""
    t = clean_term(term)
    cc = preset_of(country).id.upper() if country is not None and country.strip() else None
    if cc is not None and cc == (project_country or "").strip().upper():
        cc = None
    r = await fetch_one(rw, q.INSERT_IN_BATCH if in_batch else q.INSERT, {"pid": project_id, "term": t, "country": cc})
    if r is None:           # project_tracked_keyword_norm_uq(또는 원문 UNIQUE) 충돌 → ON CONFLICT DO NOTHING
        raise errors.conflict("duplicate_keyword", "이미 추가된 키워드", {"term": t, "country": cc})
    eff = preset_by_id(cc or project_country)
    return TrackedKeyword(keyword_id=r["keyword_id"], term=r["term"], country_code=r["country_code"], country=eff.id if eff else None,
                          created_at=r["created_at"], latest_month=None, latest_volume=None)


async def add_keywords(rw: AsyncConnection, project_id: uuid.UUID, project_country: str,
                       items: list[TrackedKeywordItem]) -> list[TrackedAddResult]:
    """다건 추가: 행마다 단건 본문 검증(TrackedKeywordIn, 실패는 요청 검증 422 와 같은 내용) → add_keyword 를 요청 순서대로.
    한 행의 422·409 는 그 행 결과이고 다른 행을 막지 않는다. 중복 판정은 앞 행이 넣은 행도 본다(같은 트랜잭션, 단건을 차례로 보낸 것과 같다).
    created_at 은 행 실행 시각(queries.INSERT_IN_BATCH)이라 목록 순서도 요청 순서다.
    그 밖의 오류(DB 등)는 요청 전체 오류로 올린다."""
    out: list[TrackedAddResult] = []
    for it in items:
        try:
            one = TrackedKeywordIn.model_validate(it.model_dump())
        except ValidationError as e:
            details = [{"loc": ["body", *x.get("loc", ())], "msg": x.get("msg"), "type": x.get("type")} for x in e.errors()]
            out.append(TrackedAddResult(status=422, data=None, error=ErrorDetail(code="unprocessable", message="요청 검증 실패", details=details)))
            continue
        try:
            kw = await add_keyword(rw, project_id, project_country, one.term, one.country, in_batch=True)
        except errors.ApiError as e:
            if e.status not in (409, 422):
                raise
            out.append(TrackedAddResult(status=e.status, data=None, error=ErrorDetail(code=e.code, message=e.message, details=e.details)))
            continue
        out.append(TrackedAddResult(status=201, data=kw, error=None))
    return out


async def remove_keywords(rw: AsyncConnection, project_id: uuid.UUID, ids: list[uuid.UUID]) -> int:
    uniq = list(dict.fromkeys(ids))
    if not 1 <= len(uniq) <= MAX_DELETE:
        raise errors.unprocessable(f"ids 는 1~{MAX_DELETE}건", details={"field": "ids"})
    rows = await fetch_all(rw, q.DELETE, {"pid": project_id, "ids": [str(i) for i in uniq]})
    return len(rows)
