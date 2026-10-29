// 답변 단위 브랜드 스탠스의 **순수** 부품 두 개 (change add-answer-brand-stance):
//   ① `buildStanceTargets` — 채점 대상 브랜드 집합 + 결정적 정렬 (스펙 §4.5 / FR5)
//   ② `matchAndVerifyStances` — 모델 응답을 대상에 되짚고 증거 오프셋을 검증 (§4.3·§4.4 / FR4)
//
// 둘 다 DB·env·네트워크를 보지 않는다. 그래야 코어 인라인 경로와 분석 lane 이
// **같은 코드 한 벌**을 쓴다(스펙 §0 R2 — lane 의 `packages/analysis-core/vendor`
// 는 이 디렉토리의 sha256 핀 바이트 사본이다).
import { buildCodePointIndexMap, toCodePointOffset, OFFSET_BASIS } from "../offsets";
import { normalizeSurface } from "../normalize";
import {
  STANCE_ASPECT_CAP,
  STANCE_ASPECT_LABEL_CAP,
  type AnswerBrandStance,
  type AnswerBrandStanceAspect,
  type MeasurementMention,
  type MentionSentiment,
  type OntologyCatalogEntity,
} from "../schema";
import type { TrackedBrandAugmentTarget } from "../tracked-brand-augment";
import type { GroupingIndex } from "@/lib/brand-grouping/types";
import { resolveRollups, type RelationshipRow } from "./rollups";

/** 프롬프트에 싣는 브랜드 상한 — 파일럿(`pilot.py:147`)과 같은 값. */
export const STANCE_TARGET_CAP = 12;

export interface StanceTarget {
  /** 브랜드 **롤업** 엔티티 id. 이 값이 영속 행의 `entity_id` 가 된다. */
  entityId: string;
  /** 프롬프트에 실제로 넘기는 이름 (카탈로그 canonicalName 우선). */
  label: string;
  isTracked: boolean;
  /** 이 턴에서 이 브랜드로 접히는 멘션 수 — 정렬 2순위. */
  mentionCount: number;
  /** 그 중 최초 `mentionPosition` — 정렬 3순위. */
  firstMentionPosition: number;
}

export interface StanceTargetSet {
  targets: StanceTarget[];
  /** 상한 12 에 걸려 잘렸는가 — `extraction_metadata.brands_truncated`. */
  truncated: boolean;
  /** 절단 전 후보 수(관측용). */
  candidateCount: number;
}

/**
 * 채점 대상 = **그 턴 멘션의 브랜드 롤업** ∪ **그 턴의 Brand 멘션 엔티티** (FR5).
 *
 * ⚠️ **멘션이 0건인 tracked 브랜드는 채점하지 않는다.** 파일럿은 자사를 강제
 * 삽입했지만(`pilot.py:144~146`) 그건 hmg 전용 요구다. 코어에서 하면 "언급 없음"에
 * stance 가 붙어 SoV 분모가 오염되고, 없는 것에 대한 판정을 모델에게 시키는 꼴이다.
 * hmg 의 "자사는 항상 보여야 한다" 는 **화면에서 0 표시**로 푼다(스펙 §4.5).
 *
 * 정렬이 **완전히 결정적**이어야 하는 이유: 이 순서가 그대로 프롬프트 바이트가
 * 되고, 흔들리면 모델 출력이 흔들려 골든·재현이 불가능해진다. 4순위 `entityId`
 * 사전순까지 박아 동률을 남기지 않는다(스펙 §8.2 WU3 AC5).
 */
export function buildStanceTargets(input: {
  mentions: MeasurementMention[];
  catalog: OntologyCatalogEntity[];
  rels: RelationshipRow[];
  grouping: GroupingIndex;
  trackedAugmentTargets: TrackedBrandAugmentTarget[];
  cap?: number;
}): StanceTargetSet {
  const cap = input.cap ?? STANCE_TARGET_CAP;
  const canonicalById = new Map<string, string>();
  for (const e of input.catalog) canonicalById.set(e.id, e.canonicalName);

  const trackedIds = new Set<string>();
  for (const t of input.trackedAugmentTargets) {
    if (t.representativeEntityId) trackedIds.add(t.representativeEntityId);
    for (const id of t.entityIds ?? []) trackedIds.add(id);
  }

  // 삽입 순서 = 멘션 순서. 아래 sort 는 안정 정렬이 아니어도 되게 4순위까지 박는다.
  const acc = new Map<
    string,
    { mentionCount: number; firstMentionPosition: number; fallbackLabel: string }
  >();
  const add = (entityId: string, mention: MeasurementMention): void => {
    const cur = acc.get(entityId);
    if (cur) {
      cur.mentionCount += 1;
      if (mention.mentionPosition < cur.firstMentionPosition) {
        cur.firstMentionPosition = mention.mentionPosition;
      }
      return;
    }
    acc.set(entityId, {
      mentionCount: 1,
      firstMentionPosition: mention.mentionPosition,
      fallbackLabel: mention.surfaceText,
    });
  };

  for (const mention of input.mentions) {
    if (mention.resolutionStatus === "resolved") {
      const brandRollup = resolveRollups(
        mention,
        input.rels,
        input.grouping,
      ).brandRollupEntityId;
      if (brandRollup) add(brandRollup, mention);
    }
    if (mention.entityType === "Brand" && mention.entityId) {
      add(mention.entityId, mention);
    }
  }

  const candidates: StanceTarget[] = [];
  for (const [entityId, v] of acc) {
    const label = canonicalById.get(entityId) ?? v.fallbackLabel;
    // 이름을 모르면 프롬프트에 실을 키가 없다 — 조용한 오분류보다 결손이 낫다.
    if (!label || label.length === 0) continue;
    candidates.push({
      entityId,
      label,
      isTracked: trackedIds.has(entityId),
      mentionCount: v.mentionCount,
      firstMentionPosition: v.firstMentionPosition,
    });
  }

  candidates.sort((a, b) => {
    if (a.isTracked !== b.isTracked) return a.isTracked ? -1 : 1;
    if (a.mentionCount !== b.mentionCount) return b.mentionCount - a.mentionCount;
    if (a.firstMentionPosition !== b.firstMentionPosition) {
      return a.firstMentionPosition - b.firstMentionPosition;
    }
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
  });

  // 같은 라벨이 서로 다른 엔티티 두 개에 붙으면 모델 응답을 되짚을 수 없다
  // (문자열 키). 퍼지 매칭을 안 하기로 한 이상 **뒤쪽을 버린다** — 정렬이
  // tracked·다빈도를 앞에 두므로 남는 쪽이 더 중요한 브랜드다.
  const seenLabel = new Set<string>();
  const deduped: StanceTarget[] = [];
  for (const c of candidates) {
    const key = normalizeSurface(c.label);
    if (seenLabel.has(key)) continue;
    seenLabel.add(key);
    deduped.push(c);
  }

  return {
    targets: deduped.slice(0, cap),
    truncated: deduped.length > cap,
    candidateCount: deduped.length,
  };
}

export type EvidenceMatch = "exact" | "empty" | "not_found" | "ambiguous";

export interface StanceMatchResult {
  stances: AnswerBrandStance[];
  /** 어느 대상에도 못 붙은 모델 브랜드 문자열 — 로그로 남긴다(RK2). */
  unmatchedBrands: string[];
  /** 응답이 없어 채점되지 않은 대상 수 — A3 커버리지의 지문. */
  unscoredTargets: number;
  /** **브랜드** evidence 의 검증 분포. aspect 축은 아래 별도 필드다. */
  evidenceMatchCounts: Record<EvidenceMatch, number>;
  /**
   * **aspect** evidence 의 검증 분포 (change add-answer-brand-stance, D6).
   *
   * 브랜드 축과 합치지 않는다 — 두 축은 모수가 다르고(브랜드 1건 vs aspect 0~8건)
   * 인용 구간의 성격도 다르다(aspect evidence 는 보통 더 좁은 span 이라
   * `not_found` 가 더 잘 난다). 합치면 다크런치에서 "어느 축이 환각하는가" 를
   * 못 가른다 — RK4 판정이 그 구분에 달려 있다.
   */
  aspectEvidenceMatchCounts: Record<EvidenceMatch, number>;
}

/**
 * 증거 오프셋 검증 (FR4 · 스펙 §4.4).
 *
 * `answerText.indexOf(evidence)` 가 **정확히 1회**일 때만 오프셋을 적는다.
 * 0회(`not_found`)·2회 이상(`ambiguous`)·빈 값(`empty`)은 **둘 다 null** 이고,
 * `evidence_text` 는 **보존**한다 — 사람이 나중에 판정할 수 있어야 하고,
 * 환각률(RK4)의 분모가 그 보존된 값이다.
 *
 * ⚠️ `end` 도 반드시 함께 변환한다. `end - start` 를 그대로 옮기면 구간 안에
 * 이모지가 있을 때 길이가 틀린다(`offsets.ts:30~32`).
 *
 * 파일럿 실측(2026-09-14, evidence 인용 4,179건): 원문 완전일치 **79.2%** ·
 * 공백·대소문자 정규화로 추가 회수 가능 1.8% · 앞 40자만 일치 5.9% · 빈 값 4.5% ·
 * 불일치 8.6%. **정규화 회수(1.8%)는 여기서 하지 않는다** — 정규화된 문자열의
 * 오프셋은 원문 오프셋이 아니라서, 하이라이트가 한 글자씩 어긋난 채 "검증됨"으로
 * 저장된다. 결손이 낫다(같은 원칙: 퍼지 브랜드 매칭 금지, §4.3).
 */
function verifyEvidence(
  answerText: string,
  evidence: string | null,
  cpMap: number[],
): { start: number | null; end: number | null; match: EvidenceMatch } {
  if (evidence == null || evidence.length === 0) {
    return { start: null, end: null, match: "empty" };
  }
  const first = answerText.indexOf(evidence);
  if (first < 0) return { start: null, end: null, match: "not_found" };
  if (answerText.indexOf(evidence, first + 1) >= 0) {
    return { start: null, end: null, match: "ambiguous" };
  }
  const start = toCodePointOffset(cpMap, first);
  const end = toCodePointOffset(cpMap, first + evidence.length);
  // ⚠️ **최종 가드 — `end > start` 가 아니면 오프셋을 쓰지 않는다.**
  //
  // UTF-16 인덱스 두 개가 코드포인트로는 **같은 값으로 접힐 수 있다**: 모델이
  // 서로게이트 쌍의 앞 절반 한 글자(`"\ud83d"`)를 인용하면 `indexOf` 는 찾아내지만
  // `buildCodePointIndexMap` 은 쌍의 두 인덱스를 같은 코드포인트로 매핑하므로
  // `start === end` 가 된다. 그대로 쓰면 DB 의
  // `measurement_answer_brand_stances_evidence_span_chk` 를 위반해 **그 트랜잭션이
  // 통째로 롤백**되고 멘션·감성까지 잃는다(FR6 위반). 빈 구간은 칠할 것이 없으므로
  // 결손으로 처리하는 것이 맞다 — `offsets.ts` 의 `makeOffsetNormalizer` 가
  // `e <= s` 를 null 로 접는 것과 같은 판단이다.
  if (!(end > start)) {
    return { start: null, end: null, match: "not_found" };
  }
  return { start, end, match: "exact" };
}

/**
 * 모델 응답 → 영속 가능한 스탠스 행.
 *
 * **브랜드 매칭 규율(semantics 에 없는 축)**: semantics 는 `index` 정수로 되짚지만
 * 스탠스는 **문자열 키**다. 1차 정확 일치 → 2차 `normalizeSurface` 일치 → 3차 실패.
 * **퍼지 매칭은 하지 않는다** — 조용한 오분류보다 결손이 낫다(스펙 §4.3).
 * 매칭 실패는 `unmatchedBrands` 로 표면화하고, A3 커버리지 98% 가 그 축의 감시다.
 *
 * 같은 대상에 대한 중복 응답은 **첫 번째만** 취한다(결정적).
 */
export function matchAndVerifyStances(input: {
  decisions: Array<{
    brand: string;
    stance: AnswerBrandStance["stance"];
    confidence: number | null;
    evidence: string | null;
    reasonKo: string | null;
    /** 없으면 빈 배열로 취급 — 옛 호출부·테스트 픽스처가 그대로 통과한다. */
    aspects?: Array<{
      aspect: string;
      stance: MentionSentiment;
      evidence: string | null;
    }>;
  }>;
  targets: StanceTarget[];
  answerText: string;
  modelSlug: string | null;
  stancePromptVersion: string;
  /** 대상 집합이 상한에 걸려 잘렸는가 — 메타에 남긴다. */
  brandsTruncated: boolean;
}): StanceMatchResult {
  const byExact = new Map<string, StanceTarget>();
  const byNormalized = new Map<string, StanceTarget>();
  for (const t of input.targets) {
    if (!byExact.has(t.label)) byExact.set(t.label, t);
    const n = normalizeSurface(t.label);
    if (!byNormalized.has(n)) byNormalized.set(n, t);
  }

  const cpMap = buildCodePointIndexMap(input.answerText);
  const evidenceMatchCounts: Record<EvidenceMatch, number> = {
    exact: 0,
    empty: 0,
    not_found: 0,
    ambiguous: 0,
  };
  const aspectEvidenceMatchCounts: Record<EvidenceMatch, number> = {
    exact: 0,
    empty: 0,
    not_found: 0,
    ambiguous: 0,
  };
  const unmatchedBrands: string[] = [];
  const taken = new Set<string>();
  const stances: AnswerBrandStance[] = [];

  for (const d of input.decisions) {
    const target =
      byExact.get(d.brand) ?? byNormalized.get(normalizeSurface(d.brand));
    if (!target) {
      unmatchedBrands.push(d.brand);
      continue;
    }
    if (taken.has(target.entityId)) continue;
    taken.add(target.entityId);
    const ev = verifyEvidence(input.answerText, d.evidence, cpMap);
    evidenceMatchCounts[ev.match] += 1;
    // 속성 스탠스 — 브랜드 evidence 와 **같은 verifyEvidence 규칙**(요구사항 3).
    // 상한은 여기서 **한 번 더** 방어적으로 자른다(llm.ts 가 이미 8개로 잘랐지만
    // 이 함수는 llm.ts 를 거치지 않는 다른 호출부에서도 쓰일 수 있는 순수 계층
    // 이다 — 대상 상한 12를 이 파일이 스스로 다시 강제하는 것과 같은 이유).
    const aspects: AnswerBrandStanceAspect[] = (d.aspects ?? [])
      .slice(0, STANCE_ASPECT_CAP)
      .map((a) => {
        const aspectEv = verifyEvidence(input.answerText, a.evidence, cpMap);
        aspectEvidenceMatchCounts[aspectEv.match] += 1;
        return {
          aspect: a.aspect.slice(0, STANCE_ASPECT_LABEL_CAP),
          stance: a.stance,
          evidence_text:
            a.evidence == null || a.evidence.length === 0 ? null : a.evidence,
          evidence_start: aspectEv.start,
          evidence_end: aspectEv.end,
          evidence_verified: aspectEv.match === "exact",
        };
      });
    stances.push({
      entityId: target.entityId,
      brandLabel: target.label,
      isTracked: target.isTracked,
      stance: d.stance,
      confidence: d.confidence,
      // 검증 실패여도 **보존**한다(FR4). 빈 문자열은 null 로 접는다.
      evidenceText: d.evidence == null || d.evidence.length === 0 ? null : d.evidence,
      evidenceStart: ev.start,
      evidenceEnd: ev.end,
      reason: d.reasonKo,
      modelSlug: input.modelSlug,
      extractionMetadata: {
        stance_prompt_version: input.stancePromptVersion,
        model_slug: input.modelSlug,
        evidence_match: ev.match,
        // `evidence_start`/`end` 가 믿을 수 있는가 — 화면·백필의 단일 판정 키.
        evidence_verified: ev.match === "exact",
        offset_basis: OFFSET_BASIS,
        brand_label_matched:
          byExact.get(d.brand) === target ? "exact" : "normalized",
        model_brand: d.brand,
        ...(input.brandsTruncated ? { brands_truncated: true } : {}),
      },
      aspects,
    });
  }

  // 결정적 출력 — 대상 순서(프롬프트 순서)를 따른다. 모델 응답 순서에 의존하면
  // 같은 입력이 다른 바이트를 낸다.
  const order = new Map(input.targets.map((t, i) => [t.entityId, i]));
  stances.sort(
    (a, b) => (order.get(a.entityId) ?? 0) - (order.get(b.entityId) ?? 0),
  );

  return {
    stances,
    unmatchedBrands,
    unscoredTargets: Math.max(0, input.targets.length - stances.length),
    evidenceMatchCounts,
    aspectEvidenceMatchCounts,
  };
}
