"""동기화 S1 BE-B(hmg-geo 2670a16 #320·#321, 제품 책임자 Q1 (a)·Q2 (a)): 글로벌 ⑤ 분자 = 출처 카테고리 Official (HMG) 인용 수.

이 파일(core 대분류)은 DB 패치·빌더·결과 캐시 규약을 본다. 값 동치(API)는 app/features/analytics/kpi/summary/tests/test_sync_s1_m05.py,
적재·재판정·채우기·R7 대조는 ingest/project/apply/tests/test_sync_s1_official.py.

  1. 합본 DB-v2.13.sql = DB-v2.12.sql + 패치(바이트), 패치 재적용 거부, 불변식(열 = 자식 합) 단언이 cit_off 어긋남을 잡는다, 행 CHECK
  2. 빌더: 글로벌 main 문장은 cit_m05 = Σ cit_off(국가 좁힘·cross 보정 없음), website·project 는 표면 자사 식. 원소 스캔은 OFFICIAL_SOURCES
  3. 결과 캐시: cit_off 를 쓰는 위치는 FINALIZE_WRITERS 분류 안(INSERT_ANSWER 하나), 새 읽기(app.citation_category·rd.dim_source)는 추적 표.
     rcache_writers 가 읽는 합본이 최신(DB-v2.13)이고 새 DB 함수는 rd 를 쓰지 않는다. 채우기 SQL 은 대역 밖이라 무효화 절차를 머리말에 적는다
"""
from __future__ import annotations

import ast
import pathlib
import textwrap
from datetime import date

import asyncpg
import pytest

from app.core.cycles import CycleRow, build_window
from app.core.measure import OFFICIAL_SOURCES, MeasureScope, OwnerScope, citation_counts_sql, plan_counts
from tests.core import rcache_writers as w
from tests.core.test_result_cache_tables import parse_refs
from tests.support import DB_URL, needs_db

BACK = pathlib.Path(__file__).resolve().parents[2]
DB = BACK / "db"


# ════════════════════════════════════════════════════════════════════════════
# 1. DB 패치
# ════════════════════════════════════════════════════════════════════════════
def test_merged_ddl_is_previous_plus_patch():
    assert (DB / "DB-v2.13.sql").read_bytes() == (DB / "DB-v2.12.sql").read_bytes() + (DB / "DB-v2.13-patch.sql").read_bytes()
    src = (DB / "DB-v2.13-patch.sql").read_text(encoding="utf-8")
    assert "result_cache_invalidate" in src and "fill-cit-off.sql" in src           # 머리말: 무효화·채우기 절차


@needs_db
async def test_patch_refuses_reapply_and_invariant_catches_cit_off():
    c = await asyncpg.connect(DB_URL)
    try:
        with pytest.raises(asyncpg.RaiseError, match="DB-v2.13 이미 적용됨"):
            await c.execute((DB / "DB-v2.13-patch.sql").read_text(encoding="utf-8"))
        await c.execute("ROLLBACK")
        k = await c.fetchval("SELECT answer_key FROM rd.answer WHERE cit_off > 0 ORDER BY answer_key LIMIT 1")
        assert k is not None                                                          # 합성 픽스처에 공식 인용 답변이 있다(비어 있지 않은 단언)
        tr = c.transaction()
        await tr.start()
        try:
            assert await c.fetchval("SELECT rd.assert_answer_cit_counts($1::int4[], true)", [k]) == 1
            await c.execute("UPDATE rd.answer SET cit_off = cit_off - 1 WHERE answer_key = $1", k)
            with pytest.raises(asyncpg.RaiseError, match="자식 합"):
                await c.fetchval("SELECT rd.assert_answer_cit_counts($1::int4[], true)", [k])
        finally:
            await tr.rollback()
        tr = c.transaction()
        await tr.start()
        try:
            with pytest.raises(asyncpg.CheckViolationError, match="answer_cit_off_bounds"):
                await c.execute("UPDATE rd.answer SET cit_off = cit_n + 1 WHERE answer_key = $1", k)
        finally:
            await tr.rollback()
        cols = await c.fetchval("SELECT proargnames FROM pg_proc WHERE oid = 'rd.answer_cit_counts(int4[])'::regprocedure")
        assert cols[-1] == "cit_off"
        assert not await c.fetchval("SELECT has_function_privilege('api_ro', 'rd.answer_cit_counts(int4[])', 'execute')")
    finally:
        await c.close()


# ════════════════════════════════════════════════════════════════════════════
# 2. 빌더(DB 없음)
# ════════════════════════════════════════════════════════════════════════════
def _win(sf: str = "global"):
    return build_window(surface=sf, mode="snapshot", rows=[CycleRow(11, 1, date(2026, 9, 14), 0)], lo=date(2026, 9, 14),
                        hi=date(2026, 9, 14), generation=1, project_keys=(1,))


def _select_cols(sql: str) -> dict[str, str]:
    """SELECT 목록(최상위 쉼표로 나눔) → {별칭: 식}."""
    head = sql.split("SELECT ", 1)[1].split("\n  FROM ", 1)[0]
    parts, depth, cur = [], 0, ""
    for ch in head:
        depth += (ch == "(") - (ch == ")")
        if ch == "," and depth == 0:
            parts.append(cur.strip())
            cur = ""
        else:
            cur += ch
    parts.append(cur.strip())
    return {p.rsplit(" AS ", 1)[1]: p.rsplit(" AS ", 1)[0] for p in parts if " AS " in p}


def _ms(sf: int = 1, *, countries=None, lang=False, source=None) -> MeasureScope:
    owner = OwnerScope(keys=(9, 193), own_bits=(1,), countries=countries, country_narrowed=bool(countries), lang_narrowed=lang) \
        if sf == 1 else None
    return MeasureScope(sf=sf, project_keys=(1,), own_bits=(1,), bgrps=(1, 8, 9), pop_bits=(1, 8), owner=owner,
                        source_category_keys=source)


def test_global_numerator_is_official_column_everywhere():
    for ms in (_ms(), _ms(countries=("US",)), _ms(countries=("US", "DE"))):
        p = plan_counts(ms, _win(), parts=("citations",))
        main = dict(p.statements)["main"].text
        cols = _select_cols(main)
        assert cols["cit_m05"] == "coalesce(sum(a.cit_off), 0)", main   # 국가 1·N 이어도 공식(HMG) 답변 열 그대로(owner 좁힘·교차 FILTER 없음)
        assert "cit_own" in cols["cit_owned"]                          # 자사 cit_owned(C-3 등 종전 소비)는 그대로 둔다
    web = _select_cols(dict(plan_counts(_ms(2), _win("website"), parts=("citations",)).statements)["main"].text)
    assert web["cit_m05"] == web["cit_owned"] == "coalesce(sum(a.cit_loc_tgt), 0)"            # website = 표면 자사
    prj = _select_cols(dict(plan_counts(_ms(3), _win("project"), parts=("citations",)).statements)["main"].text)
    assert prj["cit_m05"] == prj["cit_owned"] == "coalesce(sum(a.cit_loc), 0)"


def test_scan_paths_use_official_sources():
    for ms in (_ms(lang=True), _ms(source=(1, 6))):
        p = plan_counts(ms, _win(), parts=("citations",))
        roles = dict(p.statements)
        assert "main" in roles and "scan" in roles and "cit_m05" not in roles["main"].text
        assert f"c.source_key IN ({OFFICIAL_SOURCES})) AS cit_m05" in roles["scan"].text
    web = _select_cols(citation_counts_sql(_ms(2), _win("website")).text)
    assert web["cit_m05"] == web["cit_owned"] == "count(*) FILTER (WHERE (c.loc_owned OR c.tgt_hit))"   # website 스캔 = 표면 자사와 같은 판정
    assert "Official (HMG)" in OFFICIAL_SOURCES and "rd.dim_source" in OFFICIAL_SOURCES


# ════════════════════════════════════════════════════════════════════════════
# 3. 결과 캐시 규약(쓰기·읽기)
# ════════════════════════════════════════════════════════════════════════════
def _cit_off_writers(base: pathlib.Path, roots: tuple[str, ...] = w.ROOTS) -> set[tuple[str, str]]:
    """app·ingest 문자열 중 rd.answer 에 쓰면서 cit_off 를 이름으로 드는 것의 (파일, 기호). rcache_writers 와 같은 수집·기호 규칙."""
    from tests.core.test_guards import _strings

    out: set[tuple[str, str]] = set()
    for root in roots:
        for f in sorted((base / root).rglob("*.py")):
            rel = str(f.relative_to(base))
            if w._excluded(rel):
                continue
            tree = ast.parse(f.read_text(encoding="utf-8"))
            sym = w._symbols(tree)
            by_line: dict[int, str] = {}
            for n in ast.walk(tree):
                if hasattr(n, "lineno") and id(n) in sym:
                    by_line.setdefault(n.lineno, sym[id(n)])
            for s, line, _ in _strings(tree):
                if "cit_off" in s and "rd.answer" in ((w._ast_writes(s) or set()) | w._regex_writes(s)):
                    out.add((rel, by_line.get(line, "<module>")))
    return out


def test_cit_off_is_written_only_inside_finalize_writers():
    got = _cit_off_writers(BACK)
    assert got == {("ingest/project/apply/queries.py", "INSERT_ANSWER")}, got
    assert got <= set(w.FINALIZE_WRITERS)
    assert w.MERGED_DDL.name == "DB-v2.13.sql"                                   # 쓰기 스캔이 최신 합본의 rd 함수 본문을 본다
    fnw = w.db_function_writes()
    assert "answer_cit_counts" not in fnw and "_assert_answer_cit_counts" not in fnw   # 새 함수 본문은 rd 를 쓰지 않는다
    assert {"app.citation_category", "rd.dim_source", "app.citation_domain_override"} <= w.tracked_tables()


def test_cit_off_scan_catches_new_writer(tmp_path):
    f = tmp_path / "ingest" / "x" / "fix.py"
    f.parent.mkdir(parents=True)
    f.write_text(textwrap.dedent('''
        async def repair(conn):
            await conn.execute("UPDATE rd.answer SET cit_off = 0 WHERE answer_key = ANY($1)", [])
        '''), encoding="utf-8")
    assert _cit_off_writers(tmp_path, ("ingest",)) == {("ingest/x/fix.py", "repair")}
    assert ("ingest/x/fix.py", "repair") not in w.FINALIZE_WRITERS                # 분류 없는 새 쓰기 위치 = 실패 대상


def test_new_reads_are_covered_tables():
    tracked = w.tracked_tables()
    covered = set(w.GENERATION_ONLY) | w.GENERATION_SOURCE | tracked
    for ms in (_ms(), _ms(lang=True), _ms(source=(1,)), _ms(countries=("US", "DE"))):
        for _, q in plan_counts(ms, _win(), parts=("citations", "mentions")).statements:
            rels, _, timey = parse_refs(q.text)
            assert rels <= covered and not timey, (rels - covered, timey)


def test_fill_sql_is_batched_asserted_and_documents_invalidation():
    src = (BACK / "migration" / "fill-cit-off.sql").read_text(encoding="utf-8")
    body = src.split("DO $f$", 1)[1].split("$f$;", 1)[0]
    assert body.index("UPDATE rd.answer") < body.index("rd.assert_answer_cit_counts(keys, true)") < body.index("COMMIT;")
    assert "IS DISTINCT FROM" in body                                            # 값이 다른 행만(멱등)
    assert "result_cache_invalidate" in src and "\\if :commit" in src            # 대역 밖 쓰기 뒤 무효화, 드라이런 기본
