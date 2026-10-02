import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import u4ko from "@/messages/units/u4.ko.json";

// 옵션 지연 로드(결정 D4·Q7, U4): 패널이 열리기 전에는 호출 0, 축 드롭다운을 처음 열 때 1회.
//
// radix 는 닫힌 메뉴를 그리지 않고 renderToStaticMarkup 은 이벤트를 돌리지 않는다. 그래서
// 드롭다운 프리미티브를 통과 컴포넌트로 갈아 끼워 ① 콘텐츠 트리를 늘 그리고 ② 각 드롭다운의
// onOpenChange 를 붙잡아 "여는 동작"을 테스트에서 직접 부른다.

const opened = vi.hoisted(() => ({ handlers: [] as ((open: boolean) => void)[] }));
vi.mock("@/components/ui/dropdown-menu", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Item = ({ children }: { children?: ReactNode }) => (
    <div role="menuitemcheckbox" aria-checked="false">
      {children}
    </div>
  );
  return {
    DropdownMenu: ({ children, onOpenChange }: { children?: ReactNode; onOpenChange?: (o: boolean) => void }) => {
      if (onOpenChange) opened.handlers.push(onOpenChange);
      return <div>{children}</div>;
    },
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => <div data-testid="menu-content">{children}</div>,
    DropdownMenuCheckboxItem: Item,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: Item,
  };
});

let SEARCH = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/dashboard",
  useSearchParams: () => new URLSearchParams(SEARCH),
}));

const P = await import("@/components/dash/dimension-filter-panel");
const { DimensionFilterPanel } = P;

const messages = {
  ...ko,
  dashboard: { ...ko.dashboard, filters: { ...ko.dashboard.filters, ...u4ko.dashboard.filters } },
};

const PID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const fetchMock = vi.fn(async (_u: string, _init?: RequestInit) =>
  new Response(JSON.stringify({ options: { geographyOptions: ["KR", "US"], languageOptions: ["en"] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
);

beforeEach(() => {
  SEARCH = "";
  opened.handlers.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(props: Parameters<typeof DimensionFilterPanel>[0]): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={messages} timeZone="Asia/Seoul">
      <DimensionFilterPanel {...props} />
    </NextIntlClientProvider>,
  );
}

describe("lazyOptionsUrl: only the URL values that shape options", () => {
  it("area, surface, project_id, time, brand (+ engine on project); nothing else from the URL", () => {
    const sp = new URLSearchParams("time=2026-09-01..2026-09-14&brand=Kia&geography=US&engine=gemini");
    expect(P.lazyOptionsUrl({ area: "analysis", surface: "project", projectId: PID }, sp)).toBe(
      `/api/filters/options?area=analysis&surface=project&project_id=${PID}&time=2026-09-01..2026-09-14&brand=Kia&engine=gemini`,
    );
    expect(P.lazyOptionsUrl({ area: "analysis", surface: "website" }, sp)).toBe(
      "/api/filters/options?area=analysis&surface=website&time=2026-09-01..2026-09-14&brand=Kia",
    );
    expect(P.lazyOptionsUrl({ area: "dashboard", surface: "global" }, new URLSearchParams())).toBe(
      "/api/filters/options?area=dashboard&surface=global",
    );
  });
});

describe("F7: default lazy fields leave dynamic axes to the server", () => {
  it("LAZY_DEFAULT_FIELDS excludes dynamicAxes", () => {
    expect(P.LAZY_DEFAULT_FIELDS).toEqual(["catalogRows", "geographyOptions", "languageOptions", "optionMatrix", "engineOptions"]);
  });
  it("a loaded answer's dynamicAxes are ignored unless fields names them", () => {
    const loaded = { geographyOptions: ["US"], dynamicAxes: [{ id: "f1", label: "Tag", options: ["a"] }] };
    const cfg = { area: "analysis" as const, surface: "project" as const, projectId: PID };
    expect(P.pickLazyField(cfg, loaded, "dynamicAxes")).toBeUndefined();
    expect(P.pickLazyField(cfg, loaded, "geographyOptions")).toEqual(["US"]);
    expect(P.pickLazyField({ ...cfg, fields: ["dynamicAxes"] }, loaded, "dynamicAxes")).toEqual(loaded.dynamicAxes);
    expect(P.pickLazyField({ ...cfg, fields: ["dynamicAxes"] }, loaded, "geographyOptions")).toBeUndefined();
    expect(P.pickLazyField(undefined, loaded, "geographyOptions")).toBeUndefined();
  });
  it("project lazy URL carries the engine selection (legacy engine list depends on it); other surfaces do not", () => {
    const sp = new URLSearchParams("time=2026-09-01..2026-09-14&engine=gemini");
    expect(P.lazyOptionsUrl({ area: "analysis", surface: "project", projectId: PID }, sp)).toContain("&engine=gemini");
    expect(P.lazyOptionsUrl({ area: "analysis", surface: "global" }, sp)).not.toContain("engine=");
  });
  it("server-passed dynamic axes render before any load (a project page keeps passing them)", () => {
    const html = render({
      onlyGroups: ["engine"],
      dynamicAxes: [{ id: "f1", label: "TagAxis", options: ["a"] }],
      lazyOptions: { area: "analysis", surface: "project", projectId: PID },
    });
    expect(html).toContain("TagAxis");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createLazyOptionsRequester: one call per URL", () => {
  it("no call until requested; repeats of the same URL do not call again", async () => {
    const load = vi.fn(async () => ({ geographyOptions: ["US"] }));
    const r = P.createLazyOptionsRequester(load);
    expect(load).not.toHaveBeenCalled();
    const first = r.request("/a");
    expect(first).not.toBeNull();
    expect(r.request("/a")).toBeNull();
    expect(r.request("/a")).toBeNull();
    await first;
    expect(load).toHaveBeenCalledTimes(1);
    // the options window moved (time/brand in the URL changed): one new call
    expect(r.request("/b")).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a failed load is forgotten so the next open retries", async () => {
    const load = vi.fn(async () => {
      throw new Error("503");
    });
    const r = P.createLazyOptionsRequester(load);
    await expect(r.request("/a")).rejects.toThrow("503");
    await expect(r.request("/a")).rejects.toThrow("503");
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("fetchLazyFilterOptions", () => {
  it("keeps well-formed fields, drops the rest; no-store, same-origin", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) =>
      new Response(JSON.stringify({ options: { geographyOptions: ["US", 1], languageOptions: ["en"], engineOptions: "x", optionMatrix: [] } })),
    );
    await expect(P.fetchLazyFilterOptions("/api/filters/options?x", f as unknown as typeof fetch)).resolves.toEqual({
      languageOptions: ["en"],
      optionMatrix: [],
    });
    expect(f.mock.calls[0][1]).toEqual({ cache: "no-store", credentials: "same-origin" });
  });
  it("non-2xx throws", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(P.fetchLazyFilterOptions("/x", f as unknown as typeof fetch)).rejects.toThrow("401");
  });
});

describe("panel wiring: 0 calls before the panel opens, 1 call on the first open", () => {
  it("render alone never calls; opening axis dropdowns calls once with the lazy URL", async () => {
    SEARCH = "time=2026-09-01..2026-09-14&geography=US";
    render({ onlyGroups: ["geography", "language", "engine", "time"], lazyOptions: { area: "dashboard", surface: "global" } });
    expect(fetchMock).not.toHaveBeenCalled();
    // facets (geography, language, engine) register onOpenChange; the time dropdown does not
    expect(opened.handlers.length).toBeGreaterThanOrEqual(3);
    for (const h of opened.handlers) h(false); // closing never loads
    expect(fetchMock).not.toHaveBeenCalled();
    for (const h of opened.handlers) h(true);
    opened.handlers[0](true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/filters/options?area=dashboard&surface=global&time=2026-09-01..2026-09-14");
    await Promise.resolve();
  });

  it("without lazyOptions nothing is fetched and the static fallback lists render as before", () => {
    const html = render({ onlyGroups: ["language"] });
    for (const h of opened.handlers) h(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).not.toContain("data-lazy-options-status");
    // static DIMENSIONS.language fallback (en, ko, fr), labels localized by Intl.DisplayNames
    const lang = new Intl.DisplayNames(["ko"], { type: "language" });
    const item = (code: string) => `<div role="menuitemcheckbox" aria-checked="false">${lang.of(code)}</div>`;
    expect(html).toContain(["en", "ko", "fr"].map(item).join(""));
  });

  it("before the load, lazy-fed axes show the loading row instead of static options", () => {
    const html = render({ onlyGroups: ["geography", "engine"], lazyOptions: { area: "dashboard", surface: "global" } });
    expect(html).toContain('data-lazy-options-status="loading"');
    expect(html).toContain(u4ko.dashboard.filters.optionsLoading);
  });

  it("explicit props win: a passed list is used, no loading row for that axis, fields limits the lazy axes", () => {
    const html = render({
      onlyGroups: ["engine"],
      engineOptions: ["gemini"],
      lazyOptions: { area: "analysis", surface: "project", projectId: PID },
    });
    expect(html).not.toContain("data-lazy-options-status");
    const limited = render({
      onlyGroups: ["engine"],
      lazyOptions: { area: "analysis", surface: "project", projectId: PID, fields: ["dynamicAxes"] },
    });
    expect(limited).not.toContain("data-lazy-options-status"); // engine is not a lazy field here
    const geo = render({ onlyGroups: ["geography"], geographyOptions: ["US"], lazyOptions: { area: "dashboard", surface: "global" } });
    expect(geo).not.toContain("data-lazy-options-status");
  });
});
