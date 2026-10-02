import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// API-source routing of the member actions (HGH_SOURCE_G6=api, unit U9): the backend member API is
// called, the legacy repositories and the legacy session gate are not touched, revalidatePath keeps
// the legacy paths (on success only). Result mapping per backend code: lib/hgh/adapters/projects.test.ts;
// legacy <-> api outcome parity: lib/hgh/adapters/projects.parity.test.ts. The legacy tests in this
// folder stay as they are (legacy source).

const h = vi.hoisted(() => ({ revalidate: [] as string[] }));
const untouched = () =>
  new Proxy(
    {},
    {
      get: (_t, name) =>
        name === "then" || typeof name === "symbol"
          ? undefined
          : () => {
              throw new Error(`legacy repository touched: ${String(name)}`);
            },
    },
  );
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.revalidate.push(p) }));
vi.mock("@/lib/auth/session", () => ({
  getSession: () => {
    throw new Error("legacy session gate touched");
  },
}));
vi.mock("@/lib/db/repositories/profiles", () => ({ profileRepository: untouched() }));
vi.mock("@/lib/db/repositories/projects", () => ({ projectRepository: untouched() }));
vi.mock("@/lib/db/repositories/project-members", () => ({ projectMemberRepository: untouched() }));
vi.mock("@/lib/db/repositories/member-audit-logs", () => ({ memberAuditLogRepository: untouched() }));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { UnauthorizedError } = await import("@/lib/auth/errors");
const A = await import("./_actions");

const PID = "c0000000-0000-4000-8000-000000000003";
const UID = "a0000000-0000-4000-8000-000000000001";
const calls: { method: string; path: string; body: unknown }[] = [];
let answer: (method: string, path: string) => Response = () => new Response(null, { status: 204 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls.length = 0;
  h.revalidate.length = 0;
  vi.stubEnv("HGH_SOURCE_G6", "api");
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  bindHghAuth({ getAccessToken: async () => "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln" });
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = String(init.method ?? "GET");
    const path = new URL(String(input)).pathname;
    calls.push({ method, path, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    return answer(method, path);
  });
  answer = () => new Response(null, { status: 204 });
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("member actions on the api source", () => {
  it("inviteMember: POST …/members {email}; revalidates the member tab on success only", async () => {
    answer = () => json(201, { data: { user_id: UID, email: "a@b.c", role: "viewer", status: "pending", invited_at: "2026-06-01T00:00:00Z", invited_by: UID }, meta: { mode: "crud" } });
    await expect(A.inviteMember(PID, "a@b.c")).resolves.toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([{ method: "POST", path: `/v1/projects/${PID}/members`, body: { email: "a@b.c" } }]);
    expect(h.revalidate).toEqual([`/projects/${PID}/member`]);
    h.revalidate.length = 0;
    answer = () => json(404, { error: { code: "invitee_not_found", message: "m" } });
    await expect(A.inviteMember(PID, "x@y.z")).resolves.toEqual({ ok: false, error: "해당 이메일로 가입된 사용자를 찾을 수 없습니다" });
    expect(h.revalidate).toEqual([]);
  });

  it("cancelInvite / removeMember address /members/{user_id}", async () => {
    answer = (method) =>
      method === "GET"
        ? json(200, { data: { items: [{ user_id: UID, email: "a@b.c", role: "viewer", status: "pending", invited_at: "2026-06-01T00:00:00Z", invited_by: UID }] }, meta: { mode: "crud" } })
        : new Response(null, { status: 204 });
    await expect(A.cancelInvite(PID, UID)).resolves.toEqual({ ok: true, value: undefined });
    await expect(A.removeMember(PID, UID)).resolves.toEqual({ ok: true, value: undefined });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /v1/projects/${PID}/members`,
      `DELETE /v1/projects/${PID}/members/${UID}`,
      `DELETE /v1/projects/${PID}/members/${UID}`,
    ]);
    expect(h.revalidate).toEqual([`/projects/${PID}/member`, `/projects/${PID}/member`]);
  });

  it("acceptInvite / rejectInvite: the pending row's id is the project id; revalidate /projects", async () => {
    await A.acceptInvite(PID);
    await A.rejectInvite(PID);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /v1/projects/${PID}/members/me/accept`,
      `POST /v1/projects/${PID}/members/me/reject`,
    ]);
    expect(h.revalidate).toEqual(["/projects", "/projects"]);
  });

  it("access failures throw like the legacy gate (401, 403 owner_only, hidden project 404)", async () => {
    for (const [status, code] of [
      [401, "no_account"],
      [403, "owner_only"],
      [404, "not_found"],
    ] as const) {
      answer = () => json(status, { error: { code, message: "m" } });
      await expect(A.removeMember(PID, UID)).rejects.toBeInstanceOf(UnauthorizedError);
    }
    expect(h.revalidate).toEqual([]);
  });
});
