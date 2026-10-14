"""analytics.kpi.summary 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

비율은 정수 쌍(Ratio{num, den}, P3)만 낸다. pct 는 프론트가 만든다. 분모 0·숨김·표면 밖이면 null 이고 사유는 meta.suppressed.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

from app.core.envelope import Meta, RankAvg, Ratio, UrlPromptCounts
from app.core.filters import CommonFilters

UNMEASURED_LIMIT_MAX = 200          # BG-04 미측정 목록 상한(현행 listUnmeasuredPromptsFromCatalog 기본 200)
# K-1 선택 부분(B089). ①~⑤·params.answers·measured_by_funnel 은 늘 계산한다
SummaryPart = Literal["measured", "applied", "gap", "urls"]
SUMMARY_OPTIONAL_PARTS: tuple[str, ...] = ("measured", "applied", "gap", "urls")


class SnapshotQuery(CommonFilters):
    """공통 필터 + 스냅샷 오프셋. FastAPI 쿼리 모델은 다른 쿼리 인자와 섞으면 한 필드로 취급되므로 상속으로 합친다."""
    cycle_offset: int = Field(0, ge=0, le=1, description="스냅샷 전용: 0 최신 노출 회차, 1 직전(기간 모드에서 1 이면 ignored_filters)")


class SummaryQuery(SnapshotQuery):
    """K-1 쿼리 = 공통 필터 + cycle_offset + 선택 분해(BG-08) + 선택 부분(B089)."""
    by_funnel: bool = Field(False, description="true 면 params.measured_by_funnel(퍼널 주제별 측정 프롬프트 수)을 채운다(BG-08)")
    parts: list[SummaryPart] = Field(default_factory=list, max_length=4, description=(
        "계산할 선택 부분(B089). 비우면 전부(종전과 같은 응답). measured = params.measured_prompts·prompts_without_brand"
        "(측정 프롬프트 count DISTINCT 문장), applied = params.applied_prompts(적용 프롬프트 문장), gap = analysis_gap(A16 열), "
        "urls = target_url_rate·owned_url_rate·citation_accuracy·url_prompts·meta.source(URL 인용률 문장). 빠진 부분은 값 null 이고 "
        "meta.suppressed 에도 적지 않는다(null 자체가 '요청하지 않음'). ①~⑤·params.answers·measured_by_funnel·나머지 값은 부분과 무관하게 같다"))


class UnmeasuredQuery(SnapshotQuery):
    """BG-04 미측정 목록 쿼리 = 공통 필터 + cycle_offset + limit(상한 200)."""
    limit: int = Field(UNMEASURED_LIMIT_MAX, ge=1, le=UNMEASURED_LIMIT_MAX, description=f"행 상한(1~{UNMEASURED_LIMIT_MAX}, 기본 {UNMEASURED_LIMIT_MAX})")


class FunnelPrompts(BaseModel):
    """퍼널 주제 하나의 측정 프롬프트 수(현행 PromptTopicSlice {topic, prompts}, scope-aggregates.ts:3510)."""
    funnel: str | None = Field(description="퍼널 코드(rd.dim_prompt.funnel_key → rd.dim_taxon). null = 미분류")
    measured_prompts: int = Field(description="그 퍼널의 측정 프롬프트 수. 합 = params.measured_prompts")


class SummaryParams(BaseModel):
    """M12 모수. prompts_without_brand 는 세 표면 모두(BG-06: 측정 프롬프트 중 관점 브랜드 미언급)."""
    answers: int = Field(description="std_in 답변 수(가산)")
    measured_prompts: int | None = Field(description="std_in 답변의 서로 다른 프롬프트 수(비가산). parts 에 measured 가 없으면 null")
    applied_prompts: int | None = Field(description="적용 프롬프트 수(카탈로그·웹 등록·프로젝트 프롬프트, 측정 무관). parts 에 applied 가 없으면 null")
    prompts_without_brand: int | None = Field(None, description="measured_prompts − 관점 브랜드 언급 프롬프트 수(세 표면, BG-06). "
                                                                "숨김·노출 회차 없음이면 null")
    measured_by_funnel: list[FunnelPrompts] | None = Field(None, description="by_funnel=true 일 때만: 퍼널 주제별 측정 프롬프트 수"
                                                                             "(측정 수 내림차순, 같으면 코드순, 미분류 끝). 그 밖은 null(BG-08)")


class AnalysisGap(BaseModel):
    """A16 분석 결손: 인용 모수(cit_in) 중 언급 분석이 없는 답변(gap). 비율은 프론트가 gap_answers / base_answers 로 낸다."""
    gap_answers: int
    base_answers: int


class SummaryData(BaseModel):
    visibility: Ratio | None = Field(description="M01 노출률 = 관점 브랜드 등장 답변 / std_in 답변")
    share_of_voice: Ratio | None = Field(description="M02 점유율 = 관점 브랜드 언급 / 전체 언급")
    sentiment: Ratio | None = Field(description="M03 우호도 = 관점 긍정 / 관점 감성 채점(A3 혼합 포함)")
    position: RankAvg | None = Field(description="M04 우선 노출도 = 순위 합 / 순위 있는 답변 수(D5)")
    citation_share: Ratio | None = Field(description="M05 인용 점유율 = 분자 / 전체 인용(cit_in, 호스트 있는 인용). 분자: global = 출처 카테고리 "
                                                     "Official (HMG) 인용 수(hmg-geo #320), website·project = 표면 자사 인용 수")
    target_url_rate: Ratio | None = Field(description="M06 타겟 URL 인용률(website·project). 웹사이트 발행 회차는 R09 발행값")
    owned_url_rate: Ratio | None = Field(description="M07 자사 URL 인용률(website·project). 웹사이트 발행 회차는 R09 발행값")
    citation_accuracy: Ratio | None = Field(description="인용 정확도 = M06 분자 / M07 분자(website·project)")
    url_prompts: UrlPromptCounts | None = Field(None, description=(
        "결정 6(DC-02 현행 문구): 웹사이트 자사·타겟 URL 인용률의 프롬프트 단위 모수(website 만, 추가형). 출처는 target_url_rate 와 같다"
        "(meta.source.url_rates report = 발행 프롬프트 합, live = 측정 프롬프트 중 인용 프롬프트). 표면 밖 not_website_surface·숨김 hidden·"
        "측정 프롬프트 0 no_data 면 null(meta.suppressed 'url_prompts')"))
    params: SummaryParams
    analysis_gap: AnalysisGap | None = Field(description="A16 결손 쌍. parts 에 gap 이 없으면 null")


class UnmeasuredPrompt(BaseModel):
    """미측정 프롬프트 한 행(현행 UnmeasuredPrompt {id, text, listType, depth1, depth2, funnelStage}, scope-aggregates.ts:6162).
    프롬프트 키 하나에 한 행(적용 카운트와 같은 단위). 속성은 대표 원본 행(global = 루트 카탈로그 행, project = 프로젝트 프롬프트)."""
    prompt_id: uuid.UUID = Field(description="global = 카탈로그 행 id(app.prompt), project = 프로젝트 프롬프트 id, website = Scope 프롬프트 id")
    scope_prompt_id: uuid.UUID = Field(description="Scope 프롬프트 id(rd.dim_prompt.prompt_id)")
    text: str | None
    list_type: str | None = None
    depth1: str | None = None
    depth2: str | None = None
    funnel_stage: str | None = None


# ── meta.source 명명 스키마(fe-u4 요청 1·2, core 9라운드) ─────────────────────────────────────────────
# 뒤 6개 = 현행 프로필 web_url_rate(A2, WU-7) 사유(core R09_*: 현행 resolveReportTruthRoute·decidePublishedSelection 사유와 대응)
UrlRatesReason = Literal["not_website", "engine_axis", "period_range", "empty_window", "no_publication",
                         "unsupported_axis", "period_open_ended", "scope_narrower", "brand_not_in_publication", "vocabulary_split",
                         "no_published_sites"]


class PublicationDetail(BaseModel):
    """합산에 들어간 발행물 한 건(BG-26). 목록 순서 = 카드 라벨 규칙 순서(SummarySource.cycle_label 이 첫 원소)."""
    slug: str
    cycle_label: str | None = None
    cycle_label_en: str | None = None
    round_date: date


class SummarySource(BaseModel):
    """K-1 meta.source: 웹사이트·프로젝트 표면 URL 인용률(M06·M07)의 출처. 다른 표면(global)은 meta.source 가 null.
    report 필드(round_date·site_count·publication_details·cycle_label·cycle_label_en)는 url_rates = report 일 때만 값이 있다."""
    url_rates: Literal["report", "live"] = Field(description="report = R09 발행값, live = 측정 라이브 값")
    reason: UrlRatesReason | None = Field(None, description="라이브 사유(core R09_*). 발행값이면 null")
    publications: list[str] = Field(default_factory=list, description="합산에 들어간 발행물 slug(순서 = publication_details 와 같다)")
    round_date: date | None = Field(None, description="발행 회차(report 만)")
    site_count: int | None = Field(None, description="합산에 실제로 들어간 발행 유닛 수(헤드라인 풀 규칙 뒤, 현행 publishedSubtotal.siteCount)")
    publication_details: list[PublicationDetail] = Field(default_factory=list)
    cycle_label: str | None = Field(None, description="카드 발행 라벨(= publication_details 첫 원소, 규칙은 publication_details 순서)")
    cycle_label_en: str | None = None


class SummaryMeta(Meta):
    source: SummarySource | None = None     # type: ignore[assignment]


class SummaryResponse(BaseModel):
    data: SummaryData
    meta: SummaryMeta
