import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { EntityListing, EntityRow } from "./entity-roles-api";
import {
  ALL,
  DEFAULT_ENTITY_FILTER,
  changesOwn,
  draftChanged,
  draftNeedsWrite,
  entityCounts,
  entityFilterToQuery,
  entityMatches,
  highlightParts,
  initialDraft,
  queryToEntityFilter,
  roleProblems,
  sortEntities,
} from "./entity-roles-model";

// Admin › 엔티티 카탈로그 (2026-11-02): the list as first rendered (Gold's values next to the HUB's role, no reflection
// state, no draft or preview), the role form's rules and the pure filter model.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/ko/renewal/admin/standards/entities",
}));

const { EntityRolesManager } = await import("./entity-roles-manager");
const { EntityRoleForm, EntitySheet } = await import("./entity-role-sheet");

const html = (ui: ReactElement, locale: "ko" | "en" = "ko") =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      {ui}
    </NextIntlClientProvider>,
  );
const rowOf = (out: string, key: string) => {
  const from = out.indexOf(`data-hub-entity-row="${key}"`);
  return out.slice(from, out.indexOf("</tr>", from));
};
const keysOf = (out: string) => [...out.matchAll(/data-hub-entity-row="([^"]+)"/g)].map(([, k]) => k);

const entity = (over: Partial<EntityRow>): EntityRow => ({
  entityId: "bmw",
  name: "BMW",
  type: "Brand",
  displayBrand: "BMW",
  kind: "competitor",
  firstSeen: "2026-07-03T00:00:00Z",
  answers: 107817,
  mentions: 294581,
  role: "competitor",
  brand: null,
  hub: null,
  gold: { role: null, brand: null },
  state: null,
  ...over,
});
const hub = (over: Partial<NonNullable<EntityRow["hub"]>> = {}) => ({ role: "own" as const, brand: "Hyundai" as const, note: null, status: "active" as const, origin: "gold_import" as const, updatedAt: "2026-11-02T05:00:00Z", ...over });
const HYUNDAI = entity({ entityId: "hyundai", name: "Hyundai", displayBrand: "Hyundai", kind: "own", answers: 273895, mentions: 1205447, role: "own", brand: "Hyundai", hub: hub(), gold: { role: "own", brand: "Hyundai" }, state: "applied" });
const LISTING: EntityListing = {
  published: { version: 1, items: 19, changeSeq: 57200, recordedAt: "2026-11-02T05:00:00Z" },
  items: [
    HYUNDAI,
    entity({}),
    entity({ entityId: "apple", name: "Apple", displayBrand: "Apple", kind: "nonCompetitor", answers: 36111, mentions: 47271, role: "excluded", hub: hub({ role: "excluded", brand: null as never }), gold: { role: null, brand: null }, state: "pending" }),
    entity({ entityId: "alias", name: "현대자동차", displayBrand: "Hyundai", kind: "own", answers: 12, mentions: 20, role: "own", brand: "Hyundai", gold: { role: "own", brand: "Hyundai" }, state: "upstream" }),
  ],
};

describe("EntityRolesManager", () => {
  const out = html(<EntityRolesManager initial={LISTING} savedFilters={{ page: "entity-roles", userId: "u", initial: [] }} />);

  it("lists Gold's entities by answers with the HUB's role", () => {
    expect(keysOf(out)).toEqual(["hyundai", "bmw", "apple", "alias"]);
    expect(out).toContain("업스트림 목록 v1 · 19건");
    expect(out).toContain("entity_role");
    expect(out).toContain("4 / 4개 · 자사 2 · 제외 1");
  });

  it("keeps saved filters in the filter panel, as the other admin lists (last review 2026-11-02, F7)", () => {
    expect(out).toContain(ko.renewal.saved.empty);
  });

  it("shows each kind of row", () => {
    expect(rowOf(out, "hyundai")).toContain("자사 · Hyundai");
    expect(rowOf(out, "hyundai")).toContain("273,895");
    expect(rowOf(out, "bmw")).toContain('data-hub-entity-role="competitor"');
    expect(rowOf(out, "bmw")).toContain("2026-07-03");
    expect(rowOf(out, "apple")).toContain("비경쟁"); // Gold's kind, as it is
    expect(rowOf(out, "apple")).toContain("제외");
  });

  it("never says whether a role reached the numbers, and has no draft or preview", () => {
    for (const gone of ["반영 대기", "반영됨", "data-hub-entity-state"]) expect(out).not.toContain(gone);
    for (const word of ["초안", "미리보기", "승인"]) expect(out).not.toContain(word);
  });

  it("renders in English too", () => {
    expect(html(<EntityRolesManager initial={LISTING} savedFilters={{ page: "entity-roles", userId: "u", initial: [] }} />, "en")).toContain("Own · Hyundai");
  });

  // Service week check (2026-11-02): Gold's first_seen is a timestamp; its first 10 characters are the UTC day, so an
  // entity first seen on 10-12 08:32 KST read as 10-11 — inside the 10/5~10/11 week.
  it("shows first seen as the KST day, in the list and in the sheet", () => {
    const late = entity({ entityId: "late", name: "Late", firstSeen: "2026-10-11T23:32:00Z" });
    const out = html(<EntityRolesManager initial={{ ...LISTING, items: [late] }} savedFilters={{ page: "entity-roles", userId: "u", initial: [] }} />);
    expect(rowOf(out, "late")).toContain("2026-10-12");
    expect(rowOf(out, "late")).not.toContain("2026-10-11");
    const sheet = html(<EntitySheet row={late} onSaved={() => {}} />);
    expect(sheet).toContain("2026-10-12");
    expect(sheet).not.toContain("2026-10-11");
  });

  it("has every message in both languages", () => {
    const shape = (o: unknown): unknown => (typeof o === "object" && o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : "");
    expect(shape(en.hubEntities)).toEqual(shape(ko.hubEntities));
  });
});

describe("EntityRoleForm and sheet", () => {
  it("opens on the row's role, the brand picks only for own", () => {
    const own = html(<EntityRoleForm row={HYUNDAI} onSaved={() => {}} />);
    expect(own).toContain("data-hub-entity-brands");
    expect(own).toContain('aria-checked="true"');
    const other = html(<EntityRoleForm row={entity({})} onSaved={() => {}} />);
    expect(other).not.toContain("data-hub-entity-brands");
    expect(other).not.toContain("data-hub-entity-note"); // competitor is no stored role: nothing to note
    expect(other).toContain("기본값");
  });

  it("does not ask for a confirmation before anything changes", () => {
    expect(html(<EntityRoleForm row={HYUNDAI} onSaved={() => {}} />)).not.toContain("data-hub-entity-confirm");
  });

  it("shows Gold's values and no draft flow", () => {
    const out = html(<EntitySheet row={HYUNDAI} onSaved={() => {}} />);
    expect(out).toContain('data-hub-entity-detail="hyundai"');
    expect(out).toContain("답변 273,895 · 언급 1,205,447");
    expect(out).toContain("Gold 명부에서 가져옴");
    expect(out).not.toContain("미리보기");
  });
});

describe("role rules", () => {
  const COMPETITOR = entity({});
  const UPSTREAM = entity({ gold: { role: "excluded", brand: null }, role: "excluded", state: "upstream" });

  it("starts from the row, and an own pick from Gold's own display brand", () => {
    expect(initialDraft(HYUNDAI)).toEqual({ role: "own", brand: "Hyundai", note: "" });
    expect(initialDraft(entity({ displayBrand: "Kia", kind: "own" })).brand).toBe("Kia");
    expect(initialDraft(COMPETITOR).brand).toBeNull();
    expect(initialDraft(entity({ role: "excluded", hub: hub({ role: "excluded", note: "메모" }) })).note).toBe("메모");
    expect(initialDraft(entity({ hub: hub({ status: "cleared", note: "옛 메모" }) })).note).toBe("");
  });

  it("knows what changed and what needs a write", () => {
    const d = initialDraft(HYUNDAI);
    expect(draftChanged(HYUNDAI, d)).toBe(false);
    expect(draftChanged(HYUNDAI, { ...d, brand: "Kia" })).toBe(true);
    expect(draftChanged(HYUNDAI, { ...d, note: "메모" })).toBe(true);
    expect(draftChanged(HYUNDAI, { ...d, role: "excluded" })).toBe(true);
    expect(draftChanged(COMPETITOR, { role: "competitor", brand: null, note: "메모" })).toBe(false);
    expect(draftNeedsWrite(HYUNDAI, { ...d, role: "competitor" })).toBe(true);
    expect(draftNeedsWrite(UPSTREAM, { role: "competitor", brand: null, note: "" })).toBe(true); // a role only Gold has
    expect(draftNeedsWrite(COMPETITOR, { role: "competitor", brand: null, note: "" })).toBe(false);
    expect(draftNeedsWrite(entity({ hub: hub({ status: "cleared" }) }), { role: "competitor", brand: null, note: "" })).toBe(false);
  });

  it("checks the input as the BFF does", () => {
    expect(roleProblems({ role: "own", brand: null, note: "" })).toEqual(["brand"]);
    expect(roleProblems({ role: "own", brand: "Kia", note: "" })).toEqual([]);
    expect(roleProblems({ role: "excluded", brand: null, note: "x".repeat(501) })).toEqual(["note"]);
  });

  it("asks for a confirmation only when who is own changes", () => {
    const d = initialDraft(HYUNDAI);
    expect(changesOwn(HYUNDAI, d)).toBe(false);
    expect(changesOwn(HYUNDAI, { ...d, note: "메모" })).toBe(false);
    expect(changesOwn(HYUNDAI, { ...d, brand: "Kia" })).toBe(true);
    expect(changesOwn(HYUNDAI, { ...d, role: "competitor" })).toBe(true);
    expect(changesOwn(COMPETITOR, { role: "own", brand: "Kia", note: "" })).toBe(true);
    expect(changesOwn(COMPETITOR, { role: "excluded", brand: null, note: "" })).toBe(false);
  });

  it("marks the surface in its context", () => {
    expect(highlightParts("the HYUNDAI brand", "Hyundai")).toEqual({ before: "the ", match: "HYUNDAI", after: " brand" });
    expect(highlightParts("the brand", "Hyundai")).toBeNull();
    expect(highlightParts("the brand", null)).toBeNull();
  });
});

describe("filters", () => {
  const rows = LISTING.items;
  const keys = (f: typeof DEFAULT_ENTITY_FILTER, q = "") => rows.filter((r) => entityMatches(r, f, q)).map((r) => r.entityId);

  it("filters on each axis and searches the name and display brand", () => {
    const f = DEFAULT_ENTITY_FILTER;
    expect(keys({ ...f, role: "competitor" })).toEqual(["bmw"]);
    expect(keys({ ...f, role: "own" })).toEqual(["hyundai", "alias"]);
    expect(keys({ ...f, brand: "Hyundai" })).toEqual(["hyundai", "alias"]);
    expect(keys({ ...f, kind: "nonCompetitor" })).toEqual(["apple"]);
    expect(keys(f, " hyundai ")).toEqual(["hyundai", "alias"]); // the alias through its display brand
    expect(keys(f, "현대")).toEqual(["alias"]);
  });

  it("sorts and counts", () => {
    expect(sortEntities(rows, "answers", false, "ko").map((r) => r.entityId)).toEqual(["hyundai", "bmw", "apple", "alias"]);
    expect(sortEntities(rows, "mentions", true, "ko")[0].entityId).toBe("alias");
    expect(sortEntities(rows, "name", true, "ko")[0].name).toBe("현대자동차"); // the Korean collation
    expect(entityCounts(rows)).toEqual({ total: 4, own: 2, excluded: 1 });
  });

  it("mirrors the filter in the URL", () => {
    const filters = { ...DEFAULT_ENTITY_FILTER, role: "own", kind: "nonCompetitor" };
    expect(queryToEntityFilter(entityFilterToQuery(filters, " kia "))).toEqual({ filters, search: "kia" });
    expect(entityFilterToQuery(DEFAULT_ENTITY_FILTER, "")).toBe("");
    expect(queryToEntityFilter("role=nope&state=x").filters).toEqual({ ...DEFAULT_ENTITY_FILTER, role: ALL });
  });
});
