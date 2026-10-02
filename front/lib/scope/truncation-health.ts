import "server-only";
import { RECHECK_MAX_RUNS_PER_PASS, type MirrorSyncResult } from "./mirror/sync";

// 조용한 절단 감시 — 미러 싱크가 **소리 없이 데이터를 덜 가져온** 경우를
// GitHub Issue 로 표면화한다.
//
// 왜 필요한가: 이 리포에는 절단을 알아채는 경로가 로그와 크론 응답 JSON 뿐이고,
// 둘 다 **아무도 보지 않는다**. alert-routing 룰 4 가 "토픽만 만들고 구독하지
// 않는 것을 금지" 하는 것과 같은 구멍이다 — 표면화는 됐지만 **목적지가 없다**.
//
// 실제로 값을 치른 사례:
//   - 2026-08-30 `scope_prompts.regions` 5,000 정체: 페이지 상한 절단이 조용해서
//     오래 살아 있었다. `PAGE CAP HIT` 경고는 그 사고 뒤에 생겼지만 목적지가
//     없어 여전히 사람에게 닿지 않는다.
//   - 루트 프로젝트 run 5,423 > 상한 5,000 — **지금도 절단 중**이다.
//
// 목적지 판단(alert-routing): 이 신호들은 전부 **사람이 코드를 고쳐야** 해소된다
// (상한 상향, 증분 커서 도입). 지금 서비스가 아픈 것이 아니므로 Slack 이 아니라
// GitHub Issue 다.

export const TRUNCATION_ISSUE_TITLE =
  "[mirror] 조용한 절단 감지 — 미러가 데이터를 덜 가져오고 있다";

// 상시 재발하는 신호를 매 패스(20분) 알리면 하루 72개가 쌓여 신호가 묻힌다.
// orphan-watch 와 같은 값으로 맞춘다.
export const TRUNCATION_ALERT_COOLDOWN_HOURS = 12;

export interface TruncationFindings {
  pageCapHits: MirrorSyncResult["pageCapHits"];
  recheckCapHits: string[];
  /**
   * 잡 상한을 구조적으로 넘어 **미러되지 않은** run 들 (2026-09-13 회차 8).
   * 페이지 상한과 성격이 다르다 — 저쪽은 "잘린 채 들어왔다", 이쪽은 "아예 없다".
   */
  oversizedRuns?: MirrorSyncResult["oversizedRuns"];
  /** jobs 피드 절단으로 **부분 기록을 피해 건너뛴** run 들. */
  truncatedRuns?: MirrorSyncResult["truncatedRuns"];
  /**
   * 재확인 잡 상한(`MIRROR_RECHECK_MAX_JOBS`)에 걸려 **다시 당기지 않은** run 들
   * (2026-09-14 사고). 여기 있는 것이 위 둘보다 **덜** 심각하지 않다 —
   * 저쪽은 "이번 패스가 못 가져왔고 다음 패스가 다시 시도한다", 이쪽은
   * **정규 크론이 더 이상 시도하지 않는다**(다음 패스도 같은 판정). 재확인 창
   * 3일이 지나면 신호 자체가 사라지므로 그 안에 사람이 resync 해야 한다.
   * 라우팅을 빼 두면 "더 심각한 신호가 덜 심각한 쪽보다 약한" 상태가 된다.
   */
  recheckDeferredHeavy?: MirrorSyncResult["recheckDeferredHeavy"];
}

/** 알릴 것이 있는가. 없으면 이슈를 열지 않는다. */
export function hasTruncation(f: TruncationFindings): boolean {
  return (
    f.pageCapHits.length > 0 ||
    f.recheckCapHits.length > 0 ||
    (f.oversizedRuns?.length ?? 0) > 0 ||
    (f.truncatedRuns?.length ?? 0) > 0 ||
    (f.recheckDeferredHeavy?.length ?? 0) > 0
  );
}

export function buildTruncationIssueBody(f: TruncationFindings): string {
  const lines: string[] = [
    "미러 동기화가 **상한에 걸려 데이터를 덜 가져왔다.** 아래는 이번 패스의 관측이며,",
    "상한은 코드 상수이므로 사람이 고쳐야 해소된다.",
    "",
  ];

  if (f.pageCapHits.length > 0) {
    lines.push("## 페이지 상한 소진 (`pageAll`)");
    lines.push("");
    lines.push(
      "해당 소스는 **잘린 채** 미러됐다. 상한 밖 항목은 이 경로로 도달할 수 없다.",
    );
    lines.push("");
    lines.push("| project | source |");
    lines.push("| --- | --- |");
    for (const h of f.pageCapHits) {
      lines.push(`| \`${h.projectId}\` | ${h.kind} |`);
    }
    lines.push("");
  }

  if ((f.oversizedRuns?.length ?? 0) > 0) {
    lines.push("## 잡 상한 초과 run — **미러에 아예 없다**");
    lines.push("");
    lines.push(
      "한 run 의 잡 수가 `MIRROR_JOB_MAX_PAGES × 200` 을 넘으면 이 크론으로는 온전히 " +
        "가져올 수 없다. 부분 기록이 terminal 로 굳는 것을 막기 위해 **건너뛴다** — " +
        "그 회차는 로컬 회수 도구(상한 상향)로 따로 미러해야 한다.",
    );
    lines.push("");
    lines.push("| project | run | total_jobs |");
    lines.push("| --- | --- | --- |");
    for (const r of f.oversizedRuns ?? []) {
      lines.push(`| \`${r.projectId}\` | \`${r.runId}\` | ${r.totalJobs} |`);
    }
    lines.push("");
  }

  if ((f.truncatedRuns?.length ?? 0) > 0) {
    lines.push("## jobs 피드 절단으로 건너뛴 run");
    lines.push("");
    lines.push("| project | run |");
    lines.push("| --- | --- |");
    for (const r of f.truncatedRuns ?? []) {
      lines.push(`| \`${r.projectId}\` | \`${r.runId}\` |`);
    }
    lines.push("");
  }

  if ((f.recheckDeferredHeavy?.length ?? 0) > 0) {
    lines.push("## 재확인 잡 상한 초과 — **정규 크론이 더 이상 회수하지 않는다**");
    lines.push("");
    lines.push(
      "이미 미러된 run 인데 미완 답변이 남아 매 패스 전량 재당김되던 것들이다. " +
        "잡 수가 `MIRROR_RECHECK_MAX_JOBS` 를 넘어 **이번 패스가 다시 당기지 않았다** — " +
        "페이지 상한과 달리 다음 패스가 자동으로 재시도하지 않는다(판정이 같다). " +
        "재확인 창(`RUN_RECHECK_WINDOW_DAYS` 3일)이 지나면 이 신호도 사라지므로, " +
        "**3일 안에 명시적 resync** 로 회수해야 한다: " +
        "`/api/cron/sync-mirror?force=1&projectIds=<project>` 또는 `npm run mirror:local-resync`.",
    );
    lines.push("");
    lines.push("| project | run | jobs |");
    lines.push("| --- | --- | --- |");
    for (const r of f.recheckDeferredHeavy ?? []) {
      lines.push(`| \`${r.projectId}\` | \`${r.runId}\` | ${r.jobs} |`);
    }
    lines.push("");
  }

  if (f.recheckCapHits.length > 0) {
    lines.push("## 재확인 상한 소진 (`RECHECK_MAX_RUNS_PER_PASS`)");
    lines.push("");
    lines.push(
      `한 패스에서 재확인할 수 있는 run 은 프로젝트당 **${RECHECK_MAX_RUNS_PER_PASS}건**이다. ` +
        "상한을 넘긴 나머지는 `skipped` 에 섞여 다음 패스로 밀린다 — 밀리는 것 자체는 " +
        "설계이나, **밀린 양이 계속 늘면 따라잡지 못한다.**",
    );
    lines.push("");
    for (const id of f.recheckCapHits) lines.push(`- \`${id}\``);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "이 이슈는 미러 크론(`/api/cron/sync-mirror`)이 자동으로 연다. " +
      `같은 제목의 열린 이슈가 ${TRUNCATION_ALERT_COOLDOWN_HOURS}시간 안에 갱신됐으면 코멘트를 생략한다.`,
  );
  return lines.join("\n");
}
