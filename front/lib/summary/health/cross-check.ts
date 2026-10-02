import "server-only";
import {
  scanViewLag,
  scanGenerationBacklog,
  buildViewLagAlertBody,
  buildGenerationBacklogIssueBody,
  VIEW_LAG_GRACE_HOURS,
  GENERATION_BACKLOG_HOURS,
} from "./cycle-chain";
import { reportIssue, isIssueSinkConfigured } from "@/lib/alerts/github-issue";
import type { AlertSeverity } from "@/lib/alerts/slack";

// 회차 사슬 감시의 **교차 확인** — alert-routing 룰 7.
//
// "감시가 아예 안 도는 경우는 그 감시 자신이 못 잡는다." 주 감시
// (`/api/cron/cycle-chain-watch`, 6시간)가 죽는 경로는 여럿이고 전부 조용하다:
// vercel.json 의 크론 항목이 지워진다 · 라우트가 500 을 낸다 · 배포가 그 파일을
// 빠뜨린다 · CRON_SECRET 이 로테이션돼 401 로 튕긴다. 어느 경우에도 **아무 일도
// 일어나지 않는 것처럼 보인다** — 이번에 고치려는 결함과 정확히 같은 모양이다.
//
// 그래서 **다른 라우트 · 다른 스케줄**(GA4 워머, 매일 18:00Z)에 독립 관측자를
// 한 줄 둔다. 판정은 같은 함수를 쓴다(술어 두 벌 금지). 다른 것은 목적지뿐이다:
//   · 주 감시   → Slack(노출 지체) + GitHub Issue(생성 적체)
//   · 교차 확인 → **GitHub Issue 하나**, 제목이 다르다.
//
// Slack 을 여기서 또 울리지 않는 이유: 같은 사실을 두 발신처가 라이브 채널에 내면
// 사람이 "어느 쪽이 정본인가" 를 매번 되묻는다. 교차 확인의 목적은 **기록이
// 남는 것**이지 사람을 한 번 더 깨우는 것이 아니다.
//
// 하루 1회이므로 쿨다운은 짧게 잡아도 하루 1건을 넘지 않는다.

export const CROSS_CHECK_ISSUE_TITLE =
  "[summary] 회차 사슬 교차 확인 — 주 감시와 별도로 이상을 관측했다";

/** 하루 1회 도는 경로라 쿨다운은 그보다 짧으면 된다. */
const CROSS_CHECK_COOLDOWN_HOURS = 20;

export interface CycleChainCrossCheck {
  checked: boolean;
  severity: AlertSeverity;
  /** `none` · `created` · `commented` · `throttled` · `unconfigured` · `failed` · `error` */
  alert: string;
  issue?: number;
  error?: string;
}

export async function crossCheckCycleChain(): Promise<CycleChainCrossCheck> {
  const [viewLag, backlog] = await Promise.all([
    scanViewLag(),
    scanGenerationBacklog(),
  ]);
  // 둘 다 판정을 못 했으면(mock·DB 오류) **통과로 치지 않는다** — 재지 못한 것이다.
  if (!viewLag.checked && !backlog.checked) {
    return { checked: false, severity: 0, alert: "not-measured" };
  }
  const severity = Math.max(viewLag.severity, backlog.severity) as AlertSeverity;
  if (severity === 0) return { checked: true, severity: 0, alert: "none" };

  if (!isIssueSinkConfigured()) {
    console.error(
      `[cycle-chain/cross-check] 이상 관측(등급 ${severity}) — ` +
        "그러나 알림 채널 미배선(GITHUB_ALERT_TOKEN/GITHUB_ALERT_REPO).",
    );
    return { checked: true, severity, alert: "unconfigured" };
  }

  const lines: string[] = [
    "GA4 사전집계 크론(`/api/cron/ga4-prebuild`, 매일 1회)에 실린 **교차 확인**이 회차 사슬 이상을 관측했다.",
    "",
    "주 감시는 `/api/cron/cycle-chain-watch`(6시간)다. **그쪽이 살아 있다면** Slack 알림과",
    "`[summary] 생성 대기 적체 …` 이슈가 이미 떠 있어야 한다. 그것들이 없다면 주 감시 자체가",
    "안 돌고 있다는 뜻이므로 먼저 그쪽을 본다 — vercel.json 크론 등록 · 라우트 응답 · CRON_SECRET.",
    "",
    `- 최종 등급: **${severity}**`,
    `- 노출 지체(여유 ${VIEW_LAG_GRACE_HOURS}h): 등급 ${viewLag.severity}` +
      (viewLag.checked ? "" : " (판정 못 함)"),
    `- 생성 적체(임계 ${GENERATION_BACKLOG_HOURS}h): 등급 ${backlog.severity}` +
      (backlog.checked ? "" : " (판정 못 함)"),
    "",
  ];
  if (viewLag.severity > 0) {
    lines.push("## 노출 지체", "", "```", buildViewLagAlertBody(viewLag), "```", "");
  }
  if (backlog.severity > 0) {
    lines.push("## 생성 대기 적체", "", buildGenerationBacklogIssueBody(backlog), "");
  }

  const res = await reportIssue({
    title: CROSS_CHECK_ISSUE_TITLE,
    body: lines.join("\n"),
    cooldownHours: CROSS_CHECK_COOLDOWN_HOURS,
  });
  if (res.status === "failed") {
    console.error(`[cycle-chain/cross-check] 이슈 표면화 실패: ${res.error}`);
  }
  return {
    checked: true,
    severity,
    alert: res.status,
    issue: res.issueNumber,
  };
}
