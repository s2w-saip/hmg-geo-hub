"""Renewal Project tab screens (data_server.screens.project_dashboard, 2026-11-03): the project filters and the Dashboard."""
import unittest
from unittest import mock

try:
    from fastapi import HTTPException
    from data_server.screens import project_dashboard
    from data_server.tests.test_screens_overview import META, Router, screen, summary
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_screens_project)") from exc

PID = "35ae7ec0-a80a-4c88-a431-9698470aa94b"
FIELD = "784c45ea-8b19-48f5-9d56-32555ef20f25"
PROJECT_META = {**META, "surface": "project", "as_of": "2026-10-09", "cycles": ["2026-10-09"]}


def project_summary() -> dict:
    s = summary(192)
    s["data"].update({"url_prompts": {"measured_prompts": 192, "target_prompts": 0, "owned_prompts": 14},
                      "owned_url_rate": {"num": 14, "den": 192}, "target_url_rate": {"num": 0, "den": 192},
                      "citation_accuracy": {"num": 0, "den": 14}})
    return {**s, "meta": PROJECT_META}


TREND = {"data": {"bucket": "cycle", "dimension": "none", "own_label": "HMG", "buckets": [], "series": []}, "meta": PROJECT_META}


def bodies() -> dict:
    return {"kpi/summary": project_summary(), "mentions/brands": {"data": {"brands": []}, "meta": PROJECT_META},
            "kpi/engines": {"data": {"rows": []}, "meta": PROJECT_META}, "trend": TREND,
            "citations/domains": {"data": {"summary": {"own_share": {"num": 46, "den": 3973}},
                                           "items": [{"domain": "caranddriver.com", "citations": 315, "share": {"num": 315, "den": 3973},
                                                      "is_own": False}]}, "meta": PROJECT_META}}


class ProjectFilters(unittest.TestCase):
    def test_reads_are_the_projects_with_its_axes_and_custom_tags(self):
        router = Router(bodies())
        screen("projects/dash-summary", f"ctx.project_id={PID}&geography=CA&engine=Gemini&time=2026-10-06..2026-10-06"
               f"&cf_{FIELD}=AI~Hybrid&brand=Kia&language=fr", router)
        calls = dict(router.calls)["kpi/summary"]
        self.assertIn(("surface", "project"), calls)
        self.assertIn(("project_id", PID), calls)
        self.assertIn(("country", "CA"), calls)
        self.assertIn(("engine", "gemini"), calls)
        self.assertIn(("from", "2026-10-06"), calls)
        self.assertIn((f"cf.{FIELD}", "AI"), calls)
        self.assertIn((f"cf.{FIELD}", "Hybrid"), calls)
        # a project has no brand or language axis, and its reads are live only (no card population)
        for key in ("brand", "lang", "card"):
            self.assertNotIn(key, dict(calls), key)

    def test_a_page_without_a_project_id_is_refused(self):
        for qs in ("", "ctx.project_id=nope"):
            with self.subTest(qs=qs), self.assertRaises(HTTPException) as cm:
                screen("projects/dash-summary", qs, Router(bodies()))
            self.assertEqual(cm.exception.status_code, 422)

    def test_panel_options_and_calendar(self):
        router = Router({"filters/options": {"data": {"geo_matrix": [{"brand": "Hyundai", "region": "CA", "lang": None}],
                                                      "regions": [], "languages": [], "engines": [{"code": "chatgpt"}, {"code": "gemini"}],
                                                      "catalog": None, "custom_fields": [{"field_id": FIELD, "label": "Topic", "values": ["Hybrid", "AI"]}]},
                                             "meta": PROJECT_META},
                         "filters/dates": {"data": {"dates": ["2026-10-09", "2026-10-06"], "latest_round_date": "2026-10-09",
                                                    "first_measured_date": "2026-10-06", "presets": []}, "meta": PROJECT_META}})
        out = screen("projects/filters", f"ctx.project_id={PID}&ctx.family=citations", router)
        self.assertEqual(out["geographyOptions"], ["CA"])
        self.assertEqual(out["engineOptions"], ["chatgpt", "gemini"])
        self.assertEqual(out["dynamicAxes"], [{"id": FIELD, "label": "Topic", "options": ["AI", "Hybrid"]}])
        self.assertEqual(out["selectableDates"], ["2026-10-06", "2026-10-09"])
        self.assertIn(("family", "citations"), dict(router.calls)["filters/dates"])


class Dashboard(unittest.TestCase):
    def test_tiles_carry_the_project_url_rates_and_no_period_compare(self):
        out = screen("projects/dash-summary", f"ctx.project_id={PID}&time=2026-10-06..2026-10-09", Router(bodies()))
        keys = [t["key"] for g in out["tiles"]["groups"] for t in g["tiles"]]
        self.assertEqual(keys, ["visibility", "shareOfVoice", "sentiment", "position", "ownedUrlRate", "targetUrlRate",
                                "citationShare", "citationAccuracy"])
        tiles = {t["key"]: t for g in out["tiles"]["groups"] for t in g["tiles"]}
        self.assertEqual(tiles["visibility"]["ratio"], {"numerator": 50, "denominator": 192})
        self.assertEqual(tiles["ownedUrlRate"]["value"], 7.3)
        self.assertTrue(all(t["period"] is None for t in tiles.values()))
        self.assertNotIn("compareTitle", out["tiles"])

    def test_no_answers_is_empty_and_a_transient_failure_degrades(self):
        empty = bodies()
        empty["kpi/summary"] = {**project_summary(), "data": {**project_summary()["data"], "params": {"answers": 0}}}
        self.assertEqual(screen("projects/dash-summary", f"ctx.project_id={PID}", Router(empty)), {"state": "empty"})
        self.assertEqual(screen("projects/dash-summary", f"ctx.project_id={PID}", Router(bodies(), {"kpi/summary": 503})), {"state": "degraded"})

    def test_sections_degrade_on_a_transient_failure(self):
        self.assertTrue(screen("projects/dash-engines", f"ctx.project_id={PID}", Router({}, {"kpi/engines": 503}))["degraded"])
        self.assertTrue(screen("projects/dash-composition", f"ctx.project_id={PID}", Router({}, {"citations/domains": 503}))["degraded"])
        with self.assertRaises(HTTPException):
            screen("projects/dash-trend", f"ctx.project_id={PID}", Router({}, {"trend": 422}))

    def test_composition_is_the_top_domains_and_the_rest(self):
        out = screen("projects/dash-composition", f"ctx.project_id={PID}", Router(bodies()))
        self.assertEqual(out["sources"], [{"domain": "caranddriver.com", "citations": 315, "share": 7.9, "isOurs": False},
                                          {"domain": "", "citations": 3658, "share": 92.1, "isOurs": False}])

    def test_as_of_is_the_round_shown(self):
        self.assertEqual(screen("projects/as-of", f"ctx.project_id={PID}", Router(bodies())), {"asOf": "2026-10-09"})
        self.assertEqual(screen("projects/as-of", f"ctx.project_id={PID}", Router({}, {"kpi/summary": 503})), {"asOf": None})

    def test_status_is_the_projects_gold_facts_and_its_latest_prompts(self):
        prompts = [{"prompt_id": f"p{i}", "text": f"prompt {i}", "answers": i, "last_measured": f"2026-10-{i:02d}T05:00:00+00:00"} for i in range(1, 11)]
        prompts.append({"prompt_id": "never", "text": "never measured", "answers": 0, "last_measured": None})
        router = Router({"gold/projects": {"data": {"items": [
            {"id": PID, "prompts": 11, "answers": 55, "rounds": 2, "countries": ["CA"], "engines": ["chatgpt"], "custom_fields": 5,
             "last_measured": "2026-10-10T05:00:00+00:00"}]}, "meta": PROJECT_META},
            f"gold/projects/{PID}": {"data": {"project": {}, "prompts": prompts}, "meta": PROJECT_META}})
        out = screen("projects/dash-status", f"ctx.project_id={PID}", router)
        self.assertEqual(out["facts"], {"prompts": 11, "measuredPrompts": 10, "answers": 55, "rounds": 2, "countries": ["CA"],
                                        "engines": ["chatgpt"], "customFields": 5, "lastMeasuredDay": "2026-10-10"})
        self.assertEqual([p["promptId"] for p in out["recent"]], ["p10", "p9", "p8", "p7", "p6", "p5", "p4", "p3"])
        self.assertEqual(out["recent"][0], {"promptId": "p10", "text": "prompt 10", "answers": 10, "lastMeasuredDay": "2026-10-10"})


class Prompts(unittest.TestCase):
    """P4: the project's prompts with their tag values; country, engine and period are the lens, tags narrow the rows. Without
    the HUB catalog the rows are Gold's, read only."""

    def setUp(self):
        async def no_catalog(project_id):
            return None

        patch = mock.patch.object(project_dashboard.hub_prompts, "catalog", no_catalog)
        patch.start()
        self.addCleanup(patch.stop)

    ITEMS = [
        {"prompt_id": "a", "text": "A", "kind": "single", "lang": None, "funnel": None, "regions": None, "targets": [], "answers": 4,
         "first_measured": "2026-10-06", "last_measured": "2026-10-09", "rounds": ["2026-10-06", "2026-10-09"], "countries": ["CA"],
         "engine_answers": {"chatgpt": 2, "gemini": 2}, "custom": {FIELD: "AI", "f2": "NX5"}},
        {"prompt_id": "b", "text": "B", "kind": "single", "lang": "fr", "funnel": None, "regions": None, "targets": [], "answers": 0,
         "first_measured": None, "last_measured": None, "rounds": [], "countries": [], "engine_answers": {}, "custom": {FIELD: "Design"}},
        {"prompt_id": "c", "text": "C", "kind": "single", "lang": None, "funnel": None, "regions": None, "targets": [], "answers": 2,
         "first_measured": "2026-10-09", "last_measured": "2026-10-09", "rounds": ["2026-10-09"], "countries": ["CA"],
         "engine_answers": {"gemini": 2}, "custom": {}},
    ]

    def router(self):
        return Router({f"gold/projects/{PID}": {"data": {"items": self.ITEMS, "fields": [{"field_id": FIELD, "label": "Topic"}],
                                                          "rounds": ["2026-10-06", "2026-10-09"]}, "meta": PROJECT_META}})

    def test_the_lens_goes_to_gold_and_never_drops_a_row(self):
        router = self.router()
        out = screen("projects/prompts", f"ctx.project_id={PID}&geography=CA&engine=Gemini&time=2026-10-06..2026-10-09", router)
        params = dict(router.calls)[f"gold/projects/{PID}"]
        self.assertEqual(sorted(params), [("country", "CA"), ("engine", "gemini"), ("from", "2026-10-06"), ("to", "2026-10-09"),
                                          ("view", "prompts")])
        self.assertEqual([r["id"] for r in out["rows"]], ["a", "b", "c"])
        self.assertEqual(out["listed"], 3)
        self.assertEqual(out["fields"], [{"id": FIELD, "label": "Topic", "archived": False, "state": "applied"}])
        self.assertEqual(out["rows"][0]["custom"], {FIELD: "AI", "f2": "NX5"})
        self.assertEqual(out["rows"][0]["lastMeasured"], "2026-10-09")
        self.assertEqual((out["rows"][0]["status"], out["rows"][0]["state"], out["rows"][0]["version"], out["editable"]),
                         ("active", "applied", None, False))

    def test_tags_narrow_the_rows_or_inside_a_field_and_across_fields(self):
        out = screen("projects/prompts", f"ctx.project_id={PID}&cf_{FIELD}=AI~Design", self.router())
        self.assertEqual([r["id"] for r in out["rows"]], ["a", "b"])
        self.assertEqual(out["listed"], 3)
        other = "11111111-2222-4333-8444-555555555555"
        out = screen("projects/prompts", f"ctx.project_id={PID}&cf_{FIELD}=AI~Design&cf_{other}=x", self.router())
        self.assertEqual(out["rows"], [])


class HubPrompts(unittest.TestCase):
    """P4 with the HUB catalog (decision '프로젝트 프롬프트 적재'): the HUB's rows and values, Gold's measurement next to them,
    and each compared with Gold."""

    GOLD = [*Prompts.ITEMS, {"prompt_id": "e", "text": "E", "kind": "single", "lang": None, "funnel": None, "regions": None, "targets": [],
                             "answers": 1, "first_measured": "2026-10-09", "last_measured": "2026-10-09", "rounds": ["2026-10-09"],
                             "countries": ["CA"], "engine_answers": {"gemini": 1}, "custom": {}}]

    @staticmethod
    def hub(pid, text, status="active", custom=None, kind="single", lang=None, origin="gold"):
        return {"id": pid, "origin": origin, "version": 2, "text": text, "kind": kind, "lang": lang, "status": status,
                "custom": custom or {}, "hubEdited": origin == "hub", "recordedAt": None, "registeredAt": None}

    def setUp(self):
        hub = {"version": 3, "editable": True, "languages": ["en", "ko"],
               "fields": [{"id": FIELD, "label": "Topic", "archived": False}, {"id": "new", "label": "Model", "archived": False},
                          {"id": "gone", "label": "Old", "archived": True}],
               "prompts": [self.hub("a", "A", custom={FIELD: "AI", "f2": "NX5"}), self.hub("b", "B", custom={FIELD: "Hybrid"}, lang="fr"),
                           self.hub("c", "C", status="archived"), self.hub("d", "D", status="draft", origin="hub", custom={FIELD: "AI"}),
                           self.hub("p", "P", status="paused")]}

        async def catalog(project_id):
            self.asked = str(project_id)
            return hub

        patch = mock.patch.object(project_dashboard.hub_prompts, "catalog", catalog)
        patch.start()
        self.addCleanup(patch.stop)

    def router(self):
        return Router({f"gold/projects/{PID}": {"data": {"items": self.GOLD, "fields": [{"field_id": FIELD, "label": "Topic"},
                                                                                        {"field_id": "g2", "label": "Region"}],
                                                          "rounds": ["2026-10-06", "2026-10-09"]}, "meta": PROJECT_META}})

    def test_rows_are_the_hubs_compared_with_gold(self):
        out = screen("projects/prompts", f"ctx.project_id={PID}", self.router())
        self.assertEqual(self.asked, PID)
        rows = {r["id"]: r for r in out["rows"]}
        self.assertEqual([r["id"] for r in out["rows"]], ["a", "b", "c", "d", "p", "e"])
        self.assertEqual({k: (r["status"], r["state"]) for k, r in rows.items()},
                         {"a": ("active", "applied"), "b": ("active", "pending"), "c": ("archived", "pending"), "d": ("draft", "draft"),
                          "p": ("paused", None), "e": ("active", "upstream")})
        self.assertEqual((rows["b"]["custom"], rows["b"]["answers"]), ({FIELD: "Hybrid"}, 0))   # the HUB's value, Gold's measurement
        self.assertEqual((rows["a"]["answers"], rows["a"]["engineAnswers"]), (4, {"chatgpt": 2, "gemini": 2}))
        self.assertEqual((rows["d"]["answers"], rows["d"]["lastMeasured"], rows["d"]["version"]), (0, None, 2))
        self.assertEqual((rows["e"]["version"], out["editable"], out["listed"]), (None, True, 6))
        self.assertEqual([(f["id"], f["archived"], f["state"]) for f in out["fields"]],
                         [(FIELD, False, "applied"), ("new", False, "pending"), ("gone", True, "applied"), ("g2", False, "upstream")])

    def test_tags_narrow_by_the_hubs_values(self):
        out = screen("projects/prompts", f"ctx.project_id={PID}&cf_{FIELD}=AI", self.router())
        self.assertEqual([r["id"] for r in out["rows"]], ["a", "d"])

    def test_states_compare_values_only(self):
        state, gold = project_dashboard.prompt_state, {"text": "A", "kind": "single", "lang": None, "custom": {}}
        row = {"status": "active", "text": "A", "kind": "single", "lang": None, "custom": {}}
        self.assertEqual(state(row, gold), "applied")
        self.assertEqual(state({**row, "kind": "acr"}, gold), "pending")
        self.assertEqual(state({**row, "lang": "ko"}, gold), "pending")
        self.assertEqual(state(row, None), "pending")
        self.assertEqual(state({**row, "status": "archived"}, None), "applied")
        self.assertIsNone(state({**row, "status": "removed"}, None))


class Conversion(unittest.TestCase):
    """P5: the project's GA4 properties only (the analytics reader's own mapping); none yet = the sample veil's state."""

    def test_reads_the_projects_properties_and_offers_their_markets(self):
        prop = {"property_id": "123", "brand_bit": 1, "country": "CA", "status": "active"}
        router = Router({"analytics/conversion": {"data": {"kind": "conversion", "properties": [prop], "period": {}},
                                                  "meta": {"reason": "no_measurements"}}})
        out = screen("conversion/renewal", f"ctx.project_id={PID}&engine=gemini", router)
        calls = [dict(params) for path, params in router.calls]
        self.assertTrue(all(c.get("project_id") == PID for c in calls))
        self.assertNotIn("analytics/properties", [path for path, _ in router.calls])
        self.assertEqual(out["props"]["geographyOptions"], ["CA"])
        self.assertEqual(out["body"]["state"], "empty")

    def test_no_property_is_the_sample_state_and_a_bad_id_is_refused(self):
        router = Router({"analytics/conversion": {"data": {"kind": "conversion", "properties": []}, "meta": {"reason": "no_properties"}}})
        self.assertEqual(screen("conversion/renewal", f"ctx.project_id={PID}", router)["body"]["state"], "noprop")
        with self.assertRaises(HTTPException) as cm:
            screen("conversion/renewal", "ctx.project_id=nope", router)
        self.assertEqual(cm.exception.status_code, 422)


class Settings(unittest.TestCase):
    """Setting › General (read part): Gold's ids, measured values, tag fields with their carried values, target count."""

    def test_settings_are_golds_values(self):
        items = [{"prompt_id": "a", "targets": [], "custom": {FIELD: "Hybrid"}}, {"prompt_id": "b", "targets": ["kia.ca/x"], "custom": {FIELD: "AI"}},
                 {"prompt_id": "c", "targets": [], "custom": {FIELD: "AI"}}, {"prompt_id": "d", "targets": [], "custom": {}}]
        bodies = {"gold/projects": {"data": {"items": [{"id": PID, "countries": ["CA"], "engines": ["chatgpt"], "languages": [], "rounds": 2,
                                                         "prompts": 4, "answers": 8, "last_measured": "2026-10-09T05:00:00+00:00"}]}, "meta": PROJECT_META}}

        class Gate(Router):
            async def get(self, path, params=None):
                if path == f"gold/projects/{PID}":
                    self.calls.append((path, [("view", (params or {}).get("view"))]))
                    if (params or {}).get("view") == "gate":
                        return {"data": {"project": {"project_id": PID, "scope_project_id": "s-1", "regions": None}, "prompts": []}}
                    return {"data": {"items": items, "fields": [{"field_id": FIELD, "label": "Topic"}], "rounds": []}}
                return await super().get(path, params)

        out = screen("projects/settings", f"ctx.project_id={PID}", Gate(bodies))
        self.assertEqual(out["identity"], {"projectId": PID, "scopeProjectId": "s-1", "regions": None})
        self.assertEqual(out["measured"]["lastMeasuredDay"], "2026-10-09")
        self.assertEqual(out["fields"], [{"id": FIELD, "label": "Topic", "values": ["AI", "Hybrid"], "prompts": 3}])
        self.assertEqual(out["targets"], 1)
        with self.assertRaises(HTTPException):
            screen("projects/settings", "ctx.project_id=nope", Gate(bodies))


class Analysis(unittest.TestCase):
    """P3: the renewal Mention and Citation screens read the project with ctx.surface=project."""

    def test_mention_reads_the_projects_filters_and_no_service_week(self):
        import asyncio
        from unittest import mock
        from data_server.screens import mention_data as md
        filters, actx = md.surface_filters({"surface": "project", "project_id": PID},
                                           {"geography": "CA", f"cf_{FIELD}": "AI", "brand": "Kia", "language": "fr"})
        self.assertEqual(actx, {"surface": "project", "projectId": PID, "scope": None, "customFields": {FIELD: ["AI"]}})
        self.assertEqual(filters["region"], ["CA"])
        self.assertTrue(filters["cumulative"] and filters["uncapped"])
        self.assertNotIn("brand", filters)
        self.assertNotIn("lang", filters)
        # the header's period is the URL's, not held to the service week (the week would 503 without a store)
        with mock.patch("data_server.hub_stores.service_week.current_or_503", side_effect=AssertionError("week read")):
            out = screen("mention/rn-page", f"ctx.surface=project&ctx.project_id={PID}&time=2026-10-06..2026-10-12", Router({}))
            self.assertEqual(out["period"], {"from": "2026-10-06", "to": "2026-10-12"})
            from data_server.screens._week import period_week
            self.assertIsNone(asyncio.run(period_week(filters | {"dateFrom": "2026-10-06", "dateTo": "2026-10-12"})))

    def test_citation_project_context_has_the_source_axis_and_no_week(self):
        from unittest import mock
        from data_server.screens import citation
        filters, actx = citation.project_context({"source": "officialHmg", "engine": "gemini", f"cf_{FIELD}": "AI"}, PID)
        self.assertEqual(filters["sourceCategory"], ["officialHmg"])
        self.assertTrue(filters["cumulative"])
        self.assertEqual(actx["projectId"], PID)
        with mock.patch("data_server.hub_stores.service_week.current_or_503", side_effect=AssertionError("week read")):
            out = screen("citation/renewal-header", f"ctx.surface=project&ctx.project_id={PID}&time=2026-10-06..2026-10-12", Router({}))
        self.assertEqual(out, {"period": {"from": "2026-10-06", "to": "2026-10-12"}})
        with self.assertRaises(HTTPException) as cm:
            screen("citation/renewal-header", "ctx.surface=project&ctx.project_id=nope", Router({}))
        self.assertEqual(cm.exception.status_code, 422)

    def test_the_citation_table_route_carries_the_project_and_its_tags(self):
        from data_server.screens import citation
        query = citation.citation_route_query({"engine": "gemini", f"cf_{FIELD}": "AI", "cf_other": "x", "page": "2"}, "project", PID, [FIELD])
        self.assertEqual(query, f"cf_{FIELD}=AI&engine=gemini&projectId={PID}")


if __name__ == "__main__":
    unittest.main()
