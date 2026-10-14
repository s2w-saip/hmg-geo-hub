import { beforeEach, describe, expect, it, vi } from "vitest";
import { HghApiError } from "@/lib/hgh/errors";
import type { components } from "@/lib/hgh/api-types";
import { toEntityRow } from "@/lib/hgh/adapters/admin";
import * as ecat from "@/lib/hgh/adapters/admin-entities";
import { draftChangeCount } from "./_ecat-data";
import { EntityCatalog } from "./_components/entity-catalog";
import { EntityManager } from "./_components/entity-manager";
import { DraftBar } from "./_components/draft-bar";
import { DraftPanel } from "./_components/draft-panel";
import { AuditLog } from "./_components/audit-log";
import { EcatShell } from "./_components/ecat-shell";
import { Notice } from "./_components/ecat-shared";
import EntitiesPage from "./page";
import DraftPage from "./draft/page";
import AuditPage from "./audit/page";

// Entity main, draft and audit pages (B084 follow-up): the gate reads the version numbers only
// (versions?view=gate: no version rows, per-row counts or last applies). The pages use activeVer/draftVer
// only, so the values the screens get stay the same; the reads, round trips and failure paths are as before.
// The page components are mocked: the tests read the props of the elements the pages return.

type EntityRow = components["schemas"]["EntityRow"];

const m = vi.hoisted(() => ({
  listVersions: vi.fn(),
  listVersionNumbers: vi.fn(),
  listEntityRows: vi.fn(),
  getVersion: vi.fn(),
  getVersionDiff: vi.fn(),
  listAudit: vi.fn(),
  rounds: [] as string[][],
  inflight: 0,
}));

/** A mocked backend read: calls that start while another read is in flight share a round trip. */
function read<T>(name: string, value: () => T | Promise<T>): Promise<T> {
  if (m.inflight === 0) m.rounds.push([]);
  m.rounds[m.rounds.length - 1].push(name);
  m.inflight += 1;
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      m.inflight -= 1;
      Promise.resolve().then(value).then(resolve, reject);
    }, 0);
  });
}

vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key, setRequestLocale: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => ({ user: { role: "admin" } }) }));
vi.mock("@/lib/auth/scope-policy", () => ({ canAccessAdmin: () => true }));
vi.mock("@/lib/db/repositories/entity-registry", () => ({ listDiscoveredBrands: vi.fn() }));
vi.mock("@/lib/hgh/adapters/admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hgh/adapters/admin")>()),
  isAdminApi: () => true,
}));
vi.mock("@/lib/hgh/adapters/admin-entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hgh/adapters/admin-entities")>()),
  listVersions: m.listVersions,
  listVersionNumbers: m.listVersionNumbers,
  listEntityRows: m.listEntityRows,
  getVersion: m.getVersion,
  getVersionDiff: m.getVersionDiff,
  listAudit: m.listAudit,
}));
vi.mock("./_components/entity-catalog", () => ({ EntityCatalog: () => null }));
vi.mock("./_components/entity-manager", () => ({ EntityManager: () => null }));
vi.mock("./_components/draft-bar", () => ({ DraftBar: () => null }));
vi.mock("./_components/draft-panel", () => ({ DraftPanel: () => null }));
vi.mock("./_components/audit-log", () => ({ AuditLog: () => null }));
vi.mock("./_components/ecat-shell", () => ({ EcatShell: () => null }));
vi.mock("./_components/ecat-shared", () => ({ EcatNav: () => null, Notice: () => null }));

type El = { type: unknown; props: Record<string, unknown> };
function find(node: unknown, type: unknown): El[] {
  const out: El[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object" && "props" in n) {
      const el = n as El;
      if (el.type === type) out.push(el);
      walk(el.props.children);
    }
  };
  walk(node);
  return out;
}
const one = (node: unknown, type: unknown) => {
  const els = find(node, type);
  expect(els).toHaveLength(1);
  return els[0].props;
};

const entity = (i: number, own: string | null): EntityRow => ({
  entity_id: `00000000-0000-4000-8000-00000000000${i}`, entity_type: "Brand", name: `Brand ${i}`, brand_name: `Brand ${i}`,
  role: i === 1 ? "own" : "competitor", brand_code: i === 1 ? "HYUNDAI" : null, registered: i === 1, answers: 10 - i,
  mentions: 20 - i, updated_at: null, own_brand: own,
});
const FULL = [entity(1, "Hyundai"), entity(2, "Hyundai"), entity(3, null)];

const summary = (ver: number, status: "active" | "draft") => ({
  ver, status, title: `v${ver}`, reason: null, origin: "manual", basedOn: null, createdAt: "2026-10-01T00:00:00Z", createdBy: "a",
  activatedAt: null, retiredAt: null, submittedAt: null, entityRows: 1, surfaceRows: 0, lastApply: null,
});
const override = (id: string, role: string, own: string | null) => ({
  entityId: id, origin: "scope", role, name: null, repName: "Brand", entityType: "Brand", brandCode: null, brandName: null,
  mergeInto: null, parentBrandId: null, note: null, observed: true, updatedAt: null, effectiveOwnBrand: own,
});
const ACTIVE = { version: summary(3, "active"), contentMd5: "a", entities: [override(FULL[0].entity_id, "own", "Hyundai")], surfaces: [], lint: null } as unknown as ecat.VersionDetailView;
const DRAFT = { version: summary(4, "draft"), contentMd5: "d", entities: [override(FULL[0].entity_id, "own", "Hyundai"), override(FULL[2].entity_id, "hidden", null)], surfaces: [], lint: null } as unknown as ecat.VersionDetailView;

function backend(gate: { activeVer: number | null; draftVer: number | null } | Error, list?: Error) {
  m.listVersionNumbers.mockImplementation(() => read("versions?view=gate", () => {
    if (gate instanceof Error) throw gate;
    return { ...gate, items: [] };
  }));
  m.listVersions.mockImplementation(() => read("versions", () => {
    if (gate instanceof Error) throw gate;
    return { ...gate, items: [] };
  }));
  m.listEntityRows.mockImplementation((opts: { fields?: "names" } = {}) => read(opts.fields ? `entities?fields=${opts.fields}` : "entities", () => {
    if (list) throw list;
    return FULL;
  }));
  m.getVersion.mockImplementation((ver: number) => read(`versions/${ver}`, () => (ver === 3 ? ACTIVE : DRAFT)));
  m.getVersionDiff.mockImplementation((ver: number) => read(`versions/${ver}/diff`, () => ({ version: summary(ver, "draft"), against: 3, entities: [], surfaces: [] })));
  m.listAudit.mockImplementation(() => read("audit", () => []));
}

const input = () => ({ params: Promise.resolve({ locale: "ko" }) });
const withSearch = () => ({ ...input(), searchParams: Promise.resolve({}) });

beforeEach(() => {
  for (const fn of [m.listVersions, m.listVersionNumbers, m.listEntityRows, m.getVersion, m.getVersionDiff, m.listAudit]) fn.mockReset();
  m.rounds = [];
  m.inflight = 0;
});

describe("entity main page: light gate, list and gate read together as before", () => {
  it("version list: numbers and the full list together, then both version details (two round trips, four calls)", async () => {
    backend({ activeVer: 3, draftVer: 4 });
    const page = await EntitiesPage(input());
    expect(m.rounds).toEqual([["versions?view=gate", "entities"], ["versions/3", "versions/4"]]);
    expect(m.listVersions).not.toHaveBeenCalled();
    expect(m.listEntityRows.mock.calls).toEqual([[]]);
    const rows = ecat.mergeEntityRows(FULL, ACTIVE, DRAFT);
    expect(one(page, EntityManager)).toMatchObject({ rows, activeVer: 3, draftVer: 4 });
    expect(rows.map((r) => r.activeOwnBrand)).toEqual(["Hyundai", "Hyundai", null]);
    expect(one(page, DraftBar)).toEqual({ activeVer: 3, draftVer: 4, draftTitle: "v4", changes: draftChangeCount(rows, ACTIVE, DRAFT) });
  });

  it("version list without a draft: the active detail only", async () => {
    backend({ activeVer: 3, draftVer: null });
    const page = await EntitiesPage(input());
    expect(m.rounds).toEqual([["versions?view=gate", "entities"], ["versions/3"]]);
    expect(one(page, EntityManager)).toMatchObject({ rows: ecat.mergeEntityRows(FULL, ACTIVE, null), draftVer: null });
  });

  it.each([
    ["no active version", { activeVer: null, draftVer: null }],
    ["versions endpoint not deployed (404)", new HghApiError(404, "not_found")],
  ])("before the cutover (%s): the role editor with the list rows", async (_, gate) => {
    backend(gate);
    const page = await EntitiesPage(input());
    expect(m.rounds).toEqual([["versions?view=gate", "entities"]]);
    expect(one(page, EntityCatalog)).toEqual({ rows: FULL.map(toEntityRow), source: "api" });
    expect(find(page, EntityManager)).toHaveLength(0);
  });

  it("versions unreadable (5xx): the notice and an empty catalog", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      backend(new HghApiError(503, "unavailable"));
      const page = await EntitiesPage(input());
      expect(one(page, Notice)).toMatchObject({ tone: "danger", children: "page.unavailable" });
      expect(one(page, EntityCatalog)).toEqual({ rows: [], source: "api" });
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["version list", { activeVer: 3, draftVer: 4 }],
    ["pre-cutover editor", { activeVer: null, draftVer: null }],
    ["versions unreadable too", new HghApiError(503, "unavailable")],
  ])("a failed list read still reaches the error boundary (%s)", async (_, gate) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failure = new HghApiError(503, "unavailable");
      backend(gate, failure);
      await expect(EntitiesPage(input())).rejects.toBe(failure);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("entity draft and audit pages: light gate", () => {
  it("draft page: numbers, then the draft detail and its diff", async () => {
    backend({ activeVer: 3, draftVer: 4 });
    const page = await DraftPage(input());
    expect(m.rounds).toEqual([["versions?view=gate"], ["versions/4", "versions/4/diff"]]);
    expect(m.listVersions).not.toHaveBeenCalled();
    expect(one(page, EcatShell).gate).toEqual({ kind: "ready", versions: { activeVer: 3, draftVer: 4, items: [] } });
    expect(one(page, DraftPanel)).toMatchObject({ version: DRAFT.version, lint: null, globalBlocks: [] });
  });

  it("draft page without a draft: the draft bar with the active number", async () => {
    backend({ activeVer: 3, draftVer: null });
    const page = await DraftPage(input());
    expect(m.rounds).toEqual([["versions?view=gate"]]);
    expect(one(page, DraftBar)).toEqual({ activeVer: 3, draftVer: null, showOpen: false });
  });

  it("audit page: numbers, then one audit page", async () => {
    backend({ activeVer: 3, draftVer: null });
    const page = await AuditPage(withSearch());
    expect(m.rounds).toEqual([["versions?view=gate"], ["audit"]]);
    expect(m.listVersions).not.toHaveBeenCalled();
    expect(m.listAudit).toHaveBeenCalledWith({ beforeId: null, limit: 100 });
    expect(one(page, AuditLog)).toEqual({ items: [], limit: 100, beforeId: null });
  });

  it.each([
    ["precutover", { activeVer: null, draftVer: null }],
    ["unavailable", new HghApiError(502, "upstream")],
  ] as const)("not ready (%s): the shell notice only", async (kind, gate) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      backend(gate);
      for (const page of [await DraftPage(input()), await AuditPage(withSearch())]) {
        expect(one(page, EcatShell).gate).toEqual({ kind });
      }
      expect(m.listVersions).not.toHaveBeenCalled();
      expect(m.getVersion).not.toHaveBeenCalled();
      expect(m.listAudit).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
