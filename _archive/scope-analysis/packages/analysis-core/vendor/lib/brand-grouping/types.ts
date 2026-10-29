// 프로젝트별 브랜드 묶음 규칙의 모델 (change project-brand-grouping).
//
// 용어 (proposal.md § 용어와 같다):
//   표기(surface)  — AI 답변에 실제로 쓰인 글자. "LG전자", "엘지", "베스트샵"
//   집계 칸        — 이 언급을 어느 브랜드 밑으로 셀지. 대시보드가 세는 것은 이것뿐
//   묶음(group)    — 집계 칸 하나. 여러 엔티티/표기가 여기에 합산된다
//
// 규칙은 두 종류뿐이다:
//   묶기(entity)   — 이 엔티티로 해석된 언급을 통째로 이 묶음에
//   쪼개기(surface)— from 엔티티로 해석된 언급 중 글자가 일치하는 것만 이 묶음에

import { z } from "zod";

export const GROUPING_LEVELS = ["product", "brand", "company"] as const;
export type GroupingLevel = (typeof GROUPING_LEVELS)[number];

export const GROUPING_STATUSES = ["draft", "active", "superseded"] as const;
export type GroupingStatus = (typeof GROUPING_STATUSES)[number];

export const MEMBER_KINDS = ["entity", "surface"] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// 편집용 모델 (사람이 만지는 것)
// ─────────────────────────────────────────────────────────────────────────────

export const GroupingLevelSchema = z.enum(GROUPING_LEVELS);

/**
 * 구성원 입력. 종류에 따라 채워야 하는 칸이 다르고, 그 형태는 DB CHECK 도
 * 똑같이 강제한다 (migration 0107) — 여기서만 막으면 반쯤 채워진 행이
 * 규칙표 생성에서 조용히 누락된다.
 */
export const GroupMemberInputSchema = z.discriminatedUnion("memberKind", [
  z.object({
    memberKind: z.literal("entity"),
    entityId: z.guid(),
    note: z.string().max(500).nullish(),
  }),
  z.object({
    memberKind: z.literal("surface"),
    /** 어느 엔티티에서 떼어내는가. 글자 단독 키잉은 동명 표기를 싹쓸이한다. */
    fromEntityId: z.guid(),
    /** normalizeSurface() 를 통과한 값이어야 한다 — 호출부가 정규화 책임을 진다. */
    surfaceNormalized: z.string().min(1).max(500),
    note: z.string().max(500).nullish(),
  }),
]);
export type GroupMemberInput = z.infer<typeof GroupMemberInputSchema>;

export const GroupInputSchema = z.object({
  level: GroupingLevelSchema,
  /** 묶음의 이름표는 기존 엔티티다 — 규칙은 새 엔티티를 만들지 않는다. */
  rollupEntityId: z.guid(),
  /** 프로젝트 전용 표시 이름. NULL 이면 대표 엔티티의 canonical_name 을 쓴다. */
  label: z.string().min(1).max(200).nullish(),
  note: z.string().max(500).nullish(),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  members: z.array(GroupMemberInputSchema).default([]),
});
export type GroupInput = z.infer<typeof GroupInputSchema>;

export const GroupingDraftSchema = z.object({
  groups: z.array(GroupInputSchema).default([]),
});
export type GroupingDraft = z.infer<typeof GroupingDraftSchema>;

/** DB 에서 읽어 온 편집용 규칙 한 벌. */
export interface GroupingVersionRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  version: number;
  status: GroupingStatus;
  label: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  appliedAt: string | null;
  supersededAt: string | null;
}

export interface GroupRecord {
  id: string;
  level: GroupingLevel;
  rollupEntityId: string;
  label: string | null;
  note: string | null;
  sortOrder: number;
  members: GroupMemberRecord[];
}

export interface GroupMemberRecord {
  id: string;
  memberKind: MemberKind;
  entityId: string | null;
  surfaceNormalized: string | null;
  fromEntityId: string | null;
  note: string | null;
}

export interface GroupingSnapshot {
  version: GroupingVersionRecord;
  groups: GroupRecord[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 분석용 모델 (턴마다 읽히는 것)
// ─────────────────────────────────────────────────────────────────────────────

/** 묶기 규칙 1행 — project_entity_rollups 의 투영. */
export interface EntityRule {
  sourceEntityId: string;
  level: GroupingLevel;
  rollupEntityId: string;
}

/** 쪼개기 규칙 1행 — project_surface_rollups 의 투영. */
export interface SurfaceRule {
  fromEntityId: string;
  surfaceNormalized: string;
  level: GroupingLevel;
  rollupEntityId: string;
}

export interface CompiledGrouping {
  entityRules: EntityRule[];
  surfaceRules: SurfaceRule[];
}

/**
 * 집계 칸 결정이 쓰는 조회 구조.
 *
 * **왜 Map 인가.** 이 조회는 언급 하나당 최대 4번(product/brand/company +
 * brand→company) 일어난다. 직전 구현은 배열 `.find()` 였고 프로덕션 규칙이
 * 38행이라 문제가 없었지만, 쪼개기 규칙은 표기 단위라 수백 행이 정상이다
 * (한 묶음에 표기가 1,772가지까지 있다 — 2026-08-03 실측). 선형 탐색을
 * 남겨 두면 규칙을 많이 만든 프로젝트일수록 분석이 느려진다.
 */
export interface GroupingIndex {
  readonly entityCount: number;
  readonly surfaceCount: number;
  /** 묶기 규칙 조회 — (엔티티, 레벨). */
  entityRule(sourceEntityId: string, level: GroupingLevel): string | null;
  /** 쪼개기 규칙 조회 — (출처 엔티티, 글자, 레벨). */
  surfaceRule(
    fromEntityId: string,
    surfaceNormalized: string,
    level: GroupingLevel,
  ): string | null;
  /** 원본 규칙 — 감사·미리보기가 되짚어 볼 때 쓴다. */
  readonly compiled: CompiledGrouping;
}

const entityKey = (id: string, level: GroupingLevel) => `${id}\u0000${level}`;
const surfaceKey = (
  fromId: string,
  surface: string,
  level: GroupingLevel,
) => `${fromId}\u0000${surface}\u0000${level}`;

export function buildGroupingIndex(compiled: CompiledGrouping): GroupingIndex {
  const entityMap = new Map<string, string>();
  for (const r of compiled.entityRules) {
    entityMap.set(entityKey(r.sourceEntityId, r.level), r.rollupEntityId);
  }
  const surfaceMap = new Map<string, string>();
  for (const r of compiled.surfaceRules) {
    surfaceMap.set(
      surfaceKey(r.fromEntityId, r.surfaceNormalized, r.level),
      r.rollupEntityId,
    );
  }
  return {
    entityCount: entityMap.size,
    surfaceCount: surfaceMap.size,
    entityRule: (id, level) => entityMap.get(entityKey(id, level)) ?? null,
    surfaceRule: (fromId, surface, level) =>
      surfaceMap.get(surfaceKey(fromId, surface, level)) ?? null,
    compiled,
  };
}

/**
 * 규칙 없는 프로젝트의 조회 구조. 150개 프로젝트 중 149개가 여기 해당하므로
 * 이 경로가 무료여야 한다 — 매번 빈 Map 을 새로 만들지 않도록 상수로 둔다.
 */
export const EMPTY_GROUPING: GroupingIndex = buildGroupingIndex({
  entityRules: [],
  surfaceRules: [],
});

export function isEmptyGrouping(index: GroupingIndex): boolean {
  return index.entityCount === 0 && index.surfaceCount === 0;
}
