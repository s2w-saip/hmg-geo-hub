"""Gold citation readers (bff.gold_reader.citations, .drilldown) over a recording stand-in connection: the 자사
citation each surface counts and the 자사 미인용 bucket, as Gold defines them (gold.citation_cell comment: 자사 판정은
표면별 — global = owner_key = ANY(허용 배열), website = loc_owned ∨ tgt_hit, project = loc_owned; 자사 미인용 = 인용(호스트
있는)은 1건 이상인데 자사 인용이 0 인 프롬프트). 2026-10-30 W6 review. And the Mention brand row's drill (prompts, citation
sources, one source's detail) reads that brand (BrandTarget, 2026-10-31 renewal audit 7-2)."""
import asyncio
import unittest
from datetime import date

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams

    from bff.gold_reader import citations, drilldown
    from bff.gold_reader.context import Context
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_gold_citations)") from exc

D1, D2 = date(2026, 10, 2), date(2026, 10, 9)


class Conn:
    """asyncpg stand-in: answers the citation fact and answer fact reads with fixed rows, records every statement."""

    def __init__(self, *, cited=(), measured=()):
        self.cited, self.measured, self.sql = list(cited), list(measured), []

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        if "FROM gold.citation_fact" in sql and "job_index" not in sql:
            return self.cited
        if "FROM gold.answer_fact" in sql:
            return self.measured
        return []

    async def fetchval(self, sql, *args):
        self.sql.append(sql)
        return 10


def context(conn: Conn, qs: str) -> Context:
    ctx = Context(conn, QueryParams(qs))
    ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
    ctx.builds = {"cell": [11], "fact": [12]}
    ctx.dates = [D2, D1]
    ctx.selected_dates = [D2]
    ctx.project_key = 7 if ctx.sf in (2, 3) else None
    return ctx


def owned_filter(sql: str) -> str:
    return sql.split("FILTER(WHERE ", 1)[1].split(")::int", 1)[0]


class OwnCitationBySurface(unittest.TestCase):
    def statements(self, qs: str, read) -> list[str]:
        conn = Conn()
        asyncio.run(read(context(conn, qs)))
        return [s for s in conn.sql if "FILTER(WHERE" in s]

    def test_website_counts_a_target_hit_as_own(self):
        for read in (citations.domains, drilldown.citation_prompts):
            (sql,) = self.statements("surface=website", read)
            self.assertEqual(owned_filter(sql), "(f.loc_owned OR f.tgt_hit)", read.__name__)

    def test_project_and_global_keep_their_rules(self):
        for read in (citations.domains, drilldown.citation_prompts):
            (sql,) = self.statements("surface=project&project=p1", read)
            self.assertEqual(owned_filter(sql), "f.loc_owned", read.__name__)
            (sql,) = self.statements("surface=global", read)
            self.assertIn("f.owner_key IN (SELECT owner_key FROM gold.dim_owned_base", owned_filter(sql), read.__name__)


class UncitedPrompts(unittest.TestCase):
    """A measured prompt without any citation is in neither bucket: 미인용 needs a citation (hosted) and no 자사 one."""

    def test_a_prompt_without_citations_is_not_uncited(self):
        cited = [{"prompt_id": 1, "text": "a", "funnel": None, "prompt_key": 1, "citations": 5, "own_citations": 0, "providers": ["chatgpt"]},
                 {"prompt_id": 2, "text": "b", "funnel": None, "prompt_key": 2, "citations": 4, "own_citations": 3, "providers": ["gemini"]}]
        measured = [{"prompt_key": k, "prompt_id": k, "text": t, "funnel": None} for k, t in ((1, "a"), (2, "b"), (3, "c"))]
        ctx = context(Conn(cited=cited, measured=measured), "surface=website&bucket=uncited&include_refs=false")
        got = asyncio.run(drilldown.citation_prompts(ctx))
        self.assertEqual(got["data"]["counts"], {"owned": 1, "uncited": 1})
        self.assertEqual([i["prompt_id"] for i in got["data"]["items"]], ["1"])


class BrandConn:
    """asyncpg stand-in of a brand row's drill (the Mention drawer): knows Gold's dim_brand names, answers every fact read
    with no rows, records every statement with its arguments."""

    BRANDS = {"Toyota": 2406}

    def __init__(self):
        self.calls: list[tuple[str, tuple]] = []

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        return []

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        if "FROM gold.dim_brand WHERE brand_key<>0" in sql:
            return self.BRANDS.get(args[0].strip())
        if "SELECT name FROM gold.dim_brand" in sql:
            return {v: k for k, v in self.BRANDS.items()}.get(args[0])
        return 0

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        if "FROM gold.dim_source" in sql:
            return {"source_key": 5, "skey": "kia.com", "domain": "kia.com", "is_social": False, "category_key": 1,
                    "slug": "officialHmg", "category_name": "Official (HMG)", "competitor_brand": None}
        return {"citations": 0, "owned": 0}

    def facts(self, table: str) -> list[tuple[str, tuple]]:
        return [(s, a) for s, a in self.calls if f"FROM gold.{table} f" in s]


MENTIONED = "EXISTS(SELECT 1 FROM gold.answer_brand_fact ab"


class BrandTarget(unittest.TestCase):
    """The brand row's prompts and citation sources tabs read that brand (2026-10-31 renewal audit 7-2). The contract's
    mention_brand is a display name the original API resolved to dim_brand.brand_key (name first, else bare); the reader
    ignored it, so every brand row listed 당사's prompts (own defaults to true) and every citation of the filter."""

    def run_read(self, read, qs: str, *args):
        conn = BrandConn()
        out = asyncio.run(read(context(conn, qs), *args))
        return conn, out

    def test_the_prompts_tab_reads_the_named_brand(self):
        conn, out = self.run_read(drilldown.mention_prompts, "surface=global&mode=brand&mention_brand=Toyota&limit=2000")
        self.assertEqual(out["data"]["target"], {"brand_key": 2406, "name": "Toyota", "signal": None})
        reads = conn.facts("answer_brand_fact")
        self.assertTrue(reads)
        for sql, args in reads:
            self.assertNotIn("own_bit", sql)
            self.assertIn(2406, args)

    def test_an_unknown_name_is_not_found(self):
        with self.assertRaises(HTTPException) as cm:
            self.run_read(drilldown.mention_prompts, "surface=global&mode=brand&mention_brand=Nope")
        self.assertEqual(cm.exception.status_code, 404)

    def test_own_stays_the_perspective(self):
        conn, out = self.run_read(drilldown.mention_prompts, "surface=global&mode=brand&own=true")
        self.assertEqual(out["data"]["target"]["name"], "HMG")
        self.assertTrue(all("own_bit" in sql for sql, _ in conn.facts("answer_brand_fact")))

    def test_the_citation_sources_count_the_brands_answers_only(self):
        """Every citation scan and the coverage denominator (answers) keep the answers where the brand is mentioned as
        the prompts tab counts it (std_in ∧ competitive ∧ mention_count > 0), as the original API (mention_brand_exists)."""
        conn, _ = self.run_read(citations.domains, "surface=global&mention_brand=Toyota&limit=2000")
        reads = conn.facts("citation_fact") + conn.facts("answer_fact")
        self.assertEqual(len(reads), 2)
        for sql, args in reads:
            self.assertIn(MENTIONED, sql)
            self.assertIn("ab.std_in AND ab.competitive AND ab.mention_count>0", sql)
            self.assertIn(2406, args)

    def test_the_own_row_counts_the_answers_of_any_own_brand(self):
        """The 당사 row (label HMG, no Gold brand under the HMG perspective) asks for the perspective's own brands."""
        conn, _ = self.run_read(citations.domains, "surface=global&mention_own=true&limit=2000")
        for sql, args in conn.facts("citation_fact") + conn.facts("answer_fact"):
            self.assertIn(MENTIONED, sql)
            self.assertIn("own_bit &", sql)
            self.assertIn(7, args)

    def test_an_unknown_name_has_no_citations(self):
        conn, out = self.run_read(citations.domains, "surface=global&mention_brand=Nope&limit=2000")
        self.assertEqual(conn.facts("citation_fact"), [])
        self.assertEqual((out["data"]["items"], out["meta"]["page"]["total"]), ([], 0))
        self.assertEqual(out["meta"]["dropped_filters"], {"mention_brand": ["Nope"]})

    def test_a_source_detail_keeps_the_brands_answers(self):
        conn, out = self.run_read(drilldown.domain, "surface=website&mention_brand=Toyota", "kia.com")
        reads = conn.facts("citation_fact")
        self.assertEqual(len(reads), 4)  # URLs, totals, prompts, answer refs
        for sql, args in reads:
            self.assertIn(MENTIONED, sql)
            self.assertIn(2406, args)
        conn, out = self.run_read(drilldown.domain, "surface=website&mention_brand=Nope", "kia.com")
        self.assertEqual(conn.facts("citation_fact"), [])
        self.assertEqual((out["data"]["urls"], out["data"]["prompts"], out["data"]["citations"]), ([], [], 0))

    def test_reads_without_a_target_are_unchanged(self):
        conn, _ = self.run_read(citations.domains, "surface=global&limit=50")
        self.assertTrue(all(MENTIONED not in sql for sql, _ in conn.calls))


if __name__ == "__main__":
    unittest.main()
