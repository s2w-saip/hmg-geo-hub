import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { CodeListing, SeedListing, SeedRow, SocialListing, SocialRow } from "./source-lists-api";
import {
  DEFAULT_SEED_FILTER,
  codeProblems,
  defaultMatcher,
  moveCode,
  queryToSeedFilter,
  seedCounts,
  seedFilterToQuery,
  seedKeyOf,
  seedMatches,
  socialProblems,
  sortSeeds,
  tabOf,
} from "./source-lists-model";

// Admin › 인용 출처 분류 › 시드 · 공식 소셜 · 코드표 (2026-10-30): each tab as first rendered (the HUB's list next to
// Gold's values, the reflection states, no '즉시 반영' wording, the tab bar) and the pure filter / input models.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=seeds"),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/ko/renewal/admin/standards/citation-sources",
}));

const { SourceSeedsManager } = await import("./source-seeds-manager");
const { SourceSocialsManager, SocialForm } = await import("./source-socials-manager");
const { SourceCodesManager, CodeForm } = await import("./source-codes-manager");
const { SourceTabs } = await import("./source-tabs");

const html = (ui: ReactElement) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {ui}
    </NextIntlClientProvider>,
  );
const rowOf = (out: string, attr: string, key: string) => {
  const from = out.indexOf(`${attr}="${key}"`);
  return out.slice(from, out.indexOf("</tr>", from));
};
const keysOf = (out: string, attr: string) => [...out.matchAll(new RegExp(`${attr}="([^"]+)"`, "g"))].map(([, k]) => k);

const PUBLISHED = { version: 2, items: 701, changeSeq: 28150, recordedAt: "2026-10-30T05:00:00Z" };
const seed = (over: Partial<SeedRow>): SeedRow => ({
  skey: "x.example",
  category: "newsMedia",
  note: null,
  status: "active",
  origin: "file_import",
  updatedAt: "2026-10-30T05:00:00Z",
  gold: { category: "newsMedia", source: "seed", citations: 10 },
  state: "applied",
  ...over,
});
const SEEDS: SeedListing = {
  asOf: "2026-10-05",
  categories: [
    { slug: "officialHmg", name: "Official (HMG)" },
    { slug: "dealerMarketplace", name: "Dealer & Marketplace" },
    { slug: "automotiveMedia", name: "Automotive Media" },
    { slug: "newsMedia", name: "News & Media" },
    { slug: "other", name: "Other" },
  ],
  items: [
    seed({ skey: "carandbike.com", category: "automotiveMedia", gold: { category: "automotiveMedia", source: "seed", citations: 120 } }),
    seed({ skey: "hyundai.news", category: "officialHmg", gold: { category: "officialHmg", source: "owned", citations: 300 }, state: "shadowed" }),
    seed({ skey: "newsite.example", gold: null, state: null }),
    seed({ skey: "old.example", status: "removed", gold: { category: "newsMedia", source: "seed", citations: 5 }, state: "pending" }),
    seed({ skey: "changed.example", category: "dealerMarketplace", gold: { category: "automotiveMedia", source: "seed", citations: 50 }, state: "pending", origin: "hub" }),
    seed({ skey: "up.example", category: null, status: null, origin: null, updatedAt: null, gold: { category: "newsMedia", source: "seed", citations: 7 }, state: "upstream" }),
  ],
  published: PUBLISHED,
};

describe("tab bar", () => {
  it("lists 교정 · 시드 · 공식 소셜 · 코드표 with the picked one selected, and reads ?tab=", () => {
    const out = html(<SourceTabs value="seeds" />);
    expect(keysOf(out, "data-rn-tab")).toEqual(["overrides", "seeds", "social", "codes"]);
    expect(out).toMatch(/aria-selected="true"[^>]*data-rn-tab="seeds"/);
    expect(out).toContain(`>${ko.hubSourceLists.tabs.codes}<`);
    expect([tabOf("codes"), tabOf(["social"]), tabOf("x"), tabOf(undefined)]).toEqual(["codes", "social", "overrides", "overrides"]);
  });
});

describe("seeds tab", () => {
  it("renders the HUB's seeds next to Gold's values with their states, the add form and the published list", () => {
    const out = html(<SourceSeedsManager initial={SEEDS} tabs={<SourceTabs value="seeds" />} />);
    expect(out).toContain(">인용 출처 분류<");
    expect(out).toContain(ko.hubSourceLists.seeds.flowNote.replaceAll("'", "&#x27;"));
    expect(out).not.toContain("즉시 반영");
    expect(out).toContain("Gold 2026-10-05 회차 · 글로벌");
    expect(out).toContain("업스트림 목록 v2 · 701건");
    expect(out).toContain("data-hub-seed-add=");
    // most cited first
    expect(keysOf(out, "data-hub-seed-row")).toEqual(["hyundai.news", "carandbike.com", "changed.example", "up.example", "old.example", "newsite.example"]);
    expect(rowOf(out, "data-hub-seed-row", "carandbike.com")).toContain('data-hub-seed-state="applied"');
    const shadowed = rowOf(out, "data-hub-seed-row", "hyundai.news");
    expect(shadowed).toContain('data-hub-seed-state="shadowed"');
    expect(shadowed).toContain(`>${ko.hubSourceLists.seeds.state.shadowed}<`);
    expect(shadowed).toContain(`${ko.citationCategories.officialHmg} · ${ko.hubSourceOverrides.source.owned}`);
    // a removal Gold still applies: pending, labelled 제외 대기; restore instead of remove; the select is locked
    const removed = rowOf(out, "data-hub-seed-row", "old.example");
    expect(removed).toContain('data-hub-seed-state="pending"');
    expect(removed).toContain(`>${ko.hubSourceLists.seeds.state.pendingRemove}<`);
    expect(removed).toContain('data-hub-seed-restore="old.example"');
    expect(removed).not.toContain("data-hub-seed-remove");
    expect(removed).toMatch(/<select[^>]*disabled=""[^>]*data-hub-seed-category="old.example"/);
    // Gold seed the HUB lacks: no select, 'add as seed'
    const upstream = rowOf(out, "data-hub-seed-row", "up.example");
    expect(upstream).toContain('data-hub-seed-state="upstream"');
    expect(upstream).toContain('data-hub-seed-adopt="up.example"');
    expect(upstream).not.toContain("data-hub-seed-category");
    expect(upstream).not.toContain("data-hub-seed-history");
    // never cited: no Gold value, no state
    const uncited = rowOf(out, "data-hub-seed-row", "newsite.example");
    expect(uncited).toContain('data-hub-seed-state=""');
    expect(uncited).toContain(ko.hubSourceLists.seeds.goldNone);
    expect(rowOf(out, "data-hub-seed-row", "carandbike.com")).toContain('data-hub-seed-remove="carandbike.com"');
    expect(out).toContain("6 / 6개 · 적용 중 4 · 제외 1 · 반영 대기 2 · 업스트림 1");
  });

  it("filters, sorts, counts and mirrors the picks in the URL (keeping the tab)", () => {
    const all = SEEDS.items;
    expect(all.filter((r) => seedMatches(r, { ...DEFAULT_SEED_FILTER, state: "pending" }, "")).map((r) => r.skey)).toEqual(["old.example", "changed.example"]);
    expect(all.filter((r) => seedMatches(r, { ...DEFAULT_SEED_FILTER, status: "removed" }, "")).map((r) => r.skey)).toEqual(["old.example"]);
    // an upstream row filters by Gold's category
    expect(all.filter((r) => seedMatches(r, { ...DEFAULT_SEED_FILTER, category: "newsMedia" }, "")).map((r) => r.skey)).toEqual(["newsite.example", "old.example", "up.example"]);
    expect(all.filter((r) => seedMatches(r, DEFAULT_SEED_FILTER, " CAR")).map((r) => r.skey)).toEqual(["carandbike.com"]);
    const order = new Map(SEEDS.categories.map((c, i) => [c.slug, i] as const));
    expect(sortSeeds(all, "domain", true, order).map((r) => r.skey)[0]).toBe("carandbike.com");
    expect(sortSeeds(all, "state", true, order).map((r) => r.state)).toEqual(["pending", "pending", "shadowed", "upstream", "applied", null]);
    expect(seedCounts(all)).toEqual({ total: 6, active: 4, removed: 1, pending: 2, upstream: 1 });
    const q = seedFilterToQuery({ category: "newsMedia", state: "upstream", status: "all" }, " up ");
    expect(q).toBe("tab=seeds&category=newsMedia&state=upstream&q=up");
    expect(queryToSeedFilter(q)).toEqual({ filters: { category: "newsMedia", state: "upstream", status: "all" }, search: "up" });
    expect(queryToSeedFilter("state=done&status=deleted&category=News%20%26%20Media").filters).toEqual(DEFAULT_SEED_FILTER);
  });

  it("keys a new seed as the HUB stores it", () => {
    expect(seedKeyOf("  WWW.CarAndBike.com ")).toBe("carandbike.com");
    expect(seedKeyOf("auto.danawa.com")).toBe("auto.danawa.com");
    expect([seedKeyOf("instagram.com/hyundai"), seedKeyOf("nodot"), seedKeyOf("a b.com"), seedKeyOf("x".repeat(299) + ".com")]).toEqual([null, null, null, null]);
  });
});

const social = (over: Partial<SocialRow>): SocialRow => ({
  key: "linkedin.com/hyundai-motor-group",
  accountKey: "linkedin.com/hyundai-motor-group",
  domain: "linkedin.com",
  matchers: [
    { prefix: "linkedin.com/company/hyundai-motor-group", boundary: true },
    { prefix: "linkedin.com/posts/hyundai-motor-group_", boundary: false },
  ],
  note: null,
  status: "active",
  origin: "file_import",
  updatedAt: "2026-10-30T05:00:00Z",
  gold: { source: "social", citations: 40 },
  state: "applied",
  ...over,
});
const SOCIALS: SocialListing = {
  items: [
    social({}),
    social({ key: "threads.com/@genesis_usa", accountKey: "threads.com/@genesis_usa", domain: "threads.com", matchers: [{ prefix: "threads.com/@genesis_usa", boundary: true }], gold: null, state: null }),
    social({ key: "facebook.com/Hyundai.Europe", accountKey: "facebook.com/hyundai.europe", domain: "facebook.com", matchers: [{ prefix: "facebook.com/hyundai.europe", boundary: true }], status: "stopped", gold: { source: "social", citations: 3 }, state: "pending" }),
    social({ key: "instagram.com/NewOne", accountKey: "instagram.com/newone", domain: "instagram.com", matchers: [], status: null, origin: null, updatedAt: null, gold: { source: "social", citations: 2 }, state: "upstream" }),
  ],
  published: { ...PUBLISHED, items: 9 },
};

describe("official social tab", () => {
  it("renders the accounts with their matchers, the fixed category, states and actions", () => {
    const out = html(<SourceSocialsManager initial={SOCIALS} />);
    expect(out).toContain(ko.hubSourceLists.social.flowNote.replaceAll("'", "&#x27;"));
    expect(out).not.toContain("즉시 반영");
    expect(keysOf(out, "data-hub-social-row")).toEqual(["linkedin.com/hyundai-motor-group", "facebook.com/hyundai.europe", "instagram.com/newone", "threads.com/@genesis_usa"]);
    const li = rowOf(out, "data-hub-social-row", "linkedin.com/hyundai-motor-group");
    expect(li).toContain("linkedin.com/company/hyundai-motor-group 외 1개");
    expect(li).toContain(">Official (HMG)<");
    expect(li).toContain('data-hub-social-state="applied"');
    expect(li).toContain(`>${ko.hubSourceLists.social.stop}<`);
    const stopped = rowOf(out, "data-hub-social-row", "facebook.com/hyundai.europe");
    expect(stopped).toContain(">facebook.com/Hyundai.Europe<");
    expect(stopped).toContain(`>${ko.hubSourceLists.social.state.pendingStop}<`);
    expect(stopped).toContain(`>${ko.hubSourceLists.social.resume}<`);
    const upstream = rowOf(out, "data-hub-social-row", "instagram.com/newone");
    expect(upstream).toContain('data-hub-social-adopt="instagram.com/newone"');
    expect(upstream).not.toContain("data-hub-social-toggle");
    expect(rowOf(out, "data-hub-social-row", "threads.com/@genesis_usa")).toContain('data-hub-social-state=""');
    expect(out).toContain("4개 · 적용 중 2 · 중지 1 · 반영 대기 1");
    expect(out).toContain("업스트림 목록 v2 · 9건");
  });

  it("opens the add form with the key and its first matcher, and checks the account as the BFF does", () => {
    const out = html(<SocialForm initialKey="instagram.com/NewOne" initialMatchers={[defaultMatcher("instagram.com/NewOne")]} editing={false} onSaved={() => {}} onCancel={() => {}} />);
    expect(out).toContain('data-hub-social-form="add"');
    expect(out).toContain('value="instagram.com/NewOne"');
    expect(out).toContain('value="instagram.com/newone"');
    expect(out).toMatch(/type="checkbox"[^>]*checked=""/);
    const edit = html(<SocialForm initialKey="linkedin.com/hyundai-motor-group" initialMatchers={SOCIALS.items[0].matchers} editing onSaved={() => {}} onCancel={() => {}} />);
    expect(edit).toContain('data-hub-social-form="edit"');
    expect(edit).not.toContain("data-hub-social-key");
    expect(keysOf(edit, "data-hub-social-matcher")).toEqual(["0", "1"]);

    const ok = [{ prefix: "instagram.com/hyundai", boundary: true }];
    expect(socialProblems("instagram.com/hyundai", ok)).toEqual([]);
    expect(socialProblems("linkedin.com/hyundai-motor-group", SOCIALS.items[0].matchers)).toEqual([]);
    expect(socialProblems("instagram.com", ok)).toContain("key");
    expect(socialProblems("www.instagram.com/x", [{ prefix: "www.instagram.com/x", boundary: true }])).toContain("key");
    expect(socialProblems("instagram.com/a b", ok)).toContain("key");
    expect(socialProblems("instagram.com/x", [])).toEqual(["matchers"]);
    expect(socialProblems("instagram.com/x", [{ prefix: "Instagram.com/x", boundary: true }])).toEqual(["prefix"]);
    expect(socialProblems("instagram.com/x", [{ prefix: "facebook.com/x", boundary: true }])).toEqual(["prefix"]);
    expect(socialProblems("instagram.com/x", [{ prefix: "instagram.com/", boundary: true }])).toEqual(["prefix"]);
    expect(socialProblems("instagram.com/x", [ok[0], { prefix: "instagram.com/hyundai", boundary: false }])).toEqual(["duplicate"]);
    expect(socialProblems("instagram.com/x", Array.from({ length: 11 }, (_, i) => ({ prefix: `instagram.com/x${i}`, boundary: true })))).toEqual(["matchers"]);
  });
});

const CODES: CodeListing = {
  categories: [
    { code: "officialHmg", number: 1, nameEn: "Official (HMG)", nameKo: "공식 (HMG)", ord: 1, description: null, updatedAt: null, gold: { name: "Official (HMG)", ord: 1 }, state: "applied" },
    { code: "newsMedia", number: 5, nameEn: "News & Media", nameKo: "뉴스·미디어", ord: 2, description: "언론사", updatedAt: null, gold: { name: "News & Media", ord: 5 }, state: "pending" },
    { code: "other", number: 13, nameEn: "Other", nameKo: "기타", ord: 3, description: null, updatedAt: null, gold: { name: "Other", ord: 13 }, state: "pending" },
  ],
  layers: [
    { code: "seed", number: 4, nameEn: "Curated", nameKo: "큐레이션", ord: 4, description: null, updatedAt: null },
    { code: "override", number: 1, nameEn: "Correction", nameKo: "운영자 교정", ord: 1, description: null, updatedAt: null },
  ],
  published: { ...PUBLISHED, items: 19 },
};

describe("code table tab", () => {
  it("renders categories in order with Gold's name and order and the layers by priority, no add or remove", () => {
    const out = html(<SourceCodesManager initial={CODES} />);
    expect(out).toContain(ko.hubSourceLists.codes.note);
    expect(out).toContain(ko.hubSourceLists.codes.layersHint);
    expect(keysOf(out, "data-hub-code-row")).toEqual(["category:officialHmg", "category:newsMedia", "category:other", "layer:override", "layer:seed"]);
    expect(rowOf(out, "data-hub-code-row", "category:officialHmg")).toContain('data-hub-code-state="applied"');
    const news = rowOf(out, "data-hub-code-row", "category:newsMedia");
    expect(news).toContain('data-hub-code-state="pending"');
    expect(news).toContain("News &amp; Media · 5번째");
    // the first cannot move up, the last cannot move down
    expect(out).toMatch(/disabled=""[^>]*data-hub-code-up="officialHmg"/);
    expect(out).toMatch(/disabled=""[^>]*data-hub-code-down="other"/);
    expect(out).not.toMatch(/disabled=""[^>]*data-hub-code-up="newsMedia"/);
    expect(out).not.toContain("data-hub-code-up=\"seed\"");
    expect(out).toContain('data-hub-code-edit="layer:override"');
    expect(out).toContain("업스트림 목록 v2 · 19건");
  });

  it("edits names and description only, and moves a category a step", () => {
    const out = html(<CodeForm kind="category" row={CODES.categories[1]} onSaved={() => {}} onCancel={() => {}} />);
    expect(out).toContain('data-hub-code-form="category:newsMedia"');
    expect(out).toContain('value="뉴스·미디어"');
    expect(out).toContain('value="News &amp; Media"');
    expect(out).toContain(">언론사</textarea>");
    expect(codeProblems({ nameKo: "뉴스", nameEn: "News", description: "" })).toEqual([]);
    expect(codeProblems({ nameKo: " ", nameEn: "x".repeat(81), description: "y".repeat(501) })).toEqual(["nameKo", "nameEn", "description"]);
    expect(codeProblems({ nameKo: "a\u0007", nameEn: "b", description: "" })).toEqual(["nameKo"]);
    const codes = CODES.categories.map((c) => c.code);
    expect(moveCode(codes, "newsMedia", "up")).toEqual(["newsMedia", "officialHmg", "other"]);
    expect(moveCode(codes, "newsMedia", "down")).toEqual(["officialHmg", "other", "newsMedia"]);
    expect(moveCode(codes, "officialHmg", "up")).toEqual(codes);
    expect(moveCode(codes, "missing", "down")).toEqual(codes);
  });
});

describe("messages", () => {
  it("has the same hubSourceLists keys in ko and en", () => {
    const keys = (o: unknown, p = ""): string[] =>
      o && typeof o === "object" ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k)) : [p];
    expect(keys(en.hubSourceLists).sort()).toEqual(keys(ko.hubSourceLists).sort());
  });
});
