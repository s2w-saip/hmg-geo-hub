import { Clock } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { wasDegraded } from "@/lib/scope/server";

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
 * 이 경계의 read 중 **예산에 걸린 것**이 있으면 지연 문구를 낸다.
 *
 * 라벨은 `lib/scope/degrade-registry.ts` 의 요청 스코프 표식이고, 추가 조회가 없다.
 * 문구는 새로 만들지 않고 4-KPI 탭이 이미 쓰는 `answerAnalysis.mentions.kpi.degraded`
 * ("이 구간의 집계가 시간 안에 끝나지 않아 표시하지 않습니다")를 재사용한다.
 * degrade 가 아니면 아무것도 그리지 않는다 — 정상 경로의 마크업은 종전과 같다.
 */
export async function DegradeNotice({ labels, title }: { labels: readonly string[]; title: string }) {
  if (!labels.some((l) => wasDegraded(l))) return null;
  const tKpi = await getTranslations("answerAnalysis.mentions.kpi");
  return <PendingCard title={title} label={tKpi("degraded")} />;
}

// ⚠️ 아래 두 목록의 문자열은 `lib/scope/server.ts` 의 `degradeAware(<라벨>)` 과 **정확히**
// 같아야 한다 — 틀리면 degrade 가 조용히 고지 없이 지나간다(표식은 라벨 문자열 매칭뿐).
// `wasDegraded` 는 RSC 요청 스코프 밖에서 fail-closed(false)라 렌더 테스트로는 못 잡는다.
// 그래서 `dashboard.degrade-labels.test.ts` 가 **server.ts 소스와 대조**해 고정한다.
/** Δ 배지·스파크라인이 기다리는 read — `fetchStandardTrend` 는 단위별로 라벨이 갈린다. */
export const EXTRAS_LABELS = ["standardTrend:day", "standardTrend:week"] as const;
/**
 * 경쟁사 행이 기다리는 read 중 **degrade 표식을 내는 것** = 넷 전부(PR④ A3).
 *
 * 종전에는 셋뿐이었다 — 네 번째 `fetchStandardCitationDomains` 에 `degradeAware` 가
 * 없어서, 없는 라벨을 목록에 두면 "고지하는 척"이 되기 때문이었다. A3 가 그 페처에
 * `degradeAware` + `extras` 예산을 붙이면서 넷이 같은 계약이 됐다.
 */
export const COMPETITOR_LABELS = [
  "standardMentions",
  "brandTrend",
  "firstPosition",
  "standardCitationDomains",
] as const;
