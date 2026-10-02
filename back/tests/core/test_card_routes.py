"""동결 스냅샷 층 S0 시험(DB 없음): 사실 표 이름 자리(core.facts)·카드 경로 목록(core.card_routes).

  1. 자리: fact_tables() = LIVE(rd.*), 스코프를 줘도 S0 에서는 LIVE(동결 판정은 S3)
  2. 하드코딩 금지(정적): app/core·app/features/analytics 의 SQL 문자열(docstring 제외)에 FROM·JOIN rd.<사실 표> 가 없다(core.facts 만 이름을 안다)
  3. 카드 경로 목록 = front 호출(양방향): front lib/hgh/adapters 에서 cardParam·host_fold 를 쓰는 함수의 hghGet 경로·파라미터 쌍 집합 =
     CARD_ROUTES 쌍 집합
  4. 목록의 경로는 실제 GET 라우트이고 그 파라미터(card·host_fold)를 받는다(OpenAPI)
"""
from __future__ import annotations

import ast
import pathlib
import re

from app.core import facts
from app.core.card_routes import CARD_ROUTES, card_pairs

BACK = pathlib.Path(__file__).resolve().parents[2]
FRONT_ADAPTERS = BACK.parent / "front" / "lib" / "hgh" / "adapters"
FACT_SQL = re.compile(r"\b(FROM|JOIN)\s+rd\.(answer|answer_brand|answer_stance|citation|dim_prompt)\b")


def test_fact_tables_live():
    t = facts.fact_tables()
    assert t is facts.LIVE and facts.fact_tables(object()) is facts.LIVE
    assert (t.answer, t.answer_brand, t.answer_stance, t.citation, t.prompt) == (
        "rd.answer", "rd.answer_brand", "rd.answer_stance", "rd.citation", "rd.dim_prompt")


def _docstring_lines(tree: ast.AST) -> set[int]:
    out: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                out.update(range(first.lineno, (first.end_lineno or first.lineno) + 1))
    return out


def test_no_hardcoded_fact_tables_in_sql():
    bad: list[str] = []
    files = list((BACK / "app" / "core").glob("*.py")) + [p for p in (BACK / "app" / "features" / "analytics").rglob("*.py")
                                                         if "tests" not in p.parts]
    assert len(files) > 50
    for path in files:
        if path.name == "facts.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        doc = _docstring_lines(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.lineno not in doc and FACT_SQL.search(node.value):
                bad.append(f"{path.relative_to(BACK)}:{node.lineno}")
    assert not bad, "사실 표 이름은 core.facts.fact_tables() 로: " + ", ".join(bad)


def _front_card_calls() -> set[tuple[str, str]]:
    """front 어댑터에서 cardParam(card)·host_fold 를 쓰는 함수마다 그 함수의 hghGet 경로. (경로, 파라미터) 쌍."""
    out: set[tuple[str, str]] = set()
    files = [p for p in sorted(FRONT_ADAPTERS.glob("*.ts")) if not p.name.endswith(".test.ts")]
    assert files, f"front 어댑터 소스 없음: {FRONT_ADAPTERS}"
    for path in files:
        src = path.read_text(encoding="utf-8")
        for block in re.split(r"\n(?=(?:export\s+)?(?:async\s+)?function\s)", src):
            if not re.match(r"(?:export\s+)?(?:async\s+)?function\s+\w+", block):
                continue
            params = (["card"] if "cardParam(" in block else []) + (["host_fold"] if "host_fold" in block else [])
            if not params:
                continue
            paths = re.findall(r'hghGet(?:<[^>]*>)?\(\s*"(/v1/[^"]+)"', block)
            assert paths, f"{path.name}: 카드 파라미터를 쓰는 함수에 hghGet 경로가 없다(호출 형태가 바뀌었으면 이 시험을 고친다)"
            out |= {(p, k) for p in paths for k in params}
    return out


def test_card_routes_match_front_both_ways():
    front = _front_card_calls()
    back = card_pairs()
    assert front - back == set(), f"front 가 카드 파라미터를 보내는데 목록에 없다: {sorted(front - back)}"
    assert back - front == set(), f"목록에 있는데 front 가 보내지 않는다: {sorted(back - front)}"
    assert len(CARD_ROUTES) == 7


def test_card_routes_are_get_routes_with_params():
    from app.main import app

    spec = app.openapi()["paths"]
    for path, r in CARD_ROUTES.items():
        assert "get" in spec.get(path, {}), path
        names = {p["name"] for p in spec[path]["get"].get("parameters", [])}
        assert set(r.params) <= names, (path, r.params)
        assert set(r.surfaces) <= {"global", "website"}, path
