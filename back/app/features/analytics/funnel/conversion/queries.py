"""analytics.funnel.conversion 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

GA4 행(rd.ga4_row)은 Scope 측정 사실 표가 아니다(surface·round_date·cyc_key 없음). 가지치기 술어는 RANGE(date) 파티션 키 date 범위와
PK 선두 (prop_key, report) 등치다. 모든 문장에 prop_key = ANY · report 등치 · date 범위를 건다(실시간 GA4 호출 없음, 적재분만).

GA4 행 역할 규칙(모듈-AI-퍼널 §2.2)
- AI 세션 = report 2(traffic_ai) sessions 합(engine 필터는 여기만), 비AI 세션 = report 1(traffic_total) 의 NOT is_ai 행 sessions 합.
- 전환 = report 3(events) 의 is_conv 행. 속성 conv_basis 1 = key_events, 2 = event_count(적재 판정 열, 조회 시 분기만).
- 페이지 = report 4(landing), page_key 하나로 묶고 FILTER 집계. 세션은 이벤트 차원이 빈 행(event_key 0), 전환은 is_conv 행.
- users_day 는 행 사이로 합하지 않는다(API 규약). 사용자 수는 내지 않는다(G-12 a).
engine·device·nvr 필터 값은 차원 키 배열로 풀어 Binder 로만 넣는다.
"""
from __future__ import annotations

from collections.abc import Sequence
from datetime import date

from app.core.sqlb import Binder, Sql

_CONV = "CASE WHEN p.conv_basis = 2 THEN r.event_count ELSE r.key_events END"
LOOKBACK_DAYS = 400   # 최신 적재일 탐색 창(오늘 KST 기준). 기본 90일 창의 끝을 정하는 데만 쓴다


# 글로벌·웹사이트 표면이 읽는 속성 출처. project_override 는 프로젝트 자체 속성(현행 schema.ts:101-108)이라 프로젝트 표면 몫이다(검증 D2).
MARKET_SOURCES: tuple[str, ...] = ("env", "registry")


def markets_sql() -> Sql:
    """시장 카탈로그 입력: app.ga4_property(관리자 레지스트리) 전 행. 코드 상수 카탈로그와 합치는 것은 앱에서.
    한 시장(브랜드, 국가)에 행이 여럿일 수 있다(DDL 에 UNIQUE 없음): 순서를 고정해 읽고 앱이 상태 우선순위로 하나를 고른다."""
    return Sql("SELECT g.property_id, g.brand_code, g.country_code, g.status FROM app.ga4_property g "
               "WHERE g.brand_code IS NOT NULL AND g.country_code IS NOT NULL ORDER BY g.property_id")


def props_sql() -> Sql:
    """적재 투영 속성(rd.ga4_dim_property) 중 레지스트리·env 출처. 실데이터는 여기 status = active 인 prop_key 로만 읽는다.
    물리 순서에 기대지 않게 prop_key 순으로 읽는다(시장당 선택 규칙은 service.resolve_markets)."""
    b = Binder("m")
    t = ("SELECT p.prop_key, p.property_id, p.brand_bit, p.geo_key, p.status, p.conv_basis FROM rd.ga4_dim_property p "
         f"WHERE p.brand_bit IS NOT NULL AND p.geo_key IS NOT NULL AND p.source = ANY({b.v(list(MARKET_SOURCES), 'text[]')}) "
         "ORDER BY p.prop_key")
    return b.sql(t)


def dim_values_sql(kinds: Sequence[str], values: Sequence[str]) -> Sql:
    b = Binder("v")
    t = ("SELECT v.kind, v.value_key, v.value FROM rd.ga4_dim_value v "
         f"WHERE v.kind = ANY({b.v(sorted(set(kinds)), 'text[]')}) AND v.value = ANY({b.v(sorted(set(values)), 'text[]')})")
    return b.sql(t)


def as_of_sql(props: Sequence[int]) -> Sql:
    """속성별 최신 적재 보고서 날짜(report 1). 오늘(KST) 기준 LOOKBACK_DAYS 창으로 가지치기."""
    b = Binder("a")
    t = ("SELECT r.prop_key, max(r.date) AS as_of FROM rd.ga4_row r\n"
         f" WHERE r.prop_key = ANY({b.ints(props)}) AND r.report = 1\n"
         f"   AND r.date BETWEEN rd.today_kst() - {b.v(LOOKBACK_DAYS, 'int4')} AND rd.today_kst() + 1\n"
         " GROUP BY r.prop_key")
    return b.sql(t)


def _dims(b: Binder, device_keys: Sequence[int] | None, nvr_keys: Sequence[int] | None) -> list[str]:
    w = []
    if device_keys is not None:
        w.append(f"r.device_key = ANY({b.ints(device_keys, 'int4')})")
    if nvr_keys is not None:
        w.append(f"r.nvr_key = ANY({b.ints(nvr_keys, 'int4')})")
    return w


def _sets(cohort: str, detail: bool) -> tuple[str, str]:
    """(g·묶음 열 SELECT 조각, GROUPING SETS). detail=False(B096: 추이·엔진 행을 쓰지 않는 요약·롤업 호출)면 (날짜)·(엔진) 묶음을 빼고
    (속성)·(전체)만 센다. g 값(5 속성, 7 전체)과 date·engine_key 열(NULL)은 detail=True 의 같은 행과 같다."""
    if detail:
        return (f"GROUPING(r.date, r.prop_key, r.engine_key)::int AS g, {cohort}, r.date, r.prop_key, r.engine_key",
                f"({cohort}, r.date), ({cohort}, r.prop_key), ({cohort}, r.engine_key), ({cohort})")
    return (f"CASE WHEN GROUPING(r.prop_key) = 0 THEN 5 ELSE 7 END AS g, {cohort}, NULL::date AS date, r.prop_key, "
            "NULL::int2 AS engine_key", f"({cohort}, r.prop_key), ({cohort})")


def sessions_sql(props: Sequence[int], lo: date, hi: date, *, engine_keys: Sequence[int] | None,
                 device_keys: Sequence[int] | None, nvr_keys: Sequence[int] | None, detail: bool = True) -> Sql:
    """세션: report 2(AI, engine 필터) + report 1 비AI 행. GROUPING SETS (날짜)·(속성)·(엔진)·(전체) × report.
    g = GROUPING(date, prop_key, engine_key): 3 날짜, 5 속성, 6 엔진, 7 전체. detail=False 면 (속성)·(전체)만(_sets)."""
    b = Binder("s")
    w = [f"r.prop_key = ANY({b.ints(props)})", f"r.report = ANY({b.ints((1, 2))})",
         f"r.date BETWEEN {b.date(lo)} AND {b.date(hi)}", "r.event_key = 0", "(r.report = 2 OR NOT r.is_ai)"]
    if engine_keys is not None:
        w.append(f"(r.report = 1 OR r.engine_key = ANY({b.ints(engine_keys)}))")
    w += _dims(b, device_keys, nvr_keys)
    sel, sets = _sets("r.report", detail)
    t = (f"SELECT {sel},\n"
         "       coalesce(sum(r.sessions), 0)::int8 AS sessions, coalesce(sum(r.page_views), 0)::int8 AS page_views\n"
         f"  FROM rd.ga4_row r\n WHERE {' AND '.join(w)}\n"
         f" GROUP BY GROUPING SETS ({sets})")
    return b.sql(t)


def conversions_sql(props: Sequence[int], lo: date, hi: date, *, engine_keys: Sequence[int] | None,
                    device_keys: Sequence[int] | None, nvr_keys: Sequence[int] | None, detail: bool = True) -> Sql:
    """전환: report 3 is_conv 행, 분자 열은 속성 conv_basis. engine 필터는 AI 행에만. g·detail 은 sessions_sql 과 같다."""
    b = Binder("c")
    w = [f"r.prop_key = ANY({b.ints(props)})", "r.report = 3", f"r.date BETWEEN {b.date(lo)} AND {b.date(hi)}", "r.is_conv"]
    if engine_keys is not None:
        w.append(f"(NOT r.is_ai OR r.engine_key = ANY({b.ints(engine_keys)}))")
    w += _dims(b, device_keys, nvr_keys)
    sel, sets = _sets("r.is_ai", detail)
    t = (f"SELECT {sel},\n"
         f"       coalesce(sum({_CONV}), 0)::int8 AS conv\n"
         "  FROM rd.ga4_row r JOIN rd.ga4_dim_property p ON p.prop_key = r.prop_key\n"
         f" WHERE {' AND '.join(w)}\n"
         f" GROUP BY GROUPING SETS ({sets})")
    return b.sql(t)


def pages_sql(props: Sequence[int], lo: date, hi: date, *, engine_keys: Sequence[int] | None,
              device_keys: Sequence[int] | None, nvr_keys: Sequence[int] | None, limit: int) -> Sql:
    """페이지(report 4): page_key 하나로 묶고 코호트별 FILTER. AI 세션 내림차순 상한."""
    b = Binder("p")
    eng = f" AND r.engine_key = ANY({b.ints(engine_keys)})" if engine_keys is not None else ""
    w = [f"r.prop_key = ANY({b.ints(props)})", "r.report = 4", f"r.date BETWEEN {b.date(lo)} AND {b.date(hi)}"]
    w += _dims(b, device_keys, nvr_keys)
    t = ("WITH pg AS (\n"
         "  SELECT r.page_key,\n"
         f"         coalesce(sum(r.sessions) FILTER (WHERE r.is_ai AND r.event_key = 0{eng}), 0)::int8 AS ai_sessions,\n"
         f"         coalesce(sum({_CONV}) FILTER (WHERE r.is_ai AND r.is_conv{eng}), 0)::int8 AS ai_conversions,\n"
         "         coalesce(sum(r.sessions) FILTER (WHERE NOT r.is_ai AND r.event_key = 0), 0)::int8 AS human_sessions,\n"
         f"         coalesce(sum({_CONV}) FILTER (WHERE NOT r.is_ai AND r.is_conv), 0)::int8 AS human_conversions\n"
         "    FROM rd.ga4_row r JOIN rd.ga4_dim_property p ON p.prop_key = r.prop_key\n"
         f"   WHERE {' AND '.join(w)}\n"
         "   GROUP BY r.page_key)\n"
         "SELECT coalesce(v.value, '') AS url, pg.ai_sessions, pg.ai_conversions, pg.human_sessions, pg.human_conversions\n"
         "  FROM pg LEFT JOIN rd.ga4_dim_value v ON v.kind = 'page' AND v.value_key = pg.page_key\n"
         f" ORDER BY pg.ai_sessions DESC, pg.human_sessions DESC, url\n LIMIT {b.v(int(limit), 'int4')}")
    return b.sql(t)


# ── 프로젝트 표면(BG-28)·전환 이벤트(BG-29) ──
def project_property_sql(project_id: object) -> Sql:
    """고객 프로젝트 직접 지정 속성(app.project.ga4_property_id). 멤버십·가시성은 core.resolve_project 가 이미 판정했다."""
    b = Binder("j")
    return b.sql(f"SELECT p.ga4_property_id FROM app.project p WHERE p.project_id = {b.v(project_id, 'uuid')}")


def props_by_id_sql(property_ids: Sequence[str]) -> Sql:
    """속성 id → 적재 투영(출처 무관: 프로젝트 직접 지정 속성은 source = project_override). 없으면 행 없음."""
    b = Binder("i")
    t = ("SELECT p.prop_key, p.property_id, p.brand_bit, p.geo_key, p.status, p.conv_basis, p.source FROM rd.ga4_dim_property p "
         f"WHERE p.property_id = ANY({b.v(sorted(set(property_ids)), 'text[]')}) ORDER BY p.prop_key")
    return b.sql(t)


def registry_by_id_sql(property_ids: Sequence[str]) -> Sql:
    """속성 id → 관리자 레지스트리 행(app.ga4_property, 매핑 없는 행 포함)."""
    b = Binder("g")
    t = ("SELECT g.property_id, g.brand_code, g.country_code, g.status FROM app.ga4_property g "
         f"WHERE g.property_id = ANY({b.v(sorted(set(property_ids)), 'text[]')}) ORDER BY g.property_id")
    return b.sql(t)


def engine_sessions_sql(props: Sequence[int], lo: date, hi: date, *, device_keys: Sequence[int] | None,
                        nvr_keys: Sequence[int] | None) -> Sql:
    """엔진 비교용 AI 세션(report 2, BG-31): engine[] 을 걸지 않는다(기기·신규재방문·속성·기간은 건다)."""
    b = Binder("e")
    w = [f"r.prop_key = ANY({b.ints(props)})", "r.report = 2", f"r.date BETWEEN {b.date(lo)} AND {b.date(hi)}", "r.event_key = 0"]
    w += _dims(b, device_keys, nvr_keys)
    t = ("SELECT r.engine_key, coalesce(sum(r.sessions), 0)::int8 AS sessions\n"
         f"  FROM rd.ga4_row r\n WHERE {' AND '.join(w)}\n GROUP BY r.engine_key")
    return b.sql(t)


def engine_conversions_sql(props: Sequence[int], lo: date, hi: date, *, device_keys: Sequence[int] | None,
                           nvr_keys: Sequence[int] | None) -> Sql:
    """엔진 비교용 AI 전환(report 3 is_conv ∧ is_ai, BG-31): engine[] 을 걸지 않는다. 분자 열은 속성 conv_basis."""
    b = Binder("f")
    w = [f"r.prop_key = ANY({b.ints(props)})", "r.report = 3", f"r.date BETWEEN {b.date(lo)} AND {b.date(hi)}", "r.is_conv", "r.is_ai"]
    w += _dims(b, device_keys, nvr_keys)
    t = (f"SELECT r.engine_key, coalesce(sum({_CONV}), 0)::int8 AS conv\n"
         "  FROM rd.ga4_row r JOIN rd.ga4_dim_property p ON p.prop_key = r.prop_key\n"
         f" WHERE {' AND '.join(w)}\n GROUP BY r.engine_key")
    return b.sql(t)
