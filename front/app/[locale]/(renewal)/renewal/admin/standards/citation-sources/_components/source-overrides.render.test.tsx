import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { SourceListing, SourceRow } from "./source-overrides-api";
import { DEFAULT_FILTER, counts, filterToQuery, matches, queryToFilter, sortRows } from "./source-overrides-model";

// Admin › 인용 출처 분류 (2026-10-30): the list as first rendered (Gold's round with the HUB's corrections, 반영 대기 /
// 반영됨, the owned-domain warning, no '즉시 반영' wording) and its filter / sort model.

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("source=override") }));

const { SourceOverridesManager } = await import("./source-overrides-manager");

const html = (ui: ReactElement) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {ui}
    </NextIntlClientProvider>,
  );

const row = (over: Partial<SourceRow>): SourceRow => ({
  skey: "x.example",
  key: "x.example",
  domain: "x.example",
  isSocial: false,
  citations: 10,
  category: "newsMedia",
  source: "seed",
  gold: { category: "newsMedia", source: "seed" },
  override: null,
  state: null,
  shadowsOwned: false,
  ...over,
});
const OVERRIDE = { note: null, origin: "hub" as const, createdAt: "2026-10-30T03:00:00Z", updatedAt: "2026-10-30T03:00:00Z" };
const KIA = row({ skey: "kia.com", key: "kia.com", domain: "kia.com", citations: 77118, category: "newsMedia", source: "override", gold: { category: "officialHmg", source: "owned" },
  override: { ...OVERRIDE, category: "newsMedia", status: "active" }, state: "pending", shadowsOwned: true });
const DANAWA = row({ skey: "danawa.com", key: "danawa.com", domain: "danawa.com", citations: 191, category: "dealerMarketplace", source: "override",
  gold: { category: "dealerMarketplace", source: "override" }, override: { ...OVERRIDE, category: "dealerMarketplace", status: "active", origin: "gold_import" }, state: "applied" });
const BLOG = row({ skey: "blog.example", key: "blog.example", citations: 40, category: "other", source: "fallback", gold: { category: "other", source: "fallback" } });
const SOCIAL = row({ skey: "instagram.com/Hyundai", key: "instagram.com/hyundai", domain: "instagram.com", isSocial: true, citations: 3, category: "officialHmg", source: "social",
  gold: { category: "officialHmg", source: "social" } });
const UPSTREAM = row({ skey: "upstream.example", key: "upstream.example", citations: 0, source: "override", gold: { category: "newsMedia", source: "override" }, state: "upstream" });

const LISTING: SourceListing = {
  asOf: "2026-10-27",
  limit: 500,
  categories: [
    { slug: "officialHmg", name: "Official (HMG)" },
    { slug: "dealerMarketplace", name: "Dealer & Marketplace" },
    { slug: "newsMedia", name: "News & Media" },
    { slug: "other", name: "Other" },
  ],
  items: [KIA, DANAWA, BLOG, SOCIAL, UPSTREAM],
  published: { version: 3, items: 2, changeSeq: 28140, recordedAt: "2026-10-30T03:07:28Z" },
};

describe("citation source list", () => {
  it("renders the URL's picks: corrections with Gold's state, the owned warning and the published list", () => {
    const out = html(<SourceOverridesManager initial={LISTING} />);
    expect(out).toContain(">인용 출처 분류<");
    expect(out).toContain(ko.hubSourceOverrides.flowNote.replaceAll("'", "&#x27;"));
    expect(out).not.toContain("즉시 반영");
    expect(out).toContain("Gold 2026-10-27 회차 · 글로벌");
    expect(out).toContain("업스트림 목록 v3 · 2건");
    // source=override picked in the URL: the three corrected rows (the HUB's two and Gold's own), most cited first
    expect([...out.matchAll(/data-hub-source-row="([^"]+)"/g)].map(([, k]) => k)).toEqual(["kia.com", "danawa.com", "upstream.example"]);
    expect(out).toContain('data-hub-source-state="pending"');
    expect(out).toContain('data-hub-source-state="applied"');
    expect(out).toContain('data-hub-source-state="upstream"');
    expect(out).toContain("data-hub-source-shadows-owned");
    expect(out).toContain('data-hub-source-revert="kia.com"');
    expect(out).not.toContain('data-hub-source-revert="upstream.example"'); // Gold's own correction: nothing in the HUB to revert
    expect(out).toContain("77,118");
    expect(out).toContain("3 / 5개 · 교정 2 · 미분류 1 · 반영 대기 1");
    expect(out).toContain(">News &amp; Media</option>".replace("News &amp; Media", ko.citationCategories.newsMedia));
  });

  it("labels a revert Gold still applies as 원복 대기 (state stays pending)", () => {
    const REVERTED = row({ skey: "rev.example", key: "rev.example", source: "override", gold: { category: "newsMedia", source: "override" },
      override: { ...OVERRIDE, category: "newsMedia", status: "cleared" }, state: "pending" });
    const out = html(<SourceOverridesManager initial={{ ...LISTING, items: [REVERTED] }} />);
    const tr = out.slice(out.indexOf('data-hub-source-row="rev.example"'), out.indexOf("</tr>", out.indexOf('data-hub-source-row="rev.example"')));
    expect(tr).toContain('data-hub-source-state="pending"');
    expect(tr).toContain(`>${ko.hubSourceOverrides.state.pendingClear}<`);
    expect(tr).not.toContain(`>${ko.hubSourceOverrides.state.pending}<`);
  });

  it("gives each filter axis one 전체 radio, checked only when nothing is picked", () => {
    // 2026-10-30: axisOptions also listed ALL, so the panel showed 전체 twice (both checked while nothing was picked).
    const out = html(<SourceOverridesManager initial={LISTING} />);
    const radios = (axis: string) => [...out.matchAll(new RegExp(`role="radio" aria-checked="(true|false)"[^>]*data-fk="v:${axis}:([^"]+)"`, "g"))].map(([, c, v]) => [v, c === "true"] as const);
    // source=override is picked in the URL; the state axis is not
    expect(radios("source").filter(([v]) => v === "all")).toHaveLength(1);
    expect(radios("source").filter(([, c]) => c)).toEqual([["override", true]]);
    expect(radios("state").filter(([v]) => v === "all")).toHaveLength(1);
    expect(radios("state").filter(([, c]) => c)).toEqual([["all", true]]);
  });

  it("filters by category, layer, state, 미분류만 and the search text, and keeps them in the URL", () => {
    const all = LISTING.items;
    expect(all.filter((r) => matches(r, DEFAULT_FILTER, "", true)).map((r) => r.key)).toEqual(["blog.example"]);
    expect(all.filter((r) => matches(r, { ...DEFAULT_FILTER, state: "pending" }, "", false)).map((r) => r.key)).toEqual(["kia.com"]);
    expect(all.filter((r) => matches(r, { ...DEFAULT_FILTER, source: "social" }, "", false)).map((r) => r.key)).toEqual(["instagram.com/hyundai"]);
    expect(all.filter((r) => matches(r, DEFAULT_FILTER, "INSTAGRAM", false)).map((r) => r.key)).toEqual(["instagram.com/hyundai"]);
    expect(all.filter((r) => matches(r, { ...DEFAULT_FILTER, category: "dealerMarketplace" }, "", false)).map((r) => r.key)).toEqual(["danawa.com"]);
    const q = filterToQuery({ ...DEFAULT_FILTER, source: "override", state: "pending" }, " kia ", true);
    expect(q).toBe("source=override&state=pending&other=1&q=kia");
    expect(queryToFilter(q)).toEqual({ filters: { category: "all", source: "override", state: "pending" }, search: "kia", otherOnly: true });
    expect(queryToFilter("source=gold&state=done&category=News%20%26%20Media").filters).toEqual(DEFAULT_FILTER);
    expect(counts(all)).toEqual({ total: 5, overrides: 2, other: 1, pending: 1 });
  });

  it("sorts by citations, domain, Gold's category order, correction first and pending first", () => {
    const order = new Map(LISTING.categories.map((c, i) => [c.slug, i] as const));
    const keys = (rs: SourceRow[]) => rs.map((r) => r.key);
    expect(keys(sortRows(LISTING.items, "citations", false, order))).toEqual(["kia.com", "danawa.com", "blog.example", "instagram.com/hyundai", "upstream.example"]);
    expect(keys(sortRows(LISTING.items, "domain", true, order))).toEqual(["blog.example", "danawa.com", "instagram.com/hyundai", "kia.com", "upstream.example"]);
    expect(keys(sortRows(LISTING.items, "category", true, order))).toEqual(["instagram.com/hyundai", "danawa.com", "kia.com", "upstream.example", "blog.example"]);
    expect(keys(sortRows(LISTING.items, "source", true, order)).slice(0, 3)).toEqual(["kia.com", "danawa.com", "upstream.example"]);
    expect(keys(sortRows(LISTING.items, "state", true, order)).slice(0, 3)).toEqual(["kia.com", "upstream.example", "danawa.com"]);
  });
});
