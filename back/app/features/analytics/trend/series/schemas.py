"""analytics.trend.series 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

응답 모양(T-1 명세 response, 결정 Q9 반영)
- data.buckets: 원장 자리(R11) 버킷 목록. 버킷 = 회차(round_date) 하나 또는 그 회차들을 주(월요일)·월(1일)로 묶은 것.
  자리 자체가 없는 주·월은 만들지 않는다(없던 주를 채우지 않음).
- data.series[i].points 는 data.buckets 와 같은 순서·같은 길이다(인덱스 정렬). 값은 정수 쌍만 싣는다(P3: 퍼센트는 프론트).
  kind=ratio 면 point.ratio{num,den}, kind=rank 면 point.rank{sum,count}(평균 순위 = sum/count, 낮을수록 좋음).
- gap=true 면 그 지점은 값이 없다(ratio·rank 는 null). gap_reason: no_answer(자리는 있는데 답변 0) · analysis_pending(완료 답변은
  있는데 언급 분석이 아직 없음) · hidden(운영자 숨김으로 이 계열 제외) · collection_error(수집 오류로 숨긴 회차).
  gap=false 인데 ratio 가 null 이면 분모 0(예: 당사 언급이 없어 우호도 분모 0)이다.
- origin(웹사이트 M06·M07 만): report = 리포트 발행값(R09·A5, 프롬프트 단위), live = 측정 단위 라이브 값.

값 갭 보강(BG 라운드, 전부 추가형 선택 필드·파라미터. 기존 필드·의미는 그대로)
- BG-07 dimension=type: 유형 5종(mention·recommendation·comparison·definition·final_choice) 계열(M08 type_exposure).
  point.ratio = {그 유형 신호가 있는 당사 답변, 답변(std_in)}. 유형 판정은 GET /v1/mentions/types(M-2)와 같은 술어.
- BG-09 sentiment(M03) 지점의 negative: 부정 신호 수(분모 = ratio.den 과 같은 톤 전체). 부정률 = negative / ratio.den.
- BG-10 buckets[].measured_days: 버킷 답변(인용 모수 cit_in, 필터 축 적용)의 측정 시각(rd.job.measured_at) KST 고유 일수.
  성능 A1(core 10, 추가형 쿼리 measured_days): 기본 true = 지금처럼 계산, false 면 계산하지 않고 모든 버킷의 measured_days 가 null
  (rd.job 조인 문장을 건너뛴다. 값을 화면에 쓰지 않는 호출용: 쓰는 곳은 KPI 탭 커버리지 라벨뿐, front kpi-view.ts·kpi-trend-chart.tsx).
- BG-11 brand_key[](dimension=brand 전용): 상위 top 밖이어도 그 경쟁 브랜드 계열을 더한다. 경쟁 계열에는 brand_key 를 싣는다.
- D13 split_own=true(dimension=brand 전용): 관점 브랜드가 여럿(관점 비트 둘 이상)이면 합친 'own' 계열 대신 관점 브랜드별 당사 계열
  (key = own_brand_code = 그 브랜드 brand_code, is_own=true, brand_key = 같은 이름의 rd.dim_brand_name 키). 관점이 하나면 기존과 같다(합친 1행).
  행 키 계약: 분리 행의 정본 키는 own_brand_code, mentions 그룹과 잇는 키는 brand_key(둘 다 이름 = brand_code 규칙, 검증 V1).
- P12 B101 dims(선택, 반복): 'dimension[:metric,…][@top]' 항목마다 그 차원을 같은 요청에서 함께 낸다(data.dims[]). 항목 하나의
  {dimension, series, meta} = 같은 필터·bucket·card·measured_days 로 그 차원만 따로 부른 응답의 data.series·meta 와 같다(buckets·own_label 은
  공유). 창·측정 일수는 한 번, (버킷) base 행·인용 계열 자리 유무·출처/카테고리 구성비 문장은 차원 사이에 나눠 쓴다. 생략하면 data.dims 키가 없다.
"""
from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.envelope import Meta, RankAvg, Ratio
from app.core.filters import CommonFilters

INT4_MAX = 2**31 - 1              # rd.dim_brand_name.brand_key int4: 넘는 값은 바인드 전에 422

Bucket = Literal["cycle", "week", "month"]
Dimension = Literal["none", "engine", "brand", "source", "category", "type"]
GapReason = Literal["no_answer", "analysis_pending", "hidden", "collection_error"]
SeriesKind = Literal["ratio", "rank"]


class TrendQuery(CommonFilters):
    """공통 필터 + 추이 전용 파라미터. FastAPI 는 쿼리 모델과 개별 쿼리 파라미터를 한 엔드포인트에 섞지 못해 한 모델로 받는다."""
    bucket: Bucket = Field("cycle", description="버킷 단위. 기본 cycle(회차 자리)")
    dimension: Dimension = Field("none", description="none(지표만)·engine(엔진별)·brand(당사+경쟁)·source·category(인용 구성비)")
    metrics: list[str] = Field(default_factory=list, max_length=20,
                               description="M01~M07 또는 이름(콤마 구분·반복). 없으면 표면 기본 세트(global M01~M05, website·project M01~M07). "
                                           "website·project 는 citation_accuracy(ACC, 인용 정확도 = 타겟∧자사 ÷ 자사 URL 인용 답변, 항상 라이브)를 요청할 때만 받는다")
    top: int = Field(10, ge=1, le=50, description="dimension=brand·source·category 의 상위 계열 수")
    brand_key: list[int] = Field(default_factory=list, max_length=50,
                                 description="BG-11: dimension=brand 에서 상위 top 밖이어도 더할 경쟁 브랜드 키(rd.dim_brand_name.brand_key, 반복)")
    split_own: bool = Field(False, description="D13: dimension=brand 에서 관점 브랜드가 여럿이면 당사를 관점 브랜드별 계열로(기본 false = 합친 1행)")
    measured_days: bool = Field(True, description=(
        "성능 A1(추가형): buckets[].measured_days 계산 여부. 기본 true = 계산(종전과 같다). false 면 계산하지 않고 모든 버킷의 "
        "measured_days 를 null 로 낸다(rd.job 조인 문장 생략). 결과 캐시 키에는 원문 쿼리로 들어간다(선언 파라미터)"))
    dims: list[str] = Field(default_factory=list, max_length=5, description=(
        "P12 B101(추가형): 같은 요청에서 함께 낼 차원(반복). 항목 = 'dimension[:metric,…][@top]'(dimension = none|engine|type|source|category, "
        "metric 은 metrics 와 같은 이름·코드, 생략 = 그 차원 기본 세트, top 생략 = 요청 top). data.dims[] 에 항목 순서로 {dimension, series, meta}: "
        "그 차원만 따로 부른 응답(같은 필터·bucket·card·measured_days)의 series·meta 와 같다. brand 는 dimension 으로만, 차원 중복·형식 오류 422. "
        "생략 = 종전(data.dims 키 없음)"))

    @field_validator("brand_key")
    @classmethod
    def _brand_keys(cls, v: list[int]) -> list[int]:
        if any(k < 1 or k > INT4_MAX for k in v):
            raise ValueError(f"brand_key 범위: 1~{INT4_MAX}")
        return v


class TrendBucket(BaseModel):
    key: date = Field(description="버킷 키: cycle = round_date, week = 그 주 월요일, month = 그 달 1일")
    round_dates: list[date] = Field(description="버킷에 든 원장 자리(회차) round_date 목록(오름차순)")
    measured_days: int | None = Field(None, description="BG-10: 버킷 답변(cit_in, 필터 축 적용)의 측정 시각 KST 고유 일수. 답변 없으면 0. "
                                                          "쿼리 measured_days=false 면 null(계산 안 함, 성능 A1)")


class TrendPoint(BaseModel):
    bucket: date
    ratio: Ratio | None = None
    rank: RankAvg | None = None
    gap: bool = False
    gap_reason: GapReason | None = None
    origin: Literal["report", "live"] | None = Field(None, description="웹사이트 M06·M07 값 출처(R09). 그 밖은 null")
    negative: int | None = Field(None, description="BG-09: sentiment(M03) 지점의 부정 신호 수(분모 = ratio.den). 그 밖 계열·갭은 null")


class TrendSeries(BaseModel):
    metric: str = Field(description="visibility·share_of_voice·sentiment·position·citation_share·target_url_rate·owned_url_rate·"
                                     "citation_accuracy·source_share·category_share·type_exposure")
    code: str | None = Field(None, description="명세 지표 코드 M01~M10(type_exposure = M08), citation_accuracy = ACC")
    kind: SeriesKind
    key: str | None = Field(None, description="차원 값: engine = 엔진 코드(Q9), brand = 'own'(split_own 이면 관점 brand_code) 또는 브랜드명, "
                                              "source = 출처 키, category = 카테고리 slug, type = 유형 키. none 이면 null")
    label: str | None = Field(None, description="표시 이름(brand 당사 = 관점 라벨, source = 도메인, category = 카테고리 이름)")
    is_own: bool | None = Field(None, description="dimension=brand 에서 당사 계열 여부")
    own_brand_code: str | None = Field(None, description="D13 split_own 당사 계열의 관점 브랜드 brand_code(행 키). 합친 'own' 계열·경쟁 계열은 null")
    brand_key: int | None = Field(None, description="BG-11: dimension=brand 경쟁 계열의 rd.dim_brand_name.brand_key. D13 split_own 당사 계열은 "
                                                     "관점 brand_code 와 같은 이름의 키(GET /v1/mentions/brands 당사 행과 같은 규칙, 없으면 null, 검증 V1). "
                                                     "합친 'own' 계열은 null")
    points: list[TrendPoint]


class TrendDimBlock(BaseModel):
    """B101 dims 항목 하나의 결과: 그 차원만 따로 부른 응답의 data.series·meta 와 같다(buckets·own_label 은 TrendData 와 공유)."""
    dimension: Dimension
    series: list[TrendSeries]
    meta: Meta = Field(description="그 차원 단일 요청의 meta(suppressed·ignored_filters 는 그 차원 지표로 판정)")


class TrendData(BaseModel):
    bucket: Bucket
    dimension: Dimension
    own_label: str = Field(description="당사 라벨(BG-48: GET /v1/mentions/brands own.vp_label 과 같은 규칙): 관점 브랜드가 하나면 그 brand_code, "
                                       "둘 이상이면 엄브렐러 brand_code(app.brand, 픽스처·운영 'HMG')")
    buckets: list[TrendBucket]
    series: list[TrendSeries]
    dims: list[TrendDimBlock] | None = Field(None, exclude_if=lambda v: v is None, description=(
        "P12 B101: 쿼리 dims 를 줄 때만 실린다(그 밖 응답에는 키가 없다). 항목 순서 = 쿼리 dims 순서"))
