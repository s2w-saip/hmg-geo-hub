import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// API-source routing of createProject (HGH_SOURCE_G6=api, unit U9): POST /v1/projects, redirect to
// the new project's intent tab in the form's locale, legacy repository / Scope mirror / session
// gate untouched. Messages per backend code: lib/hgh/adapters/projects.test.ts.

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: () => {
    throw new Error("legacy session gate touched");
  },
}));
const untouched = () =>
  new Proxy(
    {},
    {
      get: (_t, name) =>
        name === "then" || typeof name === "symbol"
          ? undefined
          : () => {
              throw new Error(`legacy dependency touched: ${String(name)}`);
            },
    },
  );
vi.mock("@/lib/db/repositories/projects", () => ({ projectRepository: untouched() }));
vi.mock("@/lib/db/repositories/project-owned-bases", () => untouched());
vi.mock("@/lib/scope/project-sync", () => untouched());

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { createProject } = await import("./_actions");

const NEW = "c0000000-0000-4000-8000-0000000000aa";
const calls: { method: string; path: string; body: unknown }[] = [];
let answer: () => Response;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("HGH_SOURCE_G6", "api");
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  bindHghAuth({ getAccessToken: async () => "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln" });
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    calls.push({ method: String(init.method), path: new URL(String(input)).pathname, body: JSON.parse(String(init.body)) });
    return answer();
  });
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function form(locale: string | null): FormData {
  const f = new FormData();
  f.set("name", "Kia DE");
  f.set("country", "DE");
  f.set("brand", "Kia");
  f.append("aiEngines", "chatgpt");
  if (locale) f.set("locale", locale);
  return f;
}

describe("createProject on the api source", () => {
  it("POST /v1/projects, then redirect to /{locale}/projects/{new id}/intent (locale default ko)", async () => {
    answer = () => json(201, { data: { project_id: NEW }, meta: { mode: "crud" } });
    await expect(createProject(form("en"))).rejects.toThrow(`REDIRECT:/en/projects/${NEW}/intent`);
    await expect(createProject(form(null))).rejects.toThrow(`REDIRECT:/ko/projects/${NEW}/intent`);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/v1/projects",
      body: { name: "Kia DE", description: null, domain: null, brand_code: "Kia", country_code: "DE", ai_engines: ["chatgpt"] },
    });
  });

  it("a refused creation returns the legacy message and does not redirect", async () => {
    answer = () => json(403, { error: { code: "brand_forbidden", message: "m" } });
    await expect(createProject(form("ko"))).resolves.toEqual({ ok: false, error: "선택한 브랜드에 대한 권한이 없습니다" });
  });
});
