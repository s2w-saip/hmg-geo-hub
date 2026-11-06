"""The reads on live gold_db: what a /v1 read answers is what the metric functions calculate on the same data source, and the rules that read the input store. Upstream's precomputed
cells these tests once compared with are gone with the query tables (T9.7, T12.1). Needs HGH_GOLD_DB_URL (read only); skipped without it.
Run: env $(grep HGH_GOLD_DB_URL ../.env.gold.local) python -X utf8 -m unittest data_server.tests.test_metrics_live"""
import asyncio
import os
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

try:
    import asyncpg
    from starlette.datastructures import QueryParams

    from data_server.gold_reader import acr, metrics
    from data_server.gold_reader.context import CALENDAR_SQL, Context
    from data_server.metrics import compute
    from data_server.hub_stores import input_db
    from data_server.metrics import gold_judged, judgments
    from data_server.metrics.gold_current import GoldCurrentSource
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_metrics_live)") from exc

DSN = os.environ.get("HGH_GOLD_DB_URL", "").strip()
PROJECT = "843ecb1b-4713-4c2a-8592-e173eb16b7c7"


async def latest_round(conn, surface: str, **q) -> Context:
    ctx = await Context.create(conn, QueryParams({"surface": surface, **q}), capped=False)
    today = datetime.now(ZoneInfo("Asia/Seoul")).date()
    ctx.dates = [r["round_date"] for r in await conn.fetch(CALENDAR_SQL, ctx.sf, ctx.project_key, today, ctx.release["release_id"], None)]
    ctx.selected_dates = ctx.dates[:1]
    return ctx


@unittest.skipUnless(DSN, "HGH_GOLD_DB_URL is not set")
class OnLiveGold(unittest.TestCase):
    def run_read(self, read):
        async def main():
            conn = await asyncpg.connect(DSN, statement_cache_size=0, server_settings={"default_transaction_read_only": "on", "jit": "off", "work_mem": "32MB"})  # as the API's pool
            try:
                async with conn.transaction(isolation="repeatable_read", readonly=True):
                    await read(conn)
            finally:
                await conn.close()
        asyncio.run(main())


    def test_website_urls_and_owned(self):
        """자사 URL is what the sites registered (decision 2026-11-06), so only the rest equals upstream's cells."""
        async def read(conn):
            await input_db.open_pool()
            try:
                ctx = await latest_round(conn, "website")
                source = GoldCurrentSource(ctx)
                ours = (await source.citation_counts())[0]
                self.assertLessEqual(ours["owned"], ours["citations"])
                url = (await source.url_counts())[0]
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


    def test_the_reads_and_the_metric_functions_agree(self):
        """One definition: what a /v1 read answers is what data_server.metrics.compute calculates on the same data source."""
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
