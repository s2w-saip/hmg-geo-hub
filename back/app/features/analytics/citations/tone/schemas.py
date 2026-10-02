"""analytics.citations.tone 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.core.filters import SAFE_TEXT, CommonFilters
from app.features.analytics.citations.domains.shared import CategoryRef

MAX_TONE_LIMIT = 200


class ToneQuery(CommonFilters):
    """공통 필터(core) + 톤 드릴다운 추가 파라미터(모듈-인용 §2 C-2 /sources/tone)."""
    tone: Literal["positive", "negative"] = Field(description="답변 톤(필수): positive = 관점 sent_pos 합 > sent_neg 합, negative = 반대")
    group_by: Literal["url", "source"] = Field("url", description="url = 인용 URL 별, source = 출처(skey) 별")
    q: str | None = Field(None, max_length=200, pattern=SAFE_TEXT, description="검색어: url 모드 = 화면 표시 URL(스킴·프래그먼트 제거) ILIKE, source 모드 = skey ILIKE")
    limit: int = Field(50, ge=1, le=MAX_TONE_LIMIT)
    cursor: str | None = Field(None, max_length=4096, description="키셋 다음 페이지 커서(meta.page.next_cursor)")
    with_counts: bool = Field(False, description="BG-27 true 면 data.counts(두 톤 탭 카운트 = DISTINCT 인용 URL 수, q 무관)를 함께 낸다")


class ToneRow(BaseModel):
    key: str = Field(description="행 식별자(페이지 안·페이지 사이 유일): url 모드 = url_hash 16진(원본 URL 의 sha256), source 모드 = skey")
    display: str = Field(description="화면 표시 라벨: url 모드 = 표시 URL(스킴·프래그먼트 제거, 서로 다른 행이 같을 수 있다), source 모드 = skey")
    url: str | None = Field(None, description="원본 URL(url 모드만)")
    skey: str = Field(description="출처 그룹 키(드릴다운 /v1/citations/domains/{skey})")
    domain: str
    title: str | None = None
    citations: int
    engines: list[str] = Field(description="인용한 답변의 엔진 코드")
    category: CategoryRef | None
    prompt_text: str | None = Field(None, description="가장 이른 인용(round_date·answer_key·ord 순)의 프롬프트 텍스트")


class ToneCounts(BaseModel):
    """BG-27 탭 카운트(현행 /sources tone.positive·negative.urls 와 같은 값)."""
    positive: int = Field(description="긍정 톤 답변이 인용한 DISTINCT URL 수")
    negative: int = Field(description="부정 톤 답변이 인용한 DISTINCT URL 수")


class ToneData(BaseModel):
    items: list[ToneRow]
    counts: ToneCounts | None = Field(None, description="BG-27 with_counts=true 일 때만")
