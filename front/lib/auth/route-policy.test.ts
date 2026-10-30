import { describe, it, expect } from "vitest";
import {
  ROUTES,
  canAccessRoute,
  visibleRoutes,
  visibleGroups,
  groupForPath,
  defaultLandingFor,
  isGuardBypass,
  isMenuPath,
} from "./route-policy";
import type { Role } from "./types";

// Compensating control: route policy is the only place that maps a role to a
// reachable URL. These tests enforce the role × route matrix from the v17/v19
// planning Use Case (page 4981000). v22: 멤버 moved from a global route to a
// per-project 3depth tab inside /projects/[id], so /projects/access no longer
// exists as a route.
// v24 6-role model (2026-07-22): + website (웹사이트 전용 열람 — [글로벌X, 웹O,
// 프로젝트X]). Website group only; standard/project/admin stay closed.
const roles: Role[] = ["hq", "region", "country", "admin", "vendor", "website"];
const PROJECT_ROLES: Role[] = ["hq", "region", "country", "admin", "vendor"];

// 2026-06-04 standard SNB reorg: Answer Analysis split into mention +
// citation children, AI Funnel + Customer Interest each got an explicit
// parent route (children stayed). Order mirrors ROUTES declaration order
// since visibleRoutes preserves it.
// 2026-10-20: renewal pages sit right after their originals.
const NON_VENDOR_STANDARD_PATHS = [
  "/dashboard",
  "/renewal/dashboard",
  "/standard/prompts",
  "/renewal/standard/prompts",
  "/standard/answer-analysis",
  "/standard/answer-analysis/mention",
  "/renewal/standard/answer-analysis/mention",
  "/standard/answer-analysis/citation",
  "/renewal/standard/answer-analysis/citation",
  "/standard/ai-funnel",
  "/standard/ai-funnel/visibility",
  "/renewal/standard/ai-funnel/visibility",
  "/standard/ai-funnel/acr",
  "/renewal/standard/ai-funnel/acr",
  "/standard/ai-funnel/conversion",
  "/renewal/standard/ai-funnel/conversion",
  "/customer-interest",
  "/customer-interest/google-keywords",
  "/customer-interest/social-scraping",
];

// HIDDEN from the 표준 SNB but route access 유지(위 canAccessRoute 커버리지) —
// visibleRoutes 에서는 빠진다.
//   - customer-interest (2026-06-23): 표준 메뉴와 성격이 달라 메뉴에서만 숨김.
//   - ai-funnel/visibility (2026-10-29, 사용자): Gold 가 아닌 HUB GA4·SEO 화면이라 다시 숨김(코드·주소는 유지).
const HIDDEN_STANDARD_PATHS = [
  "/standard/ai-funnel/visibility",
  "/renewal/standard/ai-funnel/visibility",
  "/customer-interest",
  "/customer-interest/google-keywords",
  "/customer-interest/social-scraping",
];
const VISIBLE_STANDARD_PATHS = NON_VENDOR_STANDARD_PATHS.filter(
  (p) => !HIDDEN_STANDARD_PATHS.includes(p),
);

// 웹사이트 그룹 (2026-06-30): 표준 SNB 구조를 재사용하되 프롬프트(표준프롬프트)
// 메뉴만 제외. 선언 순서대로.
//   - ai-funnel/acr (2026-07-01): ACR 메뉴는 표준(전사 측정)에서만 노출 →
//     웹사이트 SNB 에서는 숨김(라우트 접근은 유지). 표준 acr 는 계속 노출.
const NON_VENDOR_WEBSITE_PATHS = [
  "/website",
  "/website/prompts",
  "/website/answer-analysis",
  "/website/answer-analysis/mention",
  "/website/answer-analysis/citation",
  "/website/ai-funnel",
  "/website/ai-funnel/acr",
  "/website/ai-funnel/conversion",
];
const HIDDEN_WEBSITE_PATHS = ["/website/ai-funnel/acr"];
const VISIBLE_WEBSITE_PATHS = NON_VENDOR_WEBSITE_PATHS.filter(
  (p) => !HIDDEN_WEBSITE_PATHS.includes(p),
);

describe("route-policy — 표준 group access", () => {
  for (const role of ["hq", "region", "country", "admin"] as Role[]) {
    for (const path of NON_VENDOR_STANDARD_PATHS) {
      it(`${role} CAN access ${path}`, () => {
        expect(canAccessRoute(role, path)).toBe(true);
      });
    }
  }
  for (const role of ["vendor", "website"] as Role[]) {
    for (const path of NON_VENDOR_STANDARD_PATHS) {
      it(`${role} cannot access ${path}`, () => {
        expect(canAccessRoute(role, path)).toBe(false);
      });
    }
  }
});

describe("route-policy — 웹사이트 group access", () => {
  for (const role of ["hq", "region", "country", "admin", "website"] as Role[]) {
    for (const path of NON_VENDOR_WEBSITE_PATHS) {
      it(`${role} CAN access ${path}`, () => {
        expect(canAccessRoute(role, path)).toBe(true);
      });
    }
  }
  for (const path of NON_VENDOR_WEBSITE_PATHS) {
    it(`vendor cannot access ${path}`, () => {
      expect(canAccessRoute("vendor", path)).toBe(false);
    });
  }
});

describe("route-policy — Project group access", () => {
  for (const role of PROJECT_ROLES) {
    it(`${role} CAN access /projects`, () => {
      expect(canAccessRoute(role, "/projects")).toBe(true);
    });
  }
  it("website cannot access /projects (프로젝트X)", () => {
    expect(canAccessRoute("website", "/projects")).toBe(false);
    expect(canAccessRoute("website", "/projects/new")).toBe(false);
    expect(canAccessRoute("website", "/projects/sample/prompts")).toBe(false);
  });
  // /projects/new — route-policy keeps vendor OUT (외부 수행사 = 운영자 영구
  // OFF, never operates). Every other role MAY reach the route; the binding
  // create gate is the orthogonal operator authority (operator-policy), not
  // route access.
  for (const role of PROJECT_ROLES.filter((r) => r !== "vendor")) {
    it(`${role} CAN access /projects/new (route level)`, () => {
      expect(canAccessRoute(role, "/projects/new")).toBe(true);
    });
  }
  it("vendor cannot access /projects/new", () => {
    expect(canAccessRoute("vendor", "/projects/new")).toBe(false);
  });

  // Project detail dynamic routes — fall through to /projects (PROJECT_VIEWERS).
  // Per-project access (Owner/Viewer) is enforced at the data layer.
  it("project detail sub-paths inherit /projects access", () => {
    for (const role of PROJECT_ROLES) {
      expect(canAccessRoute(role, "/projects/sample/customer-interest")).toBe(true);
      expect(canAccessRoute(role, "/projects/sample/prompts")).toBe(true);
      expect(canAccessRoute(role, "/projects/sample/answers")).toBe(true);
      expect(canAccessRoute(role, "/projects/sample/members")).toBe(true);
    }
  });
});

describe("route-policy — Admin group access", () => {
  const adminPaths = [
    "/admin",
    "/admin/standards/prompts",
    "/admin/standards/customer-interest",
    "/admin/standards/entities",
    "/admin/standards/citation-sources",
    "/admin/analysis",
    "/admin/reports",
    "/admin/credits",
  ];
  for (const path of adminPaths) {
    it(`admin CAN access ${path}`, () => {
      expect(canAccessRoute("admin", path)).toBe(true);
    });
    for (const role of ["hq", "region", "country", "vendor", "website"] as Role[]) {
      it(`${role} cannot access ${path}`, () => {
        expect(canAccessRoute(role, path)).toBe(false);
      });
    }
  }
});

describe("route-policy — visibleRoutes (SNB list)", () => {
  it("vendor sees only Projects (Project group only — members are per-project)", () => {
    expect(visibleRoutes("vendor").map((r) => r.path)).toEqual(["/projects"]);
  });

  it("website sees only the Website group ([글로벌X, 웹O, 프로젝트X])", () => {
    expect(visibleRoutes("website").map((r) => r.path)).toEqual(
      VISIBLE_WEBSITE_PATHS,
    );
  });

  it("hq/region/country see standard (sans hidden customer-interest) + website + projects", () => {
    for (const role of ["hq", "region", "country"] as Role[]) {
      expect(visibleRoutes(role).map((r) => r.path)).toEqual([
        ...VISIBLE_STANDARD_PATHS,
        ...VISIBLE_WEBSITE_PATHS,
        "/projects",
      ]);
    }
  });

  // 2026-10-28: no role sees a hidden menu (the menu = the production web's + AI Visibility).
  it("admin sees 표준 + website + /projects + admin routes", () => {
    expect(visibleRoutes("admin").map((r) => r.path)).toEqual([
      ...VISIBLE_STANDARD_PATHS,
      ...VISIBLE_WEBSITE_PATHS,
      "/projects",
      "/admin",
      "/admin/standards",
      "/admin/standards/prompts",
      "/renewal/admin",
      "/renewal/admin/standards/prompts",
      "/renewal/admin/standards/citation-sources",
      "/renewal/admin/ga4",
      "/admin/standards/customer-interest",
      "/admin/standards/entities",
      "/admin/standards/citation-sources",
      "/admin/keyword-tools",
      "/admin/ga4",
      "/admin/analysis",
      "/admin/reports",
      "/admin/credits",
    ]);
  });
});

describe("route-policy — visibleGroups (GNB tab list)", () => {
  it("admin sees all four 1depth groups", () => {
    expect(visibleGroups("admin")).toEqual([
      "standard",
      "website",
      "project",
      "admin",
    ]);
  });
  it("hq/region/country see standard + website + project (no admin)", () => {
    for (const role of ["hq", "region", "country"] as Role[]) {
      expect(visibleGroups(role)).toEqual(["standard", "website", "project"]);
    }
  });
  it("vendor sees only project", () => {
    expect(visibleGroups("vendor")).toEqual(["project"]);
  });
  it("website sees only website (GNB 나머지 숨김)", () => {
    expect(visibleGroups("website")).toEqual(["website"]);
  });
});

describe("route-policy — groupForPath", () => {
  it("matches the group of the resolved route", () => {
    expect(groupForPath("/dashboard", "hq")).toBe("standard");
    expect(groupForPath("/customer-interest/google-keywords", "hq")).toBe("standard");
    expect(groupForPath("/projects", "vendor")).toBe("project");
    expect(groupForPath("/projects/sample/members", "hq")).toBe("project");
    expect(groupForPath("/admin/standards/prompts", "admin")).toBe("admin");
  });
  it("falls back to the role's first visible group on unmatched paths", () => {
    expect(groupForPath("/no-access", "vendor")).toBe("project");
    expect(groupForPath("/no-access", "hq")).toBe("standard");
    expect(groupForPath("/no-access", "website")).toBe("website");
  });
});

describe("route-policy — locale prefix handling", () => {
  it("strips /ko and /en prefix before matching", () => {
    expect(canAccessRoute("hq", "/ko/dashboard")).toBe(true);
    expect(canAccessRoute("hq", "/en/dashboard")).toBe(true);
    expect(canAccessRoute("vendor", "/ko/dashboard")).toBe(false);
  });

  it("handles trailing slash", () => {
    expect(canAccessRoute("hq", "/ko/dashboard/")).toBe(true);
  });

  it("keeps old customer-interest deep links guard-compatible", () => {
    expect(canAccessRoute("hq", "/ko/customer-interest/google-keywords")).toBe(true);
    expect(canAccessRoute("hq", "/ko/customer-interest/social-scraping")).toBe(true);
    expect(canAccessRoute("vendor", "/ko/customer-interest/google-keywords")).toBe(false);
  });

  it("nested admin sub-routes resolve to most-specific entry", () => {
    expect(canAccessRoute("admin", "/ko/admin/standards/prompts")).toBe(true);
    expect(canAccessRoute("region", "/ko/admin/standards/prompts")).toBe(false);
    expect(canAccessRoute("hq", "/ko/projects/sample/customer-interest")).toBe(true);
    expect(canAccessRoute("vendor", "/ko/projects/sample/members")).toBe(true);
  });
});

describe("route-policy — guard bypass and default landing", () => {
  it("/no-access bypasses the guard for any role", () => {
    expect(isGuardBypass("/no-access")).toBe(true);
    expect(isGuardBypass("/ko/no-access")).toBe(true);
    for (const role of roles) {
      expect(canAccessRoute(role, "/ko/no-access")).toBe(true);
    }
  });

  it("unknown paths under (dash) default-deny", () => {
    expect(canAccessRoute("admin", "/unknown-page")).toBe(false);
  });

  it("defaultLandingFor matches the first visible route", () => {
    expect(defaultLandingFor("hq")).toBe("/dashboard");
    expect(defaultLandingFor("region")).toBe("/dashboard");
    expect(defaultLandingFor("country")).toBe("/dashboard");
    expect(defaultLandingFor("admin")).toBe("/dashboard");
    expect(defaultLandingFor("vendor")).toBe("/projects");
    expect(defaultLandingFor("website")).toBe("/website");
  });
});

describe("route-policy — ROUTES table integrity", () => {
  it("exposes 44 routes (renewal Overview / Global prompts / ACR / Mention / Citation / AI Visibility / AI Conversion, HUB accounts, global prompts, GA4 registry and source corrections, production Admin 분석 엔진 / 리포트 관리 / 측정 크레딧 추가)", () => {
    expect(ROUTES).toHaveLength(44);
  });

  it("renewal pages open to exactly the roles of their originals", () => {
    for (const [renewal, original] of [
      ["/renewal/dashboard", "/dashboard"],
      ["/renewal/standard/prompts", "/standard/prompts"],
      ["/renewal/standard/ai-funnel/acr", "/standard/ai-funnel/acr"],
      ["/renewal/standard/ai-funnel/visibility", "/standard/ai-funnel/visibility"],
      ["/renewal/standard/ai-funnel/conversion", "/standard/ai-funnel/conversion"],
      ["/renewal/admin", "/admin"],
      ["/renewal/admin/standards/prompts", "/admin/standards/prompts"],
      ["/renewal/admin/standards/citation-sources", "/admin/standards/citation-sources"],
      ["/renewal/admin/ga4", "/admin/ga4"],
      ["/renewal/standard/answer-analysis/mention", "/standard/answer-analysis/mention"],
      ["/renewal/standard/answer-analysis/citation", "/standard/answer-analysis/citation"],
      ["/renewal/standard/answer-analysis/citation/prompts", "/standard/answer-analysis/citation/prompts"],
      ["/renewal/standard/answer-analysis/citation/tone-urls", "/standard/answer-analysis/citation/tone-urls"],
    ]) {
      for (const role of roles) {
        expect(canAccessRoute(role, `/ko${renewal}`)).toBe(canAccessRoute(role, original));
      }
    }
    expect(canAccessRoute("admin", "/renewal")).toBe(false);
  });

  // 2026-10-28: the renewal sidebar opens /renewal<path> for every menu item; one without a renewal page
  // is the "not implemented" page, which has no row — it is permitted exactly as its original.
  it("a renewal path without a row of its own is permitted exactly as its original", () => {
    for (const original of ["/website", "/website/prompts", "/website/answer-analysis/mention", "/website/ai-funnel/conversion", "/projects", "/admin", "/admin/keyword-tools", "/admin/credits", "/customer-interest"]) {
      for (const role of [...roles, "local_reader"] as Role[]) {
        expect(canAccessRoute(role, `/ko/renewal${original}`)).toBe(canAccessRoute(role, original));
      }
    }
    expect(canAccessRoute("admin", "/renewal/unknown")).toBe(false);
    expect(canAccessRoute("admin", "/renewal/renewal")).toBe(false);
  });

  it("isMenuPath: an exact row that is not hidden", () => {
    for (const p of ["/dashboard", "/website/prompts", "/standard/ai-funnel/conversion", "/projects", "/admin/credits"]) expect(isMenuPath(p)).toBe(true);
    for (const p of ["/website/prompts/x", "/projects/new", "/customer-interest", "/website/ai-funnel/acr", "/renewal/dashboard", "/nope"]) expect(isMenuPath(p)).toBe(false);
  });

  it("/projects/new is hidden from SNB", () => {
    const wizard = ROUTES.find((r) => r.path === "/projects/new");
    expect(wizard).toBeTruthy();
    expect("hidden" in wizard! ? wizard.hidden : false).toBe(true);
  });

  it("each route key is unique", () => {
    const keys = ROUTES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("each route path is unique", () => {
    const paths = ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("groups are limited to standard / website / project / admin (1depth)", () => {
    const groups = new Set(ROUTES.map((r) => r.group));
    expect(groups).toEqual(
      new Set(["standard", "website", "project", "admin"]),
    );
  });

  it("section field uses aiFunnel / adminStandards", () => {
    const sections = new Set(
      ROUTES.flatMap((r) => ("section" in r ? [r.section] : [])),
    );
    // 2026-06-04: both standard (aiFunnel) and admin (adminStandards)
    // SNB groups dropped their section field — visual grouping now lives
    // entirely in sidebar's *_SUB_ITEMS trees. RouteSection has no
    // remaining usages outside the project-detail virtual section.
    expect(sections).toEqual(new Set());
  });
});

// 계정별 메뉴 그룹 화이트리스트(좁히기 전용, 0039) — role 이 천장, menuGroups 로
// 그 안에서만 축소. role 보다 넓게는 절대 못 준다(권한 상승 방지).
describe("route-policy — menuGroups 좁히기(A)", () => {
  it("null/빈 = 제한 없음(role 기본 그대로)", () => {
    expect(canAccessRoute("hq", "/dashboard", null)).toBe(true);
    expect(canAccessRoute("hq", "/dashboard", [])).toBe(true);
    expect(visibleGroups("hq", null)).toEqual(visibleGroups("hq"));
  });

  it("hq 계정을 project 로 좁히면 프로젝트만 접근", () => {
    expect(canAccessRoute("hq", "/projects", ["project"])).toBe(true);
    expect(canAccessRoute("hq", "/dashboard", ["project"])).toBe(false); // 표준 차단
    expect(canAccessRoute("hq", "/website", ["project"])).toBe(false); // 웹 차단
    expect(visibleGroups("hq", ["project"])).toEqual(["project"]);
  });

  it("role 보다 넓게는 못 준다(권한 상승 방지)", () => {
    // vendor 는 project 만 허용. standard 를 화이트리스트에 넣어도 role 이 막는다.
    expect(canAccessRoute("vendor", "/dashboard", ["standard", "project"])).toBe(false);
    expect(visibleGroups("vendor", ["standard", "project"])).toEqual(["project"]);
  });

  it("화이트리스트에 role 허용 그룹이 하나도 없으면 접근 그룹 0(→ no-access 랜딩)", () => {
    expect(visibleGroups("vendor", ["standard"])).toEqual([]);
    expect(defaultLandingFor("vendor", ["standard"])).toBe("/no-access");
  });

  it("defaultLandingFor 는 좁혀진 첫 그룹으로", () => {
    // hq 기본 랜딩은 표준(/dashboard). project 로 좁히면 /projects.
    expect(defaultLandingFor("hq", ["project"])).toBe("/projects");
  });
});
