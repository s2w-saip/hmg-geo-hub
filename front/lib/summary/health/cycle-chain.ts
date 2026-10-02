import "server-only";
import {
  pickGlobalCycle,
  pickWebsiteCycles,
  DEFAULT_COMPLETE_QUIET_HOURS,
} from "@/lib/db/repositories/summary-cycles";
import {
  readCycleLedger,
  readWebsiteProjectIds,
  readPendingCycles,
  readCycleWaitingSince,
  readGapExcludedCycles,
  countViewableCycles,
  readStaleCycles,
  readUrlHitsGaps,
  type UrlHitsGapRow,
  type StaleCycleRow,
  type CycleLedgerRow,
  type GapExcludedGroup,
} from "@/lib/db/repositories/summary-cycle-health";
import { VIEW_ANCHOR_DELAY, type SummarySurface } from "@/lib/summary/generate/types";
import { ANALYSIS_GAP_MAX } from "@/lib/summary/read/analysis-gap";
import { generatorPicksGap } from "@/lib/summary/read/cycle-set";
import { dropFleetLosers } from "@/lib/summary/fleet-visible";
import { getStandardRootId } from "@/lib/scope/result-adapter";
import { isMockMode } from "@/lib/scope";
import type { AlertSeverity } from "@/lib/alerts/slack";
import { websiteOwnedUnitEnabled } from "@/lib/scope/website-owned-unit-flag";
import {
  readAnchorGapGroups,
  type AnchorGapGroup,
} from "@/lib/db/repositories/scope-answer-anchors-catchup";

// ════════════════════════════════════════════════════════════════════════════
// 회차 사슬 감시 — 마감 → 생성 → 노출 이 어디서 끊겼는가 (2026-09-16)
// ════════════════════════════════════════════════════════════════════════════
//
// ── 왜 생겼나 (2026-09-13 사건) ────────────────────────────────────────────
// 09-13 글로벌 회차가 Overview 에 안 나온다는 **고객 신고**로 발견됐다. 사슬 세
// 마디가 전부 조용히 멈춰 있었다:
//   ① 마감 — 정온 가드(`DEFAULT_COMPLETE_QUIET_HOURS` 36h)가 아직 안 풀려 회차가
//      열린 채였다. 정상 동작이지만 아무도 그 대기를 안 봤다.
//   ② 생성 — `hmg-summary.timer` 가 **disabled** 였다. 마지막 generation 이
//      2026-09-11 10:09Z, 그 뒤 4.5일 동안 0건.
//   ③ 노출 — 결국 사람이 눈으로 발견해 `--cycle` 강제 생성으로 복구했다.
// 그리고 7/07·7/11·7/19·7/24 글로벌 회차 4건은 `analysis_gap_ratio` 0.167~0.224 가
// 임계 0.05 를 넘어 **영구 미발행**인데 그 사실이 아무 데도 기록돼 있지 않았다.
//
// 즉 결함은 "자동 추진력이 없다" 만이 아니라 **"아무도 그 지표를 안 본다"** 였다.
// 이 모듈이 그 눈이다.
//
// ── 술어를 새로 쓰지 않는다 ───────────────────────────────────────────────
// 이 파일에는 **회차 선택 술어가 한 줄도 새로 없다.** 감시가 화면과 다른 것을
// 보는 순간 감시는 거짓말을 시작한다 — 이번 사건의 교훈이 정확히 그것이다.
//   · 노출 픽    = `pickGlobalCycle` · `pickWebsiteCycles` 를 **그대로 호출**한다
//                  (그 안에 `cycleViewableSql` V-2 게이트가 들어 있다)
//   · 숨김 게이트 = `cycleNotHiddenSql`          (리포지토리에서)
//   · 노출 지연  = `VIEW_ANCHOR_DELAY`           (interval 문자열 그대로, 복사 금지)
//   · 생성 대기  = `pendingCyclesSql`            (`--pending` 정본을 그대로 실행)
//   · 갭 여집합  = `generatorPicksGap`           (`isGeneratorSkipped` 와 한 명제)
//   · 중복 주    = `dropFleetLosers`             (픽·추이와 같은 함수 — 2026-09-18)
//
// ── 목적지 (alert-routing 룰) ─────────────────────────────────────────────
//   ① 노출 지체 → **Slack**      (고객 화면이 **지금** 다르다 = 라이브 이슈)
//   ② 생성 적체 → **GitHub Issue** (사람이 러너·코드를 고쳐야 해소된다)

// ── 임계값 ────────────────────────────────────────────────────────────────

/**
 * 노출 지체 판정의 **여유**(시간). 계약(`cycle_anchor_at + VIEW_ANCHOR_DELAY`)에
 * 이만큼을 더한 뒤부터 경보한다.
 *
 * ⚠️ 여유가 왜 필요한가 — **계약은 사슬이 보장하지 못한다.** 마감 (b) 의 정온
 * 가드는 앵커가 아니라 **마지막 run 의 `started_at`** 에서 36h 를 잰다. 한 회차의
 * run 은 며칠에 걸쳐 도착하므로(2026-09-10 실측: 글로벌 8/31 도착 분산 39.9h ·
 * 웹사이트 9/4 분산 98.9h), 마감 시각은 "앵커 + 작은 상수" 로 묶이지 않는다.
 * 여유 없이 계약 경계에서 바로 울리면 **정상 진행 중인 회차마다 운다.**
 *
 * 값의 유도 — 임의의 "+2일" 이 아니라 사슬의 두 지연을 더한 것이다:
 *   정온 가드 `DEFAULT_COMPLETE_QUIET_HOURS` 36h  (마감이 늦어질 수 있는 설계상 상한)
 *   + 운영 여유 12h                                (30분 폴링 · 생성 소요 · 1회 재시도)
 *   = 48h
 * 정온 가드 값이 바뀌면 이 여유도 **자동으로 따라간다** — 리터럴을 복사하지 않는
 * 이유다. 상수 하나를 고치면 마감과 감시가 같이 움직인다.
 */
export const VIEW_LAG_GRACE_HOURS = DEFAULT_COMPLETE_QUIET_HOURS + 12;

/**
 * 생성 대기 적체 경보 임계(시간). 러너 타이머는 30분 폴링이므로 6h = **틱 12회
 * 연속 미소화**다. 일시적 실패(1~2틱)를 걸러 내면서 "안 돌고 있다" 는 빨리 잡는다.
 */
export const GENERATION_BACKLOG_HOURS = 6;

/**
 * 같은 적체가 이 시간을 넘으면 등급을 올린다. 24h = 틱 **48회** 연속 미소화 =
 * 일시적 실패로 설명되지 않는다(= 2026-09-13 사건의 모습: 4.5일 0건).
 */
export const GENERATION_BACKLOG_URGENT_HOURS = 24;

/**
 * `--pending` 스캔 상한(회차 **묶음** 수). `generate-cycle.ts --max-cycles` 가
 * 받는 범위(1~1000)의 최댓값이다. 소진되면 `saturated` 로 표시한다 — 조용히
 * 잘린 수를 보고하면 적체 규모를 과소평가하게 된다.
 */
export const PENDING_SCAN_LIMIT = 1000;

/** GitHub Issue 쿨다운 — orphan·truncation 감시와 같은 값(하루 2회). */
export const GENERATION_BACKLOG_COOLDOWN_HOURS = 12;

export const GENERATION_BACKLOG_ISSUE_TITLE =
  "[summary] 생성 대기 적체 — 마감된 회차가 만들어지지 않고 있다";

export const VIEW_LAG_ALERT_TITLE = "회차 노출 지체";

/**
 * 감시가 보는 표면 — **생성기가 만드는 표면과 정확히 같다**(`SummarySurface`).
 *
 * ⚠️ 원장에는 `surface='project'` 회차도 산다(2026-09-16 실측 121건). 그 표면은
 * 사실표 생성기의 대상이 아니라 활성 generation 이 **0건**이다 — 모수에 넣는 순간
 * "생성 대기 105건" 이 영구히 뜬다. 타입이 그것을 막고 있고(`SummarySurface` 는
 * global·website 뿐), 리포지토리 주석이 그 이유를 적어 둔다. 표면을 늘리려면
 * 생성기가 먼저 그 표면을 만들어야 한다.
 */
const SURFACES: SummarySurface[] = ["global", "website"];
const HOUR_MS = 3_600_000;

// ── 감시 ① 노출 지체 ──────────────────────────────────────────────────────

export interface ViewLagSurfaceVerdict {
  surface: SummarySurface;
  /** 원장에서 **노출될 예정인** 회차 중 가장 최신 앵커. 없으면 null. */
  latestAnchorAt: string | null;
  /**
   * **기준선을 만든 회차**의 앵커 = 서빙 안 된 것 중 가장 오래된 회차.
   * null 이면 밀린 회차가 없다. 경보 본문은 이것을 보여 줘야 한다 —
   * "최신이 안 나온다" 가 아니라 "이 회차가 기한을 넘겼다" 가 사실이다.
   */
  deadlineAnchorAt: string | null;
  /** `deadlineAnchorAt` 의 계약 노출 시각 = 앵커 + `VIEW_ANCHOR_DELAY[표면]`. */
  dueAt: string | null;
  /** 여유까지 더한 경보 기준선. */
  deadlineAt: string | null;
  /** 읽기 경로(`pick*`)가 **실제로** 고른 회차의 앵커. null = 아무것도 못 골랐다. */
  servedAnchorAt: string | null;
  /**
   * 고른 회차보다 최신인, 노출 예정 회차의 수 — **묶음 단위**로 센다.
   * 웹사이트는 함대 주 하나가 한 회차다(행 수로 세면 한 주 밀림이 95로 잡힌다).
   */
  cyclesBehind: number;
  /** 기준선을 넘긴 시간. 안 넘겼으면 null. */
  overdueHours: number | null;
  severity: AlertSeverity;
  /** 판정을 못 한 이유(루트 미설정 등). null 이면 판정했다. */
  skipped: string | null;
}

export interface ViewLagVerdict {
  checked: boolean;
  mode?: "mock" | "live";
  surfaces: ViewLagSurfaceVerdict[];
  severity: AlertSeverity;
  error?: string;
}

/**
 * 이 회차가 **언젠가 노출될 예정인가.**
 *
 * `latestAnchorAt` 의 모수를 정하는 술어다. 여기에 "영원히 발행되지 않을 회차" 가
 * 섞이면 감시가 **영구히** 운다 — 7월 글로벌 4건(갭 0.167~0.224)이 정확히 그것이고,
 * 읽기 계층도 같은 이유로 그 회차들을 창에서 뺀다(`isGeneratorSkipped`).
 * 대신 그 4건은 **감시 ② 본문에 건수로** 나온다 — 조용히 사라지지 않게.
 */
export function expectedToBecomeViewable(r: CycleLedgerRow): boolean {
  // 이미 만들어져 있다 — 남은 것은 노출 시각뿐이다.
  if (r.hasActiveGeneration) return true;
  // 아직 수집 중이거나 만드는 중 — 닫히면/끝나면 만들어진다.
  // ⚠️ `open` 을 빼면 안 된다. "회차가 열렸는데 영영 안 닫힌다" 가 2026-09-13
  //    사건의 첫 마디였고, 열린 회차는 갭이 `NULL` 이라 갭 술어만으로는 빠진다.
  if (r.status === "open" || r.status === "generating") return true;
  // 그 밖(= `closed`)은 생성기가 뽑을 수 있을 때만. `generatorPicksGap` 이
  // `--pending` 갭 조각의 3VL 정본이다(갭 `null` 은 false).
  return generatorPicksGap(r.analysisGapRatio);
}

/** 읽기 경로가 고른 회차 — 픽 함수를 **그대로** 부른다. */
export interface ServedCycle {
  /** 표시용 앵커(사람이 읽는 값). */
  anchor: string | null;
  /** 비교용 묶음 키 — 원장 행의 `groupKey` 와 같은 축이어야 한다. */
  groupKey: string | null;
  skipped: string | null;
}

/**
 * 픽의 `null` 을 해석한다 — **"고를 게 없다" 와 "조회가 죽었다" 는 다른 명제다.**
 *
 * 픽 함수들은 `catch → null` 이다. 화면에는 그 자세가 옳다(모르면 미러 폴백).
 * 감시에는 아니다: 그대로 쓰면 DB 순간 오류가 곧바로 **긴급 2** 로 Slack 에 나간다
 * (2026-09-16 독립 검증 실측 `overdueHours:384, severity:2`).
 *
 * 그래서 `null` 을 받으면 **던지는** 프로브(`countViewableCycles`)를 한 번 더 낸다:
 *   · 프로브가 던진다  → DB 가 아프다. 판정을 접는다(`skipped`, 경보 아님).
 *   · 프로브가 답한다  → DB 는 멀쩡하고, 픽의 `null` 은 진짜 "고를 게 없다" 다.
 *
 * 남는 창(픽 실패 직후 프로브 성공)은 수 ms 이고, 그때도 프로브가 답했다는 것은
 * 그 순간 실제로 서빙 상태를 판정할 수 있었다는 뜻이다.
 */
async function resolveNullPick(
  surface: SummarySurface,
): Promise<ServedCycle> {
  try {
    await countViewableCycles(surface);
  } catch {
    return { anchor: null, groupKey: null, skipped: "pick-unavailable" };
  }
  return { anchor: null, groupKey: null, skipped: null };
}

async function servedCycle(surface: SummarySurface): Promise<ServedCycle> {
  if (surface === "global") {
    const rootId = getStandardRootId();
    // 루트가 없으면 글로벌 화면 자체가 성립하지 않는다 — 판정 대상이 아니다.
    if (!rootId) return { anchor: null, groupKey: null, skipped: "no-root-project" };
    const pick = await pickGlobalCycle(rootId);
    if (!pick) return resolveNullPick("global");
    // 글로벌은 앵커가 곧 묶음 키다. 축은 리포지토리의 `ISO_UTC` 와 맞춰져 있다
    // (`cycleAnchorAt` 은 `toISOString()` 산출물이다 — 같은 형식).
    return { anchor: pick.cycleAnchorAt, groupKey: pick.cycleAnchorAt, skipped: null };
  }
  let ids: string[];
  try {
    ids = await readWebsiteProjectIds();
  } catch {
    // 프로젝트 목록조차 못 읽으면 판정 불가다 — 통과가 아니라 접는다.
    return { anchor: null, groupKey: null, skipped: "pick-unavailable" };
  }
  if (ids.length === 0) {
    return { anchor: null, groupKey: null, skipped: "no-website-projects" };
  }
  const picked = await pickWebsiteCycles(ids);
  // null = 회차 0개 · §6-1 규칙 1 위반(한 프로젝트가 한 주에 2회차) · **조회 실패**.
  // 마지막 경우를 걸러 내는 것이 `resolveNullPick` 이다.
  if (!picked) return resolveNullPick("website");
  const anchors = picked.cycles.map((c) => c.cycleAnchorAt).sort();
  // 함대 픽은 한 주 안에서만 나온다(`wk` CTE) — 주가 곧 묶음 키다.
  const week = picked.cycles[0]?.cycleWeek ?? null;
  return { anchor: anchors.at(-1) ?? null, groupKey: week, skipped: null };
}

/** 순수 판정 — DB 를 안 본다(테스트가 여기를 직접 때린다). */
export function judgeViewLagSurface(
  surface: SummarySurface,
  rows: CycleLedgerRow[],
  served: ServedCycle,
  now: Date,
): ViewLagSurfaceVerdict {
  const base = { surface, servedAnchorAt: served.anchor, skipped: served.skipped };
  const blank = {
    ...base,
    latestAnchorAt: null, deadlineAnchorAt: null, dueAt: null, deadlineAt: null,
    cyclesBehind: 0, overdueHours: null, severity: 0 as AlertSeverity,
  };
  if (served.skipped) return blank;
  // rows 는 앵커 내림차순이다(리포지토리가 그렇게 낸다).
  // **같은 주의 중복 패자는 기대 집합이 아니다**(2026-09-18). 픽이 그 주의 대표를 내므로
  // (`pickGlobalCycle`), 접지 않으면 중복 주마다 "한 회차 밀림" 이 상시로 잡힌다 —
  // 화면은 정상인데 Slack 이 운다. 규칙은 픽·추이와 **같은 함수**다(규칙 두 벌 금지).
  //
  // 글로벌에만 건다: 웹사이트 묶음 키는 이미 `cycle_week` 라 패자가 대표와 같은 그룹에
  // 흡수돼 판정에 영향이 0 이고(`readCycleLedger` 머리 주석), 그쪽 그룹을 여기서 주 단위로
  // 접으면 관제 파티션(`(프로젝트, 주)`)보다 거칠어져 표시값만 흔들린다.
  // 대표가 하나도 없는 주는 `dropFleetLosers` 가 통째로 남긴다 = 병리는 여전히 보인다.
  // 그룹 키는 관제 파티션(`(surface, project_id, cycle_week)`)에서 표면을 뺀 것이다 —
  // 읽기 쪽 `cycle-set.ts::fleetGroupOf` 와 같은 키. 주만 쓰면 같은 주 **다른 프로젝트**의
  // 대표가 이 프로젝트의 패자를 지운다(글로벌은 루트 하나뿐이라 오늘은 차이가 없지만,
  // 키가 갈린 채로 두면 다음에 이 함수를 재사용하는 표면에서 조용히 틀린다).
  const candidates = surface === "global"
    ? dropFleetLosers(rows, (r) => `${r.projectId}|${r.cycleWeek}`, (r) => r.fleetVisible)
    : rows;
  const expected = candidates.filter(expectedToBecomeViewable);
  const latest = expected[0];
  // 원장이 비었거나 전부 영구 미발행 — 이 감시가 답할 질문이 아니다.
  if (!latest) return blank;

  // **묶음 단위**로 센다. 웹사이트는 함대 주 하나가 한 회차라, 행으로 세면
  // 한 주 밀림이 95로 잡혀 등급이 언제나 2가 된다.
  // 키는 둘 다 정렬 가능한 ISO 문자열이라 문자열 비교로 시간 순서가 나온다
  // (형식 일치는 리포지토리의 `ISO_UTC` 가 보장한다 — 축이 갈리면 비교가 뒤집힌다).
  const servedKey = served.groupKey;
  const behind = expected.filter((r) => servedKey === null || r.groupKey > servedKey);
  const cyclesBehind = new Set(behind.map((r) => r.groupKey)).size;

  // ⚠️⚠️ 기준선은 **가장 오래된 미서빙 회차**에서 잰다 — `latest` 가 아니다.
  //
  // 초판은 `latest.dueAt` 을 썼고, 그것은 **더 나쁜 상태가 경보를 끄는** 결함이었다
  // (2026-09-16 독립 검증). 새 회차가 열리면 기준선이 미래로 밀려, 이미 기한을
  // 한참 넘긴 이전 회차의 경보가 조용히 꺼진다:
  //     2주 밀림 → overdue null · severity 0   ← 무음
  //     1주 밀림 → overdue 48.4h · severity 1  ← 경보
  // 주간 케이던스에서는 다음 회차가 열리는 순간 며칠간 침묵한다는 뜻이다.
  //
  // 가장 오래된 미서빙 회차에서 재면 등급이 **단조**가 된다: 회차가 더 밀릴수록
  // 기준선은 과거로만 움직이므로 경보가 약해질 수 없다.
  // `cycle-chain.test.ts` 가 단조성 자체를 가드로 단언한다.
  const deadlineBasis = behind.reduce<CycleLedgerRow | null>(
    (oldest, r) =>
      oldest === null || Date.parse(r.dueAt) < Date.parse(oldest.dueAt) ? r : oldest,
    null,
  );
  // 밀린 것이 없으면 기준선이 없다 — 표시는 최신 회차 것으로 채운다(PASS 경로).
  const basis = deadlineBasis ?? latest;
  const deadlineMs = Date.parse(basis.dueAt) + VIEW_LAG_GRACE_HOURS * HOUR_MS;
  const common = {
    ...base,
    latestAnchorAt: latest.cycleAnchorAt,
    /** 기준선을 만든 회차의 앵커 — 어느 회차가 기한을 넘겼는지 사람이 알아야 한다. */
    deadlineAnchorAt: deadlineBasis ? deadlineBasis.cycleAnchorAt : null,
    dueAt: basis.dueAt,
    deadlineAt: new Date(deadlineMs).toISOString(),
    cyclesBehind,
  };
  // 최신을 내고 있으면 기한과 무관하게 PASS.
  if (cyclesBehind === 0) return { ...common, overdueHours: null, severity: 0 };
  // 아직 여유 안 — 사슬이 도는 중이다. 정상.
  const overdueMs = now.getTime() - deadlineMs;
  if (overdueMs <= 0) return { ...common, overdueHours: null, severity: 0 };

  // 등급 근거 (alert-routing 룰 6 — 상시 재발 신호를 매번 적색으로 내지 않는다):
  //   1(주의) — 한 회차 밀렸다. 화면은 **직전 회차를 그대로 내는** 설계된 폴백
  //             상태다(D-1(2)). 값이 틀린 것이 아니라 낡았다.
  //   2(긴급) — ① 아무것도 못 골랐다(회차 폴백조차 못 해 전 화면이 미러로 떨어진다)
  //             또는 ② 두 회차 이상 밀렸다(고객이 2주 이상 낡은 값을 보고 있다).
  const severity: AlertSeverity =
    served.anchor === null || cyclesBehind >= 2 ? 2 : 1;
  return {
    ...common,
    overdueHours: Math.round((overdueMs / HOUR_MS) * 10) / 10,
    severity,
  };
}

/**
 * 감시 ① — 표면별 "최신 회차 앵커" 대 "읽기 경로가 실제로 고르는 앵커".
 * 절대 throw 하지 않는다 — 감시 실패가 호출자를 죽이면 안 된다.
 */
export async function scanViewLag(now: Date = new Date()): Promise<ViewLagVerdict> {
  // mock 에서는 회차 원장이 없는 것이 정상이다 — **재지 않는다**(통과가 아니다).
  if (isMockMode()) return { checked: false, mode: "mock", surfaces: [], severity: 0 };
  try {
    const surfaces: ViewLagSurfaceVerdict[] = [];
    for (const surface of SURFACES) {
      const [rows, served] = await Promise.all([
        readCycleLedger(surface),
        servedCycle(surface),
      ]);
      surfaces.push(judgeViewLagSurface(surface, rows, served, now));
    }
    const severity = surfaces.reduce<AlertSeverity>(
      (max, s) => (s.severity > max ? s.severity : max),
      0,
    );
    return { checked: true, mode: "live", surfaces, severity };
  } catch (err) {
    return {
      checked: false, surfaces: [], severity: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildViewLagAlertBody(v: ViewLagVerdict): string {
  const lines: string[] = [];
  for (const s of v.surfaces) {
    if (s.severity === 0) continue;
    lines.push(
      `· ${s.surface}: 화면은 ${s.servedAnchorAt ?? "(회차 없음 — 미러 폴백)"} 회차를 내고 있는데 ` +
        `원장의 최신은 ${s.latestAnchorAt} 다 (${s.cyclesBehind}회차 밀림).`,
    );
    lines.push(
      `  기한을 넘긴 회차: ${s.deadlineAnchorAt} (밀린 것 중 가장 오래된 것) · ` +
        `계약 노출일 ${s.dueAt} · 여유 ${VIEW_LAG_GRACE_HOURS}h 포함 기준선 ${s.deadlineAt} · ` +
        `${s.overdueHours}h 초과. (노출 지연 ${VIEW_ANCHOR_DELAY[s.surface]})`,
    );
  }
  lines.push("");
  lines.push("시각은 전부 UTC (KST = +9h).");
  lines.push(
    "볼 곳: 러너 `systemctl status hmg-summary.timer` · `journalctl -u hmg-summary` · " +
      "원장 `summary_cycles`(status · active_generation_id · view_anchor_at).",
  );
  return lines.join("\n");
}

// ── 감시 ② 생성 대기 적체 ─────────────────────────────────────────────────

export interface BacklogCycle {
  cycleId: string;
  surface: SummarySurface;
  anchorAt: string;
  /** 대기 시작 시각 = `closed_at`(없으면 `created_at`). */
  since: string;
  ageHours: number;
}

export interface BacklogVerdict {
  checked: boolean;
  mode?: "mock" | "live";
  /** `--pending` 이 지금 뽑을 회차 전량. */
  pendingTotal: number;
  /** 그중 임계를 넘겨 적체로 판정된 것(오래된 순). */
  aged: BacklogCycle[];
  oldestAgeHours: number | null;
  /**
   * **둘째 술어** — 마감 후 늦은 run 이 붙었는데 이미 발행된 회차 (F7, 2026-09-16).
   * 두 감시의 사각지대였다: 발행돼 있어 노출 지체는 PASS 이고, 활성 generation 이
   * 있어 `--pending` 에서도 빠진다. 그 사이 **고객 화면에는 낡은 값이 떠 있다.**
   */
  stale: Array<StaleCycleRow & { ageHours: number }>;
  /** 갭 초과·갭 미상으로 **영원히 안 뽑히는** 회차. 경보 대상은 아니나 함께 표기한다. */
  gapExcluded: GapExcludedGroup[];
  /** 스캔 상한 소진 — 실제 적체가 더 클 수 있다. */
  saturated: boolean;
  severity: AlertSeverity;
  error?: string;
}

export async function scanGenerationBacklog(
  now: Date = new Date(),
): Promise<BacklogVerdict> {
  if (isMockMode()) {
    return {
      checked: false, mode: "mock", pendingTotal: 0, aged: [], stale: [],
      oldestAgeHours: null, gapExcluded: [], saturated: false, severity: 0,
    };
  }
  try {
    // `--pending` 정본을 그대로 부른다. 감시가 생성기와 다른 집합을 보면
    // "감시는 우는데 생성기는 뽑을 게 없다"(또는 그 반대)가 된다.
    const pending = [];
    let saturated = false;
    for (const surface of SURFACES) {
      const rows = await readPendingCycles({
        surface, gapMax: ANALYSIS_GAP_MAX, limit: PENDING_SCAN_LIMIT,
      });
      pending.push(...rows);
      const groups = new Set(
        rows.map((r) => (surface === "website" ? r.cycle_week : r.cycle_anchor_at)),
      );
      if (groups.size >= PENDING_SCAN_LIMIT) saturated = true;
    }

    const sinceById = await readCycleWaitingSince(pending.map((r) => r.cycle_id));
    const aged: BacklogCycle[] = [];
    for (const r of pending) {
      const since = sinceById.get(r.cycle_id);
      if (!since) continue;
      const ageHours = (now.getTime() - Date.parse(since)) / HOUR_MS;
      if (ageHours < GENERATION_BACKLOG_HOURS) continue;
      aged.push({
        cycleId: r.cycle_id,
        surface: r.surface,
        anchorAt: r.cycle_anchor_at,
        since,
        ageHours: Math.round(ageHours * 10) / 10,
      });
    }
    aged.sort((a, b) => b.ageHours - a.ageHours);

    // 둘째 술어 — 발행됐지만 늦은 run 이 붙은 회차(F7).
    const stale = (await readStaleCycles(SURFACES)).map((r) => ({
      ...r,
      ageHours:
        Math.round(((now.getTime() - Date.parse(r.staleSince)) / HOUR_MS) * 10) / 10,
    }));

    const gapExcluded = await readGapExcludedCycles(ANALYSIS_GAP_MAX, SURFACES);
    const oldestAgeHours = aged[0]?.ageHours ?? null;
    // 등급 근거 (alert-routing 룰 6):
    //   적체 6h  = 틱 12회 미소화(일시 실패로 설명 가능)        → 1(주의)
    //   적체 24h = 틱 48회 미소화(= 타이머가 죽어 있다)          → 2(긴급)
    //   stale    = **항상 1(주의)**. 회차는 발행돼 있고 화면에 값이 **있다** —
    //              틀린 것이 아니라 늦은 run 이 안 섞인 값이고, 해소는 운영자의
    //              재생성이다. 2 는 "생성이 아예 안 돈다" 에 남겨 둔다. 이 신호는
    //              상시 재발형(늦은 run 은 늘 온다)이라 적색으로 내면 긴급이 묻힌다.
    const backlogSeverity: AlertSeverity =
      oldestAgeHours === null
        ? 0
        : oldestAgeHours >= GENERATION_BACKLOG_URGENT_HOURS
          ? 2
          : 1;
    const severity: AlertSeverity = Math.max(
      backlogSeverity,
      stale.length > 0 ? 1 : 0,
    ) as AlertSeverity;
    return {
      checked: true, mode: "live", pendingTotal: pending.length, aged, stale,
      oldestAgeHours, gapExcluded, saturated, severity,
    };
  } catch (err) {
    return {
      checked: false, pendingTotal: 0, aged: [], stale: [], oldestAgeHours: null,
      gapExcluded: [], saturated: false, severity: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildGenerationBacklogIssueBody(v: BacklogVerdict): string {
  const grade = v.severity === 2 ? "2(긴급)" : v.severity === 1 ? "1(주의)" : "0(PASS)";
  const lines: string[] = [
    `마감된(\`status='closed'\`) 회차가 **활성 generation 없이** ${GENERATION_BACKLOG_HOURS}시간 넘게 남아 있다.`,
    "생성기(`--pending`)가 뽑을 수 있는 회차인데 뽑히지 않았다는 뜻이다 — 러너가 안 돌거나 실패하고 있다.",
    "",
    `- 등급: **${grade}** (적체 최장 ${v.oldestAgeHours}h · ${GENERATION_BACKLOG_URGENT_HOURS}h 이상이면 2)`,
    `- \`--pending\` 대상 전량: ${v.pendingTotal}건 · 그중 임계 초과: **${v.aged.length}건**`,
    `- 늦은 run 이 붙은 발행 회차(stale): **${v.stale.length}건**`,
  ];
  if (v.saturated) {
    lines.push(`- ⚠️ 스캔 상한(${PENDING_SCAN_LIMIT} 묶음) 소진 — 실제 적체는 이보다 클 수 있다.`);
  }
  lines.push("", "## 적체 회차 (오래된 순)", "");
  lines.push("| surface | cycle_anchor_at (UTC) | 대기 시작(closed_at) | 경과 |");
  lines.push("| --- | --- | --- | --- |");
  for (const c of v.aged.slice(0, 30)) {
    lines.push(`| ${c.surface} | ${c.anchorAt} | ${c.since} | ${c.ageHours}h |`);
  }
  if (v.aged.length > 30) lines.push(`| … | (외 ${v.aged.length - 30}건) | | |`);
  if (v.aged.length === 0) lines.push("| — | 없음 | | |");

  lines.push("", "## 늦은 run 이 붙은 **발행 회차** (stale — 화면에 낡은 값이 떠 있다)", "");
  lines.push(
    "마감 뒤에 도착한 run 이 붙었는데 회차는 이미 발행·노출돼 있다. 두 감시의 사각지대였다 — " +
      "노출 지체는 `cyclesBehind=0` 으로 PASS 를 내고, 활성 generation 이 있어 `--pending` 에서도 빠진다. " +
      "해소는 그 회차 **재생성**이다(`summary:generate -- --cycle=<id> --yes`). " +
      "등급은 1(주의) 로 고정한다 — 값이 없는 것이 아니라 늦은 run 이 안 섞인 값이고, 상시 재발형이라 " +
      "적색으로 내면 진짜 긴급이 묻힌다.",
  );
  lines.push("");
  if (v.stale.length === 0) {
    lines.push("없음.");
  } else {
    lines.push("| surface | cycle_anchor_at (UTC) | stale_since (UTC) | 경과 | cycle_id |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const c of v.stale.slice(0, 30)) {
      lines.push(
        `| ${c.surface} | ${c.anchorAt} | ${c.staleSince} | ${c.ageHours}h | \`${c.cycleId}\` |`,
      );
    }
    if (v.stale.length > 30) lines.push(`| … | (외 ${v.stale.length - 30}건) | | | |`);
  }

  lines.push("", "## 이 경보에서 **제외된** 영구 미발행 회차", "");
  lines.push(
    `\`analysis_gap_ratio\` 가 임계(\`ANALYSIS_GAP_MAX\` = ${ANALYSIS_GAP_MAX})를 넘거나 ` +
      "`NULL` 인 회차는 생성기가 **영원히 안 뽑는다**. 적체가 아니므로 위 표에 없지만, " +
      "조용히 사라지는 것을 막기 위해 건수를 함께 적는다 — 이것들은 scope 분석 백필이 " +
      "와야 풀린다(읽기 계층 `isGeneratorSkipped` 와 같은 술어). 위 stale 표와 **겹치지 " +
      "않는다**: 저쪽은 활성 generation 이 있는 회차만이고, 여기는 없는 회차만이다.",
  );
  lines.push("");
  if (v.gapExcluded.length === 0) {
    lines.push("없음.");
  } else {
    lines.push("| surface | 건수 | 가장 오래된 앵커 | 가장 최신 앵커 |");
    lines.push("| --- | --- | --- | --- |");
    for (const g of v.gapExcluded) {
      lines.push(`| ${g.surface} | ${g.count} | ${g.oldestAnchorAt} | ${g.newestAnchorAt} |`);
    }
  }
  lines.push("", "---", "");
  lines.push(
    "시각은 전부 UTC (KST = +9h). 이 이슈는 회차 사슬 감시 크론" +
      "(`/api/cron/cycle-chain-watch`)이 자동으로 연다. " +
      `같은 제목의 열린 이슈가 ${GENERATION_BACKLOG_COOLDOWN_HOURS}시간 안에 갱신됐으면 코멘트를 생략한다.`,
  );
  return lines.join("\n");
}

// ── 감시 ③ 자사·타겟 URL 인용률 사실표(0081) 커버리지 (2026-09-27) ──────────
//
// 생성기 8b 단계와 백필(`generate-cycle --url-hits`)은 **비치명**이다. 실패하면 그 회차를
// 보는 웹사이트 카드가 조용히 미러 라이브 집계로 돌아간다(함대 11 s · Kia×MX 87 s). 화면은
// 값이 맞으니 사람이 못 알아챈다. 그래서 "카드가 지금 읽는 회차(최신 주, pickWebsiteCycles
// 규칙)인데 원장에 없는 generation" 을 센다. 지난 주 회차는 세지 않는다(오탐).
//
// 등급은 **항상 1(주의)**: 값이 틀린 것이 아니라 느린 것이고, 해소는 운영자의 백필이다.
// 유닛 판정 키(`X.websiteOwnedUnit`)가 꺼진 배포에서는 카드가 이 표를 **안 읽으므로**
// 판정은 하되 등급을 0 으로 둔다(울리면 노이즈).
export const URL_HITS_GAP_ALERT_TITLE = "URL 인용률 사실표 누락";

export interface UrlHitsCoverageVerdict {
  checked: boolean;
  /** 0081 미적용 = 판정 불가(통과가 아니다). */
  reason?: "mock" | "0081-missing" | "error";
  /** 카드가 이 표를 실제로 읽는 배포인가(유닛 판정 키). */
  unitOn: boolean;
  gaps: UrlHitsGapRow[];
  severity: AlertSeverity;
  error?: string;
}

export async function scanUrlHitsCoverage(): Promise<UrlHitsCoverageVerdict> {
  if (isMockMode()) return { checked: false, reason: "mock", unitOn: false, gaps: [], severity: 0 };
  try {
    const [gaps, unitOn] = await Promise.all([readUrlHitsGaps(), websiteOwnedUnitEnabled()]);
    if (gaps === null) return { checked: false, reason: "0081-missing", unitOn, gaps: [], severity: 0 };
    return { checked: true, unitOn, gaps, severity: unitOn && gaps.length > 0 ? 1 : 0 };
  } catch (err) {
    return {
      checked: false, reason: "error", unitOn: false, gaps: [], severity: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildUrlHitsGapAlertBody(v: UrlHitsCoverageVerdict): string {
  const failed = v.gaps.filter((g) => g.failed === true).length;
  const anchors = [...new Set(v.gaps.map((g) => g.anchorAt.slice(0, 10)))].sort().join(", ");
  return [
    `카드가 지금 읽는 웹사이트 회차(최신 주) ${v.gaps.length}개의 활성 generation 이 summary_url_hit_generations 에 없다 ` +
      `(회차 ${anchors}). 이 회차를 보는 자사·타겟 URL 인용률 카드는 미러 라이브 집계로 폴백한다(느림).`,
    `그중 생성기 8b 단계 실패 기록(timings.url_hits_failed=1): ${failed}개.`,
    "해소: npm run summary:generate -- --surface=website --url-hits --all-published --since=<회차 주 월요일> " +
      "(dry-run 확인 후 --yes). 캐시 무효화는 HMG_INTERNAL_BASE_URL 이 가리키는 배포 하나에만 걸린다.",
  ].join("\n");
}

// ── 감시 ④ 앵커 공백: 완료 답변인데 회차 표시(앵커 행)가 없다 (2026-09-29) ──────
//
// 앵커 축 화면은 `scope_answer_cycle_anchors` 로 답변을 읽고, 표시 행이 없는 완료 답변은
// **조용히 뺀다.** 2026-09-29 운영 전환 직후 전환 전 싱크분 6,608건(138회차)이 그렇게
// 사라졌고 고객 신고(GV80 HEV 1.2v)로 발견됐다(docs: hmg-geo-anchor-gap-after-prod-switch-rca-2026-09-29).
//
// 1차 방어는 sync 크론의 따라잡기 단계(20분, `runAnchorCatchup`)다. 이 감시는 그 뒤에도
// 남은 공백을 본다: **run 이 싱크된 지 `ANCHOR_GAP_GRACE_HOURS` 가 지났는데** 표시가 없는 것.
// 1시간 = 따라잡기가 최소 3번 기회를 가진 뒤다. 남아 있다면 따라잡기가 못 채운 것이다
// (상한 초과 대형 회차·반복 실패·창 밖·크론 정지).
//
// 목적지는 **Slack**(라이브 이슈): 고객 화면에서 답변이 지금 빠져 있다.
// 판정 불가(0077 미적용·오류·mock)는 알리지 않고 응답에만 싣는다(감시 ③과 같은 규약).
export const ANCHOR_GAP_ALERT_TITLE = "회차 표시 공백";

/** 싱크 후 이 시간이 지나도 표시가 없어야 공백으로 센다 = 따라잡기 틱 3회. */
export const ANCHOR_GAP_GRACE_HOURS = 1;

/**
 * 긴급(2) 기준. 하나라도 해당하면 2, 아니면(공백 > 0) 1.
 *
 * - **global·website 표면** 공백: 함대 대시보드(다수 계정이 보는 화면)에서 빠진다. 또 5,000
 *   답변을 넘는 대형 회차는 전부 글로벌 루트라(2026-09-29 실측 5개) 따라잡기가 설계상
 *   건너뛴다: 사람이 백필하지 않으면 영구 공백이다.
 * - **답변 1,000건 이상**: 정상 회차 2~7개 규모(p50 134 · p99 501). 따라잡기는 틱당 5,000 을
 *   채우므로 3틱 뒤에도 이만큼 남았다면 따라잡기 자체가 안 돌고 있다는 뜻이다.
 * - **싱크 후 24시간 이상**: 따라잡기 72틱이 지나도 못 채웠다(반복 실패·창 밖).
 *
 * 그 외(project 표면 소규모·24시간 미만)는 주의(1): 고객 화면 누락이지만 대개 다음 틱들이
 * 회수 중이거나 단일 회차의 일시 실패다.
 */
export const ANCHOR_GAP_URGENT_ANSWERS = 1_000;
export const ANCHOR_GAP_URGENT_AGE_HOURS = 24;
const ANCHOR_GAP_URGENT_SURFACES = new Set(["global", "website"]);

export interface AnchorGapVerdict {
  checked: boolean;
  reason?: "mock" | "0077-missing" | "error";
  severity: AlertSeverity;
  /** 공백 답변 합 */
  answers: number;
  /** 공백 회차 수 합(표면·프로젝트 묶음별 합) */
  cycles: number;
  /** 표면별 답변 수 */
  bySurface: Record<string, number>;
  /** 답변 수 상위 프로젝트 묶음(최대 5) */
  top: AnchorGapGroup[];
  /** 가장 오래된 회차 앵커와 그 묶음 */
  oldest: { anchorAt: string; projectId: string; projectName: string | null; surface: string } | null;
  /** 가장 오래된 싱크 시각 기준 경과 시간(h) */
  oldestSyncAgeHours: number;
  error?: string;
}

/** 순수 판정: DB 결과(묶음)와 현재 시각으로 등급·요약을 만든다. */
export function judgeAnchorGap(groups: AnchorGapGroup[], now: Date = new Date()): AnchorGapVerdict {
  const answers = groups.reduce((s, g) => s + g.answers, 0);
  const cycles = groups.reduce((s, g) => s + g.cycles, 0);
  const bySurface: Record<string, number> = {};
  for (const g of groups) bySurface[g.surface] = (bySurface[g.surface] ?? 0) + g.answers;
  const top = [...groups].sort((a, b) => b.answers - a.answers).slice(0, 5);
  let oldest: AnchorGapVerdict["oldest"] = null;
  for (const g of groups) {
    if (g.oldestAnchorAt && (!oldest || g.oldestAnchorAt < oldest.anchorAt)) {
      oldest = { anchorAt: g.oldestAnchorAt, projectId: g.projectId, projectName: g.projectName, surface: g.surface };
    }
  }
  const syncTimes = groups.map((g) => Date.parse(g.oldestSyncedAt)).filter((t) => Number.isFinite(t));
  const oldestSyncAgeHours = syncTimes.length
    ? Math.floor((now.getTime() - Math.min(...syncTimes)) / HOUR_MS)
    : 0;
  let severity: AlertSeverity = 0;
  if (answers > 0) {
    const urgent =
      groups.some((g) => g.answers > 0 && ANCHOR_GAP_URGENT_SURFACES.has(g.surface)) ||
      answers >= ANCHOR_GAP_URGENT_ANSWERS ||
      oldestSyncAgeHours >= ANCHOR_GAP_URGENT_AGE_HOURS;
    severity = urgent ? 2 : 1;
  }
  return { checked: true, severity, answers, cycles, bySurface, top, oldest, oldestSyncAgeHours };
}

export async function scanAnchorGap(): Promise<AnchorGapVerdict> {
  const blank = { severity: 0 as AlertSeverity, answers: 0, cycles: 0, bySurface: {}, top: [], oldest: null, oldestSyncAgeHours: 0 };
  if (isMockMode()) return { checked: false, reason: "mock", ...blank };
  try {
    const groups = await readAnchorGapGroups(ANCHOR_GAP_GRACE_HOURS);
    if (groups === null) return { checked: false, reason: "0077-missing", ...blank };
    return judgeAnchorGap(groups);
  } catch (err) {
    return {
      checked: false, reason: "error", ...blank,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Slack 제목 한 줄(등급 판단용 요약 포함). */
export function buildAnchorGapAlertTitle(v: AnchorGapVerdict): string {
  const surfaces = Object.entries(v.bySurface)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s} ${n}`)
    .join(" · ");
  return `${ANCHOR_GAP_ALERT_TITLE}: 완료 답변 ${v.answers}건 · 회차 ${v.cycles}개 (${surfaces})`;
}

export function buildAnchorGapAlertBody(v: AnchorGapVerdict): string {
  const lines: string[] = [];
  lines.push(
    `완료 답변 ${v.answers}건(회차 ${v.cycles}개)에 회차 표시(scope_answer_cycle_anchors)가 없다. ` +
      `싱크 후 ${ANCHOR_GAP_GRACE_HOURS}시간이 지나 자동 채움(sync 크론)이 최소 3번 기회를 가진 뒤에도 남은 것이다. ` +
      "앵커 축 화면에서 이 답변들은 빠져 보인다.",
  );
  lines.push(
    "표면별: " +
      Object.entries(v.bySurface)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${s} ${n}`)
        .join(" · "),
  );
  lines.push("상위 프로젝트:");
  for (const g of v.top) {
    lines.push(
      `  · ${g.projectName ?? "(이름 없음)"} [${g.surface}] ${g.answers}건 · 회차 ${g.cycles}개 · ` +
        `최고령 앵커 ${g.oldestAnchorAt ?? "없음"} · 최고령 싱크 ${g.oldestSyncedAt} (project ${g.projectId})`,
    );
  }
  if (v.oldest) {
    lines.push(
      `최고령 회차: ${v.oldest.anchorAt} · ${v.oldest.projectName ?? v.oldest.projectId} [${v.oldest.surface}]`,
    );
  }
  lines.push(`가장 오래된 싱크 경과: ${v.oldestSyncAgeHours}시간.`);
  lines.push(
    "복구: npm run db:backfill:answer-anchors (dry-run 확인) → npm run db:backfill:answer-anchors -- --apply --no-reassign. " +
      "백필 뒤 운영 캐시 무효화가 필요하다(행 단위 변경은 회차 지문이 못 본다).",
  );
  lines.push("시각은 전부 UTC (KST = +9h). 이 알림은 회차 사슬 감시 크론(/api/cron/cycle-chain-watch)이 보낸다.");
  return lines.join("\n");
}
