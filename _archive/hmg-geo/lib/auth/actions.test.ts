import { beforeEach, describe, expect, it, vi } from "vitest";

const { redirect, signInWithPassword, signOut, getByUserId } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  getByUserId: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/utils/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { signInWithPassword, signOut } }),
}));
vi.mock("@/lib/db/repositories/profiles", () => ({ profileRepository: { getByUserId } }));
import { login, logout } from "./actions";

beforeEach(() => {
  vi.clearAllMocks();
  signInWithPassword.mockResolvedValue({ data: { user: { id: "user" } }, error: null });
  signOut.mockResolvedValue({ error: null });
  getByUserId.mockResolvedValue({ role: "admin" });
});

describe("auth redirect locale", () => {
  it.each(["ko", "en", "/evil.example", "\\evil.example", "../admin", "", "fr"])(
    "limits login/logout locale %j to supported local routes", async (input) => {
      const form = new FormData();
      form.set("locale", input);
      const locale = input === "en" ? "en" : "ko";
      await expect(login({}, form)).rejects.toThrow(`redirect:/${locale}/dashboard`);
      await expect(logout(form)).rejects.toThrow(`redirect:/${locale}/login`);
    },
  );
  it("keeps failed credentials on the login form", async () => {
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: new Error("invalid") });
    expect(await login({}, new FormData())).toEqual({ error: true });
    expect(redirect).not.toHaveBeenCalled();
  });
});
