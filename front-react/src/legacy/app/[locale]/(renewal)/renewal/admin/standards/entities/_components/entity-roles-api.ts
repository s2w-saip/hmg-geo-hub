// Admin › 엔티티 카탈로그 (2026-11-02): the shapes the BFF answers (back/bff/hub_stores/entity_roles.py) and the browser's
// calls through /api/hub/entity-roles. The HUB owns the roles (admin-todo decisions A · F); the entities, their display
// brand and their numbers are Gold's and only read.
import { call, type ListEvent, type ListPublished } from "../../citation-sources/_components/source-lists-api";

export const OWN_BRANDS = ["Hyundai", "Kia", "Genesis"] as const;
export type OwnBrand = (typeof OWN_BRANDS)[number];

/** competitor is the default: it is not stored, a row back to it is cleared. */
export const ENTITY_ROLES = ["own", "competitor", "excluded"] as const;
export type EntityRole = (typeof ENTITY_ROLES)[number];

/** gold.dim_brand.kind of the display brand. */
export const GOLD_KINDS = ["own", "competitor", "nonCompetitor"] as const;
export type GoldKind = (typeof GOLD_KINDS)[number];

/** The BFF's comparison with Gold, not shown: no screen says whether an input reached the numbers (user 2026-11-06). */
export type EntityState = "applied" | "pending" | "upstream";

export interface EntityHubRole {
  role: "own" | "excluded";
  brand: OwnBrand | null;
  note: string | null;
  status: "active" | "cleared";
  origin: "gold_import" | "hub";
  updatedAt: string | null;
}

export interface EntityRow {
  entityId: string;
  name: string;
  /** Gold's entity_type (often empty) */
  type: string | null;
  displayBrand: string | null;
  kind: GoldKind | null;
  firstSeen: string | null;
  /** all time, Gold entity_mention_total */
  answers: number;
  mentions: number;
  /** what the row means now: the HUB's active role, else Gold's, else competitor */
  role: EntityRole;
  brand: OwnBrand | null;
  hub: EntityHubRole | null;
  gold: { role: "own" | "excluded" | null; brand: string | null } | null;
  state: EntityState | null;
}

export interface EntityListing {
  items: EntityRow[];
  published: ListPublished | null;
}

export interface EntityMentionSample {
  answerKey: number;
  round: string;
  surface: string | null;
  context: string;
  sentiment: string | null;
  mentionRole: string | null;
}

export interface EntityMentions {
  entityId: string;
  /** how many latest global rounds were searched */
  rounds: number;
  /** months: how many months the surface was observed in (Gold keeps no count per surface) */
  surfaces: { surface: string; months: number }[];
  samples: EntityMentionSample[];
}

export interface EntityHistory {
  entityId: string | null;
  history: ListEvent[];
}

export interface EntityWritten {
  entityId: string;
  published: { version: number; changeSeq: number } | null;
}

export const entityRoleApi = {
  list: () => call<EntityListing>("entity-roles", ""),
  history: (entity?: string) => call<EntityHistory>("entity-roles", entity ? `/history?entity=${encodeURIComponent(entity)}` : "/history"),
  mentions: (entity: string) => call<EntityMentions>("entity-roles", `/mentions?entity=${encodeURIComponent(entity)}`),
  set: (input: { entityId: string; role: "own" | "excluded"; brand: OwnBrand | null; note: string | null }) => call<EntityWritten>("entity-roles", "", "POST", input),
  clear: (entityId: string) => call<EntityWritten>("entity-roles", "/clear", "POST", { entityId }),
};
