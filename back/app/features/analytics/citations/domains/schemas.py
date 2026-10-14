"""analytics.citations.domains 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, ValidationInfo, field_validator

from app.core.envelope import Ratio
from app.core.filters import SAFE_TEXT, CommonFilters
from app.features.analytics.citations.domains.shared import CategoryRef

# 모듈-인용 §2 PageIn: limit 1~200(0 은 요약 전용). core.pagination.MAX_LIMIT(500) 보다 좁다(톤 드릴다운과 같은 상한).
MAX_DOMAINS_LIMIT = 200
MENTION_BRAND_MAX_LIMIT = 2000  # mention_brand(언급 드릴다운 인용 탭) 한 번 조회 상한 = 어댑터 종전 커서 상한(10페이지 × 200). 페이지마다 문장이
                                # 대상 전체를 다시 접던 순차 10회를 한 요청으로(B009)
Q_MAX = 200                 # 검색어 길이 상한(프롬프트·톤 검색과 같다)
SKEY_MAX_ITEMS = 100        # skey[] 선택 상한(BG-20 경쟁사 도메인 선택: 현행 옵션 수보다 넉넉하게)
SKEY_MAX_LEN = 512          # 도메인 드릴다운 경로 skey 와 같은 길이 상한
COMPETITOR_SOURCES_MAX = 5000  # BG-20 경쟁사 도메인 옵션 상한(현행은 전 도메인 중 공식(경쟁사) 전부). core 9 U7-2: 500 → 5000
                               # (stg 실측 단일 프로젝트 최대 900, p95 약 81, 카탈로그 전체 1,172). 넘으면 meta.truncated.competitor_sources
EXPORT_MAX_ROWS = 5000      # BG-22 내보내기 행 상한(현행 슬리밍 상한 1,500~2,000 행보다 넉넉하게, 넘으면 X-Export-Truncated)

# BG-21 정렬 키(현행 표 SortKey: domain·citations·share·prompts·coverageRate). share·coverage 는 표시값(반올림 퍼센트) 기준(검증 D3).
DomainSort = Literal["citations", "share", "coverage", "prompts", "skey"]
SkeyValue = Annotated[str, StringConstraints(min_length=1, max_length=SKEY_MAX_LEN, pattern=SAFE_TEXT)]


class DomainsListParams(CommonFilters):
    """공통 필터(core) + 도메인 순위 모집단·검색·정렬 파라미터(목록·내보내기 공용)."""
    mention_brand: str | None = Field(None, min_length=1, max_length=100, pattern=SAFE_TEXT, description="표시 브랜드명: 이 브랜드가 std_in 언급된 답변의 인용만")
    q: str | None = Field(None, max_length=Q_MAX, pattern=SAFE_TEXT,
                          description="BG-21 검색어: skey 부분 일치(대소문자 무시, 와일드카드는 글자 그대로). 행·meta.page.total(limit=0 포함)만 좁히고 요약·경쟁사 합은 그대로")
    sort: DomainSort = Field("citations", description="BG-21 정렬 기준(동률은 인용 순위 rank 오름차순). share·coverage 는 표시값 = 반올림 퍼센트(소수 1자리, 0.5 올림) "
                                                               "기준이라 표시값이 같은 행은 rank 순(현행 표 pctOf 비교와 같다)")
    dir: Literal["asc", "desc"] | None = Field(None, description="정렬 방향. 기본: skey = asc, 그 밖 = desc")
    skey: list[SkeyValue] = Field(default_factory=list, max_length=SKEY_MAX_ITEMS,
                                  description="BG-20 출처 그룹 키 선택(반복, 집합 의미: 순서·중복 무관, 커서도 같다): 이 출처 행만. "
                                              "요약·경쟁사 합·share·coverage 분모는 전체 모집단 그대로")
    competitor: list[SkeyValue] = Field(default_factory=list, max_length=SKEY_MAX_ITEMS,
                                        description="BG-20 경쟁사 선택(반복, 현행 ?competitor= = applyCompetitorPick): 유효 카테고리가 공식(경쟁사)인 행 중 "
                                                    "이 skey 만 남기고 다른 카테고리 행은 그대로. rank 는 선택 뒤 번호. 요약·경쟁사 합·옵션·분모는 그대로")
    host_fold: bool = Field(False, description="대시보드 도메인 목록(현행 프로필 domains_card_by_host 가 켜졌을 때만 효과): 공식 소셜 계정 그룹 키를 그 "
                                               "도메인 행에 합친 도메인(호스트) 단위. card=true 이면 이 값과 무관하게 접는다(현행 대시보드 카드 = 도메인 축). "
                                               "기간이 걸려 card 를 보내지 않는 대시보드 호출이 쓴다. 인용 화면 도메인 표는 보내지 않는다(그룹 키 단위)")


class DomainsQuery(DomainsListParams):
    """C-1 목록 파라미터. FastAPI 쿼리 모델은 다른 쿼리 인자와 섞을 수 없어 상속으로 합친다."""
    limit: int = Field(50, ge=0, le=MENTION_BRAND_MAX_LIMIT,
                       description=f"순위 행 수(0~{MAX_DOMAINS_LIMIT}, 0 = 요약·경쟁사 합만, meta.page.total 은 그대로 좁힌 행 수). "
                                   f"mention_brand 가 있으면 {MENTION_BRAND_MAX_LIMIT} 까지(언급 드릴다운 한 번 조회), 없이 넘으면 422")
    cursor: str | None = Field(None, max_length=4096, description="키셋 다음 페이지 커서(meta.page.next_cursor)")
    competitor_sources: bool = Field(False, description=f"BG-20: 공식(경쟁사) 카테고리 출처 전부(인용 수 내림차순, 상한 {COMPETITOR_SOURCES_MAX})를 "
                                                        "data.competitor_sources 로 함께 낸다(경쟁사 선택 옵션). q·skey 와 무관. "
                                                        "true 면 meta.truncated.competitor_sources = 상한에서 잘렸는가. card=true·limit=0(대시보드 카드: "
                                                        "출처를 브랜드로 접어 값을 낸다)은 상한 없이 전부(현행과 같은 값, 잘림 false)")
    include_den: bool = Field(True, description="false 면 커버리지 분모 문장을 생략한다: summary.answers_den = 0, 행 coverage.den = 0(coverage·분모를 "
                                                "읽지 않는 호출용). sort=coverage 는 정렬 키가 분모를 써서 그대로 센다")
    include_competitor_totals: bool = Field(True, description="false 면 경쟁사 브랜드별 합을 계산하지 않는다(competitor_totals = 빈 목록, 읽지 않는 호출용)")

    @field_validator("limit")
    @classmethod
    def _limit(cls, v: int, info: ValidationInfo) -> int:
        # mention_brand(DomainsListParams)는 limit 보다 먼저 검증된다: 오류 위치는 limit 그대로(D4 회귀와 같은 loc)
        if v > MAX_DOMAINS_LIMIT and info.data.get("mention_brand") is None:
            raise ValueError(f"limit > {MAX_DOMAINS_LIMIT} 는 mention_brand 와 함께만(최대 {MENTION_BRAND_MAX_LIMIT})")
        return v


class DomainsExportQuery(DomainsListParams):
    """BG-22 도메인 순위 내보내기: 목록과 같은 모집단·검색·정렬·선택, 전량(상한 EXPORT_MAX_ROWS, max_rows 로 더 좁힘)."""
    format: Literal["xlsx", "csv"] = Field("xlsx", description="파일 형식")
    locale: Literal["ko", "en"] = Field("ko", description="열 이름·카테고리 표시 언어(현행 화면 문구와 같다)")
    rank_basis: Literal["global", "match"] | None = Field(
        None, description="'#' 열 기준. global = rank(경쟁사 선택 뒤·검색 전 번호, 현행 표준 표), match = match_rank(검색·선택 뒤 번호, "
                          "현행 웹사이트·프로젝트 표). 기본: surface=global 이면 global, website·project 면 match(표면별 현행 규칙)")
    max_rows: int | None = Field(None, ge=1, le=EXPORT_MAX_ROWS,
                                 description="정렬 뒤 상위 N 행만(현행 표준 표 내보내기 = 상위 100, DOMAIN_RANK_LIMIT). 이 값으로 자른 것은 "
                                             "X-Export-Truncated 로 알리지 않는다(서버 상한으로 잘릴 때만)")


class DomainsSummary(BaseModel):
    total_citations: int = Field(description="인용 수(cit_in ∧ 호스트 있는 인용, source[] 반영)")
    unique_sources: int = Field(description="고유 출처 수(출처 그룹 키 skey: 도메인 또는 공식 소셜 계정)")
    own_share: Ratio = Field(description="M05 인용 점유율 = 자사 판정 인용 / 전체 인용(분모 0 이면 den 0)")
    answers_den: int = Field(description="커버리지 분모 = 같은 필터의 cit_in 답변 수(source[] 는 답변 축이 아니라 걸지 않는다)")


class DomainRow(BaseModel):
    skey: str = Field(description="출처 그룹 키(드릴다운 경로 /v1/citations/domains/{skey})")
    domain: str = Field(description="표시 도메인")
    is_social: bool = Field(description="공식 소셜 계정 키(host+path) 여부")
    category: CategoryRef | None
    citations: int
    share: Ratio = Field(description="이 출처 인용 / 전체 인용")
    citing_answers: int = Field(description="이 출처를 인용한 답변 수")
    coverage: Ratio = Field(description="citing_answers / answers_den")
    own_citations: int = Field(description="자사 판정 인용 수(표면별 own_expr)")
    is_own: bool = Field(description="자사 판정 인용이 1건 이상")
    is_target: bool = Field(description="타겟 URL 인용이 1건 이상(website·project 에서 의미)")
    competitor_brand: str | None = Field(None, description="공식 경쟁사 도메인이면 경쟁 브랜드 표시명")
    citing_prompts: int | None = Field(None, description="BG-24 이 출처를 인용한 프롬프트 수(DISTINCT 프롬프트, 현행 표 '프롬프트' 열)")
    rank: int | None = Field(None, description="BG-21 인용 순위(1부터, 인용 수 내림차순·skey 오름차순). competitor[] 선택 뒤·q·skey[]·정렬 전 "
                                               "모집단 기준 = 현행 표준 표 '#'(applyCompetitorPick 뒤 번호, 검색 전)")
    match_rank: int | None = Field(None, description="BG-21 검색·선택 뒤 인용 순위(1부터): competitor[]·q·skey[] 를 모두 적용한 행 안의 번호, "
                                                     "정렬과 무관 = 현행 웹사이트·프로젝트 표 '#'(검색 뒤 번호)")


class CompetitorTotal(BaseModel):
    brand: str
    citations: int
    sources: int


class CompetitorSource(BaseModel):
    """BG-20 경쟁사 선택 옵션 1행: 유효 카테고리(오버라이드 반영)가 공식(경쟁사)인 출처."""
    skey: str = Field(description="출처 그룹 키(선택 값 = skey[] 로 되돌려 보낸다)")
    domain: str
    brand: str | None = Field(None, description="경쟁 브랜드 표시명(적재기 판정, 오버라이드가 카테고리를 바꾼 출처는 null)")
    citations: int


class DomainsData(BaseModel):
    summary: DomainsSummary
    items: list[DomainRow] = Field(description="출처 순위(기본 인용 수 내림차순, skey 오름차순). limit=0 이면 빈 목록")
    competitor_totals: list[CompetitorTotal] = Field(description="경쟁 브랜드별 공식 도메인 인용 합(인용 수 내림차순)")
    competitor_sources: list[CompetitorSource] | None = Field(None, description="BG-20 competitor_sources=true 일 때만: 공식(경쟁사) 출처 목록")
