"""analytics.answers.list 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

- 사실 표(rd.answer·answer_brand·citation) 는 모든 SELECT 스코프에 core.cycles.Window.where 3술어(surface·round_date·cyc_key)를 건다.
  EXISTS 서브쿼리도 같은 3술어를 따로 건다(상관 조건만으로는 가지치기·경계 가드 모두 성립하지 않는다).
- 필터 축 술어는 core.measure.scope_where(project_key·bgrp·dflt|engine·geo·lang·prompt), 키셋은 core.pagination.keyset_predicate.
- 열·식 조각은 이 파일의 화이트리스트 상수에서만 고른다. 사용자 값은 Binder 바인드로만 들어간다.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from datetime import date
from typing import Any

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.measure import MeasureScope, catalog_all, citation_population, mention_population, scope_where, source_where
from app.core.pagination import Cursor, keyset_predicate
from app.core.sqlb import Binder, Sql

# signal → rd.answer_brand 열(화이트리스트). 현행 SIGNAL_COLUMNS(scope-aggregates.ts:7248-7258) 대응
SIGNAL_COLUMNS: dict[str, str] = {
    "positive": "s_pos", "neutral": "s_neu", "mixed": "s_mix", "negative": "s_neg",
    "mention": "t_mention", "recommendation": "t_recommendation", "comparison": "t_comparison",
    "definition": "t_definition", "final_choice": "t_final_choice",
}
_SIGNAL_COL_SET = frozenset(SIGNAL_COLUMNS.values())
SORT_COLS = ("a.round_date", "a.answer_key")
Q_KEYS_CAP = 1000          # q 결과 프롬프트 키가 이보다 많으면 상수 배열 대신 차원 semi-join(계약 §3 술어 규약)

# ── 차원 해석(작은 차원 표, 요청마다 조회: D8) ──
# 이름 → 표시 브랜드 키: 표기 일치 우선, 없으면 대소문자 무시(lower(bare)). 끔은 bare 가 이미 소문자라 종전과 같다. 현행 프로필 NAME 은
#   bare = 정본 표시명 그대로라(대소문자 표기별 행, 운영 생성기와 같다) 소문자 값과 직접 비교하면 못 찾는다(be/int3-name2)
RESOLVE_BRAND_SQL = """
SELECT brand_key, name FROM rd.dim_brand_name
 WHERE brand_key <> 0 AND (name = :n OR lower(bare) = lower(:n))
 ORDER BY (name = :n) DESC, (bare = lower(:n)) DESC, brand_key LIMIT 1"""

RESOLVE_DOMAIN_SQL = """
SELECT source_key FROM rd.dim_source WHERE source_key <> 0 AND domain = :d ORDER BY source_key"""

RESOLVE_PROMPT_SQL = f"""
SELECT prompt_key FROM {fact_tables().prompt}
 WHERE prompt_id = :pid AND surface = CAST(:sf AS int2) AND project_key = ANY(CAST(:pks AS int2[]))"""

SEARCH_PROMPT_SQL = f"""
SELECT prompt_key FROM {fact_tables().prompt}
 WHERE surface = CAST(:sf AS int2) AND project_key = ANY(CAST(:pks AS int2[])) AND text ILIKE :pat ESCAPE '\\'
 ORDER BY prompt_key LIMIT CAST(:cap AS int4)"""


def like_pattern(q: str) -> str:
    """부분 일치 ILIKE 패턴. 사용자 입력의 와일드카드(%·_)와 이스케이프 문자는 리터럴로 바꾼다."""
    esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{esc}%"


def normalize_domain(d: str) -> str:
    """도메인 입력 정규화: 소문자·앞뒤 공백·끝 점·www. 접두 제거(rd.dim_source.domain 은 등록 도메인 표기)."""
    s = d.strip().lower().rstrip(".")
    return s[4:] if s.startswith("www.") else s


@dataclass(frozen=True)
class ListPlan:
    """목록 한 페이지 조회 입력(순수 값). keys = 이 페이지 창의 회차 키(계열 교집합까지 반영)."""
    ms: MeasureScope
    keys: tuple[int, ...]
    include_gap: bool
    own_bits: tuple[int, ...]
    limit: int
    q_pattern: str | None = None               # q 결과가 상한을 넘을 때만 semi-join 으로
    mention_brand_key: int | None = None
    signal_col: str | None = None
    source_keys: tuple[int, ...] | None = None     # domain → dim_source 키
    category_keys: tuple[int, ...] | None = None   # source[] → app.citation_category 키
    cursor_key: tuple[date, int] | None = None     # (round_date, answer_key)
    collapse_cell: bool = False

    @property
    def has_mention_pred(self) -> bool:
        return self.mention_brand_key is not None or self.signal_col is not None

    @property
    def has_citation_pred(self) -> bool:
        return self.source_keys is not None or self.category_keys is not None


_ROW_COLS = """a.answer_key, a.round_date, a.anchor_date, a.cyc_key, a.engine_key, a.geo_key, a.lang_key,
       a.is_rep, a.is_acr, a.acr_iter_rank, a.gap, a.ment_total, a.ment_h, a.ment_k, a.ment_g,
       a.own_rk_h, a.own_rk_k, a.own_rk_g, a.has_cit, a.tgt_cited, a.own_url_cited,
       j.job_id, j.measured_at, p.prompt_id, p.text AS prompt_text"""


def _base_where(plan: ListPlan, win: Window, b: Binder) -> list[str]:
    w = win.where("a", "row", b, keys=plan.keys) + scope_where(plan.ms, "a", b)
    w.append(citation_population(plan.ms, "a") if plan.include_gap else mention_population(plan.ms, "a"))
    if plan.q_pattern is not None:
        w.append(f"a.prompt_key IN (SELECT dp.prompt_key FROM {fact_tables(plan.ms).prompt} dp WHERE dp.surface = {b.v(plan.ms.sf, 'int2')} "
                 f"AND dp.project_key = ANY({b.ints(plan.ms.project_keys)}) AND dp.text ILIKE {b.v(plan.q_pattern)} ESCAPE '\\')")
    if plan.mention_brand_key is not None:
        sub = win.where("ab", "row", b, keys=plan.keys)
        w.append(f"EXISTS (SELECT 1 FROM {fact_tables(plan.ms).answer_brand} ab WHERE " + " AND ".join(sub) +
                 f" AND ab.answer_key = a.answer_key AND ab.round_date = a.round_date"
                 f" AND ab.brand_key = {b.v(plan.mention_brand_key, 'int4')} AND {mention_population(plan.ms, 'ab', 'brand')})")
    if plan.signal_col is not None:
        col = plan.signal_col
        if col not in _SIGNAL_COL_SET:          # 열 이름은 화이트리스트 값만(사용자 문자열 금지)
            raise ValueError(f"알 수 없는 신호 열: {col}")
        sub = win.where("sg", "row", b, keys=plan.keys)
        w.append(f"EXISTS (SELECT 1 FROM {fact_tables(plan.ms).answer_brand} sg WHERE " + " AND ".join(sub) +
                 f" AND sg.answer_key = a.answer_key AND sg.round_date = a.round_date"
                 f" AND sg.own_bit = ANY({b.ints(plan.own_bits)}) AND {mention_population(plan.ms, 'sg', 'brand')} AND sg.{col} > 0)")
    if plan.has_citation_pred:
        sub = win.where("c", "row", b, keys=plan.keys)
        extra = []
        if plan.source_keys is not None:
            extra.append(f"c.source_key = ANY({b.ints(plan.source_keys, 'int4')})")
        if plan.category_keys is not None:      # 유효 카테고리(운영자 오버라이드 우선) 세미조인: core.measure.source_where
            extra += source_where(dataclasses.replace(plan.ms, source_category_keys=plan.category_keys), "c", b)
        w.append(f"EXISTS (SELECT 1 FROM {fact_tables(plan.ms).citation} c WHERE " + " AND ".join(sub) +
                 " AND c.answer_key = a.answer_key AND c.round_date = a.round_date AND "
                 + citation_population(plan.ms, "c", "citation") + " AND " + " AND ".join(extra) + ")")
    return w


def list_sql(plan: ListPlan, win: Window) -> Sql:
    """목록 한 페이지(limit+1행). collapse_cell 이면 (엔진, 국가) 셀마다 최신 측정 1건 + runs."""
    b = Binder()
    where = _base_where(plan, win, b)
    frm = f"FROM {fact_tables(plan.ms).answer} a JOIN rd.job j ON j.answer_key = a.answer_key JOIN {fact_tables(plan.ms).prompt} p ON p.prompt_key = a.prompt_key"
    lim = b.v(plan.limit + 1, "int4")
    cur = Cursor(sort="round_date", dir="desc", key=plan.cursor_key, fh="") if plan.cursor_key is not None else None
    if not plan.collapse_cell:
        kp = keyset_predicate(SORT_COLS, "desc", cur, b)
        if kp:
            where.append(kp)
        text = (f"SELECT {_ROW_COLS}, NULL::int4 AS runs\n  {frm}\n WHERE " + "\n   AND ".join(where) +
                f"\n ORDER BY a.round_date DESC, a.answer_key DESC\n LIMIT {lim}")
        return b.sql(text)
    inner = (f"SELECT {_ROW_COLS},\n       row_number() OVER (PARTITION BY a.engine_key, a.geo_key "
             "ORDER BY j.measured_at DESC NULLS LAST, a.round_date DESC, a.answer_key DESC) AS rn,\n"
             "       count(*) OVER (PARTITION BY a.engine_key, a.geo_key) AS runs\n"
             f"  {frm}\n WHERE " + "\n   AND ".join(where))
    outer = ["x.rn = 1"]
    kp = keyset_predicate(("x.round_date", "x.answer_key"), "desc", cur, b)
    if kp:
        outer.append(kp)
    text = (f"SELECT x.* FROM (\n{inner}\n) x\n WHERE " + " AND ".join(outer) +
            f"\n ORDER BY x.round_date DESC, x.answer_key DESC\n LIMIT {lim}")
    return b.sql(text)


def matched_brand_sql(win: Window, keys: tuple[int, ...], answer_keys: list[int], lo: date, hi: date, brand_key: int,
                      ms: MeasureScope | None = None) -> Sql:
    """페이지 답변(≤ limit+1)의 mention_brand 행(competitive 참·거짓 두 행 가능). 목록 쿼리는 EXISTS 로 존재만 보고 상세는 여기서.
    게이트 = std_in(현행 프로필 A41 이 걸린 글로벌이면 카탈로그 무관 std_in_nc: 삭제 카탈로그 프롬프트 답변도 목록 모수에 있다, WU-4)."""
    b = Binder()
    w = [f"ab.surface = {b.v(win.sf, 'int2')}",
         (f"ab.round_date = {b.date(lo)}" if lo == hi else f"ab.round_date BETWEEN {b.date(lo)} AND {b.date(hi)}"),
         f"ab.cyc_key = ANY({b.ints(keys, 'int4')})",
         f"ab.answer_key = ANY({b.ints(answer_keys, 'int4')})",
         f"ab.brand_key = {b.v(brand_key, 'int4')}", "ab.std_in_nc" if ms is not None and catalog_all(ms) else "ab.std_in"]
    return b.sql("SELECT ab.answer_key, ab.competitive, ab.mention_count, ab.rk, ab.s_pos, ab.s_neu, ab.s_neg, ab.s_mix,\n"
                 "       ab.t_mention, ab.t_recommendation, ab.t_comparison, ab.t_definition, ab.t_final_choice\n"
                 f"  FROM {fact_tables(ms).answer_brand} ab\n WHERE " + " AND ".join(w))


def matched_domain_sql(win: Window, keys: tuple[int, ...], answer_keys: list[int], lo: date, hi: date,
                       source_keys: tuple[int, ...], ms: MeasureScope | None = None) -> Sql:
    """페이지 답변의 그 도메인 인용 건수(모수 cit_in, A41 글로벌이면 cit_in_nc: matched_brand_sql 과 같은 규칙)."""
    b = Binder()
    w = [f"c.surface = {b.v(win.sf, 'int2')}",
         (f"c.round_date = {b.date(lo)}" if lo == hi else f"c.round_date BETWEEN {b.date(lo)} AND {b.date(hi)}"),
         f"c.cyc_key = ANY({b.ints(keys, 'int4')})",
         f"c.answer_key = ANY({b.ints(answer_keys, 'int4')})",
         f"c.source_key = ANY({b.ints(source_keys, 'int4')})", "c.cit_in_nc" if ms is not None and catalog_all(ms) else "c.cit_in"]
    return b.sql(f"SELECT c.answer_key, count(*) AS n FROM {fact_tables(ms).citation} c WHERE " + " AND ".join(w) + " GROUP BY c.answer_key")


def fold_matched_brand(rows: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """answer_key → 합산 행. competitive 참·거짓 두 행은 합산하고 rank 는 competitive 행 rk(0 이면 None)."""
    out: dict[int, dict[str, Any]] = {}
    sums = ("mention_count", "s_pos", "s_neu", "s_neg", "s_mix", "t_mention", "t_recommendation", "t_comparison",
            "t_definition", "t_final_choice")
    for r in rows:
        ak = int(r["answer_key"])
        cur = out.setdefault(ak, {k: 0 for k in sums} | {"rank": None})
        for k in sums:
            cur[k] += int(r[k] or 0)
        if r["competitive"] and int(r["rk"] or 0) > 0:
            cur["rank"] = int(r["rk"])
    return out
