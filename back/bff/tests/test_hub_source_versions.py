"""Versions of the 인용 출처 분류 inputs (data-013, 2026-11-03): every change of a correction, seed, official social account
or code-table row is one numbered version holding the whole row, as a prompt revision does. With HGH_SOURCE_LISTS_TEST_DB_URL
(a HUB data DB with 013, as a role that can SET ROLE hmg_source_override_editor): every list the HUB published reads back
from the versions at its change_seq, the current rows are their latest versions, a write through the stores is one whole
version (a no-op none), and the screen's role cannot write versions. Writes run in one transaction that is rolled back;
the Gold reads are faked."""
import asyncio
import json
import os
import unittest
import uuid
from contextlib import asynccontextmanager
from unittest import mock

try:
    import asyncpg

    from bff.hub_stores import source_lists as sl
    from bff.hub_stores import source_overrides as so
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_hub_source_versions)") from exc

DB_URL = os.environ.get("HGH_SOURCE_LISTS_TEST_DB_URL")

# family → (version table, key columns, the published item of a version row or None when it is not in the list)
SPECS = {
    "source_override": ("source_override_version", ("skey",),
                        lambda v: {"skey": v["skey"], "category": v["category"]} if v["status"] == "active" else None),
    "source_seed": ("source_seed_version", ("skey",),
                    lambda v: {"skey": v["skey"], "category": v["category"]} if v["status"] == "active" else None),
    "source_social": ("source_social_version", ("account_key",),
                      lambda v: {"skey": v["display_key"], "domain": v["domain"], "category": "officialHmg",
                                 "matchers": as_json(v["matchers"])} if v["status"] == "active" else None),
    "source_code": ("source_code_version", ("kind", "code"),
                    lambda v: {k: v[k] for k in ("kind", "code", "number", "name_en", "name_ko", "ord", "description")}),
}
ITEM_KEY = {"source_override": lambda v: v["skey"], "source_seed": lambda v: v["skey"],
            "source_social": lambda v: v["account_key"], "source_code": lambda v: f"{v['kind']}:{v['code']}"}
BOOKKEEPING = {"version", "recorded_at", "recorded_by", "change_seq"}


def as_json(value):
    return json.loads(value) if isinstance(value, str) else value


async def as_of(conn, family: str, seq: int) -> dict:
    """The list as the versions say it stood at change_seq `seq`: each key's latest version up to then."""
    table, keys, item = SPECS[family]
    cols = ",".join(keys)
    rows = await conn.fetch(f"""SELECT DISTINCT ON ({cols}) * FROM catalog.{table} WHERE change_seq<=$1
        ORDER BY {cols},version DESC""", seq)
    return {ITEM_KEY[family](r): i for r in rows if (i := item(r)) is not None}


@unittest.skipUnless(DB_URL, "HGH_SOURCE_LISTS_TEST_DB_URL (a HUB data DB with 013, as a role that can SET ROLE hmg_source_override_editor) not set")
class Versions(unittest.TestCase):
    def test_every_published_list_reads_back_from_the_versions(self):
        async def scenario():
            conn = await asyncpg.connect(DB_URL)
            try:
                for family in SPECS:
                    sets = await conn.fetch("SELECT set_id,version,change_seq FROM catalog.reference_set WHERE family=$1 ORDER BY version", family)
                    self.assertTrue(sets, family)
                    for s in sets:
                        published = {r["item_key"]: as_json(r["definition"]) for r in await conn.fetch(
                            "SELECT item_key,definition FROM catalog.reference_item WHERE set_id=$1", s["set_id"])}
                        if family == "source_override":  # 007 keeps the key in the definition too
                            published = {k: {"skey": d["skey"], "category": d["category"]} for k, d in published.items()}
                        self.assertEqual(await as_of(conn, family, s["change_seq"]), published, f"{family} v{s['version']}")
            finally:
                await conn.close()
        asyncio.run(scenario())

    def test_the_current_rows_are_their_latest_versions(self):
        async def scenario():
            conn = await asyncpg.connect(DB_URL)
            try:
                for family, (table, keys, _) in SPECS.items():
                    current = family
                    cols = ",".join(keys)
                    rows = {tuple(r[k] for k in keys): dict(r) for r in await conn.fetch(f"SELECT * FROM catalog.{current}")}
                    latest = {tuple(r[k] for k in keys): dict(r) for r in await conn.fetch(
                        f"SELECT DISTINCT ON ({cols}) * FROM catalog.{table} ORDER BY {cols},version DESC")}
                    self.assertEqual(set(rows), set(latest), family)
                    for key, row in rows.items():
                        version = {k: v for k, v in latest[key].items() if k not in BOOKKEEPING}
                        values = {k: row[k] for k in version}
                        self.assertEqual(json.loads(json.dumps(version, default=str)), json.loads(json.dumps(values, default=str)), f"{family} {key}")
                    gaps = await conn.fetchval(f"""SELECT count(*) FROM (SELECT {cols},count(*) n,max(version) m FROM catalog.{table}
                        GROUP BY {cols}) g WHERE n<>m""")
                    self.assertEqual(gaps, 0, f"{family}: versions are 1..n")
            finally:
                await conn.close()
        asyncio.run(scenario())

    def test_a_write_is_one_whole_version(self):
        asyncio.run(self.writes())

    async def writes(self):
        conn = await asyncpg.connect(DB_URL)
        tx = conn.transaction()
        await tx.start()
        actor = mock.Mock(user_id=str(uuid.uuid4()))

        @asynccontextmanager
        async def writing():
            await conn.execute("SET LOCAL ROLE hmg_source_override_editor")
            await conn.execute("SELECT pg_advisory_xact_lock(617427413)")
            try:
                yield conn
            finally:
                await conn.execute("RESET ROLE")

        async def gold_check(key, category):
            return {"skey": key, "category_src": 5, "slug": "newsMedia"}

        patches = [mock.patch.object(sl, "writing", writing), mock.patch.object(so, "writing", writing),
                   mock.patch.object(so, "gold_check", gold_check)]
        for p in patches:
            p.start()
        try:
            async def versions(table, where, *args):
                return [dict(r) for r in await conn.fetch(f"SELECT * FROM catalog.{table} WHERE {where} ORDER BY version", *args)]

            out = await sl.set_seed(sl.SeedSet(skey="version-test.example", category="newsMedia"), actor)
            await sl.set_seed(sl.SeedSet(skey="version-test.example", category="newsMedia"), actor)  # no change
            await sl.set_seed(sl.SeedSet(skey="version-test.example", category="blogsReviews"), actor)
            await sl.remove_seed(sl.SeedKey(skey="version-test.example"), actor)
            seeds = await versions("source_seed_version", "skey=$1", "version-test.example")
            self.assertEqual([(v["version"], v["category"], v["status"]) for v in seeds],
                             [(1, "newsMedia", "active"), (2, "blogsReviews", "active"), (3, "blogsReviews", "removed")])
            self.assertEqual({(v["origin"], v["note"], str(v["recorded_by"])) for v in seeds}, {("hub", None, actor.user_id)})
            self.assertLess(seeds[0]["change_seq"], out["published"]["changeSeq"])
            self.assertEqual(sorted(v["change_seq"] for v in seeds), [v["change_seq"] for v in seeds])

            m = [sl.Matcher(prefix="version-test.example/acct", boundary=True)]
            await sl.set_social(sl.SocialSet(key="version-test.example/Acct", matchers=m), actor)
            await sl.set_social_status(sl.SocialKey(key="version-test.example/acct"), True, actor)
            socials = await versions("source_social_version", "account_key=$1", "version-test.example/acct")
            self.assertEqual([(v["version"], v["status"], v["display_key"], v["domain"]) for v in socials],
                             [(1, "active", "version-test.example/Acct", "version-test.example"),
                              (2, "stopped", "version-test.example/Acct", "version-test.example")])
            self.assertEqual(as_json(socials[1]["matchers"]), [{"prefix": "version-test.example/acct", "boundary": True}])

            await conn.execute("""INSERT INTO catalog.source_code(kind,code,number,name_en,name_ko,ord)
                VALUES('layer','zzVersionTest',98,'Test','시험',98)""")
            await sl.set_code(sl.CodeSet(kind="layer", code="zzVersionTest", nameEn="Test", nameKo="시험", description="설명"), actor)
            codes = await versions("source_code_version", "kind='layer' AND code=$1", "zzVersionTest")
            self.assertEqual([(v["version"], v["number"], v["name_en"], v["description"], v["recorded_by"] is None) for v in codes],
                             [(1, 98, "Test", None, True), (2, 98, "Test", "설명", False)])

            await so.set_category(so.OverrideSet(skey="version-test.example", category="newsMedia"), actor)
            await so.clear(so.OverrideClear(skey="version-test.example"), actor)
            overrides = await versions("source_override_version", "skey=$1", "version-test.example")
            self.assertEqual([(v["version"], v["category"], v["status"], v["origin"]) for v in overrides],
                             [(1, "newsMedia", "active", "hub"), (2, "newsMedia", "cleared", "hub")])

            await conn.execute("SET LOCAL ROLE hmg_source_override_editor")
            for statement in ("INSERT INTO catalog.source_seed_version SELECT * FROM catalog.source_seed_version LIMIT 1",
                              "UPDATE catalog.source_seed_version SET category='x'",
                              "DELETE FROM catalog.source_social_version",
                              "UPDATE catalog.source_code_version SET name_ko='x'",
                              "DELETE FROM catalog.source_override_version"):
                with self.assertRaises(asyncpg.InsufficientPrivilegeError, msg=statement):
                    async with conn.transaction():
                        await conn.execute(statement)
        finally:
            for p in patches:
                p.stop()
            await tx.rollback()
            await conn.close()


if __name__ == "__main__":
    unittest.main()
