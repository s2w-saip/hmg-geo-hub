"""동결 층 보관 관문 정적 가드(DB-v2.21 P117, 설계 card-snapshot-design.md 12.11). DB 없이 도는 시험.

rd 사실 표에는 보관 트리거가 없다. 보관은 사실 쓰기의 단일 관문 ingest.project.apply.service._write_facts 가 명시적으로 한다
(frz_keep.before → 옛 행 삭제·삽입 → frz_keep.settle). 그래서 관문 밖에서 rd 사실 행 값을 바꾸는 코드가 새로 생기면 동결 값이 조용히
바뀐다. 이 시험이 막는다:
  1. app·ingest(시험·testkit 제외)의 SQL 문자열 중 rd 사실 표(answer·answer_brand·answer_stance·citation, 하위 파티션 이름 포함) 쓰기는
     허용 목록의 상수뿐이다. 값 쓰기(삭제·삽입) 상수는 _write_facts 에서만 참조한다.
  2. 관문 밖 허용 쓰기는 장부 열(is_rep·ecat_ver, 보관 비교에서 빼는 열이고 동결 뷰는 is_rep 참 고정)만 SET 한다.
  3. rd 사실 행을 쓰는 DB 함수 호출은 허용 목록(대표·게이트 사본 = 장부 열)뿐이다.
  4. _write_facts 안 순서: before 가 첫 사실 쓰기보다 앞, settle 이 마지막 사실 쓰기·게이트 전파보다 뒤.
관문 밖으로 남는 쓰기(문서화된 경계): psql 직접 SQL·DB 채우기 함수(fill-v2xx, 이관 명시 모드)·한 문장 다표 CTE. API 문장의 rd 쓰기는
SQL 경계 가드 G6(app.core.sqlguard), 하위 파티션 직접 쓰기는 DB 권한(P119 REVOKE, rd.ensure_leaf)이 막는다.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

BACK = Path(__file__).resolve().parents[2]
FACT = r"rd\.(?:answer|answer_brand|answer_stance|citation)(?:_[a-z0-9]+)*\b"
WRITE_RE = re.compile(rf"\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?{FACT}", re.I)
SET_RE = re.compile(rf"\bUPDATE\s+(?:ONLY\s+)?{FACT}(?:\s+[a-z]\w*)?\s+SET\s+(.*?)(?:\bFROM\b|\bWHERE\b|$)", re.I | re.S)
LEDGER = {"is_rep", "ecat_ver"}

# 값 쓰기(관문 안에서만 참조): queries.py 상수
GATED = {"DELETE_OLD", "INSERT_ANSWER", "INSERT_BRAND", "INSERT_STANCE", "INSERT_CITATION"}
# 장부 열만 쓰는 상수(관문 밖 허용): (파일, 상수)
LEDGER_ONLY = {("ingest/project/apply/queries.py", "REP_UPDATE"), ("ingest/project/apply/queries.py", "REP_UPDATE_LATEST_FIRST"),
               ("ingest/project/apply/ecat_engine.py", "MARK_PENDING"), ("ingest/project/apply/ecat_engine.py", "STAMP_CHUNK")}
ALLOWED = {("ingest/project/apply/queries.py", n) for n in GATED} | LEDGER_ONLY
# rd 사실 행을 쓰는 DB 함수 중 적재 코드가 부르는 것: 대표 재선정(is_rep·rd.rep_cit_delta)·게이트 사본 전파(부모 값 사본, is_rep 외에는 관문 안
# 재투영 답변만 바뀐다). 새 함수를 여기 더하려면 그 함수가 장부 열만 바꾸는지(또는 관문 안에서만 불리는지) 확인하고 설계 12.11 을 고친다.
FACT_FUNCS = {"rd.propagate_answer_gates", "rd.reselect_rep_seat", "rd.reselect_rep", "rd.fill_child_is_rep"}
FUNC_CALL_RE = re.compile(r"\brd\.(?:propagate_\w+|reselect_\w+|fill_\w+|rebuild_\w+|reproject_\w+)\s*\(")


def _sources() -> list[Path]:
    out = []
    for root in ("app", "ingest"):
        for p in (BACK / root).rglob("*.py"):
            rel = p.relative_to(BACK).as_posix()
            if "/tests/" in rel or rel.endswith("/testkit.py") or rel == "ingest/testkit.py":
                continue
            out.append(p)
    return out


def _docstrings(tree: ast.AST) -> set[int]:
    ids = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                ids.add(id(first.value))
    return ids


def _owner_map(tree: ast.Module) -> dict[int, str]:
    """문자열 노드 id → 소유 이름(모듈 상수 대입 이름, 아니면 함수 이름)."""
    owner: dict[int, str] = {}
    for top in tree.body:
        name = None
        if isinstance(top, ast.Assign) and top.targets and isinstance(top.targets[0], ast.Name):
            name = top.targets[0].id
        elif isinstance(top, ast.AnnAssign) and isinstance(top.target, ast.Name):
            name = top.target.id
        elif isinstance(top, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            name = top.name + "()"
        for n in ast.walk(top):
            owner[id(n)] = name or "<module>"
    return owner


def _strings(path: Path) -> list[tuple[str, str]]:
    """(소유 이름, 문자열): docstring 제외. f-string 은 상수 조각을 이어 붙인다."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docs = _docstrings(tree)
    owner = _owner_map(tree)
    out = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docs:
            out.append((owner.get(id(n), "<module>"), n.value))
        elif isinstance(n, ast.JoinedStr):
            s = "".join(v.value if isinstance(v, ast.Constant) else "{}" for v in n.values)
            out.append((owner.get(id(n), "<module>"), s))
    return out


def _fact_writes() -> dict[tuple[str, str], list[str]]:
    hits: dict[tuple[str, str], list[str]] = {}
    for p in _sources():
        rel = p.relative_to(BACK).as_posix()
        for name, s in _strings(p):
            if WRITE_RE.search(s):
                hits.setdefault((rel, name), []).append(s)
    return hits


def test_fact_write_sql_only_in_allowed_constants():
    hits = _fact_writes()
    extra = sorted(set(hits) - ALLOWED)
    assert not extra, f"관문 밖 rd 사실 쓰기 SQL(설계 12.11: _write_facts 를 지나게 하거나 장부 열만 쓰게 하고 허용 목록에 더한다): {extra}"
    missing = sorted(ALLOWED - set(hits))
    assert not missing, f"허용 목록 상수가 사라졌거나 이름이 바뀌었다(시험 갱신): {missing}"


def test_ledger_only_constants_set_only_ledger_columns():
    hits = _fact_writes()
    for key in LEDGER_ONLY:
        for s in hits[key]:
            assert not re.search(r"\b(INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\b", s, re.I), (key, "장부 상수에 삽입·삭제")
            sets = SET_RE.findall(s)
            assert sets, key
            for clause in sets:
                cols = {m.group(1).lower() for m in re.finditer(r"(?:^|,)\s*([a-z_]\w*)\s*=", clause.strip(), re.I)}
                assert cols and cols <= LEDGER, (key, cols)


def test_gated_constants_referenced_only_in_write_facts():
    refs: list[tuple[str, str]] = []
    for p in _sources():
        rel = p.relative_to(BACK).as_posix()
        tree = ast.parse(p.read_text(encoding="utf-8"))
        owner = _owner_map(tree)
        for n in ast.walk(tree):
            attr = isinstance(n, ast.Attribute) and n.attr in GATED
            bare = isinstance(n, ast.Name) and n.id in GATED and rel != "ingest/project/apply/queries.py"
            if attr or bare:
                refs.append((rel, owner.get(id(n), "<module>")))
    assert refs and set(refs) == {("ingest/project/apply/service.py", "_write_facts()")}, sorted(set(refs))


def test_fact_writing_db_functions_are_allowlisted():
    seen: set[str] = set()
    for p in _sources():
        for _name, s in _strings(p):
            for m in FUNC_CALL_RE.finditer(s):
                seen.add(m.group(0).rstrip("( ").strip())
    assert seen <= FACT_FUNCS, f"rd 사실 행을 쓸 수 있는 새 DB 함수 호출(설계 12.11 검토 후 허용 목록에): {sorted(seen - FACT_FUNCS)}"


def test_write_facts_calls_gate_around_writes():
    tree = ast.parse((BACK / "ingest/project/apply/service.py").read_text(encoding="utf-8"))
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "_write_facts")
    before = settle = None
    writes: list[int] = []
    gates: list[int] = []
    for n in ast.walk(fn):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name) and n.func.value.id == "frz_keep":
            if n.func.attr == "before":
                before = n.lineno
            elif n.func.attr == "settle":
                settle = n.lineno
        if isinstance(n, ast.Attribute) and n.attr in GATED | {"REP_UPDATE", "REP_UPDATE_LATEST_FIRST", "REP_UPDATE_SEAT"}:
            writes.append(n.lineno)
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and "propagate_answer_gates" in n.value:
            gates.append(n.lineno)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "_project_acr":
            gates.append(n.lineno)
    assert before and settle and writes and gates, (before, settle, writes, gates)
    assert before < min(writes), "frz_keep.before 는 첫 사실 쓰기(DELETE_OLD)보다 앞"
    assert settle > max(writes) and settle > max(gates), "frz_keep.settle 은 마지막 사실 쓰기·게이트 전파·ACR 뒤"


def test_gate_detector_catches_new_writer():
    """가드 자체 확인: 감지 정규식이 대표적인 관문 밖 쓰기 모양을 잡는다(리프 이름·ONLY·별칭 포함)."""
    for s in ("UPDATE rd.answer_brand SET mention_count = 1", "DELETE FROM rd.citation_g_202609 WHERE true",
              "INSERT INTO rd.answer (answer_key) VALUES (1)", "update only rd.answer a set ment_total = 0", "TRUNCATE rd.answer_stance"):
        assert WRITE_RE.search(s), s
    for s in ("SELECT * FROM rd.answer", "UPDATE rd.job SET served = true", "UPDATE frz.keep_answer SET x = 1"):
        assert not WRITE_RE.search(s), s
