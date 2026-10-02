"""대시보드 카드 경로 엔드포인트 목록(동결 스냅샷 층 S0, 제품 결정 31). front 가 card=true(lib/hgh/query.ts cardParam) 또는
host_fold=true 를 보내는 호출과 1:1 이다(tests/core/test_card_routes.py 가 front 어댑터 소스와 양방향 대조).

현행(hmg-geo 2670a16 + read_screens 14키)에서 이 호출들의 리더는 집계층(summary_* 생성 시점 표)이었다. 동결 스냅샷 층(frz)은 이 목록의
요청만 동결 회차 값을 읽는다(S3, notes/hgh-impl/wu12/card-snapshot-design.md 3·8장). frozen = 그 요청을 동결 층이 맡는지:
- citations/domains 는 기간 없는 카드(card=true)만 현행 집계층이고, 기간이 걸리면 현행도 미러라 front 는 card 대신 host_fold 만 보낸다
  (front adapters/dashboard.ts domainsCard). host_fold 요청은 동결 대상이 아니다.
- kpi/engines 는 웹사이트 배지(S4.subkpi)만 카드 경로다(글로벌 배지는 S2.mention = 14키 밖 = 미러).
표준 라이브러리만 쓴다.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CardRoute:
    params: tuple[str, ...]      # front 가 보내는 카드 경로 파라미터(card·host_fold)
    surfaces: tuple[str, ...]    # 카드 경로 표면(cardParam 은 project 에 보내지 않는다)
    frozen: bool                 # 동결 스냅샷 층이 맡는 요청인가(card=true 일 때)
    front: str                   # front 호출 함수(lib/hgh/adapters)
    legacy: str                  # 현행 리더(2670a16 lib/scope/server.ts·summary 리더)


CARD_ROUTES: dict[str, CardRoute] = {
    "/v1/kpi/summary": CardRoute(("card",), ("global", "website"), True, "summary.ts fetchKpiSummary",
                                 "global S1.dashboard viaGlobalS1(server.ts:2101-2122), website S4.dashboard viaTrend(:5165-5176)"),
    "/v1/mentions/brands": CardRoute(("card",), ("global", "website"), True, "dashboard.ts fetchCardBrands",
                                     "global S1 aggregates.brands·S1.competitors(:2120, :4124-4150), website S4 카드 read(:5165)"),
    "/v1/trend": CardRoute(("card",), ("global", "website"), True, "trend.ts fetchTrend",
                           "global S1.dashboard viaGlobalSeries(:2170, :2972-3041), website websiteTrendSet(:5186-5212)"),
    "/v1/geo": CardRoute(("card",), ("global", "website"), True, "dashboard.ts fetchGeo",
                         "global S1.dashboard viaGlobalS1(:4359-4373), website S4.dashboard viaTrend(:5284-5294)"),
    "/v1/kpi/engines": CardRoute(("card",), ("website",), True, "dashboard.ts fetchEngineRows",
                                 "website 배지 S4.subkpi viaTrend(:5228-5250). 글로벌 배지는 S2.mention(14키 밖 = 미러)"),
    "/v1/citations/domains": CardRoute(("card", "host_fold"), ("global", "website"), True, "dashboard.ts fetchDashboardDomains",
                                       "기간 없음: global S3.citation viaGlobalTrend(:4332-4347), website S6.citation viaTrend(:5274-5282). "
                                       "기간 있음 = 미러(host_fold 만, 동결 대상 아님)"),
    "/v1/kpi/compare": CardRoute(("card",), ("global", "website"), True, "compare.ts fetchPeriodCompareView",
                                 "readComparePeriods(summary-period-compare.ts:218-236·300-324) 전 화면"),
}


def card_pairs() -> frozenset[tuple[str, str]]:
    """(경로, 파라미터) 쌍 집합: front 대조 시험의 정본."""
    return frozenset((path, p) for path, r in CARD_ROUTES.items() for p in r.params)
