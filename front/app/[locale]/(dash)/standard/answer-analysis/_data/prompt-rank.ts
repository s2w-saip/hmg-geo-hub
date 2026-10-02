// 드릴다운 프롬프트 행의 "순위" · "언급 TOP 3 이내" 배지 — 순수 함수.
//
// 프롬프트 하나에는 답변이 여럿(엔진×지역)이고 각 답변에 브랜드 위치(position)가
// 있다. 디자인(327:116 하단)의 순위 열은 그중 **가장 앞 순위**(min)이고, TOP 3 배지는
// 그 값이 3 이하일 때다. 위치 정보가 하나도 없으면 null — 0 으로 위장하지 않는다.

import type { MentionsPromptLive } from "@/lib/scope/result-adapter";

export const TOP_RANK_THRESHOLD = 3;

export function promptBestRank(row: Pick<MentionsPromptLive, "answers">): number | null {
  let best: number | null = null;
  for (const a of row.answers ?? []) {
    if (a.position == null || a.position <= 0) continue;
    if (best == null || a.position < best) best = a.position;
  }
  return best;
}

export function isTopRank(rank: number | null): boolean {
  return rank != null && rank <= TOP_RANK_THRESHOLD;
}

/** 복수 언급 토글이 켜졌을 때의 브랜드 행 값. 데이터가 없으면 전부 null. */
export interface BrandRowValues {
  mentions: number | null;
  prompts: number | null;
  /** 복수 언급 합 대비(토글 on) / 전체 언급 합 대비(off). */
  share: number | null;
  /** 답변 단위 비율(%). */
  mentionRate: number | null;
}

export function brandRowValues(
  row: import("@/lib/scope/result-adapter").MentionsBrandLive,
  opts: { multi: boolean; multiTotalMentions: number; totalAnswers: number | null },
): BrandRowValues {
  if (!opts.multi) {
    return { mentions: row.mentions, prompts: row.prompts, share: row.share, mentionRate: row.mentionRate };
  }
  const m = row.multi;
  if (!m) return { mentions: null, prompts: null, share: null, mentionRate: null };
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    mentions: m.mentions,
    prompts: m.prompts,
    share: opts.multiTotalMentions > 0 ? round1((100 * m.mentions) / opts.multiTotalMentions) : null,
    mentionRate:
      opts.totalAnswers != null && opts.totalAnswers > 0
        ? round1((100 * m.answers) / opts.totalAnswers)
        : null,
  };
}
