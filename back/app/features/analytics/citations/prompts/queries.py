"""analytics.citations.prompts 읽기 SQL(rd·app 만).

설계(C-3 query_design 을 G-25 로 바꾼 것)
- 프롬프트별 인용 수·자사 여부는 rd.citation 을 스캔하지 않고 rd.answer 답변당 인용 수 열(cit_*, G-25)로 낸다.
  식은 core.measure.plan_counts(group_by=prompt·engine, parts=citations) 가 조립한 문장을 CTE 로 감싸 쓴다(지표 식 재구현 없음).
    · cit_total = Σ cit_n(호스트 있는 인용, cit_in 모수)
    · cit_owned = 표면별 자사 판정(글로벌 owner_key 허용 배열 · 웹사이트 loc_owned∨tgt_hit · 프로젝트 loc_owned)의 답변 열 합.
      국가 2개 이상(countryN)은 core 의 cross 문장(교차 국가 자사 답변만 원소 조인)을 더한다(merge_counts 와 같은 합산).
  자사 버킷 = 인용 행 단위 판정의 bool_or(2026-09-08 현행 수정) ≡ 프롬프트 답변들의 자사 인용 수 합 > 0(자식 합 = 답변 열 불변식).
- source[](출처 카테고리) 축: 답변 열은 출처 무관 합이라 core plan_counts 가 원소 스캔 문장(역할 scan = citation_counts_sql,
  citation_where 가 core.measure.source_where 를 건다)으로 바꾼다. 버킷 CTE 는 그 문장을 m 으로 쓴다(같은 열 이름 cit_total·cit_owned).
- 문장 1(bucket_page_sql): 버킷 카운트·버킷 total·키셋 페이지를 한 문장으로 낸다(스캔 1회).
- 문장 2(answer_refs_sql): 페이지에 실린 프롬프트의 답변 표본(행당 상위 8). rd.answer ⋈ rd.job(PK) 만. 출처 축이 있으면 그 출처 인용이
  있는 답변만, 인용 수도 그 출처 인용만(rd.citation 상관 집계, core citation_where 3술어).
정렬은 현행과 같다: 인용 수 내림차순, prompt_id 오름차순(키셋은 (-cites, prompt_id) 오름차순 행 비교).
선택 파라미터(P12 B099, 기본 = 종전 문장 그대로): fields=text 면 pr 의 엔진 array_agg 와 퍼널(rd.dim_taxon) 조인을 빼고(NULL 열),
both=True 면 같은 c(물리화)에서 반대 버킷의 첫 페이지(rows_other)를 한 열 더 낸다(m·pe·pr·c 계산 1회). include_refs=false 는 서비스가
문장 2 를 건너뛴다.
"""
from __future__ import annotations

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.measure import CountsPlan, MeasureScope, citation_population, citation_where, scope_where
from app.core.pagination import Cursor, keyset_predicate
from app.core.sqlb import Binder, Sql

# 키셋 정렬 식(화이트리스트): bucket CTE 열만
KEYSET_COLS = ("-b.cites", "b.prompt_id")

_EMPTY_CROSS = "SELECT NULL::int4 AS prompt_key, NULL::int2 AS engine_key, 0::int8 AS cit_cross WHERE false"


def like_pattern(q: str) -> str:
    """ILIKE 부분 일치 패턴. 와일드카드(% _)와 이스케이프 문자(\\)는 글자 그대로 찾는다."""
    esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{esc}%"


def bucket_page_sql(plan: CountsPlan, *, owned: bool, q: str | None, cursor: Cursor | None, limit: int,
                    ms: MeasureScope | None = None, fields: str = "all", both: bool = False) -> Sql:
    """문장 1. plan 은 plan_counts(ms, win, group_by=("prompt", "engine"), parts=("citations",)) 결과(역할 main + 선택 cross, 또는
    출처 축이면 main(건수만) + scan). 반환 열: n_owned, n_uncited, total, rows(json 배열: prompt_key·prompt_id·text·funnel·cites·engine_keys,
    최대 limit+1). fields='text' 면 rows 의 funnel·engine_keys 가 null(계산 안 함). both=True 면 rows_other(반대 버킷 첫 페이지, 같은 q,
    최대 limit+1, 키셋 없음: cursor 는 None 이어야 한다)를 더 낸다."""
    if fields not in ("all", "text"):
        raise ValueError(f"fields 는 all|text: {fields}")
    if both and cursor is not None:
        raise ValueError("both 는 커서 없는 첫 페이지만")
    roles = dict(plan.statements)
    if set(roles) - {"main", "cross", "scan"} or "main" not in roles:
        raise ValueError(f"프롬프트별 인용 계획은 main(+cross|scan) 문장만 지원: {sorted(roles)}")
    if plan.group_names != ("prompt_key", "engine_key"):
        raise ValueError(f"group_by 는 prompt·engine 이어야 한다: {plan.group_names}")
    main = roles.get("scan") or roles["main"]          # 원소 스캔이면 그 문장이 인용 수(cit_total·cit_owned)를 낸다
    cross = roles.get("cross")
    params = {**main.params, **(cross.params if cross else {})}
    b = Binder("k")
    bucket_where = [f"c.owned = {b.v(owned, 'bool')}"]
    q_where: list[str] = []
    if q:
        q_where = [f"c.text ILIKE {b.v(like_pattern(q), 'text')} ESCAPE '\\'"]
        bucket_where += q_where
    ks = keyset_predicate(KEYSET_COLS, "asc", cursor, b)
    page_where = f"\n    WHERE {ks}" if ks else ""
    if fields == "text":     # 퍼널·엔진 목록을 만들지 않는다(행 JSON 모양은 같고 두 값이 null)
        pr_engines = ""
        c_cols = "pr.prompt_key, pr.cites, pr.owned, NULL::int2[] AS engine_keys, dp.prompt_id, dp.text, NULL::text AS funnel"
        taxon = ""
    else:
        pr_engines = ",\n         array_agg(pe.engine_key ORDER BY pe.engine_key) AS engine_keys"
        c_cols = "pr.prompt_key, pr.cites, pr.owned, pr.engine_keys, dp.prompt_id, dp.text, t.code AS funnel"
        taxon = "\n    LEFT JOIN rd.dim_taxon t ON t.taxon_key = dp.funnel_key AND t.axis = 'funnel'"
    lim = b.v(limit + 1, "int4")
    rows_json = ("coalesce(json_agg(json_build_object('prompt_key', p.prompt_key, 'prompt_id', p.prompt_id, 'text', p.text,\n"
                 "                                                  'funnel', p.funnel, 'cites', p.cites, 'engine_keys', p.engine_keys)\n"
                 "                                ORDER BY p.cites DESC, p.prompt_id), '[]'::json)")
    other_cte = other_col = ""
    if both:                 # 반대 버킷 첫 페이지: 같은 c(물리화)·같은 q·같은 정렬(키셋 없음)
        other_where = [f"c.owned = {b.v(not owned, 'bool')}", *q_where]
        other_cte = f",\nbo AS (SELECT c.* FROM c WHERE {' AND '.join(other_where)})"
        other_col = (f",\n       (SELECT {rows_json}\n"
                     f"          FROM (SELECT bo.* FROM bo ORDER BY bo.cites DESC, bo.prompt_id LIMIT {lim}) p) AS rows_other")
    txt = (
        f"WITH m AS (\n{main.text}\n),\n"
        f"x AS (\n{cross.text if cross else _EMPTY_CROSS}\n),\n"
        "pe AS (\n"
        "  SELECT m.prompt_key, m.engine_key, m.cit_total::int8 AS cites,\n"
        "         (m.cit_owned + coalesce(x.cit_cross, 0))::int8 AS owned_cites\n"
        "    FROM m LEFT JOIN x ON x.prompt_key = m.prompt_key AND x.engine_key = m.engine_key\n"
        "   WHERE m.cit_total > 0),\n"
        "pr AS (\n"
        f"  SELECT pe.prompt_key, sum(pe.cites)::int8 AS cites, sum(pe.owned_cites) > 0 AS owned{pr_engines}\n"
        "    FROM pe GROUP BY pe.prompt_key),\n"
        "c AS MATERIALIZED (\n"
        f"  SELECT {c_cols}\n"
        f"    FROM pr JOIN {fact_tables(ms).prompt} dp ON dp.prompt_key = pr.prompt_key{taxon}),\n"
        f"b AS (SELECT c.* FROM c WHERE {' AND '.join(bucket_where)}){other_cte}\n"
        "SELECT (SELECT count(*) FILTER (WHERE c.owned) FROM c) AS n_owned,\n"
        "       (SELECT count(*) FILTER (WHERE NOT c.owned) FROM c) AS n_uncited,\n"
        "       (SELECT count(*) FROM b) AS total,\n"
        f"       (SELECT {rows_json}\n"
        "          FROM (SELECT b.* FROM b"
        f"{page_where}\n"
        f"                 ORDER BY b.cites DESC, b.prompt_id LIMIT {lim}) p) AS rows{other_col}"
    )
    return Sql(txt, {**params, **b.params})


def answer_refs_sql(ms: MeasureScope, win: Window, prompt_keys: list[int], per_prompt: int) -> Sql:
    """문장 2. 페이지 프롬프트들의 답변 표본: 인용 있는 답변(has_cit = cit_n > 0)을 인용 수 내림차순·job_id 오름차순으로 행당 per_prompt 건.
    창·필터 술어는 문장 1 과 같은 core 조각(Window.where 인용 계열 + scope_where + cit_in)이다."""
    a = "a"
    b = Binder("s")
    w = win.where(a, "citations", b) + scope_where(ms, a, b) + [
        citation_population(ms, a), f"{a}.has_cit", f"{a}.prompt_key = ANY({b.ints(prompt_keys, 'int4')})"]
    if ms.source_category_keys is None:
        cites, keep = f"{a}.cit_n::int4", "true"
    else:   # 출처 축: 그 출처 인용이 있는 답변만, 그 출처 인용 수(원소, core citation_where = 창 3술어 + 필터 축 + cit_in + 호스트 + 출처)
        cw = citation_where(ms, win, "c", b) + [f"c.answer_key = {a}.answer_key"]
        cites, keep = f"(SELECT count(*) FROM {fact_tables(ms).citation} c WHERE {' AND '.join(cw)})::int4", "s.cites > 0"
    txt = (
        "SELECT t.prompt_key, t.job_id, t.engine_key, t.geo_key, t.cites FROM (\n"
        f"  SELECT s.prompt_key, s.job_id, s.engine_key, s.geo_key, s.cites,\n"
        f"         row_number() OVER (PARTITION BY s.prompt_key ORDER BY s.cites DESC, s.job_id) AS rk\n"
        f"    FROM (SELECT {a}.prompt_key, j.job_id, {a}.engine_key, {a}.geo_key, {cites} AS cites\n"
        f"            FROM {fact_tables(ms).answer} {a} JOIN rd.job j ON j.answer_key = {a}.answer_key\n"
        f"           WHERE {' AND '.join(w)}) s\n"
        f"   WHERE {keep}) t\n"
        f" WHERE t.rk <= {b.v(per_prompt, 'int4')}\n"
        " ORDER BY t.prompt_key, t.rk"
    )
    return b.sql(txt)
