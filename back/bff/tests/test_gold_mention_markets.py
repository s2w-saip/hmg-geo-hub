"""The Gold reads behind the renewal Website Mention's market table and 미언급 list (2026-11-02,
docs/handoff/website-mention-redesign.md): counts per country, the prompts missing on some engines only, the target URL."""
from __future__ import annotations

import asyncio
import unittest
from datetime import date

try:
    from starlette.datastructures import QueryParams

    from bff.gold_reader import drilldown
    from bff.gold_reader.context import Context
except ModuleNotFoundError as exc:  # pragma: no cover - outside the API image
    raise unittest.SkipTest("Run inside the BFF image") from exc

D = date(2026, 10, 9)


class Conn:
    def __init__(self, rows):
        self.rows = rows
        self.sql: list[str] = []

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        return [] if "job_index" in sql else self.rows


def context(conn: Conn, qs: str = "") -> Context:
    ctx = Context(conn, QueryParams("surface=website&" + qs))
    ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
    ctx.builds = {"fact": [1], "mentions": [1], "citations": [1]}
    ctx.dates = [D]
    ctx.selected_dates = [D]
    return ctx


class MarketGaps(unittest.TestCase):
    def test_counts_per_country(self):
        conn = Conn([{"code": "US", "missing": 150, "with_brands": 4, "answers_no_brand": 301}])
        got = asyncio.run(drilldown.market_gaps(context(conn)))
        self.assertEqual(got["data"]["items"], [{"country": "US", "missing": 150, "with_brands": 4, "answers_no_brand": 301}])
        sql = conn.sql[0]
        # a missing prompt is the 미언급 count's (same cells), an answer without a brand is Gold's ment_total = 0
        self.assertIn("HAVING bool_or(f.has_measured) AND NOT bool_or(f.has_mention)", sql)
        self.assertIn("WHERE ment=0", sql)
        self.assertIn("gold.answer_fact a", sql)

    def test_no_snapshot_no_rows(self):
        ctx = context(Conn([]))
        ctx.selected_dates = []
        self.assertEqual(asyncio.run(drilldown.market_gaps(ctx))["data"]["items"], [])


class MissingPromptsList(unittest.TestCase):
    ROW = {"prompt_key": 7, "prompt_id": "p1", "text": "Q?", "funnel": None, "answers": 2, "brand_mentions": 3, "total_rows": 1,
           "with_brand_rows": 1, "target": "kia.com/us/ev6", "measured_engines": ["chatgpt", "gemini"], "mentioned_engines": ["chatgpt"], "n": 5}

    def test_a_row_names_its_target_page(self):
        conn = Conn([self.ROW])
        got = asyncio.run(drilldown.missing_prompts(context(conn)))
        self.assertEqual(got["data"]["items"][0]["target_url"], "kia.com/us/ev6")

    def test_the_partial_list_holds_the_prompts_an_engine_left_out(self):
        conn = Conn([self.ROW])
        got = asyncio.run(drilldown.missing_prompts(context(conn, "partial=true")))
        self.assertIn("HAVING bool_or(f.has_mention)", conn.sql[0])
        self.assertIn("FILTER(WHERE f.has_measured)", conn.sql[0])
        self.assertEqual(got["data"]["items"][0]["missing_engines"], ["gemini"])

    def test_the_whole_list_counts_the_partial_prompts(self):
        conn = Conn([self.ROW])
        got = asyncio.run(drilldown.missing_prompts(context(conn)))
        self.assertEqual(got["data"]["counts"]["partial"], 5)


if __name__ == "__main__":
    unittest.main()
