"""결과 캐시 표 커버(누락 방지 핵심): 캐시 대상 엔드포인트가 읽는 표 전부가 데이터 버전 요소 또는 스코프 서명으로 덮이는지 단언한다.

읽는 표 = 두 경로의 합집합
  동적: 허용 목록 전 엔드포인트 × 대표 파라미터(tests/core/rcache_calls.py, 필터 축 분기 포함)를 캐시 끔으로 불러 실행된 문장 전부를
        pglast 로 파싱(RangeVar schema.relname·함수 호출·SQLValueFunction), 뷰는 pg_depend 로, SQL 함수는 본문 파싱으로 재귀 전개.
  정적: 캐시 대상 기능 패키지(표식 끝점의 폴더 전체)와 분석 읽기 core 모듈(measure·cycles·filters·codes)의 문자열 상수 속 rd.·app.·ext. 이름
        (실행되지 않은 분기의 표까지). 카탈로그에 있는 관계·함수만 남긴다.
분류(하나라도 못 하면 실패)
  g   rd.surface_generation(세대 원천) 과 세대 전용 사실 표(rcache_writers.GENERATION_ONLY: 쓰기 위치 전부를 test_result_cache_writers 가
      같은 트랜잭션 finalize 분류로 강제)
  tv  rcache.tg_bump 문장 트리거가 걸린 표(DB 카탈로그 = 패치 P67 목록, 둘이 같음을 단언)
  d   rd.today_kst()(KST 오늘)
  sig 계정 스코프 서명으로 덮이는 표(요청마다 같은 스냅샷에서 다시 읽어 서명을 만든다: SIGNATURE)
ing·ext·그 밖 표는 캐시 대상에서 읽히면 안 된다. 제외한 엔드포인트가 실제로 덮이지 않는 표를 읽는다는 것도 같이 본다(제외 사유의 실측).
시각·난수(now()·current_date·current_timestamp·localtimestamp·clock_timestamp()·statement_timestamp()·transaction_timestamp()·timeofday()·
random()·gen_random_uuid()·'now'/'today' 형변환 등)는 실행 문장·전개한 SQL 함수 본문 어디에도 없어야 한다(KST 날짜 요소 rd.today_kst 본문만 예외).
뷰는 읽지 않아야 한다(뷰 정의 속 시각 함수·ing 참조를 이 시험이 보지 못하므로, 읽게 되면 멈추고 전개 규칙부터 넓힌다).
"""
from __future__ import annotations

import ast
import importlib
import pathlib
import re

import asyncpg
import pytest

from app.core.sqlguard import _to_dollar
from tests.core.rcache_calls import BACK, Stmts, all_calls, feature_routes, get, materialize, resolve_skey
from tests.core.rcache_writers import GENERATION_ONLY, GENERATION_SOURCE, NOT_CACHED, tracked_tables
from tests.support import ADMIN, DB_URL, needs_db

SIGNATURE: dict[str, str] = {
    "app.user_account": "계정 행 → core.result_cache.scope_signature(DataScope.of(계정, 참조).for_surface): 요청마다 같은 스냅샷에서 다시 읽는다",
    "app.project": "project 표면: resolve_project 결과(ProjectAccess 전부: 프로젝트·키·브랜드·국가·멤버 역할·Scope id)를 서명에 싣는다",
    "app.project_member": "project 표면: 멤버 여부·역할이 ProjectAccess.member_role 로 서명에 실린다(비가시면 게이트가 캐시를 건너뛴다)",
    # WU-8 현행 프로필 filter_options: /v1/filters/options website 요청만 읽는다. 끝점 추가 키(key_deps legacy_web)가 요청마다 같은 스냅샷에서
    # 두 표 지문(md5)을 다시 읽어 키에 싣는다(options/queries.py LEGACY_WEBSITE_VERSION_SQL)
    "app.website_site": "options website(현행 프로필): 끝점 추가 키 legacy_web = 등록 사이트·프롬프트 언어 지문(요청마다 다시 읽음)",
    "app.website_prompt": "options website(현행 프로필): 끝점 추가 키 legacy_web = 등록 사이트·프롬프트 언어 지문(요청마다 다시 읽음)",
}
DATE_FUNCS = {"rd.today_kst": "d = to_char(rd.today_kst(), 'YYYY-MM-DD')"}
# 호출마다·시각마다 값이 달라지는 함수(스키마 없음·pg_catalog). now() 는 STABLE 이라 휘발성으로는 못 거른다
TIME_FUNCS = frozenset({"now", "clock_timestamp", "statement_timestamp", "transaction_timestamp", "timeofday", "random", "random_normal",
                        "setseed", "gen_random_uuid", "uuidv4", "uuidv7", "pg_backend_pid", "txid_current", "pg_current_xact_id",
                        "current_setting", "age"})
TIME_LITERALS = frozenset({"now", "today", "tomorrow", "yesterday", "epoch"})
CORE_READ = ("measure.py", "cycles.py", "filters.py", "codes.py")
_NAME = re.compile(r"\b(rd|app|ext|ing)\.([a-z_][a-z0-9_]*)\b")


def parse_refs(sql: str) -> tuple[set[str], set[str], set[str]]:
    """문장 → (스키마 한정 관계, 스키마 한정 함수(pg_catalog 밖), 시각·난수 사용). 스키마 없는 RangeVar 는 CTE 이름(스키마 없는 실표는 없다)."""
    from pglast import ast as pa
    from pglast import parse_sql
    from pglast.enums import SQLValueFunctionOp

    rels: set[str] = set()
    funcs: set[str] = set()
    timey: set[str] = set()

    def walk(n: object) -> None:
        if isinstance(n, (list, tuple)):
            for c in n:
                walk(c)
            return
        if not isinstance(n, pa.Node):
            return
        if isinstance(n, pa.RangeVar) and n.schemaname:
            rels.add(f"{n.schemaname.lower()}.{n.relname.lower()}")
        if isinstance(n, pa.FuncCall):
            names = [getattr(x, "sval", "").lower() for x in n.funcname]
            if len(names) == 2 and names[0] != "pg_catalog":
                funcs.add(".".join(names))
            elif names and names[-1] in TIME_FUNCS and not (names[-1] == "age" and len(n.args or ()) == 2):
                timey.add(".".join(names))
        if isinstance(n, pa.SQLValueFunction):
            op = SQLValueFunctionOp(n.op).name
            if "TIME" in op or "DATE" in op:
                timey.add(op)
        if isinstance(n, pa.TypeCast) and isinstance(n.arg, pa.A_Const) and isinstance(n.arg.val, pa.String) \
                and n.arg.val.sval.strip().lower() in TIME_LITERALS:
            timey.add(f"'{n.arg.val.sval}'::")
        for a in n:
            v = getattr(n, a, None)
            if isinstance(v, (pa.Node, list, tuple)):
                walk(v)

    walk(parse_sql(_to_dollar(sql)))
    return rels, funcs, timey


def static_names() -> set[str]:
    files = {pathlib.Path(importlib.import_module(r.endpoint.__module__).__file__).parent
             for r in feature_routes() if getattr(getattr(r, "endpoint", None), "__hgh_result_cache__", None) is not None}
    paths = sorted(f for d in files for f in d.glob("*.py")) + [BACK / "app" / "core" / m for m in CORE_READ]
    out: set[str] = set()
    for f in paths:
        tree = ast.parse(f.read_text(encoding="utf-8"))
        docs = {id(n.body[0].value) for n in ast.walk(tree)
                if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.body
                and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
        for n in ast.walk(tree):
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docs:
                out |= {f"{m.group(1)}.{m.group(2)}" for m in _NAME.finditer(n.value)}
    return out


async def expand(c: asyncpg.Connection, rels: set[str], funcs: set[str],
                 fn_time: dict[str, set[str]] | None = None) -> tuple[dict[str, str], dict[str, str]]:
    """관계·함수 → ({실표·뷰: 종류}, {함수: 휘발성}). 뷰는 기반 관계로, SQL 함수는 본문 관계로 재귀 전개. plpgsql 등 본문을 못 읽는 함수는 실패.
    fn_time 을 주면 {함수: 본문의 시각·난수 사용}을 채운다."""
    tables: dict[str, str] = {}
    seen_funcs: dict[str, str] = {}
    todo_r, todo_f = set(rels), set(funcs)
    while todo_r or todo_f:
        while todo_r:
            name = todo_r.pop()
            row = await c.fetchrow("SELECT c.oid, c.relkind::text AS relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                                   "WHERE n.nspname || '.' || c.relname = $1", name)
            if row is None:
                continue                                              # 카탈로그에 없는 이름(열·별칭 조각)
            kind = row["relkind"]
            if kind in ("v", "m"):
                deps = await c.fetch("SELECT DISTINCT n.nspname || '.' || d.relname AS name FROM pg_rewrite r "
                                     "JOIN pg_depend p ON p.objid = r.oid AND p.classid = 'pg_rewrite'::regclass "
                                     "JOIN pg_class d ON d.oid = p.refobjid JOIN pg_namespace n ON n.oid = d.relnamespace "
                                     "WHERE r.ev_class = $1 AND d.oid <> $1", row["oid"])
                todo_r |= {d["name"] for d in deps if d["name"] not in tables}
                tables[name] = "view"
            elif kind in ("r", "p", "f", "u"):
                tables[name] = kind
        while todo_f:
            f = todo_f.pop()
            if f in seen_funcs:
                continue
            rows = await c.fetch("SELECT p.prosrc, l.lanname, p.provolatile::text AS vol FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                                 "JOIN pg_language l ON l.oid = p.prolang WHERE n.nspname || '.' || p.proname = $1", f)
            seen_funcs[f] = ",".join(sorted({r["vol"] for r in rows}))
            for r in rows:
                if r["lanname"] == "sql":
                    rr, ff, tt = parse_refs(r["prosrc"])
                    if fn_time is not None and tt:
                        fn_time.setdefault(f, set()).update(tt)
                    todo_r |= rr - set(tables)
                    todo_f |= ff - set(seen_funcs)
                elif r["lanname"] != "internal":
                    raise AssertionError(f"캐시 대상이 부르는 {f} 는 {r['lanname']} 함수: 읽는 표를 정적으로 알 수 없다(분류 필요)")
    return tables, seen_funcs


async def read_set(client_as, calls: list[tuple[object, str, dict]]) -> tuple[set[str], set[str], list[str], set[str]]:
    rels: set[str] = set()
    funcs: set[str] = set()
    timey: set[str] = set()
    with Stmts() as st:
        for u, path, prm in calls:
            r = await get(client_as, u, path, prm)
            assert r.status_code == 200, (path, prm, r.text[:200])
    for s in st.seen:
        rr, ff, tt = parse_refs(s)
        rels |= rr
        funcs |= ff
        timey |= tt
    return rels, funcs, st.seen, timey


def classify(name: str, triggered: set[str]) -> str | None:
    if name in GENERATION_SOURCE or name in GENERATION_ONLY:
        return "g"
    if name in triggered:
        return "tv"
    if name in SIGNATURE:
        return "sig"
    return None


@needs_db
async def test_every_table_read_by_cached_endpoints_is_covered(client_as, rcache_db):
    skey = await resolve_skey(client_as)
    calls = [(u, materialize(p, skey), prm) for u, p, prm in all_calls()]
    rels, funcs, seen, timey = await read_set(client_as, calls)
    assert len(seen) > 200 and not [s for s in seen if "result_cache" in s]       # 캐시 끔으로 잰다
    assert timey == set(), f"실행 문장이 시각·난수를 쓴다(데이터 버전은 KST 날짜만 덮는다): {sorted(timey)}"
    static = static_names()
    c = await asyncpg.connect(DB_URL)
    try:
        triggered = {r["t"] for r in await c.fetch("SELECT DISTINCT tgrelid::regclass::text AS t FROM pg_trigger "
                                                   "WHERE NOT tgisinternal AND tgfoid = 'rcache.tg_bump()'::regprocedure")}
        static_funcs = {n for n in static if await c.fetchval("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                                                              "WHERE n.nspname || '.' || p.proname = $1", n)}
        fn_time: dict[str, set[str]] = {}
        tables, all_funcs = await expand(c, rels | static, funcs | static_funcs, fn_time)
    finally:
        await c.close()
    assert triggered == set(tracked_tables()), sorted(set(triggered) ^ set(tracked_tables()))   # DB 카탈로그 = 패치 P67 목록
    views = sorted(t for t, k in tables.items() if k == "view")
    assert views == [], f"캐시 대상이 뷰를 읽는다(뷰 정의 속 시각 함수·원천을 이 시험이 보지 않는다: 전개 규칙을 넓히거나 대상에서 뺀다): {views}"
    assert {f: t for f, t in fn_time.items() if f not in DATE_FUNCS} == {}, fn_time
    base = {t for t, k in tables.items() if k != "view"}
    bad = sorted(t for t in base if classify(t, triggered) is None)
    assert bad == [], f"데이터 버전·서명으로 덮이지 않는 표: {bad}"
    assert not [t for t in base if t.startswith(("ing.", "ext."))]
    # 함수: 읽는 표는 위에서 전개됐다. 시간에 따라 값이 바뀌는 함수는 KST 날짜(d) 하나뿐이어야 한다(나머지는 IMMUTABLE)
    assert {f for f, vol in all_funcs.items() if vol != "i"} <= set(DATE_FUNCS), all_funcs
    assert "rd.today_kst" in all_funcs and "rd.surface_generation" in base
    # 커버 표(보고용 정본): 표 → 덮는 요소. 실제로 읽힌 app 표는 전부 트리거 또는 서명이다
    app_read = {t for t in base if t.startswith("app.")}
    assert app_read <= triggered | set(SIGNATURE), sorted(app_read - triggered - set(SIGNATURE))
    assert {"rd.dim_country", "rd.dim_region", "rd.dim_project"} <= base & triggered
    assert set(GENERATION_ONLY) <= base, sorted(set(GENERATION_ONLY) - base)   # 목록이 실제 읽기와 어긋나지 않게(죽은 항목 없음)
    assert not (base & set(NOT_CACHED)), sorted(base & set(NOT_CACHED))        # 쓰기 쪽 '캐시 비대상' 분류가 실제 조회와 겹치지 않는다


@needs_db
async def test_excluded_endpoints_read_uncovered_sources(client_as, rcache_db):
    """제외 사유의 실측: /v1/mentions/prompts(terms)·/v1/funnel/conversion 은 세대·카운터·서명 밖의 원천을 읽는다."""
    c = await asyncpg.connect(DB_URL)
    try:
        triggered = {r["t"] for r in await c.fetch("SELECT DISTINCT tgrelid::regclass::text AS t FROM pg_trigger "
                                                   "WHERE NOT tgisinternal AND tgfoid = 'rcache.tg_bump()'::regprocedure")}
        for path, prm, expect in (("/v1/mentions/prompts", {"surface": "global", "mode": "brand", "own": "true", "terms": "true"}, "ing."),
                                  ("/v1/funnel/conversion", {"surface": "global"}, "rd.ga4_")):
            async with client_as(ADMIN) as cl:
                with Stmts() as st:
                    r = await cl.get(path, params=prm)
            assert r.status_code == 200, (path, r.text[:200])
            rels: set[str] = set()
            for s in st.seen:
                rels |= parse_refs(s)[0]
            tables, _ = await expand(c, rels, set())                          # 뷰(rd.v_answer_mention_raw)는 기반 표로 전개
            unc = sorted(t for t, k in tables.items() if k != "view" and classify(t, triggered) is None)
            assert any(t.startswith(expect) for t in unc), (path, unc)
    finally:
        await c.close()


def test_generation_list_is_rd_only_and_signature_list_is_app_only():
    assert all(t.startswith("rd.") for t in GENERATION_ONLY)
    assert all(t.startswith("app.") for t in SIGNATURE)
    with pytest.raises(AssertionError):
        assert classify("rd.ga4_row", set()) is not None


def test_time_and_random_detection():
    """시각·난수 탐지 음성·양성 시험(스키마 없음·pg_catalog·SQLValueFunction·특수 문자열 형변환)."""
    for sql in ("SELECT now()", "SELECT pg_catalog.now()", "SELECT current_date", "SELECT CURRENT_TIMESTAMP", "SELECT localtimestamp",
                "SELECT clock_timestamp()", "SELECT statement_timestamp()", "SELECT transaction_timestamp()", "SELECT random()",
                "SELECT 1 FROM rd.cycle c WHERE c.view_date <= 'today'::date", "SELECT age(x) FROM t", "SELECT gen_random_uuid()"):
        assert parse_refs(sql)[2], sql
    for sql in ("SELECT rd.today_kst()", "SELECT age(a, b) FROM t", "SELECT to_char(x, 'YYYY') FROM t", "SELECT 'today' AS label",
                "SELECT count(*) FROM rd.answer a WHERE a.surface = 1"):
        assert parse_refs(sql)[2] == set(), sql
