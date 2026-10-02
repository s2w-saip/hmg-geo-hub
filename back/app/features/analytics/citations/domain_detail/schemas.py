"""analytics.citations.domain_detail 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

from pydantic import BaseModel, Field

from app.core.filters import SAFE_TEXT, CommonFilters
from app.features.analytics.citations.domain_detail.queries import PROMPTS_PER_SOURCE, REFS_PER_PROMPT, URLS_PER_SOURCE
from app.features.analytics.citations.domains.shared import AnswerRef, CategoryRef

# BG-25 긴 꼬리 상한(요청 하나의 답변 참조 행 ≤ 프롬프트 100 × 참조 20 = 2,000, rd.job PK 조회는 자른 뒤에만)
MAX_URLS = 200
MAX_PROMPTS = 100
MAX_ANSWERS = 20


class DomainDetailQuery(CommonFilters):
    """공통 필터(core) + 드릴다운 추가 파라미터(C-1 도메인 순위와 같은 모집단)."""
    mention_brand: str | None = Field(None, min_length=1, max_length=100, pattern=SAFE_TEXT, description="표시 브랜드명: 이 브랜드가 std_in 언급된 답변의 인용만")
    urls_limit: int = Field(URLS_PER_SOURCE, ge=1, le=MAX_URLS, description="BG-25 인용 URL 행 수(기본 = 현행 10)")
    prompts_limit: int = Field(PROMPTS_PER_SOURCE, ge=1, le=MAX_PROMPTS, description="BG-25 프롬프트 행 수(기본 = 현행 12)")
    answers_limit: int = Field(REFS_PER_PROMPT, ge=1, le=MAX_ANSWERS, description="BG-25 프롬프트당 답변 참조 수(기본 = 현행 8)")


class SourceInfo(BaseModel):
    skey: str
    domain: str
    is_social: bool
    category: CategoryRef | None
    competitor_brand: str | None = None


class DetailUrl(BaseModel):
    url: str
    title: str | None
    citations: int
    engines: list[str] = Field(description="이 URL 을 인용한 답변의 엔진 코드")
    country: str | None = Field(None, description="자사 공식 URL 이면 그 owned base 의 국가(app.owned_base.geo_code), 아니면 null")
    prompt_text: str | None = Field(None, description="BG-23 이 URL 의 가장 이른 인용(round_date·answer_key·ord 순)의 프롬프트 텍스트")


class DetailPrompt(BaseModel):
    prompt_id: str
    text: str | None
    funnel: str | None
    citations: int = Field(description="이 프롬프트의 답변이 이 출처를 인용한 수")
    own_citations: int = Field(description="그중 자사 판정 인용 수(표면별 own_expr)")
    engines: list[str]
    answers: list[AnswerRef] = Field(description="답변 참조 상위 answers_limit(기본 8, 인용 수 내림차순, 동률은 적재 답변 키 오름차순)")


class DomainDetailData(BaseModel):
    source: SourceInfo
    citations: int = Field(description="이 출처 인용 수(같은 필터·창)")
    own_citations: int
    urls: list[DetailUrl] = Field(description="인용 URL 상위 urls_limit(기본 10, 인용 수 내림차순)")
    prompts: list[DetailPrompt] = Field(description="프롬프트 상위 prompts_limit(기본 12, 인용 수 내림차순, prompt_id 오름차순)")
    url_total: int | None = Field(None, description="BG-25 자르기 전 인용 URL 수(같은 필터·창)")
    prompt_total: int | None = Field(None, description="BG-25 자르기 전 인용 프롬프트 수(같은 필터·창)")
