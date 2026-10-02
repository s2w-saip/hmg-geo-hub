import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

// Mock everything the actions reach for. The tests assert on call sequencing,
// argument shapes, and the spec-mandated denials — not on the underlying
// libraries (Supabase, Drizzle) themselves.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db/repositories/profiles", () => ({
  profileRepository: {
    update: vi.fn(),
    delete: vi.fn(),
    insert: vi.fn(),
    getByUserId: vi.fn(),
    list: vi.fn(),
    countAdminsExcept: vi.fn(),
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  adminCreateUser: vi.fn(),
  adminDeleteUser: vi.fn(),
  generateTempPassword: vi.fn(() => "tmp-pw"),
}));
vi.mock("@/lib/audit", () => ({ auditDataAccess: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { profileRepository } from "@/lib/db/repositories/profiles";
import { adminDeleteUser } from "@/lib/supabase/admin";
import { updateUserProfile, deleteUser } from "./_actions";

function adminSession(id = "admin-1"): Session {
  return {
    user: {
      id,
      email: "admin@hmg.test",
      role: "admin",
      scope: { all: true },
    },
  };
}

function nonAdminSession(): Session {
  return {
    user: {
      id: "region-1",
      email: "region@hmg.test",
      role: "region",
      scope: { all: false, regions: ["EU"] },
    },
  };
}

const updateMock = vi.mocked(profileRepository.update);
const deleteProfileMock = vi.mocked(profileRepository.delete);
const getByUserIdMock = vi.mocked(profileRepository.getByUserId);
const countAdminsExceptMock = vi.mocked(profileRepository.countAdminsExcept);
const adminDeleteMock = vi.mocked(adminDeleteUser);
const getSessionMock = vi.mocked(getSession);

// Stub a profile row matching the shape callers expect from getByUserId.
// Only the fields the admin governance guards actually read are needed.
function profile(id: string, role: "hq" | "region" | "country" | "admin") {
  return {
    id,
    email: `${role}@hmg.test`,
    role,
    scopeAll: role === "admin" || role === "hq",
    brands: null,
    regions: null,
    countries: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue({} as never);
  deleteProfileMock.mockResolvedValue(undefined);
  adminDeleteMock.mockResolvedValue(undefined);
  // Default: the target profile (whatever id) is a non-admin region user, and
  // there are plenty of admins. Tests override per case.
  getByUserIdMock.mockResolvedValue(profile("target-1", "region"));
  countAdminsExceptMock.mockResolvedValue(2);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("updateUserProfile — single atomic role+scope update", () => {
  it("admin can update role and scope in one call", async () => {
    getSessionMock.mockResolvedValue(adminSession());
    const res = await updateUserProfile("target-1", {
      role: "region",
      operator: "assigned",
      scope: { scopeAll: false, brands: null, regions: ["EU"], countries: null },
    });
    expect(res).toEqual({ ok: true });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith("target-1", {
      role: "region",
      operator: "assigned",
      scopeAll: false,
      brands: null,
      regions: ["EU"],
      countries: null,
    });
  });

  it("scopeAll=true wipes per-dimension arrays", async () => {
    getSessionMock.mockResolvedValue(adminSession());
    await updateUserProfile("target-1", {
      role: "hq",
      operator: "global",
      scope: {
        scopeAll: true,
        brands: ["Hyundai"],
        regions: ["EU"],
        countries: ["DE"],
      },
    });
    expect(updateMock).toHaveBeenCalledWith("target-1", {
      role: "hq",
      operator: "global",
      scopeAll: true,
      brands: null,
      regions: null,
      countries: null,
    });
  });

  it("empty arrays collapse to null", async () => {
    getSessionMock.mockResolvedValue(adminSession());
    await updateUserProfile("target-1", {
      role: "country",
      operator: "none",
      scope: { scopeAll: false, brands: [], regions: [], countries: [] },
    });
    expect(updateMock).toHaveBeenCalledWith("target-1", {
      role: "country",
      operator: "none",
      scopeAll: false,
      brands: null,
      regions: null,
      countries: null,
    });
  });

  it("non-admin caller is rejected before any DB write", async () => {
    getSessionMock.mockResolvedValue(nonAdminSession());
    await expect(
      updateUserProfile("target-1", {
        role: "admin",
        operator: "none",
        scope: { scopeAll: true, brands: null, regions: null, countries: null },
      }),
    ).rejects.toThrow(/admin action/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("unauthenticated caller is rejected", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(
      updateUserProfile("target-1", {
        role: "hq",
        operator: "none",
        scope: { scopeAll: true, brands: null, regions: null, countries: null },
      }),
    ).rejects.toThrow();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("invalid role returns errorKey without touching DB", async () => {
    getSessionMock.mockResolvedValue(adminSession());
    const res = await updateUserProfile("target-1", {
      // @ts-expect-error — deliberately wrong to test the guard
      role: "superuser",
      operator: "none",
      scope: { scopeAll: true, brands: null, regions: null, countries: null },
    });
    expect(res).toEqual({ ok: false, errorKey: "admin.errors.updateFailed" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("admin cannot demote themselves out of admin (lockout protection)", async () => {
    getSessionMock.mockResolvedValue(adminSession("admin-1"));
    getByUserIdMock.mockResolvedValue(profile("admin-1", "admin"));
    countAdminsExceptMock.mockResolvedValue(2); // other admins exist; rule still blocks

    const res = await updateUserProfile("admin-1", {
      role: "region",
      operator: "none",
      scope: { scopeAll: false, brands: null, regions: ["EU"], countries: null },
    });
    expect(res).toEqual({
      ok: false,
      errorKey: "admin.errors.cannotDemoteSelf",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("admin can keep admin role on their own row (no self-demote triggered)", async () => {
    getSessionMock.mockResolvedValue(adminSession("admin-1"));
    getByUserIdMock.mockResolvedValue(profile("admin-1", "admin"));

    const res = await updateUserProfile("admin-1", {
      role: "admin", // only scope changes
      operator: "global",
      scope: { scopeAll: true, brands: null, regions: null, countries: null },
    });
    expect(res).toEqual({ ok: true });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("cannot demote another admin if they are the only remaining admin", async () => {
    // Hypothetical: caller is admin, target is admin, but the count
    // excluding target is 0 (target was the only "other" admin and the
    // caller equality somehow doesn't match — e.g. a future variant).
    // The invariant guards against that future-shape regardless.
    getSessionMock.mockResolvedValue(adminSession("admin-1"));
    getByUserIdMock.mockResolvedValue(profile("admin-2", "admin"));
    countAdminsExceptMock.mockResolvedValue(0);

    const res = await updateUserProfile("admin-2", {
      role: "region",
      operator: "none",
      scope: { scopeAll: false, brands: null, regions: ["EU"], countries: null },
    });
    expect(res).toEqual({
      ok: false,
      errorKey: "admin.errors.lastAdminProtected",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("can demote another admin when others remain", async () => {
    getSessionMock.mockResolvedValue(adminSession("admin-1"));
    getByUserIdMock.mockResolvedValue(profile("admin-2", "admin"));
    countAdminsExceptMock.mockResolvedValue(1);

    const res = await updateUserProfile("admin-2", {
      role: "region",
      operator: "none",
      scope: { scopeAll: false, brands: null, regions: ["EU"], countries: null },
    });
    expect(res).toEqual({ ok: true });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("non-admin target demoted to non-admin skips count query", async () => {
    // Performance + correctness: no point checking the admin invariant when
    // no admin role is being removed.
    getSessionMock.mockResolvedValue(adminSession("admin-1"));
    getByUserIdMock.mockResolvedValue(profile("region-1", "region"));

    const res = await updateUserProfile("region-1", {
      role: "country",
      operator: "none",
      scope: { scopeAll: false, brands: null, regions: null, countries: ["KR"] },
    });
    expect(res).toEqual({ ok: true });
    expect(countAdminsExceptMock).not.toHaveBeenCalled();
  });

  it("vendor cannot be granted operator authority (forced none)", async () => {
    getSessionMock.mockResolvedValue(adminSession());
    const res = await updateUserProfile("target-1", {
      role: "vendor",
      operator: "global",
      scope: { scopeAll: false, brands: ["Hyundai"], regions: ["EU"], countries: null },
    });
    expect(res).toEqual({
      ok: false,
      errorKey: "admin.errors.vendorOperatorForbidden",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("vendor with operator=none saves with operator none", async () => {
    getSessionMock.mockResolvedValue(adminSession());
    const res = await updateUserProfile("target-1", {
      role: "vendor",
      operator: "none",
      scope: { scopeAll: false, brands: ["Hyundai"], regions: ["EU"], countries: null },
    });
    expect(res).toEqual({ ok: true });
    expect(updateMock).toHaveBeenCalledWith(
      "target-1",
      expect.objectContaining({ role: "vendor", operator: "none" }),
    );
  });
});

describe("deleteUser — single atomic delete with self-protection", () => {
  it("admin can delete another user; auth deleted before profile", async () => {
    getSessionMock.mockResolvedValue(adminSession("admin-1"));
    const order: string[] = [];
    adminDeleteMock.mockImplementation(async () => {
      order.push("auth");
    });
    deleteProfileMock.mockImplementation(async () => {
      order.push("profile");
    });

    const res = await deleteUser("target-1");
    expect(res).toEqual({ ok: true });
    expect(order).toEqual(["auth", "profile"]);
  });

  it("admin cannot delete themselves (lockout protection)", async () => {
    getSessionMock.mockResolvedValue(adminSession("admin-1"));
    const res = await deleteUser("admin-1");
    expect(res).toEqual({
      ok: false,
      errorKey: "admin.errors.cannotDeleteSelf",
    });
    expect(adminDeleteMock).not.toHaveBeenCalled();
    expect(deleteProfileMock).not.toHaveBeenCalled();
  });

  it("non-admin caller is rejected before any side effects", async () => {
    getSessionMock.mockResolvedValue(nonAdminSession());
    await expect(deleteUser("target-1")).rejects.toThrow(/admin action/);
    expect(adminDeleteMock).not.toHaveBeenCalled();
    expect(deleteProfileMock).not.toHaveBeenCalled();
  });

  it("auth deletion failure returns error and skips profile delete", async () => {
    getSessionMock.mockResolvedValue(adminSession());
    adminDeleteMock.mockRejectedValueOnce(new Error("supabase 500"));
    const res = await deleteUser("target-1");
    expect(res).toEqual({ ok: false, errorKey: "admin.errors.deleteFailed" });
    expect(deleteProfileMock).not.toHaveBeenCalled();
  });

  it("profile cleanup failure after auth deletion still returns ok", async () => {
    // Auth gone → access is revoked, which is the security-critical step.
    // Orphan profile is hidden by the join in UserList; surface as success.
    getSessionMock.mockResolvedValue(adminSession());
    deleteProfileMock.mockRejectedValueOnce(new Error("db down"));
    const res = await deleteUser("target-1");
    expect(res).toEqual({ ok: true });
  });

  it("cannot delete an admin target if no other admin remains", async () => {
    getSessionMock.mockResolvedValue(adminSession("admin-1"));
    getByUserIdMock.mockResolvedValue(profile("admin-2", "admin"));
    countAdminsExceptMock.mockResolvedValue(0);

    const res = await deleteUser("admin-2");
    expect(res).toEqual({
      ok: false,
      errorKey: "admin.errors.lastAdminProtected",
    });
    expect(adminDeleteMock).not.toHaveBeenCalled();
    expect(deleteProfileMock).not.toHaveBeenCalled();
  });

  it("non-admin target deletion skips the admin count query", async () => {
    getSessionMock.mockResolvedValue(adminSession("admin-1"));
    getByUserIdMock.mockResolvedValue(profile("region-1", "region"));

    const res = await deleteUser("region-1");
    expect(res).toEqual({ ok: true });
    expect(countAdminsExceptMock).not.toHaveBeenCalled();
  });
});
