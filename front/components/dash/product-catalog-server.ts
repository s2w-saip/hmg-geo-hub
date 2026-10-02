import "server-only";
import { trackedVehicleRepository } from "@/lib/db/repositories/tracked-entities";
import type { ProductRow } from "./product-catalog";

// 2026-06-10 (D3): live product catalog source. `tracked_vehicles` is per-
// project; we DISTINCT across the workspace via the repository so the
// dashboard product filter reflects every brand/segment/model currently being
// tracked anywhere. When HMG ships a dedicated customer product table, swap
// the repository method's SELECT target — the `ProductRow` shape stays the
// same so the panel needs no changes.
//
// Today (table empty): returns an empty list, which renders the cascading
// filter as disabled. Another worker will populate placeholder rows; once that
// lands the filter lights up automatically.
export async function fetchProductRows(): Promise<ProductRow[]> {
  return trackedVehicleRepository.listDistinctWorkspace();
}
