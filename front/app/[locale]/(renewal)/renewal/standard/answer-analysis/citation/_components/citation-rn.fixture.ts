// Test fixture: the renewal citation model as the screen sends it (`citation/standard` variant
// renewal, back/bff/screens/citation.py renewal_vm) for a CitationsLive fixture. The models were
// recorded once from the former client rules and are read from citation-rn.frozen.json (test/frozen.ts).
import type { CitationTypeCategoryRow } from "@/lib/db/repositories/scope-aggregates";
import type { OverviewCardDelta } from "@/lib/kpi/overview-card-values";
import type { CitationsLive } from "@/lib/scope/result-adapter";
import type { CitationSectionDegraded } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { frozen, loadFrozen } from "@/test/frozen";
import type { PrevCategories, RnCitationVm } from "./citation-input";

const TABLE = loadFrozen(new URL("./citation-rn.frozen.json", import.meta.url));

export function rnVmFor(
  ...args: [
    p: {
      live: CitationsLive | null;
      prev: PrevCategories;
      card: OverviewCardDelta | null;
      typeRows: CitationTypeCategoryRow[] | null;
      sections: CitationSectionDegraded | null;
      search?: string;
    },
  ]
): RnCitationVm | null {
  return frozen(TABLE, "rnVmFor", args);
}
