"""The service week on the screens (2026-11-02): shared/service-week (the shell's chip, the delay notice past 10 days
and the weeks a site shows nothing in), the screens that echo the URL period — their end is the service week's last
day at the latest, as the capped reads take it (mention/rn-page, acr/renewal-header, citation/renewal-header,
citation/as-of) — what the
screens derive from that period (the compare kind and days, the labels, the period before a Δ compares with) and the
week citation/tone-urls names for the tab counts its page keeps (review r3-5)."""
import asyncio
import json
import time
import unittest
from datetime import date, timedelta
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams

    from bff import api, screens
    from bff.gold_reader import compare
    from bff.gold_reader.context import Context
    from bff.screens import citation, mention_data
    from bff.tests.golden_util import GOLDEN, Tape, diff, load
    from bff.tests.service_week_util import HubData, hub, week_row
    from bff.tests.test_gold_service_week import LedgerConn
    from bff.tests.test_screens_mention_renewal import SCREEN_CASES
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_service_week)") from exc


def setUpModule():
    from bff.tests.stand_ins import no_judged_answers
    no_judged_answers()

D = date.fromisoformat
OCT5 = D("2026-10-05")
NOTES = [{"surface": "website", "week_start": "2026-07-20", "sites": 25, "shown": 24, "unpublished": 1, "hidden": 0, "other": 0,
          "days": ["2026-07-20", "2026-07-24"]},
         {"surface": "website", "week_start": "2026-09-14", "sites": 95, "shown": 94, "unpublished": 0, "hidden": 1, "other": 0,
          "days": ["2026-09-18"]}]


def build(name: str, query: str = ""):
    return asyncio.run(screens.build(name, QueryParams(query)))


class Gold:
    """bff.api.get for the screens under test: cycles/week-notes answers `notes` and, for the week starting `week`, the
    `rounds` its calendar holds (or fails with `status`), every other read fails transiently (the citation read
    degrades)."""

    def __init__(self, notes=None, status=None, rounds=None, week="2026-10-05"):
        self.notes, self.status, self.calls = notes if notes is not None else NOTES, status, []
        self.rounds, self.week = rounds or {"global": True, "website": True}, week

    async def get(self, path, params=None):
        self.calls.append((path, params))
        if path == "cycles/week-notes" and self.status is None:
            return {"data": {"items": self.notes, "week_start": self.week, "rounds": self.rounds}, "meta": {}}
        raise HTTPException(self.status or 503, "fixture")


class ServiceWeekScreen(unittest.TestCase):
    def screen(self, data, today=D("2026-11-02"), gold=None, query="", scope=None):
        from bff import access
        from bff.hub_stores import service_week
        gold = gold or Gold()
        with hub(data), mock.patch.object(service_week, "today", lambda: today), mock.patch("bff.api.get", gold.get), \
                access.scoped(scope or access.ALL):
            return build("shared/service-week", query), gold

    def test_the_week_its_delay_and_its_notes(self):
        out, gold = self.screen(HubData(week_row(OCT5, seq=4)))
        self.assertEqual(out, {
            "state": "ok",
            "week": {"start": "2026-10-05", "end": "2026-10-11", "month": 10, "nth": 2},
            "delay": {"days": 22, "threshold": 10, "next": {"start": "2026-10-12", "end": "2026-10-18", "month": 10, "nth": 3}},
            "checkedAt": "2026-11-02T01:10:00+00:00", "recordedAt": "2026-10-25T01:10:00+00:00", "justMoved": False,
            "rounds": {"global": True, "website": True},
            # each note's round days (the rounds shown that week and those of the sites left out): a page's period that
            # holds none of them holds none of the week's values (review r2-10)
            "notes": [{"surface": "website", "week": {"start": "2026-07-20", "end": "2026-07-26", "month": 7, "nth": 4}, "unpublished": 1, "hidden": 0,
                       "days": ["2026-07-20", "2026-07-24"]},
                      {"surface": "website", "week": {"start": "2026-09-14", "end": "2026-09-20", "month": 9, "nth": 3}, "unpublished": 0, "hidden": 1,
                       "days": ["2026-09-18"]}]})
        self.assertEqual([path for path, _ in gold.calls], ["cycles/week-notes"])

    def test_a_surface_with_no_round_in_the_week_says_so(self):
        """Review r1-19 (2026-11-03): under a week with no Website round (07-27..08-02 on live Gold: Global 07-27 only)
        the BFF reads no Website snapshot (Context.create), and the pages said '필터를 줄이거나 초기화해 보세요' or drew
        zeros. The screen says which surfaces the week holds a round of — Gold's round calendar, as cycles/week-notes
        reads it, nothing counted here — so a snapshot page can say '측정 없음' for that week."""
        out, _ = self.screen(HubData(week_row(D("2026-07-27"))), gold=Gold(rounds={"global": True, "website": False}, week="2026-07-27"))
        self.assertEqual((out["week"], out["rounds"]), ({"start": "2026-07-27", "end": "2026-08-02", "month": 7, "nth": 5},
                                                         {"global": True, "website": False}))
        self.assertEqual(self.screen(HubData(week_row(OCT5)), gold=Gold(rounds={"global": False, "website": True}))[0]["rounds"],
                         {"global": False, "website": True})

    def test_a_round_gold_withdrew_from_a_held_week(self):
        """Review r4-2 (2026-11-03): the screen took `rounds` from the HUB job's record of the week's complete cycles. A
        held week keeps that record (Gold re-opened the 10-09 website round of 10-05..10-11, so 09-28's week is the latest
        candidate: nothing is written), while Context.create follows Gold live and read no website snapshot — the pages
        drew their own empty states ('필터를 줄이거나…') under a week said to hold a round. `rounds` is the reads' own
        calendar now (cycles/week-notes), whatever the job recorded (its 96 website cycles of 10-09)."""
        out, _ = self.screen(HubData(week_row(OCT5, website_cycles=96)), gold=Gold(rounds={"global": True, "website": False}))
        self.assertEqual(out["rounds"], {"global": True, "website": False})

    def test_rounds_of_another_week_say_nothing(self):
        # the kept week moved between the screen's read of it and the notes' (their Context.create reads it again):
        # those rounds are the next week's, not this one's — not known, nothing is said (the shell reads the week again)
        out, _ = self.screen(HubData(week_row(OCT5)), gold=Gold(rounds={"global": True, "website": False}, week="2026-10-12"))
        self.assertEqual((out["week"]["start"], out["rounds"]), ("2026-10-05", None))

    def test_a_week_moved_to_moments_ago_says_so(self):
        """Review r1-16 (2026-11-03): the shell's read of the week and the page body's screens are separate requests, so
        a page read as the BFF moved to the next week could show the chip on one week and the body on the other. The
        week moved to moments ago says so (justMoved): the shell re-reads its page once."""
        from bff import access
        from bff.hub_stores import service_week
        data = HubData(week_row(OCT5))
        with hub(data), mock.patch.object(service_week, "CACHE_S", 0), mock.patch.object(service_week, "today", lambda: D("2026-11-02")), \
                mock.patch("bff.api.get", Gold().get), access.scoped(access.ALL):
            async def go():
                before = await screens.build("shared/service-week", QueryParams(""))
                data.row = week_row(OCT5 + timedelta(days=7), seq=2)
                await service_week.current()
                await service_week._refresh
                return before, await screens.build("shared/service-week", QueryParams(""))
            before, after = asyncio.run(go())
        self.assertEqual((before["week"]["start"], before["justMoved"]), ("2026-10-05", False))
        self.assertEqual((after["week"]["start"], after["justMoved"]), ("2026-10-12", True))

    def test_a_check_first_in_is_never_behind_the_pages_reads(self):
        """Review r5-2 (2026-11-03): on a soft navigation the shell reads the week again (GET /api/service-week) while
        the new page renders, so its read can reach the BFF before the page's screens. Served the kept week while the
        next one was read behind it, the check said 10-05..10-11 while the screens a moment later took 10-12..10-18: the
        chip, the delay note and the pickers on the week before over a body of the new one, and nothing re-read the page
        (the shell compares the weeks it read). The shell's read reads the week again before it answers, so no screen
        read after it is served a later week: the kept week due at the check, a read again a screen read just before
        had started, or the kept week falling due just after the check."""
        from bff import access
        from bff.hub_stores import service_week
        oct12 = OCT5 + timedelta(days=7)

        async def screens_after():
            # the page's screens: Context.create takes the week as current() serves it, at once; a read again the first
            # one starts lands before the next screen
            first = await service_week.current()
            if service_week._refresh is not None:
                await service_week._refresh
            return {first.start, (await service_week.current()).start}

        async def due_at_the_check(data):
            service_week._next_at = 0.0                 # the kept week older than HGH_SERVICE_WEEK_CACHE_S
            return await screens.build("shared/service-week", QueryParams(""))

        async def read_again_in_flight(data):
            service_week._next_at = 0.0
            data.gate = asyncio.Event()
            await service_week.current()                # a screen first in: the kept week, the read again behind it
            check = asyncio.ensure_future(screens.build("shared/service-week", QueryParams("")))
            await asyncio.sleep(0.01)                   # the check reaches the BFF while that read is out
            data.gate.set()
            return await check

        async def due_just_after_the_check(data):
            service_week._next_at = time.monotonic() + 0.05
            check = await screens.build("shared/service-week", QueryParams(""))
            await asyncio.sleep(0.06)                   # the screens, a moment later: the kept week is due now
            return check

        async def go(order, data):
            await service_week.current()                # the week the page's shell was rendered with: 10-05..10-11
            data.row = week_row(oct12, seq=2)           # the cron records the next week
            check = await order(data)
            return check["week"]["start"], await screens_after()

        for order in (due_at_the_check, read_again_in_flight, due_just_after_the_check):
            data = HubData(week_row(OCT5))
            with self.subTest(order=order.__name__), hub(data), \
                    mock.patch.object(service_week, "today", lambda: D("2026-11-02")), \
                    mock.patch("bff.api.get", Gold().get), access.scoped(access.ALL):
                check, after = asyncio.run(go(order, data))
                self.assertEqual(check, "2026-10-12")
                self.assertEqual(after, {oct12})

    def test_no_delay_up_to_ten_days(self):
        self.assertIsNone(self.screen(HubData(week_row(OCT5)), today=D("2026-10-21"))[0]["delay"])
        self.assertEqual(self.screen(HubData(week_row(OCT5)), today=D("2026-10-22"))[0]["delay"]["days"], 11)

    def test_a_site_with_nothing_shown_and_no_reason_is_unpublished(self):
        # sites with only cycles Gold superseded or set aside: Gold published nothing of them that week
        notes = [{"surface": "global", "week_start": "2026-08-17", "sites": 1, "shown": 0, "unpublished": 0, "hidden": 0, "other": 1,
                  "days": ["2026-08-17"]},
                 {"surface": "website", "week_start": "2026-08-24", "sites": 3, "shown": 3, "unpublished": 0, "hidden": 0, "other": 0,
                  "days": ["2026-08-28"]}]
        out, _ = self.screen(HubData(week_row(OCT5)), gold=Gold(notes))
        self.assertEqual(out["notes"], [{"surface": "global", "week": {"start": "2026-08-17", "end": "2026-08-23", "month": 8, "nth": 3},
                                         "unpublished": 1, "hidden": 0, "days": ["2026-08-17"]}])

    def test_the_notes_are_the_pages_sites(self):
        """Review r1-7 (2026-11-03): a Website page filtered to Genesis over July named Kia Italy's unpublished week. The
        notes are read with the page URL's picks the website pages take a site's cells by, as they read them: an
        administrator's brand, the geography, the language and the engine (each sorted; review r5-1: a German page was
        told of an Italian site and an English one its reads never take). Nothing else of the URL: the period is the
        front's, a source category picks no site."""
        _, gold = self.screen(HubData(week_row(OCT5)), query="brand=Genesis&geography=US~IT&time=2026-07-01..2026-07-31"
                                                             "&language=en~DE&engine=Gemini~chatgpt&source=officialHmg")
        self.assertEqual(gold.calls, [("cycles/week-notes", {"surface": "website", "brand": ["Genesis"], "country": ["IT", "US"],
                                                             "lang": ["de", "en"], "engine": ["chatgpt", "gemini"]})])

    def test_a_scoped_account_reads_its_own_brands_and_countries(self):
        # brand is an administrator's axis on the website pages; a country outside the account's scope is dropped, and
        # with none left the read takes the whole scope (the read's clamp adds it, as it does to the pages' reads);
        # language and engine are every account's axes
        scope = {"all": False, "brands": ["Kia"], "regions": [], "countries": ["DE", "AT"]}
        for query, params in (("brand=Genesis&geography=DE~FR", {"surface": "website", "country": ["DE"]}),
                              ("geography=FR", {"surface": "website"}),
                              ("geography=FR&language=de&engine=gemini", {"surface": "website", "lang": ["de"], "engine": ["gemini"]}),
                              ("", {"surface": "website"})):
            with self.subTest(query=query):
                _, gold = self.screen(HubData(week_row(OCT5)), query=query, scope=scope)
                self.assertEqual(gold.calls, [("cycles/week-notes", params)])

    def test_notes_that_cannot_be_read_leave_the_week(self):
        # nor is it known whether the week holds a round (Gold's to say): nothing is said of it (the reads fail on their own)
        out, _ = self.screen(HubData(week_row(OCT5)), gold=Gold(status=503))
        self.assertEqual((out["state"], out["week"]["start"], out["notes"], out["rounds"]), ("ok", "2026-10-05", [], None))

    def test_no_data_db(self):
        out, gold = self.screen(None)
        self.assertEqual(out, {"state": "unconfigured", "week": None, "delay": None, "checkedAt": None, "recordedAt": None,
                               "justMoved": False, "rounds": None, "notes": []})
        self.assertEqual(gold.calls, [])

    def test_a_week_that_cannot_be_read_is_503(self):
        with self.assertRaises(HTTPException) as cm:
            self.screen(HubData(row=None))
        self.assertEqual(cm.exception.status_code, 503)


class PeriodEchoes(unittest.TestCase):
    """2026-11-02: for time=2026-10-01..2026-10-31 the headers said '10-01 ~ 10-31' while every read stopped at the
    service week."""

    CASES = {"time=2026-10-01..2026-10-31": ("2026-10-01", "2026-10-11"),
             "time=..2026-10-31": (None, "2026-10-11"),
             "time=2026-10-01..": ("2026-10-01", None),
             "time=2026-09-01..2026-09-30": ("2026-09-01", "2026-09-30"),
             "time=2026-10-12..2026-10-18": None}   # after the week: no round of it can be shown

    def echo(self, name, query, data):
        self.gold = Gold(status=503)
        with hub(data), mock.patch("bff.api.get", self.gold.get):
            return build(name, query)

    def test_mention_header(self):
        for surface in ("", "ctx.surface=website&"):
            for query, period in self.CASES.items():
                with self.subTest(surface=surface, query=query):
                    out = self.echo("mention/rn-page", surface + query, HubData(week_row(OCT5)))
                    self.assertEqual(out["period"], period and {"from": period[0], "to": period[1]})
        self.assertIsNone(self.echo("mention/rn-page", "", HubData(week_row(OCT5)))["period"])

    def test_acr_header(self):
        for query, period in self.CASES.items():
            with self.subTest(query=query):
                out = self.echo("acr/renewal-header", query, HubData(week_row(OCT5)))
                self.assertEqual(out, {"period": True, "dateFrom": (period or (None, None))[0], "dateTo": (period or (None, None))[1]})
        self.assertEqual(self.echo("acr/renewal-header", "", HubData(week_row(OCT5))), {"period": False, "dateFrom": None, "dateTo": None})

    def test_citation_header(self):
        for surface in ("ctx.surface=global&", "ctx.surface=website&"):
            for query, period in self.CASES.items():
                with self.subTest(surface=surface, query=query):
                    out = self.echo("citation/as-of", surface + query, HubData(week_row(OCT5)))
                    self.assertEqual(out["period"], period and {"from": period[0], "to": period[1]})
        self.assertIsNone(self.echo("citation/as-of", "ctx.surface=global", HubData(week_row(OCT5)))["period"])

    def test_citation_renewal_header_reads_no_gold(self):
        """Review r2-13 (2026-11-03): the renewal Citation pills took their period from citation/as-of, which answers after
        the citation read (1.4–12.7 s cold on live Gold), while the Mention and ACR pills printed theirs in a few ms.
        citation/renewal-header answers the same period with no Gold read."""
        for surface in ("ctx.surface=global&", "ctx.surface=website&", "ctx.surface=website&ctx.role=admin&"):
            for query, period in self.CASES.items():
                with self.subTest(surface=surface, query=query):
                    out = self.echo("citation/renewal-header", surface + query, HubData(week_row(OCT5)))
                    self.assertEqual(out, {"period": period and {"from": period[0], "to": period[1]}})
                    self.assertEqual(self.gold.calls, [])
        self.assertEqual(self.echo("citation/renewal-header", "ctx.surface=global", HubData(week_row(OCT5))), {"period": None})

    def test_no_data_db_echoes_the_url(self):
        self.assertEqual(self.echo("mention/rn-page", "time=2026-10-01..2026-10-31", None)["period"], {"from": "2026-10-01", "to": "2026-10-31"})
        self.assertEqual(self.echo("acr/renewal-header", "time=2026-10-01..2026-10-31", None)["dateTo"], "2026-10-31")
        for name in ("citation/as-of", "citation/renewal-header"):
            self.assertEqual(self.echo(name, "ctx.surface=global&time=2026-10-01..2026-10-31", None)["period"],
                             {"from": "2026-10-01", "to": "2026-10-31"})

    def test_a_week_that_cannot_be_read_is_503(self):
        for name in ("mention/rn-page", "acr/renewal-header", "citation/as-of", "citation/renewal-header"):
            with self.subTest(name=name), self.assertRaises(HTTPException) as cm:
                self.echo(name, "time=2026-10-01..2026-10-31", HubData(row=None))
            self.assertEqual(cm.exception.status_code, 503)


class ToneCountsWeek(unittest.TestCase):
    """Review r3-5 (2026-11-03): the tone URL page keeps its tab counts per service week for its in-page moves (counts
    None, B045), and took that week from the shell's view, which moves on before the page is read again: the week
    before's counts were kept under the next week's name and drawn beside its rows. citation/tone-urls names the week
    it read under, read before Gold is (the kept week only moves on: never one after the rows')."""

    BODY = {"data": {"items": [], "counts": {"positive": 348, "negative": 665}}, "meta": {"page": {"limit": 50, "total": 0, "next_cursor": None}}}

    def tone(self, query, data):
        async def get(path, params=None):
            return self.BODY
        with hub(data), mock.patch("bff.api.get", get):
            return build("citation/tone-urls", query)

    def test_the_week_the_answer_was_read_under(self):
        for query in ("ctx.surface=global", "ctx.surface=website&ctx.role=admin", "ctx.surface=global&ctx.client_nav=1&q=ev&cursor=50"):
            with self.subTest(query=query):
                self.assertEqual(self.tone(query, HubData(week_row(OCT5)))["weekEnd"], "2026-10-11")
        self.assertEqual(self.tone("ctx.surface=global", HubData(week_row(OCT5 + timedelta(days=7))))["weekEnd"], "2026-10-18")

    def test_no_data_db_names_no_week(self):
        out = self.tone("ctx.surface=global", None)
        self.assertNotIn("weekEnd", out)
        self.assertEqual(out["counts"], {"positive": 348, "negative": 665})

    def test_a_week_that_cannot_be_read_is_503(self):
        with self.assertRaises(HTTPException) as cm:
            self.tone("ctx.surface=global", HubData(row=None))
        self.assertEqual(cm.exception.status_code, 503)


MONDAYS = [D("2026-10-19") - timedelta(days=7 * i) for i in range(12)]   # the global rounds 08-03..10-19, newest first
TREND = {"data": {"bucket": "cycle", "dimension": "source", "buckets": [], "series": [], "dims": [{"dimension": "category", "series": []}]},
         "meta": {}}
SOURCES = {"data": {"total_citations": 10, "categories": [{"category": {"slug": "officialHmg", "name": "Official (HMG)"}, "citations": 10,
                                                           "top_sources": []}], "by_engine": []}, "meta": {}}
#: the other reads' answers: empty, or as little as a loader needs to reach its read of the period before (the URL
#: funnel a measured prompt, the 공식(당사) tile an own share)
ANSWERS = {"mentions/brands": {"data": {"brands": [], "totals": {"answers": 0}}, "meta": {}},
           "kpi/engines": {"data": {"rows": []}, "meta": {}},
           "citations/sources": SOURCES, "trend": TREND,
           "citations/domains": {"data": {"summary": {"total_citations": 10, "unique_sources": 1, "own_share": {"num": 3, "den": 10}},
                                          "items": [], "competitor_sources": []}, "meta": {}},
           "kpi/summary": {"data": {"url_prompts": {"measured_prompts": 10, "target_prompts": 6, "owned_prompts": 8}}, "meta": {}},
           "geo": {"data": {"markets": []}, "meta": {}},
           "mentions/market-gaps": {"data": {"items": []}, "meta": {}},
           "filters/options": {"data": {"regions": [], "languages": [], "geo_matrix": []}, "meta": {}}}


class GoldUnderTheWeek:
    """bff.api.get on Gold's global rounds MONDAYS under the HUB's service week: kpi/compare is the reader's answer on a
    Context capped as Context.create caps it, the other reads answer ANSWERS. `windows` = the compare's windows."""

    def __init__(self):
        self.calls, self.windows = [], None

    def read(self, path: str) -> set:
        """The (from, to) periods `path` was read with."""
        return {(q.get("from"), q.get("to")) for p, q in self.calls if p == path}

    async def get(self, path, params=None):
        from bff.hub_stores import service_week
        q = api.query(params)
        self.calls.append((path, q))
        if path == "kpi/compare":
            week = await service_week.current()
            ctx = Context(LedgerConn(MONDAYS), q)
            ctx.release, ctx.builds, ctx.week = {"release_id": 1, "version": 1, "rule_signature": "test"}, {"fact": [1]}, week
            ctx.dates = [d for d in MONDAYS if d <= week.end]
            lo, hi = q.get("from"), q.get("to")
            ctx.selected_dates = [d for d in ctx.dates if (not lo or d >= D(lo)) and (not hi or d <= D(hi))]
            out = await compare.read(ctx)
            self.windows = out["meta"]["compare"]["windows"]
            return out
        if path in ANSWERS:
            return ANSWERS[path]
        raise AssertionError(path)


class PeriodBefore(unittest.TestCase):
    """A Δ next to a period total compares it with the period just before — the window kpi/compare compares 당사 with —
    for the rivals (mentions/brands), the engines (kpi/engines) and the Citation categories (citations/sources) too
    (2026-10-29 metric review R3), and on the Website pages for the 공식(당사) tile (citations/domains), the URL reach card
    (kpi/summary) and the market table (geo). A URL past the service week is read up to the week's last day, kpi/compare's
    window too (2026-11-02 review: for 09-28..10-25 under 10-05..10-11 당사 compared with 09-14..09-27, every other row
    with 08-31..09-27 and its 28 days, 공식(HMG) ▲2.5pp for ▲0.6pp). Review r4-8 (2026-11-03): the Website pages' reads,
    the month line's days and the ranking's share lines had no test of it — taken off at any of them, the suite stayed
    green."""

    # URL period: (the period before, the compare kind, its days) as the capped period 10-05..10-11 gives them
    CASES = {("2026-09-28", "2026-10-25"): (("2026-09-14", "2026-09-27"), "window", 14),
             ("2026-09-26", "2026-10-25"): (("2026-09-10", "2026-09-25"), "window", 16),
             ("2026-10-05", "2026-10-18"): (("2026-09-28", "2026-10-04"), "calendarWeek", 7),
             ("2026-10-01", "2026-10-31"): (("2026-09-01", "2026-09-30"), "calendarMonth", 11),
             ("2026-09-28", "2026-10-11"): (("2026-09-14", "2026-09-27"), "window", 14)}   # inside the week: as it was

    def page(self, lo, hi):
        """The loaders of the URL period lo..hi: the Mention body's compare, rivals, engines and ranking share lines, the
        Citation categories, and the Website pages' — citation/website renewal's 공식(당사) tile, URL reach card and month
        line (as citation.website wires them) and mention/rn-markets' markets."""
        gold = GoldUnderTheWeek()
        filters, ctx = {"dateFrom": lo, "dateTo": hi, "cumulative": True}, {"surface": "global", "scope": {"all": True}}
        web = {**ctx, "surface": "website"}

        async def reads():
            mention_data.begin_degrade_scope()
            out = {"period": await mention_data.load_period_compare(filters, ctx),
                   "brands": await mention_data.load_prev_period_brands(filters, ctx),
                   "lines": await mention_data.load_brand_share_lines(filters, ctx)}
            await mention_data.load_prev_period_engines(filters, ctx)
            out["deltas"] = await citation.load_deltas(citation.Reads(filters, ctx))
            r = citation.Reads(filters, web)
            deltas = asyncio.ensure_future(citation.load_deltas(r))
            out.update(own=await citation.load_own_share_line(r), reach=await citation.load_url_reach(r, deltas),
                       month=await citation.load_period_view(r, "2026-11-02"),
                       markets=await mention_data.load_market_reads(filters, web, ["Hyundai", "Kia"]))
            await deltas
            return out

        with hub(HubData(week_row(OCT5))), mock.patch("bff.api.get", gold.get):
            return gold, asyncio.run(reads())

    def test_every_row_compares_with_kpi_compares_period_before(self):
        for (lo, hi), (before, kind, days) in self.CASES.items():
            with self.subTest(period=f"{lo}..{hi}"):
                gold, out = self.page(lo, hi)
                prev = gold.windows["prev"]
                self.assertEqual((prev["lo"].isoformat(), prev["hi"].isoformat()), before)
                self.assertEqual((out["period"]["kind"], out["period"].get("days")), (kind, days))
                self.assertEqual(gold.read("mentions/brands"), {before})
                self.assertEqual(gold.read("kpi/engines"), {before})
                self.assertEqual(gold.read("citations/sources"), {(lo, hi), before})
                self.assertEqual(out["deltas"]["prevCategories"]["period"], {"from": before[0], "to": before[1]})
                # the Website pages: the 공식(당사) Δ, the URL reach Δ and the market table's window before
                self.assertEqual((out["own"]["window"], gold.read("citations/domains")), ({"from": before[0], "to": before[1]}, {before}))
                self.assertEqual({k: out["reach"]["delta"][k] for k in ("basis", "from", "date")},
                                 {"basis": "period", "from": before[0], "date": before[1]})
                self.assertEqual(gold.read("kpi/summary"), {(lo, hi), before})
                self.assertEqual(gold.read("geo"), {(lo, hi), before})
                # the month line (a calendar month only) counts the days the reads take: 10-01..10-11 of October, 11
                self.assertEqual((out["month"] or {}).get("days"), days if kind == "calendarMonth" else None)

    def test_a_period_after_the_week_has_no_period_before(self):
        # 10-12..10-18 holds no round under 10-05..10-11: kpi/compare compares nothing (no_data) and no row compares the
        # week's own values with that empty period
        gold, out = self.page("2026-10-12", "2026-10-18")
        self.assertIsNone(gold.windows)
        self.assertEqual({r["reason"] for r in out["period"]["compare"]}, {"no_data"})
        self.assertEqual((gold.read("mentions/brands"), gold.read("kpi/engines")), (set(), set()))
        # every read is of the URL period (the market table's site list, filters/options, is read with none)
        self.assertEqual({(q.get("from"), q.get("to")) for p, q in gold.calls if p != "filters/options"}, {("2026-10-12", "2026-10-18")})
        self.assertIsNone(out["deltas"]["prevCategories"])
        self.assertEqual((out["own"].get("window"), out["reach"]["delta"]["basis"], out["markets"]["prev"]), (None, None, None))
        # with no rows of a period before, the ranking reads every brand's share line, as outside period mode
        self.assertEqual((out["brands"], out["lines"] is not None), (None, True))


class CappedTape(Tape):
    """A golden tape read under a service week that ends on `end`: Gold answers a read whose `to` is after that day as the
    read up to it (Context.create stops the calendar at the week)."""

    def __init__(self, entries, end: str) -> None:
        super().__init__(entries)
        self.end = end

    async def get(self, path, params=None):
        return await super().get(path, [(k, min(v, self.end) if k == "to" else v) for k, v in api.query(params).multi_items()])


def query_params(query: dict) -> QueryParams:
    return QueryParams([(k, v) for k, vs in query.items() for v in (vs if isinstance(vs, list) else [vs])])


class PastTheWeek(unittest.IsolatedAsyncioTestCase):
    """A URL past the service week (a bookmark, a typed date, a week Gold moved back under the URL) shows what its capped
    URL shows. Each golden case here is a capped URL, its period ending on the week's last day; replayed with its end two
    weeks later, the compare kind and days, the labels and the reads of the period before must be the case's, or a read
    leaves the tape."""

    def past(self, time: str) -> tuple[str, str, str]:
        lo, hi = time.split("..")
        return lo, hi, f"{lo}..{(D(hi) + timedelta(days=14)).isoformat()}"

    async def test_screens(self):
        for family, name in (("overview", "fix-g-cards-06"), ("overview", "fix-rn-matrix-06"), ("overview", "fix-w-summary-06"),
                             ("overview", "fix-w-deferred-06"), ("mention", "live-kpi-period-week"), ("mention", "fix-kpi-period-04")):
            with self.subTest(case=f"{family}/{name}"):
                case = load(GOLDEN / family / f"{name}.json.gz")
                _lo, hi, time = self.past(case["query"]["time"])
                tape = CappedTape(case["tape"], hi)
                with hub(HubData(week_row(D(hi) - timedelta(days=6)))), mock.patch("bff.api.get", tape.get):
                    out = await screens.build(case["screen"], query_params({**case["query"], "time": time}))
                self.assertEqual(diff(case["output"], json.loads(json.dumps(out, ensure_ascii=False))), [])

    async def test_the_renewal_mention_page(self):
        # every section of the page, the rivals' and the engines' reads of the period before (09-07..09-13) included
        call = load(GOLDEN / "mention" / "rn-live-week.json.gz")["calls"][0]
        entries, sp = call["args"]
        _lo, hi, time = self.past(sp["time"])
        tape = CappedTape(entries, hi)
        with hub(HubData(week_row(D(hi) - timedelta(days=6)))), mock.patch("bff.api.get", tape.get):
            for name, ctx in SCREEN_CASES:
                key = f"{name}:{ctx['ctx.kpi']}" if ctx else name
                with self.subTest(screen=key):
                    out = await screens.build(f"mention/{name}", query_params({**sp, "time": time, **ctx}))
                    self.assertEqual(diff(call["output"][key], json.loads(json.dumps(out, ensure_ascii=False))), [])


if __name__ == "__main__":
    unittest.main()
