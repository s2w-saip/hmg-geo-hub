"""analytics.citations.prompts 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

응답 형태(C-3 명세 response 를 core.envelope 규칙에 맞춘 것)
- data.items[]  : 프롬프트 행(버킷 하나의 키셋 페이지). 내부 정수 키(prompt_key·answer_key·engine_key·geo_key)는 싣지 않는다.
- data.counts   : 현재 필터 창의 두 버킷 프롬프트 수(owned = 자사 인용 있음, uncited = 인용은 있으나 자사 0). q 와 무관한 탭 카운트.
- meta.page     : next_cursor·limit·total(total = 요청 버킷에서 q 를 적용한 행 수).
"""
from __future__ import annotations

import uuid

from pydantic import BaseModel, Field

from app.core.envelope import ListData
from app.core.filters import CommonFilters

ANSWER_SAMPLE_MAX = 8       # 행당 답변 표본 상한(현행 CITATION_SPLIT_REFS = 8, scope-aggregates.ts:5288)
DEFAULT_LIMIT = 50          # 현행 pageSize 기본값(aggregateCitationOwnedPromptsFromMirror)
MAX_LIMIT = 200             # 현행 pageSize 상한 계승(C-3 extra_params)
Q_MAX = 200                 # 검색어 길이 상한


class PromptsQuery(CommonFilters):
    """공통 필터 + C-3 추가 파라미터(owned·q·limit·cursor). FastAPI 쿼리 모델은 다른 쿼리 인자와 섞을 수 없어 한 모델로 합친다."""
    owned: bool = Field(description="true = 자사 인용 버킷, false = 자사 미인용(인용은 있으나 자사 0) 버킷")
    q: str | None = Field(None, max_length=Q_MAX, description="프롬프트 텍스트 부분 일치(대소문자 무시, 와일드카드는 글자 그대로)")
    limit: int = Field(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT)
    cursor: str | None = Field(None, max_length=4096, description="이전 응답 meta.page.next_cursor")

    def common(self) -> CommonFilters:
        """추가 파라미터를 뺀 공통 필터(커서 필터 해시 입력)."""
        return CommonFilters.model_validate(self.model_dump(by_alias=True, exclude={"owned", "q", "limit", "cursor"}))


class AnswerRef(BaseModel):
    """행 하나의 답변 표본(현행 citationAnswerRef: jobId·provider·region·mentionCount=이 답변의 인용 수)."""
    job_id: uuid.UUID
    provider: str = Field(description="엔진 코드(chatgpt·gemini 등). 표시 라벨은 프론트 어댑터가 바꾼다")
    region: str | None = Field(description="답변 국가 코드(가상 지역 포함 원래 표기)")
    citations_in_answer: int = Field(description="이 답변의 호스트 있는 인용 수(cit_in 모수)")


class PromptRow(BaseModel):
    prompt_id: uuid.UUID
    text: str
    funnel: str | None = Field(description="퍼널 코드(rd.dim_prompt.funnel_key → rd.dim_taxon). 없으면 null")
    citations: int = Field(description="창 안 이 프롬프트 답변들의 호스트 있는 인용 수 합")
    providers: list[str] = Field(description="인용이 있는 답변의 엔진 코드(정렬)")
    answers: list[AnswerRef] = Field(description=f"인용 수 내림차순·job_id 오름차순 상위 {ANSWER_SAMPLE_MAX}건")


class PromptCounts(BaseModel):
    owned: int = Field(description="자사 인용이 1건 이상인 프롬프트 수")
    uncited: int = Field(description="인용은 있으나 자사 인용이 0인 프롬프트 수")


class CitationPromptsData(ListData[PromptRow]):
    counts: PromptCounts
