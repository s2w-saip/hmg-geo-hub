import { describe, expect, it } from "vitest";
import { canonicalBrandDisplayName, BRAND_DISPLAY_ALIAS_ENTRIES } from "./brand-display-aliases";

// 표시명 병합 사전의 계약 — HMG 우선 해석, 경쟁 사전, 비등재 항등.
describe("canonicalBrandDisplayName", () => {
  it("HMG 자국어/대소문자 표기 → 정본", () => {
    expect(canonicalBrandDisplayName("기아")).toBe("Kia");
    expect(canonicalBrandDisplayName("هيونداي")).toBe("Hyundai");
    expect(canonicalBrandDisplayName("kia")).toBe("Kia");
  });

  it("경쟁사 자국어/철자 변형 → 정본", () => {
    expect(canonicalBrandDisplayName("폭스바겐")).toBe("Volkswagen");
    expect(canonicalBrandDisplayName("메르세데스-벤츠")).toBe("Mercedes-Benz");
    expect(canonicalBrandDisplayName("هوندا")).toBe("Honda");
    expect(canonicalBrandDisplayName("טויוטה")).toBe("Toyota");
    expect(canonicalBrandDisplayName("Skoda")).toBe("Škoda");
    expect(canonicalBrandDisplayName("Mini")).toBe("MINI");
  });

  it("2026-08-29 알리아스 누락 보강 — 자국어 표기가 라틴 정본으로 접힌다", () => {
    // 미러 전수 감사에서 **노이즈가 아니라 병합 대상**으로 판정된 13개.
    // 제외 목록(non-competitor-brands)에 잘못 넣으면 진짜 경쟁사 언급이 사라진다.
    expect(canonicalBrandDisplayName("테슬라")).toBe("Tesla");
    expect(canonicalBrandDisplayName("루시드")).toBe("Lucid");
    expect(canonicalBrandDisplayName("تويوتا")).toBe("Toyota");
    expect(canonicalBrandDisplayName("奔驰")).toBe("Mercedes-Benz");
    expect(canonicalBrandDisplayName("宝马")).toBe("BMW");
    expect(canonicalBrandDisplayName("نيسان")).toBe("Nissan");
    expect(canonicalBrandDisplayName("KG 모빌리티")).toBe("KG Mobility");
    expect(canonicalBrandDisplayName("זיקר")).toBe("Zeekr");
    expect(canonicalBrandDisplayName("מרצדס")).toBe("Mercedes-Benz");
    expect(canonicalBrandDisplayName("שברולט")).toBe("Chevrolet");
    expect(canonicalBrandDisplayName("ב.מ.וו")).toBe("BMW");
    expect(canonicalBrandDisplayName("엑스펑")).toBe("XPeng");
    expect(canonicalBrandDisplayName("피닌파리나")).toBe("Pininfarina");
  });

  it("2026-08-30 라틴 표기 변형 — 대소문자만 다른 진짜 브랜드는 정본으로 접힌다", () => {
    // 미러 전수 감사(정규화 키 충돌)에서 라틴 행은 4쌍이 전부였고, 그중
    // 하위 제품을 가진 진짜 브랜드 3쌍만 병합 대상이다.
    expect(canonicalBrandDisplayName("Xpeng")).toBe("XPeng");
    expect(canonicalBrandDisplayName("Mini")).toBe("MINI");
    expect(canonicalBrandDisplayName("Skoda")).toBe("Škoda");
    // 정본 표기는 그대로 통과(항등) — 접기가 정본을 다시 건드리지 않는다.
    expect(canonicalBrandDisplayName("XPeng")).toBe("XPeng");
  });

  it("Vivo/vivo 는 병합하지 않는다 — 브랜드가 아니라 'en vivo' 절단 노이즈", () => {
    // 알리아스로 접으면 노이즈가 정본으로 승격된다. 올바른 처리는 제외 목록이며
    // 그 판단은 별건이다. 누가 조용히 병합하면 이 가드가 깨진다.
    expect(canonicalBrandDisplayName("vivo")).toBe("vivo");
    expect(canonicalBrandDisplayName("Vivo")).toBe("Vivo");
  });

  it("판단 보류(c) 표기는 접지 않는다 — 조용히 병합되면 이 가드가 깨진다", () => {
    // 경쟁사 현지법인·서브브랜드는 부모에 병합하지 않는다(메르세데스-AMG 선례).
    for (const n of ["아우디코리아", "폭스바겐 그룹", "토요타 GR", "BMW코리아",
      "메르세데스-벤츠 코리아", "벤츠/BMW", "红旗"]) {
      expect(canonicalBrandDisplayName(n), n).toBe(n);
    }
  });

  it("비등재 브랜드는 항등", () => {
    expect(canonicalBrandDisplayName("Toyota")).toBe("Toyota");
    expect(canonicalBrandDisplayName("BYD")).toBe("BYD");
    expect(canonicalBrandDisplayName("현대모비스")).toBe("현대모비스");
  });

  it("SQL CASE 엔트리 — 정본이 다시 알리아스로 남지 않는다(무한 접기 방지)", () => {
    const aliases = new Set(BRAND_DISPLAY_ALIAS_ENTRIES.map(([a]) => a));
    for (const [, canon] of BRAND_DISPLAY_ALIAS_ENTRIES) {
      expect(aliases.has(canon)).toBe(false);
    }
  });
});
