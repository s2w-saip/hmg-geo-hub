"""Gold citation readers (bff.gold_reader.citations, .drilldown) over a recording stand-in connection: the 자사
citation each surface counts and the 자사 미인용 bucket, as Gold defines them (gold.citation_cell comment: 자사 판정은
표면별 — global = owner_key = ANY(허용 배열), website = loc_owned ∨ tgt_hit, project = loc_owned; 자사 미인용 = 인용(호스트
있는)은 1건 이상인데 자사 인용이 0 인 프롬프트). 2026-10-30 W6 review."""
import asyncio
import unittest
from datetime import date

try:
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


if __name__ == "__main__":
    unittest.main()
