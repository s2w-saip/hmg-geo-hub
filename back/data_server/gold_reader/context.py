"""Pin a published release and bind every filter; never sum historical builds."""
from __future__ import annotations

import os
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from data_server.hub_stores import service_week
from data_server.metrics.gold_judged import Populations, populations
from data_server.metrics.judgments import excluded_from_ranks

SURFACES = {"global": 1, "website": 2, "project": 3}
BRANDS = {"hyundai": 1, "kia": 2, "genesis": 4, "hmg": 7}
BRAND_NAMES = {1: "Hyundai", 2: "Kia", 4: "Genesis"}
AXES = {"funnel": "funnel_key", "brand_presence": "presence_key", "list_type": "list_type_key",
        "depth1": "depth1_key", "depth2": "depth2_key", "depth3": "depth3_key", "depth4": "depth4_key"}


# The contract's mention_brand (a display name) -> gold.dim_brand.brand_key, as the original API resolved it
# (rd.dim_brand_name): the name itself first, else its bare key; never brand_key 0 '(이름 없음)'.
BRAND_BY_NAME = ("SELECT brand_key FROM gold.dim_brand WHERE brand_key<>0 AND (name=$1 OR lower(bare)=lower($1)) "
                 "ORDER BY (name=$1) DESC,(bare=lower($1)) DESC,brand_key LIMIT 1")


async def brand_key_of(conn: Any, name: str) -> int | None:
    """A brand's display name -> its gold.dim_brand key (None when Gold has no such brand). Finding the key of a row
    Gold already has changes no attribution (renewal audit 7-2)."""
    return await conn.fetchval(BRAND_BY_NAME, name.strip())


def values(q: Any, key: str) -> list[str]:
    return [v for v in q.getlist(key) if v]


def flag(q: Any, key: str, default: bool = False) -> bool:
    return str(q.get(key, str(default))).lower() in {"true", "1"}


def limit(q: Any, default: int = 50, maximum: int = 1000) -> int:
    try:
        return min(maximum, max(0, int(q.get("limit", default))))
    except ValueError:
        raise HTTPException(422, "Invalid limit") from None


class SQL:
    def __init__(self) -> None:
        self.args: list[Any] = []

    def bind(self, value: Any, cast: str = "") -> str:
        self.args.append(value)
        return f"${len(self.args)}{('::' + cast) if cast else ''}"


def calendar_round(release: str, today: str) -> str:
    """The round calendar's test of a cycle `c` (Context.dates): Gold serves it, no operator hid it, it is visible on
    `today` (Korea's day) and its fact slice is ready in `release` (SQL expressions). shared/service-week asks it of the
    service week (week_notes.ROUNDS_SQL), so the shell says '측정 없음' where the reads take no snapshot (review r4-2)."""
    return (f"c.servable AND coalesce(c.hidden_scope,0)<>1 AND (c.view_date IS NULL OR c.view_date <= {today}) "
            f"AND EXISTS (SELECT 1 FROM gold.release_item ri WHERE ri.release_id={release} AND ri.family='fact' "
            f"AND ri.state='ready' AND ri.slice_key='cyc:' || c.cyc_key::text)")


# A read's rounds, newest first: $1 surface, $2 project_key (None = every site), $3 today in Korea, $4 the release,
# $5 the service week's last day (None = no cap)
CALENDAR_SQL = f"""SELECT DISTINCT c.round_date
    FROM gold.dim_cycle c
    WHERE c.surface=$1 AND ($2::smallint IS NULL OR c.project_key=$2) AND {calendar_round("$4", "$3::date")}
      AND ($5::date IS NULL OR c.round_date <= $5::date)
    ORDER BY c.round_date DESC"""


class Context:
    """One read on Gold's pinned release with its filters bound.

    The service week (hub_stores/service_week.py, decisions '발행 시점 판정' · '기준 주 세부', 2026-11-02) caps the global
    and website reads here, so every caller is capped (readers.read, answers.detail, the Admin stores): `dates` stop at
    the week's last day, a release build of a later round (or of a cycle the read does not see) is not read, a `to`
    after it reads up to it and a `from` after it selects nothing, and a snapshot of a surface with no round in the
    week is empty ('측정 없음'). The project surface, a Context built directly (tests) and a HUB data DB that is not
    configured are not capped (`week` None).
    Rule C4: a read of a Gold table that is no release item — Gold's report_value, publication, pub_cell and
    pub_cell_web — binds round_date=ANY(ctx.dates) or the cyc_keys of those rounds; neither cap reaches it (a build or a
    row with no cycle is kept), data_server.tests.test_gold_service_week.RuleC4."""

    def __init__(self, conn: Any, q: Any) -> None:
        self.conn, self.q = conn, q
        self.surface = q.get("surface", "global")
        if self.surface not in SURFACES:
            raise HTTPException(422, "Unknown surface")
        self.sf = SURFACES[self.surface]
        # One snapshot per round (SSOT): the card and grid releases, older copies of some rounds, are not read. ?card= is ignored,
        # and the screens that send it read the same answers as the others (decision 2026-11-06, D-15).
        self.card = False
        self.mode = "live"
        self.bits = 0
        for brand in values(q, "brand"):
            if brand.lower() not in BRANDS:
                raise HTTPException(422, f"Unknown brand: {brand}")
            self.bits |= BRANDS[brand.lower()]
        self.bits = self.bits or 7
        # the service week the read stops at (create() on the global and website surfaces), None = no cap
        self.week: service_week.Week | None = None
        self.project_key: int | None = None
        self.release: dict = {}
        self.builds: dict[str, list[int]] = {}
        # build -> round date of the cycle slice it publishes (release_item slice_key 'cyc:<cyc_key>')
        self.build_dates: dict[int, date] = {}
        self.dates: list[date] = []
        self.selected_dates: list[date] = []
        # the mention drill's target of a citation read (citations.mention_target): ("brand", brand_key) or ("own", None)
        self.mention: tuple[str, int | None] | None = None
        # the global 자사 judgment's 허용 배열 of this request (citations.owned_bases), read once
        self.owned_bases: list[int] | None = None
        # the prompts whose catalog row matches every taxonomy pick (global · website), read once; None = no pick
        self.catalog_prompts: list[int] | None = None
        # the rounds of this read whose pre-computed values are late (metrics.gold_rows): a trend shows them as gaps
        self.late_rounds: set[date] = set()
        # on the OBT, each round's operating snapshots in the manifest (metrics.gold_rows reads them); None off it
        self.public_snapshots: dict[date, str] | None = None
        # what the judgments leave out of this read's builds (metrics.gold_judged); the ACR answers no population takes leave every fact read
        self.populations = Populations()
        self.older_acr: list[int] = []

    @classmethod
    async def create(cls, conn: Any, q: Any, *, capped: bool = True, lazy_catalog: bool = False) -> Context:
        """`capped` False: a read of no Gold round (keyword and social research, the project list) leaves the service
        week out, so it never waits on or fails with the HUB data DB. On the global and website surfaces it reads no
        round calendar either: its meta names no round (as_of None), never one after the week (review r2-4)."""
        self = cls(conn, q)
        if capped and self.sf in (1, 2):
            self.week = await service_week.current_or_503()
        signature = os.environ.get("HGH_GOLD_RULE_SIGNATURE") or None
        rows = await conn.fetch("""SELECT * FROM gold.active_release
            WHERE scope=$1 AND read_mode=$2 AND ($3::text IS NULL OR rule_signature=$3)
            ORDER BY updated_at DESC NULLS LAST""", self.surface, self.mode, signature)
        if not rows:
            raise HTTPException(503, "No published Gold release for this surface and read mode")
        if len(rows) != 1:
            raise HTTPException(503, "Multiple Gold rule signatures; configure HGH_GOLD_RULE_SIGNATURE")
        self.release = dict(rows[0])
        week_end = self.week.end if self.week is not None else None
        for row in await conn.fetch("""SELECT i.family,i.build_id,i.slice_key,c.round_date FROM gold.release_item i
                JOIN gold.build b USING(build_id)
                LEFT JOIN gold.dim_cycle c ON i.slice_key='cyc:' || c.cyc_key::text
                WHERE i.release_id=$1 AND i.state='ready' AND b.status='validated'""", self.release["release_id"]):
            # a build of a round after the service week is not read, not even by the reads that bind builds without a
            # date (filter options, the catalog, ACR coverage, an answer's detail); one of no cycle ('rpub:all',
            # 'site:…') stays (rule C4). A cycle slice whose dim_cycle row the read does not see (Gold mid-reload, a
            # state the HUB job refuses to judge) has no known round: not read either, as `dates` leave it out
            if week_end is not None and (row["round_date"] > week_end if row["round_date"] is not None
                                         else row["slice_key"].startswith("cyc:")):
                continue
            self.builds.setdefault(row["family"], []).append(row["build_id"])
            if row["round_date"] is not None:
                self.build_dates[row["build_id"]] = row["round_date"]
        project = q.get("project_id")
        if self.sf == 3 and not project:
            raise HTTPException(422, "project_id is required")
        if project and self.sf in (2, 3):
            row = await conn.fetchrow("""SELECT * FROM gold.dim_project
                WHERE surface=$2 AND (project_id::text=$1 OR scope_project_id::text=$1) ORDER BY project_key LIMIT 1""", project, self.sf)
            if row is None:
                raise HTTPException(404, "Project not present in Gold")
            self.project_key = row["project_key"]
        if capped or self.sf == 3:   # a read of no round on the global or website surface has no calendar (above)
            self.dates = [r["round_date"] for r in await conn.fetch(
                CALENDAR_SQL, self.sf, self.project_key, datetime.now(ZoneInfo("Asia/Seoul")).date(), self.release["release_id"],
                week_end)]
        try:
            start = date.fromisoformat(q["from"]) if q.get("from") else None
            end = date.fromisoformat(q["to"]) if q.get("to") else None
        except ValueError:
            raise HTTPException(422, "Dates must use YYYY-MM-DD") from None
        if start and end and start > end:
            raise HTTPException(422, "from must not exceed to")
        if start or end:
            # `dates` stop at the service week: a `to` after it reads up to it, a `from` after it selects nothing
            self.selected_dates = [d for d in self.dates if (start is None or d >= start) and (end is None or d <= end)]
        else:
            offset = max(0, int(q.get("cycle_offset", "0")))
            if offset == 0 and self.week is not None and not any(self.week.start <= d <= self.week.end for d in self.dates):
                # no round of this surface in the service week: no snapshot, the screens' '측정 없음' (decision '기준 주
                # 세부': such a surface does not hold the week back, and an older round is not shown under its name;
                # shared/service-week's `rounds` asks the calendar the same, review r4-2).
                # A previous round (cycle_offset 1, …) still reads the capped list.
                self.selected_dates = []
            else:
                self.selected_dates = self.dates[offset:offset + 1]
        self.populations = await populations(conn, self.sf, self.builds.get("fact", []))
        self.older_acr = self.populations.older_acr
        if not lazy_catalog:
            await self.load_catalog()
        return self

    async def load_catalog(self) -> None:
        """The prompts of the taxonomy picks, once. A read Gold's rows answer never needs them (2.9 s on a brand_presence pick): it comes
        with lazy_catalog, and its data source calls this before counting from the snapshot.
        Overview check (2026-11-02): an EXISTS on catalog_entry per cell row (no prompt_key index) planned a nested loop on card reads,
        13 s and past the 15 s limit; the keys read once and bound take 0.5-1 s, same rows."""
        b = SQL()
        if self.catalog_prompts is None and self.sf != 3 and (tax := self.taxon_where(b, "ce")):
            self.catalog_prompts = [r["prompt_key"] for r in await self.conn.fetch(f"""SELECT DISTINCT ce.prompt_key
                FROM gold.catalog_entry ce WHERE ce.build_id=ANY({b.bind(self.builds.get('fact', []), 'bigint[]')})
                AND (ce.brand_bit & {b.bind(self.bits | 8)})<>0 AND {' AND '.join(tax)}""", *b.args)]

    @staticmethod
    def _left_out(b: SQL, alias: str, keys: list[int], column: str = "answer_key") -> str:
        # a hashed subplan: <>ALL over a bound array compares every row with every key (the reads took ten times as long)
        return f"{alias}.{column} NOT IN (SELECT unnest({b.bind(keys, 'bigint[]')}))" if keys else "TRUE"

    def monitoring(self, b: SQL, alias: str = "f") -> str:
        """모니터링 답변 (judgments.monitoring), on a row of any answer table."""
        return self._left_out(b, alias, self.populations.not_monitoring)

    def citation_monitoring(self, b: SQL, alias: str = "f") -> str:
        return self._left_out(b, alias, self.populations.not_citation_monitoring)

    def eligible(self, b: SQL, alias: str = "f") -> str:
        return self._left_out(b, alias, self.populations.not_eligible)

    def competitive(self, b: SQL, alias: str = "f") -> str:
        """A competing brand's row (judgments.NON_COMPETITOR_BRANDS). A bare-only name keeps the split its rows came with."""
        parts = [self._left_out(b, alias, self.populations.non_competitor, "brand_key")]
        if self.populations.bare_only:
            parts.append(f"({alias}.competitive OR {self._left_out(b, alias, self.populations.bare_only, 'brand_key')})")
        return "(" + " AND ".join(parts) + ")"

    def excluded(self, name: str | None, *, is_own: bool = False) -> bool:
        """A rank row the roster excludes (judgments.excluded_from_ranks): out of the lists, in every total."""
        return excluded_from_ranks(name, is_own=is_own, excluded=self.populations.excluded_brands)

    def capped(self, day: date | None) -> date | None:
        """`day`, at the latest the service week's last day (an uncapped read keeps it)."""
        return min(day, self.week.end) if day is not None and self.week is not None else day

    @property
    def own_names(self) -> list[str]:
        return [name for bit, name in BRAND_NAMES.items() if self.bits & bit]

    @property
    def label(self) -> str:
        return self.own_names[0] if len(self.own_names) == 1 else "HMG"

    def meta(self, *, mode: str | None = None, page: dict | None = None, suppressed: dict | None = None) -> dict:
        meta = {"surface": self.surface, "mode": mode or ("cumulative" if self.q.get("from") or self.q.get("to") else "snapshot"),
                "as_of": max(self.selected_dates).isoformat() if self.selected_dates else None,
                "cycles": [d.isoformat() for d in sorted(self.selected_dates)],
                "generation": self.release["version"], "ignored_filters": [], "dropped_filters": {},
                "suppressed": suppressed or {}, "source": {"url_rates": "live", "reason": "not_website" if self.sf != 2 else "no_publication"},
                "gold": {"database": "gold_db", "release_id": self.release["release_id"],
                    "rule_signature": self.release["rule_signature"], "read_mode": self.mode}}
        if page is not None:
            meta["page"] = page
        return meta

    def builds_for(self, family: str, dated: bool) -> list[int]:
        """The family's release builds; under a date filter only the builds whose cycle falls on a selected
        date (one build = one cycle slice), so the build_id index reads those slices instead of the whole
        table (1.1 -> 0.9 s on the Overview's brand rows). A build of no known cycle stays in."""
        builds = self.builds.get(family, [])
        if not dated:
            return builds
        selected = set(self.selected_dates)
        return [x for x in builds if x not in self.build_dates or self.build_dates[x] in selected]

    def taxon_where(self, b: SQL, alias: str) -> list[str]:
        """One condition per picked taxonomy axis on the catalog row `alias` (all on the same row)."""
        return [f"{alias}.{column} IN (SELECT taxon_key FROM gold.dim_taxon WHERE lower(code)=ANY({b.bind([v.lower() for v in selected], 'text[]')}))"
                for axis, column in AXES.items() if (selected := values(self.q, axis))]

    def population(self, family: str) -> int:
        return (9 if self.card else 2) if family == "citations" else (8 if self.card else 1)

    def predicate(self, b: SQL, alias: str = "f", *, family: str = "cell", population: str | None = None,
                  perspective: bool = False, dates: bool = True, dimensions: bool = True, taxonomy: bool = True,
                  measure_family: str = "mentions") -> str:
        parts = [f"{alias}.build_id=ANY({b.bind(self.builds_for(family, dates), 'bigint[]')})",
                 f"{alias}.surface={b.bind(self.sf, 'smallint')}"]
        if family == "fact" and self.older_acr:
            # a hashed subplan: <>ALL over a bound array compares every row with every key (the reads took ten times as long)
            parts.append(f"{alias}.answer_key NOT IN (SELECT unnest({b.bind(self.older_acr, 'bigint[]')}))")
        if dates:
            parts.append(f"{alias}.round_date=ANY({b.bind(self.selected_dates, 'date[]')})")
            hidden = (1, 2) if (population or measure_family) == "citations" else (1, 3)
            # the service week again, for a read that sets its own dates (the selected ones already stop there)
            week = f" AND cy.round_date<={b.bind(self.week.end, 'date')}" if self.week is not None else ""
            parts.append(f"EXISTS(SELECT 1 FROM gold.dim_cycle cy WHERE cy.cyc_key={alias}.cyc_key "
                         f"AND cy.servable AND coalesce(cy.hidden_scope,0) NOT IN {hidden} "
                         f"AND (cy.view_date IS NULL OR cy.view_date<={b.bind(datetime.now(ZoneInfo('Asia/Seoul')).date(), 'date')}){week})")
        if self.project_key is not None:
            parts.append(f"{alias}.project_key={b.bind(self.project_key, 'smallint')}")
        if population:
            parts.append(f"{alias}.population_key={b.bind(self.population(population), 'smallint')}")
        if perspective:
            parts.append(f"{alias}.perspective_key=(SELECT perspective_key FROM gold.dim_perspective WHERE own_bits={b.bind(self.bits)})")
        if self.sf == 1:
            parts.append(f"({alias}.bgrp & {b.bind(self.bits | 8)})<>0")
        if self.sf == 2 and values(self.q, "brand"):
            parts.append(f"EXISTS(SELECT 1 FROM gold.dim_project dp WHERE dp.project_key={alias}.project_key AND (dp.site_brand_bit & {b.bind(self.bits)})<>0)")
        if dimensions:
            for axis, table, key in (("country", "dim_country", "geo_key"), ("lang", "dim_lang", "lang_key"), ("engine", "dim_engine", "engine_key")):
                selected = values(self.q, axis)
                if selected:
                    parts.append(f"{alias}.{key} IN (SELECT {key} FROM gold.{table} WHERE lower(code)=ANY({b.bind([v.lower() for v in selected], 'text[]')}))")
        if taxonomy:
            if self.catalog_prompts is not None:
                parts.append(f"{alias}.prompt_key=ANY({b.bind(self.catalog_prompts, 'int[]')})")
            elif self.sf != 3 and any(values(self.q, axis) for axis in AXES):
                raise RuntimeError("Catalog picks are read in Context.create")  # never drop a pick
            elif self.sf == 3 and (tax := self.taxon_where(b, "p")):
                parts.append(f"EXISTS(SELECT 1 FROM gold.dim_prompt p WHERE p.prompt_key={alias}.prompt_key AND {' AND '.join(tax)})")
            custom = [(k[3:], values(self.q, k)) for k in self.q if k.startswith("cf.")]
            for field, selected in custom:
                parts.append(f"EXISTS(SELECT 1 FROM gold.prompt_custom_value cv JOIN gold.dim_custom_field cf USING(field_id) "
                             f"WHERE cv.prompt_key={alias}.prompt_key AND cf.field_id::text={b.bind(field)} "
                             f"AND cv.value=ANY({b.bind(selected, 'text[]')}))")
        return " AND ".join(parts)


def envelope(ctx: Context, data: Any, **kwargs: Any) -> dict:
    return {"data": data, "meta": ctx.meta(**kwargs)}


def ratio(num: Any, den: Any) -> dict:
    return {"num": int(num or 0), "den": int(den or 0)}


def rank_avg(total: Any, n: Any) -> dict | None:
    return {"sum": int(total or 0), "count": int(n)} if n else None
