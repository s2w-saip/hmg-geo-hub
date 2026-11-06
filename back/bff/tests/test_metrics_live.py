"""Adapter ① against upstream's precomputed cells on live Gold, one round per data family: the answer-level counts must equal what the
cells (a separate upstream calculation, which the reads no longer use) hold. Needs HGH_GOLD_DB_URL (read only); skipped without it.
Run: env $(grep HGH_GOLD_DB_URL ../.env.gold.local) python -X utf8 -m unittest bff.tests.test_metrics_live"""
import asyncio
import os
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

try:
    import asyncpg
    from starlette.datastructures import QueryParams

    from bff.gold_reader import acr, citations, metrics
    from bff.gold_reader.context import CALENDAR_SQL, SQL, Context
    from bff.metrics import compute
    from bff.metrics.catalog import MONITORING, REPRESENTATIVE
    from bff.hub_stores import input_db
    from bff.metrics import gold_judged, judgments
    from bff.metrics.gold_current import GoldCurrentSource
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_metrics_live)") from exc

DSN = os.environ.get("HGH_GOLD_DB_URL", "").strip()
PROJECT = "843ecb1b-4713-4c2a-8592-e173eb16b7c7"
MENTIONS, REPRESENTATIVES, CITATIONS, URLS = 1, 8, 2, 4
SUMS = ("answers", "tracked", "own_mentions", "total_mentions", "sent_pos", "sent_neg", "sent_all", "rank_sum", "ranked", "fp_sum", "fp_n",
        "multi_answers", "multi_mentions", "gap_answers", "gap_base", "cit_total", "cit_total_all", "cit_m05", "cit_target", "cit_owned",
        "t_mention", "t_recommendation", "t_comparison", "t_definition", "t_final_choice")


async def latest_round(conn, surface: str, **q) -> Context:
    ctx = await Context.create(conn, QueryParams({"surface": surface, **q}), capped=False)
    today = datetime.now(ZoneInfo("Asia/Seoul")).date()
    ctx.dates = [r["round_date"] for r in await conn.fetch(CALENDAR_SQL, ctx.sf, ctx.project_key, today, ctx.release["release_id"], None)]
    ctx.selected_dates = ctx.dates[:1]
    return ctx


def as_upstream(ctx: Context) -> list[int]:
    """Upstream's cells keep the older ACR answers the BFF leaves out: compare on the same answers. The kept list, to check the rule."""
    older, ctx.older_acr = ctx.older_acr, []
    return older


async def cell_sums(ctx: Context, population: int) -> dict:
    """Upstream's own sums of kpi_cell for the context's scope."""
    b = SQL()
    where = ctx.predicate(b, perspective=True, measure_family="citations" if population == CITATIONS else "mentions") + f" AND f.population_key={population}"
    sums = ",".join(f"coalesce(sum(f.{c}),0)::bigint AS {c}" for c in SUMS)
    return dict(await ctx.conn.fetchrow(f"SELECT {sums} FROM gold.kpi_cell f WHERE {where}", *b.args))


async def brand_sums(ctx: Context) -> dict:
    b = SQL()
    where = ctx.predicate(b) + f" AND f.population_key={MENTIONS} AND f.competitive"
    return {r["brand_key"]: dict(r) for r in await ctx.conn.fetch(f"""SELECT f.brand_key,sum(f.mention_count)::bigint AS mentions,sum(f.answers_present)::bigint AS answers,
        sum(f.rank_sum)::bigint AS rk_sum,sum(f.fp_sum)::bigint AS fp_sum,sum(f.s_pos)::bigint AS s_pos,sum(f.t_mention)::bigint AS t_mention
        FROM gold.brand_cell f WHERE {where} GROUP BY f.brand_key ORDER BY mentions DESC LIMIT 50""", *b.args)}


@unittest.skipUnless(DSN, "HGH_GOLD_DB_URL is not set")
class AgainstCells(unittest.TestCase):
    def run_read(self, read):
        async def main():
            conn = await asyncpg.connect(DSN, statement_cache_size=0, server_settings={"default_transaction_read_only": "on", "jit": "off", "work_mem": "32MB"})  # as the API's pool
            try:
                async with conn.transaction(isolation="repeatable_read", readonly=True):
                    await read(conn)
            finally:
                await conn.close()
        asyncio.run(main())

    def assert_same(self, ours, theirs, pairs):
        for mine, cell in pairs:
            self.assertEqual(ours[mine], theirs[cell], f"{mine} vs {cell}")

    def test_mentions_for_both_populations_and_one_brand(self):
        async def read(conn):
            for q in ({}, {"brand": "kia"}):
                ctx = await latest_round(conn, "global", **q)
                older = as_upstream(ctx)
                source = GoldCurrentSource(ctx)
                pairs = [(k, k) for k in ("answers", "tracked", "own_mentions", "total_mentions", "sent_pos", "sent_neg", "sent_all",
                                          "multi_answers", "multi_mentions")] + [("rk_sum", "rank_sum"), ("rk_count", "ranked"), ("rank_sum", "fp_sum"), ("ranked", "fp_n")]
                monitoring, representative = await cell_sums(ctx, MENTIONS), await cell_sums(ctx, REPRESENTATIVES)
                self.assert_same((await source.answer_counts(MONITORING))[0], monitoring, pairs)
                self.assert_same((await source.answer_counts(REPRESENTATIVE))[0], representative, pairs)
                # the row the /v1 reads take: 노출률 on the representative answers, the rest on the monitoring ones
                ctx.older_acr = older
                row = (await metrics.counts(ctx, prompts=False))[0]
                self.assertEqual((row["answers"], row["tracked"]), (representative["answers"], representative["tracked"]))
                # one answer per ACR cell: the monitoring answers, less the older runs' answers of this round
                ctx.older_acr = []
                b = SQL()
                where = ctx.predicate(b, family="fact")
                left_out = await conn.fetchval(f"SELECT count(*) FROM gold.answer_fact f WHERE {where} AND f.std_in AND f.answer_key=ANY({b.bind(older, 'bigint[]')})", *b.args)
                ctx.older_acr = older
                self.assertGreater(left_out, 0)
                self.assertEqual(row["answers_mon"], monitoring["answers"] - left_out)
                self.assertLess(row["own_mentions"], monitoring["own_mentions"])
            ctx = await latest_round(conn, "global")
            as_upstream(ctx)
            source = GoldCurrentSource(ctx)
            own = (await source.own_brand_counts(MONITORING))[0]
            cell = await cell_sums(ctx, MENTIONS)
            self.assert_same(own, cell, [(f"t_{t}", f"t_{t}") for t in metrics.TYPES])
            self.assertEqual(sum(own[k] for k in ("s_pos", "s_neu", "s_neg", "s_mix")), cell["sent_all"])
            ours = {r["brand_key"]: r for r in await source.brand_counts(MONITORING)}
            for key, row in (await brand_sums(ctx)).items():
                self.assert_same(ours[key], row, [("mentions", "mentions"), ("answers", "answers"), ("rk_sum", "rk_sum"), ("rank_sum", "fp_sum"), ("s_pos", "s_pos"), ("signals_mention", "t_mention")])
        self.run_read(read)

    def test_citations(self):
        async def read(conn):
            ctx = await latest_round(conn, "global")
            as_upstream(ctx)
            source = GoldCurrentSource(ctx)
            ours, cell = (await source.citation_counts())[0], await cell_sums(ctx, CITATIONS)
            self.assert_same(ours, cell, [("citations", "cit_total"), ("citations_all", "cit_total_all"), ("official", "cit_m05"), ("owned", "cit_owned"),
                                          ("gap_answers", "gap_answers"), ("base_answers", "gap_base")])
            ctx.q = QueryParams({"surface": "global", "limit": "3"})
            domains = (await citations.domains(ctx))["data"]
            rows = await source.source_counts()
            for row, top in zip(rows, domains["items"], strict=False):
                self.assertEqual((row["skey"], row["citations"], row["answers"], row["prompts"]), (top["skey"], top["citations"], top["citing_answers"], top["citing_prompts"]))
            read_back = (await citations.sources(ctx))["data"]
            self.assertEqual(await source.tone_counts(), read_back["tone"])
            b = SQL()
            where = ctx.predicate(b, perspective=True, measure_family="citations") + f" AND f.population_key={CITATIONS}"
            cells = dict(await conn.fetchrow(f"SELECT {','.join(f'sum(cit_t_{t})::bigint AS t_{t}' for t in metrics.TYPES)} FROM gold.citation_cell f WHERE {where}", *b.args))
            types = await source.type_category_counts()
            for t in metrics.TYPES:
                self.assertEqual(sum(r[f"t_{t}"] for r in types), cells[f"t_{t}"], t)
            prompts = await source.prompt_citation_counts()
            self.assertEqual(prompts["cited_prompts"], prompts["own_cited_prompts"] + prompts["uncited_prompts"])
        self.run_read(read)

    def url_cell_sums(self, ctx):
        b = SQL()
        where = ctx.predicate(b) + f" AND f.population_key={URLS}"
        return ctx.conn.fetchrow(f"""SELECT count(DISTINCT f.prompt_key) FILTER(WHERE f.eligible)::bigint AS measured,count(DISTINCT f.prompt_key) FILTER(WHERE f.eligible AND f.any_owned)::bigint AS owned,
            count(DISTINCT f.prompt_key) FILTER(WHERE f.eligible AND f.any_target)::bigint AS target,sum(f.own_url_hits)::bigint AS own_hits,sum(f.tgt_own_hits)::bigint AS tgt_own_hits
            FROM gold.url_prompt_cell f WHERE {where}""", *b.args)

    def test_website_urls_and_owned(self):
        """자사 URL is what the sites registered (decision 2026-11-06), so only the rest equals upstream's cells."""
        async def read(conn):
            await input_db.open_pool()
            try:
                ctx = await latest_round(conn, "website")
                source = GoldCurrentSource(ctx)
                ours = (await source.citation_counts())[0]
                cell = await cell_sums(ctx, CITATIONS)
                self.assert_same(ours, cell, [("citations", "cit_total"), ("target", "cit_target")])
                self.assertEqual(ours["owned"], ours["citations"] and ours["owned"])
                url, cells = (await source.url_counts())[0], await self.url_cell_sums(ctx)
                self.assert_same(url, cells, [("url_prompts", "measured"), ("url_target_prompts", "target")])
                self.assertGreater(url["url_own_prompts"], 0)
                # every counted pair is of an origin its site registered
                inputs = await gold_judged.read_inputs()
                sites = {r["project_key"]: r["id"] for r in await conn.fetch(
                    "SELECT project_key,coalesce(project_id,scope_project_id,site_id)::text AS id FROM gold.dim_project WHERE surface=2")}
                keys = (await gold_judged.owned_url_keys(ctx))[:300]
                urls = {r["url_key"]: r["u"] for r in await conn.fetch("SELECT url_key,coalesce(url_norm,url) AS u FROM gold.dim_url WHERE url_key=ANY($1::int[])",
                                                                       [k % 4294967296 for k in keys])}
                for k in keys:
                    self.assertTrue(judgments.is_registered(urls[k % 4294967296], inputs.registered[sites[k // 4294967296]]), k)
            finally:
                await input_db.close_pool()
        self.run_read(read)

    def test_the_rules_equal_upstreams_flags_on_every_round(self):
        """judgments against the flags they replaced, on the copy that still holds them: no answer differs."""
        async def read(conn):
            c = gold_judged.COLUMNS
            for surface, is_global in (("global", True), ("website", False), ("project", False)):
                builds = [r["build_id"] for r in await conn.fetch("""SELECT i.build_id FROM gold.active_release a JOIN gold.release_item i USING(release_id)
                    JOIN gold.build b USING(build_id) WHERE a.scope=$1 AND a.read_mode='live' AND i.family='fact' AND i.state='ready' AND b.status='validated'""", surface)]
                rules = {"elig": judgments.eligible(c, is_global=is_global), "cit_in": judgments.citation_monitoring(c, is_global=is_global),
                         "std_in": judgments.monitoring(c, is_global=is_global), "gap": "f.analysis_state>=2"}
                differ = ",".join(f"count(*) FILTER(WHERE f.{flag} IS DISTINCT FROM {rule}) AS {flag}" for flag, rule in rules.items())
                row = await conn.fetchrow(f"""SELECT {differ} FROM gold.answer_fact f JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key
                    LEFT JOIN gold.dim_country rc ON rc.geo_key=f.region_geo_key WHERE f.build_id=ANY($1::bigint[])""", builds)
                self.assertEqual(dict(row), dict.fromkeys(rules, 0), surface)
        self.run_read(read)

    def test_a_project(self):
        async def read(conn):
            ctx = await latest_round(conn, "project", project_id=PROJECT)
            source = GoldCurrentSource(ctx)
            pairs = [(k, k) for k in ("answers", "tracked", "own_mentions", "total_mentions", "sent_pos", "sent_all")]
            self.assert_same((await source.answer_counts(MONITORING))[0], await cell_sums(ctx, MENTIONS), pairs)
            self.assert_same((await source.citation_counts())[0], await cell_sums(ctx, CITATIONS), [("citations", "cit_total"), ("owned", "cit_owned"), ("target", "cit_target")])
            self.assert_same((await source.url_counts())[0], await self.url_cell_sums(ctx), [("url_prompts", "measured"), ("url_target_prompts", "target"),
                                                                                              ("url_own_answers", "own_hits"), ("url_target_answers", "tgt_own_hits")])
        self.run_read(read)

    def test_the_reads_and_the_metric_functions_agree(self):
        """One definition: what a /v1 read answers is what bff.metrics.compute calculates on the same data source."""
        async def read(conn):
            for surface, q in (("global", {}), ("global", {"brand": "kia"}), ("website", {}), ("project", {"project_id": PROJECT})):
                ctx = await latest_round(conn, surface, **q)
                source = GoldCurrentSource(ctx)
                mention, citation = (await compute.mention_values(source))[0]["values"], (await compute.citation_values(source))[0]["values"]
                data = (await metrics.summary(ctx))["data"]
                engines = (await metrics.engines(ctx))["data"]["total"]
                pairs = [(mention["exposure"], data["visibility"]), (mention["share"], data["share_of_voice"]), (mention["favorability"], data["sentiment"]),
                         (mention["priority"], data["position"]), (citation["citation_share_global" if surface == "global" else "citation_share_website"], data["citation_share"]),
                         (mention["top3_rate"], compute.top3_rate(engines["top3"], engines["tracked_mon"], engines["ranked"]))]
                if surface != "global":
                    url = (await compute.url_values(source))[0]["values"]
                    pairs += [(url["owned_url_rate"], data["owned_url_rate"]), (url["target_url_rate"], data["target_url_rate"]), (url["target_source_rate"], data["citation_accuracy"])]
                for i, (ours, theirs) in enumerate(pairs):
                    self.assertEqual(ours, theirs, f"{surface} {q} {i}")
                by_key = {b["brand_key"]: b["values"] for b in await compute.brand_values(source)}
                for row in (await metrics.brands(ctx))["data"]["brands"][:20]:
                    if row.get("brand_key") in by_key and not row["is_own"]:
                        self.assertEqual((by_key[row["brand_key"]]["exposure"], by_key[row["brand_key"]]["share"], by_key[row["brand_key"]]["priority"]),
                                         (row["exposure"], row["share"], row["avg_rank"]), row["name"])
        self.run_read(read)

    def test_acr(self):
        async def read(conn):
            ctx = await latest_round(conn, "global")
            ctx.q = QueryParams({"surface": "global", "territory_rows": "first"})
            data = (await acr.read(ctx))["data"]
            ours = await compute.acr_values(GoldCurrentSource(ctx))
            self.assertEqual((ours["totals"]["cells"], ours["totals"]["iterations"]), (data["totals"]["prompt_runs"], data["totals"]["iterations"]))
            self.assertEqual(ours["own"]["values"]["top1_acr"], data["own"]["choice_share"])
            self.assertEqual(ours["own"]["values"]["candidate_rate"], data["own"]["coverage"])
            self.assertEqual(ours["own"]["standing"], {"rank": data["own"]["rank"], "field": data["own"]["ranked_brands"]})
            for mine, theirs in zip(ours["brands"][:12], data["brands"], strict=False):
                self.assertEqual((mine["brand"], mine["choice"], mine["appeared_cells"]), (theirs["brand"], theirs["choice"], theirs["cells"]))
        self.run_read(read)


if __name__ == "__main__":
    unittest.main()
