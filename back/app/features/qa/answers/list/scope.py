"""검수 콘솔(qa) 공용 구성요소: 서버 고정 검수 범위(Q17), 필터 모델(QaFilter·QaNoteFilter), 참조 해석(QaRefs),
job 범위 술어 빌더(job_predicates), job 존재·범위 확인(assert_job_in_scope), 좌표(coords).

이 모듈을 qa 7개 기능이 함께 쓴다(현행 answerPredicates 단일 정본 원칙 계승: 한 곳만 고치면 목록·진행률·이웃·노트가 같이 바뀐다).

규칙
- QA 경로는 계정 없는 외부 검수자 게이트(core.auth.require_qa_reviewer, HMAC 쿠키)만 쓰고 qa_gate 풀 커넥션(core.auth.QaLiveConn:
  쿠키 + 세션 행 확인) 하나로 읽고 쓴다. role 스코프 체계 밖이므로 데이터 범위는 요청이 아니라 서버 설정
  (core.config qa_surfaces·qa_since = HGH_QA_SURFACES·HGH_QA_SINCE, 기동 시 검증)으로 고정한다(Q17).
- 모집단 = rd.job 전체(비완료·드롭 포함, G-24). 표준 모수 규칙(std_in·cit_in·dflt·is_rep)은 쓰지 않는다(지표 API 아님).
- WHERE 는 불리언·`= ANY(상수 배열)` 만. 브랜드는 rd.job.bgrp(카탈로그·사이트·프로젝트 브랜드 비트 묶음)를 core.codes.brand_masks 로
  상수 배열로 풀어 `bgrp = ANY(:masks)` 로 건다(비트 연산을 WHERE 에 두지 않는다).
- 브랜드 코드↔비트 정본은 app.brand 다(Q11). qa_gate 는 DB-v2.6 P47 로 app.brand·app.citation_category·app.citation_domain_override
  전체와 app.prompt 16열을 읽는다(권한 확인 분기 없음).
- 지원하지 않는 공통 필터 축(택소노미·출처·project_id·cf.*·own_brand)은 core.filters.ignored_axes 로 meta.ignored_filters 에 적는다.
"""
from __future__ import annotations

import inspect
import json
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta, timezone
from typing import Annotated, Any, Literal

from fastapi import Query, Request
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, model_validator
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.codes import SURFACE_CODE, SURFACE_NAME, brand_masks
from app.core.config import get_settings
from app.core.db import fetch_one
from app.core.envelope import Meta, Page, build_meta
from app.core.filters import FilterSupport, ignored_axes, parse_custom_fields
from app.core.sqlb import Binder

QaSurface = Literal["global", "website", "project"]
ReviewState = Literal["unreviewed", "ok", "issue"]
TargetKind = Literal["answer", "prompt", "mention", "citation", "acr", "meta"]
Severity = Literal["issue", "question", "info"]
JOB_STATUS = {0: "completed", 1: "in_progress", 2: "failed", 3: "other"}     # rd.job.status_code
KST = timezone(timedelta(hours=9))                                             # 한국 표준시(일광절약 없음)
_VALUE_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,100}$")
_REVIEWER_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,40}$")

# 표면별 지원 축(QA 는 표면을 복수로 받으므로 세 표면이 같다). 택소노미·출처 축은 QA 에 없다 → meta.ignored_filters.
QA_SUPPORT = FilterSupport.of(
    global_=("brand", "country", "lang", "engine", "period"),
    website=("brand", "country", "lang", "engine", "period"),
    project=("brand", "country", "lang", "engine", "period"),
)
QA_EXTRA_SUPPORTED = ("surface",)          # QA 는 표면을 복수 필터로 받는다(ignored_axes 에 축으로 세지 않게)
# 답변 락: 브라우저가 죽어도 TTL 이 지나면 다른 검수자가 가져간다. heartbeat 주기의 6배(일시 끊김으로 뺏기지 않게, 현행 계승)
LOCK_TTL_SECONDS = 180
HEARTBEAT_SECONDS = 30


class QaLock(BaseModel):
    job_id: uuid.UUID
    session_id: uuid.UUID
    reviewer_name: str
    acquired_at: datetime
    heartbeat_at: datetime


# ════════════════════════════════════════════════════════════════════════════
# 서버 고정 검수 범위(Q17)
# ════════════════════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class QaScope:
    """검수 대상 범위(요청 파라미터로 넓힐 수 없다). 값은 core.config(qa_surfaces·qa_since)에서만 온다."""
    surfaces: tuple[int, ...]            # 표면 코드(core.codes.SURFACE_CODE) 오름차순
    since: date | None                   # 있으면 round_date ≥ since 인 job 만

    def fingerprint(self) -> dict[str, Any]:
        """커서 필터 해시 입력(범위가 바뀌면 옛 커서는 cursor_invalid)."""
        return {"surfaces": list(self.surfaces), "since": self.since.isoformat() if self.since else None}


def get_qa_scope() -> QaScope:
    """core.config.get_settings().qa_surfaces·qa_since → QaScope. 테스트는 set_settings 로 설정을 바꾼다."""
    s = get_settings()
    return QaScope(surfaces=tuple(sorted({SURFACE_CODE[x] for x in s.qa_surfaces})), since=s.qa_since)


# ════════════════════════════════════════════════════════════════════════════
# 필터 모델
# ════════════════════════════════════════════════════════════════════════════
class QaFilter(BaseModel):
    """검수 목록·진행률·이웃 공통 필터. 리스트 축은 같은 이름을 반복한다(?surface=global&surface=website)."""
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    surface: list[QaSurface] = Field(default_factory=list, max_length=3, description="비우면 서버 검수 범위의 전 표면")
    brand: list[str] = Field(default_factory=list, max_length=20, description="brand_code(카탈로그·사이트·프로젝트 브랜드)")
    country: list[str] = Field(default_factory=list, max_length=300, description="국가 코드(rd.job.geo_key)")
    engine: list[str] = Field(default_factory=list, max_length=20)
    lang: list[str] = Field(default_factory=list, max_length=100, description="rd.job.lang_key 코드")
    from_: date | None = Field(None, alias="from", description="측정 시각(KST 날짜) 시작")
    to: date | None = Field(None, description="측정 시각(KST 날짜) 끝(포함)")
    q: str | None = Field(None, max_length=200, description="프롬프트 텍스트 부분 일치")
    state: list[ReviewState] = Field(default_factory=list, max_length=3, description="OR 결합")
    reviewer: list[str] = Field(default_factory=list, max_length=50)
    has_notes: bool = False
    no_mentions: bool = False
    # 공통 필터 모델의 나머지 축(QA 미지원): 값 형식만 검사하고, 받았다는 사실은 qa_filter 가 core.ignored_axes 로 meta.ignored_filters 에 적는다
    funnel: list[str] = Field(default_factory=list, max_length=100)
    brand_presence: list[str] = Field(default_factory=list, max_length=10)
    list_type: list[str] = Field(default_factory=list, max_length=100)
    depth1: list[str] = Field(default_factory=list, max_length=200)
    depth2: list[str] = Field(default_factory=list, max_length=200)
    depth3: list[str] = Field(default_factory=list, max_length=200)
    source: list[str] = Field(default_factory=list, max_length=50)
    # 공통 필터의 project_id: QA 범위는 서버 고정(Q17)이라 좁히지 않는다 → meta.ignored_filters 'project_id'(D4)
    project_id: str | None = Field(None, max_length=100, description="QA 미지원(서버 고정 범위). 받으면 meta.ignored_filters")
    # meta.ignored_filters: qa_filter 의존성이 요청 쿼리로 채운다(core.filters.ignored_axes, cf.* 는 'custom', D4). 직접 만든 모델은 빈 목록
    _ignored: list[str] = PrivateAttr(default_factory=list)

    @model_validator(mode="after")
    def _check(self) -> QaFilter:
        if self.from_ is not None and self.to is not None and self.from_ > self.to:
            raise ValueError("from ≤ to")
        for name in ("brand", "country", "engine", "lang", "funnel", "brand_presence", "list_type", "depth1", "depth2", "depth3", "source"):
            for v in getattr(self, name):
                if not _VALUE_RE.match(v):
                    raise ValueError(f"{name} 값 형식 오류")
        for v in self.reviewer:
            if not _REVIEWER_RE.match(v):
                raise ValueError("reviewer 값 형식 오류")
        if self.q is not None and "\x00" in self.q:
            raise ValueError("q 형식 오류")
        if self.q is not None:                                  # 현행 filters.ts 계승: 앞뒤 공백 제거, 비면 필터 없음(D5)
            self.q = self.q.strip() or None
        return self

    def fingerprint(self) -> dict[str, Any]:
        """커서 필터 해시 입력(페이지 파라미터 cursor·limit 제외)."""
        return self.model_dump(mode="json", by_alias=True, exclude={"cursor", "limit", "project_id"})


class QaListQuery(QaFilter):
    """목록 질의 = 필터 + 키셋 페이지(FastAPI query 모델은 한 모델로 받아야 펼쳐진다)."""
    cursor: str | None = Field(None, max_length=4096, description="키셋 페이지 토큰(meta.page.next_cursor)")
    limit: int = Field(50, ge=1, le=200)


class QaNoteFilter(QaFilter):
    """노트 목록·건수·내보내기 필터 = 답변 필터 + 노트 3축."""
    target_kind: list[TargetKind] = Field(default_factory=list, max_length=6)
    severity: list[Severity] = Field(default_factory=list, max_length=3)
    include_resolved: bool = Field(False, description="기본 미해결만")


class QaNoteListQuery(QaNoteFilter):
    cursor: str | None = Field(None, max_length=4096, description="키셋 페이지 토큰(meta.page.next_cursor)")
    limit: int = Field(50, ge=1, le=200)


def qa_filter[F: QaFilter](model: type[F]) -> Callable[..., Awaitable[F]]:
    """쿼리 모델 + 무시 축 의존성. cf.<field_id> 는 core.parse_custom_fields 로 검증(형식 오류 422)하고, 들어온 공통 필터 축 중
    QA 가 지원하지 않는 것(택소노미·출처·project_id·cf.*·own_brand)을 core.filters.ignored_axes 로 모은다(D4)."""
    async def dep(request: Request, f: Any) -> F:
        parse_custom_fields(request.query_params)
        f._ignored = ignored_axes(request.query_params, QA_SUPPORT, extra_supported=QA_EXTRA_SUPPORTED)
        return f
    # 이 모듈은 지연 어노테이션(__future__)이라 클로저 변수 model 을 문자열 어노테이션으로 풀 수 없다 → 서명을 객체로 직접 준다
    dep.__signature__ = inspect.Signature([  # type: ignore[attr-defined]
        inspect.Parameter("request", inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=Request),
        inspect.Parameter("f", inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=Annotated[model, Query()]),
    ])
    return dep


# ════════════════════════════════════════════════════════════════════════════
# 참조 해석(qa_gate 가 읽는 차원: rd.dim_*·app.brand(DB-v2.6 P47))
# ════════════════════════════════════════════════════════════════════════════
_REFS_SQL = """
SELECT json_build_object(
  'engines', (SELECT coalesce(json_agg(json_build_object('k', engine_key, 'code', code) ORDER BY code), '[]')
                FROM rd.dim_engine WHERE code <> ''),
  'countries', (SELECT coalesce(json_agg(json_build_object('k', geo_key, 'code', code, 'kind', kind) ORDER BY code), '[]')
                  FROM rd.dim_country WHERE kind <> 'unknown' AND code <> ''),
  'langs', (SELECT coalesce(json_agg(json_build_object('k', lang_key, 'code', code) ORDER BY code), '[]')
              FROM rd.dim_lang WHERE code <> ''),
  'brands', (SELECT coalesce(json_agg(json_build_object('code', brand_code, 'bit', brand_bit) ORDER BY sort_order, brand_code), '[]')
               FROM app.brand)
) AS refs
"""


@dataclass(frozen=True)
class QaRefs:
    engines: dict[str, int]                     # code → engine_key
    countries: dict[str, tuple[int, str]]       # 대문자 code → (geo_key, 원래 표기)
    langs: dict[str, int]                       # 소문자 code → lang_key
    brands: tuple[tuple[str, int], ...]         # (brand_code, bit), app.brand 정렬 순(sort_order, brand_code)

    @property
    def bit_universe(self) -> int:
        u = 0
        for _, bit in self.brands:
            u |= bit
        return u

    def engine_code(self, k: int) -> str | None:
        return next((c for c, v in self.engines.items() if v == k), None)

    def country_code(self, k: int) -> str | None:
        return next((c[1] for c in self.countries.values() if c[0] == k), None)

    def lang_code(self, k: int) -> str | None:
        return next((c for c, v in self.langs.items() if v == k), None)

    def brand_codes(self, bgrp: int) -> list[str]:
        """bgrp 비트 묶음 → brand_code 목록(app.brand 정렬 순). 카탈로그 밖(bgrp 0)은 빈 목록."""
        return [code for code, bit in self.brands if bit & bgrp]


async def load_qa_refs(conn: AsyncConnection) -> QaRefs:
    row = await fetch_one(conn, _REFS_SQL)
    d = row["refs"] if row else {}
    if isinstance(d, str):
        d = json.loads(d)
    return QaRefs(
        engines={x["code"]: int(x["k"]) for x in d["engines"]},
        countries={x["code"].upper(): (int(x["k"]), x["code"]) for x in d["countries"]},
        langs={x["code"].lower(): int(x["k"]) for x in d["langs"]},
        brands=tuple((x["code"], int(x["bit"])) for x in d["brands"]),
    )


# ════════════════════════════════════════════════════════════════════════════
# 필터 해석 → 술어
# ════════════════════════════════════════════════════════════════════════════
@dataclass
class QaResolved:
    surfaces: tuple[int, ...]
    since: date | None
    masks: tuple[int, ...] | None = None
    geo_keys: tuple[int, ...] | None = None
    engine_keys: tuple[int, ...] | None = None
    lang_keys: tuple[int, ...] | None = None
    ts_from: datetime | None = None
    ts_to: datetime | None = None
    q: str | None = None
    states: tuple[str, ...] = ()
    reviewers: tuple[str, ...] = ()
    has_notes: bool = False
    no_mentions: bool = False
    target_kinds: tuple[str, ...] = ()
    severities: tuple[str, ...] = ()
    include_resolved: bool = True
    empty: bool = False                                          # fail-closed: 준 축의 값이 전부 버려짐
    ignored: list[str] = field(default_factory=list)
    dropped: dict[str, list[str]] = field(default_factory=dict)


def escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def kst_start(d: date) -> datetime:
    return datetime.combine(d, time(0, 0), tzinfo=KST)


def resolve_filter(f: QaFilter, refs: QaRefs, scope: QaScope | None = None) -> QaResolved:
    """요청 필터 ∩ 서버 검수 범위 → QaResolved. 모르는 값은 dropped, 준 축에 남는 값이 없으면 empty(결과 0)."""
    sc = scope or get_qa_scope()
    r = QaResolved(surfaces=sc.surfaces, since=sc.since)
    r.ignored = list(f._ignored)

    if f.surface:
        want = {SURFACE_CODE[s] for s in f.surface}
        out = sorted(want - set(sc.surfaces))
        if out:
            r.dropped["surface"] = [SURFACE_NAME[s] for s in out]
        r.surfaces = tuple(sorted(want & set(sc.surfaces)))
        if not r.surfaces:
            r.empty = True

    if f.brand:
        bits = 0
        for c in f.brand:
            bit = next((b for code, b in refs.brands if code == c), None)
            if bit is None:
                r.dropped.setdefault("brand", []).append(c)
            else:
                bits |= bit
        r.masks = tuple(brand_masks(bits, refs.bit_universe)) if bits else ()
        if not r.masks:
            r.empty = True

    def keys(axis: str, values: list[str], lookup: Any) -> tuple[int, ...]:
        ks = []
        for v in values:
            k = lookup(v)
            if k is None:
                r.dropped.setdefault(axis, []).append(v)
            else:
                ks.append(k)
        if not ks:
            r.empty = True
        return tuple(sorted(set(ks)))

    if f.country:
        r.geo_keys = keys("country", f.country, lambda v: (refs.countries.get(v.upper()) or (None,))[0])
    if f.engine:
        r.engine_keys = keys("engine", f.engine, refs.engines.get)
    if f.lang:
        r.lang_keys = keys("lang", f.lang, lambda v: refs.langs.get(v.lower()))
    if f.from_ is not None:
        r.ts_from = kst_start(f.from_)
    if f.to is not None:
        r.ts_to = kst_start(f.to + timedelta(days=1))
    if f.q:
        r.q = "%" + escape_like(f.q) + "%"
    r.states = tuple(dict.fromkeys(f.state))
    r.reviewers = tuple(dict.fromkeys(f.reviewer))
    r.has_notes = f.has_notes
    r.no_mentions = f.no_mentions
    if isinstance(f, QaNoteFilter):
        r.target_kinds = tuple(dict.fromkeys(f.target_kind))
        r.severities = tuple(dict.fromkeys(f.severity))
        r.include_resolved = f.include_resolved
    return r


def job_predicates(r: QaResolved, b: Binder, j: str = "j", rv: str = "rv") -> list[str]:
    """rd.job(j)·app.qa_answer_review(rv, LEFT JOIN) 술어. 표면 술어는 호출자가 붙인다(목록은 표면별 분기)."""
    w: list[str] = []
    if r.since is not None:
        w.append(f"{j}.round_date >= {b.date(r.since)}")
    if r.masks is not None:
        w.append(f"{j}.bgrp = ANY({b.ints(r.masks)})")
    if r.geo_keys is not None:
        w.append(f"{j}.geo_key = ANY({b.ints(r.geo_keys)})")
    if r.engine_keys is not None:
        w.append(f"{j}.engine_key = ANY({b.ints(r.engine_keys)})")
    if r.lang_keys is not None:
        w.append(f"{j}.lang_key = ANY({b.ints(r.lang_keys)})")
    if r.ts_from is not None:
        w.append(f"{j}.measured_at >= {b.v(r.ts_from, 'timestamptz')}")
    if r.ts_to is not None:
        w.append(f"{j}.measured_at < {b.v(r.ts_to, 'timestamptz')}")
    if r.q is not None:
        w.append(f"EXISTS (SELECT 1 FROM rd.dim_prompt dp WHERE dp.prompt_key = {j}.prompt_key AND dp.text ILIKE {b.v(r.q)} ESCAPE '\\')")
    if r.reviewers:
        w.append(f"{rv}.reviewer_name = ANY({b.v(list(r.reviewers), 'text[]')})")
    if r.states:
        parts = []
        if "unreviewed" in r.states:
            parts.append(f"{rv}.job_id IS NULL")
        done = [s for s in r.states if s != "unreviewed"]
        if done:
            parts.append(f"{rv}.status = ANY({b.v(done, 'text[]')})")
        w.append("(" + " OR ".join(parts) + ")")
    if r.has_notes:
        w.append(f"EXISTS (SELECT 1 FROM app.qa_review_note hn WHERE hn.job_id = {j}.job_id)")
    if r.no_mentions:
        w.append(f"NOT EXISTS (SELECT 1 FROM rd.v_answer_mention_raw vm WHERE vm.answer_key = {j}.answer_key)")
    return w


def note_predicates(r: QaResolved, b: Binder, n: str = "n") -> list[str]:
    w: list[str] = []
    if r.target_kinds:
        w.append(f"{n}.target_kind = ANY({b.v(list(r.target_kinds), 'text[]')})")
    if r.severities:
        w.append(f"{n}.severity = ANY({b.v(list(r.severities), 'text[]')})")
    if not r.include_resolved:
        w.append(f"{n}.resolved_at IS NULL")
    return w


def scope_predicates(b: Binder, j: str = "j", scope: QaScope | None = None) -> list[str]:
    """서버 검수 범위만(필터 없음): 단건 확인·deltas 용."""
    sc = scope or get_qa_scope()
    w = [f"{j}.surface = ANY({b.ints(sc.surfaces)})"]
    if sc.since is not None:
        w.append(f"{j}.round_date >= {b.date(sc.since)}")
    return w


# ════════════════════════════════════════════════════════════════════════════
# job 확인·좌표
# ════════════════════════════════════════════════════════════════════════════
JOB_COLS = ("j.answer_key, j.job_id, j.prompt_key, j.round_date, j.measured_at, j.surface, j.project_key, j.engine_key, j.geo_key, "
            "j.lang_key, j.bgrp, j.status_code, j.dropped, j.served")


async def assert_job_in_scope(conn: AsyncConnection, job_id: uuid.UUID) -> dict[str, Any]:
    """job_id 가 rd.job 에 있고 서버 검수 범위 안이면 그 행. 아니면 404(없음·범위 밖 구분 안 함)."""
    b = Binder()
    where = [f"j.job_id = {b.v(job_id)}", *scope_predicates(b)]
    row = await fetch_one(conn, f"SELECT {JOB_COLS} FROM rd.job j WHERE {' AND '.join(where)}", b.params)
    if row is None:
        raise errors.not_found("검수 대상 없음", code="job_not_found")
    return row


class QaCoords(BaseModel):
    surface: QaSurface
    brand: list[str] = Field(description="rd.job.bgrp 비트의 brand_code 목록(app.brand 정렬 순, 카탈로그 밖이면 빈 목록)")
    country: str | None
    engine: str | None
    lang: str | None


def coords(row: dict[str, Any], refs: QaRefs) -> QaCoords:
    return QaCoords(surface=SURFACE_NAME[int(row["surface"])], brand=refs.brand_codes(int(row["bgrp"])),  # type: ignore[arg-type]
                    country=refs.country_code(int(row["geo_key"])), engine=refs.engine_code(int(row["engine_key"])),
                    lang=refs.lang_code(int(row["lang_key"])))


def as_utc(ts: datetime | None) -> datetime | None:
    return ts.astimezone(UTC) if ts is not None else None


def qa_meta(r: QaResolved | None = None, *, page: Page | None = None) -> Meta:
    """QA 응답 meta(mode='qa'). surface·cycles·generation 은 QA 리소스에 의미가 없어 비운다."""
    m = build_meta(mode="qa", page=page)
    if r is not None:
        m.ignored_filters = list(r.ignored)
        m.dropped_filters = {k: list(v) for k, v in r.dropped.items()}
    return m
