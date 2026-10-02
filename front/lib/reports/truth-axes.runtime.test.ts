/**
 * **런타임 합성** 테스트 — 순수 함수만 보던 기존 테스트가 못 잡은 것을 잡는다.
 *
 * ── 이 파일이 존재하는 이유 (2026-09-20 독립 검증) ────────────────────────
 * 첫 판(742369f)은 `selectPublishedSites` 를 **발행물 105행에 직접** 먹이는 테스트만
 * 갖고 있었다. 그래서 다음이 전부 통과했는데 라이브에서는 틀렸다:
 *   · 브랜드 = Hyundai 가 리포트의 42개(65.7%)가 아니라 **40개(66.1%)** 로 나가면서
 *     `source: "published"` 표식을 달았다.
 *   · 국가 = KR·worldwide 에서 발행 모집단이 라이브와 조용히 갈렸다.
 *
 * 뿌리는 **분류 어휘가 두 벌**이라는 것이다:
 *   발행물   `sites[].b` · `dash.geo`          (fs 40·41 = Hyundai · HYUNDAI-N)
 *   런타임   `website_sites.brand` · `.country_code` (fs 40·41 = Hyundai N · KR/worldwide)
 * 그리고 `withWebsite` 가 브랜드 축을 project id 로 흡수하면서 `filters.brand` 를 지우므로,
 * 브랜드 좁히기가 **전량 런타임 어휘**로 일어났다.
 *
 * 그래서 여기서는 **런타임 분류 픽스처를 함께 태운다.** 픽스처의 fs 40·41 값은 메인이
 * 미러에서 확인한 실측이다(W8.csv, 2026-09-20). 나머지 유닛은 발행물 분류와 같다 —
 * 어느 유닛이 갈리는지는 런타임 코드가 DB 에서 **동적으로** 구하므로(하드코딩 없음),
 * 픽스처는 로직을 태우기만 하면 된다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decidePublishedSelection,
  publishedSubtotal,
  selectPublishedSites,
  vocabularySplit,
  type PublishedSiteRow,
  type RuntimeSiteClass,
} from "./truth-axes";
import { parsePublication, pct1, pct2 } from "./sb-data";

const FX = path.join(__dirname, "__fixtures__");
const sb = JSON.parse(
  fs.readFileSync(path.join(FX, "sbdata-vol2-global-20260915.min.json"), "utf8"),
) as Record<string, unknown>;
const runtimeAll = JSON.parse(
  fs.readFileSync(path.join(FX, "runtime-classification-20260915.min.json"), "utf8"),
) as RuntimeSiteClass[];

const parsed = parsePublication(JSON.parse(JSON.stringify(sb)));
const published: PublishedSiteRow[] = parsed.sites.map((s) => ({
  fileSeq: s.fileSeq,
  brand: s.brand,
  countryCode: s.countryCode,
  langCode: s.langCode,
  inHeadlinePool: s.inHeadlinePool,
  targetHitPrompts: s.targetHitPrompts,
  measuredPrompts: s.measuredPrompts,
  ownedPrompts: s.ownedPrompts,
  ownedPromptsDen: s.ownedPromptsDen,
  prevTargetHitPrompts: s.prevTargetHitPrompts,
  prevMeasuredPrompts: s.prevMeasuredPrompts,
  prevOwnedPrompts: s.prevOwnedPrompts,
  prevOwnedPromptsDen: s.prevOwnedPromptsDen,
}));

/** 리포트가 발행한 부분합(기대값) — 발행물 어휘 + 헤드라인 풀. */
const reportPair = (pred: (s: PublishedSiteRow) => boolean): [number, number] => {
  const sel = published.filter((s) => pred(s) && s.inHeadlinePool);
  return [
    sel.reduce((a, s) => a + s.targetHitPrompts, 0),
    sel.reduce((a, s) => a + s.measuredPrompts, 0),
  ];
};
const decide = (axes: Parameters<typeof decidePublishedSelection>[0]["axes"], runtime = runtimeAll) =>
  decidePublishedSelection({ published, runtime, axes });
const pairOf = (d: ReturnType<typeof decidePublishedSelection>): [number, number] | null => {
  if (!d.ok) return null;
  const sub = publishedSubtotal(d.selected);
  return sub ? [sub.hitPrompts, sub.measuredPrompts] : null;
};

describe("픽스처 — 두 어휘가 실제로 갈린다", () => {
  it("런타임 분류가 발행 유닛 전부를 덮고, 발행물 밖 유닛도 들고 있다", () => {
    const seen = new Set(runtimeAll.map((r) => r.fileSeq));
    expect(published.every((p) => seen.has(p.fileSeq))).toBe(true);
    // 대시보드에만 있는 유닛(리포트 밖)도 런타임에는 있다 — 권한 집합이 더 넓다.
    expect(seen.has(44)).toBe(true);
    expect(seen.size).toBeGreaterThan(published.length);
  });

  it("어휘 분기는 fs 40·41 두 건이다 (미러 실측)", () => {
    expect([...vocabularySplit(published, runtimeAll)].sort((a, b) => a - b)).toEqual([40, 41]);
    const byFs = new Map(runtimeAll.map((r) => [r.fileSeq, r]));
    expect(byFs.get(40)).toMatchObject({ brand: "Hyundai N", countryCode: "KR" });
    expect(byFs.get(41)).toMatchObject({ brand: "Hyundai N", countryCode: "worldwide" });
    const pub = new Map(published.map((p) => [p.fileSeq, p]));
    expect(pub.get(40)).toMatchObject({ brand: "Hyundai", countryCode: "HYUNDAI-N" });
    expect(pub.get(41)).toMatchObject({ brand: "Hyundai", countryCode: "HYUNDAI-N" });
  });

  it("어휘가 같은 유닛은 분기에 들어가지 않는다 (가드가 과잉 반응하지 않는다)", () => {
    const split = vocabularySplit(published, runtimeAll);
    for (const fs of [1, 5, 42, 109]) expect(split.has(fs), `fs ${fs}`).toBe(false);
  });
});

// ── 중복 분류 (2026-09-20 검증 주의 4) ──────────────────────────────────────
//
// 한 file_seq 에 런타임 분류가 둘 이상이면 그 유닛의 브랜드·국가가 하나로 정해지지
// 않는다. 종전 판은 `new Map(runtime.map(...))` 으로 접어 **뒤엣것이 앞엣것을 덮었고**,
// 덮은 쪽이 발행물과 우연히 같으면 분기로 안 잡혔다 — 즉 결과가 행 순서에 좌우됐다.
describe("한 file_seq 에 분류가 둘 이상이면 어휘 분기다", () => {
  const dup = (brandA: string, brandB: string): RuntimeSiteClass[] => {
    const base = runtimeAll.filter((r) => r.fileSeq !== 1);
    const p = published.find((x) => x.fileSeq === 1)!;
    return [
      ...base,
      { fileSeq: 1, brand: brandA, countryCode: p.countryCode, langCodes: [p.langCode ?? "es"] },
      { fileSeq: 1, brand: brandB, countryCode: p.countryCode, langCodes: [p.langCode ?? "es"] },
    ];
  };

  it("두 행 중 **하나가 발행물과 같아도** 분기로 잡는다", () => {
    // ⚠️ 순서가 중요하다 — 발행물 fs 1 = Hyundai 이므로 **뒤엣것을 Hyundai** 로 둔다.
    //    종전의 Map 접기는 뒤엣것만 남겨 "발행물과 같다"고 보고 분기를 놓쳤다.
    //    앞뒤를 바꾸면(Hyundai, Kia) 우연히 통과해 버려 판별력이 없다.
    expect(vocabularySplit(published, dup("Kia", "Hyundai")).has(1)).toBe(true);
    expect(vocabularySplit(published, dup("Hyundai", "Kia")).has(1)).toBe(true);
  });

  it("행 순서를 뒤집어도 같다 (결정론)", () => {
    const a = vocabularySplit(published, dup("Hyundai", "Kia"));
    const b = vocabularySplit(published, dup("Kia", "Hyundai"));
    expect([...a].sort((x, y) => x - y)).toEqual([...b].sort((x, y) => x - y));
    expect(a.has(1)).toBe(true);
    expect(b.has(1)).toBe(true);
  });

  it("그 유닛에 닿는 국가 선택은 라이브로 떨어진다", () => {
    const d = decidePublishedSelection({
      published,
      // 버그를 숨기는 순서(뒤엣것이 발행물과 같다)로 태운다.
      runtime: dup("Kia", "Hyundai"),
      axes: { countryCode: ["MX"] },
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("vocabulary-split:websiteCountry");
  });

  it("중복 행 **어느 쪽이든** 국가가 닿으면 잡는다 (접힌 쪽만 보지 않는다)", () => {
    const p = published.find((x) => x.fileSeq === 1)!;
    const runtime: RuntimeSiteClass[] = [
      ...runtimeAll.filter((r) => r.fileSeq !== 1),
      { fileSeq: 1, brand: p.brand, countryCode: p.countryCode, langCodes: ["es"] },
      { fileSeq: 1, brand: p.brand, countryCode: "ZZ", langCodes: ["es"] },
    ];
    // 발행물 쪽 국가(MX)로 골라도, 런타임 전용 국가(ZZ)로 골라도 둘 다 라이브.
    for (const cc of ["MX", "ZZ"]) {
      const d = decidePublishedSelection({ published, runtime, axes: { countryCode: [cc] } });
      expect(d.ok, cc).toBe(false);
    }
  });

  it("중복이 없으면 분기로 잡지 않는다 (가드가 과잉 반응하지 않는다)", () => {
    expect(vocabularySplit(published, runtimeAll).has(1)).toBe(false);
  });
});

describe("차단 1 — 브랜드 축이 리포트 값을 재현한다", () => {
  it("Hyundai = 42개 · 2,775 / 4,223 · 65.7% (리포트 brandAvgAll 과 같다)", () => {
    const d = decide({ brand: ["Hyundai"] });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    // `selected` 는 헤드라인 풀을 적용하기 **전**이다(43개 = CPO 포함). 풀 규칙은
    // `publishedSubtotal` 이 적용해 42개로 만든다 — 리포트의 brandAvgAll.n 과 같다.
    expect(d.selected).toHaveLength(43);
    expect(publishedSubtotal(d.selected)!.siteCount).toBe(42);
    expect(pairOf(d)).toEqual([2775, 4223]);
    expect(pct2(2775, 4223)).toBe(65.71);
    expect(pct1(2775, 4223)).toBe(65.7);
    // 리포트가 발행한 값과 같은지 독립 확인.
    expect(pairOf(d)).toEqual(reportPair((s) => s.brand === "Hyundai"));
  });

  it("**변이(수리 전 동작)**: 런타임 어휘로 좁히면 40개 · 66.1% 로 리포트와 갈린다", () => {
    // 첫 판이 하던 것 그대로 재현한다 — 런타임 file_seq 집합과 교집합한 뒤 부분합.
    // 이 테스트가 "수리 전이면 무엇이 나왔는가" 의 고정이자, 다시 그 형태로 돌아가면
    // 위 케이스가 깨진다는 것을 보여 주는 대조군이다.
    const runtimeHyundai = new Set(
      runtimeAll.filter((r) => r.brand === "Hyundai").map((r) => r.fileSeq),
    );
    const old = published.filter((p) => runtimeHyundai.has(p.fileSeq));
    const sub = publishedSubtotal(selectPublishedSites(old, {}))!;
    expect(sub.siteCount).toBe(40);
    expect([sub.hitPrompts, sub.measuredPrompts]).toEqual([2666, 4034]);
    expect(pct1(sub.hitPrompts, sub.measuredPrompts)).toBe(66.1);
    // 그리고 그것은 리포트 값이 **아니다** — 이것이 차단 1 의 본체였다.
    expect([sub.hitPrompts, sub.measuredPrompts]).not.toEqual([2775, 4223]);
  });

  it("Kia·Genesis 는 어휘가 안 갈려 두 방식이 같다 (fs 40·41 만의 문제였다)", () => {
    for (const brand of ["Kia", "Genesis"]) {
      const d = decide({ brand: [brand] });
      expect(d.ok, brand).toBe(true);
      expect(pairOf(d), brand).toEqual(reportPair((s) => s.brand === brand));
      const runtimeSet = new Set(runtimeAll.filter((r) => r.brand === brand).map((r) => r.fileSeq));
      const viaRuntime = published.filter((p) => runtimeSet.has(p.fileSeq) && p.inHeadlinePool);
      expect(
        [
          viaRuntime.reduce((a, s) => a + s.targetHitPrompts, 0),
          viaRuntime.reduce((a, s) => a + s.measuredPrompts, 0),
        ],
        brand,
      ).toEqual(reportPair((s) => s.brand === brand));
    }
  });

  it("런타임 전용 브랜드('Hyundai N')는 대응 부분합이 없어 라이브로 떨어진다", () => {
    const d = decide({ brand: ["Hyundai N"] });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.reason).toBe("brand-not-in-publication:Hyundai N");
  });

  it("발행물에 있는 브랜드와 없는 브랜드를 섞어도 라이브다 (부분만 답하지 않는다)", () => {
    const d = decide({ brand: ["Hyundai", "Hyundai N"] });
    expect(d.ok).toBe(false);
  });

  it("전 브랜드 합은 헤드라인과 같다 (부분합이 모집단을 남기거나 겹치지 않는다)", () => {
    let n = 0;
    let de = 0;
    for (const brand of ["Hyundai", "Kia", "Genesis"]) {
      const p = pairOf(decide({ brand: [brand] }))!;
      n += p[0];
      de += p[1];
    }
    expect([n, de]).toEqual([5611, 9586]);
  });
});

describe("차단 2 — 국가 축은 어휘가 갈리면 라이브다", () => {
  it("KR·worldwide 는 갈리는 유닛에 닿아 라이브 (리포트에 없는 수를 published 로 내보내지 않는다)", () => {
    for (const cc of ["KR", "worldwide"]) {
      const d = decide({ countryCode: [cc] });
      expect(d.ok, cc).toBe(false);
      if (!d.ok) expect(d.reason, cc).toBe("vocabulary-split:websiteCountry");
    }
  });

  it("발행물 어휘 쪽 값(HYUNDAI-N)으로 골라도 라이브 — 양쪽 어휘를 다 본다", () => {
    const d = decide({ countryCode: ["HYUNDAI-N"] });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("vocabulary-split:websiteCountry");
  });

  it("갈리는 유닛에 안 닿는 국가는 published 이고 리포트 정수 쌍 그대로다", () => {
    for (const cc of ["MX", "GR", "BR", "DE"]) {
      const d = decide({ countryCode: [cc] });
      expect(d.ok, cc).toBe(true);
      expect(pairOf(d), cc).toEqual(reportPair((s) => s.countryCode === cc));
    }
  });

  it("대소문자는 가리지 않는다 (middleeast ↔ MIDDLEEAST)", () => {
    const upper = decide({ countryCode: ["MIDDLEEAST"] });
    const lower = decide({ countryCode: ["middleeast"] });
    expect(upper.ok).toBe(lower.ok);
    if (upper.ok && lower.ok) expect(pairOf(upper)).toEqual(pairOf(lower));
  });

  it("브랜드 + 갈리는 국가 조합도 라이브다", () => {
    expect(decide({ brand: ["Hyundai"], countryCode: ["KR"] }).ok).toBe(false);
    // 안 갈리는 국가와의 조합은 그대로 published.
    const ok = decide({ brand: ["Hyundai"], countryCode: ["MX"] });
    expect(ok.ok).toBe(true);
    expect(pairOf(ok)).toEqual(reportPair((s) => s.brand === "Hyundai" && s.countryCode === "MX"));
  });

  it("언어 축도 같은 규칙을 탄다", () => {
    // ko 는 fs 40(런타임 KR/ko)에 닿는다 → 라이브.
    expect(decide({ langCode: ["ko"] }).ok).toBe(false);
    // es 는 갈리는 유닛과 무관 → published.
    const es = decide({ langCode: ["es"] });
    expect(es.ok).toBe(true);
    expect(pairOf(es)).toEqual(reportPair((s) => s.langCode === "es"));
  });
});

describe("권한 — 좁히기가 아니라 게이트다", () => {
  it("무필터 admin = 헤드라인 104개 · 5,611 / 9,586", () => {
    const d = decide({});
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const sub = publishedSubtotal(d.selected)!;
    expect(sub.siteCount).toBe(104);
    expect([sub.hitPrompts, sub.measuredPrompts]).toEqual([5611, 9586]);
    expect(pct1(5611, 9586)).toBe(58.5);
  });

  it("스코프가 발행 모집단을 못 덮으면 **라이브** — 조용히 작은 수를 내지 않는다", () => {
    const onlyHyundai = runtimeAll.filter((r) => r.brand.startsWith("Hyundai"));
    const d = decide({}, onlyHyundai);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/^scope-narrower-than-publication:/);
  });

  it("브랜드 스코프 사용자는 브랜드를 골라도 라이브다 (그 수는 리포트에 없다)", () => {
    const onlyKia = runtimeAll.filter((r) => r.brand === "Kia");
    expect(decide({ brand: ["Kia"] }, onlyKia).ok).toBe(false);
  });

  it("런타임 분류가 비면 라이브 (프로젝트 0건)", () => {
    expect(decide({}, []).ok).toBe(false);
  });

  it("권한이 넓어도 발행 모집단 밖 유닛은 절대 더해지지 않는다", () => {
    const d = decide({});
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const chosen = new Set(d.selected.map((s) => s.fileSeq));
    for (const outside of [44, 106, 71, 94, 97]) expect(chosen.has(outside), `fs ${outside}`).toBe(false);
  });
});

describe("빈 결과", () => {
  it("발행물에 없는 국가만 고르면 라이브", () => {
    const d = decide({ countryCode: ["ZZ"] });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("no-published-sites");
  });

  it("발행물이 비면 라이브", () => {
    expect(decidePublishedSelection({ published: [], runtime: runtimeAll, axes: {} }).ok).toBe(false);
  });
});
