"use client";

import { fetchPromptAuditTimeline } from "@/app/[locale]/(dash)/standard/prompts/_actions";
import { PromptAuditTimelineDialog, type TimelineLoad } from "./prompt-audit-timeline-dialog";

// 프롬프트별 변경 이력 타임라인 (catalog-prompt-audit) — admin 카탈로그용. 데이터는 열람
// 게이트(NON_VENDOR)의 fetchPromptAuditTimeline 서버 액션으로 열릴 때 가져온다.

async function loadFromAction(promptId: string): Promise<TimelineLoad> {
  const res = await fetchPromptAuditTimeline(promptId);
  return res.ok ? { phase: "ready", rows: res.value } : { phase: "error" };
}

export function PromptAuditTimeline(props: {
  promptId: string;
  promptText: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return <PromptAuditTimelineDialog {...props} load={loadFromAction} />;
}
