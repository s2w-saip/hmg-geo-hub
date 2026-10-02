// Product dimension — the HMG vehicle hierarchy.
//
// 2026-06-10 (D3): the catalog is sourced from the DB `tracked_vehicles` table
// (lib/db/repositories/tracked-entities) rather than the previous hard-coded
// placeholder rows. Server pages call `fetchProductRows()` (see
// product-catalog-server.ts) and pass the result into `<ProductFilter rows={…}>`.
//
// ⚠️ DROP-IN POINT — when HMG ships a dedicated customer product table, swap the
// fetcher's SELECT target inside product-catalog-server.ts. The shape stays the
// same (`ProductRow`), so this client module and the filter UI are unaffected.
// Until then the live tracked_vehicles content drives the dropdowns; an empty
// table renders an empty (disabled) filter — by design.
//
// Brand is the authorization context (admin switches it; everyone else is locked
// to their scope brand), NOT a facet — the filter applies from Segment down.

export type ProductLevel = "segment" | "model";
export const PRODUCT_LEVELS: ProductLevel[] = ["segment", "model"];

// URL param key per level (illustrative — ignored by the scope query mapping).
export const PRODUCT_PARAM: Record<ProductLevel, string> = {
  segment: "pSegment",
  model: "pModel",
};
export const PRODUCT_BRAND_PARAM = "pBrand";

// One catalog row mirrors the customer product table's unit. `powertrain` is
// optional model metadata (e.g. Gasoline/Hybrid/EV), NOT a filter level.
// segment is nullable to match `tracked_vehicles.segment` (some projects ship
// vehicles without a segment tag).
export type ProductRow = {
  brand: string;
  segment: string | null;
  model: string;
  powertrain?: string;
};

const uniq = (a: string[]): string[] => [...new Set(a)];

// Empty `brands` → all (e.g. admin "전체" or a multi-brand scope).
function rowsFor(rows: ProductRow[], brands: string[]): ProductRow[] {
  return brands.length ? rows.filter((r) => brands.includes(r.brand)) : rows;
}

export function productBrands(rows: ProductRow[]): string[] {
  return uniq(rows.map((r) => r.brand));
}

// Cascading option resolution — each level's options are derived from the rows
// matching the chosen ancestors (brand context, then selected segments).
export function segmentOptions(rows: ProductRow[], brands: string[]): string[] {
  return uniq(
    rowsFor(rows, brands)
      .map((r) => r.segment)
      .filter((s): s is string => Boolean(s)),
  );
}

export function modelOptions(
  rows: ProductRow[],
  brands: string[],
  segments: string[],
): string[] {
  return uniq(
    rowsFor(rows, brands)
      .filter((r) => !segments.length || (r.segment && segments.includes(r.segment)))
      .map((r) => r.model),
  );
}
