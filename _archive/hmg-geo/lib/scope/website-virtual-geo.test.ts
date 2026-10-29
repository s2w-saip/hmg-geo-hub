import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deriveMatrixOptions } from "@/components/dash/dimension-filter-panel";
import { fileURLToPath } from "node:url";
import {
  WEBSITE_BRAND_GEO_CODES,
  isWebsiteBrandGeoCode,
  splitWebsiteGeo,
  websiteBrandGeoCodesFor,
  withWebsiteBrandGeoCombos,
} from "./website-virtual-geo";

describe("웹사이트 브랜드 가상 지역 코드 (HYUNDAI-N → website_sites.brand)", () => {
  it("가상 코드와 실 코드를 가른다 — 브랜드는 중복 없이", () => {
    expect(splitWebsiteGeo(["KR", "HYUNDAI-N", "worldwide", "HYUNDAI-N"])).toEqual({
      countries: ["KR", "worldwide"],
      brands: ["Hyundai N"],
    });
  });

  it("가상 코드가 없으면 브랜드 절이 비어 종전 술어와 동일하다", () => {
    expect(splitWebsiteGeo(["KR", "EU"])).toEqual({ countries: ["KR", "EU"], brands: [] });
  });

  it("스코프 사이트 브랜드에서 드롭다운 가상 코드를 낸다", () => {
    expect(websiteBrandGeoCodesFor(["Hyundai", "Hyundai N"])).toEqual(["HYUNDAI-N"]);
    expect(websiteBrandGeoCodesFor(["Hyundai", "Kia"])).toEqual([]);
  });

  it("코드는 ISO 2자·기존 가상 코드와 충돌하지 않는다", () => {
    for (const code of Object.keys(WEBSITE_BRAND_GEO_CODES)) {
      expect(code).not.toMatch(/^[A-Z]{2}$/);
      expect(["worldwide", "EU", "MIDDLEEAST"]).not.toContain(code);
      expect(isWebsiteBrandGeoCode(code)).toBe(true);
    }
    expect(isWebsiteBrandGeoCode("KR")).toBe(false);
  });

  // 2026-09-06 프로덕션 실측: 웹사이트 페이지는 옵션 매트릭스를 넘기고 패널은 매트릭스가
  // 있으면 listWebsiteCountries 를 무시한다 — 매트릭스에도 가상 코드 행이 있어야 한다.
  it("옵션 매트릭스에 가상 코드 행을 덧붙여 패널 파생 목록에 HYUNDAI-N 이 나온다", () => {
    const matrix = withWebsiteBrandGeoCombos([
      { brand: "Hyundai", region: "worldwide", lang: "en" },
      { brand: "Hyundai N", region: "worldwide", lang: "en" },
      { brand: "Hyundai N", region: "KR", lang: "ko" },
      { brand: "Kia", region: "KR", lang: "ko" },
    ]);
    expect(matrix.filter((r) => r.region === "HYUNDAI-N")).toEqual([
      { brand: "Hyundai N", region: "HYUNDAI-N", lang: "en" },
      { brand: "Hyundai N", region: "HYUNDAI-N", lang: "ko" },
    ]);
    // 원행 유지 — worldwide/KR 선택은 종전 그대로.
    expect(matrix.filter((r) => r.region === "worldwide")).toHaveLength(2);
    const all = deriveMatrixOptions(matrix, null, undefined);
    expect(all.regions).toContain("HYUNDAI-N");
    // 가상 코드를 고르면 언어는 현대 N 사이트의 언어(en·ko)만 남는다.
    expect(deriveMatrixOptions(matrix, null, ["HYUNDAI-N"]).languages).toEqual(["en", "ko"]);
    // 브랜드 draft 가 Hyundai 면 현대 N 행은 빠진다(다른 브랜드).
    expect(deriveMatrixOptions(matrix, ["Hyundai"], undefined).regions).not.toContain("HYUNDAI-N");
  });

  // 회귀 가드 — website_sites 를 country_code 로 좁히는 SQL 은 전부 splitWebsiteGeo
  // 를 거쳐야 한다. 직접 `ws.country_code IN` 을 쓰면 그 경로에서만 가상 코드가
  // 0건이 된다.
  it("website_sites.country_code 술어가 가상 코드 분기 없이 남아 있지 않다", () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
    for (const rel of [
      "lib/db/repositories/scope-aggregates.ts",
      "lib/db/repositories/summary-website-aggregates.ts",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/ws\.country_code IN \(\$\{inList\(f(ilters)?\.websiteCountry\)\}\)/);
      expect(src, rel).not.toMatch(/ws\.country_code = ANY\(\$\{textArray\(f\.websiteCountry\)\}\)/);
      expect(src, rel).toMatch(/websiteSiteGeoPred|summaryCountryGeoPred/);
    }
  });
});
