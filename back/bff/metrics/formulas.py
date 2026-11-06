"""Calculation on base counts: no database, no data source. A rate is {"num","den"} and a position {"sum","count"}, the
shapes the screens already read (gold_reader.context.ratio · rank_avg), so a screen keeps its API response."""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from datetime import date, datetime, timedelta
from typing import Any

from bff.metrics.catalog import BY_KEY, Metric


def rate(num: Any, den: Any) -> dict:
    return {"num": int(num or 0), "den": int(den or 0)}


def avg(total: Any, count: Any) -> dict | None:
    return {"sum": int(total or 0), "count": int(count)} if count else None


def metric_value(metric: Metric | str, counts: Mapping[str, Any]) -> Any:
    """One metric on one group's base counts. A derived value has its own function below."""
    m = BY_KEY[metric] if isinstance(metric, str) else metric
    if m.needs and not counts.get(m.needs):
        return None
    if m.kind in ("rate", "multiple"):
        return rate(counts.get(m.num), counts.get(m.den))
    if m.kind == "avg":
        return avg(counts.get(m.num), counts.get(m.den))
    if m.kind == "count":
        return int(counts.get(m.num) or 0)
    raise ValueError(f"{m.key} is derived: call its own function")


def number(value: Any) -> float | None:
    """The exact number behind a value: a percent for a rate, the average for a position, None when it has no base."""
    if value is None:
        return None
    if isinstance(value, Mapping):
        if "count" in value:
            return value["sum"] / value["count"] if value["count"] else None
        return 100 * value["num"] / value["den"] if value["den"] else None
    return float(value)


def delta(current: Any, previous: Any) -> float | None:
    """현재 − 직전, 반올림 전 값으로 (비율은 pp)."""
    a, b = number(current), number(previous)
    return None if a is None or b is None else a - b


def last_delta(points: Iterable[tuple[Any, Any]]) -> dict | None:
    """Δ of a trend [(round, value)], oldest first: the last round with a value against the one before it with a value."""
    valued = [(day, value) for day, value in points if number(value) is not None]
    if len(valued) < 2:
        return None
    (before, previous), (at, current) = valued[-2], valued[-1]
    return {"round": at, "previous_round": before, "delta": delta(current, previous)}


def previous_window(start: date, end: date) -> tuple[date, date]:
    """The period right before [start, end], of the same length (기간을 고른 Δ의 비교 기간)."""
    days = (end - start).days + 1
    return start - timedelta(days=days), start - timedelta(days=1)


def rollup(rows: Iterable[Mapping[str, Any]], keys: Iterable[str]) -> dict:
    """권역 값 · 기간 값: the numerators and denominators added; the rate is then calculated on the sums. Only for counts
    that add up: a distinct prompt count over a period is counted again by the source, never added."""
    rows = list(rows)
    return {k: sum(r.get(k) or 0 for r in rows) for k in keys}


def representative(answers: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """대표 답변, the legacy rule (rd.rep_rules' cycle cell, back/db/DB-v2.19-patch.sql): per cycle · prompt · engine · country · language, the
    answer measured last, on a tie the lowest answer key; none when that answer is not eligible. It gives the is_rep the legacy screens read on
    every round but five old ones (global 08-24 · 08-31, website 07-24 · 08-07 · 08-14), left for the KPI-by-KPI check."""
    latest: dict[tuple, Mapping[str, Any]] = {}
    for a in answers:
        key = (a["cycle"], a["prompt"], a["engine"], a["country"], a["lang"])
        kept = latest.get(key)
        if kept is None or a["measured_at"] > kept["measured_at"] or (a["measured_at"] == kept["measured_at"] and a["answer_key"] < kept["answer_key"]):
            latest[key] = a
    return [a for a in latest.values() if a["eligible"]]


def competitor_sov(own_mentions: Any, brands: Iterable[Mapping[str, Any]]) -> dict | None:
    """경쟁사 대비 SOV: 당사 언급 ÷ 언급 1위 경쟁사 언급 (brands = the rivals' rows, HMG siblings left out by the caller).
    `multiple` is the N배."""
    rivals = [b for b in brands if b["mentions"]]
    if not rivals:
        return None
    top = min(rivals, key=lambda b: (-b["mentions"], b["name"]))
    return {"brand": top["name"], "num": int(own_mentions or 0), "den": int(top["mentions"]), "multiple": (own_mentions or 0) / top["mentions"]}


def engine_consistency(values: Iterable[Any]) -> float | None:
    """엔진 간 일관성: 엔진별 값의 최솟값 ÷ 최댓값 (%). Needs two engines with a value."""
    numbers = [n for n in map(number, values) if n is not None]
    return 100 * min(numbers) / max(numbers) if len(numbers) >= 2 and max(numbers) else None


def standing(own: Any, others: Iterable[Any], *, higher_is_better: bool = True) -> dict | None:
    """순위 칩: 당사보다 앞선 값의 수 + 1, 비교한 브랜드 수 (값이 없는 브랜드는 뺀다)."""
    mine = number(own)
    if mine is None:
        return None
    numbers = [n for n in map(number, others) if n is not None]
    ahead = sum(n > mine if higher_is_better else n < mine for n in numbers)
    return {"rank": ahead + 1, "field": len(numbers) + 1}


def gap(own: Any, rival: Any, *, higher_is_better: bool = True) -> float | None:
    """격차, + = 당사가 앞섬."""
    d = delta(own, rival)
    return None if d is None else d if higher_is_better else -d


def top_rivals(brands: Iterable[Mapping[str, Any]], n: int, *, key: str = "mentions") -> list[Mapping[str, Any]]:
    """경쟁사 평균의 대상: 언급이 많은 경쟁사 n개, 같은 수면 받은 순서."""
    return sorted(brands, key=lambda b: -b[key])[:n]


def rival_average(values: Iterable[Any]) -> float | None:
    """경쟁사 평균: 값이 있는 경쟁사 값의 평균. 값이 하나도 없으면 없다."""
    numbers = [n for n in map(number, values) if n is not None]
    return sum(numbers) / len(numbers) if numbers else None


def average_line(points: Iterable[tuple[Any, Any]]) -> float | None:
    """브랜드 평균선의 기울기: (후보군 포함율, Top1 ACR) 중 후보군 포함율이 있는 브랜드의 Top1 ACR 합 ÷ 후보군 포함율 합.
    두 지표는 단위가 달라(셀 · 반복) 비교 기준이지 전환율이 아니다."""
    shown = [(number(x), number(y)) for x, y in points]
    shown = [(x, y or 0) for x, y in shown if x]
    return sum(y for _, y in shown) / sum(x for x, _ in shown) if shown else None


def line_distance(x: Any, y: Any, k: float | None) -> float | None:
    """평균선 대비: Top1 ACR − k × 후보군 포함율 (pp). 평균선이 없으면 없다."""
    return None if k is None else (number(y) or 0) - k * (number(x) or 0)


def category_share(rows: Iterable[Mapping[str, Any]], total: Any, *, key: str = "citations") -> list[dict]:
    """A list of rows with their share of `total`, largest first (인용 비중 · 도메인 점유율 · 유형 안 점유율)."""
    return [{**r, "share": rate(r[key], total)} for r in sorted(rows, key=lambda r: -r[key])]


def rank_by(rows: Iterable[Mapping[str, Any]], key: str, *, name: str = "name") -> list[dict]:
    """회차별 언급 순위 · 주별 도메인 순위: the rows numbered by `key`, largest first, ties by name."""
    return [{**r, "rank": i} for i, r in enumerate(sorted(rows, key=lambda r: (-r[key], r[name])), 1)]


def own_state(choice: Any, appearance: Any) -> str:
    """ACR 당사 상태 of one prompt × country × engine."""
    return "pick" if (choice or 0) > 0 else "listed" if (appearance or 0) > 0 else "absent"


def own_states(pairs: Iterable[Mapping[str, Any]], axis: Callable[[Mapping[str, Any]], Any] | None = None) -> dict:
    """당사 상태 counts per `axis` of a (prompt, engine, country) row list (acr_pair_counts); one total without an axis.
    Every triple that has a row counts, with 0s for a triple 당사 is not in."""
    triples: dict[tuple, list[int]] = {}
    for r in pairs:
        sums = triples.setdefault((r["prompt"], r["engine"], r["country"]), [0, 0])
        if r["is_own"]:
            sums[0] += r["choice"] or 0
            sums[1] += r["appearance"] or 0
    out: dict[Any, dict[str, int]] = {}
    for (prompt, engine, country), (choice, appearance) in triples.items():
        group = axis({"prompt": prompt, "engine": engine, "country": country}) if axis else None
        counts = out.setdefault(group, {"pick": 0, "listed": 0, "absent": 0})
        counts[own_state(choice, appearance)] += 1
    return out


def prompt_winners(pairs: Iterable[Mapping[str, Any]]) -> dict[tuple, dict]:
    """프롬프트 × 엔진 1위 브랜드: the most chosen brand over the countries, ties by name; only with a pick."""
    choices: dict[tuple, dict[str, int]] = {}
    own: dict[str, bool] = {}
    for r in pairs:
        if r["choice"]:
            brands = choices.setdefault((r["prompt"], r["engine"]), {})
            brands[r["brand"]] = brands.get(r["brand"], 0) + r["choice"]
            own[r["brand"]] = r["is_own"]
    out = {}
    for key, brands in choices.items():
        winner = min(brands, key=lambda n: (-brands[n], n))
        out[key] = {"brand": winner, "choice": brands[winner], "is_own": own[winner]}
    return out
