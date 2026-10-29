import { beforeEach, describe, expect, it, vi } from "vitest";

const { getClaims, getByUserId } = vi.hoisted(() => ({
  getClaims: vi.fn(), getByUserId: vi.fn(),
}));
vi.mock("react", () => ({ cache: (fn: unknown) => fn }));
vi.mock("@/utils/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getClaims } }),
}));
vi.mock("@/lib/db/repositories/profiles", () => ({ profileRepository: { getByUserId } }));
import { getSession } from "./session";

const profile = {
  role: "country", scopeAll: false, brands: null, regions: null, countries: null,
  email: "member@example.test", operator: "none", menuGroups: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: "user", email: profile.email } } });
  getByUserId.mockResolvedValue({ ...profile });
});

describe("session scope assignment", () => {
  it("newly created country profile has no data access until assigned", async () => {
    expect(await getSession()).toBeNull();
  });
  it.each([
    { role: "hq", brands: null },
    { role: "hq", brands: [] },
    { role: "hq", brands: [" "] },
    { role: "region", brands: [], regions: [] },
    { role: "country", brands: [" "], regions: ["\t"], countries: ["\n"] },
    { role: "website", brands: null },
    { role: "admin", brands: null },
  ])("denies an entirely unassigned nonvendor scope: %j", async (patch) => {
    getByUserId.mockResolvedValue({ ...profile, ...patch });
    expect(await getSession()).toBeNull();
  });
  it.each([
    { role: "hq", brands: ["Hyundai"] },
    { role: "region", brands: ["Hyundai"], regions: ["hyundai-europe"] },
    { role: "country", brands: ["Hyundai"], countries: ["KR"] },
    { role: "website", brands: ["Hyundai"] },
    // Existing seed/profile policy explicitly allows multiple brands without a
    // brand filter, and administrators can assign any nonempty dimension set.
    { role: "region", regions: ["hyundai-europe", "kia-western-europe", "genesis-europe"] },
    { role: "country", regions: ["hyundai-asia-pacific", "kia-asia-pacific"], countries: ["KR"] },
    { role: "country", countries: ["KR"] },
    { role: "region", brands: ["Hyundai"] },
  ])("preserves an explicitly assigned dimension scope: %j", async (patch) => {
    getByUserId.mockResolvedValue({ ...profile, ...patch });
    const session = await getSession();
    expect(session?.user.role).toBe(patch.role);
    expect(session?.user.scope.all).toBe(false);
    for (const dimension of ["brands", "regions", "countries"] as const) {
      expect(session?.user.scope[dimension]).toEqual(patch[dimension]);
    }
  });
  it.each(["admin", "hq", "region", "country", "website"])("preserves admin-assigned scopeAll for role %s", async (role) => {
    getByUserId.mockResolvedValue({ ...profile, role, scopeAll: true });
    expect((await getSession())?.user.scope.all).toBe(true);
  });
  it("keeps membership-only vendors authenticated, without scopeAll or operator bypass", async () => {
    getByUserId.mockResolvedValue({ ...profile, role: "vendor", scopeAll: true, operator: "global" });
    const session = await getSession();
    expect(session?.user.scope.all).toBe(false);
    expect(session?.user.operator).toBe("none");
  });
  it("keeps explicitly unrestricted admins authenticated", async () => {
    getByUserId.mockResolvedValue({ ...profile, role: "admin", scopeAll: true });
    expect((await getSession())?.user.scope.all).toBe(true);
  });
  it("requires verified identity and a server-controlled profile", async () => {
    getClaims.mockResolvedValueOnce({ data: null });
    expect(await getSession()).toBeNull();
    expect(getByUserId).not.toHaveBeenCalled();
    getByUserId.mockResolvedValueOnce(null);
    expect(await getSession()).toBeNull();
  });
});
