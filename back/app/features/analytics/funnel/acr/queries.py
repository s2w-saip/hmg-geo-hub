"""analytics.funnel.acr 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

모든 문장은 같은 셀 선택 머리(cells CTE)를 쓴다(모듈-AI-퍼널 §2.1 쿼리 설계).
  cells = rd.acr_cell 중 창 3술어(core.cycles.Window.where, 언급 계열 숨김 {1,3} 배제) + 필터 축(core.measure.scope_where) + acr_in.
  acr_cell 은 파티션이 없고 (surface, bgrp, round_date|cyc_key) 커버링 인덱스 두 개가 있다. 3술어는 가드 대상 표가 아니어도 그대로 건다.
  acr_cell 에는 dflt 열이 없어 scope_where(dflt_column=False): engine[] 이 비면 core 가 rd.dim_engine.is_default 키(ms.default_engine_keys)로
  engine_key = ANY 를 건다(모듈-AI-퍼널 §2.1).
레벨 조인 규약: rd.acr_choice 는 level LIST 파티션이라 level 등치로 파티션 하나만 읽는다(1 브랜드, 2 차종).
당사 판정은 SELECT 투영에만 둔다(own_bit = ANY(관점 비트), own_bit 는 0·1·2·4 단일 비트라 등치로 충분). WHERE 에 비트 식 없음.
비경쟁 이름 제외(keep)는 브랜드 계열 전 구획(브랜드 표·추이·배틀·점유 맵)에 건다. 이름 없는 브랜드(brand_key 0)는 뺀다.
열·식 조각은 이 파일 상수만 쓰고 값은 전부 Binder 로 넣는다.
"""
from __future__ import annotations

from collections.abc import Sequence

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.measure import MeasureScope, scope_where
from app.core.sqlb import Binder, Sql


def cells_cte(ms: MeasureScope, win: Window, b: Binder) -> str:
    """셀 선택 머리. 엔진 축이 없으면 기본 엔진 키(core scope_where dflt_column=False)."""
    w = win.where("c", "mentions", b) + scope_where(ms, "c", b, dflt_column=False) + ["c.acr_in"]
    return ("cells AS MATERIALIZED (\n"
            "  SELECT c.acr_cell_key, c.round_date, c.prompt_key, c.engine_key, c.geo_key, c.lang_key, c.valid_acr\n"
            f"    FROM rd.acr_cell c\n   WHERE {' AND '.join(w)})")


def option_langs_sql(ms: MeasureScope, win: Window) -> Sql:
    """ACR 모집단 언어 옵션(BG-33). ms 는 호출자가 lang 축을 뺀 것(자기 축 제외). 셀 선택 머리는 데이터와 같다."""
    b = Binder("o")
    t = (f"WITH {cells_cte(ms, win, b)}\n"
         "SELECT l.code FROM (SELECT DISTINCT cells.lang_key FROM cells) x JOIN rd.dim_lang l ON l.lang_key = x.lang_key ORDER BY l.code")
    return b.sql(t)


def option_countries_sql(ms: MeasureScope, win: Window) -> Sql:
    """ACR 모집단 국가 옵션(BG-33). ms 는 호출자가 geo 축을 계정 국가 스코프로 바꾼 것(자기 축 제외, 스코프 밖 누출 없음)."""
    b = Binder("n")
    t = (f"WITH {cells_cte(ms, win, b)}\n"
         "SELECT d.code FROM (SELECT DISTINCT cells.geo_key FROM cells) x JOIN rd.dim_country d ON d.geo_key = x.geo_key ORDER BY d.code")
    return b.sql(t)


def totals_sql(ms: MeasureScope, win: Window) -> Sql:
    b = Binder("t")
    t = (f"WITH {cells_cte(ms, win, b)}\n"
         "SELECT count(*)::int AS prompt_runs, count(DISTINCT prompt_key)::int AS prompts,\n"
         "       coalesce(sum(valid_acr), 0)::int AS iterations,\n"
         "       coalesce(array_agg(DISTINCT engine_key), '{}') AS engine_keys\n"
         "  FROM cells")
    return b.sql(t)


def brands_sql(ms: MeasureScope, win: Window, *, limit: int) -> Sql:
    """브랜드 레벨 선택·등장·등장 셀(구 Q2). 순서 = 선택 수, 등장 셀 수, 이름."""
    b = Binder("b")
    t = (f"WITH {cells_cte(ms, win, b)},\n"
         "br AS (\n"
         f"  SELECT ch.brand_key, bool_or(ch.own_bit = ANY({b.ints(ms.own_bits)})) AS is_ours,\n"
         "         sum(ch.choice)::int AS choice, sum(ch.appearance)::int AS appearance,\n"
         "         count(DISTINCT ch.acr_cell_key)::int AS cells\n"
         "    FROM cells JOIN rd.acr_choice ch ON ch.level = 1 AND ch.acr_cell_key = cells.acr_cell_key\n"
         "   WHERE ch.keep AND ch.brand_key <> 0\n"
         "   GROUP BY ch.brand_key)\n"
         "SELECT br.brand_key, bn.name AS brand, br.is_ours, br.choice, br.appearance, br.cells\n"
         "  FROM br JOIN rd.dim_brand_name bn ON bn.brand_key = br.brand_key\n"
         f" ORDER BY br.choice DESC, br.cells DESC, bn.name\n LIMIT {b.v(int(limit), 'int4')}")
    return b.sql(t)


def trend_sql(ms: MeasureScope, win: Window, *, series_brand_keys: Sequence[int]) -> Sql:
    """회차 버킷 추이(구 Q3). 분모(brand_key NULL 행) = 회차별 Σvalid_acr, 분자 = 회차 × 시리즈 브랜드 선택 합.
    분자·분모가 같은 cells(같은 게이트)를 쓴다."""
    b = Binder("r")
    t = (f"WITH {cells_cte(ms, win, b)}\n"
         "SELECT cells.round_date, NULL::int4 AS brand_key, sum(cells.valid_acr)::int AS n\n"
         "  FROM cells GROUP BY cells.round_date\n"
         "UNION ALL\n"
         "SELECT cells.round_date, ch.brand_key, sum(ch.choice)::int AS n\n"
         "  FROM cells JOIN rd.acr_choice ch ON ch.level = 1 AND ch.acr_cell_key = cells.acr_cell_key\n"
         f" WHERE ch.keep AND ch.brand_key = ANY({b.ints(series_brand_keys, 'int4')})\n"
         " GROUP BY cells.round_date, ch.brand_key")
    return b.sql(t)


def battle_sql(ms: MeasureScope, win: Window) -> Sql:
    """배틀 그리드(구 Q4): (프롬프트 × 엔진) 셀 전부 + 승자(선택 수 최다, 동률은 브랜드 이름 순).
    지역이 여럿이면 같은 (프롬프트, 엔진) 셀을 합산해 판정한다(현행과 같음). 상한은 앱에서(프롬프트 단위 합계 정렬 후)."""
    b = Binder("g")
    t = (f"WITH {cells_cte(ms, win, b)},\n"
         "agg AS (\n"
         "  SELECT cells.prompt_key, cells.engine_key, ch.brand_key, sum(ch.choice)::int AS choice,\n"
         f"         bool_or(ch.own_bit = ANY({b.ints(ms.own_bits)})) AS is_ours\n"
         "    FROM cells JOIN rd.acr_choice ch ON ch.level = 1 AND ch.acr_cell_key = cells.acr_cell_key\n"
         "   WHERE ch.keep AND ch.brand_key <> 0\n"
         "   GROUP BY cells.prompt_key, cells.engine_key, ch.brand_key\n"
         "  HAVING sum(ch.choice) > 0),\n"
         "win AS (\n"
         "  SELECT DISTINCT ON (agg.prompt_key, agg.engine_key) agg.prompt_key, agg.engine_key, bn.name AS brand, agg.choice, agg.is_ours\n"
         "    FROM agg JOIN rd.dim_brand_name bn ON bn.brand_key = agg.brand_key\n"
         "   ORDER BY agg.prompt_key, agg.engine_key, agg.choice DESC, bn.name),\n"
         "pe AS (SELECT DISTINCT cells.prompt_key, cells.engine_key FROM cells)\n"
         "SELECT dp.prompt_id::text AS prompt_id, dp.text AS prompt_text, pe.engine_key,\n"
         "       win.brand AS winner_brand, coalesce(win.is_ours, false) AS winner_is_ours, coalesce(win.choice, 0) AS choice\n"
         f"  FROM pe JOIN {fact_tables(ms).prompt} dp ON dp.prompt_key = pe.prompt_key\n"
         "  LEFT JOIN win ON win.prompt_key = pe.prompt_key AND win.engine_key = pe.engine_key")
    return b.sql(t)


def models_sql(ms: MeasureScope, win: Window, *, limit: int) -> Sql:
    """차종 전환율(구 Q5): level 2 행을 표시 이름(rep_name) × 소속 브랜드로 묶는다.
    분모 = 그 차종 행이 실린 셀의 valid_acr 합(행이 셀 × 엔티티 유일이라 합이 곧 그 값)."""
    b = Binder("m")
    t = (f"WITH {cells_cte(ms, win, b)}\n"
         "SELECT de.rep_name AS model, pb.name AS brand,\n"
         f"       bool_or(ch.own_bit = ANY({b.ints(ms.own_bits)})) AS is_ours,\n"
         "       sum(ch.choice)::int AS choice, sum(cells.valid_acr)::int AS cell_vacr,\n"
         "       count(DISTINCT ch.acr_cell_key)::int AS cells\n"
         "  FROM cells JOIN rd.acr_choice ch ON ch.level = 2 AND ch.acr_cell_key = cells.acr_cell_key\n"
         "  JOIN rd.dim_entity de ON de.entity_key = ch.entity_key\n"
         "  LEFT JOIN rd.dim_brand_name pb ON pb.brand_key = ch.parent_brand_key AND ch.parent_brand_key <> 0\n"
         " WHERE de.rep_name IS NOT NULL\n"
         " GROUP BY de.rep_name, pb.name\n"
         "HAVING sum(ch.choice) > 0\n"
         " ORDER BY sum(ch.choice)::float8 / NULLIF(sum(cells.valid_acr), 0) DESC NULLS LAST, sum(ch.choice) DESC, de.rep_name\n"
         f" LIMIT {b.v(int(limit), 'int4')}")
    return b.sql(t)


def territory_sql(ms: MeasureScope, win: Window, *, limit: int) -> Sql:
    """점유 맵(구 Q6): 시트 = (국가, 엔진), 셀 수 상위 limit 개. 행 = 셀, 항목 = 브랜드 레벨 keep ∧ 선택 > 0."""
    b = Binder("y")
    t = (f"WITH {cells_cte(ms, win, b)},\n"
         "sheets AS (\n"
         "  SELECT cells.geo_key, cells.engine_key, count(*) AS n FROM cells\n"
         "   GROUP BY cells.geo_key, cells.engine_key\n"
         f"   ORDER BY count(*) DESC, cells.geo_key, cells.engine_key LIMIT {b.v(int(limit), 'int4')})\n"
         "SELECT s.geo_key, s.engine_key, s.n, cells.acr_cell_key, dp.prompt_id::text AS prompt_id, dp.text AS prompt_text,\n"
         "       cells.valid_acr,\n"
         "       (SELECT coalesce(json_agg(json_build_object('brand', e.brand, 'choice', e.choice, 'is_ours', e.is_ours)\n"
         "                                 ORDER BY e.choice DESC, e.brand), '[]')\n"
         "          FROM (SELECT bn.name AS brand, sum(ch.choice)::int AS choice,\n"
         f"                       bool_or(ch.own_bit = ANY({b.ints(ms.own_bits)})) AS is_ours\n"
         "                  FROM rd.acr_choice ch JOIN rd.dim_brand_name bn ON bn.brand_key = ch.brand_key\n"
         "                 WHERE ch.level = 1 AND ch.acr_cell_key = cells.acr_cell_key AND ch.keep AND ch.brand_key <> 0\n"
         "                 GROUP BY bn.name HAVING sum(ch.choice) > 0) e) AS entries\n"
         "  FROM sheets s JOIN cells ON cells.geo_key = s.geo_key AND cells.engine_key = s.engine_key\n"
         f"  JOIN {fact_tables(ms).prompt} dp ON dp.prompt_key = cells.prompt_key\n"
         " ORDER BY s.n DESC, s.geo_key, s.engine_key, dp.text, cells.round_date, cells.acr_cell_key")
    return b.sql(t)
