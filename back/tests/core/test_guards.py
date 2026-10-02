"""SQL 경계 가드(app.core.sqlguard, PostgreSQL 17 파서 AST) 테스트. 검증 m7·N4.

1) core 빌더가 내는 모든 문장(표면 × 자사 판정 경로 × part × group_by × 창)이 가드를 통과한다(예외 없음).
2) app/** 의 SQL 리터럴:
   - 완결 문장(SELECT·WITH·INSERT·UPDATE·DELETE·SET·DO·EXECUTE… 로 시작)은 파싱돼야 하고 fact_guard 를 통과해야 한다
     (f-string 치환 자리는 바인드 $1 로 본다: 사실 표 술어를 치환 자리로 넘기면 위반이다 → core 빌더를 쓴다).
   - 그 밖의 SQL 조각은 fragment_guard(ing·리프·세션 SET·set_config) 를 통과해야 한다.
   기능 모듈(app/features/**)도 같은 검사를 받는다. 기능 통합 테스트는 local·test 엔진 가드(HGH_SQL_GUARD)에도 걸린다.
3) 검증자 우회 목록 전부 음성 시험.
"""
from __future__ import annotations

import ast
import itertools
import pathlib
import re
from datetime import date

import pytest

from app.core.codes import OwnedBase
from app.core.cycles import CycleRow, build_window
from app.core.measure import (
    MeasureScope,
    allowed_owner_keys,
    applied_prompts_sql,
    citation_counts_sql,
    competitor_rows_sql,
    plan_counts,
    report_values_sql,
)
from app.core.sqlb import render_literals
from app.core.sqlguard import fact_guard, fragment_guard

APP = pathlib.Path(__file__).resolve().parents[2] / "app"
BASES = [OwnedBase(1, "base", "a", "Hyundai", "US", "en"), OwnedBase(2, "base", "b", "Hyundai", "AU", "en"),
         OwnedBase(3, "base", "c", "Hyundai", "CA", "fr")]
OWN = {"Hyundai": 1, "Kia": 2, "Genesis": 4}
PARTS = ("mentions", "rank_detail", "prompts", "gap", "urls", "citations")
OK = "SELECT count(*) FROM rd.answer a WHERE a.surface = $1 AND a.round_date = $2 AND a.cyc_key = ANY($3)"


def _scopes():
    for countries, langs in ((None, None), (["US"], None), (["US", "AU"], None), (["CA"], ["fr"])):
        yield MeasureScope(sf=1, project_keys=(1,), own_bits=(1,), bgrps=(1, 9), pop_bits=(1, 8), geo_keys=(174,) if countries else None,
                           owner=allowed_owner_keys(BASES, {"Hyundai"}, OWN, countries, langs))
    yield MeasureScope(sf=1, project_keys=(1,), own_bits=(1, 2, 4), bgrps=tuple(range(1, 32)), engine_keys=(2,), prompt_keys=(1, 3),
                       owner=allowed_owner_keys(BASES, {"Hyundai", "Kia", "Genesis"}, OWN, None, None))
    yield MeasureScope(sf=2, project_keys=(2, 5), own_bits=(2,), bgrps=(2,), lang_keys=(1,))
    yield MeasureScope(sf=3, project_keys=(3,), own_bits=(1,), bgrps=None)
    # 5라운드: 출처 카테고리 축(원소 스캔 경로) · 빈 축(fail-closed)
    yield MeasureScope(sf=1, project_keys=(1,), own_bits=(1,), bgrps=(1, 9), source_category_keys=(1, 6),
                       owner=allowed_owner_keys(BASES, {"Hyundai"}, OWN, None, None))
    yield MeasureScope(sf=2, project_keys=(2,), own_bits=(2,), bgrps=(2,), source_category_keys=())


def _windows():
    d = date(2026, 9, 14)
    yield build_window(surface="global", mode="snapshot", rows=[CycleRow(11, 1, d, 0)], lo=d, hi=d, generation=1, project_keys=(1,))
    yield build_window(surface="global", mode="cumulative", rows=[CycleRow(10, 1, date(2026, 9, 7), 0), CycleRow(11, 1, d, 2)],
                       lo=date(2026, 9, 1), hi=date(2026, 9, 30), generation=1, project_keys=(1,))


def _all_builder_sql():
    for ms, win in itertools.product(list(_scopes()), list(_windows())):
        for n in range(1, len(PARTS) + 1):
            for parts in itertools.combinations(PARTS, n):
                for gb in ((), ("round_date",), ("engine", "geo"), ("week",)):
                    for split in (None, date(2026, 9, 10)):
                        for _, q in plan_counts(ms, win, group_by=gb, split_at=split, parts=parts).statements:
                            yield q
        yield citation_counts_sql(ms, win, group_by=("source",), extra_where=("c.src_first", "NOT c.tgt_hit"))
        yield competitor_rows_sql(ms, win, group_by=("round_date",))
        yield competitor_rows_sql(ms, win, group_by=("geo",), hmg_siblings=False)
        yield applied_prompts_sql(ms)
        yield applied_prompts_sql(ms, kind="acr")
    yield report_values_sql([date(2026, 9, 18)], ["Kia"], ["DE"], ["de"], project_keys=(2,), geo_keys=(44,))


def test_builder_sql_passes_guard_no_exceptions():
    seen: set[str] = set()
    for q in _all_builder_sql():
        if q.text in seen:
            continue
        seen.add(q.text)
        v = fact_guard(q.text)
        assert not v, (v, q.text)
        assert not fact_guard(render_literals(q)), q.text          # 리터럴 인라인 형태도 통과
    assert len(seen) > 300


# 검증자 우회 목록(재검증 N4): 전부 위반으로 잡혀야 한다
BYPASS = {
    "콤마 조인": "SELECT 1 FROM rd.cycle x, rd.answer a WHERE x.surface = 1",
    "FROM ONLY": "SELECT 1 FROM ONLY rd.answer a WHERE true",
    "괄호 조인": "SELECT 1 FROM (rd.cycle x JOIN (rd.citation c JOIN rd.dim_url u ON true) ON true) WHERE x.surface = 1",
    "인용 식별자 사실 표": 'SELECT 1 FROM "rd"."answer" a WHERE a.surface = 1',
    "주석 속 술어": "SELECT 1 FROM rd.answer a WHERE a.surface = 1 /* AND a.round_date = $1 AND a.cyc_key = ANY($2) */",
    "문자열 속 술어": "SELECT 1 FROM rd.answer a WHERE a.surface = 1 AND 'a.round_date = x AND a.cyc_key = ANY(y)' <> ''",
    "별칭 재사용": "SELECT 1 FROM rd.answer a JOIN rd.citation a ON true WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2)",
    "다른 별칭 술어": "SELECT 1 FROM rd.answer a JOIN rd.cycle b ON true WHERE b.surface = 1 AND b.round_date = $1 AND b.cyc_key = ANY($2)",
    "OR true": OK + " OR true",
    "OR 1=0 분기": "SELECT 1 FROM rd.answer a WHERE (a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2)) OR 1 = 0",
    "NOT 아래 술어": "SELECT 1 FROM rd.answer a WHERE NOT (a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2))",
    "자기 비교": "SELECT 1 FROM rd.answer a WHERE a.surface = a.surface AND a.round_date = a.round_date AND a.cyc_key = ANY(ARRAY[a.cyc_key])",
    "하한만": "SELECT 1 FROM rd.answer a WHERE a.surface = 1 AND a.round_date >= $1 AND a.cyc_key = ANY($2)",
    "서브쿼리 안 누락": "SELECT (SELECT count(*) FROM rd.citation c WHERE c.surface = 1) FROM app.brand",
    "CTE 안 누락": "WITH x AS (SELECT * FROM rd.answer_brand b WHERE b.surface = 1) SELECT * FROM x",
    "ING. 대소문자": "SELECT * FROM ING.answer",
    '"ing" 인용': 'SELECT * FROM "ing".answer',
    "ing . answer 공백": "SELECT * FROM ing . answer",
    "ing 함수": "SELECT ing.f(1)",
    "ing 3단 열": "SELECT ing.answer.job_id FROM app.brand",
    "대문자 리프": "SELECT 1 FROM RD.ANSWER_W_202609 x",
    "인용 대문자 리프": 'SELECT 1 FROM rd."ANSWER_G" x',
    "리프 부모": "SELECT 1 FROM rd.citation_p x",
    "# 연산": OK + " AND (a.own_mask # 1) = 0",
    ">> 연산": OK + " AND (a.own_mask >> 1) = 0",
    "| 연산": OK + " AND (a.own_mask | 1) = 3",
    "~ 연산": OK + " AND ~a.own_mask = 0",
    "get_bit": "SELECT get_bit('\\x01'::bytea, 0) FROM app.brand",
    "bit_or 집계 FILTER 밖": "SELECT bit_or(a.own_mask) FROM rd.answer a WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2)",
    "주석 속 FILTER": OK + " AND /* FILTER ( */ (a.own_mask & 1) <> 0",
    "SELECT 목록 비트": "SELECT (a.own_mask & 1) FROM rd.answer a WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2)",
    "주석 뒤 SET": "/* x */ SET statement_timeout = 0",
    "SET LOCAL": "SET LOCAL role api_rw",
    "RESET": "RESET ROLE",
    "set_config false": "SELECT set_config('role', 'api_rw', false)",
    "set_config 대문자": "SELECT SET_CONFIG('role', 'api_rw', FALSE)",
    "set_config 'f'": "SELECT set_config('role', 'api_rw', 'f')",
    "set_config 바인드": "SELECT pg_catalog.set_config('role', 'api_rw', $1)",
    "set_config 2인자": "SELECT set_config('role', 'api_rw')",
    "DO EXECUTE": "DO $$ BEGIN EXECUTE 'SELECT 1'; END $$",
    "EXECUTE 준비문": "EXECUTE q(1)",
    "PREPARE": "PREPARE q AS SELECT 1",
    "rd 쓰기": "UPDATE rd.answer SET cit_n = 0",
    "파싱 불가": "SELECT FROM WHERE",
    # 3차(D2)
    "LEFT JOIN 보존측 ON": "SELECT 1 FROM rd.answer a LEFT JOIN app.brand b ON a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2)",
    "RIGHT JOIN 보존측 ON": "SELECT 1 FROM app.brand b RIGHT JOIN rd.answer a ON a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2)",
    "FULL JOIN ON": "SELECT 1 FROM app.brand b FULL JOIN rd.answer a ON a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2)",
    "TABLESAMPLE": "SELECT 1 FROM rd.answer a TABLESAMPLE SYSTEM (1) WHERE a.surface = 1",
    "set_config role true": "SELECT set_config('role', 'api_rw', true)",
    "set_config search_path": "SELECT set_config('search_path', 'ing', true)",
    "set_config 이름 바인드": "SELECT set_config($1, 'x', true)",
    "스키마 없는 사실 표": "SELECT 1 FROM answer a WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2)",
    "스키마 없는 리프": "SELECT 1 FROM citation_w x",
    "CTE 안 DELETE": "WITH d AS (DELETE FROM app.brand RETURNING 1) SELECT * FROM d",
    "CTE 안 UPDATE": "WITH u AS (UPDATE app.brand SET sort_order = 1 RETURNING 1) SELECT * FROM u",
    "SELECT INTO": "SELECT 1 INTO t",
    "MERGE": "MERGE INTO app.brand b USING app.brand c ON true WHEN MATCHED THEN DO NOTHING",
    "query_to_xml": "SELECT query_to_xml('select 1', true, false, '')",
    "table_to_xml": "SELECT table_to_xml('ing.answer', true, false, '')",
    "cursor_to_xml": "SELECT cursor_to_xml('c', 1, true, false, '')",
    "dblink": "SELECT * FROM dblink('h', 'select 1') AS t(a int)",
    "dblink_exec": "SELECT dblink_exec('h', 'select 1')",
    "정수 열 << 정수": "SELECT (b.brand_bit << 1) FROM app.brand b",
}


@pytest.mark.parametrize("name", sorted(BYPASS))
def test_guard_catches_bypass(name):
    assert fact_guard(BYPASS[name]), name


def test_guard_accepts_valid_shapes():
    assert fact_guard(OK) == []
    assert fact_guard(OK.replace("$", ":p")) == []                                              # SQLAlchemy 바인드
    assert fact_guard("SELECT 1 FROM rd.answer WHERE surface = 1 AND round_date BETWEEN $1 AND $2 AND cyc_key IN (1, 2)") == []
    assert fact_guard("SELECT 1 FROM rd.answer a JOIN rd.citation c ON c.surface = a.surface AND c.round_date = a.round_date "
                      "AND c.surface = 1 AND c.round_date >= $1 AND c.round_date <= $2 AND c.cyc_key = ANY($3) "
                      "WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($3)") == []
    assert fact_guard("SELECT count(*) FILTER (WHERE (a.own_mask & 7) <> 0 AND get_bit('\\x01'::bytea, 0) = 1) " + OK[len("SELECT count(*) "):]) == []
    assert fact_guard("SELECT set_config('app.actor_id', 'x', true); SELECT 'ing.answer AS x -- SET y' FROM app.brand -- ing.z") == []
    # 오탐 정리(3차): 정규식 ~ ~* !~, 범위·inet 의 << >>, 형 모를 &
    assert fact_guard("SELECT 1 FROM app.brand b WHERE b.brand_code ~ 'x' AND b.brand_code ~* 'y' AND b.brand_code !~ 'z'") == []
    assert fact_guard("SELECT int4range(1, 2) << int4range(3, 4), inet '10.0.0.1' << inet '10.0.0.0/8', (b.x & b.y) FROM app.brand b") == []
    # INNER JOIN ON·LEFT JOIN 널 보충쪽 ON 은 술어로 인정
    assert fact_guard("SELECT 1 FROM app.brand b JOIN rd.answer a ON a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2)") == []
    assert fact_guard("SELECT 1 FROM app.brand b LEFT JOIN rd.answer a ON a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2)") == []
    assert fact_guard("EXPLAIN " + OK) == []


def test_fragment_guard():
    assert fragment_guard("a.surface = CAST(:p0 AS int2) AND a.cyc_key = ANY(:p1)") == []
    assert fragment_guard("SELECT count(*) AS n") == []
    for bad in ("FROM ing.answer x", 'JOIN "ING".x', "FROM rd.ANSWER_W_202609", "SET statement_timeout = 0",
                "x; RESET ROLE", "SELECT set_config('a', 'b', false)", "DO $$ x $$", "SELECT set_config(:k, :v, :f)"):
        assert fragment_guard(bad), bad
    assert fragment_guard("SELECT set_config(:k0, :v0, true), 'ing.x' /* ing.y */") == []


def _fold(node: ast.AST) -> str | None:
    """문자열 상수 접기(ast 로 계산 가능한 범위만): 상수, 상수끼리 +, 모든 조각이 상수인 f-string, "sep".join([상수…])."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        a, b = _fold(node.left), _fold(node.right)
        return a + b if a is not None and b is not None else None
    if isinstance(node, ast.JoinedStr):
        parts = [_fold(v) for v in node.values]
        return "".join(parts) if all(p is not None for p in parts) else None
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "join" and len(node.args) == 1
            and isinstance(node.args[0], (ast.List, ast.Tuple))):
        sep = _fold(node.func.value)
        items = [_fold(e) for e in node.args[0].elts]
        return sep.join(items) if sep is not None and all(i is not None for i in items) else None  # type: ignore[arg-type]
    return None


def _strings(tree: ast.AST):
    """(문자열, 줄, 완결 여부). 접을 수 있는 가장 큰 문자열 식은 완결(True), 접을 수 없는 f-string 은 치환 자리를 $1 로 둔 조각(False).
    독스트링은 문서라 뺀다."""
    covered: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                covered.add(id(first.value))
    for node in ast.walk(tree):
        if id(node) in covered:
            continue
        s = _fold(node)
        if s is not None:
            for sub in ast.walk(node):
                covered.add(id(sub))
            yield s, getattr(node, "lineno", 0), True
        elif isinstance(node, ast.JoinedStr):
            for sub in ast.walk(node):
                covered.add(id(sub))
            yield "".join(v.value if isinstance(v, ast.Constant) else "$1" for v in node.values), node.lineno, False


def _parses(s: str) -> bool:
    from pglast import parse_sql
    from pglast.parser import ParseError

    from app.core.sqlguard import _to_dollar
    try:
        return len(parse_sql(_to_dollar(s))) > 0
    except (ParseError, ValueError):
        return False


SQLISH = re.compile(r"(?i)\b(select|insert|update|delete|from|join|set_config|execute)\b")
# 낱말 하나뿐인 문자열(예: XMLPullParser 이벤트 이름 "end")은 SQL 문장이 아니다. PostgreSQL 은 "end" 를 END(= COMMIT)로,
# "begin"·"commit"·"abort"·"checkpoint" 등도 문장으로 파싱하므로 정적 스캔 대상에서 뺀다(실행 경로는 엔진 가드가 따로 본다).
_SINGLE_WORD = re.compile(r"^\s*[A-Za-z_]+\s*;?\s*$")


def _scan(root: pathlib.Path, *, whole_statements: bool) -> list[str]:
    """파싱되는 문자열·.sql 파일은 전부 fact_guard, 파싱 안 되는 SQL 조각은 fragment_guard."""
    bad = []
    for path in sorted(root.rglob("*.py")):
        if path.name == "sqlguard.py":          # 가드 자신의 진단 문구는 SQL 이 아니다
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for s, line, complete in _strings(tree):
            where = f"{path.relative_to(root.parent)}:{line}"
            if _SINGLE_WORD.match(s):
                continue
            if whole_statements and complete and _parses(s):
                bad += [f"{where}: {v}" for v in fact_guard(s)]
            elif SQLISH.search(s):
                bad += [f"{where}: {v}" for v in fragment_guard(s)]
    for path in sorted(root.rglob("*.sql")):
        bad += [f"{path.relative_to(root.parent)}: {v}" for v in fact_guard(path.read_text(encoding="utf-8"))]
    return bad


def test_feature_sql_passes_guard():
    """기능 모듈(app/features/**)의 파싱되는 SQL 문자열·.sql 파일은 전부 fact_guard 를 통과해야 한다(CI 가 기능 빌더를 잡는다).
    동적으로 조립되는 SQL 은 local·test 엔진 가드(HGH_SQL_GUARD)가 실행 시점에 잡는다."""
    bad = _scan(APP / "features", whole_statements=True)
    assert not bad, "\n".join(bad)


def test_core_sql_fragments_pass_guard():
    """core 의 SQL 문자열(빌더 산출 전체 문장은 test_builder_sql_passes_guard_no_exceptions 가 검사)."""
    bad = _scan(APP / "core", whole_statements=True)
    assert not bad, "\n".join(bad)


def test_static_scan_catches_feature_violation(tmp_path):
    """정적 검사 음성 시험: 상수 접기(+·join·상수 f-string)로 만든 SQL, .sql 파일, ing 참조를 잡는다."""
    feat = tmp_path / "features" / "x"
    feat.mkdir(parents=True)
    (feat / "queries.py").write_text(
        '"""모듈 문서: SELECT 3사 4종 FROM 설명(독스트링은 검사 밖)"""\n'
        'Q = "SELECT count(*) FROM rd.answer a " + "WHERE a.surface = 1"\n'
        'R = " ".join(["SELECT *", "FROM ing.answer"])\n'
        'S = f"SELECT set_config({x}, :v, false)"\n'
        'OK = "SELECT 1 FROM app.brand"\n'
        'T = f"SELECT set_config(:k{i}, :v{i}, true)"\n', encoding="utf-8")
    (feat / "q.sql").write_text("SELECT 1 FROM rd.citation c WHERE c.surface = 1;\n", encoding="utf-8")
    bad = _scan(tmp_path / "features", whole_statements=True)
    assert any("queries.py:2" in b and "술어 없음" in b for b in bad), bad         # 상수 + 상수
    assert any("queries.py:3" in b and "ing" in b for b in bad), bad               # "sep".join([상수])
    assert any("queries.py:4" in b and "set_config" in b for b in bad), bad        # 접을 수 없는 f-string 조각
    assert any("q.sql" in b for b in bad), bad
    assert not any(f"queries.py:{n}" in b for b in bad for n in (1, 5, 6)), bad


FORBIDDEN_IN_FEATURES = ("hgh_sql_guard", "driver_connection", "get_raw_connection")


def test_features_do_not_bypass_guard():
    """기능 모듈은 가드 우회(hgh_sql_guard)·원시 드라이버 커넥션(driver_connection·get_raw_connection)을 쓰지 않는다."""
    bad = []
    for path in sorted((APP / "features").rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for w in FORBIDDEN_IN_FEATURES:
            if w in text:
                bad.append(f"{path.relative_to(APP.parent)}: {w}")
    assert not bad, "\n".join(bad)


def test_bypass_scan_detects(tmp_path):
    f = tmp_path / "x.py"
    f.write_text('await conn.execute(q, execution_options={"hgh_sql_guard": False})\n', encoding="utf-8")
    assert any(w in f.read_text(encoding="utf-8") for w in FORBIDDEN_IN_FEATURES)


def test_extra_where_only_boolean_columns():
    ms, win = next(iter(_scopes())), next(iter(_windows()))
    for frag in ("c.src_first", "NOT c.loc_owned"):
        assert frag in citation_counts_sql(ms, win, extra_where=(frag,)).text
    for frag in ("true OR 1=1", "c.owner_key = 5", "c.src_first; DROP TABLE x", "a.std_in", "NOT c.bogus", "c.src_first OR true"):
        with pytest.raises(ValueError):
            citation_counts_sql(ms, win, extra_where=(frag,))
