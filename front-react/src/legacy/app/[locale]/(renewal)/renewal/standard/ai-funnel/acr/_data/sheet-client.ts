// Browser read of one 분포 sheet of the renewal ACR page: GET /api/standard/acr/sheet, a thin proxy to the
// screen acr/renewal-sheet, with the page's URL params (the filters the view was built from).
import type { AcrDistSheet } from "./screen-types";

export async function fetchAcrSheet(search: string, key: string): Promise<AcrDistSheet | null> {
  const qs = new URLSearchParams(search);
  qs.set("sheet", key);
  const res = await fetch(`/api/standard/acr/sheet?${qs}`, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`ACR sheet read failed (${res.status})`);
  return ((await res.json()) as { sheet: AcrDistSheet | null }).sheet;
}
