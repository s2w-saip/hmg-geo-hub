// Admin › 엔티티 카탈로그 (2026-11-02): filters, sort, URL mirror and the role form's rules, kept pure for the tests. The
// input rules mirror the BFF's (back/bff/hub_stores/entity_roles.py); the BFF decides.
import { ENTITY_ROLES, ENTITY_STATES, GOLD_KINDS, OWN_BRANDS, type EntityRole, type EntityRow, type OwnBrand } from "./entity-roles-api";

export const ALL = "all";

export const ENTITY_AXES = ["role", "brand", "kind", "state"] as const;
export type EntityAxis = (typeof ENTITY_AXES)[number];
export type EntityFilter = Record<EntityAxis, string>;
export const DEFAULT_ENTITY_FILTER: EntityFilter = { role: ALL, brand: ALL, kind: ALL, state: ALL };

export const ENTITY_SORTS = ["answers", "mentions", "name", "firstSeen", "state"] as const;
export type EntitySort = (typeof ENTITY_SORTS)[number];
export const DEFAULT_ENTITY_SORT: { key: EntitySort; asc: boolean } = { key: "answers", asc: false };

export function entityFirstAsc(key: EntitySort): boolean {
  return key === "name" || key === "state";
}

export function entityAxisOptions(axis: EntityAxis): string[] {
  if (axis === "role") return [...ENTITY_ROLES];
  if (axis === "brand") return [...OWN_BRANDS];
  if (axis === "kind") return [...GOLD_KINDS];
  return [...ENTITY_STATES];
}

export function entityMatches(r: EntityRow, f: EntityFilter, search: string): boolean {
  if (f.role !== ALL && r.role !== f.role) return false;
  if (f.brand !== ALL && r.brand !== f.brand) return false;
  if (f.kind !== ALL && r.kind !== f.kind) return false;
  if (f.state !== ALL && r.state !== f.state) return false;
  const q = search.trim().toLowerCase();
  return !q || r.name.toLowerCase().includes(q) || (r.displayBrand ?? "").toLowerCase().includes(q);
}

const STATE_ORDER: Record<string, number> = { pending: 0, upstream: 1, applied: 2 };

export function sortEntities(rows: readonly EntityRow[], key: EntitySort, asc: boolean, locale: string): EntityRow[] {
  const dir = asc ? 1 : -1;
  const compare = (a: EntityRow, b: EntityRow): number => {
    if (key === "answers") return a.answers - b.answers;
    if (key === "mentions") return a.mentions - b.mentions;
    if (key === "firstSeen") return (a.firstSeen ?? "").localeCompare(b.firstSeen ?? "");
    if (key === "state") return (a.state ? STATE_ORDER[a.state] : 9) - (b.state ? STATE_ORDER[b.state] : 9);
    return a.name.localeCompare(b.name, locale);
  };
  return [...rows].sort((a, b) => compare(a, b) * dir || b.answers - a.answers || a.entityId.localeCompare(b.entityId));
}

export function entityCounts(rows: readonly EntityRow[]) {
  return {
    total: rows.length,
    own: rows.filter((r) => r.role === "own").length,
    excluded: rows.filter((r) => r.role === "excluded").length,
    pending: rows.filter((r) => r.state === "pending").length,
    upstream: rows.filter((r) => r.state === "upstream").length,
  };
}

export function entityFilterToQuery(f: EntityFilter, search: string): string {
  const p = new URLSearchParams();
  for (const a of ENTITY_AXES) if (f[a] !== ALL) p.set(a, f[a]);
  if (search.trim()) p.set("q", search.trim());
  return p.toString();
}

export function queryToEntityFilter(q: string | URLSearchParams): { filters: EntityFilter; search: string } {
  const p = typeof q === "string" ? new URLSearchParams(q) : q;
  const pick = (a: EntityAxis) => {
    const v = p.get(a);
    return v && entityAxisOptions(a).includes(v) ? v : ALL;
  };
  return { filters: { role: pick("role"), brand: pick("brand"), kind: pick("kind"), state: pick("state") }, search: p.get("q") ?? "" };
}

export function pickedEntityAxes(f: EntityFilter): EntityAxis[] {
  return ENTITY_AXES.filter((a) => f[a] !== ALL);
}

// ─── role form ───────────────────────────────────────────────────────────────

export const NOTE_MAX = 500;

export interface RoleDraft {
  role: EntityRole;
  brand: OwnBrand | null;
  note: string;
}

/** The form's first values: the row's role; an own pick starts from Gold's display brand when that is an own brand. */
export function initialDraft(r: EntityRow): RoleDraft {
  const fromGold = (OWN_BRANDS as readonly string[]).includes(r.displayBrand ?? "") ? (r.displayBrand as OwnBrand) : null;
  return { role: r.role, brand: r.brand ?? fromGold, note: r.hub?.status === "active" ? (r.hub.note ?? "") : "" };
}

export function draftChanged(r: EntityRow, d: RoleDraft): boolean {
  const start = initialDraft(r);
  if (d.role !== r.role) return true;
  if (d.role === "own" && d.brand !== r.brand) return true;
  return d.role !== "competitor" && d.note.trim() !== start.note.trim();
}

/** Whether saving would ask the HUB to change a role Gold or the HUB already holds, or give one: competitor with no role
 * anywhere has nothing to clear. */
export function draftNeedsWrite(r: EntityRow, d: RoleDraft): boolean {
  if (d.role !== "competitor") return true;
  return r.hub?.status === "active" || (r.hub == null && r.gold?.role != null);
}

export type RoleProblem = "brand" | "note";

export function roleProblems(d: RoleDraft): RoleProblem[] {
  const out: RoleProblem[] = [];
  if (d.role === "own" && !d.brand) out.push("brand");
  if (d.note.trim().length > NOTE_MAX) out.push("note");
  return out;
}

/** A change of who is own moves every KPI's 당사 side once Gold is rebuilt: it asks for a confirmation (the original's L2). */
export function changesOwn(r: EntityRow, d: RoleDraft): boolean {
  if (r.role !== "own" && d.role !== "own") return false;
  return r.role !== d.role || r.brand !== d.brand;
}

// ─── samples ─────────────────────────────────────────────────────────────────

/** The context split around the first case-insensitive match of the surface, to mark it. */
export function highlightParts(context: string, surface: string | null): { before: string; match: string; after: string } | null {
  if (!surface) return null;
  const at = context.toLowerCase().indexOf(surface.toLowerCase());
  if (at < 0) return null;
  return { before: context.slice(0, at), match: context.slice(at, at + surface.length), after: context.slice(at + surface.length) };
}
