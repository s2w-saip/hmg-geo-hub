"""N1 회귀(2차 검증 e97deb8): shadows_owned 의 dim_source 보강 판정이 오버라이드 행마다 dim_source 전체를 훑지 않아야 한다.

재현(검증자): rd.dim_source 비당사 합성 30만 행 + 오버라이드 300행에서 서픽스 비교(right(domain, len(skey)+1))는
SubPlan Seq Scan on dim_source loops=301 로 2.8s(부하 시 7~9s, api_ro statement_timeout 5s 초과).
여기서는 메모리 여유를 위해 3만 행 + 오버라이드 300행으로 같은 계획 모양을 확인한다(ANALYZE 뒤, 롤백 전용).
준비 뒤 요청 경로와 같은 api_ro 롤로 EXPLAIN ANALYZE 한다. rd 쓰기·ANALYZE 준비 문장은 n1_synthetic.pgsql(정적 가드 밖)에 둔다.

기대:
  1) 현행 CANDIDATES_SQL(EMPTY_CTE, lim 50) 계획에서 rd.dim_source 는 dim_source_skey_key 인덱스 조회로만 읽히고 Seq Scan 이 없다.
  2) 수정 전 서픽스 식(아래 OLD_CASE, e97deb8 원문)은 같은 데이터에서 dim_source Seq Scan 을 오버라이드 수만큼 돈다(재현 증거).
  3) 판정 결과는 수정 전 식과 행 단위로 같다(의미 유지: 서픽스·적재 이력 없는 당사 도메인·소셜 제외·문자열 우연 일치 거짓).
"""
from __future__ import annotations

import json
import pathlib

from app.features.admin.citation_sources.overrides import queries
from tests.support import Rows, Sql, load_named_sql, needs_db, raw_fetch, staged

pytestmark = needs_db

N_SRC = 30_000          # 비당사 합성 출처 행
N_OV = 300              # 합성 오버라이드 행(비당사 서브도메인)

# e97deb8 의 shadows_owned CASE 원문(독립 기대값·재현용). 수정 후 식과 결과가 같아야 한다.
OLD_CASE = """CASE WHEN r.has_override
            THEN EXISTS (SELECT 1 FROM app.owned_base ob CROSS JOIN LATERAL (SELECT regexp_replace(lower(ob.host), '^www\\.', '') AS h) x
                          WHERE ob.kind = 'base' AND x.h <> ''
                            AND (x.h = r.domain OR right(r.domain, length(x.h) + 1) = '.' || x.h))
              OR EXISTS (SELECT 1 FROM rd.dim_source so
                          WHERE so.owned_brand_bit <> 0 AND NOT so.is_social AND so.skey <> ''
                            AND (so.skey = r.domain OR right(r.domain, length(so.skey) + 1) = '.' || so.skey))
            ELSE false END AS shadows_owned"""

# 경계 사례(당사 비트 보강 경로 ② 와 owned_base 경로 ① 을 함께): 도메인 → 기대 판정
EDGE = {
    "deep.a.n1own.example": True,      # ② 보강 출처 키의 2단 서브도메인
    "n1own.example": True,             # ② 정확 일치
    ".n1own.example": True,            # 선행 점(서픽스 '.n1own.example' 일치)
    "xn1own.example": False,           # 문자열 끝만 같음
    "n1own.example.evil": False,       # 당사 키를 접두로 가진 타 도메인
    "n1own.example.": False,           # 후행 점(빈 라벨은 후보에서 빠진다)
    "n1soc.example": False,            # 소셜 키는 당사 비트가 있어도 제외
    "m.news.hyundai.com": True,        # ① owned_base host 의 서브도메인
    "genesis.com": True,               # ① 적재 이력 없는 당사 도메인
    "com": False,                      # 등록 도메인의 상위 라벨만
}

# rd 쓰기·ANALYZE 준비 문장은 데이터 파일(정적 가드 밖, back/tests/README.md 6절), 오버라이드 행은 Rows 구조체로 넣는다.
M = load_named_sql(pathlib.Path(__file__).with_name("n1_synthetic.pgsql"))
PREP = [
    Sql(M["dim_source_synthetic"], (N_SRC,)),
    Sql(M["dim_source_edge"]),
    Rows("app.citation_domain_override",
         [{"domain": f"www{g}.n1s{g}.n1syn.example", "category_key": 5, "note": "n1 synthetic"} for g in range(1, N_OV + 1)]
         + [{"domain": d, "category_key": 5, "note": "n1 edge"} for d in EDGE]),
    Sql(M["analyze"]),
]


def _sql(case_sql: str | None = None) -> str:
    s = queries.CANDIDATES_SQL.format(cte=queries.EMPTY_CTE)
    if case_sql is not None:
        start = s.index("       CASE WHEN r.has_override")
        end = s.index("AS shadows_owned") + len("AS shadows_owned")
        s = s[:start] + "       " + case_sql + s[end:]
    return s.replace("CAST(:lim AS int4)", "50").replace("CAST(:cats AS int2[])", "CAST(NULL AS int2[])")


def _nodes(plan: dict):
    yield plan
    for ch in plan.get("Plans", []):
        yield from _nodes(ch)


async def _plan(conn, sql: str) -> list[dict]:
    rows = await raw_fetch(conn, "EXPLAIN (ANALYZE, FORMAT JSON) " + sql)
    doc = rows[0]["QUERY PLAN"]
    return list(_nodes((json.loads(doc) if isinstance(doc, str) else doc)[0]["Plan"]))


def _dim_source_scans(nodes: list[dict]) -> list[dict]:
    return [n for n in nodes if n.get("Relation Name") == "dim_source"]


async def test_n1_shadows_owned_uses_skey_index(client_as):
    async with staged(*PREP) as conn:
        nodes = await _plan(conn, _sql())
        new_scans = _dim_source_scans(nodes)
        assert new_scans, "dim_source 부속 조회가 계획에 있어야 한다"
        assert not [n for n in new_scans if n["Node Type"] == "Seq Scan"], new_scans
        assert all(n["Node Type"] in ("Index Scan", "Index Only Scan", "Bitmap Heap Scan") for n in new_scans), new_scans
        # 인덱스 이름은 Index Scan 노드 또는 Bitmap Heap Scan 아래 Bitmap Index Scan 노드에 붙는다
        idx = [n for n in nodes if n.get("Index Name") == "dim_source_skey_key"]
        assert idx and all(n["Actual Loops"] <= N_OV + len(EDGE) + 1 for n in idx), idx

        # 재현 증거: 수정 전 식은 dim_source 를 오버라이드 행마다 전체 스캔한다
        old_scans = _dim_source_scans(await _plan(conn, _sql(OLD_CASE)))
        seq = [n for n in old_scans if n["Node Type"] == "Seq Scan"]
        assert seq and max(n["Actual Loops"] for n in seq) >= N_OV


async def test_n1_shadows_owned_same_result_as_suffix_form(client_as):
    async with staged(*PREP) as conn:
        new = {r["domain"]: r["shadows_owned"] for r in await raw_fetch(conn, _sql()) if r["has_override"]}
        old = {r["domain"]: r["shadows_owned"] for r in await raw_fetch(conn, _sql(OLD_CASE)) if r["has_override"]}
        assert new == old
        assert len(new) >= N_OV + len(EDGE)
        assert {d: new[d] for d in EDGE} == EDGE
        assert not any(v for d, v in new.items() if d.endswith(".n1syn.example"))
