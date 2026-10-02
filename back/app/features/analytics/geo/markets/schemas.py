"""analytics.geo.markets 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

응답 모양(GEO-1 명세 response, 결정 Q8 반영)
- data.markets: 관점 브랜드 하나(brand[] 단일 또는 스코프 단일 브랜드)의 RHQ 권역 → 국가 트리. 관점 브랜드가 여럿이면 권역 귀속이
  모호해 markets=[](Q8, 현행 activeBrandFor 규칙). 권역 값은 소속 국가 원시값(분자·분모) 합으로 다시 계산한다(P3, 평균 금지).
- 비율은 정수 쌍 Ratio, M04 는 RankAvg(순위 합·순위 있는 답변 수, 낮을수록 좋음). 분모 0 이면 null.
- surface=website 는 언급 수 지표만(Q8): share_of_voice·rank·top_rival·top_own_brand 만 채우고 나머지 지표는 null(meta.suppressed 에 사유).
- top_rival 은 경쟁사(권한 밖 형제 HMG 브랜드 제외, 브랜드 격리) 중 언급 1위, rank.our 는 당사 합산을 경쟁사들과 언급 수로 비교한 순위.

명세(G-1 response)와 다른 점(검증 D3, README '명세와 다른 점' 표와 같다)
- GeoCountryRow 에 country_name 이 없다: 표시명 원천이 DB 에 없고(rd.dim_country 는 code·kind 만) 현행도 프론트 geoLocateByCode 로 붙인다.
- top_rival 은 {brand, share_of_voice} 가 아니라 {brand, metrics{visibility, share_of_voice, sentiment, position, citation_share}}:
  현행 marketStats 가 경쟁사 지표 묶음을 내고, 비율은 정수 쌍(P3)이라 한 필드로 줄이지 않는다. share_of_voice 는 metrics 안에 있다.
"""
from __future__ import annotations

from pydantic import BaseModel, Field

from app.core.envelope import RankAvg, Ratio


class GeoMetrics(BaseModel):
    visibility: Ratio | None = Field(None, description="M01 노출률 = 당사 등장 답변 / 답변")
    share_of_voice: Ratio | None = Field(None, description="M02 점유율 = 당사 언급 / 시장 전체 언급")
    sentiment: Ratio | None = Field(None, description="M03 우호도 = 긍정 / 톤 전체(A3: mixed 분모 포함)")
    position: RankAvg | None = Field(None, description="M04 우선노출도 = 평균 순위(D5)")
    citation_share: Ratio | None = Field(None, description="M05 인용점유율 = 출처 카테고리 Official (HMG) 인용 / 호스트 있는 인용(글로벌만, "
                                                           "hmg-geo #321)")


class GeoRival(BaseModel):
    brand: str
    metrics: GeoMetrics = Field(description="경쟁사 같은 지표(citation_share 는 도메인→브랜드 매핑이 없어 항상 null)")


class GeoOwnBrand(BaseModel):
    brand: str
    share_of_voice: Ratio | None


class GeoRank(BaseModel):
    our: int = Field(description="당사 순위(1부터). 언급 수가 당사보다 많은 경쟁사 수 + 1")
    field_size: int = Field(description="경쟁사 수 + 1(당사)")


class GeoCountryRow(BaseModel):
    code: str = Field(description="ISO 국가 코드. 표시명(country_name)은 싣지 않는다: 프론트 geoLocateByCode 가 붙인다(검증 D3)")
    answers: int = Field(description="언급 계열 모수 답변 수(std_in)")
    own: GeoMetrics
    rank: GeoRank
    top_own_brand: GeoOwnBrand | None
    top_rival: GeoRival | None


class GeoRegionRow(BaseModel):
    region_id: str
    region_label: str
    country_count: int
    answers: int
    own: GeoMetrics
    rank: GeoRank
    top_own_brand: GeoOwnBrand | None
    top_rival: GeoRival | None
    countries: list[GeoCountryRow] = Field(description="국가 행(당사 점유율 내림차순)")


class GeoData(BaseModel):
    active_brand: str | None = Field(description="권역 그룹핑 기준 관점 브랜드. 없으면 markets=[]")
    own_label: str = Field(description="당사 라벨(BG-48: /v1/mentions/brands own.vp_label 과 같은 규칙). 관점 하나 = brand_code, "
                                       "여럿 = 엄브렐러 brand_code(픽스처·운영 'HMG')")
    markets: list[GeoRegionRow] = Field(description="측정된 권역(당사 점유율 내림차순)")
    pending: list[str] = Field(description="관점 브랜드 권역 중 측정 없는 region_id")
