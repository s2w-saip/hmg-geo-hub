"""analytics.mentions.prompts 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope(목록 = data.items, 페이지 = meta.page)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator

from app.core.envelope import Ratio
from app.core.filters import SAFE_TEXT, CommonFilters
from app.features.analytics.mentions.brands.common import INT4_MAX

Mode = Literal["brand", "signal"]
SignalKey = Literal["positive", "neutral", "negative", "mixed", "mention", "recommendation", "comparison", "definition", "final_choice"]


TERMS_MAX_REFS = 1000    # terms=true 일 때 언급 원본 뷰를 한 문장에 읽는 answer_key 수 상한(넘으면 배치로 나눠 읽는다, service.list_prompts)
PAGE_MAX_LIMIT = 200     # 프롬프트 페이지 크기 상한(brand_key·signal 타깃)
DRILLDOWN_MAX_LIMIT = 2000   # BG-17 드릴다운 타깃(mention_brand·own) 한 번 조회 상한 = 어댑터 종전 커서 상한(10페이지 × 200). 페이지마다
                             # page_sql 이 대상 전체를 다시 접던 순차 10회를 한 요청으로(terms 는 TERMS_MAX_REFS 배치라 곱 제약 없음)


def _none(v: object) -> bool:
    return v is None


class PromptsQuery(CommonFilters):
    """공통 필터 + M-3 추가 파라미터(FastAPI 쿼리 모델은 하나만 펼치므로 공통 필터를 상속)."""
    mode: Mode = Field(description="brand = 특정 브랜드가 언급된 프롬프트, signal = 당사 언급에 신호가 발생한 프롬프트")
    brand_key: int | None = Field(None, ge=1, le=INT4_MAX, description="mode=brand 타깃(셋 중 하나): M-1 응답의 brand_key(int4). mode=signal 과 함께면 422")
    mention_brand: str | None = Field(None, min_length=1, max_length=100, pattern=SAFE_TEXT,
                                      description="mode=brand 타깃(셋 중 하나, BG-17): 표시 브랜드명(rd.dim_brand_name.name, 없으면 bare 소문자). 없으면 404")
    own: bool = Field(False, description="mode=brand 타깃(셋 중 하나, BG-17): 당사(관점 브랜드) 행. 다중 관점이면 관점 비트 전체")
    own_brand_code: str | None = Field(None, min_length=1, max_length=50, pattern=SAFE_TEXT,
                                       description="own=true 일 때 관점 브랜드 하나로 좁힘. 받는 값 = D13 split_own 행 키(own_brand_code, 관점 비트가 "
                                                   "둘 이상일 때 비트별 부모 브랜드 코드). 브랜드 코드가 아니면 422, 그 밖 코드(관점 밖·하위 브랜드·단일 관점)는 빈 목록")
    terms: bool = Field(False, description="BG-18: 답변 참조마다 하이라이트 표기(terms{brand,model}) 동봉. model = 롤업 연결만(현행과 같다). "
                                              "mode=signal 은 현행에 없는 확장")
    signal: SignalKey | None = Field(None, description="mode=signal 필수: 감성 4종·유형 5종")
    limit: int = Field(50, ge=1, le=DRILLDOWN_MAX_LIMIT,
                       description=f"프롬프트 페이지 크기(1~{PAGE_MAX_LIMIT}). mode=brand 의 드릴다운 타깃(mention_brand·own)은 {DRILLDOWN_MAX_LIMIT} 까지"
                                   "(언급 드릴다운이 한 요청으로 끝까지 읽는다), 그 밖 타깃이 넘으면 422")
    cursor: str | None = Field(None, max_length=4096, description="이전 응답 meta.page.next_cursor 그대로")
    answers_limit: int = Field(6, ge=1, le=50, description="프롬프트당 답변(job) 참조 상한(셀 대표 기준)")
    lite: bool = Field(False, description="mode=signal 전용(그 밖 mode 와 함께면 422): 답변 참조의 runs·position·measured_at 을 내지 않는다(null). "
                                          "신호 다이얼로그가 쓰지 않는 열이다. 프롬프트·값·share·대표 답변 선택(job_id)은 같다")

    @field_validator("limit")
    @classmethod
    def _limit(cls, v: int, info: ValidationInfo) -> int:
        # mode·mention_brand·own 은 limit 보다 먼저 검증된다: 오류 위치는 limit 그대로
        d = info.data
        if v > PAGE_MAX_LIMIT and not (d.get("mode") == "brand" and (d.get("mention_brand") is not None or d.get("own"))):
            raise ValueError(f"limit > {PAGE_MAX_LIMIT} 는 mode=brand 의 mention_brand·own 타깃만(최대 {DRILLDOWN_MAX_LIMIT})")
        return v

    @model_validator(mode="after")
    def _target(self) -> PromptsQuery:
        if self.mode == "brand":
            n = sum((self.brand_key is not None, self.mention_brand is not None, self.own))
            if n != 1:
                raise ValueError("mode=brand 는 brand_key·mention_brand·own 중 정확히 하나")
        if self.lite and self.mode != "signal":
            raise ValueError("lite 는 mode=signal 과 함께만")
        if self.own_brand_code is not None and not (self.mode == "brand" and self.own):
            raise ValueError("own_brand_code 는 mode=brand·own=true 와 함께만")
        if self.mode == "signal" and (self.own or self.mention_brand is not None or self.brand_key is not None):
            raise ValueError("brand_key·own·mention_brand 는 mode=brand 타깃이다(mode=signal 과 함께 줄 수 없다)")
        if self.mode == "signal" and self.signal is None:
            raise ValueError("mode=signal 은 signal 필수")
        return self


class Target(BaseModel):
    brand_key: int | None = None
    name: str | None = None
    signal: SignalKey | None = None
    own: bool | None = Field(None, exclude_if=_none, description="당사 타깃(own=true)일 때만 true")
    own_brand_code: str | None = Field(None, exclude_if=_none, description="own_brand_code 로 좁혔을 때 그 코드")


class Terms(BaseModel):
    """모달 원문 하이라이트 표기(현행 highlightTermsForBrand): brand = 타깃 브랜드 표시명·표면 표기, model = 타깃 브랜드로 접히는
    비브랜드 엔티티(모델 등) 표시명·표면 표기. 2자 미만 제외, 중복 제거, brand 에 있는 표기는 model 에서 뺀다."""
    brand: list[str]
    model: list[str]


class AnswerRef(BaseModel):
    job_id: uuid.UUID
    engine: str
    region: str | None
    value: int = Field(description="이 답변의 타깃 값(brand = 언급 수, signal = 신호 열 합)")
    position: int | None = Field(description="답변 내 브랜드 등장 순위(rk, 0 은 null). lite 면 null")
    measured_at: datetime | None = Field(description="대표 답변 측정 시각. lite 면 null")
    runs: int | None = Field(description="같은 (프롬프트, 엔진, 국가) 셀의 타깃 답변 수(대표 1건으로 접힘). lite 면 null")
    terms: Terms | None = Field(None, exclude_if=_none, description="terms=true 일 때 이 답변의 하이라이트 표기(BG-18)")


class PromptItem(BaseModel):
    prompt_id: uuid.UUID
    prompt_text: str | None
    funnel_code: str | None
    count: int = Field(description="brand = 그 브랜드 경쟁 행 mention_count 합, signal = 당사 행 신호 열 합")
    share: Ratio = Field(description="count / total(같은 필터·타깃의 전 프롬프트 합)")
    providers: list[str] = Field(description="타깃이 나온 엔진 코드")
    answers: list[AnswerRef]


class PromptsData(BaseModel):
    mode: Mode
    target: Target
    total: int = Field(description="전 프롬프트 count 합(share 분모)")
    items: list[PromptItem]
