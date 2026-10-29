import { describe, expect, it, vi } from "vitest";
import { provisionAdmin, type AdminAdapter, type AdminProfile } from "./admin-core";

const input = { email: "Admin@example.com", password: "no-real-secret-test-only", write: false, promoteExisting: false };
const profile: AdminProfile = { id: "user-1", email: "admin@example.com", role: "country", scopeAll: false, operator: "none", menuGroups: null };
function adapter(): AdminAdapter {
  return {
    findAuthByEmail: vi.fn().mockResolvedValue(null), findProfile: vi.fn().mockResolvedValue(null),
    findProfilesByEmail: vi.fn().mockResolvedValue([]), createAuth: vi.fn().mockResolvedValue({ id: "user-1", email: "admin@example.com" }),
    authExistsInDatabase: vi.fn().mockResolvedValue(true), deleteCreatedAuth: vi.fn().mockResolvedValue(undefined),
    insertAdmin: vi.fn().mockResolvedValue(undefined), promoteAdmin: vi.fn().mockResolvedValue(undefined),
  };
}
describe("first administrator provisioning", () => {
  it("dry-run does not write and normalizes email", async () => {
    const db = adapter();
    await expect(provisionAdmin(db, input)).resolves.toEqual({ status: "would-create", email: "admin@example.com" });
    expect(db.createAuth).not.toHaveBeenCalled();
    expect(db.insertAdmin).not.toHaveBeenCalled();
    expect(db.promoteAdmin).not.toHaveBeenCalled();
  });
  it("creates Auth and profile only after --yes", async () => {
    const db = adapter();
    await expect(provisionAdmin(db, { ...input, write: true })).resolves.toMatchObject({ status: "created", id: "user-1" });
    expect(db.createAuth).toHaveBeenCalledWith("admin@example.com", input.password);
    expect(db.insertAdmin).toHaveBeenCalledWith("user-1", "admin@example.com");
    expect(db.promoteAdmin).not.toHaveBeenCalled();
  });
  it("never silently elevates an existing account, including missing profile", async () => {
    for (const existingProfile of [null, profile]) {
      const db = adapter();
      vi.mocked(db.findAuthByEmail).mockResolvedValue({ id: "user-1", email: "admin@example.com" });
      vi.mocked(db.findProfile).mockResolvedValue(existingProfile);
      await expect(provisionAdmin(db, { ...input, write: true })).rejects.toThrow("--promote-existing");
      expect(db.createAuth).not.toHaveBeenCalled();
      expect(db.promoteAdmin).not.toHaveBeenCalled();
    }
  });
  it("requires --yes as well as --promote-existing and never resets password", async () => {
    const db = adapter();
    vi.mocked(db.findAuthByEmail).mockResolvedValue({ id: "user-1", email: "admin@example.com" });
    vi.mocked(db.findProfile).mockResolvedValue(profile);
    await expect(provisionAdmin(db, { ...input, promoteExisting: true })).resolves.toMatchObject({ status: "would-promote" });
    expect(db.promoteAdmin).not.toHaveBeenCalled();
    await expect(provisionAdmin(db, { ...input, promoteExisting: true, write: true })).resolves.toMatchObject({ status: "promoted" });
    expect(db.promoteAdmin).toHaveBeenCalledWith("user-1", "admin@example.com");
    expect(db.createAuth).not.toHaveBeenCalled();
  });
  it("is a no-op when the desired administrator already exists", async () => {
    const db = adapter();
    vi.mocked(db.findAuthByEmail).mockResolvedValue({ id: "user-1", email: "admin@example.com" });
    vi.mocked(db.findProfile).mockResolvedValue({ ...profile, role: "admin", scopeAll: true, operator: "global" });
    await expect(provisionAdmin(db, { ...input, write: true })).resolves.toMatchObject({ status: "unchanged" });
    expect(db.createAuth).not.toHaveBeenCalled();
    expect(db.promoteAdmin).not.toHaveBeenCalled();
  });
  it("refuses ambiguous profile identity before creating an account", async () => {
    const db = adapter();
    vi.mocked(db.findProfilesByEmail).mockResolvedValue([{ ...profile, id: "orphan-profile" }]);
    await expect(provisionAdmin(db, { ...input, write: true })).rejects.toThrow("일치하지");
    expect(db.createAuth).not.toHaveBeenCalled();
  });
  it("retains newly created Auth identity and explains explicit recovery when profile insert fails", async () => {
    const db = adapter();
    vi.mocked(db.insertAdmin).mockRejectedValue(new Error("secret from DB driver"));
    await expect(provisionAdmin(db, { ...input, write: true })).rejects.toThrow("--promote-existing --yes");
    expect(db.createAuth).toHaveBeenCalledTimes(1);
    expect(db.promoteAdmin).not.toHaveBeenCalled();
  });
  it("rejects existing Auth from a different DB without deleting or editing it", async () => {
    const db = adapter();
    vi.mocked(db.findAuthByEmail).mockResolvedValue({ id: "user-1", email: "admin@example.com" });
    vi.mocked(db.authExistsInDatabase).mockResolvedValue(false);
    await expect(provisionAdmin(db, { ...input, write: true, promoteExisting: true })).rejects.toThrow("프로젝트가 다릅니다");
    expect(db.deleteCreatedAuth).not.toHaveBeenCalled();
    expect(db.promoteAdmin).not.toHaveBeenCalled();
  });
  it("cleans up only newly created Auth when DB identity mismatch is proven", async () => {
    const db = adapter();
    vi.mocked(db.authExistsInDatabase).mockResolvedValue(false);
    await expect(provisionAdmin(db, { ...input, write: true })).rejects.toThrow("방금 만든 Auth 계정만 정리");
    expect(db.deleteCreatedAuth).toHaveBeenCalledExactlyOnceWith("user-1");
    expect(db.insertAdmin).not.toHaveBeenCalled();
    expect(db.promoteAdmin).not.toHaveBeenCalled();
  });
  it("keeps newly created account when identity lookup fails transiently", async () => {
    const db = adapter();
    vi.mocked(db.authExistsInDatabase).mockRejectedValue(new Error("timeout"));
    await expect(provisionAdmin(db, { ...input, write: true })).rejects.toThrow("동일성 조회 실패");
    expect(db.deleteCreatedAuth).not.toHaveBeenCalled();
    expect(db.insertAdmin).not.toHaveBeenCalled();
  });
  it("reports incomplete cleanup without leaking upstream error or writing profile", async () => {
    const db = adapter();
    vi.mocked(db.authExistsInDatabase).mockResolvedValue(false);
    vi.mocked(db.deleteCreatedAuth).mockRejectedValue(new Error("sensitive upstream body"));
    await expect(provisionAdmin(db, { ...input, write: true })).rejects.toThrow("정리 실패");
    expect(db.insertAdmin).not.toHaveBeenCalled();
  });
});
