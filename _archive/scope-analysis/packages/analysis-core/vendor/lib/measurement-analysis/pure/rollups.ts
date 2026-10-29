// 롤업 해석 — store.ts 에서 무수정 이동(플랜 §6 PR-B).
import { resolveSubsidiaryRoot } from "@/lib/brand-grouping/lineage";
import type { GroupingIndex } from "@/lib/brand-grouping/types";
import type { MeasurementMention, RollupLevel } from "../schema";

export interface RelationshipRow {
  fromId: string;
  type: string;
  toId: string;
}

export interface RollupIds {
  productRollupEntityId: string | null;
  brandRollupEntityId: string | null;
  companyRollupEntityId: string | null;
}

/**
 * 이 언급을 어느 브랜드 밑으로 셀지(집계 칸 3개)를 정한다.
 *
 * **정체성 해석과는 별개의 뒷단계다.** 무엇을 가리키는가(`entity_id`)는 이미
 * 정해져 있고, 여기서는 그것을 *어떻게 묶어 셀지*만 정한다. 그래서 프로젝트
 * 묶음 규칙이 이 함수의 출력만 바꾸고 원자 데이터는 건드리지 않는다.
 *
 * 결정 순서 (더 구체적인 규칙이 이긴다 — change project-brand-grouping D2):
 *
 *   1. 쪼개기 규칙  (출처 엔티티, 답변에 쓰인 글자) 정확 일치
 *   2. 묶기 규칙    (엔티티) 일치
 *   3. 공통 온톨로지 계보 (MADE_BY / SUBSIDIARY_OF)
 *
 * 쪼개기가 `(fromEntityId, surfaceNormalized)` 쌍으로 키잉되는 이유: "베스트샵"
 * 이라는 글자는 **LG전자로 해석됐을 때만** 떼어내야 한다. 글자 단독으로
 * 키잉하면 하이프라자로 해석된 동명 표기까지 싹쓸이해 조용한 오분류가 된다.
 *
 * 규칙이 없는 프로젝트(`EMPTY_GROUPING`)에서는 1·2단계가 항상 null 이므로
 * 도입 전과 **바이트 단위로 같은** 결과가 나온다.
 */
export function resolveRollups(
  mention: MeasurementMention,
  rels: RelationshipRow[],
  grouping: GroupingIndex,
): RollupIds {
  if (!mention.entityId || !mention.entityType) {
    return {
      productRollupEntityId: null,
      brandRollupEntityId: null,
      companyRollupEntityId: null,
    };
  }

  const entityId = mention.entityId;
  const surface = mention.surfaceNormalized ?? null;

  // 1단계 → 2단계. 두 규칙 모두 없으면 null 이고 호출부가 계보로 떨어진다.
  const rule = (level: RollupLevel): string | null =>
    (surface ? grouping.surfaceRule(entityId, surface, level) : null) ??
    grouping.entityRule(entityId, level);

  let productRollupEntityId: string | null =
    mention.entityType === "Product" ? entityId : null;
  let brandRollupEntityId: string | null =
    mention.entityType === "Brand" ? entityId : null;

  productRollupEntityId = rule("product") ?? productRollupEntityId;
  brandRollupEntityId =
    rule("brand") ??
    brandRollupEntityId ??
    (mention.entityType === "Product"
      ? rels.find((r) => r.fromId === entityId && r.type === "MADE_BY")?.toId ?? null
      : null);

  const companySource = brandRollupEntityId ?? entityId;
  // 회사 칸은 언급 자신의 규칙을 먼저 보고, 없으면 **브랜드 칸이 가리키게 된
  // 엔티티**의 묶기 규칙을 본다. 후자는 표기와 무관하므로 묶기만 조회한다.
  let companyRollupEntityId =
    rule("company") ??
    (brandRollupEntityId
      ? grouping.entityRule(brandRollupEntityId, "company")
      : null);
  if (!companyRollupEntityId) {
    companyRollupEntityId = resolveSubsidiaryRoot(companySource, rels);
  }

  return {
    productRollupEntityId,
    brandRollupEntityId,
    companyRollupEntityId,
  };
}
