import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ api: false, curation: vi.fn(), entities: vi.fn(), apiCuration: vi.fn(), apiEntities: vi.fn() }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key, setRequestLocale: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => ({ user: { role: "admin" } }) }));
vi.mock("@/lib/auth/scope-policy", () => ({ canAccessAdmin: () => true }));
vi.mock("@/lib/db/repositories/citation-overrides", () => ({ citationOverrideRepository: { listDomainCuration: mock.curation } }));
vi.mock("@/lib/db/repositories/entity-registry", () => ({ listDiscoveredBrands: mock.entities }));
vi.mock("@/lib/hgh/adapters/admin", () => ({ isAdminApi: () => mock.api, listCitationCuration: mock.apiCuration }));
vi.mock("@/lib/hgh/adapters/admin-entities", () => ({ listEntityRows: mock.apiEntities }));
vi.mock("@/lib/hgh/errors", () => ({ throwForPage: (error: unknown) => { throw error; } }));
vi.mock("@/app/[locale]/(dash)/admin/standards/entities/_ecat-data", () => ({ requireAdminPage: async () => {}, ecatGate: async () => ({}), draftChangeCount: () => 0 }));
vi.mock("@/app/[locale]/(dash)/admin/standards/citation-sources/_components/domain-list", () => ({ DomainList: () => null }));
vi.mock("@/app/[locale]/(dash)/admin/standards/entities/_components/entity-catalog", () => ({ EntityCatalog: () => null }));
vi.mock("@/app/[locale]/(dash)/admin/standards/entities/_components/entity-manager", () => ({ EntityManager: () => null }));
vi.mock("@/app/[locale]/(dash)/admin/standards/entities/_components/draft-bar", () => ({ DraftBar: () => null }));
vi.mock("@/app/[locale]/(dash)/admin/standards/entities/_components/ecat-shared", () => ({ EcatNav: () => null, Notice: () => null }));
import CitationsPage from "@/app/[locale]/(dash)/admin/standards/citation-sources/page";
import EntitiesPage from "@/app/[locale]/(dash)/admin/standards/entities/page";

beforeEach(() => {
  mock.api = false;
  for (const fn of [mock.curation, mock.entities, mock.apiCuration, mock.apiEntities]) fn.mockReset().mockResolvedValue([]);
});
const input = () => ({ params: Promise.resolve({ locale: "ko" }) });

describe("admin list read failures", () => {
  it("keeps legitimately empty lists renderable", async () => {
    await expect(CitationsPage(input())).resolves.toBeDefined();
    await expect(EntitiesPage(input())).resolves.toBeDefined();
  });
  it.each(["legacy", "api"])("does not turn a %s citation failure into an empty page", async (source) => {
    mock.api = source === "api";
    const failure = new Error("read unavailable");
    (mock.api ? mock.apiCuration : mock.curation).mockRejectedValueOnce(failure);
    await expect(CitationsPage(input())).rejects.toBe(failure);
  });
  it.each(["legacy", "api"])("does not turn a %s entity failure into an empty page", async (source) => {
    mock.api = source === "api";
    const failure = new Error("read unavailable");
    (mock.api ? mock.apiEntities : mock.entities).mockRejectedValueOnce(failure);
    await expect(EntitiesPage(input())).rejects.toBe(failure);
  });
});
