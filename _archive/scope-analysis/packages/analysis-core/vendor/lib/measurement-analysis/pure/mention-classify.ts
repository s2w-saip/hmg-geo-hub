// 멘션 역할·주장·후보 분류 술어 — store.ts 에서 무수정 이동.
import type { LlmExtractedMention } from "../llm";
import { compactSurface, normalizeSurface } from "../normalize";
import type { MeasurementCandidate, MeasurementMention } from "../schema";
import { hasExcludedOptionCue } from "./filters";

export function normalizeLlmMentionRole(mention: LlmExtractedMention): MeasurementMention["mentionRole"] {
  if (mention.entityType === "Feature" && mention.mentionRole === "single_choice") {
    return "background";
  }
  return mention.mentionRole ?? "background";
}

export function normalizeLlmAssertion(mention: LlmExtractedMention): MeasurementMention["assertion"] {
  if (mention.entityType === "Feature" && mention.assertion === "final_choice") {
    return "mention_only";
  }
  return mention.assertion ?? "mention_only";
}

export function isGenericFeatureLikeProductSurface(mention: LlmExtractedMention): boolean {
  const surfaces = [mention.surfaceText, mention.canonicalGuess].filter(
    (value): value is string => !!value && value.trim().length > 0,
  );
  for (const surface of surfaces) {
    const normalized = normalizeSurface(surface);
    const compact = compactSurface(surface);
    const hasModelIdentityToken =
      /(?:^|\s)[A-Za-z]{1,5}\d[A-Za-z0-9-]*(?:\s|$)/.test(surface) ||
      /[가-힣]{2,}\s*(?:[A-Za-z]{1,5}\d|[A-Z]{2,}\d*)/u.test(surface);
    if (
      [
        "hybrid",
        "hev",
        "phev",
        "ev",
        "hybridhev",
        "pluginhybrid",
        "pluginhybridphev",
        "awd",
        "fwd",
        "rwd",
        "4wd",
        "egmp",
        "htrac",
        "htracawd",
        "hda",
        "hda2",
        "lfa",
        "acc",
        "scc",
        "elsd",
        "ccnc",
        "htex",
        "syntex",
        "smartsense",
        "drivewise",
        "longrange",
        "롱레인지",
        "fullflat",
        "walkthrough",
        "tco",
        "totalcostofownership",
        "safety",
        "safe",
        "안전",
        "안전성",
        "하이브리드",
        "플러그인하이브리드",
        "사륜구동",
        "전륜구동",
        "후륜구동",
      ].includes(compact)
    ) {
      return true;
    }
    if (
      !hasModelIdentityToken &&
      /(?:egmp|htrac|hda2?|lfa|acc|scc|elsd|ccnc|htex|syntex|smartsense|drivewise|highwaydrivingassist|고속도로주행보조|전자식차동제한장치|휠|인치|타이어|미쉐린|michelin|금호|kumho|xice|crossclimate|wintercraft|윈터크래프트|6인동선|동선)/iu.test(
        compact,
      )
    ) {
      return true;
    }
    if (
      /^(?:full[-\s]*flat|walk[-\s]*through|tco(?:\s*,?\s*total\s+cost\s+of\s+ownership)?|total\s+cost\s+of\s+ownership|safety|safe)$/i.test(
        normalized,
      ) ||
      /^(?:안전|안전성|총소유비용|총\s*소유\s*비용)$/u.test(normalized)
    ) {
      return true;
    }
    if (
      !hasModelIdentityToken &&
      (/^(?:[a-z0-9]+[-\s]*)?(?:x[-\s]*pro|gt[-\s]*line|n[-\s]*line|signature|prestige|calligraphy)(?:\s*(?:trim|트림|grade|라인|line))?$/i.test(
        normalized,
      ) ||
        /(?:트림|grade|trim)$/i.test(normalized))
    ) {
      return true;
    }
    if (
      /^(?:하이브리드|전기|전기차|전동화|가솔린|디젤|터보|내연기관)(?:\s*[0-9]+(?:\.[0-9]+)?[a-z]*)?(?:\s*(?:모델|트림|라인업|엔진|파워트레인|사양|버전))?$/iu.test(
        normalized,
      ) ||
      /^(?:[0-9]+(?:\.[0-9]+)?\s*)?(?:터보|가솔린|디젤)\s*(?:하이브리드|hev|phev)(?:\s*(?:모델|트림|엔진|사양|버전|파워트레인))?$/iu.test(
        normalized,
      ) ||
      /^(?:[0-9]+(?:\.[0-9]+)?t|[0-9]+(?:\.[0-9]+)?\s*(?:가솔린|디젤|터보))(?:\s*(?:모델|트림|엔진|사양|버전))?$/iu.test(
        normalized,
      ) ||
      /^(?:[0-9]+(?:\.[0-9]+)?)?(?:터보|가솔린|디젤)(?:하이브리드|hev|phev)(?:모델|트림|라인업|엔진|파워트레인|사양|버전)?$/iu.test(
        compact,
      ) ||
      /^(?:하이브리드|전기|전기차|전동화|가솔린|디젤|터보|내연기관|[0-9]+(?:\.[0-9]+)?t|[0-9]+(?:\.[0-9]+)?가솔린|[0-9]+(?:\.[0-9]+)?디젤)(?:모델|트림|라인업|엔진|파워트레인|사양|버전)?$/iu.test(
        compact,
      )
    ) {
      return true;
    }
    if (
      /^(?:plug[-\s]*in\s+)?hybrid(?:\s*\(?(?:hev|phev)\)?)?$/i.test(
        normalized,
      ) ||
      /^(?:all[-\s]*wheel|front[-\s]*wheel|rear[-\s]*wheel|four[-\s]*wheel)\s+drive$/i.test(
        normalized,
      ) ||
      /^(?:전기\s*파워트레인|전동화\s*파워트레인|플러그인\s*하이브리드)$/i.test(
        normalized,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function hasFinalChoiceCue(text: string): boolean {
  return (
    /(최종|마지막|딱\s*하나|하나만|고르|선택|추천은|결론)/i.test(text) ||
    /\b(final|single|pick|choose|chosen|choice|winner|top recommendation)\b/i.test(
      text,
    )
  );
}

export function isFinalChoiceCueForMention(input: {
  sentence?: string | null;
  evidenceSnippet?: string | null;
  context: string;
  surfaceText: string;
}): boolean {
  const text = input.sentence ?? input.evidenceSnippet ?? input.context;
  if (!hasFinalChoiceCue(text)) return false;
  if (hasExcludedOptionCue(text, input.surfaceText)) return false;
  const compactText = compactSurface(text);
  const compactMention = compactSurface(input.surfaceText);
  const idx = compactText.indexOf(compactMention);
  if (idx < 0) return true;
  const before = compactText.slice(0, idx);
  const after = compactText.slice(idx + compactMention.length);
  if (/(?:제외|단종|미출시|비추천|탈락|아니|어렵|불리|반면|다만|하지만|대신)$/.test(before)) {
    return false;
  }
  if (/^(?:는|은|가|이)?(?:제외|단종|미출시|비추천|탈락|아니|어렵|불리)/.test(after)) {
    return false;
  }
  return true;
}

export function candidateKindForEntityType(
  type: NonNullable<LlmExtractedMention["entityType"]>,
): MeasurementCandidate["candidateKind"] {
  switch (type) {
    case "Brand":
      return "create_brand";
    case "Product":
      return "create_product";
    case "ProductCategory":
      return "create_product_category";
    case "Feature":
      return "create_feature";
  }
}

export function isAcrMetricImpactMention(
  mention: MeasurementMention,
  turnIndex?: number | null,
): boolean {
  if (mention.entityType !== "Brand" && mention.entityType !== "Product") return false;
  if (turnIndex === 1) return isAcrAppearanceEvidence(mention);
  if (typeof turnIndex === "number" && turnIndex > 1) {
    return (
      mention.mentionRole === "single_choice" ||
      mention.assertion === "recommend" ||
      mention.assertion === "final_choice"
    );
  }
  return (
    mention.mentionRole === "shortlist_candidate" ||
    mention.mentionRole === "comparison_target" ||
    mention.mentionRole === "single_choice" ||
    mention.assertion === "recommend" ||
    mention.assertion === "compare" ||
    mention.assertion === "final_choice"
  );
}

export function isAcrAppearanceEvidence(mention: {
  mention_role?: string | null;
  mentionRole?: string | null;
  assertion: string | null;
}): boolean {
  const role = mention.mention_role ?? mention.mentionRole ?? null;
  return (
    role === "shortlist_candidate" ||
    role === "comparison_target" ||
    mention.assertion === "recommend" ||
    mention.assertion === "compare"
  );
}

export function isLlmResolverEligibleMention(mention: MeasurementMention): boolean {
  return (
    mention.resolutionStatus === "pending" &&
    (mention.entityType === "Brand" || mention.entityType === "Product")
  );
}

/**
 * `llm_mention` 후보의 signature 산식 — **이것이 유일한 사본이다.**
 *
 * 2026-09-12 실측 전까지 이 산식은 코드에 **두 벌**로 존재했다: 라이브 생산 경로
 * (`mentionFromLlmExtraction` 안의 인라인 리터럴 — 현재 `llm-mention-layer.ts`)와
 * 소비 표시용인 `candidateSignatureForMention`. 한쪽만 고치면 조용히 갈라지고,
 * 그 순간 백필·롤업이 라이브와 다른 키를 만든다. 그래서 생산 경로가 이 함수를
 * 부르고, 백필(`candidate-backfill.ts`)도 같은 함수를 쓴다
 * (change candidate-append-only, A16ⓒⓓ).
 *
 * 위치가 `pure/` 인 이유: 산식은 문자열 join 뿐이라 DB·env 의존이 없고, 생산자
 * (`pure/llm-mention-layer.ts`)와 소비자(`pure/resolver-layer.ts`)가 둘 다 순수
 * 계층에 있다. store.ts 는 백필·테스트의 기존 import 경로를 지키려고 이 이름을
 * 그대로 재수출한다 (PR #641 순수 추출과 PR #639 산식 통합의 합류점).
 *
 * ⚠️ 산식을 바꾸면 **이미 저장된 헤더·이벤트의 키가 전부 무효**가 된다. 바꾸려면
 * 마이그레이션이 따라야 한다.
 */
export function llmMentionCandidateSignature(parts: {
  entityType: string | null | undefined;
  surfaceNormalized: string;
  mentionRole: string | null | undefined;
  assertion: string | null | undefined;
}): string {
  return [
    "llm_mention",
    parts.entityType,
    parts.surfaceNormalized,
    parts.mentionRole,
    parts.assertion,
  ].join("|");
}

export function candidateSignatureForMention(mention: MeasurementMention): string {
  return llmMentionCandidateSignature(mention);
}
