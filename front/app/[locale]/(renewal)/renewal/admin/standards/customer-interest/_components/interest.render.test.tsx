import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { InterestSourceListing, InterestSourceRow, KeywordListing, KeywordRow } from "./interest-api";
import {
  ALL,
  COMMON,
  DEFAULT_KEYWORD_FILTER,
  DEFAULT_SOURCE_FILTER,
  conditionKey,
  conditionLabel,
  conditionOfKey,
  keywordCounts,
  keywordFilterToQuery,
  keywordMarkets,
  keywordMatches,
  keywordProblems,
  queryToKeywordFilter,
  queryToSourceFilter,
  sortKeywords,
  sortSources,
  sourceCounts,
  sourceFilterToQuery,
  sourceKeyOf,
  sourceMatches,
  tabOf,
} from "./interest-model";

// Admin › 고객 관심 데이터 관리 (2026-11-02): each tab as first rendered (the HUB's list next to Gold's values, a source
// never reads as applied, the tab bar, the forms) and the pure filter / input models.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/ko/renewal/admin/standards/customer-interest",
}));

const { InterestKeywordsManager, KeywordForm } = await import("./interest-keywords-manager");
const { InterestSourcesManager, SourceForm } = await import("./interest-sources-manager");
const { InterestTabs } = await import("./interest-tabs");

const html = (ui: ReactElement, locale: "ko" | "en" = "ko") =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      {ui}
    </NextIntlClientProvider>,
  );
const rowOf = (out: string, attr: string, key: string) => {
  const from = out.indexOf(`${attr}="${key}"`);
  return out.slice(from, out.indexOf("</tr>", from));
};
const keysOf = (out: string, attr: string) => [...out.matchAll(new RegExp(`${attr}="([^"]+)"`, "g"))].map(([, k]) => k);

const PUBLISHED = { version: 3, items: 84, changeSeq: 57001, recordedAt: "2026-11-02T05:00:00Z" };
const KR = { location_code: 2410, language_code: "ko" };
const US = { location_code: 2840, language_code: "en" };
const keyword = (over: Partial<KeywordRow>): KeywordRow => ({
  term: "SUV",
  termNorm: "suv",
  conditions: [KR],
  sourceTypes: ["google_keyword"],
  brands: [],
  note: null,
  status: "active",
  origin: "gold_import",
  updatedAt: "2026-11-02T05:00:00Z",
  gold: { conditions: [{ ...KR, observedAt: "2026-10-07T11:25:53Z" }], observedAt: "2026-10-07T11:25:53Z" },
  collected: 1,
  state: "applied",
  ...over,
});
const KEYWORDS: KeywordListing = {
  published: PUBLISHED,
  items: [
    keyword({}),
    keyword({ term: "패밀리 SUV", termNorm: "패밀리 suv", conditions: [KR, US], sourceTypes: ["google_keyword", "community_voc"], brands: ["Kia"], origin: "hub", collected: 1, state: "pending" }),
    keyword({ term: "중고차", termNorm: "중고차", status: "stopped", state: null }),
    keyword({ term: "EV9", termNorm: "ev9", sourceTypes: [], status: null, origin: null, updatedAt: null, state: "upstream" }),
  ],
};
const source = (over: Partial<InterestSourceRow>): InterestSourceRow => ({
  key: "reddit.com/r/cars",
  url: "https://www.reddit.com/r/cars/",
  host: "reddit.com",
  channel: "community",
  brands: ["Kia"],
  note: null,
  status: "active",
  updatedAt: "2026-11-02T05:00:00Z",
  gold: { entities: 1161, mentions: 6796 },
  state: "observed",
  ...over,
});
const SOURCES: InterestSourceListing = {
  snapshot: { takenAt: "2026-07-07", sources: 606 },
  published: PUBLISHED,
  items: [
    source({}),
    source({ key: "newsite.example", url: "newsite.example", host: "newsite.example", channel: "news", brands: [], gold: null, state: "unseen" }),
    source({ key: "gall.dcinside.com", url: "gall.dcinside.com", host: "gall.dcinside.com", channel: null, brands: [], status: null, updatedAt: null, gold: { entities: 995, mentions: 7128 }, state: "upstream" }),
  ],
};

describe("InterestKeywordsManager", () => {
  const out = html(<InterestKeywordsManager initial={KEYWORDS} />);

  it("lists the HUB's keywords next to Gold's collection, with no 'saved = applied' wording", () => {
    expect(keysOf(out, "data-hub-keyword-row")).toEqual(["중고차", "패밀리 suv", "ev9", "suv"]); // the Korean collation
    expect(out).toContain("업스트림 목록 v3 · 84건");
    expect(out).toContain("HUB 데이터 DB");
    expect(out).toContain("interest_keyword");
    expect(out).not.toContain("즉시 반영");
    expect(out).toContain("4 / 4개 · 활성 2 · 중지 1 · 반영 대기 1 · 업스트림 1");
  });

  it("shows how many conditions Gold holds, and the state of each kind of row", () => {
    const partial = rowOf(out, "data-hub-keyword-row", "패밀리 suv");
    expect(partial).toContain('data-hub-keyword-state="pending"');
    expect(partial).toContain("1/2 · 2026-10-07");
    expect(partial).toContain("한국 · ko 외 1개");
    expect(partial).toContain("Kia");
    expect(rowOf(out, "data-hub-keyword-row", "suv")).toContain("공통");
    expect(rowOf(out, "data-hub-keyword-row", "suv")).toContain('data-hub-keyword-state="applied"');
    expect(rowOf(out, "data-hub-keyword-row", "중고차")).toContain('data-hub-keyword-state=""');
    expect(rowOf(out, "data-hub-keyword-row", "중고차")).toContain("재개");
  });

  it("offers an upstream keyword to take over instead of the row's actions", () => {
    const upstream = rowOf(out, "data-hub-keyword-row", "ev9");
    expect(upstream).toContain("data-hub-keyword-adopt");
    expect(upstream).not.toContain("data-hub-keyword-toggle");
    expect(upstream).not.toContain("공통");
  });

  it("renders in English too", () => {
    expect(html(<InterestKeywordsManager initial={KEYWORDS} />, "en")).toContain("South Korea · ko and 1 more");
  });
});

describe("InterestSourcesManager", () => {
  const out = html(<InterestSourcesManager initial={SOURCES} />);

  it("orders by the corpus and never says a source was applied", () => {
    expect(keysOf(out, "data-hub-source-row")).toEqual(["gall.dcinside.com", "reddit.com/r/cars", "newsite.example"]);
    expect(out).toContain("Gold 소셜 스냅샷 2026-07-07 · 출처 606개");
    expect(out).toContain("읽는 수집기가 없어");
    expect(out).not.toContain("반영됨");
    expect(out).not.toContain("반영 대기");
    expect(out).toContain("3 / 3개 · 활성 2 · 중지 0 · HUB 미등록 1");
  });

  it("shows the row kinds", () => {
    expect(rowOf(out, "data-hub-source-row", "reddit.com/r/cars")).toContain('data-hub-source-state="observed"');
    expect(rowOf(out, "data-hub-source-row", "reddit.com/r/cars")).toContain("6,796");
    expect(rowOf(out, "data-hub-source-row", "newsite.example")).toContain('data-hub-source-state="unseen"');
    const upstream = rowOf(out, "data-hub-source-row", "gall.dcinside.com");
    expect(upstream).toContain('data-hub-source-state="upstream"');
    expect(upstream).toContain("data-hub-source-adopt");
    expect(upstream).not.toContain("data-hub-source-toggle");
  });
});

describe("forms and tabs", () => {
  it("adds a keyword with the presets by region; an edit keeps the term", () => {
    const add = html(<KeywordForm initial={{ term: "", conditions: [], sourceTypes: ["google_keyword"], brands: [], note: "" }} editing={false} exists={() => false} onSaved={() => {}} onCancel={() => {}} />);
    expect(add).toContain('data-hub-keyword-form="add"');
    expect(add).toContain("data-hub-keyword-term");
    expect(add).toContain("아시아");
    expect(add).toContain("한국");
    const edit = html(<KeywordForm initial={{ term: "SUV", conditions: [KR, { location_code: 9999, language_code: "xx" }], sourceTypes: ["google_keyword"], brands: ["Kia"], note: "메모" }} editing exists={() => false} onSaved={() => {}} onCancel={() => {}} />);
    expect(edit).toContain('data-hub-keyword-form="edit"');
    expect(edit).not.toContain("data-hub-keyword-term");
    expect(edit).toContain("9999 · xx"); // a stored condition outside the presets stays visible
  });

  it("adds a source; an edit keeps the URL", () => {
    const add = html(<SourceForm initial={{ url: "", channel: "community", brands: [], note: "" }} editing={false} exists={() => false} onSaved={() => {}} onCancel={() => {}} />);
    expect(add).toContain('data-hub-source-form="add"');
    expect(add).toContain("data-hub-source-url");
    expect(html(<SourceForm initial={{ url: "arca.live", channel: "news", brands: [], note: "" }} editing exists={() => false} onSaved={() => {}} onCancel={() => {}} />)).not.toContain("data-hub-source-url");
  });

  it("has the two tabs", () => {
    const out = html(<InterestTabs value="sources" />);
    expect(out).toContain("키워드");
    expect(out).toContain("수집 소스");
    expect(tabOf("sources")).toBe("sources");
    expect(tabOf("other")).toBe("keywords");
    expect(tabOf(undefined)).toBe("keywords");
  });

  it("has every message in both languages", () => {
    const shape = (o: unknown): unknown => (typeof o === "object" && o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : "");
    expect(shape(en.hubInterest)).toEqual(shape(ko.hubInterest));
  });
});

describe("models", () => {
  const rows = KEYWORDS.items;

  it("labels a condition by the preset, or by its code", () => {
    expect(conditionLabel(KR, "ko")).toBe("한국 · ko");
    expect(conditionLabel(US, "en")).toBe("United States · en");
    expect(conditionLabel({ location_code: 2410, language_code: "en" }, "ko")).toBe("한국 · en");
    expect(conditionLabel({ location_code: 9999, language_code: "xx" }, "ko")).toBe("9999 · xx");
    expect(conditionOfKey(conditionKey({ location_code: 2158, language_code: "zh-TW" }))).toEqual({ location_code: 2158, language_code: "zh-TW" });
  });

  it("filters keywords on each axis", () => {
    const f = DEFAULT_KEYWORD_FILTER;
    const terms = (filter: typeof f, q = "") => rows.filter((r) => keywordMatches(r, filter, q)).map((r) => r.termNorm);
    expect(terms({ ...f, market: "2840:en" })).toEqual(["패밀리 suv"]);
    expect(terms({ ...f, source: "community_voc" })).toEqual(["패밀리 suv"]);
    expect(terms({ ...f, brand: "Kia" })).toEqual(["패밀리 suv"]);
    expect(terms({ ...f, brand: COMMON })).toEqual(["suv", "중고차"]); // an upstream row has no brand decision
    expect(terms({ ...f, state: "upstream" })).toEqual(["ev9"]);
    expect(terms({ ...f, status: "stopped" })).toEqual(["중고차"]);
    expect(terms(f, " SUV ")).toEqual(["suv", "패밀리 suv"]);
    expect(keywordMarkets(rows)).toEqual(["2840:en", "2410:ko"]);
  });

  it("sorts keywords and counts them", () => {
    const by = (key: Parameters<typeof sortKeywords>[1], asc: boolean) => sortKeywords(rows, key, asc, "ko").map((r) => r.termNorm);
    expect(by("term", true)).toEqual(["중고차", "패밀리 suv", "ev9", "suv"]);
    expect(by("term", false)).toEqual(["suv", "ev9", "패밀리 suv", "중고차"]);
    expect(by("conditions", false)[0]).toBe("패밀리 suv");
    expect(by("state", true)[0]).toBe("패밀리 suv");
    expect(keywordCounts(rows)).toEqual({ total: 4, active: 2, stopped: 1, pending: 1, upstream: 1 });
  });

  it("mirrors the keyword filter in the URL", () => {
    const filters = { ...DEFAULT_KEYWORD_FILTER, market: "2158:zh-TW", brand: COMMON };
    const query = keywordFilterToQuery(filters, " suv ");
    expect(queryToKeywordFilter(query)).toEqual({ filters, search: "suv" });
    expect(keywordFilterToQuery(DEFAULT_KEYWORD_FILTER, "")).toBe("");
    expect(queryToKeywordFilter("market=x&state=nope&source=nope").filters).toEqual(DEFAULT_KEYWORD_FILTER);
  });

  it("filters, sorts and counts sources", () => {
    const f = DEFAULT_SOURCE_FILTER;
    const keys = (filter: typeof f, q = "") => SOURCES.items.filter((r) => sourceMatches(r, filter, q)).map((r) => r.key);
    expect(keys({ ...f, channel: "news" })).toEqual(["newsite.example"]);
    expect(keys({ ...f, state: "upstream" })).toEqual(["gall.dcinside.com"]);
    expect(keys({ ...f, brand: "Kia" })).toEqual(["reddit.com/r/cars"]);
    expect(keys({ ...f, brand: COMMON })).toEqual(["newsite.example"]);
    expect(keys(f, "REDDIT")).toEqual(["reddit.com/r/cars"]);
    expect(sortSources(SOURCES.items, "url", true).map((r) => r.key)).toEqual(["gall.dcinside.com", "newsite.example", "reddit.com/r/cars"]);
    expect(sortSources(SOURCES.items, "state", true).map((r) => r.state)).toEqual(["observed", "unseen", "upstream"]);
    expect(sourceCounts(SOURCES.items)).toEqual({ total: 3, active: 2, stopped: 0, upstream: 1 });
    expect(sourceFilterToQuery({ ...f, channel: "pr" }, "x")).toBe("tab=sources&channel=pr&q=x");
    expect(queryToSourceFilter("tab=sources&channel=pr&state=x").filters).toEqual({ ...f, channel: "pr", state: ALL });
  });

  it("checks the input as the BFF does", () => {
    const ok = { term: "SUV", conditions: [KR], sourceTypes: ["google_keyword"], note: "" };
    expect(keywordProblems(ok)).toEqual([]);
    expect(keywordProblems({ ...ok, term: " " })).toEqual(["term"]);
    expect(keywordProblems({ ...ok, term: "a,b" })).toEqual(["term"]);
    expect(keywordProblems({ ...ok, term: "a (b)" })).toEqual(["term"]);
    expect(keywordProblems({ ...ok, term: "x".repeat(100) })).toEqual(["term"]);
    expect(keywordProblems({ ...ok, conditions: [] })).toEqual(["conditions"]);
    expect(keywordProblems({ ...ok, sourceTypes: [] })).toEqual(["sources"]);
    expect(keywordProblems({ ...ok, note: "x".repeat(501) })).toEqual(["note"]);
    expect(sourceKeyOf(" https://www.Bobaedream.co.kr/List/?a=1#x ")).toBe("bobaedream.co.kr/list");
    expect(sourceKeyOf("reddit.com/r/cars/")).toBe("reddit.com/r/cars");
    for (const bad of ["", "nodot", "a b.example", "https://nodot/x", "."]) expect(sourceKeyOf(bad)).toBeNull();
  });
});
