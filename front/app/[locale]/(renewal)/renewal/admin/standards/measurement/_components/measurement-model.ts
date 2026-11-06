// Admin › 측정 설정 (T6.3): filters, sort and the URL mirror, kept pure for the tests.
import type { Measurement, MeasurementView } from "../../../../projects/_components/project-measurement";
import { shortId } from "../../../../projects/_components/project-model";

export const ALL = "all";

export interface MeasurementRow {
  projectId: string;
  /** 1 Global, 2 Website, 3 Project */
  surface: number | null;
  name: string | null;
  description: string | null;
  domain: string | null;
  status: string | null;
  measurement: Measurement;
}

export interface MeasurementListing {
  items: MeasurementRow[];
  options: MeasurementView["options"];
  editing: boolean;
}

export const SURFACES = ["1", "2", "3"] as const;
export const OWNED_STATES = ["registered", "unregistered"] as const;
export const MEASUREMENT_AXES = ["surface", "owned", "brand"] as const;
export type MeasurementAxis = (typeof MEASUREMENT_AXES)[number];
export type MeasurementFilter = Record<MeasurementAxis, string>;
export const DEFAULT_MEASUREMENT_FILTER: MeasurementFilter = { surface: ALL, owned: ALL, brand: ALL };

export const MEASUREMENT_SORTS = ["surface", "name", "ownedUrls", "recordedAt"] as const;
export type MeasurementSort = (typeof MEASUREMENT_SORTS)[number];
export const DEFAULT_MEASUREMENT_SORT: { key: MeasurementSort; asc: boolean } = { key: "surface", asc: true };

export function measurementFirstAsc(key: MeasurementSort): boolean {
  return key === "surface" || key === "name";
}

export function measurementAxisOptions(axis: MeasurementAxis, brands: readonly string[]): string[] {
  if (axis === "surface") return [...SURFACES];
  if (axis === "owned") return [...OWNED_STATES];
  return [...brands];
}

/** What 자사 URL 인용 counts on this row (judgments.registered_urls): the owned URLs and, on a website, each unit's base address. Global has no such list: it goes by the perspective's brands. */
export function registeredUrls(row: MeasurementRow): string[] {
  if (row.surface === 1) return [];
  return [...new Set([...row.measurement.ownedUrls, ...row.measurement.webUnits.flatMap((u) => (u.base ? [u.base] : []))])];
}

export function ownedState(row: MeasurementRow): "registered" | "unregistered" | "none" {
  if (row.surface === 1) return "none";
  return registeredUrls(row).length ? "registered" : "unregistered";
}

/** Global has one row; a website is its brand and country; a project is its name, or the short id the other screens show where it has none. */
export function rowName(row: MeasurementRow, labels: { global: string; brand: (code: string) => string; country: (code: string) => string }): string {
  if (row.surface === 1) return labels.global;
  if (row.surface === 2) return [row.measurement.brands.map(labels.brand).join(", "), row.measurement.countries.map(labels.country).join(", ")].filter(Boolean).join(" · ") || shortId(row.projectId);
  return row.name ?? shortId(row.projectId);
}

export function measurementMatches(row: MeasurementRow, name: string, f: MeasurementFilter, search: string): boolean {
  if (f.surface !== ALL && String(row.surface) !== f.surface) return false;
  if (f.owned !== ALL && ownedState(row) !== f.owned) return false;
  if (f.brand !== ALL && !row.measurement.brands.includes(f.brand)) return false;
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const m = row.measurement;
  return [name, row.projectId, row.domain ?? "", ...m.countries, ...m.ownedUrls, ...m.trackedUrls, ...m.webUnits.map((u) => u.base ?? "")].some((v) => v.toLowerCase().includes(q));
}

export function sortMeasurements<T extends { row: MeasurementRow; name: string }>(rows: readonly T[], key: MeasurementSort, asc: boolean, locale: string): T[] {
  const dir = asc ? 1 : -1;
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, locale);
  const compare = (a: T, b: T): number => {
    if (key === "surface") return (a.row.surface ?? 9) - (b.row.surface ?? 9);
    if (key === "ownedUrls") return registeredUrls(a.row).length - registeredUrls(b.row).length;
    if (key === "recordedAt") return (a.row.measurement.recordedAt ?? "").localeCompare(b.row.measurement.recordedAt ?? "");
    return byName(a, b);
  };
  return [...rows].sort((a, b) => dir * compare(a, b) || byName(a, b));
}

export function unregisteredCount(rows: readonly MeasurementRow[]): number {
  return rows.filter((r) => ownedState(r) === "unregistered").length;
}

export function measurementFilterToQuery(f: MeasurementFilter, search: string): string {
  const p = new URLSearchParams();
  for (const a of MEASUREMENT_AXES) if (f[a] !== ALL) p.set(a, f[a]);
  if (search.trim()) p.set("q", search.trim());
  return p.toString();
}

export function queryToMeasurementFilter(q: string | URLSearchParams, brands: readonly string[]): { filters: MeasurementFilter; search: string } {
  const p = typeof q === "string" ? new URLSearchParams(q) : q;
  const pick = (a: MeasurementAxis) => {
    const v = p.get(a);
    return v && measurementAxisOptions(a, brands).includes(v) ? v : ALL;
  };
  return { filters: { surface: pick("surface"), owned: pick("owned"), brand: pick("brand") }, search: p.get("q") ?? "" };
}

export function pickedMeasurementAxes(f: MeasurementFilter): MeasurementAxis[] {
  return MEASUREMENT_AXES.filter((a) => f[a] !== ALL);
}
