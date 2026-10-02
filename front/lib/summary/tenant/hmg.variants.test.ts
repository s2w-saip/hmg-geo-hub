/**
 * 테넌트 seam — `own_variant` 유도(PR② T3).
 *
 * 고정하는 것 셋:
 *  1. 변형 목록이 **명부 스냅샷에서 나온다**(코드 상수 아님) → 명부가 늘면 변형이 자동으로 는다.
 *  2. 변형의 `entityIds` 가 오늘 리더의 `$own`(`trackedEntityIdsFor([key], roster)`)과 **같다**.
 *  3. ⑤ 스코프 표가 오늘 리더의 `ownedBasePrefixesForScope(브랜드, [국가], [언어])` 를
 *     **모든 (국가, 언어)에서** 재현한다 — 이게 "단일 국가·단일 언어 정수 0 오차"의 근거다.
 */
import { describe, expect, it } from "vitest";
import { geoCountryCode } from "@/lib/geo-catalog";
import { GEO_OWNED_BASES, ownedBasePrefixFromUrl } from "@/lib/geo-catalog/owned";
import {
  HMG_BRAND_ALIAS_ENTITY_IDS,
  HMG_BRAND_ENTITY_IDS,
  ownedBasePrefixesForScope,
  trackedEntityIdsFor,
} from "@/lib/scope/hmg-brands";
import { assertVariants, OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import type { RosterEntity } from "@/lib/summary/generate/types";
import { globalBaseUniverse, ownVariants, resolveOwnCitationScope } from "./hmg";

/** 2026-09-10 라이브 `entity_registry(role='own')` 실측 10행과 같은 형태. */
const ROSTER: RosterEntity[] = [
  { id: HMG_BRAND_ENTITY_IDS.Genesis, name: "Genesis" },
  { id: HMG_BRAND_ENTITY_IDS.Hyundai, name: "Hyundai" },
  { id: HMG_BRAND_ENTITY_IDS.Kia, name: "Kia" },
  { id: HMG_BRAND_ALIAS_ENTITY_IDS.Kia[0], name: "기아" },
  { id: HMG_BRAND_ALIAS_ENTITY_IDS.Genesis[0], name: "제네시스" },
  { id: HMG_BRAND_ALIAS_ENTITY_IDS.Hyundai[0], name: "현대자동차" },
];

const globalOpts = {
  roster: ROSTER,
  basePrefixes: globalBaseUniverse(),
  scopeNarrowing: "catalog-geo" as const,
  langCase: "upper" as const,
};

const sel = (p: string[]) => [...new Set(p.map(ownedBasePrefixFromUrl).filter(Boolean))] as string[];

describe("ownVariants — 명부 유도", () => {
  it("ALL + 명부 브랜드 각각 = 4개 (실측 3사)", () => {
    expect(ownVariants(globalOpts).map((v) => v.key)).toEqual([
      OWN_VARIANT_ALL,
      "Genesis",
      "Hyundai",
      "Kia",
    ]);
  });

  it("명부에 브랜드가 추가되면 변형이 자동으로 는다 — 코드 상수가 아니다", () => {
    const grown = ownVariants({
      ...globalOpts,
      roster: [...ROSTER, { id: "11111111-1111-1111-1111-111111111111", name: "Ioniq" }],
    });
    expect(grown.map((v) => v.key)).toEqual([OWN_VARIANT_ALL, "Genesis", "Hyundai", "Ioniq", "Kia"]);
    expect(grown.find((v) => v.key === "Ioniq")!.entityIds).toEqual([
      "11111111-1111-1111-1111-111111111111",
    ]);
  });

  it("자국어 표기 명부 행은 정본 브랜드 변형으로 접힌다('기아' → Kia)", () => {
    const kia = ownVariants(globalOpts).find((v) => v.key === "Kia")!;
    expect(kia.entityIds).toEqual([HMG_BRAND_ENTITY_IDS.Kia, HMG_BRAND_ALIAS_ENTITY_IDS.Kia[0]]);
  });

  it("entityIds = 오늘 리더의 $own(trackedEntityIdsFor)", () => {
    for (const v of ownVariants(globalOpts)) {
      const expected =
        v.key === OWN_VARIANT_ALL
          ? trackedEntityIdsFor(undefined, ROSTER)
          : trackedEntityIdsFor([v.key], ROSTER);
      expect([...v.entityIds].sort(), v.key).toEqual([...expected].sort());
    }
  });

  it("ALL 은 명부 전량", () => {
    const all = ownVariants(globalOpts).find((v) => v.key === OWN_VARIANT_ALL)!;
    expect(all.entityIds).toEqual(ROSTER.map((e) => e.id));
  });

  it("assertVariants 를 통과한다(빈 목록·빈 entityIds·빈 citationScopes·중복 키 없음)", () => {
    expect(() => assertVariants(ownVariants(globalOpts))).not.toThrow();
  });

  it("명부가 비면 거부한다 — 조용히 0 이 되는 대신 죽는다", () => {
    expect(() => ownVariants({ ...globalOpts, roster: [] })).toThrow(/명부가 비었다/);
  });

  it("명부 표기가 예약 키 ALL 이면 거부한다", () => {
    expect(() =>
      ownVariants({
        ...globalOpts,
        roster: [...ROSTER, { id: "22222222-2222-2222-2222-222222222222", name: OWN_VARIANT_ALL }],
      }),
    ).toThrow(/예약 키/);
  });
});

describe("ownVariants — ⑤ 인용 스코프", () => {
  const variants = ownVariants(globalOpts);

  it("모든 변형이 와일드카드 행('','')을 갖는다 — 매칭 실패 시 bases 가 NULL 이 돼 분자가 조용히 0 이 된다", () => {
    for (const v of variants) {
      expect(v.citationScopes.filter((s) => s.country === "" && s.lang === ""), v.key).toHaveLength(1);
    }
  });

  it("와일드카드 = 오늘의 무필터 화면(ownedBasePrefixesForScope(브랜드))", () => {
    for (const v of variants) {
      const wild = v.citationScopes.find((s) => s.country === "" && s.lang === "")!;
      const bf = v.key === OWN_VARIANT_ALL ? undefined : [v.key];
      expect(wild.bases.sort(), v.key).toEqual(sel(ownedBasePrefixesForScope(bf, ROSTER)).sort());
    }
  });

  it("스코프 base 는 전부 base universe 안에 있다 — 세부층 matched_base 와 같은 정규형", () => {
    const universe = new Set(sel(globalBaseUniverse()));
    for (const v of variants) {
      for (const s of v.citationScopes) {
        for (const b of s.bases) expect(universe.has(b), `${v.key} ${s.country}/${s.lang} ${b}`).toBe(true);
      }
    }
  });

  it("스코프 행의 lang 은 세부층 표기(글로벌 대문자)다", () => {
    for (const s of variants[0].citationScopes) expect(s.lang).toBe(s.lang.toUpperCase());
    const lower = ownVariants({ ...globalOpts, langCase: "lower" });
    for (const s of lower[0].citationScopes) expect(s.lang).toBe(s.lang.toLowerCase());
  });

  it("국가를 좁히면 그 나라 base 만 남는다(2026-09-01 −12.83%p 수정과 같은 좁힘)", () => {
    const kia = variants.find((v) => v.key === "Kia")!;
    const kr = resolveOwnCitationScope(kia.citationScopes, "KR", "KO")!;
    expect(kr.bases).toEqual(["kia.com/kr"]);
    // 와일드카드(전 세계 Kia base)와 달라야 의미가 있다.
    const wild = kia.citationScopes.find((s) => s.country === "" && s.lang === "")!;
    expect(wild.bases.length).toBeGreaterThan(kr.bases.length);
  });

  /**
   * 핵심 단언 — 스코프 표가 오늘 리더 함수를 **전 (국가, 언어) 격자에서** 재현한다.
   * 격자는 카탈로그 축 전량 + 카탈로그에 없는 값(폴백 경로)을 함께 돈다.
   */
  it("resolveOwnCitationScope ≡ ownedBasePrefixesForScope (전 격자)", () => {
    const countries = [
      ...new Set(GEO_OWNED_BASES.map((e) => geoCountryCode(e.country)?.toUpperCase()).filter(Boolean)),
      "VN", // 데이터엔 있으나 카탈로그에 없는 국가(2026-09-10 실측)
      "ZZ",
      "",
    ] as string[];
    const langs = [
      ...new Set(GEO_OWNED_BASES.map((e) => e.language?.toUpperCase()).filter(Boolean)),
      "XX",
      "",
    ] as string[];
    for (const v of variants) {
      const bf = v.key === OWN_VARIANT_ALL ? undefined : [v.key];
      for (const c of countries) {
        for (const l of langs) {
          const got = resolveOwnCitationScope(v.citationScopes, c, l);
          const want = sel(
            ownedBasePrefixesForScope(bf, ROSTER, c ? [c] : undefined, l ? [l] : undefined),
          );
          expect([...(got?.bases ?? [])].sort(), `${v.key} ${c}/${l}`).toEqual([...want].sort());
        }
      }
    }
  });

  it("동점(한 축씩 명시)이면 국가 행이 이긴다 — 리더가 국가를 먼저 좁힌다", () => {
    const rows = [
      { country: "", lang: "", bases: ["w"], fallbackPattern: null },
      { country: "", lang: "EN", bases: ["l"], fallbackPattern: null },
      { country: "KR", lang: "", bases: ["c"], fallbackPattern: null },
      { country: "KR", lang: "KO", bases: ["cl"], fallbackPattern: null },
    ];
    expect(resolveOwnCitationScope(rows, "KR", "KO")!.bases).toEqual(["cl"]);
    expect(resolveOwnCitationScope(rows, "KR", "EN")!.bases).toEqual(["c"]);
    expect(resolveOwnCitationScope(rows, "US", "EN")!.bases).toEqual(["l"]);
    expect(resolveOwnCitationScope(rows, "US", "DE")!.bases).toEqual(["w"]);
  });
});

describe("ownVariants — 웹사이트 표면(scopeNarrowing: none)", () => {
  const websiteOpts = {
    roster: ROSTER,
    basePrefixes: ["kia.com/no", "kia.com/dk"],
    scopeNarrowing: "none" as const,
    langCase: "lower" as const,
  };

  it("변형은 같은 4개지만 ⑤ 스코프는 와일드카드 1행(선언 base 전량)", () => {
    const v = ownVariants(websiteOpts);
    expect(v.map((x) => x.key)).toEqual([OWN_VARIANT_ALL, "Genesis", "Hyundai", "Kia"]);
    for (const x of v) {
      expect(x.citationScopes).toHaveLength(1);
      expect(x.citationScopes[0]).toMatchObject({ country: "", lang: "", bases: ["kia.com/no", "kia.com/dk"] });
    }
  });

  it("assertVariants 를 통과한다", () => {
    expect(() => assertVariants(ownVariants(websiteOpts))).not.toThrow();
  });
});
