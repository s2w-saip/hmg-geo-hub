"""Integration boundaries for separate HUB stores; no persistent fixture writes."""
import json
import os
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from bff.tests import live_auth

BASE = os.environ.get('HGH_GOLD_TEST_BASE_URL')


@unittest.skipUnless(BASE, 'Set HGH_GOLD_TEST_BASE_URL to the local read-only API')
class HubStorageReads(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if live_auth.token(BASE) is None:
            raise unittest.SkipTest(live_auth.SKIP)

    def read(self, path):
        with urlopen(live_auth.request(BASE, path), timeout=15) as response:
            return json.load(response)

    def test_operations_is_separate_and_read_only(self):
        h = self.read('/healthz')
        self.assertEqual(h['database'],'gold')
        self.assertEqual(h['analytics']['database'],'hmg_analytics')
        self.assertEqual(h['operations']['database'],'hmg_operations')
        self.assertEqual(h['operations']['role'],'hmg_operations_reader')
        self.assertTrue(h['operations']['ok'])
        self.assertEqual(h['operations']['read_only'],'on')

    def test_catalog_pagination_and_project_reference(self):
        first = self.read('/v1/hub/prompts?limit=1')
        self.assertEqual(first['meta']['source'],'hub_data')
        self.assertGreater(first['meta']['page']['total'],1)
        prompt = first['data']['items'][0]
        self.assertTrue(prompt['text'])
        self.assertGreaterEqual(prompt['version'],1)
        self.assertEqual(prompt['origin'],'gold')
        project_id = prompt['project_id']
        projects = self.read('/v1/hub/projects?project_id='+project_id)['data']['items']
        self.assertEqual(len(projects),1)
        self.assertEqual(projects[0]['project_id'],project_id)
        self.assertIsNone(projects[0]['definition']['name'])
        second = self.read('/v1/hub/prompts?limit=1&offset=1')['data']['items'][0]
        self.assertNotEqual(prompt['prompt_id'],second['prompt_id'])

    def test_invalid_inputs_and_write_methods(self):
        for path, status in (('/v1/hub/prompts?project_id=bad',400),('/v1/hub/prompts?limit=1001',422),
                             ('/v1/hub/unknown',404)):
            with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                self.read(path)
            self.assertEqual(error.exception.code,status)
        for method in ('POST','PUT','PATCH','DELETE'):
            with self.subTest(method=method), self.assertRaises(HTTPError) as error:
                urlopen(Request(BASE+'/v1/hub/projects',method=method),timeout=5)
            self.assertEqual(error.exception.code,405)


if __name__ == '__main__':
    unittest.main()
