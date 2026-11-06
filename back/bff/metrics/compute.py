"""Base counts → metric values: the one place a metric's numerator and denominator are chosen (catalog.py names them, formulas.py
calculates). The /v1 reads and the screens take their values from here, and the functions on a data source below answer one row per
group: the group's keys, `values` {metric key: value (formulas' shapes)} and, where a screen shows them, the counts behind the values."""
from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from typing import Any

from bff.metrics.catalog import BY_KEY, CITATION_MONITORING, METRICS, MONITORING, REPRESENTATIVE, URL_MEASURED
from bff.metrics.formulas import competitor_sov, last_delta, metric_value, rate, standing
from bff.metrics.source import DataSource

#: the kinds calculated from base counts alone (a derived value has its own function in formulas)
_SIMPLE = ("rate", "avg", "count", "multiple")


def of(key: str, num: Any, den: Any = None) -> Any:
    """A catalog metric on the two counts a read holds."""
    m = BY_KEY[key]
    return metric_value(m, {m.num: num, m.den: den})


def answer_values(c: Mapping[str, Any]) -> dict:
    """The five KPIs on a /v1 read's row (gold_reader.metrics.COUNTS): answers · tracked are the representative answers', cit_m05 the
    surface's AI 인용 점유율 numerator (citation_numerator), in the names the API answers."""
    return {"visibility": of("exposure", c.get("tracked"), c.get("answers")),
            "share_of_voice": of("share", c.get("own_mentions"), c.get("total_mentions")),
            "sentiment": of("favorability", c.get("sent_pos"), c.get("sent_all")),
            "position": of("priority", c.get("rank_sum"), c.get("ranked")),
            "citation_share": of("citation_share_global", c.get("cit_m05"), c.get("cit_total"))}


def citation_numerator(surface: int, row: Mapping[str, Any]) -> Any:
    """AI 인용 점유율's numerator: 공식 (HMG) on global, 자사 URL elsewhere (SSOT defines global and website)."""
    return row[BY_KEY["citation_share_global" if surface == 1 else "citation_share_website"].num]


def url_rates(u: Mapping[str, Any]) -> dict:
    """자사 · 타겟 URL 인용률 per prompt and AI 타겟 출처 인용률 per answer, in the names the API answers."""
    return {"target_url_rate": metric_value("target_url_rate", u), "owned_url_rate": metric_value("owned_url_rate", u),
            "citation_accuracy": metric_value("target_source_rate", u)}


def brand_metrics(*, rep_answers: Any, answers: Any, mentions: Any, total_mentions: Any, positive: Any, sentiments: Any, rank_sum: Any, ranked: Any) -> dict:
    """경쟁사 값은 같은 정의를 그 브랜드로 계산한다 (SSOT): on the same answers and mentions as 당사's."""
    return {"exposure": of("exposure", rep_answers, answers), "share": of("share", mentions, total_mentions),
            "favorability": of("favorability", positive, sentiments), "priority": of("priority", rank_sum, ranked)}


def type_exposure(type_: str, type_answers: Any, answers: Any) -> dict:
    return of(f"type_exposure_{type_}", type_answers, answers)


def top3_rate(top3: Any, tracked_monitoring: Any, ranked: Any) -> dict | None:
    """Top 3 노출 비율 (당사 언급 답변 of the monitoring answers); None for a round with no position at all (D-16)."""
    return metric_value("top3_rate", {"top3": top3, "tracked": tracked_monitoring, "ranked": ranked})


def multi_rate(multi_answers: Any, monitoring_answers: Any) -> dict:
    """복수 언급률: both on the monitoring answers."""
    return rate(multi_answers, monitoring_answers)


def _key(row: Mapping[str, Any], group: Sequence[str]) -> tuple:
    return tuple(row[g] for g in group)


def _by_key(rows: list[dict], group: Sequence[str]) -> dict[tuple, dict]:
    return {_key(r, group): r for r in rows}


def values_of(family: str, counts_of: Mapping[str, Mapping[str, Any]], skip: frozenset[str] = frozenset()) -> dict:
    """Every simple metric of `family`, each on its own population's counts."""
    out = {}
    for m in METRICS:
        if m.family == family and m.kind in _SIMPLE and m.key not in skip and m.population in counts_of:
            counts = counts_of[m.population]
            if m.num in counts and (not m.den or m.den in counts):
                out[m.key] = metric_value(m, counts)
    return out


async def mention_values(source: DataSource, group: Sequence[str] = ()) -> list[dict]:
    """당사's 언급 지표 per group. 노출률 and the answer count read the representative answers, the rest the monitoring
    answers (SSOT 공통 조건)."""
    representative = _by_key(await source.answer_counts(REPRESENTATIVE, group), group)
    monitoring = await source.answer_counts(MONITORING, group)
    own = _by_key(await source.own_brand_counts(MONITORING, group), group)
    out = []
    for row in monitoring:
        key = _key(row, group)
        counts = {MONITORING: {**row, **own.get(key, {})}, REPRESENTATIVE: representative.get(key, {})}
        out.append({**{g: row[g] for g in group}, "counts": counts, "values": values_of("언급", counts)})
    return out


def _brand_value(row: Mapping[str, Any], totals: Mapping[str, Any], represented: Mapping[str, Any], answers: Any) -> dict:
    return brand_metrics(rep_answers=represented.get("answers"), answers=answers, mentions=row["mentions"], total_mentions=totals.get("total_mentions"),
                         positive=row.get("s_pos"), sentiments=sum(row.get(k) or 0 for k in ("s_pos", "s_neu", "s_neg", "s_mix")),
                         rank_sum=row.get("rank_sum"), ranked=row.get("ranked"))


async def brand_values(source: DataSource, group: Sequence[str] = (), *, prompts: bool = False) -> list[dict]:
    """Every brand per group: its 노출률 · 점유율 · 우호도 · 우선 노출도, on the same answers and mentions as 당사's."""
    totals = _by_key(await source.answer_counts(MONITORING, group), group)
    answers = _by_key(await source.answer_counts(REPRESENTATIVE, group), group)
    represented = {(*_key(r, group), r["brand_key"]): r for r in await source.brand_counts(REPRESENTATIVE, group)}
    out = []
    for row in await source.brand_counts(MONITORING, group, prompts=prompts):
        key = _key(row, group)
        out.append({**row, "values": _brand_value(row, totals.get(key, {}), represented.get((*key, row["brand_key"]), {}),
                                                  answers.get(key, {}).get("answers"))})
    return out


def rival_rows(brands: list[dict], excluded: Collection[str] = ()) -> list[dict]:
    """경쟁사: neither 당사 nor a sibling HMG brand nor one the roster excludes (the Overview's rival columns and 경쟁사 대비 SOV)."""
    return [b for b in brands if not b["is_own"] and not b["own_bit"] and b.get("name") not in excluded]


async def citation_values(source: DataSource, group: Sequence[str] = ()) -> list[dict]:
    """AI 인용 점유율 by surface, 공식(당사) 인용 비중 and 분석 누락."""
    out = []
    for row in await source.citation_counts(group):
        counts = {CITATION_MONITORING: row}
        values = values_of("인용", counts, frozenset({"coverage", "source_share", "category_share"}))
        values.pop("citation_share_website" if source.surface == "global" else "citation_share_global", None)
        out.append({**{g: row[g] for g in group}, "counts": counts, "values": values})
    return out


async def category_values(source: DataSource, group: Sequence[str] = ()) -> list[dict]:
    """인용 비중: each category's citations over the group's. The denominator is the hosted citations the categories add up to."""
    rows = await source.category_counts(group)
    totals: dict[tuple, int] = {}
    for r in rows:
        totals[_key(r, group)] = totals.get(_key(r, group), 0) + r["citations"]
    return [{**r, "values": {"category_share": of("category_share", r["citations"], totals[_key(r, group)])}}
            for r in sorted(rows, key=lambda r: (_key(r, group), -r["citations"]))]


async def source_values(source: DataSource) -> list[dict]:
    """도메인 표: 인용 점유율 · 커버리지 · 프롬프트, largest first, numbered in that order."""
    rows = await source.source_counts()
    base = (await source.citation_counts())[0]["base_answers"]
    total = sum(r["citations"] for r in rows)
    return [{**r, "rank": i, "values": {"source_share": of("source_share", r["citations"], total), "coverage": of("coverage", r["answers"], base),
                                        "source_prompts": r["prompts"]}} for i, r in enumerate(rows, 1)]


async def url_values(source: DataSource, group: Sequence[str] = ()) -> list[dict]:
    """자사 · 타겟 URL 인용률 and AI 타겟 출처 인용률 (website)."""
    return [{**{g: r[g] for g in group}, "counts": {URL_MEASURED: r}, "values": values_of("인용", {URL_MEASURED: r})}
            for r in await source.url_counts(group)]


async def acr_values(source: DataSource) -> dict:
    """Top1 ACR · 후보군 포함율 of every brand and of 당사 (all its brands: 선택 수는 더하고 셀은 한 번만 센다), 당사 순위."""
    totals = (await source.acr_totals())[0]
    rows = await source.acr_brand_counts()
    brands = sorted(({**r, "values": {"top1_acr": of("top1_acr", r["choice"], totals["iterations"]), "candidate_rate": of("candidate_rate", r["appeared_cells"], totals["cells"])}}
                     for r in rows), key=lambda r: (-r["choice"], -r["appearance"], r["brand"]))
    own_rows = [r for r in brands if r["is_own"]]
    rivals = [r for r in brands if not r["is_own"] and r["choice"]]
    own_choice = sum(r["choice"] for r in own_rows)
    own = {"brands": [r["brand"] for r in own_rows], "choice": own_choice, "appearance": sum(r["appearance"] for r in own_rows),
           "appeared_cells": await source.acr_own_cells()}
    own["values"] = {"top1_acr": of("top1_acr", own_choice, totals["iterations"]), "candidate_rate": of("candidate_rate", own["appeared_cells"], totals["cells"])}
    own["standing"] = standing(own_choice, [r["choice"] for r in rivals])
    return {"totals": totals, "brands": brands, "own": own}


def trend_delta(rows: list[dict], metric: str) -> dict | None:
    """Δ of one metric over rows grouped by round (mention_values(source, ("round",)) …): 값이 있는 직전 회차 대비."""
    return last_delta(sorted(((r["round"], r["values"].get(metric)) for r in rows), key=lambda p: p[0]))


async def competitor_sov_value(source: DataSource, excluded: Collection[str] = ()) -> dict | None:
    """경쟁사 대비 SOV of 당사: Top 1 rival of the monitoring answers."""
    own = (await source.answer_counts(MONITORING))[0]["own_mentions"]
    return competitor_sov(own, rival_rows(await source.brand_counts(MONITORING), excluded))

