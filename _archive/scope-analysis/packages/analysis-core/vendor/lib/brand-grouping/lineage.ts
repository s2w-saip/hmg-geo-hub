// 공통 온톨로지의 계열 관계 걷기 (change project-brand-grouping).
//
// `resolveSubsidiaryRoot` 는 원래 lib/measurement-analysis/store.ts 의 비공개
// 함수였다. 여기로 옮긴 이유는 **두 곳이 같은 답을 내야 하기 때문**이다:
//   · 집계 칸 결정 (store.ts) — 규칙이 없을 때 떨어지는 3단계
//   · 규칙 검사 (check.ts)   — "서로 다른 법인을 한 묶음으로 묶었다" 경고
// 각자 구현하면 경고가 실제 집계와 다른 계보를 보고 거짓 경고를 낸다.
//
// 이 모듈은 store 를 import 하지 않는다 — store 가 이쪽을 import 하므로
// 반대 방향 참조는 순환이 된다.

export interface LineageRelationship {
  fromId: string;
  type: string;
  toId: string;
}

/**
 * `SUBSIDIARY_OF` 를 타고 올라가 최상위 법인을 찾는다.
 *
 * 반환 규칙(store.ts 의 원본 그대로 — 바꾸면 집계 칸이 조용히 달라진다):
 *   · 부모가 하나도 없으면 `null` (자기 자신을 반환하지 않는다)
 *   · 순환이거나 8홉을 넘으면 `null`
 */
export function resolveSubsidiaryRoot(
  entityId: string | null,
  rels: LineageRelationship[],
): string | null {
  if (!entityId) return null;
  let current = entityId;
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    if (seen.has(current)) return null;
    seen.add(current);
    const parent = rels.find(
      (r) => r.fromId === current && r.type === "SUBSIDIARY_OF",
    )?.toId;
    if (!parent) return current === entityId ? null : current;
    current = parent;
  }
  return null;
}

/**
 * 검사용 법인 루트 — 부모가 없으면 **자기 자신**을 돌려준다.
 *
 * 집계용(`resolveSubsidiaryRoot`)과 규칙이 다른 이유: 집계는 "회사 칸을
 * 채울 만한 상위 법인이 있는가"를 묻지만, 검사는 "이 둘이 같은 법인 아래인가"를
 * 묻는다. 후자에서 null 을 그대로 쓰면 부모 없는 엔티티끼리 전부 "같은 루트
 * (null)"로 보여 경고가 침묵한다.
 */
export function corporateRootForCheck(
  entityId: string,
  rels: LineageRelationship[],
): string {
  return resolveSubsidiaryRoot(entityId, rels) ?? entityId;
}
