import { describe, expect, it } from "vitest";
import {
  HMG_BRAND_ENTITY_IDS,
  HMG_BRAND_ALIAS_ENTITY_IDS,
  trackedRosterFor,
  trackedEntityIdsFor,
  trackedBrandNameSetFor,
  narrowScopeBrands,
  resolveHmgBrandName,
  rollupCanonicalPairs,
  ownedBasePrefixesForScope,
  hmgBrandByNamePrefix,
  hmgRollupIdByNamePrefix,
} from "./hmg-brands";
import { GEO_OWNED_BASES } from "@/lib/geo-catalog/owned";

// 당사 판정 정본의 계약 — (1) 축E 스코프 교집합, (2) 빈 교집합 폴백,
// (3) 레지스트리 로스터 주입 시 시드 대체, (4) 미주입/빈 명부 시 시드 폴백,
// (5) 표기 변형 알리아스(자국어 rollup id) 포함·정규화.

const SEED_TOTAL =
  Object.keys(HMG_BRAND_ENTITY_IDS).length +
  Object.values(HMG_BRAND_ALIAS_ENTITY_IDS).flat().length;

describe("trackedRosterFor (시드 폴백)", () => {
  it("무필터 → 3사 전체 (정본 + 표기 알리아스)", () => {
    const ids = trackedEntityIdsFor();
    expect(ids).toHaveLength(SEED_TOTAL);
    expect(ids).toContain(HMG_BRAND_ENTITY_IDS.Hyundai);
    expect(ids).toContain(HMG_BRAND_ENTITY_IDS.Kia);
    expect(ids).toContain(HMG_BRAND_ENTITY_IDS.Genesis);
    for (const alias of Object.values(HMG_BRAND_ALIAS_ENTITY_IDS).flat()) {
      expect(ids).toContain(alias);
    }
  });

  it("축E 교집합 — 컨텍스트 [Kia] → Kia만 (알리아스 id 포함)", () => {
    expect(trackedEntityIdsFor(["Kia"])).toEqual([
      HMG_BRAND_ENTITY_IDS.Kia,
      ...HMG_BRAND_ALIAS_ENTITY_IDS.Kia,
    ]);
    expect([...trackedBrandNameSetFor(["Kia"])]).toEqual(["Kia"]);
  });

  it("교집합이 비면 전체 폴백 (빈 IN 절 방지)", () => {
    expect(trackedEntityIdsFor(["Toyota"])).toHaveLength(SEED_TOTAL);
  });
});

describe("표기 변형 알리아스 (2026-08-05)", () => {
  it("resolveHmgBrandName — 정본/대소문자/자국어 표기 해석", () => {
    expect(resolveHmgBrandName("Kia")).toBe("Kia");
    expect(resolveHmgBrandName("kia")).toBe("Kia");
    expect(resolveHmgBrandName("기아")).toBe("Kia");
    expect(resolveHmgBrandName("현대자동차")).toBe("Hyundai");
    expect(resolveHmgBrandName("هيونداي")).toBe("Hyundai");
    expect(resolveHmgBrandName("제네시스")).toBe("Genesis");
    expect(resolveHmgBrandName("Toyota")).toBeNull();
  });

  it("rollupCanonicalPairs (시드) — 알리아스 id → 정본 id", () => {
    const pairs = rollupCanonicalPairs();
    expect(pairs).toHaveLength(Object.values(HMG_BRAND_ALIAS_ENTITY_IDS).flat().length);
    for (const [alias, canon] of pairs) {
      expect(Object.values(HMG_BRAND_ALIAS_ENTITY_IDS).flat()).toContain(alias);
      expect(Object.values(HMG_BRAND_ENTITY_IDS)).toContain(canon);
    }
  });

  it("rollupCanonicalPairs (레지스트리) — 자국어 표기 행도 정본으로 접힘", () => {
    const roster = [
      { id: HMG_BRAND_ENTITY_IDS.Kia, name: "Kia" },
      { id: "id-kia-ko", name: "기아" },
      { id: "id-4th", name: "Ioniq" }, // 비3사 — 페어 없음
    ];
    expect(rollupCanonicalPairs(roster)).toEqual([["id-kia-ko", HMG_BRAND_ENTITY_IDS.Kia]]);
  });

  it("축E 교집합 — 레지스트리에 자국어 표기로 등록된 행도 브랜드 필터에 포함", () => {
    const roster = [
      { id: HMG_BRAND_ENTITY_IDS.Kia, name: "Kia" },
      { id: "id-kia-ko", name: "기아" },
      { id: HMG_BRAND_ENTITY_IDS.Hyundai, name: "Hyundai" },
    ];
    expect(trackedEntityIdsFor(["Kia"], roster)).toEqual([
      HMG_BRAND_ENTITY_IDS.Kia,
      "id-kia-ko",
    ]);
  });
});

describe("trackedRosterFor (레지스트리 로스터 주입)", () => {
  const roster = [
    { id: "id-hyundai", name: "Hyundai" },
    { id: "id-kia", name: "Kia" },
    { id: "id-ioniq", name: "Ioniq" }, // admin이 자사로 추가한 가상의 4번째 브랜드
  ];

  it("로스터가 시드를 대체한다", () => {
    expect(trackedEntityIdsFor(undefined, roster)).toEqual([
      "id-hyundai",
      "id-kia",
      "id-ioniq",
    ]);
  });

  it("축E 교집합이 로스터 기준으로 동작", () => {
    expect(trackedEntityIdsFor(["Ioniq"], roster)).toEqual(["id-ioniq"]);
  });

  it("교집합이 비면 로스터 전체 폴백", () => {
    expect(trackedEntityIdsFor(["Toyota"], roster)).toHaveLength(3);
  });

  it("빈 로스터([])는 시드 폴백", () => {
    expect([...new Set(trackedRosterFor(undefined, []).map((e) => e.name))]).toEqual([
      "Hyundai",
      "Kia",
      "Genesis",
    ]);
  });
});

describe("narrowScopeBrands (필터 옵션·데이터 읽기 공용 유효 스코프)", () => {
  it("브랜드 선택 없음 → 계정 스코프 그대로", () => {
    const scope = { all: true as const };
    expect(narrowScopeBrands(scope)).toBe(scope);
    expect(narrowScopeBrands(scope, [])).toBe(scope);
  });

  it("admin(all) + 브랜드 선택 → 선택 브랜드로 좁힘", () => {
    expect(narrowScopeBrands({ all: true }, ["Hyundai"])).toEqual({
      all: false,
      brands: ["Hyundai"],
    });
  });

  it("브랜드 락 없음(brands 미설정) + 선택 → 선택 브랜드 사용", () => {
    expect(narrowScopeBrands({ all: false }, ["Kia"])).toEqual({
      all: false,
      brands: ["Kia"],
    });
  });

  it("브랜드 락 계정 → 락 ∩ 선택", () => {
    expect(narrowScopeBrands({ all: false, brands: ["Hyundai", "Genesis"] }, ["Genesis"])).toEqual({
      all: false,
      brands: ["Genesis"],
    });
  });

  it("교집합이 비면 락 전체로 폴백 (빈 배열 유출 금지 — 스코프 우회 방지)", () => {
    expect(narrowScopeBrands({ all: false, brands: ["Kia"] }, ["Hyundai"])).toEqual({
      all: false,
      brands: ["Kia"],
    });
  });

  it("countries/regions 등 다른 축은 보존", () => {
    expect(
      narrowScopeBrands({ all: false, brands: ["Kia"], countries: ["IT"] } as {
        all: boolean;
        brands?: string[];
        countries?: string[];
      }, ["Kia"]),
    ).toEqual({ all: false, brands: ["Kia"], countries: ["IT"] });
  });
});

describe("ownedBasePrefixesForScope — 공식(당사) 인용 판정 베이스 (2026-08-05 축E 통일)", () => {
  const ALL = GEO_OWNED_BASES.map((e) => e.prefix);
  const brandOf = new Map(GEO_OWNED_BASES.map((e) => [e.prefix, e.brand]));

  it("무필터 → 3사 전체 카탈로그 베이스 (종전 전사값과 동일 — 무필터 불변 회귀 기준)", () => {
    expect(ownedBasePrefixesForScope()).toEqual(ALL);
  });

  it("축E 교집합 — [Hyundai] → Hyundai 베이스만 (kia/genesis 프리픽스 배제)", () => {
    const prefixes = ownedBasePrefixesForScope(["Hyundai"]);
    expect(prefixes.length).toBeGreaterThan(0);
    for (const p of prefixes) expect(brandOf.get(p)).toBe("Hyundai");
    expect(prefixes.some((p) => p.startsWith("kia."))).toBe(false);
    expect(prefixes.some((p) => p.startsWith("genesis."))).toBe(false);
  });

  it("교집합이 비면 3사 전체 폴백 (판정 공집합 방지 — trackedRosterFor 와 동일 규칙)", () => {
    expect(ownedBasePrefixesForScope(["Toyota"])).toEqual(ALL);
  });

  it("알리아스 표기 로스터('기아')도 정본 브랜드로 해석된다", () => {
    const roster = [{ id: "x", name: "기아" }];
    const prefixes = ownedBasePrefixesForScope(["Kia"], roster);
    expect(prefixes.length).toBeGreaterThan(0);
    for (const p of prefixes) expect(brandOf.get(p)).toBe("Kia");
  });

  it("전부 비HMG 표기 로스터(해석 불가) → 3사 전체 폴백", () => {
    const roster = [{ id: "x", name: "SomethingElse" }];
    expect(ownedBasePrefixesForScope(["SomethingElse"], roster)).toEqual(ALL);
  });

  // 2026-09-01 — 국가·언어 축이 판정에 배선되지 않아 **다른 나라·다른 언어의 자사
  // 사이트 인용이 그 화면의 성과로 잡히던** 회귀의 방지선. 실측: Kia/KR 화면 ⑤ 가
  // 58.60% 로 보였으나 kia.com/kr 만 세면 55.28%, 전 사이트 평균 44.33 → 31.50%.
  describe("국가·언어 축 좁히기", () => {
    const countryOf = new Map(GEO_OWNED_BASES.map((e) => [e.prefix, e.country]));

    it("국가를 좁히면 그 나라 베이스만 남는다 (Kia + KR → kia.com/kr)", () => {
      expect(ownedBasePrefixesForScope(["Kia"], undefined, ["KR"])).toEqual(["kia.com/kr"]);
    });

    it("국가 무필터는 종전과 동일 — 브랜드 전체 베이스 (무변경 회귀 기준)", () => {
      const withUndefined = ownedBasePrefixesForScope(["Kia"], undefined, undefined);
      const withEmpty = ownedBasePrefixesForScope(["Kia"], undefined, []);
      expect(withEmpty).toEqual(withUndefined);
      expect(withUndefined.length).toBeGreaterThan(1);
    });

    it("국가 다중 선택은 합집합", () => {
      const two = ownedBasePrefixesForScope(["Kia"], undefined, ["KR", "NO"]);
      expect(new Set(two)).toEqual(new Set(["kia.com/kr", "kia.com/no"]));
    });

    it("언어까지 좁히면 같은 도메인의 다른 언어 베이스가 빠진다 (현대 캐나다)", () => {
      const both = ownedBasePrefixesForScope(["Hyundai"], undefined, ["CA"]);
      expect(new Set(both)).toEqual(new Set(["hyundaicanada.com", "hyundaicanada.com/fr"]));
      expect(ownedBasePrefixesForScope(["Hyundai"], undefined, ["CA"], ["fr"])).toEqual([
        "hyundaicanada.com/fr",
      ]);
      expect(ownedBasePrefixesForScope(["Hyundai"], undefined, ["CA"], ["en"])).toEqual([
        "hyundaicanada.com",
      ]);
    });

    it("교집합이 비면 좁히기 전 목록으로 폴백 (판정 공집합 방지)", () => {
      const brandOnly = ownedBasePrefixesForScope(["Kia"]);
      expect(ownedBasePrefixesForScope(["Kia"], undefined, ["ZZ"])).toEqual(brandOnly);
      expect(ownedBasePrefixesForScope(["Kia"], undefined, ["KR"], ["xx"])).toEqual([
        "kia.com/kr",
      ]);
    });

    // 2026-09-01 — 카탈로그 원천의 사이트 URL 오등록 교정(OWNED_BASE_URL_FIXES).
    // hyundai.com/kr/ko/e 가 base 로 잡히면 현대 한국 타겟 116개 중 56개가 자사 밖으로
    // 떨어진다(실측). 원천 xlsx 를 다시 추출해도 살아남아야 하므로 값을 못박는다.
    it("원천 오등록 URL 이 교정된 base 로 들어온다", () => {
      expect(ownedBasePrefixesForScope(["Hyundai"], undefined, ["KR"])).toEqual([
        "hyundai.com/kr/ko",
      ]);
      expect(GEO_OWNED_BASES.some((e) => e.prefix === "hyundai.com/kr/ko/e")).toBe(false);
      expect(GEO_OWNED_BASES.some((e) => e.prefix === "genesis.com/ru/ru/genesis")).toBe(false);
      expect(GEO_OWNED_BASES.some((e) => e.prefix === "genesis.com/ru/ru")).toBe(true);
    });

    // 베이스가 4단계 이상으로 깊어지면 그 아래 콘텐츠 대부분이 자사에서 빠진다 —
    // 위 두 건이 그렇게 새던 경로다. 새 오등록이 유입되면 여기서 걸린다.
    it("자사 base 에 3단계(호스트+경로2)를 넘는 접두가 없다", () => {
      const deep = GEO_OWNED_BASES.filter((e) => e.prefix.split("/").length > 3);
      expect(deep.map((e) => e.prefix)).toEqual([]);
    });

    it("좁힌 결과는 항상 요청한 브랜드·국가에 속한다", () => {
      for (const cc of ["KR", "US", "CA", "IT"]) {
        for (const p of ownedBasePrefixesForScope(["Kia"], undefined, [cc])) {
          expect(brandOf.get(p)).toBe("Kia");
          expect(countryOf.get(p)).toBeTruthy();
        }
      }
    });
  });
});

describe("hmgBrandByNamePrefix — 표기 접두 교정 (2026-08-28)", () => {
  it("scope rollup 이 틀린 브랜드를 가리키는 실측 케이스를 표기로 되돌린다", () => {
    // 미러 전수조사에서 확인된 오귀속 (→ 실제 rollup 브랜드)
    expect(hmgBrandByNamePrefix("Genesis G70 3.3T")).toBe("Genesis"); // → Dodge
    expect(hmgBrandByNamePrefix("Hyundai Verna")).toBe("Hyundai"); // → Suzuki
    expect(hmgBrandByNamePrefix("Kia Pro Cee'd")).toBe("Kia"); // → BMW
    expect(hmgBrandByNamePrefix("Hyundai Creta Electric")).toBe("Hyundai"); // → Tata
    expect(hmgBrandByNamePrefix("Kia Seltos Hybrid")).toBe("Kia"); // → MG
    expect(hmgBrandByNamePrefix("Hyundai i30 Fastback")).toBe("Hyundai"); // → Ora
  });

  it("당사 파생 표기(별도 rollup 으로 떨어져 있던 것)도 3사로 접는다", () => {
    expect(hmgBrandByNamePrefix("Kia Charge")).toBe("Kia");
    expect(hmgBrandByNamePrefix("Hyundai Canada")).toBe("Hyundai");
    expect(hmgBrandByNamePrefix("Hyundai N")).toBe("Hyundai");
  });

  it("정본 표기 자체와 자국어 표기", () => {
    expect(hmgBrandByNamePrefix("Genesis")).toBe("Genesis");
    expect(hmgBrandByNamePrefix("제네시스 G80")).toBe("Genesis");
    expect(hmgBrandByNamePrefix("현대자동차")).toBe("Hyundai");
    expect(hmgBrandByNamePrefix("현대차")).toBe("Hyundai");
    expect(hmgBrandByNamePrefix("기아 EV6")).toBe("Kia");
    expect(hmgBrandByNamePrefix("هيونداي كونا")).toBe("Hyundai");
  });

  it("경계 없는 부분일치는 잡지 않는다", () => {
    expect(hmgBrandByNamePrefix("Genesisian")).toBeNull();
    expect(hmgBrandByNamePrefix("Kiap")).toBeNull();
    // 접두가 아니라 중간에 있는 것도 아니다 (귀속은 표기 머리 기준)
    expect(hmgBrandByNamePrefix("Toyota Hyundai comparison")).toBeNull();
  });

  it("비HMG·빈 값", () => {
    expect(hmgBrandByNamePrefix("Bugatti Chiron")).toBeNull();
    expect(hmgBrandByNamePrefix("")).toBeNull();
    expect(hmgBrandByNamePrefix(null)).toBeNull();
    expect(hmgBrandByNamePrefix(undefined)).toBeNull();
  });

  it("hmgRollupIdByNamePrefix 는 정본 entity_id 를 돌려준다", () => {
    expect(hmgRollupIdByNamePrefix("Genesis G70 3.3T")).toBe(
      HMG_BRAND_ENTITY_IDS.Genesis,
    );
    expect(hmgRollupIdByNamePrefix("Bugatti")).toBeNull();
  });
});
