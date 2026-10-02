/**
 * ACR 셀(prompt_run) 예산 배분 + 불변식 단언.
 *
 * scope 정본 계산기(`lib/measurement-analysis/store.ts`)의 의미를 그대로 옮긴다:
 *
 *  - iteration 하나는 turn1 이 유효할 때만 `valid_turn1_iterations` 로 센다.
 *    (store.ts:5253-5258 — turn1 무효/shortlist 공집합은 아무 카운터에도 안 들어간다)
 *  - turn1 유효 iteration 중 turn2 유효답변이 없으면 `choice_outcome.none`,
 *    있으면 `valid_acr_iterations` 로 간다 → **none = validTurn1 − validAcr**.
 *    (store.ts:5288-5296)
 *  - `appearance_count` 는 (level, entityId) 당 iteration 카운트라 ≤ validTurn1.
 *    (store.ts:5281-5286)
 *  - **한 iteration 의 최종 선택은 한 엔티티에게만 크레딧된다** —
 *    `finalMentions.length === 1` 일 때만 `choiceCount += 1` 이고
 *    (store.ts:5330-5364), `rollupKeys()` 는 레벨당 최대 1엔티티다
 *    (store.ts:5453-5470). 따라서 셀·레벨 단위로
 *    **Σ choice_count ≤ valid_acr_iterations** 가 구조적으로 성립한다.
 *  - ACR 분모는 등장 수가 아니라 유효 반복 수다:
 *    **acr = choice / valid_acr_iterations** (store.ts:5387, change
 *    `acr-iteration-denominator`). `overall_choice_share` 는 같은 값.
 *  - `choice_outcome_*` 계열은 **셀 단위 공유값**이라 그 셀의 모든 엔티티 행이
 *    같은 값을 갖는다 (store.ts:5396).
 *
 * 이 모듈은 데모 시드(`scripts/db/seed-demo.ts`)가 이 의미를 재현하도록
 * 만들어졌다 — 시드가 브랜드별로 독립 난수를 굴려 셀 예산을 초과하던 결함
 * (issue #127: `territory[KR·chatgpt] 15 ≤ 10` FAIL)의 재발 차단이 목적이다.
 */

export interface AcrEntityPlanInput {
  entityId: string;
  /** 이 셀에서 등장한 iteration 수 희망값. validTurn1 로 클램프된다. */
  appearance: number;
  /** 최종 선택 배분 가중치. 클수록 많이 가져간다. 0 이면 배분 제외. */
  weight: number;
}

export interface AcrCellPlanInput {
  /** 계획된 iteration 수. */
  plannedIterations: number;
  /** turn1 자체가 무효였던 iteration 수 (planned − validTurn1). */
  invalidTurn1Iterations?: number;
  /** turn1 은 유효했으나 turn2 유효답변이 없던 iteration 수 → breakdown.none. */
  noneIterations?: number;
  /** 최종 선택이 복수 엔티티였던 iteration 수 (choice_count 로 안 간다). */
  conditionalMultipleIterations?: number;
  /** 최종 선택이 미해소 엔티티였던 iteration 수. */
  unresolvedChoiceIterations?: number;
  entities: AcrEntityPlanInput[];
}

export interface AcrEntityPlan {
  entityId: string;
  appearanceCount: number;
  choiceCount: number;
  conditionalChoiceCount: number;
  appearanceRate: number;
  /** = choiceCount / validAcrIterations (정본 정의). */
  acr: number;
  /** acr 과 같은 값 (정본에서도 동일). */
  overallChoiceShare: number;
}

export interface AcrCellPlan {
  plannedIterations: number;
  validTurn1Iterations: number;
  validAcrIterations: number;
  /** 이하 choice_outcome_breakdown — 셀 단위 공유값. */
  coSingleEntity: number;
  coConditionalMultiple: number;
  coGenericCategory: number;
  coResolvedOffShortlist: number;
  coUnresolvedChoice: number;
  coNone: number;
  entities: AcrEntityPlan[];
}

const clampInt = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.trunc(v)));

/**
 * 셀 예산(`validAcrIterations`)을 엔티티들에게 **나눠** 배분한다.
 * 각 엔티티는 자기 `appearance` 를 넘을 수 없고, 합은 예산을 넘을 수 없다.
 * 캡에 막혀 남은 예산은 `coGenericCategory`(카테고리만 답한 iteration)로 흡수해
 * breakdown 합이 정확히 `validAcrIterations` 가 되도록 닫는다.
 */
export function planAcrCell(input: AcrCellPlanInput): AcrCellPlan {
  const planned = Math.max(0, Math.trunc(input.plannedIterations));
  const invalidTurn1 = clampInt(input.invalidTurn1Iterations ?? 0, 0, planned);
  const validTurn1 = planned - invalidTurn1;
  const none = clampInt(input.noneIterations ?? 0, 0, validTurn1);
  const validAcr = validTurn1 - none;

  const conditional = clampInt(input.conditionalMultipleIterations ?? 0, 0, validAcr);
  const unresolved = clampInt(input.unresolvedChoiceIterations ?? 0, 0, validAcr - conditional);
  const singleBudget = validAcr - conditional - unresolved;

  const appearances = input.entities.map((e) =>
    clampInt(e.appearance, 0, validTurn1),
  );
  const weights = input.entities.map((e) => Math.max(0, e.weight));
  // 배분 순서: 가중치 내림차순 → 입력 순서. 결정적이어야 재실행이 멱등이다.
  const order = input.entities
    .map((_, i) => i)
    .sort((a, b) => (weights[b] - weights[a]) || (a - b));

  const choices = new Array<number>(input.entities.length).fill(0);
  const totalWeight = weights.reduce((s, w, i) => s + (appearances[i] > 0 ? w : 0), 0);
  if (totalWeight > 0 && singleBudget > 0) {
    for (let i = 0; i < choices.length; i++) {
      if (appearances[i] === 0) continue;
      choices[i] = Math.min(
        appearances[i],
        Math.floor((singleBudget * weights[i]) / totalWeight),
      );
    }
    // 나머지는 가중치 순으로 한 표씩. 전부 캡에 걸리면 중단(남는 건 generic 으로).
    let remaining = singleBudget - choices.reduce((s, c) => s + c, 0);
    let progressed = true;
    while (remaining > 0 && progressed) {
      progressed = false;
      for (const i of order) {
        if (remaining === 0) break;
        if (choices[i] < appearances[i]) {
          choices[i] += 1;
          remaining -= 1;
          progressed = true;
        }
      }
    }
  }

  const singleEntity = choices.reduce((s, c) => s + c, 0);
  const generic = singleBudget - singleEntity;

  // 복수 선택 iteration 은 상위 2개 엔티티에 함께 계상된다(정본에서도 선택된
  // 모든 엔티티가 conditionalChoiceCount 를 받는다 — store.ts:5334-5344).
  const conditionalTargets = new Set(order.filter((i) => appearances[i] > 0).slice(0, 2));

  const entities: AcrEntityPlan[] = input.entities.map((e, i) => ({
    entityId: e.entityId,
    appearanceCount: appearances[i],
    choiceCount: choices[i],
    conditionalChoiceCount: conditionalTargets.has(i)
      ? Math.min(conditional, appearances[i])
      : 0,
    appearanceRate: validTurn1 > 0 ? appearances[i] / validTurn1 : 0,
    acr: validAcr > 0 ? choices[i] / validAcr : 0,
    overallChoiceShare: validAcr > 0 ? choices[i] / validAcr : 0,
  }));

  return {
    plannedIterations: planned,
    validTurn1Iterations: validTurn1,
    validAcrIterations: validAcr,
    coSingleEntity: singleEntity,
    coConditionalMultiple: conditional,
    coGenericCategory: generic,
    coResolvedOffShortlist: 0,
    coUnresolvedChoice: unresolved,
    coNone: none,
    entities,
  };
}

/** `scope_acr_rollups` 로 들어갈 행에서 불변식 검사에 쓰는 필드만 추린 모양. */
export interface AcrRollupInvariantRow {
  promptRunId: string;
  rollupLevel: string;
  entityId?: string | null;
  brand?: string | null;
  plannedIterations: number;
  validTurn1Iterations: number;
  validAcrIterations: number;
  appearanceCount: number;
  choiceCount: number;
  coSingleEntity?: number | null;
  coConditionalMultiple?: number | null;
  coGenericCategory?: number | null;
  coResolvedOffShortlist?: number | null;
  coUnresolvedChoice?: number | null;
  coNone?: number | null;
  acr?: number | null;
  overallChoiceShare?: number | null;
  appearanceRate?: number | null;
}

const EPS = 1e-9;

/**
 * insert 직전 사후 단언. 위반이면 던진다 — 불가능한 값이 조용히 DB 에 앉는
 * 경로를 남기지 않는 것이 목적이다(issue #127 은 그렇게 몇 달을 살아남았다).
 */
export function assertAcrRollupInvariants(rows: AcrRollupInvariantRow[]): void {
  const errors: string[] = [];
  const cells = new Map<string, AcrRollupInvariantRow[]>();
  for (const r of rows) {
    const key = `${r.promptRunId}|${r.rollupLevel}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(r);
    else cells.set(key, [r]);
  }

  for (const [key, group] of cells) {
    const head = group[0];
    const label = (r: AcrRollupInvariantRow) => r.brand ?? r.entityId ?? "?";

    // 셀 단위 공유값 — 모수와 breakdown 은 그 셀의 모든 엔티티 행이 같아야 한다.
    const shared: Array<[string, (r: AcrRollupInvariantRow) => number | null | undefined]> = [
      ["plannedIterations", (r) => r.plannedIterations],
      ["validTurn1Iterations", (r) => r.validTurn1Iterations],
      ["validAcrIterations", (r) => r.validAcrIterations],
      ["coSingleEntity", (r) => r.coSingleEntity],
      ["coConditionalMultiple", (r) => r.coConditionalMultiple],
      ["coGenericCategory", (r) => r.coGenericCategory],
      ["coResolvedOffShortlist", (r) => r.coResolvedOffShortlist],
      ["coUnresolvedChoice", (r) => r.coUnresolvedChoice],
      ["coNone", (r) => r.coNone],
    ];
    for (const [field, get] of shared) {
      const first = get(head);
      for (const r of group) {
        if (get(r) !== first) {
          errors.push(
            `[${key}] ${field} 는 셀 단위 공유값이어야 한다: ${label(head)}=${first} vs ${label(r)}=${get(r)}`,
          );
          break;
        }
      }
    }

    const planned = head.plannedIterations;
    const validTurn1 = head.validTurn1Iterations;
    const validAcr = head.validAcrIterations;
    if (!(validAcr <= validTurn1 && validTurn1 <= planned)) {
      errors.push(
        `[${key}] validAcr(${validAcr}) ≤ validTurn1(${validTurn1}) ≤ planned(${planned}) 위반`,
      );
    }

    let choiceSum = 0;
    for (const r of group) {
      for (const [field, v] of [
        ["appearanceCount", r.appearanceCount],
        ["choiceCount", r.choiceCount],
      ] as const) {
        if (!Number.isInteger(v) || v < 0) {
          errors.push(`[${key}] ${label(r)}.${field} 는 음이 아닌 정수여야 한다: ${v}`);
        }
      }
      if (r.appearanceCount > validTurn1) {
        errors.push(
          `[${key}] ${label(r)}.appearanceCount(${r.appearanceCount}) > validTurn1(${validTurn1})`,
        );
      }
      if (r.choiceCount > r.appearanceCount) {
        errors.push(
          `[${key}] ${label(r)}.choiceCount(${r.choiceCount}) > appearanceCount(${r.appearanceCount})`,
        );
      }
      choiceSum += r.choiceCount;

      const expectAcr = validAcr > 0 ? r.choiceCount / validAcr : 0;
      if (r.acr != null && Math.abs(r.acr - expectAcr) > EPS) {
        errors.push(
          `[${key}] ${label(r)}.acr 은 choice/validAcr 이어야 한다: ${r.acr} ≠ ${expectAcr}`,
        );
      }
      if (
        r.overallChoiceShare != null &&
        Math.abs(r.overallChoiceShare - expectAcr) > EPS
      ) {
        errors.push(
          `[${key}] ${label(r)}.overallChoiceShare 은 acr 과 같아야 한다: ${r.overallChoiceShare} ≠ ${expectAcr}`,
        );
      }
      const expectAppRate = validTurn1 > 0 ? r.appearanceCount / validTurn1 : 0;
      if (r.appearanceRate != null && Math.abs(r.appearanceRate - expectAppRate) > EPS) {
        errors.push(
          `[${key}] ${label(r)}.appearanceRate 는 appearance/validTurn1 이어야 한다: ${r.appearanceRate} ≠ ${expectAppRate}`,
        );
      }
    }

    // 핵심 불변식 — 한 iteration 의 최종 선택은 한 엔티티에게만 간다.
    if (choiceSum > validAcr) {
      errors.push(
        `[${key}] Σ choiceCount(${choiceSum}) > validAcrIterations(${validAcr}) — ` +
          `셀 예산 초과 (${group.map((r) => `${label(r)}=${r.choiceCount}`).join(", ")})`,
      );
    }

    const breakdown = [
      head.coSingleEntity,
      head.coConditionalMultiple,
      head.coGenericCategory,
      head.coResolvedOffShortlist,
      head.coUnresolvedChoice,
    ];
    if (breakdown.every((v) => v != null)) {
      const sum = breakdown.reduce<number>((s, v) => s + (v as number), 0);
      if (sum !== validAcr) {
        errors.push(
          `[${key}] choice_outcome 합(${sum}) ≠ validAcrIterations(${validAcr})`,
        );
      }
      if ((head.coSingleEntity as number) < choiceSum) {
        errors.push(
          `[${key}] coSingleEntity(${head.coSingleEntity}) < Σ choiceCount(${choiceSum})`,
        );
      }
    }
    if (head.coNone != null && head.coNone !== validTurn1 - validAcr) {
      errors.push(
        `[${key}] coNone(${head.coNone}) ≠ validTurn1 − validAcr(${validTurn1 - validAcr})`,
      );
    }
  }

  if (errors.length) {
    throw new Error(
      `ACR 불변식 위반 ${errors.length}건 (insert 중단):\n  - ${errors.join("\n  - ")}`,
    );
  }
}
