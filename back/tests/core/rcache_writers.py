"""rd 쓰기 위치 정적 수집(결과 캐시 누락 방지, test_result_cache_writers.py 가 쓴다). DB 없이 소스만 읽는다.

수집 대상
  - app/**·ingest/** 의 .py 문자열(tests.core.test_guards._strings: 상수 접기·f-string 조각, 독스트링 제외)과 .sql 파일.
    시험 전용 코드(*/tests/*, conftest.py, ingest/testkit.py)는 빼고, app/core/sqlguard.py(진단 문구)도 뺀다.
  - 쓰기 문장: pglast AST 의 INSERT·UPDATE·DELETE·MERGE 대상(CTE 안 포함)·COPY FROM·TRUNCATE 대상. 파싱이 안 되는 조각은 같은 문장 머리
    정규식으로 한 번 더 본다(둘의 합집합). 스키마 rd 만.
  - DB 함수 경유 쓰기: 문자열이 rd.<함수>( 를 부르면 back/db 최신 합본(DB-v2.13.sql)의 그 함수 본문(마지막 정의)이 쓰는 rd 표를 그 위치의
    쓰기로 센다(본문이 부르는 다른 rd 함수까지 닫는다).
  - asyncpg COPY API(copy_records_to_table·copy_to_table) 호출(schema_name 인자 또는 'rd.x' 문자열).
위치 = (back 기준 파일 경로, 기호): 함수 안 문자열 = 감싼 함수의 점 경로(Class.func), 모듈 수준 = 대입 대상 이름(없으면 '<module>').

분류(이 파일이 정본, test_result_cache_writers.py 가 강제하고 test_result_cache_tables.py 가 조회 표와 잇는다)
  TRACKED           DB-v2.11 P67 문장 트리거 카운터가 걸린 표(패치 파일의 목록을 읽는다). 쓰기 위치 요구 없음(어느 경로로 바뀌어도 버전이 오른다)
  GENERATION_ONLY   세대(rd.surface_generation)만으로 덮는 사실 표. 쓰기 위치마다 FINALIZE_WRITERS 분류가 있어야 한다
  GENERATION_SOURCE rd.surface_generation(세대 원천, finalize 만 쓴다)
  NOT_CACHED        캐시 대상이 읽지 않는 rd 표(test_result_cache_tables 가 실제 조회와 겹치지 않음을 단언)
"""
from __future__ import annotations

import ast
import pathlib
import re
from dataclasses import dataclass

BACK = pathlib.Path(__file__).resolve().parents[2]
ROOTS = ("app", "ingest")
EXCLUDE = ("app/core/sqlguard.py", "ingest/testkit.py")
MERGED_DDL = BACK / "db" / "DB-v2.13.sql"          # 최신 합본(동기화 S1 BE-B DB-v2.13: rd.answer_cit_counts 교체)
_WRITE_RE = re.compile(r"(?i)\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?(?:\s+only)?|merge\s+into|copy)\s+rd\s*\.\s*"
                       r"(\{|[a-z_][a-z0-9_]*)")
_CALL_RE = re.compile(r"(?i)\brd\s*\.\s*([a-z_][a-z0-9_]*)\s*\(")


PATCH_V211 = BACK / "db" / "DB-v2.11-patch.sql"
# 뒤 패치가 같은 P67 규약(FOREACH 배열 + 문장 트리거 4개)으로 더한 추적 표. DB-v2.16 = WU-7 WEBREG16 표 3개, DB-v2.21 = 동결 세대 frz.generation,
# DB-v2.25 = 엔티티 합계 rd.entity_mention_total, DB-v2.30 = 창 판정 기초 rd.cycle_pick_basis
PATCHES_LATER = (BACK / "db" / "DB-v2.16-patch.sql", BACK / "db" / "DB-v2.20-patch.sql", BACK / "db" / "DB-v2.21-patch.sql",
                 BACK / "db" / "DB-v2.25-patch.sql", BACK / "db" / "DB-v2.30-patch.sql")


def tracked_tables() -> frozenset[str]:
    """DB-v2.11 P67 트리거 대상 목록(패치 파일의 FOREACH 배열) ∪ 뒤 패치(PATCHES_LATER)가 같은 규약으로 더한 표."""
    out: set[str] = set()
    for i, path in enumerate((PATCH_V211, *PATCHES_LATER)):
        src = path.read_text(encoding="utf-8")
        m = re.search(r"FOREACH t IN ARRAY ARRAY\[(.*?)\] LOOP", src, re.S)
        assert m is not None or i > 0, "P67 목록을 찾지 못했다"
        if m is not None:
            out |= set(re.findall(r"'([a-z_]+\.[a-z_]+)'", m.group(1)))
    return frozenset(out)


_PROJECT = ("apply.service.project() 안(적재 트랜잭션). project 는 끝에서 ctx.rd_changed = res.jobs·answers·rep_flips·surfaces"
            "(_ig_job ∪ _ig_old ∪ ACR_SURFACES) 이면 참(ingest/project/apply/service.py:220-223·249): 이 사실 쓰기가 행을 바꾸면 그 job·옛 좌표·"
            "ACR 셀 표면이 surfaces 에 들어간다. 호출 = apply·reproject·rejudge → 같은 트랜잭션 끝 finalize(ingest/common/db.py:143-162 세대 +1): "
            "pull/sync/service.py load_run·sync_prompts(둘째 트랜잭션), cycles/workers/service.py cycles_tick·process_change")
_ACR = "apply.service._project_acr() 안(project 가 부른다). ACR 쓰기 표면은 ACR_SURFACES 로 res.surfaces(service.py:249) → " + _PROJECT
_ECAT = ("엔티티 버전 반영 원장 열 rd.answer.ecat_ver(대기 표시 = −새 버전, 표시 = 새 버전): 조회가 읽지 않는 열(DB-v2.17 P101)이라 세대가 오르지 "
         "않아도 캐시 값이 틀리지 않는다. 쓰기는 ecat_engine._start·_abandon·_advance 안(한 청크 = judgment_change 'entity_version' 한 처리): 호출 = "
         "handle → cycles/workers/service.py _dispatch → process_change(같은 트랜잭션 끝 finalize). 같은 트랜잭션의 project 재투영이 "
         "ctx.rd_changed·surfaces 로 세대를 올린다")
_LEDGER_SEAT = ("답변분석 경로 셀 대표 재선정(현행 프로필 rep_round_date_cell, WU-12): ledger.project_cycles 가 서빙·숨김·좌석이 바뀐 회차를 투영한 뒤 "
                "그 자리만 rd.reselect_rep_seat + rd.propagate_answer_gates. 같은 project_cycles 가 바뀐 회차마다 ctx.surfaces·rd_changed 를 세운다"
                "(ingest/cycles/ledger/service.py project_cycles 루프) → 호출 = reevaluate·handle_cycle_admin → process_change·cycles_tick 의 "
                "같은 트랜잭션 끝 finalize(세대 +1)")
GENERATION_ONLY: dict[str, str] = {t: "사실 표: 쓰기 전부가 apply.project()·_project_acr 안(FINALIZE_WRITERS)" for t in
                                   ("rd.answer", "rd.answer_brand", "rd.answer_stance", "rd.citation", "rd.job", "rd.acr_cell", "rd.acr_choice")}
# 인용 계열 셀 대표 보정(DB-v2.19 P109): 쓰기 = rd.reselect_rep_seat 만(적재기 REP_UPDATE_SEAT = project() 안, 원장 _reselect_changed_seats = 위 근거,
# 재구축 seed-40·재투영 fill-v219-rep.sql = 끝에 app.result_cache_invalidate). rd.answer.is_rep 과 같은 문장 범위에서 바뀐다
GENERATION_ONLY["rd.rep_cit_delta"] = "인용 계열 셀 대표 보정: rd.answer.is_rep 과 같은 트랜잭션(rd.reselect_rep_seat)에서만 바뀐다(FINALIZE_WRITERS)"
GENERATION_SOURCE = frozenset({"rd.surface_generation"})
NOT_CACHED: dict[str, str] = {
    "rd.acr_cell_job": "ACR 셀 ↔ 답변 연결(검수·적재 전용). /v1/funnel/acr 는 acr_cell·acr_choice 만 읽는다",
    "rd.dim_keyword": "키워드 도구(intent·admin keyword_tools, 캐시 대상 아님)",
    "rd.kw_serp": "키워드 도구(DataForSEO dfs, 세대를 올리지 않는다)",
    "rd.kw_suggestion": "키워드 도구(DataForSEO dfs)",
    "rd.kw_volume_monthly": "키워드 도구(DataForSEO dfs)",
}
# 세대만으로 덮는 표의 쓰기 위치 분류(파일, 기호) → 근거. 새 쓰기 위치는 여기 없으면 시험이 실패한다
FINALIZE_WRITERS: dict[tuple[str, str], str] = {
    **{("ingest/project/apply/queries.py", c): _PROJECT for c in ("DELETE_OLD", "INSERT_ANSWER", "INSERT_BRAND", "INSERT_CITATION", "INSERT_JOB",
                                                                  "INSERT_STANCE", "REP_UPDATE",
                                                                  "REP_UPDATE_LATEST_FIRST")},
    **{("ingest/project/apply/queries.py", c): _ACR for c in ("ACR_DELETE", "ACR_INSERT_CELL", "ACR_INSERT_REST", "ACR_REP")},
    ("ingest/project/apply/service.py", "_write_facts"): "rd.propagate_answer_gates(served 키) 호출(project 의 뒤 단계): " + _PROJECT,
    **{("ingest/project/apply/ecat_engine.py", c): _ECAT for c in ("MARK_PENDING", "STAMP_CHUNK")},
    ("ingest/cycles/ledger/service.py", "_reselect_changed_seats"): _LEDGER_SEAT,
}
# 위 상수를 쓰는(참조하는) 함수는 이것뿐이어야 하고, 이 함수들의 호출 사슬(ingest 안, 이름 기준)은 finalize 를 부르는 적재 트랜잭션 함수에서 끝나야 한다
WRITER_FUNCS: frozenset[tuple[str, str]] = frozenset({("ingest/project/apply/service.py", "project"),
                                                      ("ingest/project/apply/service.py", "_write_facts"),
                                                      ("ingest/project/apply/service.py", "_project_acr"),
                                                      ("ingest/project/apply/ecat_engine.py", "_start"),
                                                      ("ingest/project/apply/ecat_engine.py", "_abandon"),
                                                      ("ingest/project/apply/ecat_engine.py", "_advance"),
                                                      ("ingest/cycles/ledger/service.py", "_reselect_changed_seats")})
FINALIZE_CALLERS: frozenset[tuple[str, str]] = frozenset({("ingest/pull/sync/service.py", "load_run"), ("ingest/pull/sync/service.py", "sync_prompts"),
                                                          ("ingest/cycles/workers/service.py", "cycles_tick"),
                                                          ("ingest/cycles/workers/service.py", "process_change"),
                                                          ("ingest/project/apply/wu5_reproject.py", "run")})   # WU-5 투영 스위치 전환 재투영(같은 트랜잭션 finalize)


@dataclass(frozen=True)
class Write:
    table: str          # rd.x 또는 rd.{동적}
    path: str           # back 기준
    symbol: str
    line: int
    via: str            # sql | regex | fn:<함수> | copy


def _excluded(rel: str) -> bool:
    parts = rel.split("/")
    return "tests" in parts or rel.endswith("conftest.py") or rel in EXCLUDE


def _ast_writes(sql: str) -> set[str] | None:
    """pglast 로 쓰기 대상(rd 만). 파싱 실패 = None."""
    from pglast import ast as pa
    from pglast import parse_sql
    from pglast.parser import ParseError

    from app.core.sqlguard import _to_dollar
    try:
        stmts = parse_sql(_to_dollar(sql))
    except (ParseError, ValueError):
        return None
    out: set[str] = set()

    def rel(rv: object) -> None:
        if isinstance(rv, pa.RangeVar) and (rv.schemaname or "").lower() == "rd":
            out.add(f"rd.{rv.relname.lower()}")

    def walk(n: object) -> None:
        if isinstance(n, (list, tuple)):
            for c in n:
                walk(c)
            return
        if not isinstance(n, pa.Node):
            return
        if isinstance(n, (pa.InsertStmt, pa.UpdateStmt, pa.DeleteStmt, pa.MergeStmt)) or isinstance(n, pa.CopyStmt) and n.is_from:
            rel(n.relation)
        elif isinstance(n, pa.TruncateStmt):
            for r in n.relations or ():
                rel(r)
        for a in n:
            v = getattr(n, a, None)
            if isinstance(v, (pa.Node, list, tuple)):
                walk(v)

    walk(stmts)
    return out


def _regex_writes(sql: str) -> set[str]:
    return {f"rd.{m.group(1).lower()}" if m.group(1) != "{" else "rd.{동적}" for m in _WRITE_RE.finditer(sql)}


def db_function_writes() -> dict[str, set[str]]:
    """합본 DDL 의 rd 함수 → 본문이 쓰는 rd 표(마지막 정의, 본문이 부르는 rd 함수까지 닫음)."""
    from pglast import ast as pa
    from pglast import parse_sql

    direct: dict[str, set[str]] = {}
    calls: dict[str, set[str]] = {}
    for raw in parse_sql(MERGED_DDL.read_text(encoding="utf-8")):
        s = raw.stmt
        if not isinstance(s, pa.CreateFunctionStmt):
            continue
        names = [getattr(x, "sval", "") for x in s.funcname]
        if len(names) != 2 or names[0] != "rd":
            continue
        body = ""
        for opt in s.options or ():
            if opt.defname == "as":
                body = " ".join(getattr(x, "sval", "") for x in (opt.arg if isinstance(opt.arg, (list, tuple)) else [opt.arg]))
            if opt.defname == "sql_body" and opt.arg is not None:
                body = str(opt.arg)
        fn = names[1].lower()
        direct[fn] = _regex_writes(body)
        calls[fn] = {m.group(1).lower() for m in _CALL_RE.finditer(body)} - {fn}
    closed: dict[str, set[str]] = {}
    for fn in direct:
        seen, todo, acc = {fn}, [fn], set()
        while todo:
            f = todo.pop()
            acc |= direct.get(f, set())
            for g in calls.get(f, ()):
                if g not in seen:
                    seen.add(g)
                    todo.append(g)
        closed[fn] = acc
    return {k: v for k, v in closed.items() if v}


def _symbols(tree: ast.AST) -> dict[int, str]:
    """노드 id → 위치 기호(감싼 함수 점 경로 또는 모듈 수준 대입 이름)."""
    out: dict[int, str] = {}

    def visit(node: ast.AST, scope: list[str], target: str | None) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                visit(child, [*scope, child.name], None)
                continue
            t = target
            if not scope and isinstance(child, (ast.Assign, ast.AnnAssign)):
                tg = child.targets[0] if isinstance(child, ast.Assign) else child.target
                t = tg.id if isinstance(tg, ast.Name) else target
            for sub in ast.walk(child):
                out.setdefault(id(sub), ".".join(scope) if scope else (t or "<module>"))
            visit(child, scope, t)

    visit(tree, [], None)
    return out


def collect(base: pathlib.Path = BACK, roots: tuple[str, ...] = ROOTS) -> list[Write]:
    from tests.core.test_guards import _strings

    fnw = db_function_writes()
    found: set[Write] = set()
    for root in roots:
        for f in sorted((base / root).rglob("*.py")):
            rel = str(f.relative_to(base))
            if _excluded(rel):
                continue
            tree = ast.parse(f.read_text(encoding="utf-8"))
            sym = _symbols(tree)
            by_line: dict[int, str] = {}
            for n in ast.walk(tree):
                if hasattr(n, "lineno") and id(n) in sym:
                    by_line.setdefault(n.lineno, sym[id(n)])
            for s, line, _complete in _strings(tree):
                where = by_line.get(line, "<module>")
                tables = (_ast_writes(s) or set()) | _regex_writes(s)
                for t in tables:
                    via = "sql" if t in (_ast_writes(s) or set()) else "regex"
                    found.add(Write(t, rel, where, line, via))
                for m in _CALL_RE.finditer(s):
                    for t in fnw.get(m.group(1).lower(), ()):
                        found.add(Write(t, rel, where, line, f"fn:rd.{m.group(1).lower()}"))
            for n in ast.walk(tree):
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("copy_records_to_table", "copy_to_table"):
                    schema = next((k.value.value for k in n.keywords if k.arg == "schema_name" and isinstance(k.value, ast.Constant)), None)
                    name = n.args[0].value if n.args and isinstance(n.args[0], ast.Constant) else "{동적}"
                    if schema == "rd" or (isinstance(name, str) and name.startswith("rd.")):
                        found.add(Write(f"rd.{str(name).removeprefix('rd.')}", rel, sym.get(id(n), "<module>"), n.lineno, "copy"))
        for f in sorted((base / root).rglob("*.sql")):
            rel = str(f.relative_to(base))
            if _excluded(rel):
                continue
            s = f.read_text(encoding="utf-8")
            for t in (_ast_writes(s) or set()) | _regex_writes(s):
                found.add(Write(t, rel, "<file>", 0, "sql"))
    return sorted(found, key=lambda w: (w.table, w.path, w.symbol, w.line))


def _functions(base: pathlib.Path, root: str) -> dict[tuple[str, str], ast.AST]:
    out: dict[tuple[str, str], ast.AST] = {}
    for f in sorted((base / root).rglob("*.py")):
        rel = str(f.relative_to(base))
        if _excluded(rel):
            continue
        for n in ast.walk(ast.parse(f.read_text(encoding="utf-8"))):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out[(rel, n.name)] = n
    return out


def _referenced(fn: ast.AST) -> set[str]:
    """함수 본문이 읽는 이름(Name·Attribute 끝 이름)과 부르는 함수 이름."""
    out: set[str] = set()
    for sub in ast.walk(fn):
        if isinstance(sub, ast.Attribute):
            out.add(sub.attr)
        elif isinstance(sub, ast.Name):
            out.add(sub.id)
    return out


def const_users(names: set[str], base: pathlib.Path = BACK, root: str = "ingest") -> dict[str, set[tuple[str, str]]]:
    """모듈 수준 SQL 상수 이름 → 그 이름을 참조하는 ingest 함수(파일, 함수)."""
    out: dict[str, set[tuple[str, str]]] = {n: set() for n in names}
    for key, fn in _functions(base, root).items():
        for n in _referenced(fn) & names:
            out[n].add(key)
    return out


def unfinalized_paths(writers: set[tuple[str, str]], finalizers: set[tuple[str, str]], base: pathlib.Path = BACK,
                      root: str = "ingest") -> list[list[str]]:
    """writers 에서 호출자 쪽으로(ingest 안, 함수 이름 기준) 올라가 finalizers 를 거치지 않고 끝나는(호출자 없는) 사슬 목록."""
    fns = _functions(base, root)
    callers: dict[str, set[tuple[str, str]]] = {}
    for key, fn in fns.items():
        for sub in ast.walk(fn):
            if isinstance(sub, ast.Call):
                name = sub.func.attr if isinstance(sub.func, ast.Attribute) else sub.func.id if isinstance(sub.func, ast.Name) else None
                if name and name != key[1]:
                    callers.setdefault(name, set()).add(key)
    bad: list[list[str]] = []

    def up(key: tuple[str, str], chain: list[str], seen: set[tuple[str, str]]) -> None:
        if key in finalizers:
            return
        cs = callers.get(key[1], set()) - seen
        if not cs:
            bad.append([*chain, f"{key[0]}:{key[1]}"])
            return
        for c in sorted(cs):
            up(c, [*chain, f"{key[0]}:{key[1]}"], seen | {c})

    for w in sorted(writers):
        up(w, [], {w})
    return bad


def calls_finalize(key: tuple[str, str], base: pathlib.Path = BACK) -> bool:
    fn = _functions(base, key[0].split("/")[0]).get(key)
    return fn is not None and any(isinstance(n, ast.Call) and (getattr(n.func, "id", None) == "finalize"
                                                               or getattr(n.func, "attr", None) == "finalize") for n in ast.walk(fn))
