"""The drilldown route and the filter options screen the hub server forwards (T14.5.2): the answer's shape is the data server's."""
import os
import unittest
from unittest import mock

try:
    from data_server import screens
    from data_server.screens import shared
    from data_server.tests.signed_in import SECRET, call, run, token_for
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_drill_route)") from exc


class Drill(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.dict(os.environ, {"HGH_INTERNAL_TOKEN_SECRET": SECRET})
        patch.start()
        self.addCleanup(patch.stop)

    def test_the_screens_status_and_body(self):
        async def build(name, q):
            self.assertEqual((name, q["ctx.params"]), ("mention/drill-answer", '[["jobId","1"]]'))
            return {"status": 404, "body": {"available": False}}

        with mock.patch.object(screens, "build", build):
            status, body = run(call("GET", "/v1/drill/mention/drill-answer?ctx.params=%5B%5B%22jobId%22,%221%22%5D%5D", token=token_for()))
        self.assertEqual((status, body), (404, {"available": False}))

    def test_only_the_drilldowns_and_only_with_the_internal_token(self):
        self.assertEqual(run(call("GET", "/v1/drill/overview/cards", token=token_for()))[0], 404)
        self.assertEqual(run(call("GET", "/v1/drill/mention/drill-answer"))[0], 401)

    def test_filter_options_are_the_panels_options_under_a_key(self):
        async def options(q):
            return {"engineOptions": ["chatgpt"]}

        with mock.patch.object(shared, "panel_options", options):
            self.assertEqual(run(shared.browser_panel_options({})), {"options": {"engineOptions": ["chatgpt"]}})


if __name__ == "__main__":
    unittest.main()
