"""Filters, picks, sorts and searches the Gold readers must apply (2026-10-29 metric review R4: each was ignored,
so the page showed unfiltered numbers under a filter, lost a pick, or could not page or search)."""
import asyncio
import unittest
from datetime import date
from unittest import mock

try:
    from starlette.datastructures import QueryParams

    from data_server.gold_reader import citations, context as context_module, drilldown, metrics
    from data_server.gold_reader.context import Context
    from data_server.screens import citation, citation_model
    from data_server.tests.test_gold_metrics import brand_row, counts_row
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_gold_filters)") from exc


def setUpModule():
    from data_server.tests.stand_ins import no_judged_answers
    no_judged_answers()

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
        if "bool_or(x.t_" in sql:  # GoldCurrentSource.type_category_counts
            return [{"category_key": 1, "slug": "officialHmg", "name": "Official (HMG)", **dict.fromkeys((f"t_{t}" for t in metrics.TYPES), 0),
                     "t_mention": 7, "t_final_choice": 2}]
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

    def test_the_type_matrix_counts_citations_with_a_source(self):
        # T9.8: its totals held the host-less citations the other citation counts leave out (575,083 against 575,079 on Global 10-05)
        conn = SourcesConn()
        asyncio.run(citations.sources(context(conn, "surface=global")))
        self.assertIn("f.source_key<>0", next(s for s in conn.sql if "FROM gold.answer_brand_fact x" in s))

    def test_the_source_filter_narrows_the_type_matrix(self):
        # D: 출처 = 공식(HMG) still showed every category's type counts (1,400,034 for 452,842)
        conn = SourcesConn()
        data = asyncio.run(citations.sources(context(conn, "surface=global&source=officialHmg")))["data"]
        matrix = next(s for s in conn.sql if "FROM gold.answer_brand_fact x" in s)
        self.assertRegex(matrix, r"f\.source_key IN \(SELECT s\.source_key FROM gold\.dim_source s JOIN gold\.dim_category d USING\(category_key\) WHERE d\.slug=ANY\(\$\d+::text\[\]\)\)")
        types = {t["type"]: (t["total"], t["categories"]) for t in data["types"]}
        self.assertEqual(types["mention"], (7, [{"category_key": 1, "citations": 7}]))
        self.assertEqual(types["final_choice"], (2, [{"category_key": 1, "citations": 2}]))
        self.assertEqual(types["comparison"], (0, []))


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
        self.assertRegex(conn.main(), r"regexp_replace\(regexp_replace\(t\.url,.*\) ILIKE \$\d+")


class EngineConn:
    async def fetch(self, sql, *args):
        if "FROM gold.answer_fact" in sql or "f.answer_key AS a_" in sql:
            own = {"tracked": 80, "own_mentions": 40, "total_mentions": 100}
            if "GROUP BY f.engine_key" in sql:
                return [counts_row(engine_key=1, answers=100, **own), counts_row(engine_key=2, answers=0, **own)]
            return [counts_row(answers=100, **own)]
        if "FROM gold.answer_brand_fact" in sql:
            rows = [brand_row(D, 9, "Toyota", 0, 30, 11, prompts=1, multi_prompts=0), brand_row(D, 7, "Kia", 2, 40, 80, prompts=1, multi_prompts=0)]
            return [{**r, "engine_key": 1} for r in rows] if "f.engine_key" in sql else rows
        if "gold.dim_engine" in sql:
            return [{"engine_key": 1, "code": "chatgpt"}, {"engine_key": 2, "code": "gemini"}]
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
        with mock.patch("data_server.api.get", get):
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



class TaxonomyCase(unittest.TestCase):
    """Global score sheet (2026-11-02): dim_taxon spells 47 depth3 values in two cases, so picking `Design` (587) left out
    `design` (286). A taxonomy pick matches regardless of case, as the country, language and engine axes do."""

    def test_a_pick_matches_both_spellings(self):
        src = open(context_module.__file__, encoding="utf8").read()
        self.assertIn("gold.dim_taxon WHERE lower(code)=ANY(", src)
        self.assertNotIn("gold.dim_taxon WHERE code=ANY(", src)


class CreateConn:
    """Context.create's reads: the release, its builds, the round dates and the catalog read under test."""

    def __init__(self, prompts=(11, 12)):
        self.prompts, self.catalog = prompts, []

    async def fetch(self, sql, *args):
        if "FROM gold.active_release" in sql:
            return [{"release_id": 1, "version": 1, "rule_signature": "test"}]
        if "FROM gold.release_item i" in sql:
            return [{"family": "cell", "build_id": 1, "round_date": D}, {"family": "fact", "build_id": 2, "round_date": D}]
        if "SELECT DISTINCT c.round_date" in sql:
            return [{"round_date": D}]
        if "SELECT DISTINCT f.answer_key" in sql:   # no ACR cell with several runs
            return []
        if "FROM gold.catalog_entry" in sql:
            self.catalog.append((sql, args))
            return [{"prompt_key": k} for k in self.prompts]
        raise AssertionError(sql)


class CatalogAxes(unittest.TestCase):
    """Overview check (2026-11-02): a catalog pick tested each cell row with EXISTS on catalog_entry, which has no
    prompt_key index; card reads planned a nested loop over it (1,451 rows estimated, 133k read). Country + 미포함 took
    13 s, 미포함 + a list type ran past Gold's 15 s and the page went empty. The matching prompts are read once per
    request instead, every axis on the same catalog row (231 prompts have several rows that differ)."""

    def create(self, qs, conn):
        return asyncio.run(Context.create(conn, QueryParams(qs)))

    def test_the_matching_prompts_are_read_once_and_bound(self):
        conn = CreateConn()
        ctx = self.create("surface=global&card=true&brand=kia&brand_presence=unbranded&list_type=Brand%20Message", conn)
        self.assertEqual(len(conn.catalog), 1)
        sql, args = conn.catalog[0]
        self.assertIn("presence_key IN", sql)
        self.assertIn("list_type_key IN", sql)
        self.assertIn([2], args)  # the fact builds
        self.assertIn(2 | 8, args)  # the brand bits with the shared bit
        b = context_module.SQL()
        where = ctx.predicate(b, "f", population="mentions")
        self.assertNotIn("catalog_entry", where)
        self.assertIn("f.prompt_key=ANY(", where)
        self.assertIn([11, 12], b.args)

    def test_no_pick_reads_no_catalog(self):
        conn = CreateConn()
        ctx = self.create("surface=global&card=true&country=DE", conn)
        self.assertEqual(conn.catalog, [])
        b = context_module.SQL()
        self.assertNotIn("prompt_key", ctx.predicate(b, "f"))

    def test_no_matching_prompt_matches_no_row(self):
        ctx = self.create("surface=global&list_type=none", CreateConn(prompts=()))
        b = context_module.SQL()
        self.assertIn("f.prompt_key=ANY(", ctx.predicate(b, "f"))
        self.assertIn([], b.args)

    def test_a_read_without_taxonomy_ignores_the_pick(self):
        ctx = self.create("surface=global&brand_presence=unbranded", CreateConn())
        b = context_module.SQL()
        self.assertNotIn("prompt_key", ctx.predicate(b, "f", taxonomy=False))


if __name__ == "__main__":
    unittest.main()
