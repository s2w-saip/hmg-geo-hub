"""analytics.kpi.summary 읽기 SQL. 지표 식은 core 빌더가 낸다.

M01~M05·M12·A16 은 core.measure.fetch_counts(rd.answer 한 번 스캔 + M12 측정 프롬프트 수 보조 문장),
M06·M07 은 core.measure.url_rates(R09 발행값 접기), 적용 프롬프트 수는 core.measure.prompt_counts 가 낸다.
사실 표 술어(surface·round_date·cyc_key)는 core.cycles.Window.where 가 붙인다(fact_guard 통과).

이 파일의 문장(값 갭 보강, 술어는 core 빌더만 조립한다)
- funnel_measured_sql(BG-08): 측정 프롬프트(core.measure.measured_prompt_where = M12 'prompts' 문장 술어)를 rd.dim_prompt.funnel_key
  로 나눈 서로 다른 프롬프트 수. funnel_key 는 scope_prompt_id 가 같은 app.prompt 어느 행이든(현행 aggregatePromptTopicFromMirror 규칙).
- unmeasured_sql(BG-04): 적용 집합(core.measure.applied_prompt_keys_sql = M12 적용 카운트 술어) − 측정 집합(measured_prompt_where).
  카드의 params.applied_prompts·measured_prompts 와 같은 술어라 total = |적용 \\ 측정|(측정 ⊆ 적용이면 applied − measured).
  global 은 본문(text·분류)을 내므로 권한 게이트를 더 건다(검증 D1): 적용 키 = 살아 있는(soft-delete 제외) 루트 카탈로그 행 중 계정 대상
  시장 3분기(core.filters.catalog_market_scope, GET /v1/prompts 와 같은 술어)를 통과하는 행이 있는 키, 대표 행도 그 행 중에서 고른다.
  그래서 시장 밖 적용 행이 있는 계정은 total < 카드 applied − measured 다(카드의 시장 게이트는 메인 결정 대기, CORE-REQUESTS).
  행 게이트(CatalogRowGate)는 GET /v1/prompts 의 행 술어와 같은 한 벌이다: 살아 있음 ∧ 브랜드 스코프(catalog_brand_scope) ∧ 대상 시장
  3분기 ∧ 적용된 택소노미 축(rd.catalog_entry 키, rd.dim_taxon 사전) ∧ depth4(app.prompt.depth4). 적용 키와 대표 행이 **같은 행**에서
  이 게이트를 통과해야 한다(검증 D1 재검증: 시장·택소노미를 서로 다른 행이 나눠 통과하는 키를 내지 않는다, D3: 대표 행이 필터에 안 맞는
  형제 카탈로그 행이 되지 않는다). 한 키 한 행 접기(카드 distinct 키 단위)는 현행 카탈로그 행 단위 목록과의 known_diff(README).
- PUBLICATION_LABELS_SQL(BG-26): 합산에 들어간 발행물(slug)의 회차 라벨.
"""
from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.filters import catalog_brand_scope, catalog_market_scope
from app.core.measure import MeasureScope, applied_prompt_keys_sql, measured_prompt_where
from app.core.sqlb import Binder, Sql

# 요약 카드가 쓰는 core.measure 부분 집합(part). urls 는 url_rates 가 따로 읽는다.
SUMMARY_PARTS: tuple[str, ...] = ("mentions", "prompts", "gap", "citations")

# 발행물 회차 라벨(app.report_publication, 현행 loadPublishedWebsiteRound 의 cycleLabel·cycleLabelEn·roundDate)
PUBLICATION_LABELS_SQL = """
SELECT p.slug, p.cycle_label, p.cycle_label_en, p.round_date
  FROM app.report_publication p
 WHERE p.slug = ANY(CAST(:slugs AS text[]))
 ORDER BY p.slug
"""


def funnel_measured_sql(ms: MeasureScope, win: Window) -> Sql:
    """퍼널 키별 측정 프롬프트 수. 퍼널 키 0(미분류)도 한 행."""
    b = Binder("f")
    where = measured_prompt_where(ms, win, "a", b)
    return b.sql("SELECT dp.funnel_key, count(DISTINCT a.prompt_key) AS measured_prompts\n"
                 f"  FROM {fact_tables(ms).answer} a JOIN {fact_tables(ms).prompt} dp ON dp.prompt_key = a.prompt_key\n"
                 f" WHERE {' AND '.join(where)}\n GROUP BY 1")


# 대표 원본 행(표면별). 프롬프트 키 하나에 한 행으로 접는다(적용 카운트 단위 = 서로 다른 프롬프트 키).
_REP_GLOBAL = ("LEFT JOIN LATERAL (SELECT p.prompt_id, p.text, p.list_type, p.depth1, p.depth2, p.funnel_stage\n"
               "                     FROM rd.catalog_entry ce2 JOIN app.prompt p ON p.prompt_id = ce2.catalog_row_id\n"
               "                    WHERE ce2.prompt_key = u.prompt_key AND ce2.brand_bit = ANY({bits}) AND p.deleted_at IS NULL AND {gate}\n"
               "                    ORDER BY p.prompt_id LIMIT 1) r ON true")
_REP_PROJECT = ("LEFT JOIN LATERAL (SELECT p.prompt_id, p.text, p.list_type, p.depth1, p.depth2, p.funnel_stage\n"
                "                     FROM app.prompt p\n"
                "                    WHERE p.project_id = {pid} AND p.scope_prompt_id = dp.prompt_id AND p.deleted_at IS NULL\n"
                "                    ORDER BY p.created_at, p.prompt_id LIMIT 1) r ON true")
_REP_NONE = ("LEFT JOIN LATERAL (SELECT NULL::uuid AS prompt_id, NULL::text AS text, NULL::text AS list_type, NULL::text AS depth1,\n"
             "                          NULL::text AS depth2, NULL::text AS funnel_stage) r ON true")


# 택소노미 축 → rd.catalog_entry 키 열·rd.dim_taxon 축 이름(core.filters._taxonomy_prompt_keys_global 과 같은 대응)
_TAX_CE_COL = {"funnel": ("funnel_key", "funnel"), "brand_presence": ("presence_key", "presence"), "list_type": ("list_type_key", "list_type"),
               "depth1": ("depth1_key", "depth1"), "depth2": ("depth2_key", "depth2"), "depth3": ("depth3_key", "depth3")}


@dataclass(frozen=True)
class CatalogRowGate:
    """global 미측정 목록의 카탈로그 행 게이트(본문을 내는 행 = GET /v1/prompts 가 보여 줄 행).
    countries = 계정 국가 스코프(ReadContext.scope.countries, 요청 country[] 가 아니다: 답변 축은 적용 집합을 좁히지 않는다),
    own_brands·umbrella = catalog_brand_scope 인자, taxonomy = 실제로 적용된 택소노미 축 {축: 요청 코드}, depth4 = 적용된 depth4 값."""
    countries: tuple[str, ...] | None = None
    own_brands: tuple[str, ...] = ()
    umbrella: tuple[str, ...] = ()
    taxonomy: Mapping[str, Sequence[str]] = field(default_factory=dict)
    depth4: tuple[str, ...] = ()

    def pred(self, ce: str, p: str, b: Binder) -> str:
        """행 술어(ce = rd.catalog_entry 별칭, p = 그 행의 app.prompt 별칭). soft-delete 는 호출 문장이 건다."""
        w = [catalog_brand_scope(p, self.own_brands, self.umbrella, b)]
        ms = catalog_market_scope(p, self.countries, b)
        if ms:
            w.append(ms)
        for axis, codes in sorted(self.taxonomy.items()):
            col, dbaxis = _TAX_CE_COL[axis]
            # 사전에 없는 코드는 어느 키와도 맞지 않는다(core 가 dropped 로 적고 적용 키를 비운다: 같은 fail-closed)
            w.append(f"{ce}.{col} IN (SELECT t.taxon_key FROM rd.dim_taxon t WHERE t.axis = {b.v(dbaxis)}"
                     f" AND t.code = ANY({b.v(sorted(set(codes)), 'text[]')}))")
        if self.depth4:
            w.append(f"{p}.depth4 = ANY({b.v(sorted(set(self.depth4)), 'text[]')})")
        return " AND ".join(w)


def unmeasured_sql(ms: MeasureScope, win: Window, *, project_id: uuid.UUID | None, limit: int,
                   gate: CatalogRowGate | None = None) -> Sql:
    """적용 − 측정 프롬프트(한 키 한 행), 정렬 = list_type·depth1(NULL 뒤)·text·키(현행 ORDER BY 계승), total = 절단 전 행 수.
    gate = global 카탈로그 행 게이트(global 필수: 없으면 ValueError, 권한 게이트를 빠뜨린 호출을 조용히 넘기지 않는다).
    적용 키와 대표 행이 같은 게이트를 쓴다."""
    if ms.sf == 1 and gate is None:
        raise ValueError("global 미측정 목록은 CatalogRowGate 가 필요하다")
    b = Binder("u")
    g = gate or CatalogRowGate()
    applied = applied_prompt_keys_sql(ms, b, catalog_row_pred=g.pred("ce", "cp", b) if ms.sf == 1 else None)
    measured = measured_prompt_where(ms, win, "a", b)
    if ms.sf == 1:
        rep = _REP_GLOBAL.format(bits=b.ints(ms.pop_bits), gate=g.pred("ce2", "p", b))
    elif ms.sf == 3 and project_id is not None:
        rep = _REP_PROJECT.format(pid=b.v(str(project_id), "uuid"))
    else:
        rep = _REP_NONE
    t = ("WITH ap AS (" + applied + "),\n"
         f"     me AS (SELECT DISTINCT a.prompt_key FROM {fact_tables(ms).answer} a WHERE " + " AND ".join(measured) + "),\n"
         "     u AS (SELECT ap.prompt_key FROM ap WHERE NOT EXISTS (SELECT 1 FROM me WHERE me.prompt_key = ap.prompt_key))\n"
         "SELECT coalesce(r.prompt_id, dp.prompt_id) AS prompt_id, dp.prompt_id AS scope_prompt_id, coalesce(r.text, dp.text) AS text,\n"
         "       r.list_type, r.depth1, r.depth2, r.funnel_stage, count(*) OVER () AS total\n"
         f"  FROM u JOIN {fact_tables(ms).prompt} dp ON dp.prompt_key = u.prompt_key\n"
         f"  {rep}\n"
         " ORDER BY r.list_type NULLS LAST, r.depth1 NULLS LAST, coalesce(r.text, dp.text), u.prompt_key\n"
         f" LIMIT {b.v(int(limit), 'int4')}")
    return b.sql(t)
