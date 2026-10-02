// 공식(당사) 인용 비중(officialOwnShare) — 실 DB(read-only) 불변식 검증.
// DATABASE_URL이 있을 때만 실행 (CI 무DB skip). 로컬:
//   DATABASE_URL=... npx vitest run lib/db/repositories/scope-aggregates.official-share.int.test.ts
//
// 2026-08-05 축E 통일의 실데이터 안전망:
//  ① 무필터(3사 전체 베이스) 값 = 종전 전사 판정과 동일 모집단 — [0,100] 범위.
//  ② 같은 필터 모집단에서 당사(Hyundai) 판정 분자 ⊆ 전사 판정 분자 → share ≤.
import { describe, expect, it } from "vitest";
import { aggregateCitationsFromMirror } from "./scope-aggregates";
import { ownedBasePrefixesForScope } from "@/lib/scope/hmg-brands";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)(
  "officialOwnShare invariants (live mirror)",
  { timeout: 120_000 },
  () => {
    it("무필터: 3사 전체 판정 — 값이 [0,100] 또는 null(인용 없음)", async () => {
      const std = await aggregateCitationsFromMirror({}, undefined, ownedBasePrefixesForScope());
      if (!std) return; // 미러 비어 있음 — 검증 대상 없음
      const v = std.summary.officialOwnShare;
      // eslint-disable-next-line no-console
      console.log("[무필터] total:", std.summary.total, "officialOwnShare:", v);
      if (v != null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    });

    it("brand=Hyundai: 당사 판정 share ≤ 전사 판정 share (분자 부분집합)", async () => {
      const filters = { brand: ["Hyundai"] };
      const own = await aggregateCitationsFromMirror(
        filters, undefined, ownedBasePrefixesForScope(["Hyundai"]));
      const all = await aggregateCitationsFromMirror(
        filters, undefined, ownedBasePrefixesForScope());
      if (!own || !all) return;
      // eslint-disable-next-line no-console
      console.log(
        "[brand=Hyundai] 당사판정:", own.summary.officialOwnShare,
        "전사판정(비교용):", all.summary.officialOwnShare,
        "total:", own.summary.total,
      );
      expect(own.summary.total).toBe(all.summary.total); // 분모(모집단) 동일
      if (own.summary.officialOwnShare != null && all.summary.officialOwnShare != null) {
        expect(own.summary.officialOwnShare).toBeLessThanOrEqual(all.summary.officialOwnShare);
      }
    });
  },
);
