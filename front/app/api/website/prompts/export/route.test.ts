/**
 * `GET /api/website/prompts/export` — 권한 게이트와 파라미터 파생 계약.
 *
 * 이 라우트를 테스트하는 이유의 절반은 **menuGroups** 다. `canAccessRoute` 는
 * 3번째 인자를 생략하면 `groupAllowed` 가 무조건 true 를 돌려준다
 * (lib/auth/route-policy.ts:335-338) — 즉 인자를 빼도 role 만 맞으면 200 이 나고,
 * 계정별 메뉴 화이트리스트가 **통째로 무력화된 채 조용히 동작**한다. 페이지는
 * DashLayout(app/[locale]/(dash)/layout.tsx:121)이 이미 3인자로 판정한 뒤라
 * 2인자로 불러도 되지만, 라우트 핸들러에는 그 레이아웃이 없다.
 * 아래 "menuGroups 가 막는다" 케이스는 3번째 인자를 빼면 **반드시 실패한다**.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "@/lib/auth/types";

const getSession = vi.hoisted(() => vi.fn());
const listWebsitePromptsForExport = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({ getSession }));
// 질의만 갈아끼운다 — WEBSITE_PROMPT_SORT_KEYS 같은 상수는 **실물을 써야**
// 정렬 화이트리스트 테스트가 진짜 화이트리스트를 검증한다(사본이면 드리프트).
vi.mock("@/lib/db/repositories/website-sites", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/repositories/website-sites")>()),
  listWebsitePromptsForExport,
}));
// next-intl 의 서버 헬퍼는 빌드 타임 alias(`next-intl/config` → i18n/request.ts)에
// 의존해 vitest 에서 해석되지 않는다. 라벨 자체는 website-prompts-query.test.ts 가
// ko/en 키 집합으로 고정하므로, 여기서는 키를 그대로 돌려주는 스텁으로 둔다.
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const session = (over: Partial<Session["user"]> = {}): Session => ({
  user: {
    id: "u1",
    email: "u@hmg.test",
    role: "admin",
    scope: { all: true },
    operator: "none",
    menuGroups: null,
    ...over,
  },
});

const call = async (qs = "") => {
  const { GET } = await import("./route");
  return GET(
    new Request(`http://t/api/website/prompts/export${qs}`) as never,
  );
};

beforeEach(() => {
  getSession.mockReset();
  listWebsitePromptsForExport.mockReset();
  listWebsitePromptsForExport.mockResolvedValue({ rows: [], truncated: false });
});

describe("GET /api/website/prompts/export — 권한", () => {
  it("세션이 없으면 401 이고 질의하지 않는다", async () => {
    getSession.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(listWebsitePromptsForExport).not.toHaveBeenCalled();
  });

  it("role 이 그 라우트를 못 보면 403", async () => {
    // vendor = 프로젝트 메뉴 전용 — /website/prompts 의 WEBSITE_VIEWERS 에 없다.
    getSession.mockResolvedValue(session({ role: "vendor", scope: { all: false, brands: ["Kia"] } }));
    const res = await call();
    expect(res.status).toBe(403);
    expect(listWebsitePromptsForExport).not.toHaveBeenCalled();
  });

  it("role 은 되는데 계정 menuGroups 가 website 를 빼면 403", async () => {
    // ⚠️ canAccessRoute 의 3번째 인자를 빼면 이 케이스가 200 이 되어 실패한다.
    getSession.mockResolvedValue(
      session({ role: "hq", menuGroups: ["standard"] }),
    );
    const res = await call();
    expect(res.status).toBe(403);
    expect(listWebsitePromptsForExport).not.toHaveBeenCalled();
  });

  it("menuGroups 가 website 를 포함하면 통과한다 (403 이 화이트리스트에서 온 것임을 확인)", async () => {
    getSession.mockResolvedValue(session({ role: "hq", menuGroups: ["website"] }));
    const res = await call();
    expect(res.status).toBe(200);
  });
});

describe("GET /api/website/prompts/export — 응답 계약", () => {
  beforeEach(() => {
    getSession.mockResolvedValue(session());
  });

  it("xlsx 바이트 + no-store + attachment 헤더로 응답한다", async () => {
    listWebsitePromptsForExport.mockResolvedValue({
      rows: [
        {
          id: "p1",
          promptText: "제네시스 GV80 가격",
          brand: "Genesis",
          countryCode: "KR",
          langCode: "ko",
          targetUrl: "https://genesis.com/kr",
          domain: "genesis.com",
          answers: 4,
          lastMeasuredAt: "2026-09-08T00:00:00.000Z",
          engines: ["chatgpt", "gemini"],
        },
      ],
      truncated: false,
    });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toContain("spreadsheetml");
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd.startsWith("attachment;")).toBe(true);
    // 헤더 값은 ByteString 이어야 한다 — 비 ASCII 가 그대로 들어가면 500 이 난다
    // (2026-09-03 실증). attachmentContentDisposition 이 이것을 보장한다.
    expect(/^[\x20-\x7e]*$/.test(cd)).toBe(true);
    // PK.. = zip 매직. 실제 워크북 바이트인지 확인(직렬화가 조용히 비지 않았나).
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });

  it("상한에 닿으면 X-Export-Truncated 로 알린다 (조용히 자르지 않는다)", async () => {
    listWebsitePromptsForExport.mockResolvedValue({ rows: [], truncated: true });
    const res = await call();
    expect(res.headers.get("X-Export-Truncated")).toBe("true");
  });

  it("에러 응답에는 Content-Disposition 이 없다 — 버튼이 <a download> 를 안 쓰는 근거", async () => {
    // 이 둘은 한 세트다. 에러에 attachment 헤더가 붙거나 앵커에 download 가
    // 붙으면, 401/403/500 의 JSON 이 `.xlsx` 인 양 디스크에 떨어져 사용자에겐
    // "열리지 않는 엑셀"로만 보인다(2026-09-16 검증자 F3).
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    getSession.mockResolvedValue(null);
    expect((await call()).headers.get("Content-Disposition")).toBeNull();

    getSession.mockResolvedValue(session({ role: "hq", menuGroups: ["standard"] }));
    expect((await call()).headers.get("Content-Disposition")).toBeNull();

    getSession.mockResolvedValue(session());
    listWebsitePromptsForExport.mockRejectedValue(new Error("boom"));
    expect((await call()).headers.get("Content-Disposition")).toBeNull();
    spy.mockRestore();
  });

  it("질의가 던지면 500 JSON (스택을 그대로 흘리지 않는다)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    listWebsitePromptsForExport.mockRejectedValue(new Error("boom"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "export failed" });
    spy.mockRestore();
  });
});

describe("GET /api/website/prompts/export — scope 전달", () => {
  // 급소: 아래 "필터 파생" 케이스들은 전부 **2번째 인자(filters)** 만 본다.
  // 그래서 라우트가 `session.user.scope` 대신 `{ all: true }` 를 넘기도록
  // 바꿔도(= 권한 상승) 전 스위트가 그린이었다(2026-09-16 검증자 뮤테이션).
  // scope 는 listWebsitePromptsForExport 의 default-deny 하드락이 걸리는
  // **1번째 인자**다 — 그것을 직접 단언한다.
  const scopeArgOf = () => listWebsitePromptsForExport.mock.calls[0][0];

  it("세션 scope 객체가 그대로 1번째 인자로 간다 (admin)", async () => {
    const s = session();
    getSession.mockResolvedValue(s);
    await call("?geography=KR");
    expect(scopeArgOf()).toEqual(s.user.scope);
  });

  it("브랜드 제한 롤의 scope 가 admin scope 로 넓어지지 않는다", async () => {
    const s = session({
      role: "hq",
      scope: { all: false, brands: ["Genesis"] },
    });
    getSession.mockResolvedValue(s);
    await call();
    expect(scopeArgOf()).toEqual({ all: false, brands: ["Genesis"] });
    // 권한 상승 뮤테이션의 정확한 지문
    expect(scopeArgOf()).not.toEqual({ all: true });
    expect(scopeArgOf().all).toBe(false);
  });

  it("국가 제한 롤의 scope 도 국가까지 그대로 간다", async () => {
    const s = session({
      role: "country",
      scope: { all: false, brands: ["Kia"], countries: ["KR"] },
    });
    getSession.mockResolvedValue(s);
    await call("?geography=US");
    expect(scopeArgOf()).toEqual({ all: false, brands: ["Kia"], countries: ["KR"] });
    expect(scopeArgOf().all).toBe(false);
    expect(scopeArgOf().countries).toEqual(["KR"]);
  });

  it("롤마다 서로 다른 scope 가 간다 (한 값으로 고정돼 있지 않다)", async () => {
    const a = session({ role: "hq", scope: { all: false, brands: ["Genesis"] } });
    getSession.mockResolvedValue(a);
    await call();
    const first = listWebsitePromptsForExport.mock.calls[0][0];

    const b = session({ role: "country", scope: { all: false, brands: ["Kia"], countries: ["KR"] } });
    getSession.mockResolvedValue(b);
    await call();
    const second = listWebsitePromptsForExport.mock.calls[1][0];

    expect(first).not.toEqual(second);
    expect(first).toEqual(a.user.scope);
    expect(second).toEqual(b.user.scope);
  });
});

describe("GET /api/website/prompts/export — 필터 파생", () => {
  beforeEach(() => {
    getSession.mockResolvedValue(session());
  });

  it("다중 선택(같은 키 반복)이 배열로 살아남는다", async () => {
    // Next 의 서버 searchParams 는 중복 키를 배열로 준다. 라우트가 forEach 로
    // 평탄화하면 **마지막 값만** 남아 화면과 갈린다 — 그 회귀를 여기서 잡는다.
    await call("?geography=KR&geography=US&engine=chatgpt&engine=gemini");
    const [, filters] = listWebsitePromptsForExport.mock.calls[0];
    expect(filters.countries).toEqual(["KR", "US"]);
    expect(filters.engines).toEqual(["chatgpt", "gemini"]);
  });

  it("구분자 인코딩(FILTER_SEP)도 같은 결과를 낸다", async () => {
    await call("?geography=KR~US");
    const [, filters] = listWebsitePromptsForExport.mock.calls[0];
    expect(filters.countries).toEqual(["KR", "US"]);
  });

  it("정렬·검색·기간을 화면과 같은 규약으로 넘긴다", async () => {
    await call("?sort=brand&dir=asc&q=GV80&time=2026-09-01..2026-09-08");
    const [, filters, opts] = listWebsitePromptsForExport.mock.calls[0];
    expect(opts).toEqual({ sort: "brand", dir: "asc" });
    expect(filters.search).toBe("GV80");
    expect(filters.dateFrom).toBe("2026-09-01");
    expect(filters.dateTo).toBe("2026-09-08");
  });

  it("정렬 키 화이트리스트 밖이면 기본값으로 떨어진다", async () => {
    await call("?sort=wp.id%3B%20DROP&dir=sideways");
    const [, , opts] = listWebsitePromptsForExport.mock.calls[0];
    expect(opts).toEqual({ sort: "lastMeasuredAt", dir: "desc" });
  });

  it("?page 는 무시된다 — 내보내기는 정의상 전량이다", async () => {
    await call("?page=7");
    const [, , opts] = listWebsitePromptsForExport.mock.calls[0];
    expect(opts).not.toHaveProperty("page");
  });

  it("비 admin 의 brand 축은 URL 이 아니라 scope 가 결정한다 (D4 하드락)", async () => {
    getSession.mockResolvedValue(
      session({ role: "country", scope: { all: false, brands: ["Kia"], countries: ["KR"] } }),
    );
    await call("?brand=Genesis");
    const [, filters] = listWebsitePromptsForExport.mock.calls[0];
    expect(filters.brands).toContain("Kia");
    expect(filters.brands).not.toContain("Genesis");
  });
});
