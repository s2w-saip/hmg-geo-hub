"""analytics.filters.dates 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

- 선택 가능 날짜는 core.cycles.selectable_round_dates 가 낸다: 회차 후보(R01 servable · R03 view_date ≤ 오늘 KST) ∧ R04 계열 숨김 배제
  (core.codes.HIDDEN_EXCLUDE: mentions {1,3} · citations {1,2} · all = any {1,2,3}, Q18)의 DISTINCT round_date 를 DB 에서 내림차순
  MAX_DATES 개로 자른다(website 10배 폭에서도 전송 ≤ 400행). 전체 개수·최초일은 절단과 무관하게 같은 문장이 낸다.
- 표면 경로 게이트(역할 천장 + menu_groups)는 core.filters.resolve_read_context 가 건다.
- 기준일은 family 별이다(모듈-필터 열린 질문 3 의 family 별 안). F-1 스냅샷(meta.as_of)은 core 함대 스냅샷이라 row 계열({1}만 배제)이다.
  그래서 두 값은 "최신 게이트 통과 회차의 hidden_scope 가 그 family 배제 집합 밖일 때"만 같다(검증 M3):
  mentions 는 hidden_scope ∈ {0,2}, citations 는 {0,3}, all 은 {0}. 그 밖에는 F-2 latest_round_date < F-1 as_of 이고,
  hidden_scope = 1 이면 둘 다 직전 회차로 물러나 다시 같다. 불변식은 항상 F-2 latest_round_date ≤ F-1 as_of.
- 기간 프리셋은 현행 presetRange(components/dash/dimension-filter-panel.tsx:1852)의 파이썬 이식이다.
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import Any

from app.core.auth import Principal
from app.core.cycles import RoundDates, selectable_round_dates
from app.core.envelope import Envelope, build_meta
from app.core.filters import CommonFilters, FilterSupport, resolve_read_context
from app.features.analytics.filters.dates.schemas import DateFamily, DatesData, PresetRange

MAX_DATES = 400                     # 현행 scope-answer-anchors.ts:204 MAX_DATES 와 같은 상수(서버가 자른다)
PRESET_ORDER = ("weekly", "biweekly", "monthly", "yearly")   # 현행 TIME_PRESET_ORDER
FAMILY_KEY = {"mentions": "mentions", "citations": "citations", "all": "any"}
# 날짜 축은 값 필터를 받지 않는다(현행 설계: 브랜드·국가를 채우면 필터를 바꿀 때마다 달력이 흔들린다). 기간(from/to)도 옵션 창의 입력이라 무시한다.
DATES_SUPPORT = FilterSupport.of()


def _minus_years(d: date, n: int) -> date:
    """JS Date.setFullYear(y - n) 동작 재현: 없는 날(2/29 → 평년)은 다음 달로 넘긴다(3/1)."""
    y = d.year - n
    last = calendar.monthrange(y, d.month)[1]
    if d.day <= last:
        return d.replace(year=y)
    return date(y, d.month, last) + timedelta(days=d.day - last)


def preset_range(preset: str, end: date, min_day: date | None) -> tuple[date, date]:
    """presetRange 이식: 주 -6일 · 격주 -13일 · 월 -29일 · 년 -1년. min_day 가 시작보다 늦고 끝보다 이르면 시작을 클램프."""
    if preset == "weekly":
        start = end - timedelta(days=6)
    elif preset == "biweekly":
        start = end - timedelta(days=13)
    elif preset == "monthly":
        start = end - timedelta(days=29)
    elif preset == "yearly":
        start = _minus_years(end, 1)
    else:
        raise ValueError(f"알 수 없는 프리셋: {preset}")
    if min_day is not None and start < min_day < end:
        start = min_day
    return start, end


def build_dates(surface: str, rd: RoundDates) -> DatesData:
    """core 선택 가능 날짜(내림차순·절단·전체 개수·최초일) → 응답 data(순수 함수: 절단·프리셋 단위 테스트 대상)."""
    latest = rd.dates[0] if rd.dates else None
    first = rd.first
    presets = []
    if latest is not None:
        for p in PRESET_ORDER:
            f, t = preset_range(p, latest, first)
            presets.append(PresetRange(preset=p, from_=f, to=t))  # type: ignore[arg-type]
    return DatesData(surface=surface, latest_round_date=latest, first_measured_date=first, dates=list(rd.dates[:MAX_DATES]),
                     dates_truncated=rd.total > MAX_DATES, presets=presets)


async def get_dates(conn: Any, principal: Principal, filters: CommonFilters, family: DateFamily,
                    custom_fields: dict[str, list[str]]) -> Envelope[DatesData]:
    ctx = await resolve_read_context(conn, principal, filters, support=DATES_SUPPORT, custom_fields=custom_fields)
    rd = await selectable_round_dates(conn, surface=ctx.surface, project_keys=ctx.project_keys, family=FAMILY_KEY[family], limit=MAX_DATES)
    data = build_dates(ctx.surface, rd)
    meta = build_meta(mode="snapshot", ctx=ctx, generation=rd.generation)
    meta.as_of = data.latest_round_date
    return Envelope[DatesData](data=data, meta=meta)
