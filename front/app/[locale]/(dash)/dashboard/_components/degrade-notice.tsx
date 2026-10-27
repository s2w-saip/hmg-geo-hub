import { Clock } from "lucide-react";
import { getTranslations } from "next-intl/server";

// ⚠️ `PendingCard` 를 `standard/answer-analysis/_components/mentions-view.tsx` 에서
// import 하지 않는다 — 그 모듈은 `"use client"`(1,165줄, 표·차트·상태 전부 포함)라
// `/ko/dashboard` 의 First Load JS 가 **305 → 385 kB(+80 kB)** 로 뛴다(2026-09-11
// `npm run build` 실측, base `6beb6d8` 대비 — 초판이 실제로 그랬고 재검에서 잡혔다).
// 서버 컴포넌트로 분리한 뒤 **305 kB 로 복귀**했다. 성능 PR 이 성능을 깎을 수는 없다.
// 이 카드는 아이콘 하나 + 마크업 열 줄짜리 **서버 컴포넌트**로 충분하므로 여기서 만든다.
// 시각 계약은 원본과 동일(같은 클래스) — 원본이 바뀌면 여기도 맞춰야 한다.
function PendingCard({ title, label }: { title: string; label: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-card p-4">
      <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      <div className="flex items-center justify-center gap-2 rounded-md bg-muted/20 px-4 py-8 text-xs text-muted-foreground">
        <Clock className="h-4 w-4" aria-hidden />
        {label}
      </div>
    </div>
  );
}

/**
 * 지연 고지 카드 — 화면 payload(또는 화면 자체의 일시 실패)가 그 섹션이 degrade 됐다고 알리면
 * 호출부가 판정하고, 이 컴포넌트는 카드만 그린다. 문구는 4-KPI 탭이 이미 쓰는
 * `answerAnalysis.mentions.kpi.degraded`("이 구간의 집계가 시간 안에 끝나지 않아 표시하지 않습니다")다.
 */
export async function PendingNotice({ title }: { title: string }) {
  const tKpi = await getTranslations("answerAnalysis.mentions.kpi");
  return <PendingCard title={title} label={tKpi("degraded")} />;
}
