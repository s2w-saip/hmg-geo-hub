import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { effectiveCountries, websiteScopeCountryCondition } from "./website-sites";

// website_sites has no region column — scope.regions (RHQ buckets) must resolve
// to country codes here or a region-only account (e.g. seed's region@hmg.test:
// brands=["Hyundai"], regions=["hyundai-europe"], countries unset) sees every
// country worldwide instead of just its region.
describe("effectiveCountries", () => {
  it("resolves a region-only scope to that region's countries", () => {
    const countries = effectiveCountries({ all: false, regions: ["hyundai-europe"] });
    expect(countries).toContain("DE");
    expect(countries).not.toBeNull();
    expect(countries).not.toContain("KR"); // asia-pacific, not europe
  });

  it("returns explicit countries unchanged when no region is set", () => {
    expect(effectiveCountries({ all: false, countries: ["KR"] })).toEqual(["KR"]);
  });

  it("intersects region and explicit countries when both are set (country role)", () => {
    // seed's country@hmg.test: regions=["hyundai-asia-pacific"], countries=["KR"]
    const countries = effectiveCountries({
      all: false,
      regions: ["hyundai-asia-pacific"],
      countries: ["KR"],
    });
    expect(countries).toEqual(["KR"]);
  });

  it("drops an explicit country outside the region (defense in depth)", () => {
    const countries = effectiveCountries({
      all: false,
      regions: ["hyundai-europe"],
      countries: ["KR"], // KR is asia-pacific, not europe
    });
    expect(countries).toEqual([]);
  });

  it("returns null (no restriction) when neither region nor country is set", () => {
    expect(effectiveCountries({ all: false, brands: ["Hyundai"] })).toBeNull();
  });

  it("does not special-case scope.all — still resolves stray region/country values", () => {
    // effectiveCountries itself doesn't look at .all — the caller
    // (getProjectIdsForScope) already skips this function entirely when
    // scope.all. Documented here so a future refactor doesn't assume this
    // function short-circuits on .all itself.
    expect(effectiveCountries({ all: true, regions: ["hyundai-europe"], countries: ["KR"] })).toEqual([]);
  });
});

// 제네시스 사우디 도시별 사이트(SA-Dammam·SA-Jeddah·SA-Riyadh, migration 0056)는
// ISO 가 아니라 RHQ 맵에 없다 — SA 를 허용하는 스코프가 셋을 함께 봐야 중동 권역
// 계정이 사우디 사이트를 잃지 않는다. CN-BJ 는 합작사 별도 사이트라 CN 에 딸리지 않는다.
describe("effectiveCountries — pseudo city codes", () => {
  it("region scope that covers SA also covers the Saudi city sites", () => {
    const countries = effectiveCountries({ all: false, regions: ["genesis-middle-east"] });
    expect(countries).toContain("SA");
    expect(countries).toEqual(expect.arrayContaining(["SA-Dammam", "SA-Jeddah", "SA-Riyadh"]));
  });

  it("a Saudi city account keeps its city plus SA, and the region intersection does not drop it", () => {
    const countries = effectiveCountries({
      all: false,
      regions: ["genesis-middle-east"],
      countries: ["SA-Dammam", "SA"],
    });
    expect(countries).toEqual(["SA", "SA-Dammam", "SA-Jeddah", "SA-Riyadh"]);
  });

  it("CN scope does not gain Beijing Hyundai (explicit account scope only)", () => {
    expect(effectiveCountries({ all: false, countries: ["CN"] })).toEqual(["CN"]);
  });
});

// 가상코드(비 ISO) = RHQ 맵 ISO 유니버스(ALL_RHQ_COUNTRIES) 밖의 값. 관리자가 계정에
// **명시적으로** 부여한 사이트 단위 코드라 권역 교집합을 거치지 않고 통과한다 —
// 권역 ISO 목록에 절대 들어갈 수 없으니 교집합을 태우면 항상 탈락한다(2026-09-29
// hyundai-cpo 계정이 CPO 사이트를 통째로 잃은 결함). ISO 는 종전대로 교집합 유지.
describe("effectiveCountries — virtual (non-ISO) site codes pass the region intersection", () => {
  const set = (xs: string[] | null) => new Set(xs ?? ["<null>"]);

  // 2026-09-29: CPO 는 전용 사이트 코드 — 웹사이트에서는 CPO 사이트만(US 는 글로벌 전용).
  it("hyundai-cpo: [CPO, US] + North America → CPO only on the website surface", () => {
    const c = effectiveCountries({
      all: false,
      brands: ["Hyundai"],
      regions: ["hyundai-north-america"],
      countries: ["CPO", "US"],
    });
    expect(set(c)).toEqual(new Set(["CPO"]));
  });

  it("hyundai-mea: MIDDLEEAST survives next to its in-region ISO countries", () => {
    const c = effectiveCountries({
      all: false,
      brands: ["Hyundai"],
      regions: ["hyundai-middle-east"],
      countries: ["MIDDLEEAST", "SA", "AE"],
    });
    expect(c).toEqual(expect.arrayContaining(["MIDDLEEAST", "SA", "AE"]));
  });

  it("genesis-mea: MIDDLEEAST survives, and SA still pulls the Saudi city codes", () => {
    const c = effectiveCountries({
      all: false,
      brands: ["Genesis"],
      regions: ["genesis-middle-east"],
      countries: ["MIDDLEEAST", "SA"],
    });
    expect(set(c)).toEqual(new Set(["MIDDLEEAST", "SA", "SA-Dammam", "SA-Jeddah", "SA-Riyadh"]));
  });

  it("hyundai-eur: EU is a 2-letter code but not an RHQ ISO — it still passes", () => {
    const c = effectiveCountries({
      all: false,
      brands: ["Hyundai"],
      regions: ["hyundai-europe"],
      countries: ["EU", "DE", "FR"],
    });
    expect(set(c)).toEqual(new Set(["EU", "DE", "FR"]));
  });

  it("hyundai-cn-bj: CN-BJ passes, CN stays via the intersection", () => {
    const c = effectiveCountries({
      all: false,
      brands: ["Hyundai"],
      regions: ["hyundai-asia-pacific"],
      countries: ["CN-BJ", "CN"],
    });
    expect(set(c)).toEqual(new Set(["CN-BJ", "CN"]));
  });

  it("an out-of-region ISO is still dropped even when a virtual code rides along", () => {
    const c = effectiveCountries({
      all: false,
      regions: ["hyundai-north-america"],
      countries: ["CPO", "KR"],
    });
    expect(c).toEqual(["CPO"]);
  });

  it("an out-of-region ISO alone still yields the empty set (KR + North America)", () => {
    expect(
      effectiveCountries({ all: false, regions: ["hyundai-north-america"], countries: ["KR"] }),
    ).toEqual([]);
  });

  it("region-only and country-only scopes are unchanged", () => {
    expect(effectiveCountries({ all: false, countries: ["CPO"] })).toEqual(["CPO"]);
    expect(set(effectiveCountries({ all: false, regions: ["hyundai-north-america"] }))).toEqual(
      new Set(["CA", "MX", "US"]),
    );
  });
});

// 빈 교집합은 "제한 없음"이 아니라 "허용 국가 0" 이다. 호출부가 `countries?.length`
// 로 조건을 생략하면 브랜드 전 사이트가 열린다(fail-open) — 조건 파생을 한 곳으로
// 모아 빈 집합을 `false` 로 고정한다.
describe("websiteScopeCountryCondition — fail-closed", () => {
  const render = (s: Parameters<typeof websiteScopeCountryCondition>[0]) => {
    const cond = websiteScopeCountryCondition(s);
    return cond ? new PgDialect().sqlToQuery(cond) : null;
  };

  it("empty intersection renders `false` (0 sites), not an omitted condition", () => {
    const q = render({ all: false, regions: ["hyundai-north-america"], countries: ["KR"] });
    expect(q).not.toBeNull();
    expect(q!.sql.trim()).toBe("false");
  });

  it("unknown region ids (empty expansion) also fail closed", () => {
    const q = render({ all: false, regions: ["no-such-region"] });
    expect(q!.sql.trim()).toBe("false");
  });

  it("non-empty set renders an IN list over website_sites.country_code", () => {
    const q = render({ all: false, regions: ["hyundai-north-america"], countries: ["CA", "US"] });
    expect(q!.sql).toContain('"country_code" in');
    expect(new Set(q!.params)).toEqual(new Set(["CA", "US"]));
  });

  it("no country/region restriction → null (no condition), as before", () => {
    expect(render({ all: false, brands: ["Hyundai"] })).toBeNull();
  });

  it("scope.all → null (admin sees every site)", () => {
    expect(render({ all: true })).toBeNull();
    expect(render({ all: true, regions: ["hyundai-europe"], countries: ["KR"] })).toBeNull();
  });
});

// 역할 5종 × 스코프 축 — 웹사이트 국가 파생이 역할별로 기대 집합을 내는지(행동 규칙 4).
// route·operator 축은 이 변경이 건드리지 않는다(route-policy / operator-policy 테스트).
describe("website country scope — 5 roles", () => {
  const cases: Array<[string, Parameters<typeof effectiveCountries>[0], string[] | null]> = [
    ["admin (scope.all)", { all: true }, null],
    ["hq (brand only)", { all: false, brands: ["Hyundai"] }, null],
    [
      "region (regions + explicit incl. virtual)",
      { all: false, brands: ["Hyundai"], regions: ["hyundai-europe"], countries: ["EU", "DE", "FR"] },
      ["DE", "EU", "FR"],
    ],
    [
      "country (region + own country + virtual)",
      { all: false, brands: ["Hyundai"], regions: ["hyundai-north-america"], countries: ["CPO", "US"] },
      ["CPO"],
    ],
    [
      "vendor (region + countries, out-of-region ISO dropped)",
      { all: false, brands: ["Hyundai"], regions: ["hyundai-europe"], countries: ["DE", "KR"] },
      ["DE"],
    ],
  ];
  it.each(cases)("%s", (_label, scope, expected) => {
    const cond = websiteScopeCountryCondition(scope);
    if (expected === null) {
      expect(cond).toBeNull();
      return;
    }
    const q = new PgDialect().sqlToQuery(cond!);
    expect([...(q.params as string[])].sort()).toEqual(expected);
  });
});

// 브랜드 가상코드(HYUNDAI-N, website-virtual-geo::WEBSITE_BRAND_GEO_CODES)는
// country_code 가 아니라 **브랜드**를 가리킨다. RHQ ISO 유니버스 밖이라 여집합 판정만
// 쓰면 사이트 가상코드처럼 통과해 버리는데, 경로마다 해석이 갈린다(목록·export 는
// ws.brand IN ('Hyundai N'), project id 게이트는 country_code IN ('HYUNDAI-N') = 0건).
// 통과 대상에서 빼서 ISO 처럼 권역 교집합을 거치게 한다 = 이 PR 이전과 같은 결과(탈락).
describe("effectiveCountries — brand virtual codes are not site codes", () => {
  // 2026-09-29: HYUNDAI-N·CPO 는 전용 사이트 코드가 됐다 — 있으면 웹사이트는 그것만
  // 본다(권역 교집합을 타지 않는다). 같은 배열의 US 는 글로벌 전용.
  it("dedicated site codes win on the website surface (HYUNDAI-N·CPO only, US dropped)", () => {
    expect(
      effectiveCountries({
        all: false,
        brands: ["Hyundai"],
        regions: ["hyundai-north-america"],
        countries: ["HYUNDAI-N", "CPO", "US"],
      }),
    ).toEqual(["HYUNDAI-N", "CPO"]);
  });
});

// 2026-09-29 제품 책임자: CPO·Hyundai N·WW 계정은 웹사이트에서 자기 사이트만 본다.
describe("전용 사이트 계정 — 웹사이트 표면", () => {
  const render = (s: Parameters<typeof websiteScopeCountryCondition>[0]) => {
    const cond = websiteScopeCountryCondition(s);
    return cond ? new PgDialect().sqlToQuery(cond) : null;
  };

  it("N 계정 [HYUNDAI-N, KR] → 사이트 브랜드 술어만(현대 본사 KR 사이트 제외)", () => {
    const q = render({ all: false, brands: ["Hyundai"], countries: ["HYUNDAI-N", "KR"] });
    expect(q!.sql).toContain('"brand" in');
    expect(q!.sql).not.toContain('"country_code" in');
    expect(q!.params).toEqual(["Hyundai N"]);
  });

  it("WW 계정 [worldwide] → worldwide 사이트만", () => {
    const q = render({ all: false, brands: ["Kia"], countries: ["worldwide"] });
    expect(q!.params).toEqual(["worldwide"]);
  });

  it("권역 허브 계정(MIDDLEEAST + 중동 ISO)은 전용 규칙 밖 — 종전대로 허브 + 국가", () => {
    const c = effectiveCountries({
      all: false,
      brands: ["Hyundai"],
      regions: ["hyundai-middle-east"],
      countries: ["MIDDLEEAST", "SA", "AE"],
    });
    expect(c).toContain("MIDDLEEAST");
    expect(c).toContain("SA");
  });
});
