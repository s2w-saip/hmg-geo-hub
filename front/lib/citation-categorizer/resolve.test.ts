import { describe, it, expect } from "vitest";
import { resolveCitationCategory, categorizeDomain } from "./index";
import type { CitationCategory } from "./taxonomy";

// 운영자 교정 > 저장된/전송된 row.category > 로컬 분류기 (제품 결정 2026-08-21).
// 단 row.category 는 **택소노미 안일 때만** 신뢰한다 (2026-09-04).
// 이 순서가 뒤집히면 scope 가 category 를 보내기 시작하는 순간 admin 화면이
// 조용히 무력화된다 — mock 인용 행은 이미 category 를 싣고 있어 지금도 재현된다.
const ov = (m: Record<string, CitationCategory>) =>
  new Map(Object.entries(m)) as ReadonlyMap<string, CitationCategory>;

describe("resolveCitationCategory — 우선순위", () => {
  it("오버라이드가 저장된 row.category 를 이긴다", () => {
    const o = ov({ "example.com": "Blogs & Reviews" });
    expect(resolveCitationCategory("Automotive Media", "example.com", o)).toBe("Blogs & Reviews");
  });

  it("오버라이드가 없으면 row.category 가 로컬 분류를 이긴다 (기존 동작 보존)", () => {
    expect(resolveCitationCategory("News & Media", "youtube.com", ov({}))).toBe("News & Media");
  });

  it("둘 다 없으면 로컬 분류기와 동일하다", () => {
    for (const d of ["youtube.com", "wikipedia.org", "kiaofstreetsboro.com", "zzz-unknown.test"]) {
      expect(resolveCitationCategory(null, d, ov({}))).toBe(categorizeDomain(d));
      expect(resolveCitationCategory(undefined, d)).toBe(categorizeDomain(d));
    }
  });

  it("오버라이드는 정규화된 키로 매칭된다 (www./대문자/공백)", () => {
    const o = ov({ "example.com": "Wiki & Reference" });
    for (const d of ["www.example.com", "EXAMPLE.com", " www.Example.com "]) {
      expect(resolveCitationCategory("Automotive Media", d, o)).toBe("Wiki & Reference");
    }
  });

  it("오버라이드 0행이면 (택소노미) row.category ?? categorizeDomain 과 동일하다", () => {
    const rows: Array<[string | null, string]> = [
      ["News & Media", "youtube.com"],
      [null, "youtube.com"],
      [null, "toyota.com"],
      ["Other", "wikipedia.org"],
    ];
    for (const [rc, d] of rows) {
      const expected = rc ?? categorizeDomain(d);
      expect(resolveCitationCategory(rc, d, ov({}))).toBe(expected);
      expect(resolveCitationCategory(rc, d, null)).toBe(expected);
      expect(resolveCitationCategory(rc, d)).toBe(expected);
    }
  });

  // 2026-09-04 회귀: 택소노미 밖 문자열이 그대로 통과해 UI 가 조용히 망가졌다
  // (색맵·i18n 슬러그가 전부 미스 → 회색 fallback + 영문/원문 라벨 노출).
  it("택소노미 밖 row.category 는 버리고 분류기로 내린다", () => {
    for (const [rc, d] of [
      ["커뮤니티/UGC", "youtube.com"],
      ["백과사전", "namu.wiki"],
      ["정부/공공", "consumer.go.kr"],
      ["Legacy Scope Label", "zzz-unknown.test"],
      ["", "toyota.com"],
    ] as Array<[string, string]>) {
      expect(resolveCitationCategory(rc, d, ov({}))).toBe(categorizeDomain(d));
    }
  });

  it("택소노미 밖이어도 오버라이드는 여전히 최우선", () => {
    const o = ov({ "youtube.com": "Blogs & Reviews" });
    expect(resolveCitationCategory("커뮤니티/UGC", "youtube.com", o)).toBe("Blogs & Reviews");
  });

  it("도메인이 비어도 죽지 않는다", () => {
    expect(resolveCitationCategory(null, "", ov({ "example.com": "Other" }))).toBe("Other");
    expect(resolveCitationCategory("News & Media", null, ov({}))).toBe("News & Media");
  });
});
