// ACR 셀 예산 배분 단위 검증.
//
// 존재 이유(issue #127): 데모 시드가 브랜드별로 독립적으로 choice 를 만들어
// 한 셀의 Σchoice(15)가 valid_acr_iterations(10)를 넘겼고, 그 값이 몇 달간
// 프로덕션 미러에 앉아 있다가 int 테스트가 처음 돌면서 드러났다. 시드가 쓰는
// 파라미터 공간 전체를 여기서 미리 돌려 불변식을 못 깨게 만든다.
import { describe, expect, it } from "vitest";
import {
  assertAcrRollupInvariants,
  planAcrCell,
  type AcrRollupInvariantRow,
} from "./acr-cell-plan";

// scripts/db/seed-demo.ts 와 동일한 상수·변주식 (시드가 만들 값을 그대로 재현).
const RUN_COUNT = 8;
const ACR_PROMPT_INDICES = [9, 10, 11]; // kind:"acr" 프롬프트의 위치
const BRANDS = ["Hyundai", "Toyota", "Tesla", "BMW", "Volkswagen", "Volvo"];
const OWN_INDEX = 0;

function seedPlan(pi: number, k: number) {
  const s = pi + k;
  return planAcrCell({
    plannedIterations: 10,
    invalidTurn1Iterations: s % 4 === 0 ? 1 : 0,
    noneIterations: 1 + (s % 2),
    conditionalMultipleIterations: s % 3 === 0 ? 1 : 0,
    unresolvedChoiceIterations: 0,
    entities: BRANDS.map((name, ei) => ({
      entityId: name,
      appearance: ei === OWN_INDEX ? 8 + (k % 2) : 3 + ((pi + ei) % 4),
      weight: ei === OWN_INDEX ? 6 + k : Math.max(1, 4 - ((pi + ei + k) % 4)),
    })),
  });
}

function toRows(plan: ReturnType<typeof planAcrCell>, cell: string): AcrRollupInvariantRow[] {
  return plan.entities.map((e) => ({
    promptRunId: cell,
    rollupLevel: "brand",
    entityId: e.entityId,
    brand: e.entityId,
    plannedIterations: plan.plannedIterations,
    validTurn1Iterations: plan.validTurn1Iterations,
    validAcrIterations: plan.validAcrIterations,
    appearanceCount: e.appearanceCount,
    choiceCount: e.choiceCount,
    appearanceRate: e.appearanceRate,
    acr: e.acr,
    overallChoiceShare: e.overallChoiceShare,
    coSingleEntity: plan.coSingleEntity,
    coConditionalMultiple: plan.coConditionalMultiple,
    coGenericCategory: plan.coGenericCategory,
    coResolvedOffShortlist: plan.coResolvedOffShortlist,
    coUnresolvedChoice: plan.coUnresolvedChoice,
    coNone: plan.coNone,
  }));
}

describe("planAcrCell — 셀 예산", () => {
  it("데모 시드가 쓰는 파라미터 전 조합에서 불변식을 만족한다", () => {
    const rows: AcrRollupInvariantRow[] = [];
    for (const pi of ACR_PROMPT_INDICES) {
      for (let k = 0; k < RUN_COUNT; k++) {
        const plan = seedPlan(pi, k);
        const sum = plan.entities.reduce((s, e) => s + e.choiceCount, 0);
        expect(sum, `cell(pi=${pi},k=${k}) Σchoice ≤ validAcr`).toBeLessThanOrEqual(
          plan.validAcrIterations,
        );
        for (const e of plan.entities) {
          expect(e.choiceCount).toBeLessThanOrEqual(e.appearanceCount);
          expect(e.appearanceCount).toBeLessThanOrEqual(plan.validTurn1Iterations);
          expect(e.acr).toBeGreaterThanOrEqual(0);
          expect(e.acr).toBeLessThanOrEqual(1);
        }
        rows.push(...toRows(plan, `p${pi}-r${k}`));
      }
    }
    // 24 셀 × 6 브랜드
    expect(rows).toHaveLength(ACR_PROMPT_INDICES.length * RUN_COUNT * BRANDS.length);
    expect(() => assertAcrRollupInvariants(rows)).not.toThrow();
  });

  it("모수·가중치를 넓게 흔들어도 불변식이 깨지지 않는다", () => {
    for (let planned = 0; planned <= 12; planned++) {
      for (let inv = 0; inv <= 3; inv++) {
        for (let none = 0; none <= 3; none++) {
          for (let cond = 0; cond <= 2; cond++) {
            for (let app = 0; app <= 12; app += 3) {
              const plan = planAcrCell({
                plannedIterations: planned,
                invalidTurn1Iterations: inv,
                noneIterations: none,
                conditionalMultipleIterations: cond,
                unresolvedChoiceIterations: 1,
                entities: BRANDS.map((name, ei) => ({
                  entityId: name,
                  appearance: (app + ei) % 13,
                  weight: ei === 0 ? 9 : (ei * 3) % 5,
                })),
              });
              expect(() =>
                assertAcrRollupInvariants(
                  toRows(plan, `x${planned}-${inv}-${none}-${cond}-${app}`),
                ),
              ).not.toThrow();
            }
          }
        }
      }
    }
  });

  it("ACR 분모는 등장 수가 아니라 유효 반복 수다", () => {
    const plan = planAcrCell({
      plannedIterations: 10,
      noneIterations: 2,
      entities: [
        { entityId: "own", appearance: 6, weight: 10 },
        { entityId: "rival", appearance: 4, weight: 1 },
      ],
    });
    expect(plan.validAcrIterations).toBe(8);
    const own = plan.entities[0];
    expect(own.acr).toBeCloseTo(own.choiceCount / 8, 12);
    expect(own.overallChoiceShare).toBe(own.acr);
    // 등장 조건부 비율(choice/appearance)과는 다른 값이어야 한다.
    expect(own.acr).not.toBe(own.choiceCount / own.appearanceCount);
  });

  it("자사 가중치가 커질수록 자사 ACR 이 단조 증가한다 (데모 추세)", () => {
    const acrs = Array.from({ length: RUN_COUNT }, (_, k) => seedPlan(9, k).entities[0].acr);
    expect(acrs[RUN_COUNT - 1]).toBeGreaterThan(acrs[0]);
  });

  it("breakdown 은 셀 단위 공유값이고 합이 validAcr 과 같다", () => {
    const plan = seedPlan(10, 3);
    const sum =
      plan.coSingleEntity +
      plan.coConditionalMultiple +
      plan.coGenericCategory +
      plan.coResolvedOffShortlist +
      plan.coUnresolvedChoice;
    expect(sum).toBe(plan.validAcrIterations);
    expect(plan.coNone).toBe(plan.validTurn1Iterations - plan.validAcrIterations);
  });
});

describe("assertAcrRollupInvariants — 감지력", () => {
  const base = toRows(seedPlan(9, 4), "cell-1");

  it("Σchoice > validAcr 를 잡는다 (issue #127 의 실제 형태)", () => {
    // 옛 시드의 실측 분해: appearance 9/6/5/6/3/4, choice 7/2/2/2/1/1 (합 15 > 10)
    const bad = base.map((r, i) => ({
      ...r,
      validTurn1Iterations: 10,
      validAcrIterations: 10,
      plannedIterations: 10,
      appearanceCount: [9, 6, 5, 6, 3, 4][i],
      choiceCount: [7, 2, 2, 2, 1, 1][i],
      acr: null,
      overallChoiceShare: null,
      appearanceRate: null,
      coSingleEntity: null,
      coConditionalMultiple: null,
      coGenericCategory: null,
      coResolvedOffShortlist: null,
      coUnresolvedChoice: null,
      coNone: null,
    }));
    expect(() => assertAcrRollupInvariants(bad)).toThrow(/Σ choiceCount\(15\).*validAcrIterations\(10\)/s);
  });

  it("choice > appearance 를 잡는다", () => {
    const bad = base.map((r, i) => (i === 1 ? { ...r, choiceCount: r.appearanceCount + 1, acr: null } : r));
    expect(() => assertAcrRollupInvariants(bad)).toThrow(/choiceCount.*> appearanceCount/s);
  });

  it("셀 단위 공유값이 엔티티별로 갈리면 잡는다 (co_none 지문)", () => {
    const bad = base.map((r, i) => (i === 2 ? { ...r, coNone: r.coNone! + 3 } : r));
    expect(() => assertAcrRollupInvariants(bad)).toThrow(/coNone 는 셀 단위 공유값/s);
  });

  it("acr 을 choice/appearance 로 넣으면 잡는다", () => {
    // 두 정의가 실제로 갈리는 행(appearance ≠ validAcr, choice > 0)을 고른다.
    const idx = base.findIndex(
      (r) => r.choiceCount > 0 && r.appearanceCount !== r.validAcrIterations,
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const bad = base.map((r, i) =>
      i === idx ? { ...r, acr: r.choiceCount / r.appearanceCount } : r,
    );
    expect(() => assertAcrRollupInvariants(bad)).toThrow(/acr 은 choice\/validAcr/s);
  });

  it("정상 행은 통과한다", () => {
    expect(() => assertAcrRollupInvariants(base)).not.toThrow();
  });
});
