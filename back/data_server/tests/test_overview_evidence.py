"""The renewal Overview's 근거 drawer (2026-11-05 D-12 step 3): the answers listing's KPI split, marks and excerpt
(data_server.gold_reader.answers), the screen overview/market-evidence and the sample line's counts on the renewal geo rows."""
import asyncio
import json
import unittest
from datetime import date, datetime, timezone
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams

    from data_server.gold_reader import answers
    from data_server.gold_reader.context import Context
    from data_server.screens import build
    from data_server.screens import overview_evidence as ev
    from data_server.tests.test_screens_overview import META, Router, screen, summary
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_overview_evidence)") from exc


def setUpModule():
    from data_server.tests.stand_ins import no_judged_answers
    no_judged_answers()

D = date(2026, 10, 5)


class ListingConn:
    """asyncpg stand-in for answers.listing: the total, then the page rows; records the statements."""

    def __init__(self, rows, total=1):
        self.rows, self.total, self.sql = rows, total, []

    async def fetchval(self, sql, *args):
        self.sql.append(sql)
        return self.total

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        return self.rows


def fact(**extra) -> dict:
    row = {"job_id": "j1", "round_date": D, "anchor_date": D, "measured_at": datetime(2026, 10, 5, 3, tzinfo=timezone.utc),
           "prompt_id": "p1", "text": "Q?", "engine": "chatgpt", "country": "JP", "lang": "JA", "is_rep": True, "is_acr": False,
           "acr_iter_rank": 0, "analysis_state": 0, "mention_total": 5, "own_m": 3, "citations_all": 9, "citations_target": 0,
           "citations_own_or_target": 0, "citations_official": 3, "citations_hosted": 9}
    row.update(extra)
    return row


def listing(qs: str, rows, total=1):
    conn = ListingConn(rows, total)
    ctx = Context(conn, QueryParams(qs))
    ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
    ctx.builds = {"cell": [11], "fact": [12]}
    ctx.dates = ctx.selected_dates = [D]
    return asyncio.run(answers.listing(ctx)), conn


class Split(unittest.TestCase):
    """Each KPI's split is the answers its numerator counts and the rest of its denominator (the sums the table's
    value is made of; checked on Gold 10-05: JP 347 + 222 = 569, the position's 252 + 95 = 347 ranked)."""

    def test_each_kpis_numerator_and_rest(self):
        # the answers' key sets (metrics.gold_judged) an answer must be in and must not be in
        self.assertEqual(answers.split_sets("visibility", "num"), (("tracked",), ()))
        self.assertEqual(answers.split_sets("visibility", "rest"), ((), ("tracked",)))
        self.assertEqual(answers.split_sets("shareOfVoice", "rest"), (("mentioned",), ("tracked",)))
        self.assertEqual(answers.split_sets("sentiment", "num"), (("positive",), ()))
        self.assertEqual(answers.split_sets("sentiment", "rest"), (("with_sentiment",), ("positive",)))
        self.assertEqual(answers.split_sets("position", "num"), (("first",), ()))   # the text order, as AI 우선 노출도
        self.assertEqual(answers.split_sets("position", "rest"), (("later",), ()))
        self.assertEqual(answers.split_sets("citationShare", "rest"), (("hosted",), ("official",)))

    def test_an_unknown_split_is_refused(self):
        for split in ("nope:num", "visibility:half", "visibility"):
            with self.subTest(split=split), self.assertRaises(HTTPException) as caught:
                listing(f"surface=global&split={split}", [])
            self.assertEqual(caught.exception.status_code, 422)


class ListingMarks(unittest.TestCase):
    def test_the_drawer_read_filters_orders_and_marks(self):
        rows = [fact(own_rank=1, own_pos=4, own_neg=0, own_sent=6, answer_text="はい。IONIQ 5は良い", own_at=3, own_end=10,
                     own_terms=["IONIQ 5", "Hyundai"])]
        out, conn = listing("surface=global&rep=1&split=visibility:num&marks=1&excerpt=1&order=prompt&limit=50", rows, 347)
        count, page = conn.sql
        self.assertIn("AND f.is_rep", count)
        self.assertIn("AND f.is_rep", page)
        # the page is chosen before the bodies and occurrences are joined (joined first they took 14 s)
        self.assertIn("pg AS MATERIALIZED (", page)
        self.assertIn('ORDER BY p.text COLLATE "und-x-icu",e.code,c.code,f.answer_key LIMIT', page)
        self.assertIn('ORDER BY f.text COLLATE "und-x-icu",f.engine,f.country,f.answer_key', page)
        # Gold's first 당사 occurrence that lands on its surface text in the body
        self.assertIn("substr(bd.answer_text,o.source_start+1,o.source_end-o.source_start)=o.surface_text", page)
        item = out["data"]["items"][0]
        self.assertEqual(item["marks"], {"rank": 1, "sentiment": {"positive": 4, "negative": 0, "all": 6},
                                         "citations": {"official": 3, "all": 9}})
        self.assertEqual(item["own_occurrence"], {"start": 3, "end": 10})
        self.assertEqual(item["own_terms"], ["Hyundai", "IONIQ 5"])
        self.assertEqual(out["meta"]["page"]["total"], 347)

    def test_the_other_lists_read_as_before(self):
        out, conn = listing("surface=global&limit=20", [fact()])
        _, page = conn.sql
        self.assertNotIn("answer_body", page)
        self.assertIn("ORDER BY f.round_date DESC,f.answer_key DESC", page)
        self.assertNotIn("marks", out["data"]["items"][0])
        self.assertNotIn("answer_text", out["data"]["items"][0])


class Excerpt(unittest.TestCase):
    def test_the_text_around_the_first_own_occurrence(self):
        body = "x" * 100 + "Hyundai" + " **good**  car " + "y" * 300
        e = ev.excerpt_of(body, {"start": 100, "end": 107})
        self.assertEqual(e["mark"], "Hyundai")
        self.assertEqual(e["before"], "x" * 70)
        self.assertTrue(e["after"].startswith(" good car y"))
        self.assertEqual(len(e["after"]), len(" good car ") + 200 - len(" **good**  car "))
        self.assertEqual((e["cutStart"], e["cutEnd"]), (True, True))

    def test_a_cut_word_is_left_out_where_the_text_has_spaces(self):
        # 2026-11-05 e2e: '… ietarios y Reddit) coinciden …' began inside a word
        body = "Lorem ipsum dolor sit amet, " * 10 + "Hyundai" + " consectetur adipiscing elit sed do" * 20
        start = body.index("Hyundai")
        e = ev.excerpt_of(body, {"start": start, "end": start + 7})
        self.assertIn(e["before"].split(" ")[0], {"Lorem", "ipsum", "dolor", "sit", "amet,"})
        self.assertIn(e["after"].split(" ")[-1], {"consectetur", "adipiscing", "elit", "sed", "do"})
        self.assertEqual((e["cutStart"], e["cutEnd"]), (True, True))
        # no spaces: the cut stays where it falls
        cjk = "あ" * 100 + "ヒョンデ" + "い" * 300
        e = ev.excerpt_of(cjk, {"start": 100, "end": 104})
        self.assertEqual((len(e["before"]), len(e["after"])), (70, 200))

    def test_the_opening_without_an_occurrence_and_nothing_without_a_body(self):
        e = ev.excerpt_of("## Title\n\nSee [Kia](https://kia.com) | more", None)
        self.assertEqual(e, {"before": "Title See Kia more", "mark": None, "after": "", "cutStart": False, "cutEnd": False})
        self.assertIsNone(ev.excerpt_of(None, None))
        self.assertIsNone(ev.excerpt_of("", None))

    def test_an_occurrence_inside_an_entity_span_marks_the_name_without_the_span(self):
        # 2026-11-05 e2e: JP '4万ドル以下のEV…' showed entity["vehicle"," … ","2026 electric crossover"] around the mark
        body = 'はい。米国で\ue200entity\ue202["vehicle","Hyundai IONIQ 5","2026 electric crossover"]\ue201は買う価値'
        start = body.index("Hyundai IONIQ 5")
        e = ev.excerpt_of(body, {"start": start, "end": start + len("Hyundai IONIQ 5")})
        self.assertEqual((e["before"], e["mark"], e["after"]), ("はい。米国で", "Hyundai IONIQ 5", "は買う価値"))

    def test_chatgpt_entity_spans_read_as_their_name(self):
        body = 'a entity["vehicle","Hyundai IONIQ 5","electric SUV"] b citeturn0search1 c'
        self.assertEqual(ev.plain(body), "a Hyundai IONIQ 5 b c")


def item(i: int, **extra) -> dict:
    it = {"id": f"j{i}", "prompt": {"prompt_id": "p", "text": f"Q{i}"}, "engine": "chatgpt", "country": "JP", "lang": "ja",
          "measured_at": "2026-10-04T15:00:00+00:00", "mentions": {"total": 5, "own": {"count": 2, "present": True}},
          "marks": {"rank": 2, "sentiment": {"positive": 1, "negative": 0, "all": 3}, "citations": {"official": 0, "all": 4}},
          "answer_text": "Hyundai is fine", "own_occurrence": {"start": 0, "end": 7}, "own_terms": ["Hyundai"]}
    it.update(extra)
    return it


def page(items, total, next_cursor=None) -> dict:
    return {"data": {"items": items}, "meta": {**META, "page": {"limit": 50, "total": total, "next_cursor": next_cursor}}}


class EvidenceRouter(Router):
    """The two answers reads: the tab's page (marks) and the other tab's count (limit 0)."""

    def __init__(self, num_total=347, rest_total=222, fail=None):
        super().__init__({}, fail)
        self.totals = {"num": num_total, "rest": rest_total}

    async def get(self, path, params=None):
        from data_server.api import query
        q = dict(query(params))
        self.calls.append((path, list(query(params).multi_items())))
        if path in self.fail:
            raise HTTPException(self.fail[path], "boom")
        side = q["split"].split(":")[1]
        items = [item(1), item(2)] if q.get("marks") else []
        return page(items, self.totals[side], "50" if q.get("marks") and self.totals[side] > 50 else None)


def evidence(pairs, router):
    return screen("overview/market-evidence", "ctx.params=" + json.dumps(pairs), router)


class MarketEvidence(unittest.TestCase):
    def test_a_country_reads_the_tables_answers_on_its_split(self):
        router = EvidenceRouter()
        out = evidence([["brand", "Kia"], ["mkt", "position"], ["market", "jp"], ["kpi", "visibility"]], router)
        self.assertEqual(out["status"], 200)
        body = out["body"]
        self.assertEqual((body["total"], body["counts"], body["nextCursor"]), (347, {"num": 347, "rest": 222}, "50"))
        (_, tab), (_, other) = router.calls
        tab, other = dict(tab), dict(other)
        self.assertEqual((tab["country"], tab["brand"], tab["card"], tab["rep"]), ("JP", "Kia", "true", "true"))
        self.assertEqual((tab["split"], tab["order"], tab["limit"], tab["cursor"]), ("visibility:num", "prompt", "50", "0"))
        self.assertEqual((other["split"], other["limit"]), ("visibility:rest", "0"))
        self.assertNotIn("marks", other)
        row = body["items"][0]
        self.assertEqual((row["engine"], row["rank"], row["ownMentions"], row["brandMentions"]), ("ChatGPT", 2, 2, 5))
        # the measurement in KST (the answer view prints its first ten characters: 10-04 15:00Z is 10-05 in Seoul)
        self.assertEqual((row["measuredAt"], row["answer"]["measuredAt"]), ("2026-10-05T00:00:00+09:00",) * 2)
        self.assertEqual(row["excerpt"]["mark"], "Hyundai")
        # the answer view's reference, its 당사 terms lit
        self.assertEqual(row["answer"]["jobId"], "j1")
        self.assertEqual(row["answer"]["highlights"], {"brand": ["Hyundai"], "model": []})
        self.assertEqual(row["answer"]["highlightTerms"], [{"term": "hyundai", "kind": "brand"}])

    def test_a_region_names_its_countries_and_the_rest_tab_counts_both(self):
        router = EvidenceRouter(num_total=6080, rest_total=1852)
        out = evidence([["market", "KR"], ["market", "JP"], ["kpi", "citationShare"], ["side", "rest"]], router)
        self.assertEqual(out["body"]["counts"], {"num": 6080, "rest": 1852})
        self.assertEqual(out["body"]["total"], 1852)
        (_, tab), (_, other) = router.calls
        self.assertEqual([v for k, v in tab if k == "country"], ["JP", "KR"])
        self.assertEqual((dict(tab)["split"], dict(other)["split"]), ("citationShare:rest", "citationShare:num"))

    def test_a_later_page_reads_the_tab_only(self):
        router = EvidenceRouter()
        out = evidence([["market", "JP"], ["kpi", "sentiment"], ["cursor", "50"]], router)
        self.assertEqual(len(router.calls), 1)
        self.assertEqual(dict(router.calls[0][1])["cursor"], "50")
        self.assertNotIn("counts", out["body"])

    def test_a_bad_request_is_400_and_a_failed_read_is_raised(self):
        for pairs in ([["kpi", "visibility"]], [["market", "JP"], ["kpi", "nope"]], [["market", "J1"], ["kpi", "visibility"]],
                      [["market", "JP"], ["kpi", "visibility"], ["side", "all"]], [["market", "JP"], ["kpi", "visibility"], ["cursor", "-1"]]):
            with self.subTest(pairs=pairs):
                self.assertEqual(evidence(pairs, EvidenceRouter())["status"], 400)
        self.assertEqual(evidence([["market", "JP"], ["kpi", "visibility"]], EvidenceRouter(fail={"answers": 422}))["status"], 400)
        with self.assertRaises(HTTPException) as caught:
            evidence([["market", "JP"], ["kpi", "visibility"]], EvidenceRouter(fail={"answers": 504}))
        self.assertEqual(caught.exception.status_code, 504)


class GeoCounts(unittest.TestCase):
    """The sample line is the table row's own counts: the renewal geo rows carry each KPI's num / den (the position's
    sum / count); the original page's rows do not."""

    def read(self, qs: str):
        own = {"visibility": {"num": 347, "den": 569}, "share_of_voice": {"num": 2435, "den": 6577},
               "sentiment": {"num": 1205, "den": 2435}, "position": {"sum": 561, "count": 347},
               "citation_share": {"num": 2849, "den": 11642}}
        jp = {"code": "JP", "answers": 569, "own": own, "rank": {"our": 1, "field_size": 2}, "top_own_brand": None, "top_rival": None}
        region = {**jp, "code": "Asia", "region_id": "Asia", "region_label": "Asia", "country_count": 1, "countries": [jp]}
        router = Router({"kpi/summary": summary(), "geo": {"data": {"markets": [region], "pending": [], "own_label": "HMG"}, "meta": META}})
        return screen("overview/geo", qs, router)["geo"]["markets"][0]

    def test_the_renewal_rows_carry_the_counts(self):
        jp = self.read("ctx.view=renewal")["countries"][0]
        self.assertEqual(jp["counts"]["visibility"], {"num": 347, "den": 569})
        self.assertEqual(jp["counts"]["position"], {"sum": 561, "count": 347})
        self.assertEqual(jp["counts"]["citationShare"], {"num": 2849, "den": 11642})
        self.assertNotIn("counts", self.read("")["countries"][0])


if __name__ == "__main__":
    unittest.main()
