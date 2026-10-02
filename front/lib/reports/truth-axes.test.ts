/**
 * 발행값 라우팅 술어 + 부분합 규칙 — 오프라인 테스트(DB 접속 없음).
 *
 * 이 파일이 지키는 것:
 *   · **폴백이 기본값이다** — 모르는 축이 하나라도 켜지면 발행값을 쓰지 않는다.
 *   · `StandardFilters` 에 축이 새로 생겼는데 분류에 안 적히면 **테스트가 깨진다**.
 *     이것이 이 파일의 가장 중요한 케이스다 — 축을 조용히 무시하면 틀린 부분합이
 *     "발행값" 표식을 달고 나간다(값이 틀린 것보다 나쁘다).
 *   · 헤드라인 풀 규칙의 두 절이 실제로 둘 다 작동한다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import {
  FALLBACK_AXES,
  PUBLISHED_AXES,
  publishedSubtotal,
  resolveReportTruthRoute,
  selectPublishedSites,
  type PublishedSiteRow,
} from "./truth-axes";

const site = (o: Partial<PublishedSiteRow> & { fileSeq: number }): PublishedSiteRow => ({
  brand: "Hyundai",
  countryCode: "MX",
  langCode: "es",
  inHeadlinePool: true,
  targetHitPrompts: 10,
  measuredPrompts: 20,
  ownedPrompts: 15,
  ownedPromptsDen: 20,
  prevTargetHitPrompts: 9,
  prevMeasuredPrompts: 20,
  prevOwnedPrompts: 14,
  prevOwnedPromptsDen: 20,
  ...o,
});

describe("축 분류 — 드리프트 가드", () => {
  it("StandardFilters 의 모든 축이 분류돼 있다 (새 축이 조용히 통과하지 않는다)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "scope", "result-adapter.ts"),
      "utf8",
    );
    const body = src.slice(
      src.indexOf("export interface StandardFilters {"),
      src.indexOf("\n}", src.indexOf("export interface StandardFilters {")),
    );
    expect(body.length).toBeGreaterThan(200);
    const keys = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);

    /** 좁히기 축이 **아닌** 것 — 여기 넣을 때는 왜인지 한 줄을 남긴다. */
    const NOT_NARROWING: Record<string, string> = {
      dateFrom: "기간 — resolveReportTruthRoute 가 따로 본다",
      dateTo: "기간 — 같음",
      cumulative: "기간 의미론 스위치. 기간 없이 단독으로는 아무것도 안 좁힌다",
      contextBrand: "서버 주입(당사 판정 전용). 모집단을 안 좁힌다",
      ownEntities: "서버 주입(자사 명부). 모집단을 안 좁힌다",
      customFieldFilters: "Record 라 모양이 달라 resolveReportTruthRoute 가 따로 본다",
    };
    const classified = new Set<string>([...PUBLISHED_AXES, ...FALLBACK_AXES, ...Object.keys(NOT_NARROWING)]);
    const unclassified = keys.filter((k) => !classified.has(k));
    expect(
      unclassified,
      `StandardFilters 에 새 축이 생겼다. PUBLISHED_AXES / FALLBACK_AXES / NOT_NARROWING 중 하나에 넣어라 — ` +
        `안 넣으면 그 축이 켜져도 발행값을 내보낸다`,
    ).toEqual([]);
  });

  it("두 목록이 겹치지 않는다", () => {
    const pub = new Set<string>(PUBLISHED_AXES);
    expect(FALLBACK_AXES.filter((a) => pub.has(a))).toEqual([]);
  });
});

describe("resolveReportTruthRoute — 필터 조합별 판정", () => {
  const cases: Array<[string, StandardFilters, "published" | "live", string?]> = [
    ["무필터", {}, "published"],
    ["브랜드", { brand: ["Genesis"] }, "published"],
    ["국가", { websiteCountry: ["MX", "KR"] }, "published"],
    ["언어", { lang: ["es"] }, "published"],
    ["브랜드+국가+언어", { brand: ["Kia"], websiteCountry: ["GR"], lang: ["el"] }, "published"],
    ["하루(from === to)", { dateFrom: "2026-09-11", dateTo: "2026-09-11" }, "published"],
    ["빈 배열은 좁히지 않는다", { brand: [], engine: [] }, "published"],
    ["엔진", { engine: ["chatgpt"] }, "live", "unsupported-axis:engine"],
    ["출처 카테고리", { sourceCategory: ["뉴스"] }, "live", "unsupported-axis:sourceCategory"],
    ["퍼널", { funnelStage: ["consider"] }, "live", "unsupported-axis:funnelStage"],
    ["브랜드 유무", { brandPresence: ["branded"] }, "live", "unsupported-axis:brandPresence"],
    ["목록 유형", { listType: ["a"] }, "live", "unsupported-axis:listType"],
    ["depth1", { depth1: ["a"] }, "live", "unsupported-axis:depth1"],
    ["depth2", { depth2: ["a"] }, "live", "unsupported-axis:depth2"],
    ["depth3", { depth3: ["a"] }, "live", "unsupported-axis:depth3"],
    ["region(website 미지원 축)", { region: ["KR"] }, "live", "unsupported-axis:region"],
    ["커스텀 태그", { customFieldFilters: { f1: ["v"] } }, "live", "unsupported-axis:customField"],
    ["기간 구간", { dateFrom: "2026-09-01", dateTo: "2026-09-11" }, "live", "period-range"],
    ["기간 한쪽만", { dateFrom: "2026-09-01" }, "live", "period-open-ended"],
    ["기간 한쪽만(to)", { dateTo: "2026-09-11" }, "live", "period-open-ended"],
    ["발행 가능 축 + 엔진 = 폴백", { brand: ["Kia"], engine: ["gemini"] }, "live", "unsupported-axis:engine"],
  ];

  for (const [name, filters, expected, reason] of cases) {
    it(`${name} → ${expected}${reason ? ` (${reason})` : ""}`, () => {
      const r = resolveReportTruthRoute(filters);
      expect(r.source).toBe(expected);
      if (r.source === "live" && reason) expect(r.reason).toBe(reason);
    });
  }

  it("빈 커스텀 태그 Record 는 좁히지 않는다", () => {
    expect(resolveReportTruthRoute({ customFieldFilters: { f1: [] } }).source).toBe("published");
    expect(resolveReportTruthRoute({ customFieldFilters: {} }).source).toBe("published");
  });

  it("기간이 없으면 roundDate 가 null 이다 (리더가 최신 노출 회차를 채운다)", () => {
    const r = resolveReportTruthRoute({ brand: ["Kia"] });
    expect(r).toMatchObject({ source: "published", roundDate: null, axes: { brand: ["Kia"] } });
  });

  it("하루짜리 기간은 그 날짜가 회차 후보다", () => {
    const r = resolveReportTruthRoute({ dateFrom: "2026-09-11", dateTo: "2026-09-11" });
    expect(r).toMatchObject({ source: "published", roundDate: "2026-09-11" });
  });

  it("cumulative 단독은 기간이 아니다", () => {
    expect(resolveReportTruthRoute({ cumulative: true }).source).toBe("published");
  });
});

describe("selectPublishedSites", () => {
  const rows = [
    site({ fileSeq: 1, brand: "Hyundai", countryCode: "MX", langCode: "es" }),
    site({ fileSeq: 2, brand: "Kia", countryCode: "GR", langCode: "el" }),
    site({ fileSeq: 3, brand: "Genesis", countryCode: "MX", langCode: "en" }),
  ];

  it("축 안은 OR, 축 사이는 AND", () => {
    expect(selectPublishedSites(rows, {}).map((r) => r.fileSeq)).toEqual([1, 2, 3]);
    expect(selectPublishedSites(rows, { brand: ["Hyundai", "Kia"] }).map((r) => r.fileSeq)).toEqual([1, 2]);
    expect(selectPublishedSites(rows, { countryCode: ["MX"] }).map((r) => r.fileSeq)).toEqual([1, 3]);
    expect(
      selectPublishedSites(rows, { countryCode: ["MX"], langCode: ["en"] }).map((r) => r.fileSeq),
    ).toEqual([3]);
  });

  it("대소문자를 가리지 않는다 (website_sites 는 middleeast, 발행물은 MIDDLEEAST)", () => {
    const r = [site({ fileSeq: 9, countryCode: "MIDDLEEAST", langCode: "AR" })];
    expect(selectPublishedSites(r, { countryCode: ["middleeast"] })).toHaveLength(1);
    expect(selectPublishedSites(r, { langCode: ["ar"] })).toHaveLength(1);
  });

  it("발행 모집단 밖만 고르면 빈 결과다", () => {
    expect(selectPublishedSites(rows, { countryCode: ["US"] })).toEqual([]);
  });
});

describe("publishedSubtotal — 헤드라인 풀 규칙", () => {
  it("교집합이 있으면 제외 유닛을 뺀다 (리포트 자신의 자세)", () => {
    const rows = [
      site({ fileSeq: 1, targetHitPrompts: 10, measuredPrompts: 20 }),
      site({ fileSeq: 109, inHeadlinePool: false, targetHitPrompts: 3, measuredPrompts: 91 }),
    ];
    const sub = publishedSubtotal(rows)!;
    expect([sub.hitPrompts, sub.measuredPrompts]).toEqual([10, 20]);
    expect(sub.siteCount).toBe(1);
    expect(sub.headlinePoolApplied).toBe(true);
  });

  it("**제외 유닛만** 고르면 그 유닛 값이 보인다 (필터로 CPO 를 직접 고른 경우)", () => {
    const rows = [site({ fileSeq: 109, inHeadlinePool: false, targetHitPrompts: 3, measuredPrompts: 91 })];
    const sub = publishedSubtotal(rows)!;
    expect([sub.hitPrompts, sub.measuredPrompts]).toEqual([3, 91]);
    expect(sub.siteCount).toBe(1);
    // 뺄 것이 없었으므로 규칙이 "적용됐다" 고 말하지 않는다.
    expect(sub.headlinePoolApplied).toBe(false);
  });

  it("제외 유닛이 **섞여 있으면** 언제나 앞 절이 이긴다 (두 절이 충돌하지 않는 이유)", () => {
    const rows = [
      site({ fileSeq: 1, targetHitPrompts: 10, measuredPrompts: 20 }),
      site({ fileSeq: 109, inHeadlinePool: false, targetHitPrompts: 3, measuredPrompts: 91 }),
    ];
    // 순서를 뒤집어도 같다(결정론).
    expect(publishedSubtotal([...rows].reverse())!.measuredPrompts).toBe(20);
  });

  it("전부 풀 안이면 그대로 더한다", () => {
    const rows = [site({ fileSeq: 1 }), site({ fileSeq: 2 })];
    const sub = publishedSubtotal(rows)!;
    expect([sub.hitPrompts, sub.measuredPrompts]).toEqual([20, 40]);
    expect(sub.headlinePoolApplied).toBe(false);
  });

  it("빈 선택은 null — 0/0 을 발행값이라 우기지 않는다", () => {
    expect(publishedSubtotal([])).toBeNull();
  });

  it("두 카드는 같은 분모를 쓴다", () => {
    const sub = publishedSubtotal([site({ fileSeq: 1 }), site({ fileSeq: 2 })])!;
    expect(sub.measuredPrompts).toBe(40);
    expect(sub.ownedPrompts).toBe(30);
  });

  it("직전 회차 쌍도 같은 선택에서 더해진다 (섞어 빼지 않기 위한 전제)", () => {
    const rows = [
      site({ fileSeq: 1, prevTargetHitPrompts: 9, prevMeasuredPrompts: 20 }),
      site({ fileSeq: 109, inHeadlinePool: false, prevTargetHitPrompts: 100, prevMeasuredPrompts: 100 }),
    ];
    const sub = publishedSubtotal(rows)!;
    // 제외 유닛의 직전 값이 새지 않는다 — 현재와 직전이 **같은 모집단**이어야 한다.
    expect([sub.prev.hitPrompts, sub.prev.measuredPrompts]).toEqual([9, 20]);
  });

  it("직전 값이 null 인 사이트는 0 으로 더한다", () => {
    const sub = publishedSubtotal([site({ fileSeq: 1, prevTargetHitPrompts: null, prevMeasuredPrompts: null })])!;
    expect([sub.prev.hitPrompts, sub.prev.measuredPrompts]).toEqual([0, 0]);
  });
});
