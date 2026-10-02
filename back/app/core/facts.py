"""사실 표 이름 자리(동결 스냅샷 층 S0, 제품 결정 31). core·analytics 의 사실 표 SQL 은 표 이름을 여기서만 받는다.

왜: 대시보드 카드 경로(요청 card=true)는 현행(hmg-geo 2670a16 + read_screens 14키)처럼 회차 생성(발행) 시점에 고정한 값을 읽어야 한다
(notes/hgh-impl/wu12/card-snapshot-design.md). 고정 값은 rd 사실 표와 같은 열을 가진 동결 층(frz 스키마)에 담고, 읽기는 같은 SQL 에서
표 이름만 바꾼다. 그 치환이 한 곳에서 일어나도록 표 이름을 이 자리로 모은다.

S3(DB-v2.23)·S4(DB-v2.24): 카드 요청(MeasureScope.card = core.card_routes 의 card=true 요청) ∧ 현행 프로필 freeze_at_publish ∧ global·website
∧ 창 판정 통과(MeasureScope.frz_ok)면 카드 읽기 뷰(frz.card_*: 동결 회차 = 동결 셀·보관 행·in_full_cycle 셀·동결 카탈로그 비트)를 돌려준다.
글로벌 추이 격자(MeasureScope.frz_grid, 현행 X.trendGrid)는 in_full_cycle 게이트가 없는 frz.grid_* 를 쓴다. 스위치가 꺼져 있거나 카드가 아니면
LIVE(도입 전과 바이트 같다).
- 창 판정(S4, core.cycles.frz_judge → core.filters.ReadContext.card_window): 창 회차에 세대 없는 발행 회차(구멍)가 있으면 현행처럼 요청 전체를
  미러로(lib/summary/read/cycle-set.ts:336-357·400-401) = 허브는 그 요청을 card=False 로 내려 비카드 경로로 처음부터 푼다. 그래서 카드 뷰에는
  비동결 회차 갈래가 없다(P126). 기간 비교는 현행처럼 구멍을 누락 비중으로 센다(폴백 없음, 값 = 동결 회차만).
- answer_stance·prompt 자리는 동결 대상이 아니다(카드 경로 7개는 스탠스를 읽지 않는다: 스탠스 문장은 analytics.mentions.types 뿐. 프롬프트 차원
  판정은 동결 카탈로그 비트가 사실 행 bgrp 로 들어간다: core.measure.catalog_all_pred 의 동결 분기). 생성 시점 판정 중 사실 행 열이 아닌 것은
  옆 표로 읽는다(S4): 웹 보고 유닛·⑥ 유닛 플래그·URL 인용률 job 플래그 = frz.card_web, 택소노미 축 = frz.card_axis, 브랜드 표시명 =
  frz.card_brand_name(core.measure unit_gate_of·accuracy_counts_sql·frozen_taxon_pred·frozen_brand_names).

규약
- 자리는 rd.answer·rd.answer_brand·rd.answer_stance·rd.citation·rd.dim_prompt 다섯이다(카드 경로가 읽는 사실·프롬프트 차원).
  그 밖의 rd 표(rd.job·rd.cycle·rd.dim_*·rd.web_report_prompt·rd.report_unit_value·rd.acr_*)는 동결 대상이 아니라 그대로 쓴다.
- 인자 ms(core.measure.MeasureScope) 는 S3 의 판정 입력(card·profile·창)이다. 스코프가 없는 호출(답변 상세처럼 키로 찾는 문서형 읽기)은
  fact_tables() 를 인자 없이 부른다 = 늘 LIVE.
- 표준 라이브러리만 쓴다(core.measure 빌더를 대조 러너가 재사용).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class FactTables:
    answer: str
    answer_brand: str
    answer_stance: str
    citation: str
    prompt: str


LIVE = FactTables(answer="rd.answer", answer_brand="rd.answer_brand", answer_stance="rd.answer_stance",
                  citation="rd.citation", prompt="rd.dim_prompt")
CARD = FactTables(answer="frz.card_answer", answer_brand="frz.card_answer_brand", answer_stance="rd.answer_stance",
                  citation="frz.card_citation", prompt="rd.dim_prompt")
# 웹 카드 읽기 뷰(DB-v2.24 P127): 카드 뷰 열 + 웹 셀 판정 6열(unit_in·unit_owned·unit_target·url_registered·url_owned_hit·url_target_hit)
CARD_WEB = FactTables(answer="frz.card_answer_w", answer_brand="frz.card_answer_brand_w", answer_stance="rd.answer_stance",
                      citation="frz.card_citation_w", prompt="rd.dim_prompt")
GRID = FactTables(answer="frz.grid_answer", answer_brand="frz.grid_answer_brand", answer_stance="rd.answer_stance",
                  citation="frz.grid_citation", prompt="rd.dim_prompt")


def frozen_read(ms: Any) -> bool:
    """이 스코프가 동결 층을 읽나: 카드 요청 ∧ freeze_at_publish ∧ global·website ∧ 창 판정 통과(MeasureScope.frz_ok).
    frz_ok 는 ReadContext.card_window(창 해석 → core.cycles 동결 판정)가 세운다: 창 회차에 세대 없는 회차(구멍)가 없을 때만 참이고,
    구멍이 있으면 그 요청은 card=False 로 내려가 처음부터 비카드(현행 미러 폴백 대응) 경로를 탄다(S4)."""
    return (ms is not None and bool(getattr(ms, "card", False)) and bool(ms.profile.freeze_at_publish) and ms.sf in (1, 2)
            and bool(getattr(ms, "frz_ok", False)))


def fact_tables(ms: Any = None) -> FactTables:
    """이 읽기가 쓸 사실 표 이름. 동결 읽기(frozen_read)면 카드 뷰(글로벌 추이 격자 = 격자 뷰, website = 웹 카드 읽기 뷰), 그 밖 LIVE."""
    if not frozen_read(ms):
        return LIVE
    if getattr(ms, "frz_grid", False):
        return GRID
    return CARD_WEB if ms.sf == 2 else CARD
