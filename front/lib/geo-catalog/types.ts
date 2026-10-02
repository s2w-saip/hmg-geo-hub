// Schema for the Web GEO catalog — HMG brand × region × country × language ×
// website. Sourced from webgeo_final_list.xlsx ("Web GEO Final" sheet, 218
// rows). One GeoEntry = a brand's localized site for a (region, country,
// language); a country can have several entries (e.g. Canada en/fr).

export type GeoBrand = "Hyundai" | "Genesis" | "Kia";
export type GeoConfidence = "HIGH" | "MED" | "X-추정";

export interface GeoEntry {
  /** Source row number (No column); null if blank. */
  no: number | null;
  /** One of GeoBrand in practice, kept as string for forward-compat. */
  brand: string;
  /** Continental region grouping (North America / Asia / Europe / …). */
  region: string;
  country: string;
  /** Original locale tag, e.g. "es_MX" (Language 원본). */
  languageTag: string | null;
  /** Measured body language, e.g. "es" (Language 실측·본문). */
  language: string | null;
  /** Language-detection confidence (HIGH / MED / X-추정). */
  confidence: GeoConfidence | null;
  /** Normalized final URL. */
  url: string | null;
  note: string | null;
}

// ── Derived Brand ▸ Region ▸ Country ▸ entries hierarchy ──────────────────
export interface GeoCountryNode {
  country: string;
  /** ISO 3166-1 alpha-2 code (matches scope_answers.region); null for placeholders. */
  code: string | null;
  /** Every language/URL variant for this brand+region+country. */
  entries: GeoEntry[];
}
export interface GeoRegionNode {
  region: string;
  countries: GeoCountryNode[];
}
export interface GeoBrandNode {
  brand: string;
  regions: GeoRegionNode[];
}

/** Optional filter for the catalog accessors. */
export type GeoFilter = { brand?: string; region?: string; country?: string };
