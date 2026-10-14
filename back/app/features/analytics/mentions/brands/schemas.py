"""analytics.mentions.brands 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope(Envelope·Ratio·RankAvg).

비율은 정수 쌍(Ratio)으로만, 평균 순위는 RankAvg(순위 합·순위 있는 답변 수, 순위가 하나도 없으면 null: 0 아님)로 낸다.
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field

from app.core.envelope import RankAvg, Ratio
from app.core.filters import SAFE_TEXT, CommonFilters
from app.features.analytics.mentions.brands.common import INT4_MAX

SortKey = Literal["mentions", "share", "avg_rank"]
Include = Literal["prompts", "multi", "types", "hmg"]
FULL_CAP = 10000         # full=true 전량 모드 상한(경쟁 행 수). 넘으면 data.truncated = true·meta.truncated.brands = true(BG-19).
                         # core 9 U6-3: 2000 → 10000(stg 실측 카탈로그 경쟁 브랜드 4,690, 답변 등장 1,933 = 옛 상한의 97%)


def _none(v: object) -> bool:
    return v is None


class BrandsQuery(CommonFilters):
    """공통 필터 + M-1 추가 파라미터(FastAPI 는 쿼리 모델이 하나일 때만 펼치므로 공통 필터를 상속해 한 모델로 받는다)."""
    top_n: int = Field(10, ge=1, le=100, description="경쟁 브랜드 상위 N(당사 행은 별도로 항상 포함)")
    sort: SortKey = Field("mentions", description="경쟁 행 선택·정렬 기준. rank 는 항상 언급 수 순위")
    brand_key: list[Annotated[int, Field(ge=1, le=INT4_MAX)]] = Field(default_factory=list, max_length=100,
                                                         description="표시 경쟁 브랜드 한정(M-1 응답 brand_key)")
    # ── 값 갭 보강(BG-12~16·19, D13). 전부 선택: 주지 않으면 응답 모양이 이전과 같다 ──
    split_own: bool = Field(False, description="D13: 관점 비트가 둘 이상이면 당사 행을 관점 브랜드별로 가른다(core.measure.split_own_scopes, trend·types 와 같은 판정. "
                                               "행 키 own_brand_code = 비트의 부모 브랜드 코드). 단일 관점이면 가르지 않는다")
    include: list[Include] = Field(default_factory=list, max_length=4,
                                   description="행 보강 필드: prompts(등장 프롬프트 수)·multi(복수 언급 3값)·types(유형 5종, + types_total)·hmg(is_hmg_own)")
    group_by: Literal["engine"] | None = Field(None, description="BG-16: engine 이면 data.by_engine[](엔진별 당사 + 경쟁 상위 top_n). "
                                                                 "std_in 답변이 있는 엔진만(answers 0 블록 없음)")
    q: str | None = Field(None, min_length=1, max_length=100, pattern=SAFE_TEXT,
                          description="BG-19: 경쟁 브랜드 이름 부분 일치(대소문자 무시). 당사 행은 항상 포함, 순위는 전체 기준")
    full: bool = Field(False, description=f"BG-19: 경쟁 행 전량(top_n 무시, 상한 {FULL_CAP}). 상한을 넘으면 data.truncated = true. "
                                          "full=true 응답은 meta.truncated = {brands: bool(, by_engine: bool)} 를 싣는다")
    # ── 계산 생략(B092). 전부 선택: 주지 않으면 응답이 이전과 같다 ──
    include_sentiment: bool = Field(True, description=(
        "false = 감성을 계산하지 않는다: 당사 감성 문장(rd.answer_brand 당사 행 합)을 건너뛰고 모든 행(brands·by_engine[].brands)의 "
        "sentiment 를 0 4개로 둔다. 다른 필드 값은 같다"))
    engine_only: bool = Field(False, description=(
        "group_by=engine 일 때만: true = by_engine 만 계산한다. 전체 창 당사 합계·경쟁 행·당사 감성 문장을 건너뛰고 최상위 "
        "totals·own·brands·types_total 은 빈 창과 같은 값(0, 당사 행만)으로 둔다. by_engine 값은 같다. group_by 가 없으면 효과 없음"))


class Sentiment(BaseModel):
    positive: int
    neutral: int
    mixed: int
    negative: int


class Multi(BaseModel):
    """복수 언급(한 답변 안에서 그 브랜드 언급 2회 이상): 그런 답변의 언급 합·답변 수·고유 프롬프트 수."""
    mentions: int
    answers: int
    prompts: int


class TypeCounts(BaseModel):
    """언급 유형 5종 합(rd.answer_brand t_* 합, 경쟁 행)."""
    mention: int
    recommendation: int
    comparison: int
    definition: int
    final_choice: int


class Totals(BaseModel):
    answers: int = Field(description="M12 모수: std_in 답변 수(노출률 분모)")
    mentions_total: int = Field(description="경쟁 행 언급 합(rd.answer.ment_total 합, 점유율 분모)")
    brand_count: int = Field(description="순위를 매긴 브랜드 수(당사 1 + 경쟁 브랜드)")


class OwnBlock(BaseModel):
    vp_label: str = Field(description="관점 라벨(단일 관점 = brand_code, 다중 = 엄브렐러 brand_code)")
    brands: list[str] = Field(description="관점 브랜드 brand_code 목록")
    rank: int = Field(description="전 브랜드 언급 수 내림차순 순위(동률은 이름 순)")
    mentions: int
    exposure: Ratio = Field(description="M01 노출률: 당사 등장 답변 / 답변")
    share: Ratio = Field(description="M02 점유율: 당사 언급 / 전체 언급")
    avg_rank: RankAvg | None = Field(description="M04(D5) 우선노출도 = 순위 합 / 순위 있는 답변")


class BrandItem(BaseModel):
    brand_key: int | None = Field(description="rd.dim_brand_name 키(M-3 mode=brand 입력). 다중 관점 당사 행은 null")
    name: str
    is_own: bool
    rank: int = Field(description="전 브랜드 언급 수 내림차순 순위(1부터, 동률은 이름 localeCompare 순)")
    mentions: int
    exposure: Ratio = Field(description="브랜드 등장 답변 / 답변(공유 분모)")
    share: Ratio = Field(description="브랜드 언급 / 전체 언급(공유 분모)")
    avg_rank: RankAvg | None
    sentiment: Sentiment
    # ── 선택 필드(요청했을 때만 응답에 나온다) ──
    own_brand_code: str | None = Field(None, exclude_if=_none, description="split_own=true 로 가른 당사 행의 키(D13, 비트의 부모 브랜드 코드). 가르지 않은 행에는 없다")
    is_hmg_own: bool | None = Field(None, exclude_if=_none,
                                    description="include=hmg: HMG 브랜드(rd.dim_brand_name.own_bit ≠ 0, 관점 밖 형제 포함) 여부(BG-15)")
    prompts: int | None = Field(None, exclude_if=_none, description="include=prompts: 이 브랜드가 등장한 고유 프롬프트 수(BG-12)")
    multi: Multi | None = Field(None, exclude_if=_none, description="include=multi: 복수 언급 3값(BG-13)")
    types: TypeCounts | None = Field(None, exclude_if=_none, description="include=types: 브랜드 × 유형 5종(BG-14)")


class EngineBrands(BaseModel):
    """group_by=engine 의 엔진 하나: 그 엔진 답변만으로 센 합계와 당사 + 경쟁 상위 top_n(같은 선택 규칙)."""
    engine: str
    totals: Totals
    brands: list[BrandItem]
    truncated: bool | None = Field(None, exclude_if=_none, description=f"full=true: 이 엔진의 경쟁 행이 상한 {FULL_CAP} 을 넘어 잘렸는가")


class BrandsData(BaseModel):
    totals: Totals
    own: OwnBlock
    brands: list[BrandItem] = Field(description="당사 행(항상) + 경쟁 상위 top_n(sort 기준), sort 순서")
    types_total: TypeCounts | None = Field(None, exclude_if=_none,
                                           description="include=types: 유형별 전 브랜드 합(당사 + 전 경쟁 행, top_n 컷 이전 = 점유율 분모)")
    by_engine: list[EngineBrands] | None = Field(None, exclude_if=_none, description="group_by=engine: 엔진별 스냅샷(엔진 코드 순)")
    truncated: bool | None = Field(None, exclude_if=_none, description=f"full=true: 경쟁 행이 상한 {FULL_CAP} 을 넘어 잘렸는가")
