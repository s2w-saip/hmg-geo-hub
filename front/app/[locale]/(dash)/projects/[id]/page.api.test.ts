import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// /projects/[id] on the api sources (U5): HGH_SOURCE_SESSION=api (the U2 page gate) and
// HGH_SOURCE_G6=api (tiles, panels, filter options). Membership and role come from the backend:
// a hidden project (non-member, out of scope, missing) is 404 -> notFound() before any data
// call; a role/menu refusal on a data call -> /no-access; the page never sends the session
// scope. The legacy repositories must not be touched on this path.

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});
vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
const legacy = vi.hoisted(() => ({ n: 0 }));
const boom = vi.hoisted(() => () => {
  legacy.n += 1;
  throw new Error("legacy repository read on the api source");
});
vi.mock("@/lib/db/repositories/project-members", () => ({ projectMemberRepository: { listForProject: boom } }));
vi.mock("@/lib/db/repositories/request-cache", () => ({ cachedProjectById: boom, cachedMembership: boom }));
vi.mock("@/lib/db/repositories/prompts", () => ({ promptRepository: { listForProject: boom }, promptCandidateRepository: { listForProject: boom } }));
vi.mock("@/lib/db/repositories/scope-aggregates", () => ({ listMeasuredRegions: boom }));
vi.mock("@/lib/db/repositories/project-custom-fields", () => ({ projectCustomFieldRepository: { listForProject: boom, listValuesForProject: boom } }));
vi.mock("./_components/project-dashboard", () => ({ ProjectDashboard: () => null }));
vi.mock("./_data/live", () => ({ buildProjectOverview: boom }));
const session = vi.hoisted(() => ({
  current: { user: { id: "u", email: "", role: "country", operator: "none", menuGroups: ["project"], scope: { all: false, brands: ["Kia"], countries: ["DE"] } } } as unknown,
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn(async () => session.current) }));

const { withRequestScope } = await import("@/test/request-scope");
const { bindHghAuth } = await import("@/lib/hgh/auth");
const { default: Page } = await import("./page");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln"; // {"alg":"ES256"}.{"sub":"u"}.sig
const PID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CF = "0f8fad5b-d9cb-469f-a165-70867728950e";
const meta = { mode: "crud" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string) => json({ error: { code, message: "", details: null } }, status);

const detail = {
  project_id: PID,
  name: "Kia DE",
  country_code: "DE",
  brand_code: "Kia",
  created_at: "2026-09-01T00:00:00Z",
  created_by: PID,
  updated_at: "2026-09-01T00:00:00Z",
  effective_engines: [],
  scope_linked: true,
  my_role: "viewer",
  prompt_counts: { done: 2, draft: 1 },
  candidate_count: 3,
  active_member_count: 2,
  last_run_at: "2026-09-10T00:00:00Z",
  recent_prompts: [],
};

let routes: Record<string, () => Response>;
let hits: URL[];
beforeEach(() => {
  legacy.n = 0;
  hits = [];
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_SOURCE_SESSION", "api");
  vi.stubEnv("HGH_SOURCE_G6", "api");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  routes = {
    [`/v1/projects/${PID}`]: () => json({ data: detail, meta }),
    [`/v1/projects/${PID}/prompt-candidates`]: () =>
      json({ data: { items: [{ candidate_id: "c1", text: "t", source: "manual", source_keyword: null, created_at: "2026-09-02T00:00:00Z" }] }, meta }),
    "/v1/filters/options": () =>
      json({
        data: {
          catalog: null,
          custom_fields: [{ field_id: CF, label: "Segment", values: ["SUV", "EV"] }],
          engines: [],
          geo_matrix: [{ brand: "Kia", region: "DE", lang: "de" }],
          languages: ["de"],
          regions: [{ code: "DE", area: null, kind: "iso" }],
        },
        meta: { mode: "snapshot" },
      }),
    "/v1/filters/dates": () =>
      json({ data: { dates: [], dates_truncated: false, first_measured_date: null, latest_round_date: null, presets: [] }, meta: { mode: "snapshot" } }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const u = new URL(String(input));
      hits.push(u);
      const r = routes[u.pathname];
      return r ? r() : err(404, "not_found");
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const run = (sp: Record<string, string> = {}) =>
  withRequestScope(() =>
    Page({ params: Promise.resolve({ locale: "ko", id: PID }), searchParams: Promise.resolve(sp) }) as Promise<ReactElement<Record<string, unknown>>>,
  );

describe("/projects/[id] api sources", () => {
  it("member: tiles from ProjectDetail (BG-38), options = project countries + custom field axis, cf filter read from the URL", async () => {
    const el = await run({ [`cf_${CF}`]: "EV" });
    const props = el.props as {
      overview: { promptCount: number; candidateCount: number; activeMemberCount: number; recentCandidates: unknown[] };
      geographyOptions: string[];
      dynamicAxes: { id: string; options: string[] }[];
      filters: { customFieldFilters: Record<string, string[]> };
      brand: string;
    };
    expect([props.overview.promptCount, props.overview.candidateCount, props.overview.activeMemberCount]).toEqual([3, 3, 2]);
    expect(props.overview.recentCandidates).toHaveLength(1);
    expect(props.geographyOptions).toEqual(["DE"]);
    expect(props.dynamicAxes).toEqual([{ id: CF, label: "Segment", options: ["EV", "SUV"] }]);
    expect(props.filters.customFieldFilters).toEqual({ [CF]: ["EV"] });
    expect(props.brand).toBe("Kia");
    expect(legacy.n).toBe(0);
    // D6: the page shell is the four essential calls, each requested once
    expect(hits.map((u) => u.pathname).sort()).toEqual(
      ["/v1/filters/dates", "/v1/filters/options", `/v1/projects/${PID}`, `/v1/projects/${PID}/prompt-candidates`].sort(),
    );
    // the session scope (brands Kia, countries DE) is never sent
    for (const u of hits) {
      expect(u.searchParams.getAll("brand"), u.pathname).toEqual([]);
      expect(u.searchParams.getAll("country"), u.pathname).toEqual([]);
    }
  });

  it("non-member / out of scope / missing: backend 404 -> notFound before any data call", async () => {
    routes[`/v1/projects/${PID}`] = () => err(404, "not_found");
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(hits.map((u) => u.pathname)).toEqual([`/v1/projects/${PID}`]);
    expect(legacy.n).toBe(0);
  });

  it("menu or role refusal on a data call -> /no-access; an owner-only style 403 hides the project", async () => {
    routes["/v1/filters/options"] = () => err(403, "menu_forbidden");
    await expect(run()).rejects.toThrow("NEXT_REDIRECT /ko/no-access");
    routes["/v1/filters/options"] = () => err(403, "owner_only");
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("expired session on the gate -> login", async () => {
    routes[`/v1/projects/${PID}`] = () => err(401, "token_expired");
    await expect(run()).rejects.toThrow("NEXT_REDIRECT /ko/login");
  });

  it("not a uuid: hidden without a backend call", async () => {
    await expect(
      withRequestScope(() => Page({ params: Promise.resolve({ locale: "ko", id: "new" }), searchParams: Promise.resolve({}) })),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(hits).toHaveLength(0);
  });
});
