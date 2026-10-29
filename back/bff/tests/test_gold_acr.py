"""Gold ACR reader (bff.gold_reader.acr) over a stand-in connection: the own total (당사 = every own brand
of the perspective) wherever the page shows 당사, beyond the brand table's top."""
import asyncio
import unittest
from datetime import date, timedelta

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams

    from bff.gold_reader import acr
    from bff.gold_reader.context import Context
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_gold_acr)") from exc

D1, D2 = date(2026, 9, 28), date(2026, 10, 5)


def cell(key, day, valid=10):
    return {"acr_cell_key": key, "round_date": day, "prompt_key": key, "prompt_id": key, "prompt_text": f"p{key}",
            "engine": "chatgpt", "country": "US", "lang": "en", "valid_acr": valid}


def entity(key, brand, own_bit, choice, appearance=1):
    return {"acr_cell_key": key, "level": 1, "brand": brand, "own_bit": own_bit, "choice": choice, "appearance": appearance,
            "model": None, "parent_brand": None, "parent_own_bit": None, "entity_key": None}


def model(key, entity_key, name, parent, parent_own_bit, choice, appearance=1):
    return {"acr_cell_key": key, "level": 2, "brand": None, "own_bit": 0, "choice": choice, "appearance": appearance,
            "model": name, "parent_brand": parent, "parent_own_bit": parent_own_bit, "entity_key": entity_key}


class Conn:
    """The cell and entity facts of the test; the trend's aggregates are summed from them, over the rounds the
    statement binds (as the database would)."""

    def __init__(self, cells, rows):
        self.cells, self.rows, self.trend_days = cells, rows, []

    def bound_days(self, args):
        return next((a for a in args if isinstance(a, list) and a and isinstance(a[0], date)), [])

    async def fetch(self, sql, *args):
        if "sum(f.valid_acr)" in sql:
            self.trend_days = self.bound_days(args)
            out = {}
            for c in self.cells:
                if c["round_date"] in self.trend_days:
                    out[c["round_date"]] = out.get(c["round_date"], 0) + c["valid_acr"]
            return [{"round_date": d, "den": n} for d, n in out.items()]
        if "sum(e.choice)" in sql:
            days = {c["acr_cell_key"]: c["round_date"] for c in self.cells if c["round_date"] in self.bound_days(args)}
            out = {}
            for r in self.rows:
                if r["level"] == 1 and r["acr_cell_key"] in days:
                    k = (days[r["acr_cell_key"]], r["brand"], r["own_bit"])
                    out[k] = out.get(k, 0) + r["choice"]
            return [{"round_date": d, "brand": b, "own_bit": o, "choice": n} for (d, b, o), n in out.items()]
        if "FROM gold.acr_cell_fact" in sql:
            return self.cells
        if "FROM gold.acr_entity_fact" in sql:
            return self.rows
        raise AssertionError(f"unexpected statement: {sql[:120]}")


class SheetConn(Conn):
    """funnel/acr/territory binds the sheet's engine and country last."""

    async def fetch(self, sql, *args):
        if "FROM gold.acr_cell_fact" in sql and "e.code=" in sql:
            return [c for c in self.cells if (c["engine"], c["country"]) == (args[-2], args[-1])]
        return await super().fetch(sql, *args)


def read(cells, rows, qs="surface=global&from=2026-09-28&to=2026-10-05", *, dates=(D2, D1), selected=(D2, D1), conn=None, reader=acr.read):
    ctx = Context(conn or Conn(cells, rows), QueryParams(qs))
    ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
    ctx.builds = {"acr": list(range(len(dates)))}  # one ACR build per round
    ctx.build_dates = dict(enumerate(dates))
    ctx.dates = list(dates)
    ctx.selected_dates = list(selected)
    return asyncio.run(reader(ctx))["data"]


# 2026-10-29 metric review R1: Genesis (outside the brand table's top) was left out of 당사 on the ACR page.
CELLS = [cell(1, D1), cell(2, D2), cell(3, D2)]
ROWS = ([entity(1, "Toyota", 0, 4), entity(1, "Hyundai", 1, 2), entity(2, "Toyota", 0, 5), entity(2, "Hyundai", 1, 3),
         entity(2, "Kia", 2, 2), entity(3, "Genesis", 4, 1), entity(3, "BMW", 0, 6), entity(3, "Tesla", 0, 0)]
        + [entity(3, f"R{i}", 0, 1) for i in range(12)])


class OwnTotal(unittest.TestCase):
    def test_the_trend_carries_the_own_total_of_every_own_brand(self):
        data = read(CELLS, ROWS, "surface=global&from=2026-09-28&to=2026-10-05&top_brands=3")
        self.assertEqual([b["brand"] for b in data["brands"]], ["Toyota", "BMW", "Hyundai"])
        self.assertEqual([(str(b["round_date"]), b["den"], b["own"]) for b in data["trend"]["buckets"]],
                         [("2026-09-28", 10, 2), ("2026-10-05", 20, 6)])

    def test_own_lists_every_own_brand_it_sums(self):
        own = read(CELLS, ROWS, "surface=global&from=2026-09-28&to=2026-10-05&top_brands=3")["own"]
        self.assertEqual(own["brands"], ["Hyundai", "Kia", "Genesis"])
        self.assertEqual(own["choice"], 8)

    def test_the_standing_counts_every_chosen_rival_beyond_the_top(self):
        # rivals with a choice: Toyota 9, BMW 6 and R0..R11 1 each (Tesla never chosen) = 14, plus 당사
        own = read(CELLS, ROWS, "surface=global&from=2026-09-28&to=2026-10-05&top_brands=3")["own"]
        self.assertEqual((own["rank"], own["ranked_brands"]), (2, 15))

    def test_the_brand_table_holds_twelve_brands_by_default(self):
        self.assertEqual(len(read(CELLS, ROWS)["brands"]), 12)


class ReadRange(unittest.TestCase):
    """R5: the snapshot read its one round (Top1 ACR 증감 "−", one trend point); the model conversion came from one
    representative repetition per cell (Corolla Hybrid 50.0 % for 15.8 %, every one of 1,152 models); the
    distribution's sheets and its 최빈 column were in read order."""

    def test_a_snapshot_trend_spans_the_last_twelve_acr_rounds(self):
        days = [date(2026, 7, 6) + timedelta(days=7 * i) for i in range(14)]  # 07-06 .. 10-05
        cells = [cell(i + 1, d) for i, d in enumerate(days)]
        rows = [entity(i + 1, "Hyundai", 1, i + 1) for i in range(14)]
        conn = Conn(cells, rows)
        ctx_days = sorted(days, reverse=True)
        data = read(cells, rows, "surface=global", dates=ctx_days, selected=[days[-1]], conn=conn)
        self.assertEqual([str(b["round_date"]) for b in data["trend"]["buckets"]], [str(d) for d in days[-12:]])
        self.assertEqual([b["own"] for b in data["trend"]["buckets"]][-2:], [13, 14])

    def test_a_model_converts_its_picks_over_the_repetitions_of_its_cells(self):
        cells = [cell(1, D2, valid=10), cell(2, D2, valid=10), cell(3, D2, valid=8)]
        rows = [model(1, 50, "Corolla Hybrid", "Toyota", 0, 4), model(2, 50, "Corolla Hybrid", "Toyota", 0, 1),
                model(3, 50, "Corolla Hybrid", "Toyota", 0, 0),
                model(1, 60, "Tucson", "Hyundai", 1, 3), model(2, 61, "Kona", "Hyundai", 1, 0)]
        data = read(cells, rows, "surface=global", selected=[D2])
        self.assertEqual([(m["model"], m["conversion"], m["cells"], m["top1"], m["is_ours"]) for m in data["model_conversion"]],
                         [("Tucson", {"num": 3, "den": 10}, 1, 3, True), ("Corolla Hybrid", {"num": 5, "den": 28}, 3, 5, False)])

    def test_twelve_models_by_default(self):
        cells = [cell(1, D2, valid=100)]
        rows = [model(1, 100 + i, f"M{i:02d}", "Toyota", 0, 20 - i) for i in range(15)]
        self.assertEqual(len(read(cells, rows, "surface=global", selected=[D2])["model_conversion"]), 12)

    def test_sheets_with_the_most_rows_first_and_their_brands_most_picked_first(self):
        cells = [cell(1, D2), {**cell(2, D2), "engine": "gemini"}, {**cell(3, D2), "engine": "gemini"}]
        rows = [entity(1, "Toyota", 0, 0), entity(1, "Kia", 2, 9), entity(2, "BMW", 0, 2), entity(2, "Kia", 2, 5)]
        sheets = read(cells, rows, "surface=global", selected=[D2])["territory"]
        self.assertEqual([(s["engine"], len(s["rows"])) for s in sheets], [("gemini", 2), ("chatgpt", 1)])
        self.assertEqual([e["brand"] for e in sheets[1]["rows"][0]["entries"]], ["Kia", "Toyota"])

    def test_a_row_is_a_prompt_with_its_cells_summed(self):
        # 2026-10-29: a round re-measures a prompt (up to 20 cells) and a period holds its rounds; one row per prompt
        cells = [{**cell(1, D1), "prompt_id": "q"}, {**cell(2, D2), "prompt_id": "q", "valid_acr": 8}, {**cell(3, D2), "prompt_id": "r"}]
        rows = [entity(1, "Toyota", 0, 4, 9), entity(1, "Hyundai", 1, 0, 5), entity(2, "Toyota", 0, 2, 6), entity(2, "Kia", 2, 3, 3),
                entity(3, "BMW", 0, 1)]
        sheet = read(cells, rows)["territory"][0]
        self.assertEqual(sheet["row_count"], 2)
        q = sheet["rows"][0]
        self.assertEqual((q["prompt_id"], q["valid_acr"], q["cells"]), ("q", 18, 2))
        self.assertEqual(q["entries"], [{"brand": "Toyota", "choice": 6, "appearance": 15, "is_ours": False},
                                        {"brand": "Kia", "choice": 3, "appearance": 3, "is_ours": True},
                                        {"brand": "Hyundai", "choice": 0, "appearance": 5, "is_ours": True}])
        self.assertEqual([(r["prompt_id"], r["cells"]) for r in sheet["rows"]], [("q", 2), ("r", 1)])



class SheetsOnDemand(unittest.TestCase):
    """2026-10-29: territory_rows=first sends the first sheet's rows only, with every sheet's row count;
    funnel/acr/territory sends one sheet as funnel/acr builds it (the renewal page loads a sheet when its tab opens)."""

    CELLS = [cell(1, D2), {**cell(2, D2), "engine": "gemini"}, {**cell(3, D2), "engine": "gemini"}, {**cell(4, D2), "country": None}]
    ROWS = [entity(1, "Toyota", 0, 0), entity(1, "Kia", 2, 9), entity(2, "BMW", 0, 2), entity(2, "Kia", 2, 5), entity(3, "Kia", 2, 1),
            entity(4, "Audi", 0, 3), model(4, 70, "A4", "Audi", 0, 3)]

    def sheets(self, qs="surface=global"):
        return read(self.CELLS, self.ROWS, qs, selected=[D2])["territory"]

    def sheet(self, qs):
        return read(self.CELLS, self.ROWS, qs, selected=[D2], conn=SheetConn(self.CELLS, self.ROWS), reader=acr.territory)["sheet"]

    def test_every_sheet_carries_its_row_count(self):
        self.assertEqual([(s["country"], s["engine"], s["row_count"], len(s["rows"])) for s in self.sheets()],
                         [("US", "gemini", 2, 2), (None, "chatgpt", 1, 1), ("US", "chatgpt", 1, 1)])

    def test_first_sends_the_first_sheets_rows_only(self):
        full, first = self.sheets(), self.sheets("surface=global&territory_rows=first")
        self.assertEqual(first[0], full[0])
        self.assertEqual([{**s, "rows": []} for s in full[1:]], first[1:])

    def test_a_bad_territory_rows_is_refused(self):
        with self.assertRaises(HTTPException) as ctx:
            self.sheets("surface=global&territory_rows=none")
        self.assertEqual(ctx.exception.status_code, 422)

    def test_a_sheet_is_the_one_funnel_acr_builds(self):
        for s in self.sheets():
            self.assertEqual(self.sheet(f"surface=global&sheet_engine={s['engine']}&sheet_country={s['country'] or ''}"), s)

    def test_a_sheet_without_cells_is_null(self):
        self.assertIsNone(self.sheet("surface=global&sheet_engine=perplexity&sheet_country=US"))

    def test_the_sheet_engine_is_required(self):
        with self.assertRaises(HTTPException) as ctx:
            self.sheet("surface=global&sheet_country=US")
        self.assertEqual(ctx.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
