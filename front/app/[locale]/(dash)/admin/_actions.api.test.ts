import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// api source (HGH_SOURCE_G7=api) of the admin server actions (U11). The legacy tests next to
// this file mock the legacy repositories and stay as they are; here the same repositories are
// mocked as spies to prove the api source never touches them, keeps the admin gate first, and
// sends each action to its /v1/admin operation. Result parity with legacy is in
// lib/hgh/adapters/admin.parity.test.ts.

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join: j } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(j(root, "cjs", "react.react-server.development.js"));
});
const legacy = vi.hoisted(() => ({ calls: [] as string[] }));
const spy = (name: string) => () => {
  legacy.calls.push(name);
  throw new Error(`legacy ${name} must not run on the api source`);
};
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/audit", () => ({ auditDataAccess: vi.fn() }));
vi.mock("@/lib/db/repositories/profiles", () => ({
  profileRepository: new Proxy({}, { get: (_t, k) => spy(`profiles.${String(k)}`) }),
}));
vi.mock("@/lib/db/repositories/project-members", () => ({
  projectMemberRepository: new Proxy({}, { get: (_t, k) => spy(`members.${String(k)}`) }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  adminCreateUser: spy("supabase.create"),
  adminDeleteUser: spy("supabase.delete"),
  generateTempPassword: () => "unused",
}));
vi.mock("@/lib/db/repositories/entity-registry", () => ({
  entityRegistryRepository: new Proxy({}, { get: (_t, k) => spy(`registry.${String(k)}`) }),
}));
vi.mock("@/lib/db/repositories/citation-overrides", () => ({
  citationOverrideRepository: new Proxy({}, { get: (_t, k) => spy(`overrides.${String(k)}`) }),
}));
vi.mock("@/lib/db/repositories/ga4-properties", () => ({
  ga4PropertyRepository: new Proxy({}, { get: (_t, k) => spy(`ga4.${String(k)}`) }),
}));
vi.mock("@/lib/ga4/client", () => ({ runReport: spy("ga4.runReport"), dateNDaysAgo: () => ({ start: "", end: "" }) }));
vi.mock("@/lib/scope/server", () => ({
  MIRROR_AGGREGATE_TAG: "m",
  updateRootPrompt: spy("scope.updateRootPrompt"),
  createRootPrompt: spy("scope.createRootPrompt"),
  getProject: spy("scope.getProject"),
}));

const { getSession } = await import("@/lib/auth/session");
const { UnauthorizedError } = await import("@/lib/auth/errors");
const { bindHghAuth } = await import("@/lib/hgh/auth");
const users = await import("./_actions");
const standards = await import("./standards/_actions");
const entities = await import("./standards/entities/_actions");
const citations = await import("./standards/citation-sources/_actions");
const ga4 = await import("./ga4/_actions");

const U = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhIn0.c2ln";
const ADMIN = { user: { id: U(1), email: "a@t.test", role: "admin", scope: { all: true }, operator: "global", menuGroups: null } };
const REGION = { user: { id: U(2), email: "r@t.test", role: "region", scope: { all: false, regions: ["EU"] }, operator: "none", menuGroups: null } };

let sent: string[] = [];
beforeEach(() => {
  sent = [];
  legacy.calls = [];
  vi.stubEnv("HGH_SOURCE_G7", "api");
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => null });
  vi.mocked(getSession).mockResolvedValue(ADMIN as never);
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    sent.push(`${init.method ?? "GET"} ${url.pathname}`);
    const data =
      url.pathname === "/v1/admin/users" && init.method === "POST"
        ? { email: "n@t.test", temp_password: "pw" }
        : url.pathname.endsWith("/export")
          ? null
          : { prompt: { prompt_id: U(9) }, keyword_id: U(8), source_id: U(7), verified: true, updated: 1, unchanged: 0, failed: [] };
    return new Response(JSON.stringify({ data, meta: { mode: "crud" } }), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  bindHghAuth(null);
});

describe("admin actions on the api source", () => {
  it("each action goes to its backend operation and never to the legacy repositories", async () => {
    const fd = new FormData();
    fd.set("email", "n@t.test");
    fd.set("role", "hq");
    fd.set("scopeAll", "true");
    const scope = { scopeAll: true, brands: null, regions: null, countries: null };
    const results = [
      await users.createUser(fd),
      await users.updateUserProfile(U(3), { role: "hq", operator: "none", scope }, 2),
      await users.deleteUser(U(3)),
      await standards.setStandardPromptKind(U(4), "acr"),
      await standards.updateStandardPromptText(U(4), "t"),
      await standards.updateStandardPromptLabels(U(4), { depth1: "d" }),
      await standards.updateStandardPromptRegions(U(4), { regions: ["KR"] }),
      await standards.bulkSetStandardPromptRegions([U(4)], null),
      await standards.softDeleteStandardPrompt(U(4)),
      await standards.restoreStandardPrompt(U(4)),
      await standards.createStandardPrompt({ text: "new" }),
      await standards.createStandardKeyword({ term: "k", sourceType: "google_keyword" }),
      await standards.toggleStandardKeywordEnabled(U(8), false),
      await standards.deleteStandardKeyword(U(8)),
      await standards.createStandardSource({ url: "https://s.test", channel: "news" }),
      await standards.toggleStandardSourceEnabled(U(7), true),
      await standards.deleteStandardSource(U(7)),
      await entities.setEntityRole(U(5), "Kia", "own", "Kia"),
      await citations.setCitationDomainCategory("a.test", "Other"),
      await citations.clearCitationDomainOverride("a.test"),
      await ga4.upsertGa4Mapping({ brand: "Kia", countryCode: "us", propertyId: "" }),
      await ga4.verifyGa4Mapping("p:7", "7", { brand: "Kia", countryCode: "US" }),
      await ga4.importLegacyMapping("Nope", "zz"),
      await ga4.removeGa4Mapping("p:7"),
    ];
    expect(legacy.calls).toEqual([]);
    expect(results.every((r) => r.ok || (r as { error?: string }).error === "해당 시장의 env 속성ID를 찾을 수 없습니다")).toBe(true);
    expect(sent).toEqual([
      "POST /v1/admin/users",
      `PATCH /v1/admin/users/${U(3)}`,
      `DELETE /v1/admin/users/${U(3)}`,
      `PATCH /v1/admin/catalog/prompts/${U(4)}/kind`,
      `PATCH /v1/admin/catalog/prompts/${U(4)}/text`,
      `PATCH /v1/admin/catalog/prompts/${U(4)}/labels`,
      `PATCH /v1/admin/catalog/prompts/${U(4)}/regions`,
      "POST /v1/admin/catalog/prompts/bulk/regions",
      `DELETE /v1/admin/catalog/prompts/${U(4)}`,
      `POST /v1/admin/catalog/prompts/${U(4)}/restore`,
      "POST /v1/admin/catalog/prompts",
      "POST /v1/admin/interest/keywords",
      `PATCH /v1/admin/interest/keywords/${U(8)}`,
      `DELETE /v1/admin/interest/keywords/${U(8)}`,
      "POST /v1/admin/interest/sources",
      `PATCH /v1/admin/interest/sources/${U(7)}`,
      `DELETE /v1/admin/interest/sources/${U(7)}`,
      `PUT /v1/admin/entities/${U(5)}`,
      "PUT /v1/admin/citation-overrides/a.test",
      "DELETE /v1/admin/citation-overrides/a.test",
      "PUT /v1/admin/ga4/markets/Kia/US",
      "PUT /v1/admin/ga4/properties/7",
      "DELETE /v1/admin/ga4/properties/7",
    ]);
  });

  it("the admin gate runs first: a non-admin session throws before any request", async () => {
    vi.mocked(getSession).mockResolvedValue(REGION as never);
    const scope = { scopeAll: false, brands: ["Kia"], regions: null, countries: null };
    await expect(users.updateUserProfile(U(3), { role: "hq", operator: "none", scope }, 1)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(standards.exportStandardCatalogXlsx()).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(standards.getStandardMarketVocabulary()).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(entities.setEntityRole(U(5), "Kia", "own", "Kia")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(citations.clearCitationDomainOverride("a.test")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(ga4.removeGa4Mapping("p:7")).rejects.toBeInstanceOf(UnauthorizedError);
    vi.mocked(getSession).mockResolvedValue(null as never);
    await expect(standards.deleteStandardKeyword(U(8))).rejects.toBeInstanceOf(UnauthorizedError);
    expect(sent).toEqual([]);
    expect(legacy.calls).toEqual([]);
  });

  it("local checks stay in front of the backend (same messages as legacy)", async () => {
    const bad = new FormData();
    bad.set("email", "x");
    expect(await users.createUser(bad)).toEqual({ ok: false, errorKey: "admin.errors.invalidEmail" });
    const vendor = new FormData();
    vendor.set("email", "v@t.test");
    vendor.set("role", "vendor");
    vendor.set("operator", "global");
    expect(await users.createUser(vendor)).toEqual({ ok: false, errorKey: "admin.errors.vendorOperatorForbidden" });
    expect(await users.deleteUser(U(1))).toEqual({ ok: false, errorKey: "admin.errors.cannotDeleteSelf" });
    expect(await standards.updateStandardPromptText(U(4), "  ")).toEqual({ ok: false, error: "프롬프트 내용을 입력해주세요" });
    expect(await standards.applyStandardCatalogChunk([], U(9))).toEqual({ ok: false, error: "적용할 항목이 없습니다" });
    expect(await standards.applyStandardCatalogChunk([{ id: U(4), labels: {} }], "not-a-uuid")).toEqual({ ok: false, error: "잘못된 batch id입니다" });
    expect(await entities.setEntityRole(U(5), "Kia", "own")).toEqual({ ok: false, error: "자사 지정에는 브랜드가 필요합니다" });
    expect(await citations.setCitationDomainCategory("a.test", "Nope")).toEqual({ ok: false, error: "지원하지 않는 카테고리입니다" });
    expect(await ga4.upsertGa4Mapping({ brand: "Kia", countryCode: "US", propertyId: "123456789012345678901" })).toEqual({ ok: false, error: "속성ID는 숫자만 허용됩니다" });
    expect(await ga4.verifyGa4Mapping("p:7", " ")).toEqual({ ok: false, error: "속성ID가 없어 검증할 수 없습니다" });
    expect(await standards.toggleStandardPromptEnabled(U(4), false)).toEqual({ ok: false, error: "더 이상 지원하지 않는 작업입니다" });
    expect(sent).toEqual([]);
    expect(legacy.calls).toEqual([]);
  });
});
