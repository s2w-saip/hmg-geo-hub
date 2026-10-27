// Test input for SummaryTilesView: the tiles view the website screens send (back/bff/screens/overview.py
// tiles_view) for the small KpiSummary fixtures the tests use, recorded once from the former browser
// rule and read from tiles-views.frozen.json (test/frozen.ts).
import { frozen, loadFrozen } from "@/test/frozen";
import type { KpiSummary } from "../../_data/model";
import type { TilesView } from "../../_data/screen-types";

const TABLE = loadFrozen(new URL("./tiles-views.frozen.json", import.meta.url));

export function tilesViewFor(...args: [items: KpiSummary[]]): TilesView {
  return frozen(TABLE, "tilesViewFor", args);
}
