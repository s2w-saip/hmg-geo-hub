"""analytics.answers.list 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

요청 = 공통 필터(CommonFilters) + 이 기능의 추가 축(모듈-답변-드릴다운 §3.1). CommonFilters 를 상속해 한 query parameter model 로 받는다.
응답 행의 공개 id 는 job_id(uuid)다. answer_key·cyc_key·geo_key 같은 내부 정수 키는 싣지 않는다(core.envelope 규칙, 모듈 결정 1).
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.core.filters import CommonFilters

Signal = Literal["positive", "neutral", "mixed", "negative", "mention", "recommendation", "comparison", "definition", "final_choice"]
Collapse = Literal["none", "cell"]
_TEXT_RE = re.compile(r"^[^\x00-\x1f\x7f]+$")
MAX_LIMIT = 200


class AnswerListQuery(CommonFilters):
    """공통 필터 + 답변 목록 추가 축. 리스트 축은 같은 이름을 반복해 보낸다."""
    prompt_id: uuid.UUID | None = Field(None, description="특정 프롬프트 1건으로 좁힘(collapse=cell 필수 입력)")
    mention_brand: str | None = Field(None, min_length=1, max_length=100, description="이 브랜드(rd.dim_brand_name.name)가 언급된 답변만")
    signal: Signal | None = Field(None, description="당사(관점 브랜드) 언급 행의 해당 감성·유형 수가 1 이상인 답변만")
    domain: str | None = Field(None, min_length=1, max_length=253, description="이 도메인(rd.dim_source.domain)이 인용된 답변만")
    q: str | None = Field(None, min_length=2, max_length=200, description="프롬프트 텍스트 부분 일치")
    include_gap: bool = Field(False, description="true 면 언급 분석 결손(analysis_state ≥ 2) 답변도 포함(모수 cit_in)")
    collapse: Collapse = Field("none", description="cell = (엔진, 국가) 셀마다 최신 측정 1건 + runs(반복 수). prompt_id 필수")
    cursor: str | None = Field(None, max_length=4096, description="이전 응답 meta.page.next_cursor")
    limit: int = Field(50, ge=1, le=MAX_LIMIT)

    @model_validator(mode="after")
    def _check_extra(self) -> AnswerListQuery:
        for name in ("mention_brand", "domain", "q"):
            v = getattr(self, name)
            if v is not None and not _TEXT_RE.match(v):
                raise ValueError(f"{name} 값 형식 오류")
        if self.collapse == "cell" and self.prompt_id is None:
            raise ValueError("collapse=cell 은 prompt_id 필수")
        return self


class PromptRef(BaseModel):
    prompt_id: uuid.UUID
    text: str | None = None


class OwnMention(BaseModel):
    count: int = Field(description="관점 브랜드 언급 수 합(rd.answer ment_h·k·g 중 관점 비트분)")
    rank: int | None = Field(None, description="관점 브랜드 순위(다중 관점이면 0 을 뺀 최솟값), 없으면 null")


class RowMentions(BaseModel):
    total: int
    own: OwnMention


class RowCitations(BaseModel):
    has_cit: bool
    tgt_cited: bool
    own_url_cited: bool


class BrandSentiment(BaseModel):
    pos: int
    neu: int
    neg: int
    mix: int


class BrandTypes(BaseModel):
    mention: int
    recommendation: int
    comparison: int
    definition: int
    final_choice: int


class MatchedBrand(BaseModel):
    name: str
    mention_count: int
    rank: int | None = None
    sentiment: BrandSentiment
    types: BrandTypes


class MatchedDomain(BaseModel):
    domain: str
    citations: int


class AnswerRow(BaseModel):
    id: uuid.UUID = Field(description="job_id. 상세 GET /v1/answers/{job_id} 에 그대로 전달")
    round_date: date
    anchor_date: date
    measured_at: datetime | None = None
    prompt: PromptRef
    engine: str
    country: str | None = None
    lang: str | None = None
    is_rep: bool
    is_acr: bool
    acr_iter_rank: int
    gap: bool
    mentions: RowMentions | None = Field(None, description="언급 계열 숨김 회차이거나 분석 결손(gap)이면 null")
    citations: RowCitations | None = Field(None, description="인용 계열 숨김 회차면 null")
    matched_brand: MatchedBrand | None = None
    matched_domain: MatchedDomain | None = None
    runs: int | None = Field(None, description="collapse=cell 일 때 그 셀의 측정 수")


class AnswerListData(BaseModel):
    items: list[AnswerRow]             # 이 페이지가 훑은 round_date 창은 meta.page.window_from·window_to(core Page, 기간 모드 92일 조각)
