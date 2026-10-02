import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { canAccessRoute } from "@/lib/auth/route-policy";

// middleware 전체를 부트하려면 Supabase/Edge 런타임이 필요하다. 여기서 지키려는
// 불변식은 정적으로 확인 가능한 것들이다.
describe("검수 콘솔 라우트 등록", () => {
  it("PUBLIC_PATHS 에 /raw-data-qa 가 있다 — 없으면 검수자가 로그인으로 튕긴다", () => {
    const src = readFileSync("middleware.ts", "utf8");
    const m = src.match(/const PUBLIC_PATHS = \[(.*?)\]/s);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('"/raw-data-qa"');
  });

  it("robots 가 /raw-data-qa 를 막는다", () => {
    expect(readFileSync("app/robots.ts", "utf8")).toContain("/raw-data-qa");
  });

  it("route-policy 는 이 경로를 모른다 — (dash) 밖이므로 등록하지 않는 것이 맞다", () => {
    // 실수로 ROUTES 에 넣으면 (dash) 가드 대상이 되어 의미가 뒤엉킨다.
    // 알려지지 않은 경로는 default-deny 이므로 false 여야 한다.
    for (const role of ["admin", "hq", "vendor"] as const) {
      expect(canAccessRoute(role, "/raw-data-qa")).toBe(false);
      expect(canAccessRoute(role, "/raw-data-qa/answers")).toBe(false);
    }
  });
});
