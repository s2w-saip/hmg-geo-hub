import { describe, expect, it } from "vitest";
import { safeError, SetupError, validateAdminEnv, validateSetupEnv } from "./config";

function jwt(role: string, ref = "projecta") {
  return `header.${Buffer.from(JSON.stringify({ role, ref })).toString("base64url")}.signature`;
}
const valid = {
  DATABASE_URL: "postgresql://postgres:password@db.projecta.supabase.co:5432/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://projecta.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt("anon"),
  SUPABASE_SERVICE_ROLE_KEY: jwt("service_role"),
  SCOPE_MODE: "mock",
};
const errors = (env = valid) => validateSetupEnv(env).filter((entry) => entry.level === "error");
describe("setup env diagnostics", () => {
  it("accepts matching hosted credentials and local Supabase", () => {
    expect(errors()).toEqual([]);
    expect(errors({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" })).toEqual([]);
  });
  it("reports missing example values without echoing supplied secrets", () => {
    expect(validateSetupEnv({}).filter((i) => i.level === "error").map((i) => i.name)).toEqual([
      "DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
    ]);
    const result = errors({ ...valid, DATABASE_URL: "postgresql://postgres:secret-token@db.otherproject.supabase.co:5432/postgres" });
    expect(result.some((i) => i.name === "DATABASE_URL")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(errors({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "https://your-project.supabase.co" }).length).toBeGreaterThan(0);
  });
  it("rejects pooler project mismatch and key role/ref mistakes", () => {
    expect(errors({ ...valid, DATABASE_URL: "postgresql://postgres.projectb:password@aws-0-region.pooler.supabase.com:6543/postgres" }).map((i) => i.name)).toContain("DATABASE_URL");
    expect(errors({ ...valid, NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt("service_role") }).map((i) => i.name)).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(errors({ ...valid, SUPABASE_SERVICE_ROLE_KEY: jwt("service_role", "other") }).map((i) => i.name)).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
  it("accepts new Supabase key formats, rejects cross-use", () => {
    expect(errors({ ...valid, NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test-key", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test-key" })).toEqual([]);
    expect(errors({ ...valid, NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_test-key" }).map((i) => i.name)).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });
  it("requires Scope credentials only for live integration", () => {
    expect(errors({ ...valid, SCOPE_MODE: "live" }).map((i) => i.name)).toEqual(["SCOPE_API_BASE", "SCOPE_API_KEY", "SCOPE_ROOT_PROJECT_ID"]);
  });
  it("rejects hosted Auth mixed with local/arbitrary DB before connecting", () => {
    for (const host of ["localhost", "db.internal.example"]) {
      expect(errors({ ...valid, DATABASE_URL: `postgresql://postgres:password@${host}:5432/postgres` }).map((i) => i.name)).toContain("DATABASE_URL");
    }
    expect(errors({ ...valid, DATABASE_URL: "postgresql://postgres.projecta:password@aws-0-region.pooler.supabase.com:6543/postgres" })).toEqual([]);
    expect(errors({ ...valid, DATABASE_URL: "postgresql://hmg_int_ro.projecta:password@aws-0-region.pooler.supabase.com:5432/postgres" })).toEqual([]);
    expect(errors({ ...valid, DATABASE_URL: "postgresql://hmg_int_ro.projectb:password@aws-0-region.pooler.supabase.com:5432/postgres" }).map((i) => i.name)).toContain("DATABASE_URL");
  });
  it("requires email/password and suppresses arbitrary upstream errors", () => {
    expect(validateAdminEnv({})).toHaveLength(2);
    expect(validateAdminEnv({ SETUP_ADMIN_EMAIL: "new@example.com", SETUP_ADMIN_PASSWORD: "strong-test-password" })).toEqual([]);
    expect(validateAdminEnv({ SETUP_ADMIN_EMAIL: "existing@example.com", SETUP_ADMIN_PASSWORD: "old-secret" }, false)).toEqual([]);
    expect(safeError(new Error("connection string containing secret"))).not.toContain("secret");
    expect(safeError(new SetupError("safe status"))).toBe("safe status");
  });
});
