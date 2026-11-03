"""Renewal Project tab screens (bff.screens.project_dashboard, 2026-11-03): the project filters and the Dashboard."""
import unittest

try:
    from fastapi import HTTPException
    from bff.tests.test_screens_overview import META, Router, screen, summary
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_project)") from exc

PID = "35ae7ec0-a80a-4c88-a431-9698470aa94b"
FIELD = "784c45ea-8b19-48f5-9d56-32555ef20f25"
PROJECT_META = {**META, "surface": "project", "as_of": "2026-10-09", "cycles": ["2026-10-09"]}


def project_summary() -> dict:
    s = summary(192)
    s["data"].update({"owned_url_rate": {"num": 14, "den": 192}, "target_url_rate": {"num": 0, "den": 192},
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


class Analysis(unittest.TestCase):
    """P3: the renewal Mention and Citation screens read the project with ctx.surface=project."""

    def test_mention_reads_the_projects_filters_and_no_service_week(self):
        import asyncio
        from unittest import mock
        from bff.screens import mention_data as md
        filters, actx = md.surface_filters({"surface": "project", "project_id": PID},
                                           {"geography": "CA", f"cf_{FIELD}": "AI", "brand": "Kia", "language": "fr"})
        self.assertEqual(actx, {"surface": "project", "projectId": PID, "scope": None, "customFields": {FIELD: ["AI"]}})
        self.assertEqual(filters["region"], ["CA"])
        self.assertTrue(filters["cumulative"] and filters["uncapped"])
        self.assertNotIn("brand", filters)
        self.assertNotIn("lang", filters)
        # the header's period is the URL's, not held to the service week (the week would 503 without a store)
        with mock.patch("bff.hub_stores.service_week.current_or_503", side_effect=AssertionError("week read")):
            out = screen("mention/rn-page", f"ctx.surface=project&ctx.project_id={PID}&time=2026-10-06..2026-10-12", Router({}))
            self.assertEqual(out["period"], {"from": "2026-10-06", "to": "2026-10-12"})
            from bff.screens._week import period_week
            self.assertIsNone(asyncio.run(period_week(filters | {"dateFrom": "2026-10-06", "dateTo": "2026-10-12"})))

    def test_citation_project_context_has_the_source_axis_and_no_week(self):
        from unittest import mock
        from bff.screens import citation
        filters, actx = citation.project_context({"source": "officialHmg", "engine": "gemini", f"cf_{FIELD}": "AI"}, PID)
        self.assertEqual(filters["sourceCategory"], ["officialHmg"])
        self.assertTrue(filters["cumulative"])
        self.assertEqual(actx["projectId"], PID)
        with mock.patch("bff.hub_stores.service_week.current_or_503", side_effect=AssertionError("week read")):
            out = screen("citation/renewal-header", f"ctx.surface=project&ctx.project_id={PID}&time=2026-10-06..2026-10-12", Router({}))
        self.assertEqual(out, {"period": {"from": "2026-10-06", "to": "2026-10-12"}})
        with self.assertRaises(HTTPException) as cm:
            screen("citation/renewal-header", "ctx.surface=project&ctx.project_id=nope", Router({}))
        self.assertEqual(cm.exception.status_code, 422)

    def test_the_citation_table_route_carries_the_project_and_its_tags(self):
        from bff.screens import citation
        query = citation.citation_route_query({"engine": "gemini", f"cf_{FIELD}": "AI", "cf_other": "x", "page": "2"}, "project", PID, [FIELD])
        self.assertEqual(query, f"cf_{FIELD}=AI&engine=gemini&projectId={PID}")


if __name__ == "__main__":
    unittest.main()
