import { describe, it, expect } from "vitest";
import {
  RHQ_BRANDS,
  rhqRegionsForBrand,
  rhqForCountry,
  countriesForRhq,
  rhqLabel,
} from "./index";

describe("RHQ 정본 — brand × country → 권역", () => {
  it("3개 브랜드 정본을 보유하고, 권역 수는 브랜드마다 다르다", () => {
    expect(RHQ_BRANDS).toEqual(expect.arrayContaining(["Hyundai", "Kia", "Genesis"]));
    expect(rhqRegionsForBrand("Hyundai")).toHaveLength(6); // 단일 유럽
    expect(rhqRegionsForBrand("Kia")).toHaveLength(7); // 서유럽 + 동유럽 분리
    expect(rhqRegionsForBrand("Genesis")).toHaveLength(5); // 중남미 없음
  });

  it("매핑 기준은 website 측정 로스터다 — 글로벌(공통 프롬프트) 측정국으로 확장하지 않는다", () => {
    // 2026-08-31: 글로벌 표면 측정국(BE·BR — 공통 프롬프트가 그 국가에서 측정됨)을
    // 근거로 genesis-europe+BE·genesis-latin-america 를 신설했다가 당일 롤백.
    // 제네시스는 브라질 미진출이며, RHQ 정본은 브랜드가 실제 운영(website 측정)
    // 하는 국가 기준이어야 한다. 이 가드는 그 재발을 막는다.
    expect(rhqForCountry("Genesis", "BR")).toBeNull();
    expect(rhqForCountry("Genesis", "BE")).toBeNull();
  });

  it("같은 국가가 브랜드마다 다른 권역에 속한다 (RHQ는 brand 의존)", () => {
    // Pakistan: Hyundai 중동 vs Kia 아시아 & 태평양
    expect(rhqForCountry("Hyundai", "PK")).toBe("hyundai-middle-east");
    expect(rhqForCountry("Kia", "PK")).toBe("kia-asia-pacific");
    // Mexico: Hyundai 북아메리카 vs Kia 중남미
    expect(rhqForCountry("Hyundai", "MX")).toBe("hyundai-north-america");
    expect(rhqForCountry("Kia", "MX")).toBe("kia-central-south-america");
    // Kazakhstan: 3사 3색
    expect(rhqForCountry("Hyundai", "KZ")).toBe("hyundai-europe");
    expect(rhqForCountry("Kia", "KZ")).toBe("kia-eastern-europe");
    expect(rhqForCountry("Genesis", "KZ")).toBe("genesis-asia-pacific");
    // Puerto Rico: Hyundai/Kia 중남미 vs Genesis 북아메리카
    expect(rhqForCountry("Genesis", "PR")).toBe("genesis-north-america");
    expect(rhqForCountry("Hyundai", "PR")).toBe("hyundai-latin-america");
  });

  it("AU(호주)는 세 브랜드 모두 아시아·태평양 계열 권역", () => {
    expect(rhqForCountry("Hyundai", "AU")).toBe("hyundai-asia-pacific");
    expect(rhqForCountry("Kia", "AU")).toBe("kia-asia-pacific");
    expect(rhqForCountry("Genesis", "AU")).toBe("genesis-asia-pacific");
  });

  it("ISO 입력은 대소문자 무관", () => {
    expect(rhqForCountry("Hyundai", "au")).toBe("hyundai-asia-pacific");
  });

  it("권역 id의 ISO 목록 + 라벨(ko/en)", () => {
    expect(countriesForRhq("hyundai-north-america").sort()).toEqual(["CA", "MX", "US"]);
    expect(rhqLabel("kia-western-europe", "ko")).toBe("Europe(W)");
    expect(rhqLabel("kia-eastern-europe", "en")).toBe("Europe(E)");
    expect(rhqLabel("genesis-europe", "ko")).toBe("유럽");
  });

  it("미정의 국가/브랜드는 null/[]", () => {
    expect(rhqForCountry("Hyundai", "ZZ")).toBeNull();
    expect(rhqForCountry("Genesis", "PK")).toBeNull(); // Genesis는 PK 미진출
    expect(rhqRegionsForBrand("Toyota")).toEqual([]);
  });

  it("브랜드별 파티션 무결 — 한 국가는 정확히 한 권역에만", () => {
    for (const brand of ["Hyundai", "Kia", "Genesis"]) {
      const seen = new Set<string>();
      for (const r of rhqRegionsForBrand(brand)) {
        for (const c of r.countries) {
          expect(seen.has(c), `${brand} dup ${c}`).toBe(false);
          seen.add(c);
        }
      }
    }
  });
});
