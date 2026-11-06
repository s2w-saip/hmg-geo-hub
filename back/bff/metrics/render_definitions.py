"""Render the catalog to docs/ssot-staging/service/metric-definitions.md, so the document cannot drift from the code.
Run from back/: python -X utf8 -m bff.metrics.render_definitions"""
from __future__ import annotations

from pathlib import Path

from bff.metrics.catalog import BASE_COUNTS, COMMON_CONDITIONS, DEFINITION_VERSION, METRICS, POPULATIONS

OUT = Path(__file__).resolve().parents[3] / "docs/ssot-staging/service/metric-definitions.md"
FAMILIES = ("언급", "인용", "ACR", "측정", "AI 가시성", "고객 관심")


def term(key: str) -> str:
    """A base count's meaning; a formula written in words stays as it is."""
    return BASE_COUNTS[key][1] if key in BASE_COUNTS else key


def cell(value: str) -> str:
    return str(value).replace("|", "\\|")


def table(head: list[str], rows: list[list[str]]) -> list[str]:
    return ["| " + " | ".join(head) + " |", "|" + "---|" * len(head), *("| " + " | ".join(map(cell, r)) + " |" for r in rows), ""]


def metric_row(m) -> list[str]:
    population = POPULATIONS[m.population].split(":")[0] if m.population else "—"
    return [m.name, term(m.num), term(m.den) if m.den else "—", population, " · ".join(m.dims) or "—",
            "낮을수록 앞" if not m.higher_is_better else "", m.screens, m.note]


def render() -> str:
    lines = ["# 지표 정의 (스테이징)", "",
             "서비스(BFF)가 정의하고 계산하는 지표 전체다. 코드 `back/bff/metrics/catalog.py`에서 만든 문서이므로 여기를 직접 고치지 않는다. "
             "SSOT `service/metric-definitions.md`의 지표 19개와 공통 조건 7개에, 화면에 나오지만 SSOT에 없는 값을 더했다. "
             "SSOT 반영은 SSOT 세션이 한다.", "",
             f"지표 정의 버전: `{DEFINITION_VERSION}`", "",
             "'사전 집계' 지표는 필터 없는 초기 화면 값이라 회차마다 Gold에 저장한다. '차원'은 저장 · 조회 단위다.", "",
             "## 공통 조건", "", *table(["항목", "정의"], [list(c) for c in COMMON_CONDITIONS])]
    for family in FAMILIES:
        members = [m for m in METRICS if m.family == family]
        head = ["지표", "분자 · 계산식", "분모", "모수", "차원", "방향", "화면", "비고"]
        for title, chosen in ((f"## {family}: SSOT 지표", [m for m in members if m.ssot]),
                              (f"## {family}: SSOT에 없는 화면 값", [m for m in members if not m.ssot])):
            if chosen:
                lines += [title, "", *table(head, [metric_row(m) for m in chosen])]
    lines += ["## 지금 화면 값과 다른 것 ('분석팀 리뷰 필요')", "",
              "지표 계산 함수는 SSOT 정의를 따른다. 화면을 이 함수로 바꾸면(T7) 값이 아래처럼 달라진다.", "",
              *table(["지표", "차이"], [[m.name, m.review] for m in METRICS if m.review]),
              "## 기본 집계값과 gold_db 대응", "",
              "데이터 소스 어댑터가 세는 값이다. Silver 어댑터는 같은 값을 OBT에서 센다. 값 대조: `bff.tests.test_metrics_live`.", "",
              *table(["기본 집계값", "단위", "뜻", "어댑터 ① gold_db"], [[k, *v] for k, v in BASE_COUNTS.items()])]
    return "\n".join(lines)


if __name__ == "__main__":
    OUT.write_text(render(), encoding="utf-8")
    print(f"{OUT} {sum(1 for m in METRICS if m.ssot)} ssot rows, {len(METRICS)} metrics")
