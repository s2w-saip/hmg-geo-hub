import { requireCronSecret } from "@/lib/cron-auth";
import { revalidateTag } from "next/cache";
import { syncStandardMirror, MIRROR_SYNC_BUDGET_MS } from "@/lib/scope/mirror/sync";
import { MIRROR_AGGREGATE_TAG } from "@/lib/scope/server";
import {
  scanOrphanProjects,
  buildOrphanIssueBody,
  ORPHAN_ISSUE_TITLE,
} from "@/lib/scope/orphan-health";
import { reportIssue, isIssueSinkConfigured } from "@/lib/alerts/github-issue";
// ── ⚠️ `alert:"unconfigured"` 는 결함이 아니라 **의도된 상태**다 (2026-08-30) ──
// 두 감시(orphan · truncation)는 코드 배선이 끝나 있지만 `GITHUB_ALERT_TOKEN` /
// `GITHUB_ALERT_REPO` 가 **의도적으로 보류**돼 있다. 판단 근거: 지금 불난 곳이
// 없고, 오늘 발견분(루트 페이지 상한 절단 · 고아 프로젝트 3건)은 전부 문서로
// 남았다. 되돌릴 비용이 없는 보류다 — **env 둘만 넣으면 즉시 가동**된다.
//
// 그러니 이 값을 보고 "감시가 고장났다"고 고치지 마라. 반대로 **`alert:"none"`
// 으로 바꿔 조용히 통과시키는 것도 금지다** — 미배선을 통과로 치지 않는 것이
// alert-routing 룰 4 이고, 이 응답 필드가 그 룰의 유일한 집행 지점이다.
//
// 재개 시 판정 기준(미리 정해 둔다 — 없으면 "이슈가 하나 떴으니 됐다"로 넘어간다):
//   절단과 고아가 **둘 다**, **제목이 달라 별개 이슈로** 열려야 정상이다.
//   하나만 열리면 배선이 반쪽이라는 뜻이다.
import { runCycleControl } from "@/lib/summary/cycle-control";
import {
  hasTruncation,
  buildTruncationIssueBody,
  TRUNCATION_ISSUE_TITLE,
  TRUNCATION_ALERT_COOLDOWN_HOURS,
  type TruncationFindings,
} from "@/lib/scope/truncation-health";

// Incremental scope → hmg-geo mirror sync (scope_* tables). New/un-mirrored
// measurement runs only; ?force=1 re-pulls everything. Guarded by CRON_SECRET
// (fail-closed, lib/cron-auth.ts; Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`). Outside
// the (dash) auth area — middleware matcher excludes /api.
//
// ── 실행 순서 (2026-09-14 사고, 이슈 #262) ─────────────────────────────────
// ① 회차 관제 → ② 미러 동기화 → ③ 감시 둘(병렬). 관제가 **맨 앞**이다.
//
// 종전엔 관제가 뒷단이었다(미러가 갱신된 뒤 읽어야 이번 패스 run 까지 회차에
// 굳는다는 설계 §2-7). 그런데 2026-09-14 18:00Z~23:00Z 동기화가 매 틱 300s 에서
// 죽자 관제는 **16틱 연속 한 번도 실행되지 못했다** — 루트 global 회차 8 의
// fleet_visible 이 5시간 넘게 멈추고 다른 프로젝트 회차 4개 개설도 밀렸다.
// 뒷단은 앞단이 죽으면 같이 죽는다. "동기화 성패와 독립" 이라는 계약을 지키려면
// 실행 순서에서도 독립이어야 한다.
//
// 대가는 **귀속이 한 틱(20분) 늦는 것**이다: 이번 패스가 당긴 run 은 다음 틱의
// 관제가 굳힌다. 관제는 멱등이고 20분마다 도므로 누락이 아니라 지연이다 —
// "가끔 20분 늦다" 가 "몇 시간 동안 아예 안 돈다" 보다 싸다.
//
// 같은 PR 의 재확인 잡 상한(`MIRROR_RECHECK_MAX_JOBS`)에도 대가가 있다:
// heavy run 의 failed→completed **회수 반영이 지연·수동화된다.** 종전에는 정규
// 크론이(사고 창 밖 평시에는) 그 회수를 자동 반영했다 — `replaceRun` 은 run 단위
// tx 라 같은 패스 앞쪽 run 은 커밋됐기 때문이다. 이제는 재확인 창 3일이 지나면
// 신호 자체가 사라지므로 **그 안에 명시적 resync** 가 필요하고, 대상은 응답
// `recheckDeferredHeavy` · 커서 `last_error` · 절단 감시 이슈에 나온다.
//
// 이 라우트는 미러 동기화와 함께 **고아 프로젝트 감시**도 돈다 — scope 미러가
// 없는 프로젝트(`scope_project_id IS NULL`)를 세어 GitHub Issue 로 표면화한다.
// 별도 크론을 만들지 않은 이유: 감시 대상(projects)에 이미 닿아 있는 프로세스가
// 20분마다 돌고 있어 새로 필요한 인프라가 0이다. 술어·본문은
// `lib/scope/orphan-health.ts`, 알림 싱크는 `lib/alerts/github-issue.ts` 가 정본.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 고아는 사람이 손대기 전엔 스스로 낫지 않는다 — 매 패스(20분)마다 코멘트하면
// 하루 72개가 쌓여 신호가 묻힌다. 반나절에 한 번만 남긴다.
const ORPHAN_ALERT_COOLDOWN_HOURS = 12;

/** `maxDuration` 을 ms 로. 예산 계산의 기준값이다. */
const MAX_DURATION_MS = maxDuration * 1000;
/**
 * 응답 직렬화·네트워크·감시(최악 ~17s)를 위해 남겨 두는 몫. 관제·동기화 예산은
 * 둘 다 `maxDuration − 지금까지 쓴 시간 − 이 값` 을 천장으로 한다.
 *
 * 25s → **35s** (2026-09-15 검증 지적). 25s 면 최악 총합이 292s 라 300s 까지
 * 마진이 8s 뿐이었다 — 감시 최악 ~17s 추정이 조금만 틀려도 그대로 타임아웃이다.
 * 35s 로 올려도 **평시 동기화 예산은 그대로다**: min(250, 300−2−35=263) = 250.
 * 줄어드는 것은 관제가 예산을 다 쓴 최악 경로뿐이다(230s → 220s, 총합 282s).
 */
const WATCH_SAFETY_MS = 35_000;
/**
 * **선행** 회차 관제에 떼어 주는 고정 예산(ms). 관제는 DB 5문장 tx 라 실측
 * 1.7s(2026-09-10 프로덕션)면 끝나지만, `SET LOCAL statement_timeout` 이 문장마다
 * 걸려 최악은 훨씬 크다 — 그래서 벽시계 예산을 넘겨 눌러 잡는다
 * (`lib/summary/cycle-control.ts` 의 `CYCLE_CONTROL_BUDGET_MS` 주석이 정본).
 *
 * 이 값은 동기화 예산에서 그대로 빠진다. 즉 최악 배분은
 * 관제 45s + 동기화 min(250s, 300−45−35=220s) + 감시 ~17s ≈ 282s < 300s 다.
 * 평시(관제 ~2s)에는 동기화가 250s 상한을 그대로 받는다.
 *
 * ⚠️ 이 예산은 **하드 월클럭으로도 집행된다**(`Promise.race`, controlCycles 참조).
 * 관제가 행업하면 예산만으로는 sync 가 굶는다 — 예산은 관제가 스스로 볼 때만
 * 유효하고, 그 전제가 깨지는 경로(DB 커넥션 획득 대기 등)가 실제로 있다.
 */
const CYCLE_CONTROL_LEAD_MS = 45_000;

interface OrphanWatchReport {
  checked: boolean;
  mode?: "mock" | "live";
  count?: number;
  graceHeld?: number;
  alert?: string;
  issue?: number;
  error?: string;
}

// 감시는 동기화 성패와 **독립**이어야 한다. 동기화가 예산 초과로 죽어도 고아는
// 계속 보여야 하고, 반대로 감시가 죽어서 동기화 결과가 사라져도 안 된다.
//
// 시간 예산: 동기화는 스스로 SYNC_BUDGET_MS(250s)에서 멈추고 maxDuration 은
// 300s 다 → 감시에 남는 여유는 최소 50s. 감시 **하나**의 최악 경로(열린 이슈가
// 없어 생성 전 재확인 폴링을 예산 15s 끝까지 쓰는 경우)는 ~17s 다.
//
// ⚠️ 2026-08-30: 감시가 **둘**이 됐다(orphan + truncation). 순차로 돌리면 최악이
// ~34s 가 되어 여유 50s 중 16s 만 남는다 — 아직 들어가지만 마진이 절반으로
// 준다. 그래서 둘을 `Promise.all` 로 **병렬** 실행해 최악을 ~17s 로 유지한다
// (둘은 감지원도 이슈 제목도 달라 서로 간섭하지 않는다).
//
// **감시를 하나 더 붙이는 사람에게**: 병렬이므로 최악은 여전히 ~17s 지만,
// 그건 GitHub API 가 동시 요청을 직렬화하지 않는다는 전제 위에 있다. 셋째를
// 붙일 때는 이 세 상수(SYNC_BUDGET_MS · maxDuration · 폴링 예산)를 **함께**
// 다시 계산할 것.
//
// ⚠️ 2026-09-10: **셋째가 붙었다 — 회차 관제(PR① A1)**. 위 지시대로 다시 계산한다.
//   · 성격이 다르다: 앞의 둘은 GitHub API 왕복이고, 관제는 **DB 한 트랜잭션**이다.
//     경합 자원이 겹치지 않으므로 병렬 최악은 여전히 `max(감시 ~17s, 관제 상한)` 이다.
//   · 실측(2026-09-10 프로덕션): 읽기 전용 드라이런 판정 826 ms · 전체 1,734 ms.
//     **적용 경로는 추정이 아니라 실측이다** — 롤백 테스트에서 적용 1회 ≈ 2~3 s
//     (`summary-cycles.apply.int.test.ts`, 3 테스트 17.6 s).
//
// ⚠️ 2026-09-10 T16 검증 6-① 정정 — **DB 상한만으로는 이 계산이 안 선다.**
//   처음엔 "관제 최악 15s" 로 적었는데 틀렸다:
//     · `SET LOCAL statement_timeout` 은 tx 가 아니라 **문장마다** 걸린다
//       → 적용 5문장 × 15s = **75s**
//     · 파티션 경로의 문장 천장은 **120s**(ANALYZE 63표·562 MB 대비)
//     합계 195s. 250s 를 이미 쓴 뒤라면 300s 를 넘겨 **라우트 전체가 죽는다.**
//   → 그래서 관제에 **벽시계 예산**을 넘긴다(`budgetMs`). 관제는 그 예산으로
//     실제 `statement_timeout` 을 눌러 잡고, 모자라면 단계를 건너뛴다(멱등이라
//     다음 틱이 이어받는다).
//
// ⚠️ 2026-09-14 (이슈 #262) — **관제를 병렬 뒷단에서 선행 단독 실행으로 옮겼다.**
//   뒷단에 두면 앞단(동기화)이 죽을 때 같이 죽는다. 실측: 동기화가 16틱 연속
//   300s 타임아웃 → 관제 **0회 실행** → 회차 8 fleet_visible 5시간 정지.
//   이제 예산 배분은 한 줄로 고정된다:
//     관제 = min(CYCLE_CONTROL_LEAD_MS 45s, 남은 시간 − WATCH_SAFETY_MS) · 하드 race
//     동기화 = min(MIRROR_SYNC_BUDGET_MS 250s, 남은 시간 − WATCH_SAFETY_MS)
//     감시 둘 = 병렬 최악 ~17s (WATCH_SAFETY_MS 35s 안)
//   → **넷째를 붙이려면** 이 세 줄을 함께 다시 계산할 것. 남은 시간에서 빼는
//     구조라 상수를 하나 더 늘리면 동기화 예산이 자동으로 줄어든다.
async function watchOrphans(): Promise<OrphanWatchReport> {
  try {
    const scan = await scanOrphanProjects();
    if (scan.mode === "mock") {
      // mock 에서는 미러 없음이 정상 — 재지 않는다(통과가 아님).
      return { checked: false, mode: "mock" };
    }
    const base = {
      checked: true,
      mode: "live" as const,
      count: scan.orphans.length,
      graceHeld: scan.graceHeld,
    };
    if (scan.orphans.length === 0) return { ...base, alert: "none" };

    // 채널이 배선 안 됐으면 **조용히 넘어가지 않는다** — 미배선은 통과가 아니다
    // (alert-routing 룰 4). 런타임 로그에 남기고 응답에도 그대로 싣는다.
    if (!isIssueSinkConfigured()) {
      console.error(
        `[orphan-watch] 고아 프로젝트 ${scan.orphans.length}건 감지 — 그러나 알림 채널 미배선(GITHUB_ALERT_TOKEN/GITHUB_ALERT_REPO). ids=${scan.orphans.map((o) => o.id).join(",")}`,
      );
      return { ...base, alert: "unconfigured" };
    }

    const res = await reportIssue({
      title: ORPHAN_ISSUE_TITLE,
      body: buildOrphanIssueBody(scan.orphans),
      cooldownHours: ORPHAN_ALERT_COOLDOWN_HOURS,
    });
    if (res.status === "failed") {
      console.error(`[orphan-watch] 이슈 표면화 실패: ${res.error}`);
    }
    return { ...base, alert: res.status, issue: res.issueNumber };
  } catch (err) {
    // 감시 실패가 크론을 죽이면 미러 동기화까지 같이 멈춘다.
    console.error("[orphan-watch] 판정 실패:", err);
    return {
      checked: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 조용한 절단 감시. orphan-watch 와 같은 계약이다 — 동기화 성패와 **독립**이고,
// 실패해도 크론을 죽이지 않으며, 미배선을 **통과로 치지 않는다**(룰 4).
async function watchTruncation(
  findings: TruncationFindings,
): Promise<{ checked: boolean; alert?: string; issue?: number; error?: string }> {
  try {
    if (!hasTruncation(findings)) return { checked: true, alert: "none" };
    if (!isIssueSinkConfigured()) {
      console.error(
        `[truncation-watch] 절단 감지 — 그러나 알림 채널 미배선(GITHUB_ALERT_TOKEN/GITHUB_ALERT_REPO). ` +
          `pageCap=${findings.pageCapHits.length} recheckCap=${findings.recheckCapHits.length}`,
      );
      return { checked: true, alert: "unconfigured" };
    }
    const res = await reportIssue({
      title: TRUNCATION_ISSUE_TITLE,
      body: buildTruncationIssueBody(findings),
      cooldownHours: TRUNCATION_ALERT_COOLDOWN_HOURS,
    });
    if (res.status === "failed") {
      console.error(`[truncation-watch] 이슈 표면화 실패: ${res.error}`);
    }
    return { checked: true, alert: res.status, issue: res.issueNumber };
  } catch (err) {
    console.error("[truncation-watch] 판정 실패:", err);
    return {
      checked: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface CycleControlReport {
  opened: number;
  closed: number;
  attributed: number;
  late: number;
  /** 이번 호출이 만든 주 파티션 수. `null` = 0064 미적용(함수 없음) 또는 실패. */
  partitionsCreated: number | null;
  /**
   * 파티션 선생성 실패 사유(타임아웃·락). 관제 본체와 독립이다 — 이 값이 차 있어도
   * opened/closed/attributed 는 정상 수행된 결과다(T16 검증 D2).
   */
  partitionsError: string | null;
  /** 관제를 통째로 건너뛴 사유. 표 미적용(`ledger-unavailable`) 이 정상 값이다. */
  skipped: string | null;
  errors: string[];
  ms: number;
}

// 회차 관제 — orphan/truncation 감시와 **같은 계약**이다: 미러 동기화 성패와 독립이고,
// 실패해도 크론을 죽이지 않는다. 다만 미배선을 통과로 치지 않는 감시들과 달리, 여기의
// `skipped:"ledger-unavailable"` 은 **의도된 no-op** 다 — 사실표 마이그레이션(0059)이
// 아직 안 걸린 환경에서 라우트가 500 을 내면 미러 동기화까지 함께 멈춘다.
//
// 관제 자신은 미러를 **읽기만** 한다(P5). 쓰기는 summary_cycles·summary_cycle_runs 뿐.
async function controlCycles(budgetMs: number): Promise<CycleControlReport> {
  try {
    const r = await runCycleControl({ budgetMs });
    if (r.errors.length) {
      console.error(`[cycle-control] 부분 실패: ${r.errors.join(" | ")}`);
    }
    return {
      opened: r.opened,
      closed: r.closed,
      attributed: r.attributed,
      late: r.late,
      partitionsCreated: r.partitionsCreated,
      partitionsError: r.partitionsError,
      skipped: r.skipped,
      errors: r.errors,
      ms: r.ms,
    };
  } catch (err) {
    // runCycleControl 은 스스로 삼키지만, 프로브 단계의 예외까지 여기서 막는다.
    console.error("[cycle-control] 판정 실패:", err);
    return {
      opened: 0, closed: 0, attributed: 0, late: 0,
      partitionsCreated: null, partitionsError: null, skipped: null,
      errors: [err instanceof Error ? err.message : String(err)],
      ms: 0,
    };
  }
}

/**
 * 관제에 **하드 월클럭 차단**을 씌운다 (2026-09-15 검증 지적).
 *
 * `budgetMs` 는 관제가 **스스로 볼 때만** 유효하다 — `remaining()` 검사 사이에서
 * 멈춰 있으면(DB 커넥션 획득 대기, 프로브 행업) 예산은 아무것도 집행하지 않는다.
 * 관제를 sync **앞**으로 옮긴 이상 그 행업은 곧 sync 기아다: 이번 사고에서 관제가
 * 굶었듯, 이번엔 반대로 sync 가 굶는다.
 *
 * 그래서 예산이 지나면 **보고만 끊고 진행한다.** 진행 중인 관제 tx 자체는 여기서
 * 취소할 수 없지만(JS 프로미스는 취소 불가) DB 쪽 `lock_timeout`/`statement_timeout`
 * 이 걸려 있으므로 방치해도 표를 오래 잡지 않는다. 결과는 `skipped:"lead-timeout"`
 * 으로 표면화한다 — 조용히 0 으로 보고하면 "관제가 돌았는데 할 일이 없었다" 와
 * 구분되지 않는다.
 */
async function controlCyclesWithDeadline(budgetMs: number): Promise<CycleControlReport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CycleControlReport>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          opened: 0, closed: 0, attributed: 0, late: 0,
          partitionsCreated: null, partitionsError: null,
          skipped: "lead-timeout",
          errors: [`cycle-control exceeded lead budget ${budgetMs}ms — sync 를 굶기지 않기 위해 보고를 끊고 진행한다`],
          ms: budgetMs,
        }),
      budgetMs,
    );
  });
  try {
    const r = await Promise.race([controlCycles(budgetMs), timeout]);
    if (r.skipped === "lead-timeout") {
      console.error(`[cycle-control] lead budget ${budgetMs}ms 초과 — 결과를 기다리지 않고 진행한다`);
    }
    return r;
  } finally {
    // 타이머를 남기면 함수 인스턴스가 예산만큼 더 살아 있을 수 있다.
    if (timer) clearTimeout(timer);
  }
}

export async function GET(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const denied = requireCronSecret(req);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const force = params.get("force") === "1";
  // ?maxRuns=N — partial/smoke cap (per project). e.g. force=1&maxRuns=1 re-pulls
  // just one run to verify scope→mirror category persistence before a full re-sync.
  const maxRunsRaw = params.get("maxRuns");
  const maxRuns = maxRunsRaw ? Math.max(1, Number.parseInt(maxRunsRaw, 10) || 1) : undefined;
  // ?resyncBefore=<ISO> — 강제 재싱크 워터마크. "이 시각 이후 이미 재싱크된 run 은
  // 건너뛴다" 이므로, 같은 값으로 패스를 반복하면 목록 앞쪽이 소진되며 **단조
  // 전진**한다. force 단독은 목록 앞에서부터 maxRuns 개를 매번 다시 집어 패스를
  // 반복해도 진도가 0 이다(2026-08-30 실측: 동일 파라미터 재실행 494행 중 +1).
  //
  // 잘못된 값을 조용히 무시하면 "워터마크를 걸었다고 믿는 무한 멱등 패스"가 된다
  // — 파싱 실패는 400 으로 **거절**한다.
  const resyncBeforeRaw = params.get("resyncBefore");
  let resyncBefore: Date | undefined;
  if (resyncBeforeRaw) {
    const parsed = new Date(resyncBeforeRaw);
    if (Number.isNaN(parsed.getTime())) {
      return Response.json(
        { ok: false, error: `invalid resyncBefore: ${resyncBeforeRaw}` },
        { status: 400 },
      );
    }
    resyncBefore = parsed;
  }
  // ?projectIds=<uuid>[,<uuid>…] — 이 패스가 돌 프로젝트를 좁힌다(scope project id).
  // 싱크는 기본적으로 181개 전부를 순회하고, 표준 루트 하나가 prompts 50 + runs 50
  // = 100 왕복을 `maxRuns` 와 무관하게 매번 낸다. 특정 프로젝트만 재싱크할 때는
  // 그 비용이 통째로 낭비이므로 대상을 좁힌다. **루트도 예외가 아니다** — 요청에
  // 없으면 루트도 뺀다(그게 이 파라미터의 주된 실익이다).
  //
  // 형식이 틀린 값은 조용히 무시하지 않고 **400 으로 거절**한다. 무시하면 그 id 가
  // 대상에서 빠진 채 200 이 돌아와 "돌렸다고 믿는데 안 돈" 상태가 된다 —
  // resyncBefore 와 같은 규약이다. 형식은 맞지만 대상에 없는 id 는 여기서 알 수
  // 없으므로(대상 목록은 sync 안에서 만들어진다) 응답의 `projectIdsNotFound` 로 나온다.
  const projectIdsRaw = params.get("projectIds");
  let projectIds: string[] | undefined;
  if (projectIdsRaw) {
    const parts = projectIdsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const bad = parts.filter((p) => !UUID.test(p));
    if (parts.length === 0 || bad.length > 0) {
      return Response.json(
        {
          ok: false,
          error:
            parts.length === 0
              ? "empty projectIds"
              : `invalid projectIds (not a uuid): ${bad.join(", ")}`,
        },
        { status: 400 },
      );
    }
    projectIds = parts;
  }
  // ?promptsUpdatedFrom=<ISO> — 프롬프트 조회 창을 좁혀 페이지 상한 절단을
  // 피한다(백필 회수용). 잘못된 값은 조용히 무시하지 않고 400 으로 거절한다 —
  // 무시하면 "창을 걸었다고 믿는데 실제로는 최신 5,000 만 보는" 패스가 된다.
  const puf = params.get("promptsUpdatedFrom");
  if (puf && Number.isNaN(new Date(puf).getTime())) {
    return Response.json(
      { ok: false, error: `invalid promptsUpdatedFrom: ${puf}` },
      { status: 400 },
    );
  }
  // ?runsSince=<ISO>&runsUntil=<ISO> — 런을 started_at 창으로 좁힌다(sync.ts 의 기존
  // opts 노출). 목록이 newest-first 라 `maxRuns` 만으로는 "특정 회차의 런"을 집을 수
  // 없다 — 2026-09-08 실증: 케이던스가 큐 런을 계속 만들어 maxRuns=75 로도 멘션 있는
  // 런에 닿지 못했다. 잘못된 값은 promptsUpdatedFrom 과 같은 이유로 400.
  const parseWindow = (name: string): Date | undefined | Response => {
    const raw = params.get(name);
    if (!raw) return undefined;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return Response.json({ ok: false, error: `invalid ${name}: ${raw}` }, { status: 400 });
    }
    return d;
  };
  const runsSince = parseWindow("runsSince");
  if (runsSince instanceof Response) return runsSince;
  const runsUntil = parseWindow("runsUntil");
  if (runsUntil instanceof Response) return runsUntil;
  // 상한. from 만으로는 절단이 안 풀린다 — 그 이유는 PromptsQuery.updated_to 주석.
  const put = params.get("promptsUpdatedTo");
  if (put && Number.isNaN(new Date(put).getTime())) {
    return Response.json(
      { ok: false, error: `invalid promptsUpdatedTo: ${put}` },
      { status: 400 },
    );
  }
  if (put && !puf) {
    return Response.json(
      { ok: false, error: "promptsUpdatedTo requires promptsUpdatedFrom" },
      { status: 400 },
    );
  }
  // ── ① 회차 관제 (선행) ────────────────────────────────────────────────
  // 동기화보다 **먼저** 돈다. 근거는 파일 헤더의 실행 순서 주석(2026-09-14 사고).
  // 남은 요청 시간을 넘지 않는 고정 예산이고, 던져도 라우트를 죽이지 않는다.
  const cycleControl = await controlCyclesWithDeadline(
    Math.max(
      0,
      Math.min(
        CYCLE_CONTROL_LEAD_MS,
        MAX_DURATION_MS - (Date.now() - startedAt) - WATCH_SAFETY_MS,
      ),
    ),
  );
  // ── ② 미러 동기화 ────────────────────────────────────────────────────
  // 예산은 **관제가 쓰고 남은 시간**에서 감시·응답 몫을 뺀 값이고, 평소 상한
  // (MIRROR_SYNC_BUDGET_MS)을 넘지 않는다. 종전엔 sync 가 250s 를 하드코딩으로
  // 가져가 관제가 어디서 시작하든 총합이 300s 를 넘을 수 있었다.
  const syncBudgetMs = Math.max(
    0,
    Math.min(
      MIRROR_SYNC_BUDGET_MS,
      MAX_DURATION_MS - (Date.now() - startedAt) - WATCH_SAFETY_MS,
    ),
  );
  const result = await syncStandardMirror({
    force,
    maxRuns,
    resyncBefore,
    projectIds,
    promptsUpdatedFrom: puf ?? undefined,
    runsSince,
    runsUntil,
    promptsUpdatedTo: put ?? undefined,
    ...(process.env.MIRROR_BULK_ENABLED === "1"
      ? { queueBulkRun: (await import("@/lib/scope/mirror/bulk-worker")).enqueueBulkRun }
      : {}),
    budgetMs: syncBudgetMs,
  });
  // Bust the per-filter aggregation cache so the freshly mirrored data shows.
  if (result.runs > 0) revalidateTag(MIRROR_AGGREGATE_TAG);
  // ── ③ 감시 둘 (병렬) ─────────────────────────────────────────────────
  // 병렬 — 근거는 watchOrphans 위 예산 주석. 순차면 최악이 두 배가 된다.
  // 절단 감시는 이번 패스 결과를 입력으로 받으므로 동기화 **뒤**여야 한다.
  const [orphanWatch, truncationWatch] = await Promise.all([
    watchOrphans(),
    watchTruncation({
      pageCapHits: result.pageCapHits,
      recheckCapHits: result.recheckCapHits,
      oversizedRuns: result.oversizedRuns,
      truncatedRuns: result.truncatedRuns,
      recheckDeferredHeavy: result.recheckDeferredHeavy,
    }),
  ]);
  return Response.json({
    ok: true,
    ...result,
    orphanWatch,
    truncationWatch,
    cycleControl,
    // 이번 패스가 동기화에 실제로 준 예산(ms) — 관제가 오래 끌면 줄어든다.
    // 타임아웃 재발 시 "예산이 실제로 얼마였나"를 로그 없이 응답에서 확인한다.
    syncBudgetMs,
    at: new Date().toISOString(),
  });
}
