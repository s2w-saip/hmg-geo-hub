import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CatalogPage, CatalogPageQuery, CatalogRowsPage } from "@/lib/standards/catalog-page";

// 관리자 표준 프롬프트 목록 — 첫 페이지 하이드레이션 재조회 판정(B077)과 엑셀(CSV) 내보내기 묶음(B078).
// 서버 액션 모듈은 DB·Scope 를 물고 있어 대역으로 둔다. 페이지 읽기 훅(usePagedQuery)은 받은 인자
// (첫 페이지·질의·하이드레이션 뒤 재조회 여부)를 기록하는 대역: 정적 렌더러는 effect 를 돌리지 않는다.

const paged = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../../_actions", () => ({
  setStandardPromptKind: vi.fn(),
  softDeleteStandardPrompt: vi.fn(),
  restoreStandardPrompt: vi.fn(),
  updateStandardPromptText: vi.fn(),
  updateStandardPromptLabels: vi.fn(),
  updateStandardPromptRegions: vi.fn(),
}));
vi.mock("@/app/[locale]/(dash)/standard/prompts/_actions", () => ({ fetchPromptAuditTimeline: vi.fn() }));
vi.mock("@/hooks/use-paged-query", () => ({
  usePagedQuery: (...args: unknown[]) => {
    paged.calls.push(args);
    return { data: args[0], error: null, loading: false };
  },
}));

const { StandardPromptList, exportCatalogRows } = await import("./prompt-list");
type Row = Parameters<typeof StandardPromptList>[0]["rows"][number];

const row = (text: string): Row => ({
  id: `id-${text}`, text, promptType: null, category: null, brand: "Hyundai", brandPresence: "branded", listType: "Brand Message",
  depth1: "D1", depth2: null, depth3: null, depth4: null, funnelStage: "인지/탐색", regions: ["KR"], lang: "KO", kind: "single",
  scopePromptId: `scope-${text}`, scopeText: null, deletedAt: null,
});
const STATS = { total: 4, tracked: 4, untracked: 0, scopeOrphans: 0, acr: 0, deleted: 0 };

// Korean ICU puts Hangul before Latin, English ICU the other way round.
const texts = ["b row", "가 행", "a row", "나 행"];
const koOrder = [...texts].sort(new Intl.Collator("ko").compare);
const enOrder = [...texts].sort(new Intl.Collator("en").compare);
const page = (order: string[], collation?: "ko" | "en"): CatalogPage => ({
  rows: order.map(row) as unknown as CatalogPage["rows"], total: order.length, count: order.length, offset: 0, limit: 200,
  facets: { depth1: ["D1"], funnel: [] }, columns: [], stats: null, ...(collation ? { collation } : {}),
});

/** The browser's default comparator (Intl.Collator() without locales) for one render. */
function asBrowser<T>(locale: string, fn: () => T): T {
  const Real = Intl.Collator;
  const Collator = Object.assign(
    function (locales?: string | string[], options?: Intl.CollatorOptions) { return new Real(locales ?? locale, options); },
    { supportedLocalesOf: Real.supportedLocalesOf },
  );
  Object.defineProperty(Intl, "Collator", { value: Collator, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(Intl, "Collator", { value: Real, configurable: true, writable: true });
  }
}

function render(initial: CatalogPage, browser: string) {
  paged.calls = [];
  const load = vi.fn(), rows = vi.fn();
  const html = asBrowser(browser, () => renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <StandardPromptList rows={initial.rows as unknown as Row[]} stats={STATS} markets={[]} remote={{ initial, load, rows }} />
    </NextIntlClientProvider>,
  ));
  const [first, , query, reread] = paged.calls.at(-1) as [CatalogPage, unknown, CatalogPageQuery, boolean];
  expect(first).toBe(initial);
  const at = texts.map((t) => [t, html.indexOf(`>${t}<`)] as const);
  expect(at.every(([, i]) => i >= 0)).toBe(true);
  const shown = at.sort((a, b) => a[1] - b[1]).map(([t]) => t);
  return { shown, query, reread, load, rows };
}

describe("first page after hydration (B077): re-read only when the browser sorts otherwise than the server read", () => {
  it("a Korean browser and a Korean server read: the first render is the Korean ICU order and it is not read again", () => {
    expect(koOrder).not.toEqual(enOrder);
    const { shown, query, reread, load, rows } = render(page(koOrder, "ko"), "ko-KR");
    expect(shown).toEqual(koOrder);
    expect(query.collation).toBe("ko");
    expect(reread).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(rows).not.toHaveBeenCalled();
  });

  it("a Korean browser and an English server read (the admin render today): re-read in Korean order, as before", () => {
    const { query, reread } = render(page(enOrder, "en"), "ko-KR");
    expect([query.collation, reread]).toEqual(["ko", true]);
  });

  it("an English browser: no re-read of an English read, a re-read of a Korean one", () => {
    expect(render(page(enOrder, "en"), "en-US")).toMatchObject({ shown: enOrder, reread: false, query: { collation: "en" } });
    expect(render(page(koOrder, "ko"), "en-US")).toMatchObject({ reread: true, query: { collation: "en" } });
  });

  it("a first page without a reported collation keeps the former rule: Korean browsers re-read, others do not", () => {
    expect(render(page(enOrder), "ko-KR").reread).toBe(true);
    expect(render(page(enOrder), "en-US").reread).toBe(false);
  });
});

describe("CSV export (B078): every filtered row in server order, in 5,000-row batches through the rows-only reader", () => {
  const all = Array.from({ length: 12005 }, (_, i) => ({ id: `r${i}`, text: `prompt ${i}` })) as unknown as CatalogPage["rows"];
  const query: CatalogPageQuery = { filters: { view: "active", depth1: "D1" }, sort: "text", asc: false, offset: 96, limit: 200, collation: "ko" };
  const reader = (reads: { offset: number; limit: number }[]) => async (q: CatalogPageQuery): Promise<CatalogRowsPage> => {
    const { offset = 0, limit = 0, ...rest } = q;
    expect(rest).toEqual({ filters: query.filters, sort: "text", asc: false, collation: "ko" });
    reads.push({ offset, limit });
    return { rows: all.slice(offset, offset + limit), total: all.length, offset, limit };
  };
  const pageLoader = (reads: { offset: number; limit: number }[]) => {
    const rows = reader(reads);
    return async (q: CatalogPageQuery): Promise<CatalogPage> => ({ ...(await rows(q)), count: all.length, facets: {}, columns: [] });
  };

  it("the same rows in the same order as 500-row pages, in a tenth of the reads", async () => {
    const batched: { offset: number; limit: number }[] = [], pages: { offset: number; limit: number }[] = [], unused: { offset: number; limit: number }[] = [];
    const initial = page(koOrder, "ko");
    const big = await exportCatalogRows({ initial, load: pageLoader(unused), rows: reader(batched) }, query);
    const small = await exportCatalogRows({ initial, load: pageLoader(pages) }, query);
    expect(big).toEqual(all);
    expect(small).toEqual(big);
    expect(batched).toEqual([0, 5000, 10000].map((offset) => ({ offset, limit: 5000 })));
    expect(unused).toEqual([]);
    expect(pages).toEqual(Array.from({ length: 25 }, (_, i) => ({ offset: i * 500, limit: 500 })));
  });

  it("a failed batch rejects the whole export (the list then shows its existing exportFailed message)", async () => {
    const failure = new Error("read failed");
    const rows = vi.fn().mockResolvedValueOnce({ rows: all.slice(0, 5000), total: all.length, offset: 0, limit: 5000 }).mockRejectedValueOnce(failure);
    await expect(exportCatalogRows({ initial: page(koOrder, "ko"), load: vi.fn(), rows }, query)).rejects.toBe(failure);
    expect(rows).toHaveBeenCalledTimes(2);
  });
});
