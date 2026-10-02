"""SQL 경계 가드(전체-통합 §5 "CI 경계 가드"): PostgreSQL 17 파서(pglast 7) AST 검사.

규칙(DESIGN-CONTRACT §3 술어 규약, A17 스키마 경계, core.db 세션 규약)
  G1 사실 표(rd.answer·answer_brand·answer_stance·citation)를 읽는 RangeVar 마다 같은 SELECT 스코프의 WHERE·JOIN ON 최상위 AND 항에
     surface = 값 · round_date(= 값 | BETWEEN 값 AND 값 | 하한·상한 쌍) · cyc_key = ANY(값)(또는 IN) 세 술어가 있어야 한다.
     값 = 열 참조가 없는 식(상수·바인드·형변환). OR·NOT 아래 술어는 인정하지 않는다(무력화 방지). 같은 스코프 별칭 중복 금지.
  G2 파티션 리프(rd.<사실 표>_g|w|p[_YYYYMM]) 직접 참조 금지(대소문자·인용 식별자 무관).
  G3 ing 스키마 참조 금지(표·함수·열 3단 참조, 대소문자·인용 식별자 무관). API 는 rd·app·ext 만 읽는다.
  G4 비트 연산(& | # << >> ~, get_bit·set_bit·bit_count·bit_and·bit_or·bit_xor)은 집계 FILTER (WHERE …) 안에서만.
  G5 세션 상태 변경 금지: SET·RESET·DO·EXECUTE·PREPARE·MERGE 등 SELECT·INSERT·UPDATE·DELETE·EXPLAIN 밖 문장.
     예외: 세이브포인트 3종(SAVEPOINT·RELEASE·ROLLBACK TO)은 트랜잭션 안 부분 되돌리기라 허용(행 단위 부분 성공, core.write.savepoint).
     BEGIN·COMMIT·ROLLBACK·PREPARE TRANSACTION 등 트랜잭션 경계 문장은 계속 금지(요청 트랜잭션은 core.db 가 연다).
     set_config 는 app.* GUC 문자열 상수(app.actor_id·actor_type·batch_id 등) + 세 번째 인자 true 상수만(role·search_path 등 금지).
     동적 SQL·서버 파일 함수(query_to_xml·table_to_xml·cursor_to_xml 계열, dblink*, pg_read_file 등) 금지.
  G6 API 문장은 rd·frz 를 쓰지 않는다(최상위 INSERT·UPDATE·DELETE 대상이 rd·frz 면 위반). CTE 등 중첩 데이터 변경 문·SELECT INTO 금지.
  동결 층(DB-v2.21, 결정 31·32): frz.answer·answer_brand·citation 뷰와 보관 표 frz.keep_* 도 사실 관계로 보고 G1 세 술어를 요구한다
     (core.facts 가 표 이름 자리를 frz 로 바꿔도 같은 술어 규약이 걸린다).
     rd 사실 표에는 보관 트리거가 없다(DB-v2.21 P117 명시 관문): G6 이 API 의 rd 쓰기를 막고, 적재 코드의 rd 사실 쓰기는 관문
     ingest.project.apply.service._write_facts 만 하도록 tests/core/test_frz_keep_gate.py 가 막는다(설계 card-snapshot-design.md 12.11).
  조인: INNER JOIN ON 항은 양쪽을 좁히는 술어로 인정, LEFT/RIGHT JOIN ON 은 널 보충쪽만, FULL JOIN ON 은 인정하지 않는다
     (보존측 사실 표의 술어는 WHERE 에 있어야 한다). TABLESAMPLE 안 관계도 검사한다. 스키마 없는 사실 표·리프 이름도 위반.
  비트 연산: 단항 ~ 는 항상, 이항 & | # << >> 는 한쪽이 정수 리터럴이거나 알려진 정수 비트 열(BIT_COLUMNS)일 때만 비트로 본다
     (이항 ~·~*·!~ 정규식, 범위·inet 의 << >>, 기하 # 오탐 방지).
주석·문자열 리터럴은 파서가 거른다(주석 속 술어·FILTER, 문자열 속 'ing.x' 는 효과 없음).

린트 한계(의도): 이 가드는 정직한 실수를 잡는 린트다. 보안 경계는 DB 권한(api_ro 읽기 전용·rd·app·ext 만, ing 권한 없음,
  api_rw 는 rd USAGE 없음, NOINHERIT 로그인 롤)이다. 의미 없는 값(예: surface = 0)·별칭 재명명·인용 대소문자 별칭 충돌·
  형을 알 수 없는 비트 연산 같은 적대적 우회는 막으려 하지 않는다(docs/design/api/전체-통합.md §5 CI 경계 가드).

쓰는 곳
  - fact_guard(sql): 완결 SQL(여러 문장 가능) 검사 → 위반 목록. SQLAlchemy ':name' 바인드와 '$n' 을 모두 받는다.
  - fragment_guard(text): 파싱 안 되는 SQL 조각(f-string 부분 등)용 토큰 검사(G2·G3·G5 일부).
  - install_engine_guard(engine): local·test 에서 모든 실행 문장에 fact_guard 를 걸어 위반 시 SqlGuardError(기능 통합 테스트가 걸린다).
    의도적 예외(권한 시험 등)는 execution_options(hgh_sql_guard=False).
"""
from __future__ import annotations

import logging
import re
from typing import Any

log = logging.getLogger("hgh.sqlguard")

FACT_TABLES = frozenset({"answer", "answer_brand", "answer_stance", "citation"})
# G1 대상 사실 관계(스키마, 이름). frz = 동결 층 읽기 뷰·보관 표(DB-v2.21 P115·P116)
FACT_RELS = frozenset({("rd", t) for t in FACT_TABLES} | {("frz", t) for t in ("answer", "answer_brand", "citation", "keep_answer",
                                                                              "keep_answer_brand", "keep_citation",
                                                                              "card_answer", "card_answer_brand", "card_citation",
                                                                              "card_answer_w", "card_answer_brand_w", "card_citation_w",
                                                                              "grid_answer", "grid_answer_brand", "grid_citation")})
WRITE_FORBIDDEN_SCHEMAS = frozenset({"rd", "frz"})
_LEAF = re.compile(r"^(answer|answer_brand|answer_stance|citation)_(g|w|p)(_\d+)?$")
BIT_OPS = frozenset({"&", "|", "#", "<<", ">>"})          # 이항. 단항 ~ 는 비트 NOT(이항 ~ 는 정규식 일치)
BIT_FUNCS = frozenset({"get_bit", "set_bit", "bit_count", "bit_and", "bit_or", "bit_xor"})
# 형을 모르는 이항 연산은 한쪽이 정수 리터럴이거나 알려진 정수 비트 열일 때만 비트로 본다(범위·inet 의 << >>, 기하 # 오탐 방지)
BIT_COLUMNS = frozenset({"own_mask", "bgrp", "cat_mask", "own_bit", "brand_bit", "site_brand_bit", "virtual_brand_bit", "name_own"})
_ALLOWED_GUC = re.compile(r"^app\.[a-z_][a-z0-9_]*$")    # set_config 로 바꿀 수 있는 GUC(app.actor_id·actor_type·batch_id 등). role·search_path 등 금지
DYNAMIC_SQL_FUNCS = frozenset({
    "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema", "table_to_xml", "table_to_xmlschema",
    "table_to_xml_and_xmlschema", "cursor_to_xml", "cursor_to_xmlschema", "schema_to_xml", "schema_to_xmlschema",
    "schema_to_xml_and_xmlschema", "database_to_xml", "database_to_xmlschema", "database_to_xml_and_xmlschema",
    "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "lo_import", "lo_export"})   # + dblink* (접두 검사)
_SAVEPOINT_KINDS = frozenset({4, 5, 6})     # pglast TransactionStmtKind: SAVEPOINT·RELEASE·ROLLBACK_TO
_BIND = re.compile(r"(?<![:\w]):([A-Za-z_]\w*)(?!:)")


class SqlGuardError(Exception):
    """가드 위반(개발·테스트 환경 실행 차단)."""


def _to_dollar(sql: str) -> str:
    names: dict[str, int] = {}

    def rep(m: re.Match[str]) -> str:
        n = names.setdefault(m.group(1), len(names) + 1)
        return f"${n}"
    return _BIND.sub(rep, sql)


def _names(nodes: Any) -> list[str]:
    out = []
    for n in nodes or ():
        v = getattr(n, "sval", None)
        out.append(v if v is not None else "*")
    return out


def _children(node: Any):
    from pglast import ast
    if isinstance(node, (list, tuple)):
        yield from node
        return
    if not isinstance(node, ast.Node):
        return
    for attr in node:
        v = getattr(node, attr, None)
        if isinstance(v, (ast.Node, list, tuple)):
            yield v


def _has_colref(node: Any) -> bool:
    from pglast import ast
    if isinstance(node, ast.ColumnRef):
        return True
    return any(_has_colref(c) for c in _children(node))


def _and_terms(e: Any) -> list[Any]:
    from pglast import ast
    from pglast.enums import BoolExprType
    if e is None:
        return []
    if isinstance(e, ast.BoolExpr) and e.boolop == BoolExprType.AND_EXPR:
        out: list[Any] = []
        for a in e.args:
            out += _and_terms(a)
        return out
    return [e]


def _is_col(node: Any, qualifiers: set[tuple[str, ...]], col: str) -> bool:
    from pglast import ast
    if not isinstance(node, ast.ColumnRef):
        return False
    f = tuple(x.lower() for x in _names(node.fields))
    return bool(f) and f[-1] == col and f[:-1] in qualifiers


def _fact_predicates(terms: list[Any], quals: set[tuple[str, ...]]) -> set[str]:
    from pglast import ast
    from pglast.enums import A_Expr_Kind as K
    have: set[str] = set()
    lower_b = upper_b = False
    for t in terms:
        if not isinstance(t, ast.A_Expr):
            continue
        op = _names(t.name)[-1] if t.name else ""
        lhs, rhs = t.lexpr, t.rexpr
        if t.kind == K.AEXPR_OP and op == "=":
            for a, b in ((lhs, rhs), (rhs, lhs)):
                if not _has_colref(b):
                    if _is_col(a, quals, "surface"):
                        have.add("surface")
                    if _is_col(a, quals, "round_date"):
                        have.add("round_date")
        elif t.kind == K.AEXPR_OP and op in (">", ">=", "<", "<="):
            for a, b, flip in ((lhs, rhs, False), (rhs, lhs, True)):
                if _is_col(a, quals, "round_date") and not _has_colref(b):
                    is_lower = (op in (">", ">=")) != flip
                    lower_b |= is_lower
                    upper_b |= not is_lower
        elif t.kind in (K.AEXPR_BETWEEN, K.AEXPR_BETWEEN_SYM) and _is_col(lhs, quals, "round_date") and not _has_colref(rhs):
            have.add("round_date")
        elif t.kind in (K.AEXPR_OP_ANY, K.AEXPR_IN) and op == "=" and _is_col(lhs, quals, "cyc_key") and not _has_colref(rhs):
            have.add("cyc_key")
    if lower_b and upper_b:
        have.add("round_date")
    return have


def _check_select(sel: Any, v: list[str]) -> None:
    from pglast import ast
    from pglast.enums import JoinType
    rels: list[tuple[Any, list[Any]]] = []          # (RangeVar, 그 관계를 실제로 좁히는 JOIN ON 항)

    def collect(item: Any, on_terms: list[Any]) -> None:
        if isinstance(item, ast.RangeVar):
            rels.append((item, on_terms))
        elif isinstance(item, ast.RangeTableSample):
            collect(item.relation, on_terms)
        elif isinstance(item, ast.JoinExpr):
            q = _and_terms(item.quals)
            jt = item.jointype
            # INNER: ON 이 양쪽을 좁힌다. LEFT: 오른쪽(널 보충쪽)만. RIGHT: 왼쪽만. FULL: 어느 쪽도 아니다(보존측 술어는 WHERE 에만 인정)
            left = q if jt in (JoinType.JOIN_INNER, JoinType.JOIN_RIGHT) else []
            right = q if jt in (JoinType.JOIN_INNER, JoinType.JOIN_LEFT) else []
            collect(item.larg, on_terms + left)
            collect(item.rarg, on_terms + right)

    for f in sel.fromClause or ():
        collect(f, [])
    seen: dict[str, int] = {}
    for rv, _ in rels:
        key = (rv.alias.aliasname if rv.alias else rv.relname).lower()
        seen[key] = seen.get(key, 0) + 1
    for k, n in seen.items():
        if n > 1:
            v.append(f"G1 같은 스코프 별칭 중복: {k}")
    where_terms = _and_terms(sel.whereClause)
    for rv, on_terms in rels:
        schema = (rv.schemaname or "").lower()
        name = rv.relname.lower()
        if (schema, name) not in FACT_RELS:
            continue
        quals: set[tuple[str, ...]] = set()
        if rv.alias:
            quals.add((rv.alias.aliasname.lower(),))
        else:
            quals |= {(name,), (schema, name)}
        if len(rels) == 1:
            quals.add(())
        missing = {"surface", "round_date", "cyc_key"} - _fact_predicates(where_terms + on_terms, quals)
        for m in sorted(missing):
            v.append(f"G1 {schema}.{name} {(rv.alias.aliasname if rv.alias else name)}: {m} 술어 없음")


def _is_int_operand(n: Any) -> bool:
    from pglast import ast
    if isinstance(n, ast.A_Const) and isinstance(n.val, ast.Integer):
        return True
    if isinstance(n, ast.ColumnRef):
        f = _names(n.fields)
        return bool(f) and f[-1].lower() in BIT_COLUMNS
    if isinstance(n, ast.A_Expr):             # 괄호 속 비트 식의 결과도 정수 문맥
        op = _names(n.name)[-1] if n.name else ""
        return op in BIT_OPS and (_is_int_operand(n.lexpr) or _is_int_operand(n.rexpr))
    return False


def _walk(node: Any, v: list[str], in_filter: bool, depth: int = 0) -> None:
    from pglast import ast
    if isinstance(node, (list, tuple)):
        for c in node:
            _walk(c, v, in_filter, depth)
        return
    if not isinstance(node, ast.Node):
        return
    if depth > 0 and isinstance(node, (ast.InsertStmt, ast.UpdateStmt, ast.DeleteStmt, ast.MergeStmt)):
        v.append(f"G6 중첩 데이터 변경 문(CTE 등): {type(node).__name__}")
    if isinstance(node, ast.SelectStmt):
        _check_select(node, v)
        if node.intoClause is not None:
            v.append("G6 SELECT INTO 금지")
    elif isinstance(node, ast.RangeVar):
        schema, name = (node.schemaname or "").lower(), (node.relname or "").lower()
        if schema == "ing":
            v.append(f"G3 ing 스키마 참조: {node.schemaname}.{node.relname}")
        if schema in ("rd", "") and _LEAF.match(name):
            v.append(f"G2 파티션 리프 직접 참조: {node.relname}")
        if schema == "" and name in FACT_TABLES:
            v.append(f"G1 스키마 없는 사실 표 이름: {node.relname}(rd. 로 명시)")
    elif isinstance(node, ast.ColumnRef):
        f = [x.lower() for x in _names(node.fields)]
        if len(f) >= 3 and f[0] == "ing":
            v.append("G3 ing 스키마 열 참조")
    elif isinstance(node, ast.FuncCall):
        fn = [x.lower() for x in _names(node.funcname)]
        base = fn[-1] if fn else ""
        if len(fn) > 1 and fn[0] == "ing":
            v.append(f"G3 ing 스키마 함수: {'.'.join(fn)}")
        if base == "set_config":
            args = node.args or ()
            name = args[0] if args else None
            third = args[2] if len(args) == 3 else None
            ok_name = (isinstance(name, ast.A_Const) and isinstance(name.val, ast.String) and _ALLOWED_GUC.match(name.val.sval) is not None)
            ok_local = isinstance(third, ast.A_Const) and isinstance(third.val, ast.Boolean) and third.val.boolval
            if not (ok_name and ok_local):
                v.append("G5 set_config 은 app.* GUC 문자열 상수 + 세 번째 인자 true 만")
        if base in DYNAMIC_SQL_FUNCS or base.startswith("dblink"):
            v.append(f"G5 동적 SQL·서버 파일 함수 금지: {base}")
        if base in BIT_FUNCS and not in_filter:
            v.append(f"G4 FILTER 밖 비트 함수: {base}")
        for attr in node:
            val = getattr(node, attr, None)
            _walk(val, v, True if attr == "agg_filter" else in_filter, depth + 1)
        return
    elif isinstance(node, ast.A_Expr):
        op = _names(node.name)[-1] if node.name else ""
        bit = (op == "~" and node.lexpr is None) or (
            op in BIT_OPS and (_is_int_operand(node.lexpr) or _is_int_operand(node.rexpr)))
        if bit and not in_filter:
            v.append(f"G4 FILTER 밖 비트 연산: {op}")
    for c in _children(node):
        _walk(c, v, in_filter, depth + 1)


def fact_guard(sql: str) -> list[str]:
    """완결 SQL 검사. 빈 목록 = 통과. 파싱 실패도 위반으로 돌려준다(검사할 수 없는 SQL 은 통과시키지 않는다)."""
    from pglast import ast, parse_sql
    from pglast.parser import ParseError

    try:
        stmts = parse_sql(_to_dollar(sql))
    except ParseError as e:
        return [f"파싱 실패: {e}"]
    v: list[str] = []
    for raw in stmts:
        s = raw.stmt
        if isinstance(s, ast.TransactionStmt) and int(s.kind) in _SAVEPOINT_KINDS:
            continue
        target = s.query if isinstance(s, ast.ExplainStmt) else s
        if not isinstance(target, (ast.SelectStmt, ast.InsertStmt, ast.UpdateStmt, ast.DeleteStmt)):
            v.append(f"G5 허용되지 않은 문장: {type(s).__name__}")
            continue
        if isinstance(target, (ast.InsertStmt, ast.UpdateStmt, ast.DeleteStmt)):
            rel = target.relation
            if rel is not None and (rel.schemaname or "").lower() in WRITE_FORBIDDEN_SCHEMAS:
                v.append(f"G6 {(rel.schemaname or '').lower()} 쓰기: {(rel.schemaname or '').lower()}.{rel.relname}")
        _walk(target, v, False)
    return v


def fragment_guard(text: str) -> list[str]:
    """파싱 안 되는 SQL 조각 토큰 검사: ing 스키마·리프 참조, 문장 머리 SET·RESET·DO·EXECUTE, set_config(…, true 아님)."""
    from pglast.parser import scan

    s = _to_dollar(text)
    try:
        toks = [t for t in scan(s) if t.name not in ("C_COMMENT", "SQL_COMMENT")]
    except Exception:  # noqa: BLE001  토큰화조차 안 되는 문자열은 PostgreSQL 이 받을 수 없는 SQL 이다(문서 문장 등) → 검사 대상 아님
        return []

    def txt(t: Any) -> str:
        w = s[t.start:t.end + 1]
        return w[1:-1] if w.startswith('"') and w.endswith('"') else w.lower()

    v: list[str] = []
    for i, t in enumerate(toks):
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        if t.name == "IDENT" and txt(t).lower() == "ing" and nxt is not None and nxt.name == "ASCII_46":
            v.append("G3 ing 스키마 참조")
        if (t.name == "IDENT" and txt(t).lower() == "rd" and nxt is not None and nxt.name == "ASCII_46" and i + 2 < len(toks)
                and _LEAF.match(txt(toks[i + 2]).lower())):
            v.append("G2 파티션 리프 직접 참조")
        head = i == 0 or toks[i - 1].name == "ASCII_59"
        if head and t.name in ("SET", "RESET", "DO", "EXECUTE", "PREPARE", "DEALLOCATE", "DISCARD"):
            v.append(f"G5 허용되지 않은 문장: {t.name}")
        if t.name == "IDENT" and txt(t).lower() == "set_config":
            depth, j, last = 0, i + 1, None
            while j < len(toks):
                if toks[j].name == "ASCII_40":
                    depth += 1
                elif toks[j].name == "ASCII_41":
                    depth -= 1
                    if depth == 0:
                        break
                last = toks[j]
                j += 1
            if last is None or last.name != "TRUE_P":
                v.append("G5 set_config 은 세 번째 인자 true 상수만")
    return v


def install_engine_guard(engine: Any) -> bool:
    """SQLAlchemy AsyncEngine 에 실행 전 가드를 건다(local·test). pglast 가 없으면 경고 후 False."""
    try:
        import pglast  # noqa: F401
    except ImportError:
        log.warning("pglast 없음: SQL 경계 가드 비활성")
        return False
    from sqlalchemy import event

    def before(conn: Any, cursor: Any, statement: str, parameters: Any, context: Any, executemany: bool) -> None:
        opts = getattr(context, "execution_options", {}) or {}
        if not opts.get("hgh_sql_guard", True):
            return
        v = fact_guard(statement)
        if v:
            raise SqlGuardError("; ".join(v) + f" :: {statement[:300]}")

    event.listen(engine.sync_engine, "before_cursor_execute", before)
    return True
