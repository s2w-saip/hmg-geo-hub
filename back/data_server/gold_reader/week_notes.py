"""cycles/week-notes: per surface and ISO week up to the service week, the sites the week shows nothing of, and why
(2026-11-02, decision '기준 주 세부': a site with no round in a week does not hold the week back, its absence is said as
it is). The screens put it next to a period that holds such a week: 'Website 7월 4주차: Gold가 발행하지 않은 사이트 1곳'.

The completion rule the job advances the week by (back/hub_storage/service_week.py; the job's twin, so the two change together, pinned clause by clause in
data_server.tests.test_gold_service_week.WeekNotes): dim_cycle follows the manifest (the load job): a cycle is shown when its operating snapshot is loaded (status 2, servable) into the live
release of its scope; one on its way holds its site back (status 0, or public and not in the live release). Per site and week:
- shown: a shown cycle;
- unpublished: none shown, one held back;
- hidden: none shown or held back, one hidden;
- other: none shown, held back or hidden (only cycles Gold superseded or set aside: its own judgement).
Only the weeks with a site not shown are listed; counts are sites (dim_project), not cycles. An account with a scope
counts the website sites its reads take, a page's picks the page's (shared/service-week passes its brand, country,
language and engine on): a site of the brands with a job up to the service week on every axis picked, as the reads take
its cells (Context.predicate) — the country being where the job is measured (one site can hold several markets: Genesis
Saudi Arabia, site SA-Dammam, is measured in Jeddah and Riyadh), the job's language, its engine. Any job of the site
counts, of any round: a cycle Gold has not published may have none (review r5-1, 2026-11-03: the notes took a site by
its own country and by no language or engine, so a German page was told of an Italian and an English site, and a
SA-Jeddah page of none of Saudi Arabia's). A site with no job yet is taken by its own country (what it will be measured
on is not known). The global surface is everyone's. `days` are the round days a note is about: the rounds the week's
sites show and every round of a site it shows nothing of. A period reads rounds by their day, so one that holds none of
them holds none of that week's values, nor a round left out (review r2-10: a period from 09-19 was told of the 9월 3주차
site hidden on 09-18). Read on the global or website surface only: those are the weeks Context.create holds to the
service week (review r2-6).

With them, `rounds`: whether the service week (`week_start`) holds a round of each surface as the reads take it — the
shell's '측정 없음' (review r1-19). True when the round calendar of the live release, the one the reads
take, holds a round in the week, by Context.create's own test of a cycle
(calendar_round); False = none does, and no read of the surface takes a snapshot. Not the HUB job's record of the
week's complete cycles: a held week keeps that as recorded while Gold re-opens its round (review r4-2, 2026-11-03)."""
from __future__ import annotations

import os
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from data_server.gold_reader.context import Context, calendar_round, envelope, values

SURFACE_NAMES = {1: "global", 2: "website"}

# per release the reads pick from: a round of its surface in the week ($3..$4) its calendar takes ($1 today in Korea)
ROUNDS_SQL = f"""SELECT a.scope,a.read_mode,EXISTS (SELECT 1 FROM gold.dim_cycle c
        WHERE c.surface=CASE a.scope WHEN 'global' THEN 1 ELSE 2 END AND {calendar_round("a.release_id", "$1::date")}
          AND c.round_date BETWEEN $3::date AND $4::date) AS holds
    FROM gold.active_release a
    WHERE a.scope IN ('global','website') AND a.read_mode='live' AND ($2::text IS NULL OR a.rule_signature=$2)"""

# $3 the service week's last day, $4 brand bits, $5 · $6 · $7 the countries, languages and engines picked (None = any).
# `measured`: per website site with a job up to $3, whether one is on every axis picked. Read only with an axis picked
# (the gate holds in a generic plan too): one scan of job_index, 0.2 s on live Gold (2026-11-03)
NOTES_SQL = """WITH rel AS (
    SELECT a.scope,a.release_id FROM gold.active_release a
     WHERE a.scope IN ('global','website') AND a.read_mode='live'
       AND ($2::text IS NULL OR a.rule_signature=$2)),
  measured AS MATERIALIZED (
    SELECT j.project_key,bool_or(($5::text[] IS NULL OR j.geo_key IN (SELECT geo_key FROM gold.dim_country WHERE lower(code)=ANY($5::text[])))
           AND ($6::text[] IS NULL OR j.lang_key IN (SELECT lang_key FROM gold.dim_lang WHERE lower(code)=ANY($6::text[])))
           AND ($7::text[] IS NULL OR j.engine_key IN (SELECT engine_key FROM gold.dim_engine WHERE lower(code)=ANY($7::text[])))) AS on_axes
      FROM gold.job_index j
     WHERE ($5::text[] IS NOT NULL OR $6::text[] IS NOT NULL OR $7::text[] IS NOT NULL)
       AND j.surface=2 AND ($3::date IS NULL OR j.round_date<=$3::date)
     GROUP BY 1),
  cyc AS (
    SELECT d.cyc_key,d.surface,d.project_key,d.round_date,date_trunc('week',d.round_date)::date AS wk,d.status,d.servable,d.view_date,
           coalesce(d.hidden_scope,0) AS hidden_scope,
           CASE d.surface WHEN 1 THEN 'global' ELSE 'website' END AS scope
      FROM gold.dim_cycle d
      LEFT JOIN gold.dim_project dp ON dp.project_key=d.project_key
      LEFT JOIN gold.dim_country dc ON dc.geo_key=dp.site_geo_key
      LEFT JOIN measured m ON m.project_key=d.project_key
     WHERE d.surface IN (1,2) AND ($3::date IS NULL OR d.round_date<=$3::date)
       AND (d.surface=1 OR (($4::int IS NULL OR (dp.site_brand_bit & $4::int)<>0)
            AND (m.on_axes OR (m.project_key IS NULL AND ($5::text[] IS NULL OR lower(dc.code)=ANY($5::text[]))))))),
  judged AS (
    SELECT c.*,(c.status=2 AND c.servable AND (c.view_date IS NULL OR c.view_date<=$1::date)
        AND EXISTS (SELECT 1 FROM rel r WHERE r.scope=c.scope)
        AND NOT EXISTS (SELECT 1 FROM rel r WHERE r.scope=c.scope AND NOT EXISTS (
            SELECT 1 FROM gold.release_item ri JOIN gold.build bu ON bu.build_id=ri.build_id AND bu.status='validated'
             WHERE ri.release_id=r.release_id AND ri.family='fact' AND ri.state='ready' AND ri.slice_key='cyc:'||c.cyc_key::text))
      ) AS complete
      FROM cyc c),
  verdict AS (
    SELECT j.*,(j.hidden_scope<>1 AND NOT j.complete
        AND (j.status=0 OR (j.status=2 AND j.servable))) AS blocking
      FROM judged j),
  site_week AS (
    SELECT surface,wk,project_key,bool_or(complete AND hidden_scope<>1) AS shown,bool_or(blocking) AS waiting,
           bool_or(hidden_scope=1) AS hidden
      FROM verdict GROUP BY 1,2,3),
  week_day AS (
    SELECT v.surface,v.wk,array_agg(DISTINCT v.round_date ORDER BY v.round_date) AS days
      FROM verdict v JOIN site_week s ON s.surface=v.surface AND s.wk=v.wk AND s.project_key=v.project_key
     WHERE (v.complete AND v.hidden_scope<>1) OR NOT s.shown GROUP BY 1,2)
SELECT s.surface,s.wk AS week_start,count(*)::int AS sites,(count(*) FILTER (WHERE s.shown))::int AS shown,
       (count(*) FILTER (WHERE NOT s.shown AND s.waiting))::int AS unpublished,
       (count(*) FILTER (WHERE NOT s.shown AND NOT s.waiting AND s.hidden))::int AS hidden,
       (count(*) FILTER (WHERE NOT s.shown AND NOT s.waiting AND NOT s.hidden))::int AS other,w.days
  FROM site_week s JOIN week_day w ON w.surface=s.surface AND w.wk=s.wk
 GROUP BY 1,2,w.days HAVING bool_or(NOT s.shown) ORDER BY 1,2"""


async def read(ctx: Context) -> dict:
    if ctx.sf not in SURFACE_NAMES:
        raise HTTPException(422, "Week notes are read on the global or website surface")
    brands = ctx.bits if values(ctx.q, "brand") else None
    # the axes the reads take a site's cells by (Context.predicate: country, lang, engine), lower case as they bind them
    countries, langs, engines = ([v.lower() for v in values(ctx.q, axis)] or None for axis in ("country", "lang", "engine"))
    today, signature, week = datetime.now(ZoneInfo("Asia/Seoul")).date(), os.environ.get("HGH_GOLD_RULE_SIGNATURE") or None, ctx.week
    rows = await ctx.conn.fetch(NOTES_SQL, today, signature, week.end if week is not None else None, brands, countries,
                                langs, engines)
    rounds = None
    if week is not None:   # no week (no HUB data DB): nothing is capped, no week to hold a round
        rounds = dict.fromkeys(SURFACE_NAMES.values(), False)
        for r in await ctx.conn.fetch(ROUNDS_SQL, today, signature, week.start, week.end):
            rounds[r["scope"]] = rounds[r["scope"]] or r["holds"]
    return envelope(ctx, {"items": [{"surface": SURFACE_NAMES[r["surface"]], "week_start": r["week_start"], "sites": r["sites"],
                                     "shown": r["shown"], "unpublished": r["unpublished"], "hidden": r["hidden"],
                                     "other": r["other"], "days": list(r["days"] or [])} for r in rows],
                          "week_start": week.start if week is not None else None, "rounds": rounds})
