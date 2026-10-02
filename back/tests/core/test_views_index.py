"""화면 색인·기능 분류 정합(bg-qa-platform 검증 결함 D-02·D-03·D-04 회귀). DB 없이 돈다.

- D-02: 레포 안 생성기(docs/design/taxonomy/)가 예전 정규식 파서였고 back/taxonomy.json views(30키)가 views.json(41키)과 달랐다.
  → 레포 생성기를 임시 폴더에서 다시 돌려 taxonomy.json·views.json·VIEWS.md 가 바이트 단위로 재현되는지, 세 사본이 같은지,
    기능 README 의 '이 기능을 쓰는 화면' 목록이 views.json 과 같은지 본다.
- D-03: analytics.trend.series 는 9화면이다(보고서의 10 은 오기).
- D-04: GET /v1/qa/sessions/current 가 기능 README 에만 있고 카탈로그·모듈 문서에 없었다.
"""
from __future__ import annotations

import json
import pathlib
import re
import runpy
import shutil
import subprocess
import sys
from collections import defaultdict

import pytest

BACK = pathlib.Path(__file__).resolve().parents[2]
REPO = BACK.parent
TAX = REPO / "docs" / "design" / "taxonomy"
API = REPO / "docs" / "design" / "api"
VIEWS = json.loads((BACK / "app" / "views" / "views.json").read_text(encoding="utf-8"))
TX = json.loads((BACK / "taxonomy.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def regen(tmp_path_factory) -> pathlib.Path:
    """레포 생성기 사본을 임시 폴더(<tmp>/taxonomy + <tmp>/api/units 복사)에서 돌린다. 레포 파일은 건드리지 않는다."""
    root = tmp_path_factory.mktemp("taxgen")
    shutil.copytree(TAX, root / "taxonomy", ignore=shutil.ignore_patterns("taxonomy.json", "__pycache__"))
    shutil.copytree(API / "units", root / "api" / "units")
    subprocess.run([sys.executable, str(root / "taxonomy" / "build_taxonomy.py")], check=True, capture_output=True)
    (root / "repo" / "back").mkdir(parents=True)                # front/ 가 없으면 page 대조는 건너뛴다(레포 대조는 아래 테스트)
    subprocess.run([sys.executable, str(root / "taxonomy" / "gen_back_scaffold.py"), str(root / "repo"), "--views-only"],
                   check=True, capture_output=True)
    return root


def test_d02_repo_generator_reproduces_committed_outputs(regen):
    assert (regen / "taxonomy" / "taxonomy.json").read_bytes() == (TAX / "taxonomy.json").read_bytes() == (BACK / "taxonomy.json").read_bytes()
    views = regen / "repo" / "back" / "app" / "views"
    assert (views / "views.json").read_bytes() == (BACK / "app" / "views" / "views.json").read_bytes()
    assert (views / "VIEWS.md").read_bytes() == (BACK / "app" / "views" / "VIEWS.md").read_bytes()
    assert TX["views"] == VIEWS and len(VIEWS) == 42


def test_d02_screen_parser_expands_defect_strings(regen, capsys):
    """3.1 결함 문자열: ( · , { 에서 잘리던 경로가 전부 펼쳐진다(예전 파서: '/', '/standard', '/projects' 등)."""
    g = runpy.run_path(str(regen / "taxonomy" / "build_taxonomy.py"))
    capsys.readouterr()
    p = g["parse_screen_routes"]
    assert p("/(standard)/answer-analysis/*") == ["/standard/answer-analysis/*"]
    assert p("/standard·website/answer-analysis/citation") == ["/standard/answer-analysis/citation", "/website/answer-analysis/citation"]
    assert p("/projects/{id}/*") == ["/projects/[id]/*"]
    assert p("/standard/answer-analysis/citation, /mention") == ["/standard/answer-analysis/citation", "/standard/answer-analysis/mention"]
    assert p("/standard/answer-analysis/{mention,citation}") == ["/standard/answer-analysis/mention", "/standard/answer-analysis/citation"]
    assert not {"/standard", "/standard/answer-analysis"} & set(VIEWS)     # 예전 파싱 산물 키(리다이렉트 전용·없는 화면)
    assert VIEWS["/"] == ["platform.auth.session"]                           # 예전 '/' 는 잘린 경로 묶음, 지금은 랜딩 착지 판정뿐


def test_d02_feature_readme_screens_match_views():
    by_feature: dict[str, set[str]] = defaultdict(set)
    for route, fids in VIEWS.items():
        for f in fids:
            by_feature[f].add(route)
    checked = 0
    for f in TX["features"]:
        parts = (["ingest"] if f["category"] == "ingest" else ["app", "features", f["category"]]) + [f["domain"], f["feature"]]
        readme = BACK.joinpath(*parts, "README.md")
        if not readme.exists():
            continue
        s = readme.read_text(encoding="utf-8")
        m = re.search(r"## 이 기능을 쓰는 화면[^\n]*\n((?:(?:- |  )[^\n]*\n)*)", s)
        assert m, f"{readme}: 화면 절 없음"
        assert set(re.findall(r"^- `([^`]*)`$", m.group(1), re.M)) == by_feature[f["id"]], f["id"]
        for e in f["endpoints"]:
            assert f"`{e['path']}`" in s, (f["id"], e["path"])
        checked += 1
    assert checked >= 60


def test_d03_trend_series_screens():
    got = sorted(r for r, fids in VIEWS.items() if "analytics.trend.series" in fids)
    assert got == ["/dashboard", "/projects/[id]", "/projects/[id]/analysis/citation", "/projects/[id]/analysis/mention",
                   "/standard/answer-analysis/citation", "/standard/answer-analysis/mention", "/website",
                   "/website/answer-analysis/citation", "/website/answer-analysis/mention"]


def test_d04_qa_routes_are_catalogued():
    """검수 콘솔(/v1/qa) 앱 경로는 전부 카탈로그(전체-통합.json)·분류(taxonomy.json)에 있고, 새 GET /v1/qa/sessions/current 는 모듈 문서에도 있다."""
    from app.main import app

    catalog = json.loads((API / "units" / "전체-통합.json").read_text(encoding="utf-8"))["api_catalog"]
    cat_eps = {(a["method"], a["path"]) for a in catalog}
    tax_eps = {(e["method"], e["path"]) for f in TX["features"] for e in f["endpoints"]}
    routes = {(m.upper(), path) for path, ops in app.openapi()["paths"].items() if path.startswith("/v1/qa")
              for m in ops if m in ("get", "post", "put", "patch", "delete")}
    assert routes and not routes - cat_eps and not routes - tax_eps, sorted((routes - cat_eps) | (routes - tax_eps))
    sessions = next(f for f in TX["features"] if f["id"] == "qa.review.sessions")
    assert ("GET", "/v1/qa/sessions/current") in {(e["method"], e["path"]) for e in sessions["endpoints"]}
    assert "GET /v1/qa/sessions/current" in (API / "모듈-검수-콘솔.md").read_text(encoding="utf-8")
    unit = json.loads((API / "units" / "모듈-검수-콘솔.json").read_text(encoding="utf-8"))
    assert "/v1/qa/sessions/current" in {e["path"] for e in unit["endpoints_table"]}
    assert unit["doc"] == (API / "모듈-검수-콘솔.md").read_text(encoding="utf-8")
