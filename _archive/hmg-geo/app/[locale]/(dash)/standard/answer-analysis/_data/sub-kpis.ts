import type { StandardSubKpis } from "@/lib/db/repositories/scope-aggregates";

// 답변분석 > 언급 화면이 쓰는 Sub KPI view-model.
//
// 산출 자체는 미러 집계(aggregateSubKpisFromMirror)가 엔진(target)별 행으로
// 내려주고, 여기서는 그 행들을 전체 합산해 화면이 그대로 그릴 수 있는 스칼라로
// 접는다. Core 카드(대시보드)가 아니라 언급 화면이 이 지표들의 지면이다
// (2026-07-29 결정 — 카드는 값 아래 분자/분모 2줄을 이미 쓰고 있어 자리가 없고,
// 미언급/복수언급/Top3 는 드릴다운이 있는 언급 화면 쪽이 의미가 산다).
//
// null 의 의미는 두 가지로 갈린다:
//   - promptsWithoutBrand: 측정 프롬프트가 0개 (집계가 null 로 내려줌)
//   - 감정 3종: 당사 언급의 sentiment 신호가 0건 → 값 0 대신 "측정 대기"
export interface MentionSubKpis {
  // #9 당사 브랜드가 어떤 답변에도 등장하지 않은 프롬프트 수 (prompt 단위).
  missingPrompts: number | null;
  // #15 당사 언급이 2회 이상인 답변 수 (answer 단위).
  multiMentionAnswers: number;
  // #20 당사 등장 위치 평균이 3.0 이하인 답변의 비중 (%). 분모는 당사가 1회
  // 이상 등장한 답변 — "3위 이내"가 아니라 "평균 위치 3.0 이하"다.
  top3Rate: number | null;
  // top3Rate 의 분자(평균 위치 3.0 이하 답변 수)·분모(당사 등장 답변 수) —
  // 비율만으로는 표본 규모를 알 수 없다는 고객 피드백(2026-08-06)으로 병기.
  top3Count: number | null;
  top3Base: number | null;
  // #17 / #18 당사 긍정·부정 sentiment 신호 합. (필드명은 화면 i18n 키와 1:1 —
  // 값은 집계의 positiveMentions / negativeMentions 를 그대로 싣는다.)
  positiveKeywords: number | null;
  negativeKeywords: number | null;
  // 당사(전 브랜드 합산) 언급률 — 당사가 1회 이상 언급된 답변 ÷ 전체 답변 (%).
  // 답변 단위 DISTINCT(EXISTS) 기준이라 브랜드별 언급률을 더하는 것과 달리
  // 복수 브랜드 동시 언급을 중복 계상하지 않는다 — 헤드투헤드 '당사' 행 전용.
  // (2026-08-06 고객 피드백: 합산+클램프 산식이 100% 고정을 만들던 버그의 대체값)
  ownMentionRate: number | null;
  // 직전 측정 대비 증감 계산용 총계(2026-08-07) — 표시값은 MentionsLive.summary
  // 를 유지하고, 증감(Δ)만 현재/직전 스냅샷 모두 이 필드에서 계산해 산식 기준을
  // 통일한다.
  totalMentions: number;
  measuredPrompts: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function buildMentionSubKpis(sub: StandardSubKpis | null): MentionSubKpis | null {
  if (!sub || sub.rows.length === 0) return null;
  const sum = (f: (r: StandardSubKpis["rows"][number]) => number) =>
    sub.rows.reduce((s, r) => s + f(r), 0);

  const tracked = sum((r) => r.tracked);
  const answers = sum((r) => r.answers);
  const sentMentions = sum((r) => r.sentMentions);

  return {
    missingPrompts: sub.promptsWithoutBrand,
    multiMentionAnswers: sum((r) => r.multi),
    top3Rate: tracked > 0 ? round1((100 * sum((r) => r.top3)) / tracked) : null,
    top3Count: tracked > 0 ? sum((r) => r.top3) : null,
    top3Base: tracked > 0 ? tracked : null,
    positiveKeywords: sentMentions > 0 ? sum((r) => r.positiveMentions) : null,
    negativeKeywords: sentMentions > 0 ? sum((r) => r.negativeMentions) : null,
    ownMentionRate: answers > 0 ? round1((100 * tracked) / answers) : null,
    totalMentions: sum((r) => r.totalMentions),
    measuredPrompts: sub.measuredPrompts,
  };
}
