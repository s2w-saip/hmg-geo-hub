import { requireCronSecret } from "@/lib/cron-auth";
import {
  scanViewLag,
  scanGenerationBacklog,
  scanUrlHitsCoverage,
  buildUrlHitsGapAlertBody,
  URL_HITS_GAP_ALERT_TITLE,
  type UrlHitsCoverageVerdict,
  scanAnchorGap,
  buildAnchorGapAlertTitle,
  buildAnchorGapAlertBody,
  type AnchorGapVerdict,
  buildViewLagAlertBody,
  buildGenerationBacklogIssueBody,
  VIEW_LAG_ALERT_TITLE,
  GENERATION_BACKLOG_ISSUE_TITLE,
  GENERATION_BACKLOG_COOLDOWN_HOURS,
  type ViewLagVerdict,
  type BacklogVerdict,
} from "@/lib/summary/health/cycle-chain";
import { postSlackAlert, isSlackSinkConfigured } from "@/lib/alerts/slack";
import { reportIssue, isIssueSinkConfigured } from "@/lib/alerts/github-issue";

// 회차 사슬 감시 크론 — 마감 → 생성 → 노출 이 어디서 끊겼는지 본다 (2026-09-16).
//
// ── 왜 `sync-mirror` 에 얹지 않았나 ───────────────────────────────────────
// 그쪽은 이미 20분마다 관제 + 동기화 + 감시 둘을 300s 예산 안에 욱여넣고 있고,
// 파일 헤더가 "넷째를 붙이려면 세 상수를 함께 다시 계산하라" 고 명시적으로 경고한다.
// 더 결정적인 이유는 **동기화가 죽으면 그 뒤 감시도 같이 죽는다**는 것이다 —
// 2026-09-14 에 동기화가 16틱 연속 300s 타임아웃 났을 때 뒷단 관제가 **0회** 실행된
// 전례가 그 리포 안에 있다. 이 감시는 그 사고를 잡으려고 만드는 것이므로 같은
// 배에 태우면 안 된다. **별도 라우트 · 별도 스케줄**이 설계의 핵심이다.
//
// ── 왜 6시간인가 ─────────────────────────────────────────────────────────
// Slack 웹훅은 GitHub Issue 와 달리 서버측 중복 억제가 없다 — 보낸 만큼 울린다. 그런데
// 이 리포에는 "마지막으로 언제 알렸나" 를 적을 곳이 없다(상태 표를 새로 만들려면
// 마이그레이션이 필요하고, 그건 이 변경의 범위 밖이다). 그래서 **스케줄 자체가
// 스로틀**이다: 조건이 계속 참이어도 하루 4회를 넘지 않는다.
// 임계값이 시간·일 단위(노출 여유 48h · 생성 적체 6h)라 6시간 해상도로 충분하다.
//
// 감시 목적지 (alert-routing 룰):
//   ① 노출 지체 → **Slack**      (고객 화면이 지금 다르다 = 라이브 이슈)
//   ② 생성 적체 → **GitHub Issue** (사람이 러너·코드를 고쳐야 해소된다)
//   ③ URL 인용률 사실표 누락(0081) → **Slack** 주의(카드가 지금 느린 미러로 폴백 중).
//      해소가 운영자 백필이고 상시 재발형이 아니라 라이브 채널이 맞다.
//   ④ 회차 표시(앵커) 공백 → **Slack** (2026-09-29). 완료 답변인데 앵커 행이 없으면 앵커 축
//      화면에서 조용히 빠진다(= 고객 화면이 지금 다르다). 1차 방어는 sync 크론의 자동 채움이고
//      이 감시는 그 뒤에도 남은 것(싱크 후 1시간+)을 본다. 등급 기준은 cycle-chain.ts ④.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface SinkReport {
  alert: string;
  severity: number;
  issue?: number;
  error?: string;
}

/** 감시 ① → Slack. 미배선을 **통과로 치지 않는다**(alert-routing 룰 4). */
async function emitViewLag(v: ViewLagVerdict): Promise<SinkReport> {
  if (!v.checked || v.severity === 0) {
    return { alert: "none", severity: v.severity };
  }
  const summary = v.surfaces
    .filter((s) => s.severity > 0)
    .map((s) => `${s.surface} ${s.cyclesBehind}회차/${s.overdueHours}h`)
    .join(" · ");
  if (!isSlackSinkConfigured()) {
    console.error(
      `[cycle-chain/view-lag] 노출 지체 감지(등급 ${v.severity}: ${summary}) — ` +
        "그러나 알림 채널 미배선(SLACK_ALERT_WEBHOOK).",
    );
    return { alert: "unconfigured", severity: v.severity };
  }
  const res = await postSlackAlert({
    severity: v.severity,
    title: `${VIEW_LAG_ALERT_TITLE} — ${summary}`,
    body: buildViewLagAlertBody(v),
  });
  if (res.status === "failed") {
    console.error(`[cycle-chain/view-lag] Slack 발송 실패: ${res.error}`);
  }
  return { alert: res.status, severity: v.severity, error: res.error };
}

/** 감시 ③ → Slack(주의). 판정 불가(0081 미적용·오류)는 알리지 않고 응답에만 싣는다. */
async function emitUrlHits(v: UrlHitsCoverageVerdict): Promise<SinkReport> {
  if (!v.checked || v.severity === 0) return { alert: "none", severity: v.severity };
  const title = `${URL_HITS_GAP_ALERT_TITLE}: 노출 회차 ${v.gaps.length}개 미러 폴백`;
  if (!isSlackSinkConfigured()) {
    console.error(`[cycle-chain/url-hits] ${title}: 그러나 알림 채널 미배선(SLACK_ALERT_WEBHOOK).`);
    return { alert: "unconfigured", severity: v.severity };
  }
  const res = await postSlackAlert({ severity: v.severity, title, body: buildUrlHitsGapAlertBody(v) });
  if (res.status === "failed") console.error(`[cycle-chain/url-hits] Slack 발송 실패: ${res.error}`);
  return { alert: res.status, severity: v.severity, error: res.error };
}

/** 감시 ④ → Slack. 미배선을 통과로 치지 않는다(룰 4). 판정 불가는 알리지 않고 응답에만. */
async function emitAnchorGap(v: AnchorGapVerdict): Promise<SinkReport> {
  if (!v.checked || v.severity === 0) return { alert: "none", severity: v.severity };
  const title = buildAnchorGapAlertTitle(v);
  if (!isSlackSinkConfigured()) {
    console.error(`[cycle-chain/anchor-gap] ${title} (등급 ${v.severity}): 그러나 알림 채널 미배선(SLACK_ALERT_WEBHOOK).`);
    return { alert: "unconfigured", severity: v.severity };
  }
  const res = await postSlackAlert({ severity: v.severity, title, body: buildAnchorGapAlertBody(v) });
  if (res.status === "failed") console.error(`[cycle-chain/anchor-gap] Slack 발송 실패: ${res.error}`);
  return { alert: res.status, severity: v.severity, error: res.error };
}

/** 감시 ② → GitHub Issue. 제목 고정 + 쿨다운으로 중복을 억제한다. */
async function emitBacklog(v: BacklogVerdict): Promise<SinkReport> {
  if (!v.checked || v.severity === 0) {
    return { alert: "none", severity: v.severity };
  }
  if (!isIssueSinkConfigured()) {
    console.error(
      `[cycle-chain/backlog] 생성 대기 적체 ${v.aged.length}건(최장 ${v.oldestAgeHours}h) — ` +
        "그러나 알림 채널 미배선(GITHUB_ALERT_TOKEN/GITHUB_ALERT_REPO).",
    );
    return { alert: "unconfigured", severity: v.severity };
  }
  const res = await reportIssue({
    title: GENERATION_BACKLOG_ISSUE_TITLE,
    body: buildGenerationBacklogIssueBody(v),
    cooldownHours: GENERATION_BACKLOG_COOLDOWN_HOURS,
  });
  if (res.status === "failed") {
    console.error(`[cycle-chain/backlog] 이슈 표면화 실패: ${res.error}`);
  }
  return { alert: res.status, severity: v.severity, issue: res.issueNumber };
}

export async function GET(req: Request): Promise<Response> {
  const denied = requireCronSecret(req);
  if (denied) return denied;
  // `?dry=1` — 판정만 하고 **아무것도 보내지 않는다**. 운영자가 "지금 무엇을
  // 잡는가" 를 확인하는 경로다. 보내는 쪽이 기본값이면 안 되므로 명시 플래그.
  const dry = new URL(req.url).searchParams.get("dry") === "1";

  // 두 판정은 서로 독립이다 — 하나가 죽어도 다른 하나는 나가야 한다.
  const [viewLag, backlog, urlHits, anchorGap] = await Promise.all([
    scanViewLag(),
    scanGenerationBacklog(),
    scanUrlHitsCoverage(),
    scanAnchorGap(),
  ]);

  const sinks = dry
    ? {
        viewLag: { alert: "dry-run", severity: viewLag.severity } as SinkReport,
        backlog: { alert: "dry-run", severity: backlog.severity } as SinkReport,
        urlHits: { alert: "dry-run", severity: urlHits.severity } as SinkReport,
        anchorGap: { alert: "dry-run", severity: anchorGap.severity } as SinkReport,
      }
    : await (async () => {
        const [v, b, u, g] = await Promise.all([
          emitViewLag(viewLag), emitBacklog(backlog), emitUrlHits(urlHits), emitAnchorGap(anchorGap),
        ]);
        return { viewLag: v, backlog: b, urlHits: u, anchorGap: g };
      })();

  return Response.json({
    ok: true,
    dry,
    // 최종 등급 — 0=PASS / 1=주의 / 2=긴급.
    severity: Math.max(viewLag.severity, backlog.severity, urlHits.severity, anchorGap.severity),
    viewLag,
    backlog,
    // 누락 목록은 최대 500행이라 응답에는 개수·실패 수만 싣는다.
    urlHits: {
      checked: urlHits.checked, reason: urlHits.reason, unitOn: urlHits.unitOn,
      severity: urlHits.severity, gaps: urlHits.gaps.length,
      failed: urlHits.gaps.filter((g) => g.failed === true).length, error: urlHits.error,
    },
    anchorGap,
    sinks,
    at: new Date().toISOString(),
  });
}
