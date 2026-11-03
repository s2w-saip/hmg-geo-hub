"""The service week job (back/hub_storage/service_week.py, 2026-11-02): rule A on fake Gold rows (what completes a week,
what holds it back and what does not, the week-ended guard on the KST day, weeks with nothing to show, never moving
back, the project surface left out), the ISO month-week name and the delay days, the checks that refuse a mixed read,
the line the job prints, its Gold reads (rule A's SQL half, pinned clause by clause), its writes and the run around
them on a fake data connection (a row per change, checked_at otherwise, one transaction; the run lock, the dry run, the
KST day, the exits, a connection closed or dropped), the run ending by itself when Gold or the HUB data DB goes silent
(fake servers), and — with
HGH_SERVICE_WEEK_TEST_DB_URL, a HUB data DB with 011 applied, as a role that can SET ROLE hmg_service_week_writer — its
writes against the real table inside one transaction that is rolled back, (as a role that may grant on that table) that
verify-data.sql fails when the job's role is given more than it needs, and (as a role that may create a schema) its
reads on a small gold schema made in a rolled-back transaction, next to the notes' twin. The run on the real stores is
manage.py sync-service-week's."""
import asyncio
import contextlib
import importlib
import importlib.util
import io
import itertools
import json
import os
import re
import struct
import time
import unittest
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

try:
    import asyncpg
    spec = importlib.util.spec_from_file_location("service_week", Path(__file__).resolve().parents[2] / "hub_storage" / "service_week.py")
    sw = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sw)
    from bff.tests.service_week_util import clock
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_hub_service_week)") from exc

G, W, P = 1, 2, 3                 # surfaces: global (Monday rounds), website (Friday rounds), project (out of scope)
TODAY = date(2026, 11, 2)         # a Monday: live Gold's service week then is 2026-10-05..10-11 (10월 2주차)
KEYS = itertools.count(1)


def cycle(surface, day, status=2, servable=True, publication=True, released=True, view_date=None, hidden=0, fleet=None):
    """A Gold cycle row as the job reads it. The defaults are a complete one; fleet None = no cycle_pick_basis row."""
    return {"cycle_id": uuid.uuid4(), "cyc_key": next(KEYS), "surface": surface, "project_key": 1, "round_date": day,
            "status": status, "servable": servable, "view_date": view_date, "hidden_scope": hidden, "fleet_visible": fleet,
            "has_active_publication": publication, "in_every_active_release": released}


def published(surface, day, n=1):
    return [cycle(surface, day) for _ in range(n)]


def live_today():
    """The shape of live Gold on 2026-11-02 (surfaces 1 and 2): Global on Mondays, the 95-96 websites on Fridays, and
    nothing after 10-09."""
    return [*published(G, date(2026, 9, 28)), *published(W, date(2026, 10, 2), 95),
            *published(G, date(2026, 10, 5)), *published(W, date(2026, 10, 9), 96)]


def gold(cycles, versions=None, releases=None, **over):
    """A consistent Gold read around the given cycles."""
    if releases is None:
        releases = [{"scope": scope, "read_mode": mode, "release_id": i, "version": 1, "rule_signature": "2026-10-25.provisional.2",
                     "last_build_id": 10 + i, "as_of": date(2026, 10, 29)}
                    for i, (scope, mode) in enumerate(itertools.product(("global", "website"), ("card", "grid", "live")), 1)]
    return {"versions": {"cycle": 3183, "dim": 6028} if versions is None else versions, "releases": releases, "cycles": cycles,
            "orphan_publications": 0, "orphan_items": 0, **over}


def recorded(week_start, cycles, seq=1, versions=None):
    """The newest catalog.current_service_week row as the job reads it."""
    return {"seq": seq, "week_start": week_start, "global_cycles": [c["cycle_id"] for c in cycles if c["surface"] == G],
            "website_cycles": [c["cycle_id"] for c in cycles if c["surface"] == W], "gold_versions": json.dumps(versions or {})}


def in_week(cycles, start):
    return [c for c in cycles if sw.week_of(c["round_date"]) == start]


def ids(cycles, surface):
    return sorted(c["cycle_id"] for c in cycles if c["surface"] == surface)


class Weeks(unittest.TestCase):
    def test_a_week_is_the_iso_week_of_the_round_date(self):
        for day in (date(2026, 10, 5), date(2026, 10, 9), date(2026, 10, 11)):
            self.assertEqual(sw.week_of(day), date(2026, 10, 5), day)
        self.assertEqual(sw.week_of(date(2026, 10, 12)), date(2026, 10, 12))

    def test_the_name_is_the_month_of_its_thursday_and_its_week_in_that_month(self):
        for monday, expected in ((date(2026, 10, 5), (10, 2)),     # Thursday 10-08
                                 (date(2026, 9, 28), (10, 1)),     # Thursday 10-01: the week straddles September
                                 (date(2026, 8, 31), (9, 1)),      # Thursday 09-03
                                 (date(2026, 7, 27), (7, 5)),      # Thursday 07-30: still July
                                 (date(2026, 12, 28), (12, 5)),    # Thursday 12-31
                                 (date(2025, 12, 29), (1, 1))):    # Thursday 2026-01-01: the next year's first week
            self.assertEqual(sw.label(monday), expected, monday)
        self.assertEqual(sw.name(date(2026, 10, 5)), "10월 2주차")
        self.assertEqual(sw.name(date(2026, 9, 28)), "10월 1주차")

    def test_delay_days_count_from_the_sunday(self):
        self.assertEqual(sw.delay_days(date(2026, 10, 11), TODAY), 22)
        self.assertEqual(sw.delay_days(date(2026, 10, 11), date(2026, 10, 21)), 10)
        self.assertEqual(sw.delay_days(date(2026, 10, 11), date(2026, 10, 22)), 11)

    def test_the_day_is_the_kst_day(self):
        self.assertEqual(sw.today_kst(datetime(2026, 10, 11, 23, 0, tzinfo=UTC)), date(2026, 10, 12))   # Monday 08:00 KST
        self.assertEqual(sw.today_kst(datetime(2026, 10, 11, 14, 59, tzinfo=UTC)), date(2026, 10, 11))  # Sunday 23:59 KST
        rows = [*published(G, date(2026, 10, 5)), *published(W, date(2026, 10, 9), 3)]
        self.assertEqual(sw.decide(rows, sw.today_kst(datetime(2026, 10, 11, 23, 0, tzinfo=UTC)))["week_start"], date(2026, 10, 5))
        self.assertIsNone(sw.decide(rows, date(2026, 10, 11)))   # the UTC date then: the week has not ended


class Rule(unittest.TestCase):
    def test_todays_gold_gives_the_week_of_10_05_with_1_global_and_96_website_cycles(self):
        rows = live_today()
        d = sw.decide(rows, TODAY)
        self.assertEqual((d["week_start"], len(d["global"]), len(d["website"]), d["held"]), (date(2026, 10, 5), 1, 96, False))
        self.assertEqual(sorted(d["website"]), sorted(c["cycle_id"] for c in rows if c["round_date"] == date(2026, 10, 9)))

    def test_any_cycle_still_owed_holds_its_week_back(self):
        later = date(2026, 10, 9)
        for blocker in (cycle(W, later, status=0, servable=False, publication=False, released=False),     # still collecting
                        cycle(W, later, status=1, servable=False, publication=False, released=False, fleet=True),
                        cycle(W, later, status=1, servable=False, publication=False, released=False),     # no pick row: fleet-visible
                        cycle(G, date(2026, 10, 5), status=1, servable=False, publication=False, released=False, fleet=False),
                        cycle(W, later, publication=False),                                               # no active publication
                        cycle(W, later, view_date=date(2026, 11, 3)),                                     # visible from tomorrow
                        cycle(W, later, released=False)):                                                 # not in every release
            d = sw.decide([*live_today(), blocker], TODAY)
            self.assertEqual(d["week_start"], date(2026, 9, 28), blocker)
            self.assertEqual((len(d["global"]), len(d["website"])), (1, 95))
            self.assertTrue(sw.blocking(blocker, TODAY))

    def test_a_cycle_visible_from_today_counts(self):
        """Review r2-3: view_date is the first KST day Gold shows a cycle on, so the day itself counts."""
        from_today = cycle(W, date(2026, 10, 9), view_date=TODAY)
        self.assertTrue(sw.complete(from_today, TODAY))
        self.assertFalse(sw.blocking(from_today, TODAY))
        d = sw.decide([*live_today(), from_today], TODAY)
        self.assertEqual((d["week_start"], len(d["website"])), (date(2026, 10, 5), 97))
        self.assertIn(from_today["cycle_id"], d["website"])

    def test_duplicates_hidden_and_stale_cycles_do_not_hold_it_back(self):
        later = date(2026, 10, 9)
        quiet = [cycle(W, later, servable=False, publication=False, released=False, fleet=False),   # superseded duplicate
                 cycle(W, later, status=1, servable=False, publication=False, released=False, fleet=False),  # not the representative
                 cycle(W, later, status=0, servable=False, publication=False, released=False, hidden=1),     # hidden from everything
                 cycle(W, later, status=3, servable=False, publication=False, released=False)]                # stale
        d = sw.decide([*live_today(), *quiet], TODAY)
        self.assertEqual((d["week_start"], len(d["website"])), (date(2026, 10, 5), 96))
        self.assertFalse(any(sw.blocking(c, TODAY) for c in quiet))
        self.assertFalse(set(d["website"]) & {c["cycle_id"] for c in quiet})

    def test_a_hidden_cycle_is_not_shown_and_a_partly_hidden_one_is(self):
        hidden, citations_hidden = cycle(W, date(2026, 10, 9), hidden=1), cycle(W, date(2026, 10, 9), hidden=2)
        d = sw.decide([*live_today(), hidden, citations_hidden], TODAY)
        self.assertNotIn(hidden["cycle_id"], d["website"])
        self.assertIn(citations_hidden["cycle_id"], d["website"])
        self.assertEqual(len(d["website"]), 97)

    def test_a_surface_gold_has_not_loaded_that_far_holds_the_week(self):
        """Review r2-1 (decision '미적재 표면', 2026-11-03): a surface with no cycle in the week and none after it may only
        not be loaded yet ('A 10/5, B 10/12 → 10/5'), so the week waits for it."""
        d = sw.decide([*live_today(), *published(G, date(2026, 10, 12))], TODAY)   # Gold lists websites only up to 10-09
        self.assertEqual((d["week_start"], len(d["global"]), len(d["website"])), (date(2026, 10, 5), 1, 96))
        d = sw.decide([*live_today(), *published(W, date(2026, 10, 16), 2)], TODAY)   # and Global only up to 10-05
        self.assertEqual((d["week_start"], len(d["global"]), len(d["website"])), (date(2026, 10, 5), 1, 96))

    def test_a_week_a_surface_skipped_shows_it_as_not_measured(self):
        """A surface with a later cycle of any state skipped the week: it does not hold the week, which shows its
        '측정 없음' (live Gold: no website round in 06-08..06-22, before the sites started, nor in 07-27..08-02)."""
        later = cycle(W, date(2026, 10, 23), status=0, servable=False, publication=False, released=False)   # still collecting
        d = sw.decide([*live_today(), *published(G, date(2026, 10, 12)), later], TODAY)
        self.assertEqual((d["week_start"], len(d["global"]), d["website"]), (date(2026, 10, 12), 1, []))
        hidden_later = cycle(G, date(2026, 10, 19), hidden=1)   # a hidden row still shows how far Gold has listed it
        d = sw.decide([*live_today(), *published(W, date(2026, 10, 16), 2), hidden_later], TODAY)
        self.assertEqual((d["week_start"], d["global"], len(d["website"])), (date(2026, 10, 12), [], 2))

    def test_a_surface_gold_lists_nothing_for_never_holds_a_week(self):
        rows = [*published(G, date(2026, 10, 5)), *published(G, date(2026, 10, 12))]
        d = sw.decide(rows, TODAY)
        self.assertEqual((d["week_start"], len(d["global"]), d["website"]), (date(2026, 10, 12), 1, []))

    def test_a_week_with_nothing_to_show_is_not_a_candidate(self):
        empty_later = [cycle(W, date(2026, 10, 16), hidden=1),
                       cycle(W, date(2026, 10, 23), servable=False, publication=False, released=False, fleet=False)]
        d = sw.decide([*live_today(), *empty_later], TODAY)   # and 10-26..11-01 has no cycle at all
        self.assertEqual(d["week_start"], date(2026, 10, 5))

    def test_a_week_still_running_is_not_accepted(self):
        rows = [*live_today(), *published(G, date(2026, 10, 12)),          # a Monday Global round, published mid-week,
                *published(W, date(2026, 10, 16), 2)]                       # and that Friday's sites
        for today, week in ((date(2026, 10, 14), date(2026, 10, 5)),     # Wednesday
                            (date(2026, 10, 18), date(2026, 10, 5)),     # Sunday, its last day
                            (date(2026, 10, 19), date(2026, 10, 12))):   # the Monday after
            self.assertEqual(sw.decide(rows, today)["week_start"], week, today)

    def test_the_newest_complete_week_wins(self):
        rows = [*published(G, date(2026, 9, 7)), *published(W, date(2026, 9, 11), 95), *live_today()]
        rows.append(cycle(W, date(2026, 9, 25), status=1, servable=False, publication=False, released=False, fleet=True))
        self.assertEqual(sw.decide(rows, TODAY)["week_start"], date(2026, 10, 5))   # an older week's gap does not matter

    def test_the_project_surface_is_ignored(self):
        rows = [*live_today(), cycle(P, date(2026, 10, 6), status=0, servable=False, publication=False, released=False),
                *published(P, date(2026, 10, 13))]
        d = sw.decide(rows, TODAY)
        self.assertEqual((d["week_start"], len(d["global"]), len(d["website"])), (date(2026, 10, 5), 1, 96))

    def test_no_week_without_a_candidate_or_a_record(self):
        self.assertIsNone(sw.decide([], TODAY))
        owed = [cycle(W, date(2026, 10, 9), status=1, servable=False, publication=False, released=False)]
        self.assertIsNone(sw.decide(owed, TODAY))
        with self.assertRaises(sw.Refused) as cm:   # the run then ends non-zero and records nothing
            sw.plan(gold(owed), TODAY, None)
        self.assertIn("no complete week", str(cm.exception))


class NeverBack(unittest.TestCase):
    def test_an_older_latest_week_keeps_the_recorded_one(self):
        rows = live_today()
        before = recorded(date(2026, 10, 5), [c for c in rows if sw.week_of(c["round_date"]) == date(2026, 10, 5)])
        retracted = [*rows, cycle(W, date(2026, 10, 9), publication=False)]   # Gold now owes a 10-05 week cycle again
        d = sw.decide(retracted, TODAY, before)
        self.assertEqual((d["week_start"], d["held"], d["latest"]), (date(2026, 10, 5), True, date(2026, 9, 28)))
        self.assertEqual((d["global"], d["website"]), (sorted(before["global_cycles"]), sorted(before["website_cycles"])))
        self.assertFalse(sw.changed(d, before))
        d = sw.decide([], TODAY, before)   # nothing complete at all
        self.assertEqual((d["week_start"], d["held"], d["latest"]), (date(2026, 10, 5), True, None))

    def test_a_later_week_advances_and_a_changed_cycle_set_is_a_change(self):
        rows = live_today()
        older = recorded(date(2026, 9, 28), [c for c in rows if sw.week_of(c["round_date"]) == date(2026, 9, 28)])
        d = sw.decide(rows, TODAY, older)
        self.assertEqual((d["week_start"], d["held"]), (date(2026, 10, 5), False))
        self.assertTrue(sw.changed(d, older))
        week = [c for c in rows if sw.week_of(c["round_date"]) == date(2026, 10, 5)]
        same = recorded(date(2026, 10, 5), list(reversed(week)))
        self.assertFalse(sw.changed(sw.decide(rows, TODAY, same), same))          # the same set in another order
        fewer = recorded(date(2026, 10, 5), week[:-1])                             # a late site published since
        d = sw.decide(rows, TODAY, fewer)
        self.assertEqual((d["week_start"], d["held"], len(d["website"])), (date(2026, 10, 5), False, 96))
        self.assertTrue(sw.changed(d, fewer))
        self.assertTrue(sw.changed(d, None))


class Checks(unittest.TestCase):
    def refused(self, g, previous=None):
        with self.assertRaises(sw.Refused) as cm:
            sw.check_read(g, previous)
        return str(cm.exception)

    def test_a_consistent_read_passes(self):
        sw.check_read(gold(live_today()), {"cycle": 3183, "dim": 6000, "gone": 1})

    def test_signs_of_a_reload_in_progress_refuse(self):
        self.assertIn("went back", self.refused(gold(live_today()), {"cycle": 3184}))
        self.assertIn("publication", self.refused(gold(live_today(), orphan_publications=2)))
        self.assertIn("release item", self.refused(gold(live_today(), orphan_items=1)))
        rows = live_today()
        rows.append(dict(rows[-1]))
        self.assertIn("unique", self.refused(gold(rows)))
        rows = live_today()
        rows[0]["round_date"] = None
        self.assertIn("round date", self.refused(gold(rows)))

    def test_releases_the_screens_could_not_pick_refuse(self):
        g = gold(live_today())
        g["releases"].append({**g["releases"][0], "rule_signature": "another"})
        self.assertIn("HGH_GOLD_RULE_SIGNATURE", self.refused(g))

    def test_a_shown_cycle_without_an_id_refuses(self):
        rows = live_today()
        rows[-1]["cycle_id"] = None
        with self.assertRaises(sw.Refused):
            sw.decide(rows, TODAY)
        rows[-1]["hidden_scope"] = 1   # not recorded, so not needed
        self.assertEqual(sw.decide(rows, TODAY)["week_start"], date(2026, 10, 5))


def flat(sql):
    return " ".join(sql.split())


class GoldReads(unittest.TestCase):
    """Review r2-3 (2026-11-03): rule A's SQL half. No server answers these reads in the default run, so they are pinned
    clause by clause (whitespace aside) like their twin, the notes' NOTES_SQL (bff.tests.test_gold_service_week
    .WeekNotes.test_the_rule_is_the_jobs): change the two together. GoldSchema runs them on PostgreSQL."""

    def test_the_sql_half_of_rule_a(self):
        for sql, clauses in (
                (sw.RELEASES_SQL, (
                    # the active releases the screens pick from: Global and Website, live · card · grid, one rule signature
                    "SELECT scope,read_mode,release_id,version,rule_signature,last_build_id,as_of FROM gold.active_release "
                    "WHERE scope IN ('global','website') AND read_mode IN ('live','card','grid') "
                    "AND ($1::text IS NULL OR rule_signature=$1) ORDER BY scope,read_mode",)),
                (sw.CYCLES_SQL, (
                    # the same releases for the cycles' check
                    "WITH rel AS (SELECT scope,release_id FROM gold.active_release WHERE scope IN ('global','website') "
                    "AND read_mode IN ('live','card','grid') AND ($1::text IS NULL OR rule_signature=$1))",
                    "SELECT d.cycle_id,d.cyc_key,d.surface,d.project_key,d.round_date,d.status,d.servable,d.view_date,"
                    "d.hidden_scope,b.fleet_visible,",
                    # complete(): an active publication
                    "EXISTS(SELECT 1 FROM gold.publication p WHERE p.cyc_key=d.cyc_key AND p.state='active') AS has_active_publication",
                    # complete(): a ready fact item of a validated build in every active release of its scope (and one at least)
                    "(EXISTS(SELECT 1 FROM rel r WHERE r.scope=s.scope) AND NOT EXISTS(SELECT 1 FROM rel r WHERE r.scope=s.scope "
                    "AND NOT EXISTS( SELECT 1 FROM gold.release_item i JOIN gold.build bu ON bu.build_id=i.build_id "
                    "AND bu.status='validated' WHERE i.release_id=r.release_id AND i.family='fact' AND i.state='ready' "
                    "AND i.slice_key='cyc:'||d.cyc_key::text)) ) AS in_every_active_release",
                    # fleet_visible(): the pick row, NULL without one; every cycle of surfaces 1 and 2, the project surface left out
                    "FROM gold.dim_cycle d LEFT JOIN gold.cycle_pick_basis b ON b.cyc_key=d.cyc_key "
                    "CROSS JOIN LATERAL (SELECT CASE d.surface WHEN 1 THEN 'global' ELSE 'website' END AS scope) s "
                    "WHERE d.surface IN (1,2) ORDER BY d.cyc_key")),
                (sw.VERSIONS_SQL, ("SELECT scope,version FROM gold.data_version",)),
                (sw.ORPHANS_SQL, (
                    # a reload in progress: an active publication or a ready fact item of the read's releases with no cycle row
                    "(SELECT count(*) FROM gold.publication p WHERE p.state='active' "
                    "AND NOT EXISTS(SELECT 1 FROM gold.dim_cycle d WHERE d.cyc_key=p.cyc_key)) AS publications",
                    "(SELECT count(*) FROM gold.release_item i WHERE i.release_id=ANY($1::bigint[]) AND i.family='fact' "
                    "AND i.state='ready' AND i.slice_key LIKE 'cyc:%' "
                    "AND NOT EXISTS(SELECT 1 FROM gold.dim_cycle d WHERE 'cyc:'||d.cyc_key::text=i.slice_key)) AS items"))):
            for clause in clauses:
                self.assertIn(clause, flat(sql))

    def test_the_notes_twin_asks_the_same(self):
        """The pieces of the rule the job reads in SQL are the notes' too (aliases and 'EXISTS (' aside), so a change to
        one twin and its pin alone fails here."""
        if importlib.util.find_spec("bff.gold_reader.week_notes") is None:
            self.skipTest("bff.gold_reader.week_notes is not there")

        def same(sql):
            return re.sub(r"EXISTS\s*\(\s*", "EXISTS(", flat(sql))

        notes, job = same(importlib.import_module("bff.gold_reader.week_notes").NOTES_SQL), same(sw.CYCLES_SQL)
        for piece in (
                # the releases: Global and Website, live · card · grid, the one rule signature
                "scope IN ('global','website') AND", "read_mode IN ('live','card','grid') AND", "::text IS NULL OR",
                "rule_signature=$",
                # an active publication
                "EXISTS(SELECT 1 FROM gold.publication p WHERE p.cyc_key=", "AND p.state='active')",
                # in one active release of the scope at least, and in every one: a ready fact item of a validated build
                "EXISTS(SELECT 1 FROM rel r WHERE r.scope=", "AND NOT EXISTS(SELECT 1 FROM rel r WHERE r.scope=",
                "AND NOT EXISTS(SELECT 1 FROM gold.release_item ", "JOIN gold.build bu ON bu.build_id=",
                "AND bu.status='validated'", ".release_id=r.release_id AND ", "family='fact' AND ", "state='ready' AND ",
                "slice_key='cyc:'||",
                # the pick basis, surfaces 1 and 2 and their scopes
                "FROM gold.dim_cycle d LEFT JOIN gold.cycle_pick_basis b ON b.cyc_key=d.cyc_key", "WHERE d.surface IN (1,2)",
                "CASE d.surface WHEN 1 THEN 'global' ELSE 'website' END AS scope"):
            self.assertIn(piece, job)
            self.assertIn(piece, notes)

    def test_one_read_asks_with_the_rule_signature_and_counts_orphans_of_its_own_releases(self):
        rows = live_today()
        releases = gold([])["releases"]
        calls = []

        class Conn:
            async def fetch(self, sql, *args):
                calls.append((sql, args))
                return {sw.VERSIONS_SQL: [{"scope": "cycle", "version": 3183}], sw.RELEASES_SQL: releases, sw.CYCLES_SQL: rows}[sql]

            async def fetchrow(self, sql, *args):
                calls.append((sql, args))
                return {"publications": 0, "items": 2}

        g = asyncio.run(sw.read_gold(Conn(), "2026-10-25.provisional.2"))
        self.assertEqual(calls, [(sw.VERSIONS_SQL, ()), (sw.RELEASES_SQL, ("2026-10-25.provisional.2",)),
                                 (sw.CYCLES_SQL, ("2026-10-25.provisional.2",)), (sw.ORPHANS_SQL, ([1, 2, 3, 4, 5, 6],))])
        self.assertEqual((g["versions"], g["releases"], g["cycles"], g["orphan_publications"], g["orphan_items"]),
                         ({"cycle": 3183}, releases, rows, 0, 2))


class Line(unittest.TestCase):
    def test_the_printed_line(self):
        d = sw.decide(live_today(), TODAY)
        self.assertEqual(sw.summary(d, True, 7, TODAY), {
            "week_start": "2026-10-05", "week_end": "2026-10-11", "label": "10월 2주차", "changed": True, "held": False,
            "latest": "2026-10-05", "global_cycles": 1, "website_cycles": 96, "delay_days": 22, "seq": 7, "today": "2026-11-02"})

    def test_the_release_record_is_scope_by_read_mode(self):
        out = sw.gold_release(gold([]))
        self.assertEqual(sorted(out), ["global", "website"])
        self.assertEqual(sorted(out["website"]), ["card", "grid", "live"])
        self.assertEqual(set(out["global"]["live"]), {"release_id", "version", "rule_signature", "last_build_id", "as_of"})
        self.assertEqual(json.loads(sw.encoded(out))["global"]["live"]["as_of"], "2026-10-29")


class DataConn:
    """The job's data connection on catalog.service_week kept in memory, answering as asyncpg does (jsonb as JSON text,
    uuid[] as a list): `rows` in seq order, each with the times its checked_at was moved (`checks`); `lock` is what
    pg_try_advisory_lock answers; `log` names each statement in the order it ran, with a transaction's BEGIN and its
    COMMIT or ROLLBACK (which puts the rows back), and how the run let the connection go: close, or terminate (dropped,
    review r4-6: the server rolls back a transaction left open)."""

    def __init__(self, *rows, lock=True):
        self.rows = [{"gold_release": "{}", "checks": 0, **row} for row in rows]
        self.lock, self.log, self.kept = lock, [], None

    def transaction(self):
        conn = self

        class Transaction:   # asyncpg's start, commit and rollback
            async def start(self):
                conn.kept = [dict(row) for row in conn.rows]
                conn.log.append("BEGIN")

            async def commit(self):
                conn.kept = None
                conn.log.append("COMMIT")

            async def rollback(self):
                conn.rows, conn.kept = conn.kept, None
                conn.log.append("ROLLBACK")

        return Transaction()

    async def fetchrow(self, sql, *args):
        assert (sql, args) == (sw.CURRENT_SQL, ()), sql
        self.log.append("current")
        newest = self.rows[-1] if self.rows else None
        return newest and {k: newest[k] for k in ("seq", "week_start", "global_cycles", "website_cycles", "gold_versions")}

    async def fetchval(self, sql, *args):
        if (sql, args) == ("SELECT pg_try_advisory_lock($1)", (sw.RUN_LOCK,)):
            self.log.append("lock")
            return self.lock
        assert sql == sw.INSERT_SQL, sql
        self.log.append("insert")
        week_start, global_cycles, website_cycles, release, versions = args
        seq = max((row["seq"] for row in self.rows), default=0) + 1
        self.rows.append({"seq": seq, "week_start": week_start, "global_cycles": list(global_cycles),
                          "website_cycles": list(website_cycles), "gold_release": release, "gold_versions": versions, "checks": 0})
        return seq

    async def execute(self, sql, *args):
        assert sql == sw.CONFIRM_SQL, sql
        self.log.append("confirm")
        for row in self.rows:
            row["checks"] += row["seq"] == args[0]

    async def close(self, timeout=None):
        self.log.append("close")

    def terminate(self):
        if self.kept is not None:
            self.rows, self.kept = self.kept, None
        self.log.append("terminate")


class Writes(unittest.TestCase):
    """Review r3-1 (2026-11-03): record() on a fake data connection, so the default run holds the write half too (Store
    runs the same writes on the real table, where checked_at cannot be seen to move inside its one transaction): a new
    row only when the week or a surface's cycles change, the newest row's checked_at otherwise, each run in one
    transaction; the recorded versions read back from jsonb text; a read older than them writes nothing."""

    def test_a_row_on_change_checked_at_otherwise(self):
        data, versions = DataConn(), {"cycle": 3183, "dim": 6028}

        def run(cycles):
            data.log.clear()
            return asyncio.run(sw.record(data, gold(cycles, versions), TODAY))

        rows = live_today()
        first = run(rows)
        week = in_week(rows, date(2026, 10, 5))
        self.assertEqual((first["week_start"], first["changed"], first["seq"], data.log),
                         ("2026-10-05", True, 1, ["BEGIN", "current", "insert", "COMMIT"]))
        row = data.rows[-1]
        self.assertEqual((row["week_start"], row["global_cycles"], row["website_cycles"]), (date(2026, 10, 5), ids(week, G), ids(week, W)))
        self.assertEqual((json.loads(row["gold_versions"]), sorted(json.loads(row["gold_release"]))), (versions, ["global", "website"]))
        again = run(rows)                                            # the same week and cycles: checked_at only
        self.assertEqual((again["changed"], again["seq"], data.log), (False, 1, ["BEGIN", "current", "confirm", "COMMIT"]))
        late = [*rows, *published(W, date(2026, 10, 9))]             # a late site in the same week: a new row
        third = run(late)
        self.assertEqual((third["changed"], third["seq"], third["website_cycles"], data.log[2]), (True, 2, 97, "insert"))
        skipped = cycle(W, date(2026, 10, 23), status=0, servable=False, publication=False, released=False)
        later = [*late, *published(G, date(2026, 10, 12)), skipped]  # the next week, Global only (the sites skipped it): it advances
        fourth = run(later)
        self.assertEqual((fourth["week_start"], fourth["seq"], data.rows[-1]["global_cycles"], data.rows[-1]["website_cycles"]),
                         ("2026-10-12", 3, ids(in_week(later, date(2026, 10, 12)), G), []))
        owed = [*later, cycle(W, date(2026, 10, 16), status=1, servable=False, publication=False, released=False)]
        held = run(owed)                                             # Gold owes that week a site again: it stays
        self.assertEqual((held["week_start"], held["held"], held["changed"], held["seq"], data.log[2]),
                         ("2026-10-12", True, False, 3, "confirm"))
        self.assertEqual([(row["seq"], row["checks"]) for row in data.rows], [(1, 1), (2, 0), (3, 1)])

    def test_a_read_older_than_the_record_writes_nothing(self):
        rows = live_today()
        data = DataConn(recorded(date(2026, 10, 5), in_week(rows, date(2026, 10, 5)), seq=4, versions={"cycle": 3184, "dim": 6028}))
        kept = [dict(row) for row in data.rows]
        with self.assertRaisesRegex(sw.Refused, "^Gold data_version cycle went back from 3184 to 3183$"):
            asyncio.run(sw.record(data, gold(rows), TODAY))
        self.assertEqual((data.log, data.rows), (["BEGIN", "current", "ROLLBACK"], kept))


class Run(unittest.TestCase):
    """Review r3-1: the run around record() (manage.py sync-service-week) on a fake data connection, with Gold's read
    faked and the clock at Monday 10-12 08:00 in Korea, still Sunday 10-11 in UTC: the writer's connection, the run lock,
    the dry run, the day, and the exits vm.sh logs as 'service-week FAILED'."""

    DSN = "postgresql://writer@test/hub"
    GOLD = {"HGH_GOLD_DB_URL": "postgresql://gold@test/gold", "HGH_GOLD_RULE_SIGNATURE": "2026-10-25.provisional.2"}

    def setUp(self):
        self.connect, self.snapshot = mock.AsyncMock(), mock.AsyncMock(return_value=gold(live_today()))

    def go(self, config, data=None):
        """main(config): the line it prints."""
        self.connect.return_value, out = data, io.StringIO()
        with mock.patch.dict(os.environ, self.GOLD), mock.patch.object(sw.asyncpg, "connect", self.connect), \
                mock.patch.object(sw, "gold_snapshot", self.snapshot), clock(sw, datetime(2026, 10, 11, 23, 0, tzinfo=UTC)), \
                contextlib.redirect_stdout(out):
            asyncio.run(sw.main(config))
        return json.loads(out.getvalue())

    def test_a_run_holds_the_lock_records_the_week_of_the_kst_day_and_closes(self):
        data = DataConn()
        out = self.go({"data": self.DSN}, data)
        # on the UTC day, 10-11, the week of 10-05 would not have ended: it would record the week of 09-28
        self.assertEqual((out["week_start"], out["today"], out["delay_days"], out["changed"], out["seq"], "dry_run" in out),
                         ("2026-10-05", "2026-10-12", 1, True, 1, False))
        self.assertEqual(data.log, ["lock", "BEGIN", "current", "insert", "COMMIT", "close"])
        self.assertEqual([c.args for c in self.connect.await_args_list], [(self.DSN,)])
        self.snapshot.assert_awaited_once_with("postgresql://gold@test/gold", "2026-10-25.provisional.2")

    def test_a_dry_run_decides_against_the_record_and_writes_nothing(self):
        rows = live_today()
        data = DataConn(recorded(date(2026, 9, 28), in_week(rows, date(2026, 9, 28)), seq=7, versions={"cycle": 3183}))
        kept = [dict(row) for row in data.rows]
        out = self.go({"data": self.DSN, "dry_run": True}, data)
        self.assertEqual((out["dry_run"], out["week_start"], out["changed"], out["seq"]), (True, "2026-10-05", True, 7))
        self.assertEqual((data.log, data.rows), (["current", "close"], kept))   # no lock, no transaction, no write
        out = self.go({"dry_run": True})                             # no writer yet: as if nothing were recorded
        self.assertEqual((out["dry_run"], out["week_start"], out["seq"], self.connect.await_count), (True, "2026-10-05", None, 1))

    def test_a_second_run_waits_its_turn(self):
        data = DataConn(lock=False)
        with self.assertRaisesRegex(RuntimeError, "^Another service week check is running$"):
            self.go({"data": self.DSN}, data)
        self.assertEqual((data.log, self.snapshot.await_count), (["lock", "terminate"], 0))   # Gold not even read

    def test_a_run_that_records_nothing_ends_with_its_reason(self):
        with self.assertRaisesRegex(RuntimeError, "^No HUB data DB connection to record the service week in$"):
            self.go({})
        self.assertEqual((self.connect.await_count, self.snapshot.await_count), (0, 0))
        data = DataConn(recorded(date(2026, 10, 5), in_week(live_today(), date(2026, 10, 5)), versions={"cycle": 3184}))
        with self.assertRaisesRegex(RuntimeError, "^Service week not recorded: Gold data_version cycle went back from 3184 to 3183$"):
            self.go({"data": self.DSN}, data)
        self.assertEqual(data.log, ["lock", "BEGIN", "current", "ROLLBACK", "terminate"])   # a refusal still rolls back


def pg_message(kind, payload=b""):
    return kind + struct.pack("!i", len(payload) + 4) + payload


class HushedGold:
    """A server that greets like PostgreSQL (trust, ready for queries) and then answers nothing, not even a cancel
    request: Gold frozen, or a half-open connection to it. serve() answers what comes before the silence (nothing)."""

    async def __aenter__(self):
        self.writers = []
        self.server = await asyncio.start_server(self.greet, "127.0.0.1", 0)
        self.dsn = f"postgresql://gold@127.0.0.1:{self.server.sockets[0].getsockname()[1]}/gold?sslmode=disable"
        return self

    async def __aexit__(self, *exc):
        await asyncio.sleep(0.1)      # a cancel request still coming in is accepted first, not left open by close()
        for writer in self.writers:   # the server goes away: whatever still waits on it ends
            writer.close()
        self.server.close()
        await self.server.wait_closed()

    async def greet(self, reader, writer):
        self.writers.append(writer)
        try:
            while True:
                length, code = struct.unpack("!ii", await reader.readexactly(8))
                await reader.readexactly(length - 8)
                if code not in (80877103, 80877104):   # SSL and GSS encryption requests: not offered
                    break
                writer.write(b"N")
            if code != 80877102:                       # a cancel request gets no answer
                writer.write(pg_message(b"R", struct.pack("!i", 0)))
                for name, value in (("server_version", "16.4"), ("server_encoding", "UTF8"), ("client_encoding", "UTF8"),
                                    ("integer_datetimes", "on"), ("standard_conforming_strings", "on"), ("DateStyle", "ISO, MDY"),
                                    ("TimeZone", "UTC")):
                    writer.write(pg_message(b"S", f"{name}\0{value}\0".encode()))
                writer.write(pg_message(b"K", struct.pack("!ii", 4242, 2424)) + pg_message(b"Z", b"I"))
                await self.serve(reader, writer)
            while await reader.read(65536):            # then silence
                pass
        except (asyncio.IncompleteReadError, ConnectionError):
            pass

    async def serve(self, reader, writer):
        pass


def prepared(params, columns):
    """The answer to a statement's Parse, Describe and Flush: its parameter type oids, its columns (name, type oid)."""
    row = struct.pack("!h", len(columns)) + b"".join(name.encode() + b"\0" + struct.pack("!ihihih", 0, 0, oid, -1, -1, 0)
                                                     for name, oid in columns)
    return pg_message(b"1") + pg_message(b"t", struct.pack(f"!h{len(params)}i", len(params), *params)) + pg_message(b"T", row)


def executed(rows, tag):
    """The answer to its Bind, Execute and Sync: the rows (binary values), the command tag, then ready (idle)."""
    data = b"".join(pg_message(b"D", struct.pack("!h", len(row)) + b"".join(struct.pack("!i", len(v)) + v for v in row))
                    for row in rows)
    return pg_message(b"2") + data + pg_message(b"C", tag + b"\0") + pg_message(b"Z", b"I")


class ScriptedHub(HushedGold):
    """A HUB data DB that gives its answers in order, one each time it is asked for one (a Flush, a Sync or a simple
    Query), and then nothing: frozen in the middle of a run."""

    def __init__(self, *answers):
        self.answers = answers

    async def serve(self, reader, writer):
        for answer in self.answers:
            while True:
                kind = await reader.readexactly(1)
                await reader.readexactly(struct.unpack("!i", await reader.readexactly(4))[0] - 4)
                if kind in (b"H", b"S", b"Q"):
                    break
            writer.write(answer)


LOCKED = (prepared([20], [("pg_try_advisory_lock", 16)]), executed([[b"\x01"]], b"SELECT 1"))   # the run lock, taken
BEGUN = pg_message(b"C", b"BEGIN\0") + pg_message(b"Z", b"T")                                    # the run's transaction
# the newest recorded row: none (its uuid[] columns described as text[], so asyncpg has no type to look up)
NO_ROW = (prepared([], [("seq", 20), ("week_start", 1082), ("global_cycles", 1009), ("website_cycles", 1009),
                        ("gold_versions", 3802)]), executed([], b"SELECT 0"))


class SilentGold(unittest.TestCase):
    """Review r2-2 (2026-11-03): a Gold that stops answering after the connection never sends its own statement_timeout
    (60 s), so the job's read gives up by itself (client-side limits) and drops the connection at once: a rollback, the
    query's cancel request and a graceful close would each wait for Gold with no end. The run then ends non-zero, so
    vm.sh logs FAILED and frees its lock, and scripts/start-local.sh goes on to start the API."""

    def test_the_run_ends_by_itself_when_gold_goes_silent(self):
        asyncio.run(self.scenario())

    async def scenario(self):
        async with HushedGold() as gold:
            with mock.patch.dict(os.environ, {"HGH_GOLD_DB_URL": gold.dsn}), \
                    mock.patch.object(sw, "GOLD_TIMEOUTS", {"timeout": 5, "command_timeout": 0.2}, create=True):
                run = asyncio.ensure_future(sw.main({"dry_run": True}))
                started = time.monotonic()
                try:
                    await asyncio.wait({run}, timeout=5)
                    self.assertTrue(run.done(), f"the job still waits on a silent Gold after {time.monotonic() - started:.0f} s")
                    with self.assertRaisesRegex(RuntimeError, "^Service week not recorded: Gold did not answer"):
                        run.result()
                finally:
                    if not run.done():   # let it go: the server closes, the job's waits end
                        for writer in gold.writers:
                            writer.close()
                        await asyncio.wait({run}, timeout=5)
                    run.cancel()
                    await asyncio.gather(run, return_exceptions=True)
        self.assertLessEqual(sw.GOLD_TIMEOUTS["timeout"], 60)            # the job's own limits: a connect,
        self.assertGreater(sw.GOLD_TIMEOUTS["command_timeout"], 60)      # a statement above a live Gold's 60 s timeout
        self.assertLess(sw.GOLD_TIMEOUTS["command_timeout"], 600)        # and well inside the hourly run


class SilentData(unittest.TestCase):
    """Review r4-6 (2026-11-03): the same for the HUB data DB, with Gold's read faked. After a statement timed out,
    asyncpg's next statement on that connection (the transaction's ROLLBACK) and a graceful close wait for the answer to
    its cancel request, with no end on a frozen server; so after a failure the job sends nothing more (it drops the
    connection, and the server rolls back what was open) and ends non-zero, and a run that went through does not wait
    past DATA_CLOSE for the server to see its connection off."""

    def test_the_run_ends_by_itself_when_the_hub_data_db_goes_silent(self):
        for silent_at, server, config in (("the run lock", HushedGold, {}), ("the dry run's read", HushedGold, {"dry_run": True}),
                                          ("the newest row, after BEGIN", lambda: ScriptedHub(*LOCKED, BEGUN), {})):
            with self.subTest(silent_at=silent_at):
                failure, printed = asyncio.run(self.run_on(server(), config))
                self.assertIsInstance(failure, RuntimeError)
                self.assertEqual((str(failure), printed), ("Service week check stopped: the HUB data DB did not answer "
                                                           "(limits: connect 5 s, a statement 0.2 s)", ""))

    def test_a_run_that_went_through_does_not_wait_for_its_goodbye(self):
        failure, printed = asyncio.run(self.run_on(ScriptedHub(*NO_ROW), {"dry_run": True}))
        self.assertIsNone(failure)
        out = json.loads(printed)
        self.assertEqual((out["dry_run"], out["week_start"], out["seq"]), (True, "2026-10-05", None))

    def test_its_limits_end_each_wait_well_inside_the_hourly_run(self):
        self.assertEqual(set(sw.DATA_TIMEOUTS), {"timeout", "command_timeout"})   # a connect, a statement
        self.assertTrue(all(0 < limit <= 60 for limit in (*sw.DATA_TIMEOUTS.values(), sw.DATA_CLOSE)))

    async def run_on(self, server, config):
        """main(config) with `server` as the HUB data DB: (the error it ended with or None, what it printed)."""
        out = io.StringIO()
        async with server:
            with mock.patch.dict(os.environ, {"HGH_GOLD_DB_URL": "postgresql://gold@test/gold"}), \
                    mock.patch.object(sw, "DATA_TIMEOUTS", {"timeout": 5, "command_timeout": 0.2}, create=True), \
                    mock.patch.object(sw, "DATA_CLOSE", 0.2, create=True), \
                    mock.patch.object(sw, "gold_snapshot", mock.AsyncMock(return_value=gold(live_today()))), \
                    clock(sw, datetime(2026, 10, 11, 23, 0, tzinfo=UTC)), contextlib.redirect_stdout(out):
                run = asyncio.ensure_future(sw.main({**config, "data": server.dsn}))
                started = time.monotonic()
                try:
                    await asyncio.wait({run}, timeout=5)
                    self.assertTrue(run.done(), f"the job still waits on a silent HUB data DB after {time.monotonic() - started:.0f} s")
                    return run.exception(), out.getvalue()
                finally:
                    if not run.done():   # let it go: the server closes, the job's waits end
                        for writer in server.writers:
                            writer.close()
                        await asyncio.wait({run}, timeout=5)
                    run.cancel()
                    await asyncio.gather(run, return_exceptions=True)


class MatchesTheBff(unittest.TestCase):
    """The BFF's provider (bff.hub_stores.service_week) names weeks and counts the delay the same way."""

    def setUp(self):
        if importlib.util.find_spec("bff.hub_stores.service_week") is None:
            self.skipTest("bff.hub_stores.service_week is not there yet")
        self.bff = importlib.import_module("bff.hub_stores.service_week")

    def test_names_and_delays_match(self):
        monday = date(2025, 12, 29)
        for _ in range(160):
            self.assertEqual(tuple(self.bff.label(monday)), sw.label(monday), monday)
            monday += timedelta(days=7)
        for days in (0, 10, 11, 22):
            end = date(2026, 10, 11)
            self.assertEqual(self.bff.delay_days(end, end + timedelta(days=days)), sw.delay_days(end, end + timedelta(days=days)))


DB_URL = os.environ.get("HGH_SERVICE_WEEK_TEST_DB_URL")


@unittest.skipUnless(DB_URL, "HGH_SERVICE_WEEK_TEST_DB_URL (a HUB data DB with 011, as a role that can SET ROLE hmg_service_week_writer) not set")
class Store(unittest.TestCase):
    """The job's writes as hmg_service_week_writer, in one transaction that is rolled back. Weeks in 2030 and a version
    scope Gold never has, so rows already in the table do not change the outcome."""

    def test_rows_on_change_checked_at_otherwise(self):
        asyncio.run(self.scenario())

    async def scenario(self):
        conn = await asyncpg.connect(DB_URL)
        tx = conn.transaction()
        await tx.start()
        try:
            await conn.execute("SET LOCAL ROLE hmg_service_week_writer")
            await self.writes(conn)
        finally:
            await tx.rollback()
            await conn.close()

    async def newest(self, conn):
        return await conn.fetchrow("SELECT * FROM catalog.current_service_week")

    async def writes(self, conn):
        one, two = date(2030, 9, 30), date(2030, 10, 7)   # Mondays
        versions = {"rollback-only": 5}
        rows = [*published(G, one), *published(W, one + timedelta(days=4), 3)]
        today = date(2030, 10, 14)
        first = await sw.record(conn, gold(rows, versions), today)
        self.assertEqual((first["changed"], first["week_start"], first["global_cycles"], first["website_cycles"]), (True, "2030-09-30", 1, 3))
        row = await self.newest(conn)
        self.assertEqual((row["seq"], row["week_end"], sorted(row["website_cycles"])),
                         (first["seq"], date(2030, 10, 6), sorted(c["cycle_id"] for c in rows if c["surface"] == W)))
        self.assertEqual(json.loads(row["gold_versions"]), versions)
        self.assertEqual(sorted(json.loads(row["gold_release"])), ["global", "website"])
        again = await sw.record(conn, gold(rows, versions), today)       # the same week and cycles: checked_at only
        self.assertEqual((again["changed"], again["seq"]), (False, first["seq"]))
        self.assertEqual(await conn.fetchval("SELECT count(*) FROM catalog.service_week WHERE seq>=$1", first["seq"]), 1)
        late = [*rows, *published(W, one + timedelta(days=4))]          # a late site in the same week: a new row
        third = await sw.record(conn, gold(late, versions), today)
        self.assertEqual((third["changed"], third["website_cycles"]), (True, 4))
        self.assertGreater(third["seq"], first["seq"])
        unloaded = [*late, *published(G, two)]                           # the next week, Global only, no site listed after it
        waits = await sw.record(conn, gold(unloaded, versions), today)   # (maybe not loaded yet): it waits, checked_at only
        self.assertEqual((waits["week_start"], waits["changed"], waits["seq"]), ("2030-09-30", False, third["seq"]))
        skipped = cycle(W, two + timedelta(days=11), status=0, servable=False, publication=False, released=False)
        later = [*unloaded, skipped]                                     # a later site (the sites skipped that week): it advances
        fourth = await sw.record(conn, gold(later, versions), today)
        self.assertEqual((fourth["week_start"], fourth["changed"], fourth["website_cycles"]), ("2030-10-07", True, 0))
        owed = [*later, cycle(W, two + timedelta(days=4), status=1, servable=False, publication=False, released=False)]
        held = await sw.record(conn, gold(owed, versions), today)        # Gold owes that week a site again: it stays
        self.assertEqual((held["week_start"], held["held"], held["changed"], held["seq"]), ("2030-10-07", True, False, fourth["seq"]))
        self.assertEqual((await self.newest(conn))["seq"], fourth["seq"])
        with self.assertRaises(sw.Refused):                              # a read older than the recorded one writes nothing
            await sw.record(conn, gold(later, {"rollback-only": 4}), today)
        self.assertEqual((await self.newest(conn))["seq"], fourth["seq"])
        for statement in ("UPDATE catalog.service_week SET week_start=week_start+7", "UPDATE catalog.service_week SET website_cycles='{}'",
                          "DELETE FROM catalog.service_week", "SELECT 1 FROM catalog.prompt LIMIT 1"):
            with self.assertRaises(asyncpg.InsufficientPrivilegeError, msg=statement):
                async with conn.transaction():
                    await conn.execute(statement)


@unittest.skipUnless(DB_URL, "HGH_SERVICE_WEEK_TEST_DB_URL (a HUB data DB with 011, as a role that can grant on its table) not set")
class VerifyCatches(unittest.TestCase):
    """manage.py verify fails when the job's role holds more than new rows and checked_at: each grant a later migration
    could add by mistake, given in one transaction that is rolled back, then verify-data.sql's block for the role."""

    def test_a_grant_beyond_new_rows_and_checked_at_fails_verify(self):
        asyncio.run(self.scenario())

    async def scenario(self):
        lines = (Path(__file__).resolve().parents[2] / "hub_storage" / "verify-data.sql").read_text(encoding="utf-8").splitlines()
        start = next(i for i, line in enumerate(lines) if line.startswith("-- The service week job's role (011)"))
        block = "\n".join(lines[start:lines.index("RESET ROLE;", start) + 1])
        conn = await asyncpg.connect(DB_URL)
        try:
            if not await conn.fetchval("""SELECT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) OR pg_has_role(relowner,'USAGE')
                    FROM pg_class WHERE oid='catalog.service_week'::regclass"""):
                self.skipTest("the test role cannot grant on catalog.service_week")
            for grant in (None, "UPDATE(week_start)", "UPDATE(global_cycles)", "UPDATE(website_cycles)", "UPDATE(gold_release)",
                          "UPDATE(gold_versions)", "UPDATE(recorded_at)", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
                with self.subTest(grant=grant):
                    tx = conn.transaction()
                    await tx.start()
                    try:
                        if grant is None:
                            await conn.execute(block)                      # 011's own grants pass
                        else:
                            await conn.execute(f"GRANT {grant} ON catalog.service_week TO hmg_service_week_writer")
                            with self.assertRaisesRegex(asyncpg.RaiseError, "^Writer "):
                                await conn.execute(block)
                    finally:
                        await tx.rollback()
        finally:
            await conn.close()


GOLD_SCHEMA = """CREATE SCHEMA gold;
CREATE TABLE gold.data_version(scope text PRIMARY KEY, version bigint);
CREATE TABLE gold.active_release(scope text, read_mode text, rule_signature text, release_id bigint, version bigint,
    last_build_id bigint, as_of date);
CREATE TABLE gold.dim_cycle(cyc_key int PRIMARY KEY, cycle_id uuid, surface smallint, project_key int, round_date date,
    status smallint, servable boolean, view_date date, hidden_scope smallint);
CREATE TABLE gold.cycle_pick_basis(cyc_key int PRIMARY KEY, fleet_visible boolean);
CREATE TABLE gold.publication(cyc_key int, state text);
CREATE TABLE gold.build(build_id bigint PRIMARY KEY, status text);
CREATE TABLE gold.release_item(release_id bigint, family text, slice_key text, build_id bigint, state text);
CREATE TABLE gold.dim_project(project_key int PRIMARY KEY, site_brand_bit int, site_geo_key int);
CREATE TABLE gold.dim_country(geo_key int PRIMARY KEY, code text);
CREATE TABLE gold.dim_lang(lang_key int PRIMARY KEY, code text);
CREATE TABLE gold.dim_engine(engine_key int PRIMARY KEY, code text);
CREATE TABLE gold.job_index(cyc_key int, project_key int, surface smallint, round_date date, geo_key int, lang_key int,
    engine_key int);
INSERT INTO gold.data_version VALUES ('cycle', 3183), ('dim', 6028);"""
SIGNATURE = "2026-10-25.provisional.2"
RELEASE_IDS = {("global", "live"): 1, ("global", "card"): 2, ("global", "grid"): 3,
               ("website", "live"): 4, ("website", "card"): 5, ("website", "grid"): 6}


@unittest.skipUnless(DB_URL, "HGH_SERVICE_WEEK_TEST_DB_URL (a HUB data DB, as a role that may create a schema) not set")
class GoldSchema(unittest.TestCase):
    """Review r2-3: the job's reads on PostgreSQL, over a small gold schema made in one transaction that is rolled back
    (the HUB data DB has none; Gold itself is never written): each way a cycle completes, holds its week back or does
    not, releases the screens could not pick left out, the orphans of a reload, the week they give, the notes' twin
    (NOTES_SQL) counting the same sites on the same rows, and the notes of a page's sites (review r5-1)."""

    def test_the_reads_judge_each_cycle_by_rule_a(self):
        asyncio.run(self.scenario(self.reads))

    def test_the_notes_are_the_pages_sites(self):
        asyncio.run(self.scenario(self.sites))

    async def scenario(self, body):
        conn = await asyncpg.connect(DB_URL)
        tx = conn.transaction()
        await tx.start()
        try:
            if not await conn.fetchval("SELECT has_database_privilege(current_database(),'CREATE') AND to_regnamespace('gold') IS NULL"):
                self.skipTest("the test role cannot make a gold schema in this database, or it has one")
            await conn.execute(GOLD_SCHEMA)
            await body(conn)
        finally:
            await tx.rollback()
            await conn.close()

    async def put(self, conn, key, surface, day, project=1, status=2, servable=True, view_date=None, hidden=0, fleet=None,
                  publication="active", modes=("live", "card", "grid"), item="ready", build="validated", family="fact"):
        """A cycle and what Gold keeps about it; the defaults are a complete one (fleet None = no pick row)."""
        await conn.execute("INSERT INTO gold.dim_cycle VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                           key, uuid.uuid4(), surface, project, day, status, servable, view_date, hidden)
        if fleet is not None:
            await conn.execute("INSERT INTO gold.cycle_pick_basis VALUES ($1,$2)", key, fleet)
        if publication:
            await conn.execute("INSERT INTO gold.publication VALUES ($1,$2)", key, publication)
        if modes:
            await conn.execute("INSERT INTO gold.build VALUES ($1,$2)", 1000 + key, build)
            await conn.executemany("INSERT INTO gold.release_item VALUES ($1,$2,$3,$4,$5)",
                                   [(RELEASE_IDS[sw.SURFACES[surface], mode], family, f"cyc:{key}", 1000 + key, item) for mode in modes])

    async def reads(self, conn):
        await conn.executemany("INSERT INTO gold.active_release VALUES ($1,$2,$3,$4,1,10,'2026-10-29')",
                               [(scope, mode, SIGNATURE, i) for (scope, mode), i in RELEASE_IDS.items()]
                               + [("website", "live", "another rule", 7), ("website", "draft", SIGNATURE, 8)])   # never picked
        none, shown, quiet, owed = {"publication": None, "modes": ()}, "shown", "quiet", "owed"
        closed, friday = {"status": 1, "servable": False, **none}, date(2026, 10, 30)
        cycles = {   # cyc_key: surface, round date, what Gold has of it, the job's verdict
            1: (G, date(2026, 9, 28), {}, shown), 2: (W, date(2026, 10, 2), {}, shown),
            3: (G, date(2026, 10, 5), {}, shown), 4: (W, date(2026, 10, 9), {}, shown),
            5: (W, date(2026, 10, 9), {"project": 2, "view_date": TODAY}, shown),                   # visible from today
            6: (W, date(2026, 10, 9), {"servable": False, "fleet": False, **none}, quiet),           # a superseded duplicate
            7: (W, date(2026, 10, 9), {"project": 3, "fleet": False, **closed}, quiet),               # not the site's representative
            8: (W, date(2026, 10, 9), {"project": 4, **closed, "status": 0, "hidden": 1}, quiet),     # hidden everywhere
            9: (W, date(2026, 10, 9), {"project": 5, **closed, "status": 3}, quiet),                  # stale
            10: (P, date(2026, 10, 6), {**closed, "status": 0}, None),                                # never read
            11: (G, date(2026, 10, 12), {}, shown), 12: (W, date(2026, 10, 16), {"modes": ("live", "grid")}, owed),   # not in card
            13: (G, date(2026, 10, 19), {}, shown), 14: (W, date(2026, 10, 23), {"publication": "retired"}, owed),
            15: (G, date(2026, 10, 26), {}, shown),
            16: (W, friday, {"item": "building"}, owed), 17: (W, friday, {"project": 2, "build": "failed"}, owed),
            18: (W, friday, {"project": 3, "family": "dim"}, owed),
            19: (W, friday, {"project": 4, "view_date": TODAY + timedelta(days=1)}, owed),           # from tomorrow
            20: (W, friday, {"project": 5, **closed, "status": 0}, owed),                             # still collecting
            21: (W, friday, {"project": 6, **closed}, owed),                                          # closed, no pick row
            22: (G, TODAY, {}, shown)}                                                               # its week runs on
        for key, (surface, day, facts, _) in cycles.items():
            await self.put(conn, key, surface, day, **facts)
        g = await sw.read_gold(conn, SIGNATURE)
        self.assertEqual(sorted((r["scope"], r["read_mode"]) for r in g["releases"]), sorted(RELEASE_IDS))
        self.assertEqual((g["versions"], g["orphan_publications"], g["orphan_items"]), ({"cycle": 3183, "dim": 6028}, 0, 0))

        def verdict(c):
            return shown if sw.complete(c, TODAY) and not sw.hidden(c) else owed if sw.blocking(c, TODAY) else quiet

        self.assertEqual({c["cyc_key"]: verdict(c) for c in g["cycles"]}, {key: v for key, (*_, v) in cycles.items() if v})
        ids = {c["cyc_key"]: c["cycle_id"] for c in g["cycles"]}
        decision, is_changed = sw.plan(g, TODAY, None)
        self.assertEqual((decision["week_start"], decision["global"], decision["website"], is_changed),
                         (date(2026, 10, 5), [ids[3]], sorted([ids[4], ids[5]]), True))
        if importlib.util.find_spec("bff.gold_reader.week_notes") is not None:
            # the twin on the same rows: per week with a site not shown, sites, shown, unpublished, hidden, other and the
            # round days the note is about (review r2-10)
            notes_sql = importlib.import_module("bff.gold_reader.week_notes").NOTES_SQL
            self.assertEqual([tuple(r.values()) for r in await conn.fetch(notes_sql, TODAY, SIGNATURE, None, None, None, None, None)],
                             [(W, date(2026, 10, 5), 5, 2, 0, 1, 2, [date(2026, 10, 9)]),
                              (W, date(2026, 10, 12), 1, 0, 1, 0, 0, [date(2026, 10, 16)]),
                              (W, date(2026, 10, 19), 1, 0, 1, 0, 0, [date(2026, 10, 23)]),
                              (W, date(2026, 10, 26), 6, 0, 6, 0, 0, [friday])])
            # review r4-2: the notes' rounds (shared/service-week `rounds`, '측정 없음') hold a week's round exactly where
            # the reads' calendar (Context.create's dates under that week) takes one, per release they pick from
            context = importlib.import_module("bff.gold_reader.context")
            rounds_sql = importlib.import_module("bff.gold_reader.week_notes").ROUNDS_SQL
            for start in (date(2026, 9, 28), date(2026, 10, 5), date(2026, 10, 12), date(2026, 10, 19), date(2026, 10, 26)):
                end = start + timedelta(days=6)
                calendar = {(scope, mode): any(start <= r["round_date"] <= end for r in await conn.fetch(
                                context.CALENDAR_SQL, {"global": G, "website": W}[scope], None, TODAY, release, end))
                            for (scope, mode), release in RELEASE_IDS.items()}
                rounds = {(r["scope"], r["read_mode"]): r["holds"] for r in await conn.fetch(rounds_sql, TODAY, SIGNATURE, start, end)}
                self.assertEqual(rounds, calendar, start)
                if start == date(2026, 10, 12):   # 12, of 10-16, is in no card release: the card calendar has no round
                    self.assertEqual([rounds["website", m] for m in ("card", "grid", "live")], [False, True, True])
        await conn.execute("INSERT INTO gold.publication VALUES (99,'active'),(98,'retired')")   # cycles a reload has not brought
        await conn.execute("INSERT INTO gold.release_item VALUES (4,'fact','cyc:97',1001,'ready'),"
                           "(8,'fact','cyc:96',1001,'ready'),(5,'fact','cyc:95',1001,'building')")
        g = await sw.read_gold(conn, SIGNATURE)
        self.assertEqual((g["orphan_publications"], g["orphan_items"]), (1, 1))
        with self.assertRaises(sw.Refused):
            sw.check_read(g, None)
        await conn.execute("DELETE FROM gold.active_release WHERE scope='website'")   # a scope with no release completes nothing
        g = await sw.read_gold(conn, SIGNATURE)
        self.assertEqual({c["cyc_key"] for c in g["cycles"] if sw.complete(c, TODAY)}, {1, 3, 11, 13, 15, 22})

    async def sites(self, conn):
        """Review r5-1 (2026-11-03): cycles/week-notes read with a page's picks (week_notes.read on a Context built
        directly, under the week 10-05..10-11). The reads take a website site's cells by the country each job is measured
        in, its language and the engine, so a site is the page's when one of its jobs up to the week's last day is on
        every axis picked; one with no job yet by its own country. The notes named the sites of their own country and
        of every language and engine: a German page was told of an Italian and an English site, and a page or an account
        on a city market or on AE of none of the sites measured there."""
        from starlette.datastructures import QueryParams

        from bff.gold_reader import week_notes
        from bff.gold_reader.context import Context
        await conn.executemany("INSERT INTO gold.active_release VALUES ($1,$2,$3,$4,1,10,'2026-10-29')",
                               [(scope, mode, SIGNATURE, i) for (scope, mode), i in RELEASE_IDS.items()])
        geos = {"IT": 1, "US": 2, "SA-Dammam": 3, "SA-Jeddah": 4, "SA-Riyadh": 5, "DE": 6, "FR": 7, "MIDDLEEAST": 8, "AE": 9}
        langs, engines = {"it": 1, "en": 2, "ar": 3, "de": 4}, {"chatgpt": 1, "deepseek": 2, "gemini": 3}
        for table, codes in (("dim_country", geos), ("dim_lang", langs), ("dim_engine", engines)):
            await conn.executemany(f"INSERT INTO gold.{table} VALUES ($1,$2)", [(k, code) for code, k in codes.items()])
        before, friday, later = date(2026, 10, 2), date(2026, 10, 9), date(2026, 10, 16)
        closed = {"status": 1, "servable": False, "publication": None, "modes": (), "fleet": True}   # its site's week representative
        sites = {   # project: brand bit, site country, its 10-09 cycle, its jobs (round, country measured in, language, engines)
            11: (2, "IT", closed, [(before, "IT", "it", ("chatgpt", "gemini"))]),                 # Kia Italy: no job of 10-09
            12: (4, "US", {"hidden": 1}, [(friday, "US", "en", ("chatgpt", "gemini")),            # hidden by an operator;
                                          (later, "DE", "de", ("chatgpt",))]),                    # German after the week
            13: (4, "SA-Dammam", {**closed, "status": 0}, [(before, "SA-Jeddah", "ar", ("chatgpt",)),   # a city market: its
                                                         (before, "SA-Riyadh", "ar", ("gemini",))]),    # prompts elsewhere
            14: (1, "DE", {}, [(friday, "DE", "de", ("chatgpt", "deepseek", "gemini"))]),         # shown
            15: (2, "FR", {**closed, "status": 0}, []),                                           # nothing measured yet
            16: (1, "MIDDLEEAST", closed, [(before, "AE", "en", ("chatgpt",))])}                 # a hub site measured in AE
        keys = itertools.count(100)
        for project, (brand, country, cycle, jobs) in sites.items():
            await conn.execute("INSERT INTO gold.dim_project VALUES ($1,$2,$3)", project, brand, geos[country])
            rounds = {day: next(keys) for day in (before, friday, later)}
            await self.put(conn, rounds[before], W, before, project=project)   # the week before: shown
            await self.put(conn, rounds[friday], W, friday, project=project, **cycle)
            await self.put(conn, rounds[later], W, later, project=project)     # after the service week: never read
            await conn.executemany("INSERT INTO gold.job_index VALUES ($1,$2,2,$3,$4,$5,$6)",
                                   [(rounds[day], project, day, geos[geo], langs[lang], engines[e])
                                    for day, geo, lang, names in jobs for e in names])

        async def notes(qs):
            ctx = Context(conn, QueryParams(f"surface=website&{qs}"))
            ctx.release = {"release_id": RELEASE_IDS["website", "live"], "version": 1, "rule_signature": SIGNATURE}
            ctx.week = SimpleNamespace(start=date(2026, 10, 5), end=date(2026, 10, 11))
            with clock(week_notes), mock.patch.dict(os.environ, {"HGH_GOLD_RULE_SIGNATURE": SIGNATURE}):
                out = await week_notes.read(ctx)
            return [(n["week_start"].isoformat(), n["sites"], n["shown"], n["unpublished"], n["hidden"], n["other"])
                    for n in out["data"]["items"]]

        week = "2026-10-05"
        for qs, expected in (
                # the week: sites, shown, unpublished, hidden, other (the week before shows every site: no note)
                ("", [(week, 6, 1, 4, 1, 0)]),
                ("lang=de", [(week, 2, 1, 1, 0, 0)]),            # 14 shown; 15 not known; 12's German job is after the week
                ("lang=it", [(week, 2, 0, 2, 0, 0)]),            # 11 by its jobs of another round, 15 not known
                ("lang=en", [(week, 3, 0, 2, 1, 0)]),            # 12 hidden, 16 measured in AE, 15
                ("engine=deepseek", [(week, 2, 1, 1, 0, 0)]),    # 14, 15
                ("country=SA-Jeddah", [(week, 1, 0, 1, 0, 0)]),  # 13 measured there (its site is SA-Dammam)
                ("country=SA-Dammam", []),                       # none of 13's prompts is measured there
                ("country=AE", [(week, 1, 0, 1, 0, 0)]),         # 16, as an AE account's reads take it
                ("country=FR", [(week, 1, 0, 1, 0, 0)]),         # 15, by its own country
                ("country=IT&lang=it", [(week, 1, 0, 1, 0, 0)]),
                ("country=SA-Riyadh&engine=chatgpt", []),        # 13's chatgpt prompt is Jeddah's: no cell of both
                ("brand=Kia", [(week, 2, 0, 2, 0, 0)]),          # the brand is the site's own (as the reads)
                ("brand=Kia&lang=de", [(week, 1, 0, 1, 0, 0)])):
            with self.subTest(qs=qs):
                self.assertEqual(await notes(qs), expected)


if __name__ == "__main__":
    unittest.main()
