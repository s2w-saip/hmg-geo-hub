// ACR 집계 불변식 — 실 DB(read-only) 대상 상시 검증. DATABASE_URL이 있을 때만
// 실행되므로 CI(무DB)에서는 skip, 로컬에서 `DATABASE_URL=... npx vitest run
// lib/db/repositories/scope-aggregates.acr.int.test.ts` 로 돌린다.
//
// 존재 이유(2026-07-08 사고): scope의 appearance_count가 "등장 반복 수"가
// 아니라 "언급 횟수"라는 걸 배포 후에야 발견 — 등장률이 100%를 넘는 화면이
// 그대로 나갔다. 파생 지표는 정의만 믿지 말고 값의 범위를 데이터로 검증한다.
import { describe, expect, it } from "vitest";
import { aggregateAcrFromMirror } from "./scope-aggregates";

const hasDb = !!process.env.DATABASE_URL;

const OWN = [
  { id: "00000000-0000-0000-0000-000000000301", name: "Hyundai" },
  { id: "00000000-0000-0000-0000-000000000302", name: "Kia" },
  { id: "00000000-0000-0000-0000-000000000304", name: "Genesis" },
];

function expectPct(v: number | null, label: string) {
  if (v == null) return;
  expect(v, `${label} must be within [0, 100]`).toBeGreaterThanOrEqual(0);
  expect(v, `${label} must be within [0, 100]`).toBeLessThanOrEqual(100);
}

describe.skipIf(!hasDb)("aggregateAcrFromMirror invariants (live mirror)", { timeout: 60_000 }, () => {
  it("all ratio metrics stay in [0,100] and counts are consistent", async () => {
    const out = await aggregateAcrFromMirror({ ownEntities: OWN });
    if (!out.measured) return; // 측정 전 — 검증 대상 없음 (빈 상태 자체는 유효)

    expect(out.totals.promptRuns).toBeGreaterThan(0);
    expect(out.totals.iterations).toBeGreaterThan(0);
    expect(out.totals.prompts).toBeGreaterThan(0);

    let choiceSum = 0;
    for (const b of out.brands) {
      expect(b.brand.length).toBeGreaterThan(0);
      expectPct(b.choiceShare, `brands[${b.brand}].choiceShare`);
      expectPct(b.coverage, `brands[${b.brand}].coverage`);
      expect(b.choiceCount).toBeGreaterThanOrEqual(0);
      expect(b.choiceCount, `brands[${b.brand}].choiceCount ≤ totals.iterations`)
        .toBeLessThanOrEqual(out.totals.iterations);
      choiceSum += b.choiceCount;
    }
    // 셀마다 최종 선택은 최대 1개/반복 → 브랜드 선택 합 ≤ 전체 유효 반복.
    expect(choiceSum, "sum of brand choices ≤ total iterations").toBeLessThanOrEqual(
      out.totals.iterations,
    );

    for (const bucket of out.trend) {
      for (const [brand, v] of Object.entries(bucket.series)) {
        expectPct(v, `trend[${bucket.date}][${brand}]`);
      }
    }

    for (const m of out.modelConversion) {
      expectPct(m.conversionRate, `modelConversion[${m.model}].conversionRate`);
      expect(m.top1Count).toBeGreaterThanOrEqual(0);
      expect(m.shortlistCount).toBeGreaterThan(0);
    }

    for (const row of out.battle) {
      expect(row.cells.length).toBeGreaterThan(0);
      for (const c of row.cells) {
        expect(out.totals.engines).toContain(c.engine);
        if (c.winner == null) expect(c.choiceCount).toBe(0);
      }
    }

    for (const sheet of out.territory) {
      for (const row of sheet.rows) {
        const chosen = row.entries.reduce((s, e) => s + e.choice, 0);
        expect(chosen, `territory[${sheet.region}·${sheet.engine}] chosen ≤ validAcr`)
          .toBeLessThanOrEqual(row.validAcr);
      }
    }
  });
});
