"""analytics.mentions.prompts 읽기 SQL(rd 만). 술어는 core 빌더(Window.where 3술어 + core.measure.scope_where)와
core.pagination.keyset_predicate 만 쓰고, 신호 열은 화이트리스트(SIGNAL_COLS)에서만 고른다(사용자 문자열을 SQL 에 넣지 않는다).

타깃 술어(모듈-언급 §3.3)
- brand : b.brand_key = :bk ∧ b.competitive, 값 = mention_count (ab_brand_idx). mention_brand 는 서비스가 brand_key 로 풀어 같은 술어.
- own   : b.own_bit = ANY(당사 비트) ∧ b.competitive, 값 = mention_count (BG-17 당사 행 드릴다운, own_brand_code 면 그 비트 하나)
- signal: b.own_bit = ANY(관점 비트) ∧ b.competitive ∧ b.<신호 열> > 0, 값 = <신호 열>
문장 둘(페이지 + 답변 배치)만 실행한다. terms=true 면 답변 참조의 언급 원본(rd.v_answer_mention_raw, answer_key 등치 배치) 한 문장을 더한다.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.measure import MeasureScope, mention_population, scope_where
from app.core.pagination import Cursor, keyset_predicate
from app.core.sqlb import Binder, Sql

SIGNAL_COLS: dict[str, str] = {"positive": "s_pos", "neutral": "s_neu", "negative": "s_neg", "mixed": "s_mix",
                               "mention": "t_mention", "recommendation": "t_recommendation", "comparison": "t_comparison",
                               "definition": "t_definition", "final_choice": "t_final_choice"}
KEY_TYPES = ("int8", "int4")          # 커서 키: (count, prompt_key)
SORT = "count_desc"


@dataclass(frozen=True)
class TargetSpec:
    mode: str
    brand_key: int | None = None
    signal: str | None = None
    own_bits: tuple[int, ...] | None = None      # mode=brand 당사 타깃(BG-17)


def _target(t: TargetSpec, ms: MeasureScope, b: Binder) -> tuple[list[str], str]:
    if t.mode == "brand" and t.own_bits is not None:
        return [f"b.own_bit = ANY({b.ints(t.own_bits)})", "b.competitive"], "b.mention_count"
    if t.mode == "brand":
        if t.brand_key is None:
            raise ValueError("brand_key 필요")
        return [f"b.brand_key = {b.v(int(t.brand_key), 'int4')}", "b.competitive"], "b.mention_count"
    col = SIGNAL_COLS[t.signal or ""]                       # KeyError = 화이트리스트 밖(스키마 검증을 지난 값만 온다)
    return [f"b.own_bit = ANY({b.ints(ms.own_bits)})", "b.competitive", f"b.{col} > 0"], f"b.{col}"


def page_sql(ms: MeasureScope, win: Window, t: TargetSpec, *, cursor: Cursor | None, limit: int) -> Sql:
    """프롬프트 페이지(limit+1 행): count DESC, prompt_key DESC 키셋. total·n_prompts 는 키셋 적용 전 창 함수로 구한다."""
    b = Binder("p")
    tw, val = _target(t, ms, b)
    w = win.where("b", "mentions", b) + scope_where(ms, "b", b) + [mention_population(ms, "b", "brand")] + tw
    ks = keyset_predicate(["g.cnt", "g.prompt_key"], "desc", cursor, b)
    txt = ("SELECT g.prompt_key, g.cnt, g.total, g.n_prompts, g.engines, p.prompt_id, p.text AS prompt_text, x.code AS funnel_code\n"
           f"  FROM (SELECT b.prompt_key, sum({val})::int8 AS cnt, (sum(sum({val})) OVER ())::int8 AS total, count(*) OVER () AS n_prompts,\n"
           "               array_agg(DISTINCT b.engine_key ORDER BY b.engine_key) AS engines\n"
           f"          FROM {fact_tables(ms).answer_brand} b\n         WHERE {' AND '.join(w)}\n         GROUP BY b.prompt_key) g\n"
           f"  JOIN {fact_tables(ms).prompt} p ON p.prompt_key = g.prompt_key\n"
           "  LEFT JOIN rd.dim_taxon x ON x.taxon_key = p.funnel_key AND x.axis = 'funnel'\n"
           + (f" WHERE {ks}\n" if ks else "")
           + f" ORDER BY g.cnt DESC, g.prompt_key DESC\n LIMIT {b.v(limit + 1, 'int4')}")
    return b.sql(txt)


def answers_sql(ms: MeasureScope, win: Window, t: TargetSpec, *, prompt_keys: Sequence[int], answers_limit: int, lite: bool = False) -> Sql:
    """페이지 프롬프트의 답변 참조(1회). 답변 단위로 타깃 값을 접고 → (프롬프트, 엔진, 국가) 셀 대표 1건(R05: is_rep 우선, 최신 측정)과
    셀 답변 수(runs) → 프롬프트 안에서 값 내림차순 answers_limit 건. job_id·measured_at 은 rd.job(answer_key PK) 에서 읽는다.
    lite(mode=signal 전용): 순위(pos)·셀 답변 수(runs) 집계를 하지 않고 pos·measured_at·runs 를 NULL 로 낸다. measured_at 은 대표 선택
    정렬에 그대로 쓰므로 고르는 답변(job_id)·순서는 lite 가 아닐 때와 같다."""
    b = Binder("a")
    tw, val = _target(t, ms, b)
    w = (win.where("b", "mentions", b) + scope_where(ms, "b", b) + [mention_population(ms, "b", "brand")] + tw
         + [f"b.prompt_key = ANY({b.ints(prompt_keys, 'int4')})"])
    wa = win.where("a", "mentions", b)
    pos = "" if lite else ", min(NULLIF(b.rk, 0)) AS pos"
    runs = "" if lite else ",\n         count(*) OVER (PARTITION BY t.prompt_key, t.engine_key, t.geo_key) AS runs"
    out = "NULL::int4 AS pos, NULL::timestamptz AS measured_at, NULL::int8 AS runs" if lite else "d.pos, d.measured_at, d.runs"
    txt = ("WITH t AS (\n"
           f"  SELECT b.round_date, b.answer_key, b.prompt_key, b.engine_key, b.geo_key, sum({val})::int8 AS val{pos}\n"
           f"    FROM {fact_tables(ms).answer_brand} b\n   WHERE {' AND '.join(w)}\n   GROUP BY 1, 2, 3, 4, 5),\n"
           "c AS (\n"
           "  SELECT t.*, j.job_id, j.measured_at,\n"
           "         row_number() OVER (PARTITION BY t.prompt_key, t.engine_key, t.geo_key\n"
           f"                            ORDER BY a.is_rep DESC, j.measured_at DESC NULLS LAST, t.answer_key DESC) AS rn{runs}\n"
           f"    FROM t JOIN {fact_tables(ms).answer} a ON a.round_date = t.round_date AND a.answer_key = t.answer_key\n"
           "           JOIN rd.job j ON j.answer_key = t.answer_key\n"
           f"   WHERE {' AND '.join(wa)}),\n"
           "d AS (\n"
           "  SELECT c.*, row_number() OVER (PARTITION BY c.prompt_key ORDER BY c.val DESC, c.measured_at DESC NULLS LAST, c.answer_key DESC) AS pr\n"
           "    FROM c WHERE c.rn = 1)\n"
           f"SELECT d.prompt_key, d.answer_key, d.job_id, e.code AS engine, g.code AS region, d.val, {out}\n"
           "  FROM d LEFT JOIN rd.dim_engine e ON e.engine_key = d.engine_key LEFT JOIN rd.dim_country g ON g.geo_key = d.geo_key\n"
           f" WHERE d.pr <= {b.v(answers_limit, 'int4')}\n ORDER BY d.prompt_key, d.pr")
    return b.sql(txt)


def terms_sql(answer_keys: Sequence[int], sf: int, project_keys: Sequence[int]) -> Sql:
    """BG-18: 답변 참조의 언급 원본(엔티티 표시명·표면 표기·롤업) + 엔티티 정본 브랜드(rd.dim_entity → rd.dim_brand_name: 키·비트·이름).
    문서형 뷰라 answer_key 등치 + 스코프 열(surface·project_key) 재단언(answers.detail 과 같은 규칙, fail-closed)."""
    b = Binder("h")
    t = ("SELECT m.answer_key, m.ord, m.entity_id, m.entity_type, m.display_name, m.surfaces, m.brand_rollup_entity_id AS rollup_id,\n"
         "       ee.brand_key AS e_bk, ebn.own_bit AS e_own, ebn.name AS e_name, re.brand_key AS r_bk, rbn.own_bit AS r_own\n"
         "  FROM rd.v_answer_mention_raw m\n"
         "  LEFT JOIN rd.dim_entity ee ON ee.entity_key = m.entity_key LEFT JOIN rd.dim_brand_name ebn ON ebn.brand_key = ee.brand_key\n"
         "  LEFT JOIN rd.dim_entity re ON re.entity_id = m.brand_rollup_entity_id LEFT JOIN rd.dim_brand_name rbn ON rbn.brand_key = re.brand_key\n"
         f" WHERE m.answer_key = ANY({b.ints(answer_keys, 'int4')}) AND m.surface = {b.v(sf, 'int2')}"
         f" AND m.project_key = ANY({b.ints(project_keys)})\n ORDER BY m.answer_key, m.ord")
    return b.sql(t)


# 이름 → 표시 브랜드 키: 표기 일치 우선, 없으면 대소문자 무시(lower(bare)). 끔은 bare 가 이미 소문자라 종전과 같다. 현행 프로필 NAME 은
#   bare = 정본 표시명 그대로라(대소문자 표기별 행, 운영 생성기와 같다) 소문자 값과 직접 비교하면 못 찾는다(be/int3-name2)
RESOLVE_BRAND_SQL = """
SELECT brand_key, name FROM rd.dim_brand_name
 WHERE brand_key <> 0 AND (name = :n OR lower(bare) = lower(:n))
 ORDER BY (name = :n) DESC, (bare = lower(:n)) DESC, brand_key LIMIT 1"""


def brand_name_sql(brand_key: int) -> Sql:
    b = Binder("n")
    return b.sql(f"SELECT brand_key, name FROM rd.dim_brand_name WHERE brand_key = {b.v(int(brand_key), 'int4')}")
