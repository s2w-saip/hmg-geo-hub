"""The unfiltered first screens: the screen builders each page calls on its first load, with no URL conditions (front/app/[locale]/
(renewal) and (dash)). The rollup job runs them and keeps every /v1 read they make; a page keeps its query, so the same read finds the
kept value. A page added here is pre-computed; one left out is counted at query time and cached like a filtered read."""
from __future__ import annotations

from collections.abc import Iterator

Call = tuple[str, dict[str, str]]

#: the Mention tabs' values (renewal pages' KPI_TABS)
KPI_TABS = ("exposure", "sov", "favorability", "first-rank")
MENTION = ("rn-page", "rn-asof", "rn-shell", "rn-compare", "rn-rate-value", "rn-rate-hero", "rn-rate-engines", "rn-rate-types",
           "rn-favor-hero", "rn-favor-dist", "rn-favor-matrix", "rn-rank", "rn-bump", "rn-ranking", "rn-engine-extra",
           "rn-presence-split", "rn-markets")


def _mention(q: dict[str, str], tabs: bool) -> list[Call]:
    calls = [(f"mention/{name}", q) for name in MENTION]
    if tabs:
        calls += [("mention/rn-tab-deltas", q), ("mention/rn-summary", q)]
        calls += [("mention/rn-tab-value", {**q, "ctx.kpi": k}) for k in KPI_TABS]
    return calls


def _citation(q: dict[str, str], name: str) -> list[Call]:
    """The Citation page: the renewal and the original body, and its two sub-pages."""
    return [("citation/as-of", q), ("citation/filter-bar", q), (f"citation/{name}", {**q, "ctx.variant": "renewal"}), (f"citation/{name}", q),
            ("citation/prompts", q), ("citation/tone-urls", q)]


def _legacy_global_mention() -> list[Call]:
    """The original Global Mention page: each of its tabs' sections, on no query but the metric."""
    calls: list[Call] = [(f"mention/{name}", {}) for name in ("as-of", "kpi-period", "prompts-section", "first-rank", "favor-hero", "favor-delta", "favor-trend",
                                                              "favor-sentiment", "favor-matrix")]
    for metric in ("exposure", "sov"):
        calls += [(f"mention/{name}", {"ctx.metric": metric}) for name in ("kpi-hero", "kpi-hero-delta", "kpi-competitors", "kpi-hero-trend", "kpi-engines", "kpi-types")]
    return calls


def global_calls() -> list[Call]:
    q = {"ctx.surface": "global"}
    return [("overview/as-of", q), ("overview/filters", q), ("overview/cards", {}), ("overview/card-trend", {}), ("overview/brand-matrix", {}),
            ("overview/card-competitors", {}), ("overview/geo", {"ctx.locale": "ko", "ctx.view": "renewal"}), ("overview/geo", {"ctx.locale": "ko"}),
            *_mention(q, False), *_legacy_global_mention(),
            ("shared/panel-options", {"surface": "global"}), ("shared/filter-dates", {"surface": "global", "family": "mentions"}),
            ("shared/service-week", {}), *_citation(q, "standard"), ("acr/renewal-header", {}), ("acr/renewal", {}), ("acr/standard", {}),
            ("catalog/prompts-page", {}), ("catalog/prompts-header", {})]


def website_calls() -> list[Call]:
    calls: list[Call] = []
    for admin in ("true", "false"):
        a = {"ctx.admin": admin}
        q = {"ctx.surface": "website", **a}
        calls += [("overview/as-of", q), ("overview/filters", q), ("website/summary", a), ("website/summary-deferred", a), ("website/brands", a),
                  ("website/engines", a), ("website/trend", a), ("website/composition", a), ("website/geo", {**a, "ctx.locale": "ko"}),
                  ("website/prompts-page", a), ("website/prompts-insights", a), ("website/prompts-options", a), ("website/prompts-list", a),
                  ("mention/view-cards", q), ("mention/view-weekly", q), ("mention/view-compare", q), ("mention/view", q), *_mention(q, True),
                  *_citation(q, "website")]
    calls += [("shared/panel-options", {"surface": "website"}), ("shared/filter-dates", {"surface": "website", "family": "mentions"})]
    return calls


def project_calls(project_id: str) -> list[Call]:
    p = {"ctx.project_id": project_id}
    q = {**p, "ctx.surface": "project"}
    return [("shared/project-gate", {"project_id": project_id}), ("projects/as-of", p), ("projects/filters", p), ("projects/dash-summary", p),
            ("projects/dash-summary-deferred", p), ("projects/dash-engines", p), ("projects/dash-trend", p), ("projects/dash-composition", p),
            ("projects/dash-status", p), ("projects/prompts", p), ("projects/detail", {**p, "ctx.kpis": "true"}), ("projects/detail", p), ("acr/gold", p),
            *_mention(q, True), ("mention/view", q), *_citation(q, "project")]


def calls_of(surface: str, project_ids: list[str]) -> Iterator[Call]:
    if surface == "global":
        yield from global_calls()
    elif surface == "website":
        yield from website_calls()
    else:
        yield ("projects/list", {})
        for pid in project_ids:
            yield from project_calls(pid)
