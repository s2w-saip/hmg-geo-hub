"""analytics.mentions.types 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope. 비율은 Ratio(정수 쌍)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.core.envelope import Ratio
from app.core.filters import CommonFilters

MentionType = Literal["mention", "recommendation", "comparison", "definition", "final_choice"]


def _none(v: object) -> bool:
    return v is None


class TypesQuery(CommonFilters):
    """공통 필터 + M-2 추가 파라미터(FastAPI 쿼리 모델은 하나만 펼치므로 공통 필터를 상속)."""
    split_own: bool = Field(False, description="D13: 다중 관점이면 당사 쪽을 관점 브랜드별로 가른 블록(by_own_brand, 행 키 own_brand_code)을 더한다. "
                                               "mentions/brands·trend 의 split_own 과 같은 공용 판정(core.measure.split_own_scopes)")
    include_stance: bool = Field(True, description=(
        "B093: false = 당사 스탠스(A3) 문장을 돌리지 않고 stance(by_own_brand[].stance 포함)를 null 로 둔다. 다른 필드 값은 같다"))


class TypeRow(BaseModel):
    type: MentionType
    own_mentions: int
    other_mentions: int
    own_answers: int = Field(description="이 유형으로 당사가 언급된 답변 수")
    other_answers: int = Field(description="이 유형으로 비교(경쟁) 브랜드가 언급된 답변 수")
    own_exposure: Ratio = Field(description="M08: own_answers / answers_total")
    other_exposure: Ratio = Field(description="other_answers / answers_total")
    own_share: Ratio = Field(description="own_mentions / (own_mentions + other_mentions)")


class SentimentCell(BaseModel):
    type: MentionType
    scope: Literal["own", "all"]
    rows: int = Field(description="이 유형이 있는 (답변 × 표시 브랜드) 행 수")
    positive: int
    neutral: int
    mixed: int
    negative: int


class StanceCounts(BaseModel):
    positive: int
    neutral: int
    mixed: int
    negative: int
    pairs: int = Field(description="4계열 합 = 당사 (답변 × 엔티티) 대표 턴 쌍 수")


class OwnTypes(BaseModel):
    """split_own 으로 가른 관점 브랜드 하나(D13). 그 비트만 당사로 둔 스코프로 센다: own_* = 그 브랜드, other_* = 그 밖 경쟁 행 전부
    (형제 관점 브랜드 포함). 분모(answers_total)는 합친 관점과 같다. own_mentions·당사 매트릭스 행·스탠스는 가른 블록끼리 더하면
    합친 값과 같고(행 가산), own_answers 는 답변이 여러 브랜드에 걸치면 가산이 아니다."""
    own_brand_code: str = Field(description="관점 브랜드 코드(mentions/brands·trend split_own 행 키와 같다: 그 비트의 부모 브랜드 코드)")
    by_type: list[TypeRow]
    sentiment_matrix: list[SentimentCell]
    stance: StanceCounts | None = Field(description="그 관점 브랜드의 스탠스. include_stance=false 면 null")


class TypesData(BaseModel):
    answers_total: int = Field(description="M08 노출률 분모(std_in 답변 수)")
    by_type: list[TypeRow] = Field(description="유형 5종 고정 순서")
    sentiment_matrix: list[SentimentCell] = Field(
        description="유형 5종 × 스코프(own·all) 10행. 근사: 한 행에 유형이 둘 이상이면 두 유형에 모두 계상되므로 유형 간 합산 금지, 유형 안 구성비로만 읽는다")
    stance: StanceCounts | None = Field(description="A3 당사 스탠스(대표 턴, rd.answer_stance). 창이 비면 0 쌍. include_stance=false 면 null")
    by_own_brand: list[OwnTypes] | None = Field(None, exclude_if=_none,
                                                description="split_own=true 이고 관점 비트가 둘 이상일 때만: 관점 브랜드별 블록(비트 오름차순). 단일 관점이면 []")
