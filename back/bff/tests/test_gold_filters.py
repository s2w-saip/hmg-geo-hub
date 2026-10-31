"""Filters, picks, sorts and searches the Gold readers must apply (2026-10-29 metric review R4: each was ignored,
so the page showed unfiltered numbers under a filter, lost a pick, or could not page or search)."""
import asyncio
import unittest
from datetime import date
from unittest import mock

try:
    from starlette.datastructures import QueryParams

    from bff.gold_reader import citations, drilldown, metrics
    from bff.gold_reader.context import Context
    from bff.screens import citation, citation_model
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_gold_filters)") from exc

D = date(2026, 10, 5)


def context(conn, qs: str) -> Context:
    ctx = Context(conn, QueryParams(qs))
    ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
    ctx.builds = {"cell": [1], "fact": [2]}
    ctx.dates = [D]
    ctx.selected_dates = [D]
    return ctx


def domain_row(skey, slug, citations, prompts=1, answers=1, owned=0):
    return {"skey": skey, "domain": skey, "is_social": False, "owned_brand_bit": 0, "competitor_brand_key": None,
            "category_key": 1, "slug": slug, "category_name": slug, "competitor_brand": None,
            "citations": citations, "answers": answers, "prompts": prompts, "owned": owned, "target": False}


class DomainsConn:
    def __init__(self, rows):
        self.rows = rows

    async def fetch(self, sql, *args):
        if "FROM gold.dim_owned_base" in sql:  # the global 자사 판정's 허용 배열 (citations.owned_bases)
            return []
        assert "FROM gold.citation_fact" in sql
        return self.rows

    async def fetchval(self, sql, *args):
        return 100


ROWS = [domain_row("toyota.com", "officialCompetitor", 50, prompts=3, answers=9), domain_row("cars.com", "automotiveMedia", 40, prompts=9, answers=4),
        domain_row("bmw.com", "officialCompetitor", 30, prompts=5, answers=6), domain_row("toyota.be", "officialCompetitor", 3, prompts=1, answers=1)]


def domains(qs):
    return asyncio.run(citations.domains(context(DomainsConn(ROWS), "surface=global&" + qs)))["data"]["items"]


class Domains(unittest.TestCase):
    def test_skey_keeps_only_those_sources(self):
        # Citation E: toyota.be (beyond the first rows) 0 for 345 — the pick read got the unfiltered top rows
        self.assertEqual([r["skey"] for r in domains("skey=toyota.be&skey=toyota.com")], ["toyota.com", "toyota.be"])

    def test_a_competitor_pick_narrows_official_competitor_only_and_renumbers(self):
        rows = domains("competitor=toyota.be")
        self.assertEqual([(r["skey"], r["rank"]) for r in rows], [("cars.com", 1), ("toyota.be", 2)])

    def test_the_sort_and_direction_with_ties_by_rank(self):
        self.assertEqual([r["skey"] for r in domains("sort=prompts")], ["cars.com", "bmw.com", "toyota.com", "toyota.be"])
        self.assertEqual([r["skey"] for r in domains("sort=skey")], ["bmw.com", "cars.com", "toyota.be", "toyota.com"])
        self.assertEqual([r["skey"] for r in domains("sort=citations&dir=asc")], ["toyota.be", "bmw.com", "cars.com", "toyota.com"])
        self.assertEqual([r["skey"] for r in domains("sort=coverage")], ["toyota.com", "bmw.com", "cars.com", "toyota.be"])

    def test_search_matches_the_source_key_and_keeps_the_rank(self):
        self.assertEqual([(r["skey"], r["rank"]) for r in domains("q=TOYOTA")], [("toyota.com", 1), ("toyota.be", 4)])


class SourcesConn:
    def __init__(self):
        self.sql = []

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        if "FROM gold.citation_cell" in sql:
            return []
        if "gold.dim_engine" in sql and "citation_fact" not in sql:
            return [{"engine_key": 1, "code": "chatgpt"}]
        if "GROUP BY f.engine_key,f.source_key" in sql:
            return [{"engine_key": 1, "citations": n, "skey": s, "domain": s, "category_key": k, "slug": slug, "category_name": slug}
                    for s, k, slug, n in (("a.com", 12, "academicResearch", 5), ("b.org", 12, "academicResearch", 4),
                                          ("c.edu", 12, "academicResearch", 3), ("d.net", 12, "academicResearch", 2),
                                          ("kia.com", 1, "officialHmg", 50))]
        return []


class Sources(unittest.TestCase):
    def test_each_category_names_its_top_sources_over_every_source(self):
        # the tooltip took its top 3 from the domain table's first page: 학술·연구 listed none
        conn = SourcesConn()
        data = asyncio.run(citations.sources(context(conn, "surface=global&include_tone=false&include_types=false")))["data"]
        top = {c["category"]["slug"]: [(s["skey"], s["citations"]) for s in c["top_sources"]] for c in data["categories"]}
        self.assertEqual(top, {"officialHmg": [("kia.com", 50)], "academicResearch": [("a.com", 5), ("b.org", 4), ("c.edu", 3)]})

    def test_the_source_filter_narrows_the_type_matrix(self):
        # D: 출처 = 공식(HMG) still showed every category's type counts (1,400,034 for 452,842)
        conn = SourcesConn()
        asyncio.run(citations.sources(context(conn, "surface=global&source=officialHmg")))
        cells = next(s for s in conn.sql if "FROM gold.citation_cell" in s)
        self.assertRegex(cells, r"f\.category_key IN \(SELECT category_key FROM gold\.dim_category WHERE slug=ANY\(\$\d+::text\[\]\)\)")


class ToneConn:
    def __init__(self, total=120):
        self.sql, self.args, self.total = [], [], total

    def main(self):
        return next(s for s in self.sql if "WITH t AS" in s)

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        self.args.append(args)
        if "FROM gold.dim_engine" in sql and "WITH t AS" not in sql:
            return [{"engine_key": 1, "code": "chatgpt"}]
        by_source = "GROUP BY f.source_key" in sql
        return [{"skey": "kia.com", "domain": "kia.com", "category_key": 1, "slug": "officialHmg", "category_name": "Official (HMG)",
                 "citations": 9, "engine_keys": [1], "total": self.total,
                 **({"n_pos": 226805, "n_neg": 10877} if "n_pos" in sql else {}),
                 **({} if by_source else {"url": "https://www.kia.com/a#x", "title": "t"})}]

    async def fetchrow(self, sql, *args):
        self.sql.append(sql)
        return {"positive": 226805, "negative": 10877}


class Tone(unittest.TestCase):
    def read(self, qs, total=120):
        conn = ToneConn(total)
        out = asyncio.run(drilldown.tone(context(conn, "surface=global&tone=positive&limit=50&" + qs)))
        return out, conn

    def test_the_tabs_count_distinct_urls_of_each_tone(self):
        out, _ = self.read("with_counts=true")
        self.assertEqual(out["data"]["counts"], {"positive": 226805, "negative": 10877})
        out, _ = self.read("with_counts=true&group_by=source")
        self.assertEqual(out["data"]["counts"], {"positive": 226805, "negative": 10877})

    def test_a_next_page_while_rows_remain(self):
        out, _ = self.read("cursor=50")
        self.assertEqual(out["meta"]["page"]["next_cursor"], "100")
        out, _ = self.read("cursor=100")
        self.assertIsNone(out["meta"]["page"]["next_cursor"])

    def test_search_and_grouping_by_source(self):
        out, conn = self.read("q=consumer_reports&group_by=source")
        sql = conn.main()
        self.assertIn("GROUP BY f.source_key", sql)
        self.assertRegex(sql, r"s\.skey ILIKE \$\d+")
        self.assertIn("%consumer\\_reports%", conn.args[0])
        self.assertEqual([(r["key"], r["url"], r["engines"]) for r in out["data"]["items"]], [("kia.com", None, ["chatgpt"])])
        _, conn = self.read("q=kia.com/a")
        self.assertRegex(conn.main(), r"regexp_replace\(regexp_replace\(u\.url,.*\) ILIKE \$\d+")


class EngineConn:
    async def fetch(self, sql, *args):
        if "gold.dim_engine" in sql and "kpi_cell" not in sql:
            return [{"engine_key": 1, "code": "chatgpt"}, {"engine_key": 2, "code": "gemini"}]
        if "FROM gold.kpi_cell" in sql:
            row = dict.fromkeys(metrics.COUNTS, 0)
            row.update(measured_prompts=0, mentioned_prompts=0, answers=100, tracked=80, own_mentions=40, total_mentions=100, n=0)
            if "GROUP BY f.engine_key" in sql:
                return [{**row, "engine_key": 1}, {**row, "engine_key": 2, "answers": 0}]
            return [row]
        if "FROM gold.brand_cell" in sql:
            base = {"rank_sum": 0, "ranked": 0, "positive": 0, "neutral": 0, "mixed": 0, "negative": 0, "multi_answers": 0,
                    "multi_mentions": 0, "prompts": 1, "multi_prompts": 0, **{f"t_{t}": 0 for t in metrics.TYPES}}
            rows = [{**base, "brand_key": 9, "name": "Toyota", "own_bit": 0, "mentions": 30, "answers": 11},
                    {**base, "brand_key": 7, "name": "Kia", "own_bit": 2, "mentions": 40, "answers": 80}]
            return [{**r, "engine_key": 1} for r in rows] if "f.engine_key" in sql else rows
        raise AssertionError(sql[:120])

    async def fetchval(self, sql, *args):
        return 0


class EngineBrands(unittest.TestCase):
    def test_group_by_engine_answers_each_engine(self):
        # Mention 엔진 카드: 경쟁사 평균 "—" (상위 0개사) — by_engine was never sent
        data = asyncio.run(metrics.brands(context(EngineConn(), "surface=global&group_by=engine&top_n=30")))["data"]
        self.assertEqual([e["engine"] for e in data["by_engine"]], ["chatgpt"])  # an engine without answers has no block
        chatgpt = data["by_engine"][0]
        self.assertEqual([(b["name"], b["is_own"], b["exposure"]) for b in chatgpt["brands"]],
                         [("HMG", True, {"num": 80, "den": 100}), ("Toyota", False, {"num": 11, "den": 100})])


class CitationSourceFilter(unittest.TestCase):
    """D (출처 = 공식(HMG)): 미인용 530 for 5,758 and "100.0% ▲1.3pp" for 100 % → 100 %."""

    def reads(self):
        calls = []

        async def get(path, params=None):
            calls.append(path)
            if path == "trend" and dict(params).get("dimension") == "none":
                # the Overview card trend (cells, no 출처 axis): 23.7 % → 25.0 %
                return {"data": {"bucket": "cycle", "dimension": "none", "own_label": "HMG", "dims": None,
                                 "buckets": [{"key": k, "round_dates": [k], "measured_days": None} for k in ("2026-09-28", "2026-10-05")],
                                 "series": [{"metric": m, "kind": "ratio", "key": None, "label": "HMG",
                                             "points": [{"bucket": k, "ratio": {"num": n, "den": 1000}, "gap": False}
                                                        for k, n in (("2026-09-28", 237), ("2026-10-05", 250))]}
                                            for m in ("visibility", "citation_share")]}, "meta": {}}
            if path == "trend":
                return {"data": {"bucket": "cycle", "dimension": "category", "own_label": "HMG", "dims": None,
                                 "buckets": [{"key": "2026-09-28", "round_dates": ["2026-09-28"], "measured_days": None},
                                             {"key": "2026-10-05", "round_dates": ["2026-10-05"], "measured_days": None}],
                                 "series": [{"metric": "category_share", "kind": "ratio", "key": "officialHmg", "label": "Official (HMG)",
                                             "points": [{"bucket": k, "ratio": {"num": n, "den": n}, "gap": False} for k, n in
                                                        (("2026-09-28", 200), ("2026-10-05", 233))]}]}, "meta": {}}
            raise AssertionError(path)

        return get, calls

    def test_the_official_delta_is_the_filtered_category_delta(self):
        get, calls = self.reads()
        with mock.patch("bff.api.get", get):
            out = asyncio.run(citation.load_deltas(citation.Reads({"sourceCategory": ["officialHmg"]}, {"surface": "global"})))
        self.assertIsNone(out["officialDelta"])
        self.assertEqual(citation_model.category_delta(out["prevCategories"], "Official (HMG)", 100.0), 0.0)

    def test_the_prompt_split_is_not_computed(self):
        live = citation_model.to_citations_live({
            "domains": {"data": {"summary": {"total_citations": 10, "unique_sources": 1, "own_share": None}, "items": []}, "meta": {}},
            "sources": {"data": {"total_citations": 10, "categories": [], "by_engine": []}, "meta": {}},
            "owned": None, "splitOff": True})
        self.assertNotIn("promptSplit", live)
        self.assertEqual(citation_model.lens(live, None, None, ["Official (HMG)"], {})["split"], {"kind": "notComputed"})


if __name__ == "__main__":
    unittest.main()
