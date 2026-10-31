"""Pin a published release and bind every filter; never sum historical builds."""
from __future__ import annotations

import os
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import HTTPException

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


class Context:
    def __init__(self, conn: Any, q: Any) -> None:
        self.conn, self.q = conn, q
        self.surface = q.get("surface", "global")
        if self.surface not in SURFACES:
            raise HTTPException(422, "Unknown surface")
        self.sf = SURFACES[self.surface]
        self.card = flag(q, "card") and self.sf != 3
        self.mode = "grid" if self.card and flag(q, "grid") else "card" if self.card else "live"
        self.bits = 0
        for brand in values(q, "brand"):
            if brand.lower() not in BRANDS:
                raise HTTPException(422, f"Unknown brand: {brand}")
            self.bits |= BRANDS[brand.lower()]
        self.bits = self.bits or 7
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

    @classmethod
    async def create(cls, conn: Any, q: Any) -> Context:
        self = cls(conn, q)
        signature = os.environ.get("HGH_GOLD_RULE_SIGNATURE") or None
        rows = await conn.fetch("""SELECT * FROM gold.active_release
            WHERE scope=$1 AND read_mode=$2 AND ($3::text IS NULL OR rule_signature=$3)
            ORDER BY updated_at DESC NULLS LAST""", self.surface, self.mode, signature)
        if not rows:
            raise HTTPException(503, "No published Gold release for this surface and read mode")
        if len(rows) != 1:
            raise HTTPException(503, "Multiple Gold rule signatures; configure HGH_GOLD_RULE_SIGNATURE")
        self.release = dict(rows[0])
        for row in await conn.fetch("""SELECT i.family,i.build_id,c.round_date FROM gold.release_item i
                JOIN gold.build b USING(build_id)
                LEFT JOIN gold.dim_cycle c ON i.slice_key='cyc:' || c.cyc_key::text
                WHERE i.release_id=$1 AND i.state='ready' AND b.status='validated'""", self.release["release_id"]):
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
        self.dates = [r["round_date"] for r in await conn.fetch("""SELECT DISTINCT c.round_date
            FROM gold.dim_cycle c
            WHERE c.surface=$1 AND c.servable AND coalesce(c.hidden_scope,0)<>1
              AND ($2::smallint IS NULL OR c.project_key=$2)
              AND (c.view_date IS NULL OR c.view_date <= $3::date)
              AND EXISTS (SELECT 1 FROM gold.release_item ri
                  WHERE ri.release_id=$4 AND ri.family='fact' AND ri.state='ready'
                    AND ri.slice_key='cyc:' || c.cyc_key::text)
            ORDER BY c.round_date DESC""", self.sf, self.project_key, datetime.now(ZoneInfo("Asia/Seoul")).date(), self.release["release_id"])]
        try:
            start = date.fromisoformat(q["from"]) if q.get("from") else None
            end = date.fromisoformat(q["to"]) if q.get("to") else None
        except ValueError:
            raise HTTPException(422, "Dates must use YYYY-MM-DD") from None
        if start and end and start > end:
            raise HTTPException(422, "from must not exceed to")
        if start or end:
            self.selected_dates = [d for d in self.dates if (start is None or d >= start) and (end is None or d <= end)]
        else:
            offset = max(0, int(q.get("cycle_offset", "0")))
            self.selected_dates = self.dates[offset:offset + 1]
        return self

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
                "gold": {"database": "gold", "release_id": self.release["release_id"],
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

    def population(self, family: str) -> int:
        return (9 if self.card else 2) if family == "citations" else (8 if self.card else 1)

    def predicate(self, b: SQL, alias: str = "f", *, family: str = "cell", population: str | None = None,
                  perspective: bool = False, dates: bool = True, dimensions: bool = True, taxonomy: bool = True,
                  measure_family: str = "mentions") -> str:
        parts = [f"{alias}.build_id=ANY({b.bind(self.builds_for(family, dates), 'bigint[]')})",
                 f"{alias}.surface={b.bind(self.sf, 'smallint')}"]
        if dates:
            parts.append(f"{alias}.round_date=ANY({b.bind(self.selected_dates, 'date[]')})")
            hidden = (1, 2) if (population or measure_family) == "citations" else (1, 3)
            parts.append(f"EXISTS(SELECT 1 FROM gold.dim_cycle cy WHERE cy.cyc_key={alias}.cyc_key "
                         f"AND cy.servable AND coalesce(cy.hidden_scope,0) NOT IN {hidden} "
                         f"AND (cy.view_date IS NULL OR cy.view_date<={b.bind(datetime.now(ZoneInfo('Asia/Seoul')).date(), 'date')}))")
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
            tax = []
            tax_alias = "p" if self.sf == 3 else "ce"
            for axis, column in AXES.items():
                selected = values(self.q, axis)
                if selected:
                    tax.append(f"{tax_alias}.{column} IN (SELECT taxon_key FROM gold.dim_taxon WHERE code=ANY({b.bind(selected, 'text[]')}))")
            if tax:
                if self.sf == 3:
                    parts.append(f"EXISTS(SELECT 1 FROM gold.dim_prompt p WHERE p.prompt_key={alias}.prompt_key AND {' AND '.join(tax)})")
                else:
                    parts.append(f"EXISTS(SELECT 1 FROM gold.catalog_entry ce WHERE ce.prompt_key={alias}.prompt_key "
                                 f"AND ce.build_id=ANY({b.bind(self.builds.get('fact', []), 'bigint[]')}) "
                                 f"AND (ce.brand_bit & {b.bind(self.bits | 8)})<>0 AND {' AND '.join(tax)})")
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
