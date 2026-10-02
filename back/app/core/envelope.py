"""응답 봉투 {data, meta}, Ratio{num, den}, RankAvg{sum, count}.

규칙(전체-통합 §5 core.envelope)
- 비율은 정수 쌍 Ratio 로만 낸다(pct 는 프론트, P3). 평균 순위는 RankAvg.
- 목록은 data.items, 페이지 정보는 meta.page 로 통일한다.
- suppressed 는 {지표 키: 사유 코드} dict. 응답 전체 억제는 '*' 키(source_pending·no_active_snapshot). 사유 코드는 아래 SUPPRESS_* 상수만
  쓴다(기능마다 다른 코드를 쓰면 프론트가 사유별 분기를 둘로 둔다). 창에서 나오는 사유는 window_suppression(win, family) 이 판정한다.
- 내부 정수 키(cyc_key·geo_key·brand_bit·answer_key)는 어떤 필드에도 싣지 않는다. cycles 는 round_date 목록.
- Meta 확장 규약: 모드·기능별 부가 meta 는 Meta 를 상속한 타입 모델로 더한다(예 CompareMeta(Meta): compare 필드). 자유 dict(extra)는
  두지 않는다(OpenAPI 스키마가 타입을 잃는다). 공통 필드로 올릴 값은 이 파일에서만 더한다.
- Page.window_from·window_to: 기간 창을 조각으로 걷는 목록(AN-1 92일 조각)이 이 페이지가 훑은 round_date 창을 알린다(값이 없으면 직렬화에서 빠진다).
"""
from __future__ import annotations

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field

Mode = Literal["snapshot", "cumulative", "catalog", "audit", "qa", "admin", "crud", "external", "session"]

# 억제 사유 코드(meta.suppressed 값). 응답 전체는 '*' 키
SUPPRESS_NO_SNAPSHOT = "no_active_snapshot"     # 스냅샷 창에 노출 회차 없음
SUPPRESS_HIDDEN = "hidden"                      # 창 회차가 그 계열에서 전부 숨김(core.cycles.Window.hidden)
SUPPRESS_PARTIAL_HIDDEN = "partial_hidden"      # 창 회차 일부만 그 계열에서 숨김(남은 회차 값만 나온다는 고지)
SUPPRESS_NO_DATA = "no_data"                    # 창은 있으나 분모 0(측정 대기)
SUPPRESS_UNSUPPORTED = "unsupported"            # 이 표면·축 조합에서 정의되지 않는 지표
SUPPRESS_SOURCE_PENDING = "source_pending"      # 외부 원천(GA4·ext) 준비 전
SUPPRESS_NO_PREV = "no_prev"                    # 비교 직전 구간 없음(K-2)
SUPPRESS_CODES = frozenset({SUPPRESS_NO_SNAPSHOT, SUPPRESS_HIDDEN, SUPPRESS_PARTIAL_HIDDEN, SUPPRESS_NO_DATA, SUPPRESS_UNSUPPORTED,
                            SUPPRESS_SOURCE_PENDING, SUPPRESS_NO_PREV})


class Ratio(BaseModel):
    num: int
    den: int


class RankAvg(BaseModel):
    sum: int = Field(description="순위 합(낮을수록 좋음)")
    count: int = Field(description="순위 있는 답변 수")


class UrlPromptCounts(BaseModel):
    """웹사이트 자사·타겟 URL 인용률의 프롬프트 단위 모수(제품 결정 6, DC-02 현행 문구 유지: '자사/타겟 URL 인용 프롬프트 ÷ 측정 프롬프트').
    타겟 URL 인용률 = target_prompts / measured_prompts, 자사 URL 인용률 = owned_prompts / measured_prompts(두 카드 공통 분모, 퍼센트는 프론트).
    발행 회차(R09)면 발행 프롬프트 합(현행 publishedSubtotal), 라이브면 측정 프롬프트 중 타겟·자사 URL 인용 답변이 하나라도 있는 프롬프트 수
    (현행 aggregateWebsiteTargetHitRate). 기존 측정 단위 Ratio(target_url_rate·owned_url_rate)는 그대로 둔다(추가형)."""
    measured_prompts: int = Field(description="측정 프롬프트 수(웹 등록 프롬프트 중 창 안 인용 모수 답변이 있는 서로 다른 프롬프트)")
    target_prompts: int = Field(description="그중 지정 타겟 URL 이 인용된 프롬프트 수")
    owned_prompts: int = Field(description="그중 자사 URL(선언 base ∪ 타겟)이 인용된 프롬프트 수(라이브는 자사 ⊇ 타겟이라 ≥ target_prompts)")


class Page(BaseModel):
    next_cursor: str | None = None
    limit: int
    total: int | None = None
    # 창 조각 목록(AN-1)만 싣는다. 값이 없으면 직렬화에서 빠진다(그 밖 목록의 meta.page 모양은 그대로)
    window_from: date | None = Field(None, exclude_if=lambda v: v is None, description="이 페이지가 훑은 round_date 창 시작(기간 조각 목록만)")
    window_to: date | None = Field(None, exclude_if=lambda v: v is None, description="이 페이지가 훑은 round_date 창 끝(기간 조각 목록만)")


class Meta(BaseModel):
    surface: str | None = None
    mode: Mode
    as_of: date | None = None
    cycles: list[date] = Field(default_factory=list)
    generation: int | None = None
    ignored_filters: list[str] = Field(default_factory=list)
    dropped_filters: dict[str, list[str]] = Field(default_factory=dict)
    suppressed: dict[str, str] = Field(default_factory=dict)
    source: dict[str, Any] | None = None
    page: Page | None = None
    missing_projects: list[str] | None = None
    truncated: dict[str, bool] | None = Field(
        None, exclude_if=lambda v: v is None,
        description="상한이 있는 목록을 요청했을 때만 실린다(그 밖 응답에는 키가 없다). 키 = data 의 목록 필드 이름, 값 = 서버 상한에서 "
                    "잘렸는가(true 면 목록이 전량이 아니다). 상한 값은 각 엔드포인트 매개변수 설명에 있다")


class Envelope[T](BaseModel):
    data: T
    meta: Meta


class ListData[T](BaseModel):
    items: list[T]


def ratio(num: int | None, den: int | None) -> Ratio:
    return Ratio(num=int(num or 0), den=int(den or 0))


def ratio_or_none(num: int | None, den: int | None) -> Ratio | None:
    """분모 0 이면 None(지표 없음). 억제 사유는 호출자가 meta.suppressed 에 적는다."""
    if not den:
        return None
    return Ratio(num=int(num or 0), den=int(den))


def rank_avg_or_none(total: int | None, count: int | None) -> RankAvg | None:
    if not count:
        return None
    return RankAvg(sum=int(total or 0), count=int(count))


def window_suppression(win: Any, family: str, *, partial: bool = False) -> str | None:
    """창에서 나오는 억제 사유(core.cycles.Window). 스냅샷에 노출 회차 없음 = no_active_snapshot, 창 회차가 계열에서 전부 숨김 = hidden,
    partial=True 이면 일부만 숨김 = partial_hidden(계열 술어가 걸린 목록처럼 남은 회차만 나올 때). 해당 없음 = None."""
    if win.mode == "snapshot" and win.lo is None:
        return SUPPRESS_NO_SNAPSHOT
    if win.hidden(family):
        return SUPPRESS_HIDDEN
    if partial and win.partially_hidden(family):
        return SUPPRESS_PARTIAL_HIDDEN
    return None


def build_meta(*, mode: Mode, surface: str | None = None, window: Any = None, ctx: Any = None, generation: int | None = None,
               suppressed: dict[str, str] | None = None, source: dict[str, Any] | None = None, page: Page | None = None,
               truncated: dict[str, bool] | None = None) -> Meta:
    """ReadContext(ctx)·Window(window) 에서 meta 를 채운다(둘 다 선택). 명시 인자가 우선한다."""
    m = Meta(mode=mode, surface=surface)
    if ctx is not None:
        m.surface = m.surface or ctx.surface
        m.ignored_filters = list(ctx.ignored_filters)
        m.dropped_filters = {k: list(v) for k, v in ctx.dropped_filters.items()}
    if window is not None:
        m.surface = m.surface or window.surface
        m.as_of = window.as_of
        m.cycles = list(window.round_dates)
        m.generation = window.generation
        if window.missing_project_ids:
            m.missing_projects = list(window.missing_project_ids)
    if generation is not None:
        m.generation = generation
    if suppressed:
        m.suppressed.update(suppressed)
    if source is not None:
        m.source = source
    if page is not None:
        m.page = page
    if truncated is not None:
        m.truncated = dict(truncated)
    return m


def crud_meta(query_params: Any = None, *, mode: Mode = "crud", surface: str | None = None, page: Page | None = None,
              source: dict[str, Any] | None = None, support: Any = None, consumed: Any = (), extra_supported: Any = ()) -> Meta:
    """CommonFilters 를 받지 않는 엔드포인트(CRUD·관리·세션·적재 운영)의 meta: 분석 필드는 비우고, 들어온 공통 필터 축을
    ignored_filters 로 드러낸다(core.filters.ignored_axes: support·consumed·extra_supported 는 그 함수와 같은 뜻)."""
    m = build_meta(mode=mode, surface=surface, page=page, source=source)
    if query_params is not None:
        from app.core.filters import ignored_axes
        m.ignored_filters = ignored_axes(query_params, support, surface, consumed=consumed, extra_supported=extra_supported)
    return m


def envelope(data: Any, meta: Meta) -> dict[str, Any]:
    """response_model 이 있는 라우터는 Envelope[T](data=..., meta=...) 를 그대로 반환해도 된다. 이 함수는 dict 가 필요할 때만."""
    d = data.model_dump(mode="json") if isinstance(data, BaseModel) else data
    return {"data": d, "meta": meta.model_dump(mode="json")}
