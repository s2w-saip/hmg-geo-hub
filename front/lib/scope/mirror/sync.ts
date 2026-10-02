import "server-only";
import {
  scopeMirrorRepository,
  type MirrorAnswer,
  type MirrorMention,
  type MirrorMentionOccurrence,
  type MirrorAnswerStance,
  type MirrorCitation,
  type MirrorAcrRollup,
} from "@/lib/db/repositories/scope-mirror";
import { getScopeClient } from "@/lib/scope";
import { getRootConfig } from "@/lib/scope/result-adapter";
import { projectRepository } from "@/lib/db/repositories/projects";
import { promptRepository } from "@/lib/db/repositories/prompts";
import { getWebsiteScopeProjectIds } from "@/lib/db/repositories/website-sites";
import type { ScopeClient } from "@/lib/scope/client";
import { withScopeReadDeadline } from "@/lib/scope/read-deadline";
import { getProjectTrackedDictionary } from "@/lib/db/repositories/project-tracked-dictionary";
import { correctCaseSensitiveBrandMention } from "@/lib/scope/mirror/case-sensitive-brands";
import { RUN_RECHECK_WINDOW_MS } from "@/lib/scope/mirror/recheck-window";
import {
  assertScopeDeadline,
  pageAll,
  PROMPT_MAX_PAGES,
  ScopeDeadlineExceededError,
} from "@/lib/scope/paging";
import type { AcrRollupRow, MeasurementJob, MeasurementRunSummary, Paginated, Prompt, QueryAnalysisSummary, ResolvedMention, ScopeBrandStance } from "@/lib/scope/types";
// scope_citations.domain 은 이 경로에서 "저장 시점에" 결정된다 — 읽기 경로에 재계산이
// 없으므로 여기서 잘리면 영구적이다. 2026-08-24 실측: 하드코딩 8개짜리 접미사 Set 이
// 71,825행(3.04%)을 `com.mx`·`co.id` 같은 public suffix 로 접었다. 정본은 PSL 하나뿐.
import { registrableDomainOfHost } from "@/lib/public-suffix";

// Incremental mirror sync — pulls the STANDARD/root project's measurement data
// from scope and writes it into the scope_* tables, one run at a time. Runs are
// immutable once TERMINAL (completed/failed/partial_failed), so only runs
// already mirrored in a terminal state are skipped — that set is the watermark.
// A run mirrored while still queued/running is re-pulled on every pass until it
// finishes, so an in-flight snapshot never freezes. Pass { force: true } to
// re-pull everything.
//
// Per-answer text + citations come from the project jobs feed with
// ?include=result (scope change). When that scope build isn't deployed yet, the
// row's `result` is absent and we fall back to GET /query/{jobId} per answer —
// correct but chatty; it disappears once scope ships the include param.
//
// System job: uses the raw client (no enforce/audit — there's no user session);
// user-facing reads still go through the gateway.
//
// ── 2026-09-14 18:00Z~23:00Z: 크론 16틱 연속 타임아웃 (이슈 #262) ──────────
// terminal 이지만 failed 답변이 남은 대형 run 이 재확인 창(3일) 동안 **매 틱 전량
// 재당김**됐고(상한은 건수 25 뿐, 크기 상한 없음), 예산 경계 직전에 시작한 run 이
// 300s 를 넘겨 함수가 킬 → tx 롤백 → 다음 틱 같은 run → 영구 반복.
// 여기서 더한 규칙 둘 (둘 다 순수 함수 + 회귀 테스트):
//   ① `shouldDeferHeavyRecheck` — **재확인**만 잡 수 상한(MIRROR_RECHECK_MAX_JOBS,
//      기본 500)을 본다. 신규 run·상태 변경 run·force 는 크기와 무관하게 당긴다.
//      대가: heavy run 의 failed→completed 회수 반영이 **지연·수동화**된다
//      (재확인 창 3일 뒤 신호 소멸 → 그 안에 명시적 resync 필요).
//   ② `shouldStopBeforeRun` — 남은 예산 < 예상 비용(페이지 수 × 이번 패스 실측
//      ms/페이지 + replace 상수)이면 그 run 을 **시작하지 않고** 패스를 끝낸다.

function hostFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// Catalog status feedback: a job's scope status collapses onto the local
// prompts.status lifecycle (draft → queued → done|failed, see prompts.ts).
// "running" covers any non-terminal job state (queued/running/etc on scope's
// side) so the chip moves off "queued" as soon as a run picks the prompt up.
export type CatalogPromptStatus = "running" | "done" | "failed";
const CATALOG_STATUS_RANK: Record<CatalogPromptStatus, number> = {
  running: 1,
  done: 2,
  failed: 3,
};
function jobStatusToCatalogStatus(jobStatus: string): CatalogPromptStatus {
  if (jobStatus === "completed") return "done";
  if (jobStatus === "failed") return "failed";
  return "running";
}
// Highest-rank status wins when a sync pass sees multiple jobs (different
// engines/runs) for the same prompt — failed > done > running.
function mergeCatalogStatus(
  a: CatalogPromptStatus,
  b: CatalogPromptStatus,
): CatalogPromptStatus {
  return CATALOG_STATUS_RANK[b] > CATALOG_STATUS_RANK[a] ? b : a;
}

// ── 페이지 상한 ───────────────────────────────────────────────────────────
// `pageAll` 과 프롬프트 상한은 lib/scope/paging.ts 로 올렸다 — server.ts·
// result-adapter.ts·scripts/** 도 같은 헬퍼를 쓰기 때문이다(레이어 근거는 그
// 파일 헤더 참조). runs·jobs 상한은 **미러 싱크 전용이라 여기 남긴다.**

/**
 * 미러 싱크의 `listMeasurementRuns` / `listRunJobs` 상한 —
 * **의도적으로 종전 값(50)을 유지한다.**
 *
 * runs·jobs 는 프롬프트와 달리 시간이 갈수록 **무한히 늘어난다**. 여기서 상한을
 * 올리면 한 패스가 폭주한다. 이 증가는 상한이 아니라 워터마크
 * (`shouldSkipMirroredRun`)·재확인 상한(`RECHECK_MAX_RUNS_PER_PASS`)·oldest-first
 * 로테이션이 다루도록 설계돼 있다. 프롬프트 상한(PROMPT_MAX_PAGES)을 올린다고
 * 여기까지 같이 올리지 말 것 — 부하 성격이 다르다.
 *
 * ⚠️ result-adapter 의 라이브 집계는 같은 소스를 **다른 값(30)** 으로 읽는다.
 * 공유 상수로 합치지 않은 이유는 그쪽이 사용자 요청 경로(지연 민감)이고 이쪽은
 * 백그라운드 크론이기 때문이다 — 값이 다른 것이 의도다.
 */
// ⚠️ 100건/페이지 × 50 = 5,000런이 상한이었다. 2026-09-05 실측: 프로젝트
// `be28fe15…` 는 런이 **5,639개**라 상한 밖 런이 재싱크에서 조용히 빠졌고,
// 8/31 백필로 코어에 채워진 언급이 미러에 영영 안 넘어왔다(미러 28.6% 고착).
// `runsSince` 는 **가져온 뒤** 거르므로 상한을 못 대신한다 — 상한 자체를 올린다.
export const MIRROR_RUN_MAX_PAGES = Number(process.env.MIRROR_RUN_MAX_PAGES ?? 50);
/**
 * jobs 피드 페이지 상한. **기본값 50 은 종전과 같다** — 크론의 300s 안에서
 * 한 run 이 낼 수 있는 왕복을 묶어 두는 값이라 올리면 라우트가 죽는다
 * (paging.ts 헤더의 2026-08-30 프롬프트 상한 300 사고와 같은 축).
 *
 * env 로 뺀 이유는 **로컬 회수 도구**(`scripts/scope/local-resync-window.ts`)가
 * 같은 `syncStandardMirror` 를 쓰기 때문이다. 그쪽은 Vercel 300s 밖이라 상한을
 * 올려도 안전한데, 하드코딩이면 66,144 잡짜리 대형 run 을 회수할 경로가 아예
 * 없다(2026-09-13 회차 8). **프로덕션 env 에는 넣지 말 것** — 로컬 전용이다.
 */
export const MIRROR_JOB_MAX_PAGES = Number(process.env.MIRROR_JOB_MAX_PAGES ?? 50);
/** `listRunJobs` 페이지 크기. 상한 계산(=한 run 이 볼 수 있는 잡 수)의 분모다. */
export const MIRROR_JOB_PAGE_LIMIT = 200;
/**
 * 한 패스가 한 run 에서 볼 수 있는 최대 잡 수. 이 수를 **넘는 run 은 애초에
 * 온전히 미러될 수 없다** — 그래서 페이징을 시작하기도 전에 걸러낸다
 * (`run.total_jobs` 는 run 목록에 이미 들어 있어 추가 왕복이 0이다).
 */
export function mirrorJobCapacity(): number {
  return MIRROR_JOB_MAX_PAGES * MIRROR_JOB_PAGE_LIMIT;
}

/**
 * run 이 이번 패스의 잡 상한을 **구조적으로** 넘는가 (순수 함수, 테스트 대상).
 *
 * ── 왜 페이징 전에 판정하는가 (2026-09-13 미러 정지 사고) ──────────────────
 * 회차 8 은 코어 measurement_run **1건에 66,144 잡**으로 들어왔다(회차 7 은
 * 1,348 run 분산). 상한(10,000)의 6.6배다. 종전 코드는 그래도 10,000 잡을
 * 끝까지 당긴 뒤 `pageCapHits.add("jobs")` 만 찍고 **부분 run 을 그대로 썼다.**
 * 그 왕복(50페이지 × 무거운 include=result,occurrences)이 루트 프로젝트에서
 * 300s 를 통째로 먹어 크론이 매 패스 504 로 죽었고, 커서 갱신이 `syncOneProject`
 * **뒤**에 있어 216개 프로젝트 커서가 전부 얼어붙었다.
 *
 * 미러될 수 없는 run 을 위해 상한만큼 왕복을 지불하는 것은 순손실이다 —
 * 0원에 걸러내고 `oversizedRuns` 로 시끄럽게 표면화한다.
 */
export function isOversizedRun(
  totalJobs: number | null | undefined,
  capacity: number = mirrorJobCapacity(),
): boolean {
  return typeof totalJobs === "number" && totalJobs > capacity;
}

/**
 * 양수 env 정수 읽기. 빈 문자열·NaN·0·음수는 **기본값으로 되돌린다** —
 * `Number("")` 이 0 이라, 빈 env 하나로 상한이 0 이 되어 전부 막히는 사고를 막는다.
 */
function readPositiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * **재확인** 1건이 감당할 최대 잡 수 (2026-09-14 크론 16틱 연속 타임아웃).
 *
 * ── 사고 ──────────────────────────────────────────────────────────────────
 * 2026-09-14 18:00Z 부터 23:00Z 까지 `/api/cron/sync-mirror` 가 **매 틱**
 * `Task timed out after 300 seconds` 로 죽었다(16틱 연속, 수동 호출도 504).
 * 원인은 terminal 이지만 failed 답변이 남은 대형 run 들이다 —
 * `shouldSkipMirroredRun` 은 `prior.hasUnresolved && recheckable` 이면 skip 하지
 * 않으므로, 그런 run 은 **재확인 창(3일) 동안 매 틱 전량 재당김**된다. 2,170 잡
 * (11페이지) · 1,000 잡(5페이지) 짜리가 매 패스 include=result,occurrences 로
 * 다시 넘어왔다. 종전 상한은 `RECHECK_MAX_RUNS_PER_PASS`(건수 25) 뿐이고
 * **run 크기에 대한 상한이 없었다.** 오버사이즈 가드(capacity 10,000)는 그보다
 * 작은 이 run 들을 전혀 막지 못한다.
 *
 * ── 규칙 ──────────────────────────────────────────────────────────────────
 * 재확인(= 이미 미러된 run 을 회수 추적으로 **다시** 당기는 것)만 이 상한을 본다.
 * 처음 보는 run·상태가 바뀐 run·force 경로는 크기와 무관하게 당긴다 — 신규
 * 데이터와 상태 전이가 비용 상한 때문에 밀리면 안 된다.
 *
 * ── 값의 근거 (라이브 미러 실측, 2026-09-15) ──────────────────────────────
 * 최근 3일 terminal run 의 `total_jobs`: **>500 = 20건**(전부 루트 프로젝트,
 * 734~1,818잡 + 66,144잡 오버사이즈 1건)이고 **20건 전부 미완 답변 보유**
 * = 매 틱 재확인 대상이었다. >1,000 = 5건, >1,500 = 3건. 14일 분포는
 * p50 20 · p90 200 · **p99 ≈ 825**. 1,000 으로 올리면 734~990잡 15건이 남아
 * 틱당 수 분을 다시 먹는다 → **500 이 맞다**(정상 run p99 ≈ 825 기준 영향 ~1%,
 * 루트 대형 run 회수는 명시적 resync).
 *
 * ⚠️ 이 상한에 걸린 run 의 failed→completed 회수는 **지연·수동화된다.** 정규
 * 크론이 더 이상 자동으로 회수를 반영하지 않으므로, 재확인 창
 * (`RUN_RECHECK_WINDOW_DAYS` 3일)이 지나면 그 신호 자체가 사라진다 —
 * **3일 안에 명시적 재싱크**가 필요하다(`?force=1&projectIds=…` 또는
 * `npm run mirror:local-resync`). 대상은 보고 필드 `recheckDeferredHeavy` 와
 * 커서 `last_error` 의 `heavy recheck deferred`, 그리고 절단 감시 이슈에 나온다.
 */
export const MIRROR_RECHECK_MAX_JOBS = readPositiveEnvInt(
  "MIRROR_RECHECK_MAX_JOBS",
  500,
);

/**
 * 무거운 **재확인**을 이번 패스에서 미룰 것인가 (순수 함수, 테스트 대상).
 *
 * 참이 되는 유일한 경우: ① 이미 미러된 run 이고(`prior` 존재 — force 는 호출부가
 * `undefined` 로 만든다) ② scope 가 보고하는 status 가 우리가 미러한 것과 **같고**
 * ③ 코어가 보고한 잡 수가 상한을 넘는다.
 *
 * 상태가 바뀐 run(②의 부정)은 크기와 무관하게 당긴다 — `shouldSkipMirroredRun`
 * 의 종전 규칙을 그대로 보존한다. 잡 수를 모르면(`null`/`undefined`) 막지 않는다:
 * 모른다고 버리면 정상 run 이 사라진다(`isOversizedRun` 과 같은 규약).
 */
export function shouldDeferHeavyRecheck(
  prior: MirroredRunState | undefined,
  currentStatus: string,
  totalJobs: number | null | undefined,
  maxJobs: number = MIRROR_RECHECK_MAX_JOBS,
): boolean {
  if (!prior) return false;
  if (prior.status !== currentStatus) return false;
  if (typeof totalJobs !== "number") return false;
  return totalJobs > maxJobs;
}

/**
 * **가득 찬** jobs 페이지(200건) 하나의 보수적 기본 단가(ms). 이번 패스에서 아직
 * 표본이 없을 때 쓴다. 2026-09-14 수동 호출 실측(254s 에 2 run · 132 answers)과
 * `?maxRuns=1` 보고서의 프로젝트당 ~5s 목록 왕복을 근거로 잡은 값이다 —
 * **낮게 잡으면 상한을 넘는 시작을 허용**하므로 과대평가가 안전한 방향이다.
 */
export const MIRROR_JOB_PAGE_MS_FALLBACK = 4_000;

/**
 * 실측 단가의 **하한**(가득 찬 페이지 기준 ms). 기본 상수의 1/4.
 *
 * ── 왜 하한이 필요한가 (검증자 재현, 2026-09-15) ─────────────────────────
 * 종전 페이스는 **페이지당 ms** 였다. 첫 run 이 희소 페이지(10잡·10ms)면 평균이
 * 10ms/페이지가 되고, 뒤따르는 2,170잡 run 의 예상이 5,110ms 로 떨어져 잔여
 * 9,990ms 에서 **시작이 허용**된다 — 실제로는 16,535ms 가 걸려 1.65배를 넘겼고
 * `budgetStoppedProjects` 는 빈 배열이었다. 즉 가드가 있는데도 사고가 재현된다.
 *
 * 그래서 두 겹으로 고친다: ① 페이스를 **잡당(ms/job)** 으로 정규화해 페이지의
 * 희소·밀도 차이를 없애고(표본이 실제 잡 수로 가중된다) ② 그렇게 환산한
 * 가득 찬 페이지 단가에 이 하한을 건다. 표본이 적거나 이상하게 빠른 초반
 * (캐시 적중·빈 run)이 예산 판단을 낙관으로 끌고 가지 못하게 하는 것이 목적이다.
 */
export const MIRROR_JOB_PAGE_MS_FLOOR = MIRROR_JOB_PAGE_MS_FALLBACK / 4;

/**
 * `replaceRun`(run 단위 delete+insert 트랜잭션) + 답변 가공에 잡아 두는 상수(ms).
 * 페이지 수에 비례하지 않는 고정 꼬리라 별도 상수로 둔다.
 */
export const MIRROR_REPLACE_RUN_COST_MS = 5_000;

/**
 * 이번 패스의 jobs 피드 실측 페이스. 프로젝트 사이에 **공유**한다.
 * 단위는 **페이지가 아니라 잡**이다 — MIRROR_JOB_PAGE_MS_FLOOR 주석의 재현 참조.
 */
export interface PassPacing {
  /** 누적 소요(ms). 표본으로 채택한 페이지들의 합. */
  jobMs: number;
  /** 그 페이지들이 실제로 담고 있던 **잡 수** 합(=가중치). */
  jobs: number;
}

export function createPassPacing(): PassPacing {
  return { jobMs: 0, jobs: 0 };
}

/**
 * 이번 패스가 표본을 채택하는 규칙 (순수 함수, 테스트 대상).
 * 잡이 0건인 페이지는 **표본이 아니다** — 분모가 0이라 ms/job 을 만들 수 없고,
 * 빈 왕복의 지연을 잡 단가로 환산하면 어느 쪽으로든 거짓말이 된다.
 */
export function recordJobPageSample(
  pacing: PassPacing,
  elapsedMs: number,
  jobCount: number,
): void {
  if (jobCount <= 0) return;
  pacing.jobMs += elapsedMs;
  pacing.jobs += jobCount;
}

/**
 * **가득 찬 페이지(200건) 하나**의 예상 단가(ms).
 * 표본이 없으면 보수적 상수, 있으면 `ms/job × 200` 에 하한을 건 값이다.
 */
export function jobPageAvgMs(pacing: PassPacing | undefined): number {
  if (!pacing || pacing.jobs <= 0) return MIRROR_JOB_PAGE_MS_FALLBACK;
  const perJob = pacing.jobMs / pacing.jobs;
  return Math.max(perJob * MIRROR_JOB_PAGE_LIMIT, MIRROR_JOB_PAGE_MS_FLOOR);
}

/**
 * 이 run 을 당기는 데 걸릴 예상 시간(ms) — 순수 함수, 테스트 대상.
 * 페이지 수(`ceil(jobs / 200)`) × 가득 찬 페이지 단가 + replace 상수.
 *
 * 잡 수를 모르면 **한 페이지**로 본다. 과소평가지만, 모르는 run 을 크다고
 * 가정해 막으면 정상 run 이 영구히 밀린다 — 바깥의 `Date.now() > deadlineAt`
 * 검사가 그 경우의 안전망이다.
 */
export function estimateRunPullMs(
  totalJobs: number | null | undefined,
  pacing?: PassPacing,
): number {
  const jobs = typeof totalJobs === "number" && totalJobs > 0 ? totalJobs : 1;
  const pages = Math.max(1, Math.ceil(jobs / MIRROR_JOB_PAGE_LIMIT));
  return pages * jobPageAvgMs(pacing) + MIRROR_REPLACE_RUN_COST_MS;
}

/**
 * 이 run 을 **시작하지 말아야** 하는가 (순수 함수, 테스트 대상).
 *
 * ── 왜 필요한가 (2026-09-14) ──────────────────────────────────────────────
 * 종전 예산 검사는 `Date.now() > deadlineAt`, 즉 **이미 초과했는가** 뿐이었다.
 * 예산 경계 **직전**에 시작한 대형 run 하나가 300s 를 넘기면 Vercel 이 함수를
 * 죽이고 그 run 의 트랜잭션은 롤백된다 → 다음 틱이 같은 run 을 다시 당긴다 →
 * 영구 반복. 그래서 "남은 시간 < 예상 비용" 이면 **시작 자체를 하지 않는다.**
 *
 * `remainingMs` 가 유한하지 않으면(로컬 회수 도구: `budgetMs` 무제한) 항상 거짓.
 */
export function shouldStopBeforeRun(
  remainingMs: number,
  totalJobs: number | null | undefined,
  pacing?: PassPacing,
): boolean {
  if (!Number.isFinite(remainingMs)) return false;
  return remainingMs < estimateRunPullMs(totalJobs, pacing);
}

export interface MirroredRunState {
  /** 미러에 기록된 run status. null 이면 비교가 불가하므로 항상 다시 당긴다. */
  status: string | null;
  hasUnresolved: boolean;
  recheckable: boolean;
  /** 이 run 을 마지막으로 미러에 쓴 시각. 강제 재싱크 워터마크의 기준값. */
  syncedAt: Date | null;
}

/**
 * 워터마크 판정 (순수 함수, 테스트 대상).
 *
 * terminal 이라는 이유만으로 건너뛰지 않는다 — scope 의 run status 는 job 에서
 * 파생되고(measurement_runs 에 status 컬럼이 없다), 티켓 회수가 이미 terminal 인
 * run 안의 job 을 failed→completed 로 뒤집는다. 건너뛰려면 두 조건이 모두 참이어야
 * 한다: ① scope 가 지금 보고하는 status 가 우리가 미러한 것과 같다 ② 더 바뀔 것이
 * 없다 — 미완 답변이 하나도 없거나, 재확인 창을 지난 오래된 run 이다.
 */
export function shouldSkipMirroredRun(
  prior: MirroredRunState | undefined,
  currentStatus: string,
): boolean {
  if (!prior) return false;
  if (prior.status !== currentStatus) return false;
  return !(prior.hasUnresolved && prior.recheckable);
}

/**
 * 강제 재싱크 워터마크 판정 (순수 함수, 테스트 대상).
 *
 * ── 왜 필요한가 (2026-08-30 실측) ─────────────────────────────────────────
 * `?force=1` 은 미러 상태를 **통째로 무시**하고 run 목록의 **앞에서부터**
 * `maxRuns` 개를 집는다. 목록에는 커서도 오프셋도 없으므로 **같은 N 으로 패스를
 * 반복하면 매번 같은 run 을 다시 쓴다 — 진도가 0 이다.** 실측: 동일 파라미터
 * (`force=1&maxRuns=20`) 로 255초짜리 패스를 두 번 돌린 결과 대상 494행 중
 * 전환은 **1행**이었고, 미러의 `synced_at` 갱신 run 은 **20건에서 늘지 않았다**.
 * scope 응답은 newest-first 라(재싱크된 20건의 `started_at DESC` 랭크 = 1~20)
 * force 는 언제나 "가장 최신 N 개"만 다시 당긴다.
 *
 * 워터마크는 여기에 **단조 전진**을 준다: "기준 시각 T 이후 이미 재싱크된 run 은
 * 건너뛴다". 앞쪽이 소진되면 다음 패스가 그 다음 구간을 집으므로, 패스를 반복하면
 * 목록 깊은 곳(실측 대상 run 은 랭크 3,683 까지 분포)까지 닿는다.
 *
 * ⚠️ 미러에 없는 run(=state undefined)과 `syncedAt` 이 null 인 run 은 **절대
 * 건너뛰지 않는다** — 신규·미기록 데이터가 워터마크 때문에 밀리면 안 된다.
 */
export function shouldSkipResyncedRun(
  state: Pick<MirroredRunState, "syncedAt"> | undefined,
  resyncBefore: Date | undefined,
): boolean {
  if (!resyncBefore) return false;
  if (!state?.syncedAt) return false;
  return state.syncedAt >= resyncBefore;
}

// ── 증분 읽기 (2026-09-28, 루트 크론 정지) ───────────────────────────────
// 2026-09-27 17:20Z 이후 루트(prompts ~12,446 · runs ~8,681)의 모든 시도가
// "PAGE CAP HIT — prompts" 뒤 `Scope read deadline exceeded` 로 **쓰기 단계에 못 갔다.**
// 매 틱 listPrompts 50페이지 + listMeasurementRuns 50페이지를 처음부터 다시 읽었기
// 때문이다(paging.ts 헤더가 예고한 해법 ② "updated_at 워터마크 기반 증분").
//
// 두 소스를 각각 다른 방식으로 줄인다 — 목록 정렬이 둘 다 created_at DESC 인데
// 필터 능력이 다르기 때문이다:
//   · 프롬프트: scope 가 `updated_from` 을 지원한다 → 워터마크 이후 갱신분만 읽는다.
//     한 틱 상한을 넘는 창(일괄 편집)은 커서를 남기고 다음 틱이 이어 읽는다.
//   · run: 시간 필터가 없다 → 최신부터 읽다가 "이 아래는 전부 정착" 경계(floor)를 지나고
//     정착 run 이 연속 N 개 나오면 멈춘다.
// 저장 위치는 scope_sync_watermarks(0082). 표가 없으면 종전 전량 읽기다.
//
// 증분이 **구조적으로 못 잡는 변경**은 러너 박스의 하루 1회 전체 대조
// (`npm run mirror:reconcile`, `fullScan`)가 맡는다 — 목록은 docs/mirror-incremental-sync.md
// "사각" 표. 전체 대조가 안 돌면 그 사각은 **영구**다.

/** 이 run status 들만 "끝났다"로 본다(scope-mirror.ts TERMINAL_RUN_STATUSES 와 같은 집합). */
const TERMINAL_RUN_STATUS_SET = new Set(["completed", "failed", "partial_failed"]);

/**
 * 프롬프트 워터마크 안전 여유(ms) — 다음 창은 `워터마크 − 이 값` 부터 읽는다.
 *
 * 워터마크는 hmg 쪽 시계로 잰 **읽기 시작 시각**이고, 비교 대상 `prompts.updated_at` 은
 * scope 쪽 시계로 찍힌 값이다. 이 여유가 덮는 것 둘:
 *   ① 두 시계의 차(NTP 동기 — 통상 1초 미만)
 *   ② scope 쪽 **긴 쓰기 트랜잭션** — updated_at 을 T 로 찍고 우리 읽기 뒤에 커밋되면,
 *      읽기 시점에는 안 보였는데 값은 워터마크보다 이르다.
 * ⚠️ 가정: 그 커밋 지연이 10분 **이하**다. 넘으면 그 프롬프트는 증분 창 밖이 되고
 * 다음 전체 대조까지 누락된다(검증 V5 산술 확인). 대가는 "최근 30분 갱신분 재읽기" 뿐이다.
 */
export const PROMPT_WATERMARK_MARGIN_MS = 10 * 60 * 1000;

/**
 * 이어 읽기(증분·첫 실행) 프롬프트 창의 **한 틱** 페이지 상한 — 기본 20(2,000건).
 *
 * 종전 상한(PROMPT_MAX_PAGES 50)을 한 틱에 다 쓰면 루트는 run 단계에 갈 예산이 없다 —
 * 이번 사고가 정확히 그 모양이다. 그래서 창이 크면(일괄 편집 6,000건 등) **커서를 저장하고
 * 다음 틱이 이어 읽는다.** 같은 updated_at 으로 한꺼번에 찍힌 갱신은 `updated_to` 로
 * 쪼갤 수 없으므로(검증 V4), 시간 분할이 아니라 커서 이어 읽기를 택했다.
 * 커서가 유효한 근거: 창 술어(`updated_at >= from`)는 갱신으로 빠지지 않고(갱신은 값을
 * 키울 뿐), 정렬 키(created_at, id)는 불변이다 — 이어 읽는 동안 창의 원소가 자리를 옮기지 않는다.
 */
export const PROMPT_TICK_MAX_PAGES = readPositiveEnvInt("MIRROR_PROMPT_TICK_MAX_PAGES", 20);

/**
 * run 목록 조기 종료에 필요한 **floor 아래 정착 run 연속 개수** — 기본 200.
 *
 * floor 가 정확하면 경계를 지나는 순간 멈춰도 된다. 더 읽는 이유는 **늦게 커밋된 run** 이다:
 * scope 가 created_at 을 T 로 찍고 우리 목록 읽기 뒤에 커밋하면, 그 run 은 이미 본 run 들
 * 아래(floor 아래)에 끼어든다. floor 아래로 N 개를 더 보면 그런 run 이 정착 run 사이에서
 * 드러나 연속이 끊기고 읽기가 계속된다.
 *
 * ⚠️ 보장 폭은 **floor 아래 최소 N 개**다(페이지 단위로 읽으므로 실제로는 N ~ N+99).
 * 그보다 깊이 끼어든 run 은 크론이 못 본다 — 전체 대조가 회수한다(검증 V2).
 * 100 → 200 으로 올린 이유: 한 번에 100개 넘게 만들어지는 회차 디스패치가 흔해서
 * (회차 7 은 1,348 run) 한 페이지 폭은 늦은 커밋 방어로 얇다. 대가는 틱당 목록 1페이지.
 */
export const MIRROR_RUN_SETTLED_STREAK = readPositiveEnvInt("MIRROR_RUN_SETTLED_STREAK", 200);

/**
 * floor 앵커 개수 — floor run 과 그 바로 아래(더 오래된) run 들 최대 K 개를 함께 저장한다.
 * 다음 패스는 **하나라도** 만나면 floor 를 지난 것으로 본다. floor run 하나만 저장하면
 * 그 run 이 Scope 에서 지워질 때 경계를 영영 못 지나 매 틱 페이지 상한까지 읽는 종전
 * 모양으로 돌아간다(검증 d). 아래쪽 앵커를 지났다는 것은 floor 자리를 지났다는 뜻이므로
 * 불변식("floor 보다 오래된 run 은 정착")이 그대로 선다.
 */
export const MIRROR_RUN_FLOOR_ANCHORS = 5;

/**
 * 비종결(queued/running) run 이 floor 를 붙잡는 최대 나이(ms) — 7일.
 *
 * 비종결 run 은 끝날 때까지 매 패스 다시 당겨야 하므로 floor 를 붙잡는다(목록에서
 * 계속 보이게). 그런데 **영영 안 끝나는** 좀비 run 이 하나만 있어도 floor 가 거기
 * 고정돼 루트가 다시 목록 전량을 읽는다 — 이번 사고와 같은 모양이다. 7일을 넘긴 비종결
 * run 은 floor 계산에서 빼고, 그 run 이 나중에 끝나는 전이는 하루 1회 전체 대조가 잡는다.
 */
export const OPEN_RUN_FLOOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 한 프로젝트의 증분 워터마크 (scope_sync_watermarks 한 행). */
export interface ProjectSyncWatermark {
  promptsSyncedThrough: Date | null;
  /** 한 틱 상한에서 끊긴 프롬프트 창의 이어 읽기 지점. */
  promptsResume: { cursor: string; from: Date | null; startedAt: Date } | null;
  runsFloorRunIds: string[] | null;
  runsFloorSnapshotAt: Date | null;
}

export type PromptReadMode = "incremental" | "resume" | "full" | "window";

export interface PromptReadPlan {
  mode: PromptReadMode;
  /** listPrompts `updated_from`. 없으면 하한 없음. */
  updatedFrom?: string;
  /** 이어 읽기 시작 커서(resume 모드). */
  startCursor?: string;
  /** 한 틱 상한에서 끊기면 커서를 저장해 다음 틱이 이어 읽는다. */
  resumable: boolean;
  /** 이 창의 하한(이어 읽기 상태에 그대로 남긴다). */
  windowFrom: Date | null;
  /** resume 모드: 창을 다 읽으면 워터마크가 될 값(그 창의 **첫** 읽기 시작 시각). */
  windowStartedAt?: Date;
  /** 이번 읽기가 창 끝까지 가면 워터마크를 전진해도 되는가. */
  canAdvance: boolean;
}

/**
 * 프롬프트를 어떻게 읽을지 (순수 함수, 테스트 대상).
 *
 *   window      — 호출자가 `promptsUpdatedFrom/To` 를 줬다(백필 회수). 종전 그대로 쓰고
 *                 워터마크는 **건드리지 않는다** — 일부 창을 읽은 것은 "여기까지 다 읽었다"
 *                 의 근거가 못 된다.
 *   full(비활성) — 표 미적용. 종전 전량 읽기, 쓰기 없음.
 *   full(force·fullScan) — 증분을 쓰지 않는다(강제 재싱크를 증분이 막으면 안 된다). 절단 없이
 *                 끝나면 전진은 한다.
 *   resume      — 지난 틱이 창을 상한에서 끊었다 → 같은 창·같은 커서로 이어 읽는다.
 *   incremental — 워터마크가 있다 → `updated_from = 워터마크 − 여유`.
 *   full(첫 실행) — 워터마크가 없다 → 하한 없는 창을 **이어 읽기로** 끝까지 읽는다
 *                 (루트처럼 5,000을 넘어도 몇 틱 안에 첫 워터마크가 선다).
 */
export function planPromptRead(args: {
  watermarksEnabled: boolean;
  explicitWindow: boolean;
  force: boolean;
  fullScan: boolean;
  syncedThrough: Date | null | undefined;
  resume?: ProjectSyncWatermark["promptsResume"];
  marginMs?: number;
}): PromptReadPlan {
  if (args.explicitWindow) return { mode: "window", resumable: false, windowFrom: null, canAdvance: false };
  if (!args.watermarksEnabled) return { mode: "full", resumable: false, windowFrom: null, canAdvance: false };
  if (args.force || args.fullScan) return { mode: "full", resumable: false, windowFrom: null, canAdvance: true };
  if (args.resume) {
    return {
      mode: "resume",
      updatedFrom: args.resume.from?.toISOString(),
      startCursor: args.resume.cursor,
      resumable: true,
      windowFrom: args.resume.from,
      windowStartedAt: args.resume.startedAt,
      canAdvance: true,
    };
  }
  if (!args.syncedThrough) return { mode: "full", resumable: true, windowFrom: null, canAdvance: true };
  const from = new Date(args.syncedThrough.getTime() - (args.marginMs ?? PROMPT_WATERMARK_MARGIN_MS));
  return { mode: "incremental", updatedFrom: from.toISOString(), resumable: true, windowFrom: from, canAdvance: true };
}

/**
 * run 목록을 어떻게 읽을지 (순수 함수, 테스트 대상).
 *
 * `recordFloor` — 이 패스가 floor 를 다시 계산해 남겨도 되는가. 정착 판정은
 *   `shouldSkipMirroredRun(prior, status)` 로 하는데, force 는 prior 를 버리고
 *   resyncBefore/runsSince/runsUntil 은 목록 일부만 보므로 판정 근거가 못 된다.
 * `earlyStop` — floor 를 근거로 목록을 **중간에 끊어도** 되는가. recordFloor 조건에
 *   더해 floor 가 있어야 하고, fullScan(전체 대조)은 끊지 않는다.
 *
 * ⚠️ `mirror:local-resync` 는 항상 force 다 → 둘 다 false = **종전 동작 그대로**.
 */
export function planRunScan(args: {
  watermarksEnabled: boolean;
  force: boolean;
  resyncBefore?: Date;
  runsSince?: Date;
  runsUntil?: Date;
  fullScan: boolean;
  floorRunIds: readonly string[] | null | undefined;
}): { recordFloor: boolean; earlyStop: boolean } {
  const recordFloor =
    args.watermarksEnabled && !args.force && !args.resyncBefore && !args.runsSince && !args.runsUntil;
  return { recordFloor, earlyStop: recordFloor && !args.fullScan && Boolean(args.floorRunIds?.length) };
}

export interface RunScanResult {
  items: MeasurementRunSummary[];
  /** 페이지 상한에 걸려 **잘렸다**(조기 종료는 절단이 아니다). */
  truncated: boolean;
  pages: number;
  /** 목록 끝(다음 커서 없음)까지 읽었다. */
  reachedEnd: boolean;
  /** 이전 floor 앵커 중 하나를 이번 읽기에서 **지나갔다**(= 그 아래는 불변식으로 정착). */
  passedFloor: boolean;
  /** 처음 만난 floor 앵커의 `items` 안 위치(-1 = 못 만남). */
  floorIndex: number;
  /** floor + 연속 정착 N 조건으로 멈췄다. */
  stoppedEarly: boolean;
}

/**
 * 조기 종료 판정 (순수 함수, 테스트 대상) — 페이지 경계마다 부른다.
 * floor 를 지났고, 그 뒤로 정착 run 이 연속 `streakTarget` 개 이상이면 멈춘다.
 */
export function shouldStopRunScan(args: {
  earlyStop: boolean;
  passedFloor: boolean;
  settledStreak: number;
  streakTarget: number;
}): boolean {
  return args.earlyStop && args.passedFloor && args.settledStreak >= args.streakTarget;
}

/**
 * run 목록 읽기. `earlyStop` 이 거짓이면 `pageAll` 과 **같은 결과**다(상한·경고·데드라인
 * 규약 동일). 참이면 floor 앵커를 지나 정착 run 이 연속 N 개 나온 페이지에서 멈춘다.
 * `isSettled` 는 **읽기 전 상태**(미러 워터마크)로만 판정한다 — 이번 패스의 처리 결과와
 * 무관해야 같은 목록에서 같은 결정이 나온다. 연속은 **첫 앵커 다음 run 부터** 센다.
 */
export async function scanRunList(
  fetchPage: (cursor?: string) => Promise<Paginated<MeasurementRunSummary>>,
  opts: {
    maxPages: number;
    label: string;
    deadlineAt?: number;
    earlyStop: boolean;
    floorRunIds: readonly string[] | null | undefined;
    streakTarget: number;
    isSettled: (run: MeasurementRunSummary) => boolean;
  },
): Promise<RunScanResult> {
  const anchors = new Set(opts.floorRunIds ?? []);
  let seen = 0;
  let floorIndex = -1;
  let streak = 0;
  const visit = (items: readonly MeasurementRunSummary[]) => {
    for (const run of items) {
      const index = seen++;
      if (floorIndex < 0) {
        if (anchors.has(run.measurement_run_id)) floorIndex = index;
        continue;
      }
      streak = opts.isSettled(run) ? streak + 1 : 0;
    }
  };
  let visitedTo = 0;
  const page = await pageAll(fetchPage, {
    maxPages: opts.maxPages,
    label: opts.label,
    deadlineAt: opts.deadlineAt,
    stopAfterPage: (items) => {
      visit(items);
      visitedTo = seen;
      return shouldStopRunScan({
        earlyStop: opts.earlyStop,
        passedFloor: floorIndex >= 0,
        settledStreak: streak,
        streakTarget: opts.streakTarget,
      });
    },
  });
  // 마지막 페이지(커서 없음)·상한에서 끊긴 마지막 페이지는 stopAfterPage 를 안 거치므로 마저 본다.
  visit(page.items.slice(visitedTo));
  return {
    items: page.items,
    truncated: page.truncated,
    pages: page.pages,
    reachedEnd: !page.truncated && !page.stoppedEarly,
    passedFloor: floorIndex >= 0,
    floorIndex,
    stoppedEarly: page.stoppedEarly,
  };
}

/**
 * 새 floor 계산 (순수 함수, 테스트 대상).
 *
 * ── 불변식 ─────────────────────────────────────────────────────────────────
 * "목록(created desc)에서 floor run 보다 **오래된** run 은 전부 정착했다."
 * 정착 = 이 패스가 끝난 시점에 더 당길 것이 없다. 이 불변식이 서야 다음 패스가 floor
 * 아래를 안 읽어도 잃는 run 이 없다(늦은 커밋·재확인 창 밖 전이는 예외 — 문서 "사각").
 *
 * ── 계산 ───────────────────────────────────────────────────────────────────
 * ① 이번 읽기가 **완결**(목록 끝까지 읽었거나 이전 floor 를 지남)이 아니면 floor 를
 *    **그대로 둔다** — 이전 floor 와 읽은 바닥 사이가 미확인이므로 올릴 근거가 없다.
 * ② 완결이면: 읽은 run 중 **floor 를 붙잡는** run 의 가장 오래된 것이 새 floor.
 *    하나도 없으면 가장 최신 run(목록 맨 앞)이 floor. 읽은 run 이 0 이면 null.
 * ③ 저장은 floor run 과 그 **아래** run 들 최대 `anchorCount` 개(MIRROR_RUN_FLOOR_ANCHORS).
 *
 * floor 를 붙잡는 run(`holdsFloor`) = 다음 패스가 다시 봐야 하는 run. 호출부가 정한다 —
 * 예산 중단으로 못 처리한 run·재확인 대상·잘린 run 등이 전부 여기 든다. 그래서 **예산
 * 중단으로 뒤쪽(오래된) run 을 못 처리한 패스**도 다음 패스가 그 run 까지 다시 읽는다 —
 * 연속-N 만으로 끊으면 이 run 들이 앞쪽 정착 run 뒤에 묻혀 영영 안 보인다.
 */
export function computeRunFloor(args: {
  runs: readonly Pick<MeasurementRunSummary, "measurement_run_id">[];
  holdsFloor: (runId: string) => boolean;
  scanComplete: boolean;
  previousFloorRunIds: readonly string[] | null | undefined;
  anchorCount?: number;
}): { floorRunIds: string[] | null; changed: boolean } {
  const previous = args.previousFloorRunIds?.length ? [...args.previousFloorRunIds] : null;
  if (!args.scanComplete) return { floorRunIds: previous, changed: false };
  if (args.runs.length === 0) return { floorRunIds: null, changed: previous !== null };
  let at = 0;
  for (let i = args.runs.length - 1; i >= 0; i--) {
    if (args.holdsFloor(args.runs[i].measurement_run_id)) {
      at = i;
      break;
    }
  }
  const k = args.anchorCount ?? MIRROR_RUN_FLOOR_ANCHORS;
  const floor = args.runs.slice(at, at + k).map((r) => r.measurement_run_id);
  const changed = !previous || previous.length !== floor.length || previous.some((id, i) => id !== floor[i]);
  return { floorRunIds: floor, changed };
}

/**
 * 이 run 이 이번 패스 뒤에도 floor 를 붙잡는가 (순수 함수, 테스트 대상).
 *   · 오버사이즈 run 은 붙잡지 않는다 — 크론이 스스로 미러할 수 없고(대량 경로는 러너
 *     박스의 bulk discovery 가 목록을 따로 훑는다), 붙잡으면 그 run 까지 매 틱 읽게 된다.
 *   · **completed 가 아닌 terminal run 은 재확인 창(3일) 동안 붙잡는다 — 정착했어도.**
 *     ACR 반복의 숨은 실패가 대표 답변 접기로 가려지면 미러 답변은 전부 completed 인데
 *     run status 는 partial_failed 다 → `shouldSkipMirroredRun` 은 정착으로 본다. 이후
 *     실패 반복이 회수돼 status 가 completed 로 바뀌는 전이는 **목록에서 status 를 비교해야만**
 *     보이므로, 그 run 이 floor 아래로 묻히면 증분은 영영 못 본다(검증 V1). 종전 크론은
 *     5,000 run 을 매 틱 비교해 1틱 만에 회수했다 — 창 안에서는 그 성질을 지킨다.
 *   · 정착했으면 붙잡지 않는다.
 *   · **이번 패스가 처리하지 못한** 비정착 run(예산 중단·run 상한·재확인 건수 상한·잡 피드
 *     절단)은 **나이와 무관하게** 붙잡는다. 종전엔 7일 규칙이 먼저 걸려, 미러에 한 번도 안
 *     들어간 8일짜리 running run 이 run 상한에 밀리면 floor 가 그 위로 올라가 영영 묻혔다
 *     (재검증 부수 발견 1). 7일 규칙은 "처리해 봤는데 여전히 안 끝났다"에만 쓴다.
 *   · 이번 패스에 처리했는데 여전히 비종결인 run 은 7일까지만 붙잡는다(OPEN_RUN_FLOOR_MAX_AGE_MS).
 *     놓아준 좀비는 호출부가 `openRunsReleased` 로 센다 — 그 run 의 종료는 전체 대조가 잡는다.
 *
 * ⚠️ 처리가 **매번** 실패하는 run(예: 잡 피드가 늘 상한에서 잘리는 run)은 나이와 무관하게
 * floor 를 계속 붙잡는다. 그 경우는 `truncatedRuns`·`recheckCapHits` 로 이미 표면화된다.
 */
export function runHoldsFloor(
  run: Pick<MeasurementRunSummary, "status" | "started_at" | "total_jobs">,
  settled: boolean,
  now: number = Date.now(),
  /** 이번 패스가 이 run 을 실제로 써 봤는가(replaceRun 성공). 기본 참 = 종전 판정. */
  processedThisPass = true,
): boolean {
  if (isOversizedRun(run.total_jobs)) return false;
  if (!settled && !processedThisPass) return true;
  const started = run.started_at ? new Date(run.started_at).getTime() : NaN;
  const age = Number.isFinite(started) ? now - started : 0;
  if (TERMINAL_RUN_STATUS_SET.has(run.status)) {
    if (run.status !== "completed" && age <= RUN_RECHECK_WINDOW_MS) return true;
    return !settled;
  }
  if (settled) return false;
  return age <= OPEN_RUN_FLOOR_MAX_AGE_MS;
}

export interface MirrorSyncResult {
  runs: number; // runs (re)mirrored this pass
  answers: number; // answers written
  skipped: number; // runs already mirrored
  /**
   * `?resyncBefore=` 워터마크로 건너뛴 run 수. 이 값이 0 이 되면 그 패스가
   * 해당 프로젝트의 재싱크를 **완주**했다는 뜻이다 — 진행률 지표로 쓴다.
   */
  resyncSkipped: number;
  /**
   * 재확인 상한(`RECHECK_MAX_RUNS_PER_PASS`)에 닿은 프로젝트 목록.
   * **비어 있어야 정상이다** — 값이 있으면 그 프로젝트의 재확인 대상 일부가
   * 이번 패스에서 `skipped` 에 조용히 섞여 밀렸다는 뜻이다.
   */
  recheckCapHits: string[];
  /**
   * **재확인 잡 상한**(`MIRROR_RECHECK_MAX_JOBS`)에 걸려 이번 패스가 다시 당기지
   * 않은 run 들 (2026-09-14 사고). `recheckCapHits`(건수 상한)와 성격이 다르다 —
   * 저쪽은 "다음 패스로 밀린다", 이쪽은 **정규 크론으로는 영영 안 당긴다**
   * (다음 패스도 같은 판정이고, 재확인 창 3일이 지나면 skip 으로 굳는다).
   * 회수하려면 명시적 재싱크가 필요하다 — 그래서 조용히 두지 않고 올린다.
   */
  recheckDeferredHeavy: Array<{ projectId: string; runId: string; jobs: number }>;
  usedFallback: boolean; // had to call /query (scope ?include=result not live)
  catalogUpdated: number; // prompts.status rows flipped off queued/running
  // 시간 예산(SYNC_BUDGET_MS) 소진으로 이번 패스에서 시작하지 못한 프로젝트 수.
  // oldest-first 로테이션 덕에 다음 패스에서 이들이 앞순번이 된다.
  deferred: number;
  /**
   * 페이지 상한을 소진한 (프로젝트 × 소스) 목록. **비어 있어야 정상이다.**
   * 값이 있으면 그 소스는 잘린 채 미러됐다 — 조용한 절단이 2026-08-30
   * `scope_prompts.regions` 5,000 정체 사고를 오래 살려뒀기 때문에, 크론 응답
   * JSON(`app/api/cron/sync-mirror/route.ts` 가 결과를 그대로 spread 한다)에까지
   * 올린다. 상세는 pageAll 주석 참조.
   */
  pageCapHits: Array<{ projectId: string; kind: string }>;
  /**
   * 잡 상한을 구조적으로 넘어 **미러되지 않은** run 들. **비어 있어야 정상이다.**
   * 값이 있으면 그 회차는 미러에 아예 없다 — 로컬 회수 도구(상한 상향)가 필요하다.
   */
  oversizedRuns: Array<{ projectId: string; runId: string; totalJobs: number }>;
  /**
   * jobs 피드 절단으로 **건너뛴** run 들. 부분 미러를 굳히지 않기 위한 의도적
   * 스킵이지만, 값이 있으면 그 run 은 미러에 없다는 뜻이라 함께 표면화한다.
   */
  truncatedRuns: Array<{ projectId: string; runId: string }>;
  /**
   * run 루프 **도중에** 예산이 끊긴 프로젝트들. `deferred`(시작조차 못 함)와
   * 구분된다 — 이쪽은 일부만 동기화된 상태로 다음 패스에 이어진다.
   */
  budgetStoppedProjects: string[];
  /** `maxRuns`에 닿았고 다음에 실제 처리 가능한 run이 남은 프로젝트. */
  runLimitHits: Array<{ projectId: string; nextRunId: string }>;
  /**
   * `?projectIds=` 로 요청됐지만 **이번 패스의 싱크 대상에 없던** id 들.
   * **비어 있어야 정상이다** — 값이 있으면 요청한 프로젝트 일부가 아예 돌지
   * 않았다는 뜻이고, 그걸 조용히 버리면 "돌렸다고 믿는데 안 돈" 상태가 된다.
   * (오타·이미 지워진 프로젝트·로컬에 링크가 없는 scope id 가 여기 잡힌다.)
   */
  projectIdsNotFound: string[];
  perProject: Array<{
    projectId: string;
    runs?: number;
    answers?: number;
    skipped?: number;
    catalogUpdated?: number;
    /** 프롬프트 읽기 방식 — 증분이 실제로 켜졌는지 응답에서 바로 확인한다. */
    promptRead?: PromptReadMode;
    /** 이번 패스가 낸 목록 왕복 수(프롬프트·run). 증분 효과의 직접 지표. */
    promptPages?: number;
    runPages?: number;
    /** run 목록을 floor + 연속 정착 조건으로 중간에 끊었는가. */
    runScanStoppedEarly?: boolean;
    /** 프롬프트 창이 한 틱 상한에서 끊겨 다음 틱이 이어 읽는다(절단 아님). */
    promptResumePending?: boolean;
    /** 이전 floor 아래(크론 증분이 안 보는 구간)에서 다시 당긴 run 수 — 전체 대조의 증분 누락 지표. */
    pulledBelowFloor?: number;
    /**
     * 이번 패스에 써 봤지만 여전히 비종결이고 7일을 넘겨 floor 를 놓아준 run 수(좀비).
     * 그 run 의 이후 종료는 하루 1회 전체 대조가 잡는다 — 계속 0 이 아니면 좀비를 조사한다.
     */
    openRunsReleased?: number;
    error?: string;
  }>; // per-project breakdown (root + SCOPE_EXTRA_PROJECT_IDS)
}

// 크론 라우트 maxDuration(300s)보다 낮게 잡은 소프트 예산 — 초과 시 새 프로젝트를
// 시작하지 않고 깔끔히 이월한다(진행 중인 프로젝트를 Vercel이 강제 킬하는 대신).
// run 단위 트랜잭션 + terminal 워터마크라 강제 킬도 데이터는 안전하지만, 어떤
// 프로젝트가 밀렸는지 보고가 남지 않아 기아(starvation) 진단이 불가능했다.
//
// ⚠️ 이 값은 **상한이지 보장이 아니다.** 라우트는 회차 관제를 먼저 돌린 뒤 남은
// 시간으로 `budgetMs` 를 계산해 넘긴다(`app/api/cron/sync-mirror/route.ts` 헤더).
// 그래서 export 한다 — 두 곳이 250_000 을 각자 적으면 한쪽만 고치는 결함이 난다.
export const MIRROR_SYNC_BUDGET_MS = 250_000;
const SYNC_BUDGET_MS = MIRROR_SYNC_BUDGET_MS;

type MirrorSyncOptions = {
  force?: boolean;
  maxRuns?: number;
  resyncBefore?: Date;
  projectIds?: string[];
  promptsUpdatedFrom?: string;
  promptsUpdatedTo?: string;
  runsSince?: Date;
  runsUntil?: Date;
  /** 패스 전체 예산. 함수 시작 시점부터 계산한다. */
  budgetMs?: number;
  /** 프로젝트 하나가 사용할 수 있는 최대 벽시계 시간. */
  projectBudgetMs?: number;
  /**
   * 하루 1회 **전체 대조** 모드(`npm run mirror:reconcile`, 러너 박스 전용).
   * 증분 읽기·조기 종료를 끄고 목록 전량을 읽되, force 가 아니므로 워터마크 판정은
   * 정상으로 돌고 **워터마크를 새로 세운다**(루트의 첫 워터마크가 여기서 생긴다).
   */
  fullScan?: boolean;
  /** 프롬프트·run 목록 페이지 상한 덮어쓰기 — 전체 대조 스크립트 전용(크론은 기본값). */
  promptMaxPages?: number;
  runMaxPages?: number;
  /** Discovery only; a worker resumes the durable job outside this request. */
  queueBulkRun?: (run: MeasurementRunSummary, projectId: string, localProjectId: string | null) => Promise<void>;
};

function projectBudgetFor(opts: MirrorSyncOptions, totalBudgetMs: number): number {
  // A one-project local recovery explicitly owns the whole supplied budget.
  if (opts.projectBudgetMs != null) return opts.projectBudgetMs;
  if (opts.projectIds?.length === 1 && opts.budgetMs != null) return opts.budgetMs;
  // Keep the existing 250s behavior by default: the standard prompt cap alone
  // can take ~100s, so a hard 60s default would stop before runs are read.
  return totalBudgetMs;
}

// terminal run 재확인(회수 추적)으로 한 패스에서 다시 당길 run 수 상한.
// 영구 실패한 run 은 재확인해도 계속 미완으로 남으므로, 상한이 없으면 매 패스
// 같은 run 들을 다시 당기며 예산을 소모한다. 상한을 넘긴 나머지는 다음 패스로
// 넘어간다 — 회수는 몇 시간 단위라 하루 여러 패스면 충분히 따라잡는다.
export const RECHECK_MAX_RUNS_PER_PASS = 25;

/**
 * 싱크 순회 순서 (2026-08-13 기아 수정): 모든 프로젝트를 **마지막 시도가 오래된
 * 순**(미동기화 프로젝트 최우선, 동률은 root 우선 후 id 사전순)으로 정렬한다.
 * root를 매번 고정하던 순서는 300s 컷과 결합해 뒷순번 프로젝트가 영영 동기화되지
 * 않는 기아를 만들었다(제네시스 FR 사례 — scope 121런, 미러 0). oldest-first는
 * 어떤 패스에서 잘리든 다음 패스에서 밀린 쪽이 앞순번이 된다.
 *
 * ⚠️ 2026-08-20 재수정 — 그 전제는 **정렬 키가 매 시도마다 갱신될 때만** 성립한다.
 * 원래 키는 `max(scope_runs.synced_at)`(= 마지막으로 run 을 **쓴** 시각)이라,
 * 새 run 이 없어 아무것도 안 쓴 프로젝트는 키가 그대로 → 다음 패스에도 같은
 * 앞순번을 점유하고, 실제로 쓴 프로젝트만 뒤로 밀렸다. 결과적으로 순회 앞부분이
 * 굳어 예산(SYNC_BUDGET_MS) 밖 뒷순번은 영구 미도달이 된다 — 실측(2026-08-20
 * 프로덕션 크론 로그): 대상 176개 중 `deferred 89~102`, GENESIS GV80 HEV(1.1v)는
 * 2026-08-12 이후 scope 3회차분이 미러에 한 번도 안 들어옴.
 * → 키를 `scope_sync_cursors.last_attempt_at`(= 마지막 **시도**, 성공·실패·무작업
 *   전부 기록)로 바꾼다. mergeRotationKeys 참조.
 */
export function orderSyncTargets(
  rootId: string,
  ids: readonly string[],
  lastSynced: ReadonlyMap<string, Date>,
): string[] {
  const ordered = [...ids];
  ordered.sort((a, b) => {
    const ta = lastSynced.get(a)?.getTime() ?? 0;
    const tb = lastSynced.get(b)?.getTime() ?? 0;
    if (ta !== tb) return ta - tb;
    // 동률일 때만 root를 먼저 둔다. root도 마지막 시도 시각 기준으로
    // 순환에 참여해야 root 하나가 매 패스 예산을 독점하지 않는다.
    if (a === rootId && b !== rootId) return -1;
    if (b === rootId && a !== rootId) return 1;
    return a.localeCompare(b);
  });
  return ordered;
}

/**
 * 로테이션 정렬 키 병합 — 시도 커서(scope_sync_cursors)가 정본이고, 아직 커서가
 * 없는 프로젝트만 과거의 쓰기 시각(max(scope_runs.synced_at))으로 대체한다.
 * 0043 배포 직후엔 커서가 비어 있으므로 폴백이 기존 순서를 그대로 재현하고,
 * 한 패스가 지날 때마다 도달한 프로젝트가 커서를 얻어 뒤로 밀린다 — 즉 전체
 * 대상이 몇 패스 안에 모두 순회된다(정지 상태의 로테이션이 다시 돈다).
 * 순수 함수 (테스트 대상).
 */
/**
 * `?projectIds=` 대상 좁히기 (순수 함수, 테스트 대상).
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────────
 * 싱크는 매 패스 **181개 전부**를 순회한다. 특정 프로젝트만 재싱크하려 해도
 * 나머지 180개를 도느라 250s 예산이 소진되고, 특히 표준 루트는 prompts 50 +
 * runs 50 = **100 왕복을 `maxRuns` 와 무관하게 매번** 낸다(`maxRuns` 는 목록을
 * 다 페이징한 뒤 처리 루프에서 끊는다). 대상 밖 프로젝트에는 순수 낭비다.
 *
 * ── 설계 ────────────────────────────────────────────────────────────────
 * ① **루트를 특별 취급하지 않는다.** 요청에 없으면 루트도 뺀다 — 루트의 100
 *    왕복을 피하는 것이 이 파라미터의 주된 실익이기 때문이다. `orderSyncTargets`
 *    는 `ids` 에 루트가 없으면 그대로 나머지만 정렬하므로 그 계약과도 맞는다.
 * ② **못 찾은 id 를 조용히 버리지 않는다.** 오타 하나로 "돌렸다고 믿는데 안 돈"
 *    상태가 되는 것이 작성 시점에 반복해 값을 치른 실패 모양이다(조용한 페이지
 *    절단·조용한 재확인 상한). 호출부가 `projectIdsNotFound` 로 표면화한다.
 * ③ 순서는 **원본 순서를 보존**한다 — 로테이션 정렬(`orderSyncTargets`)이 이미
 *    적용된 배열을 받으므로, 여기서 재정렬하면 그 의미가 사라진다.
 */
export function selectSyncTargets(
  ids: readonly string[],
  projectIds: readonly string[] | undefined,
): { ids: string[]; notFound: string[] } {
  if (!projectIds || projectIds.length === 0) return { ids: [...ids], notFound: [] };
  const wanted = new Set(projectIds);
  const available = new Set(ids);
  return {
    ids: ids.filter((id) => wanted.has(id)),
    // 중복 요청은 한 번만 보고한다 — Set 순회라 입력 순서가 아니라 요청 순서를
    // 쓰려면 filter 가 필요하지만, 진단용 목록이라 결정성만 있으면 충분하다.
    notFound: [...wanted].filter((id) => !available.has(id)),
  };
}

export function mergeRotationKeys(
  attempts: ReadonlyMap<string, Date>,
  writes: ReadonlyMap<string, Date>,
): Map<string, Date> {
  const out = new Map(writes);
  for (const [id, at] of attempts) out.set(id, at);
  return out;
}

// ⚠ TEMP — multi-project sync via env (2026-06-23). 추후 hmg-geo 측에
// `project_scope_links` 테이블이 들어오면 SCOPE_EXTRA_PROJECT_IDS env 와 이
// 파싱 로직을 모두 제거하고 DB 에서 sync 대상 list 를 도출하도록 교체. 마킹
// 목적의 const — 같은 키워드(SCOPE_EXTRA_PROJECT_IDS)가 한 곳에 집중되어
// 있어야 이관 시 한 번에 grep 해서 정리 가능.
const SCOPE_EXTRA_PROJECT_IDS_ENV = "SCOPE_EXTRA_PROJECT_IDS";
function readExtraProjectIds(): string[] {
  const raw = process.env[SCOPE_EXTRA_PROJECT_IDS_ENV];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface OneProjectResult {
  runs: number;
  answers: number;
  skipped: number;
  /** `?resyncBefore=` 워터마크로 건너뛴 run 수. */
  resyncSkipped: number;
  /**
   * 이번 패스에서 재확인 상한(RECHECK_MAX_RUNS_PER_PASS)에 **닿았는지**.
   * 닿으면 나머지는 `skipped++` 로 조용히 섞여 사라진다 — pageCapHits 와 같은
   * 성격의 조용한 절단이라 함께 표면화한다.
   */
  recheckCapHit: boolean;
  /**
   * 재확인 잡 상한(`MIRROR_RECHECK_MAX_JOBS`)에 걸려 다시 당기지 않은 run 들.
   * 이 프로젝트 범위의 목록이고, 호출부가 `projectId` 를 붙여 보고에 올린다.
   */
  recheckDeferredHeavy: Array<{ runId: string; jobs: number }>;
  usedFallback: boolean;
  catalogUpdated: number;
  /**
   * 이번 패스에서 페이지 상한을 소진한 소스 종류 (`prompts` · `runs` · `jobs`).
   * 비어 있어야 정상 — 값이 있으면 그 소스는 **잘린 채** 미러됐다는 뜻이다.
   * jobs 는 run 마다 돌므로 종류로만 접는다(구체 run id 는 console.warn 에).
   */
  pageCapHits: string[];
  /**
   * 잡 상한을 **구조적으로** 넘어 이번 패스가 아예 손대지 않은 run 들.
   * **비어 있어야 정상이다** — 값이 있으면 그 회차는 미러에 들어오지 않는다.
   */
  oversizedRuns: Array<{ runId: string; totalJobs: number }>;
  /**
   * jobs 피드가 상한에 걸려 잘린 run 들. **부분 미러를 쓰지 않고 건너뛴 것**이다
   * (아래 truncated 분기 주석 참조) — 값이 있으면 그 run 은 미러에 없다.
   */
  truncatedRuns: string[];
  /** 패스 예산이 이 프로젝트의 run 루프 **도중에** 소진됐는가. */
  budgetStopped: boolean;
  /** maxRuns 뒤에 남은 다음 eligible run. */
  runLimitNextRunId?: string;
  promptRead: PromptReadMode;
  promptPages: number;
  runPages: number;
  runScanStoppedEarly: boolean;
  promptResumePending: boolean;
  pulledBelowFloor: number;
  openRunsReleased: number;
}

function isScopeDeadlineExceeded(error: unknown): boolean {
  return (
    error instanceof ScopeDeadlineExceededError ||
    (error instanceof Error && error.name === "ScopeDeadlineExceededError")
  );
}

function throwIfScopeDeadlineExceeded(deadlineAt: number): void {
  assertScopeDeadline(deadlineAt);
}

export interface MentionCanonicalizer {
  canonicalizeBrand(mention: ResolvedMention): ResolvedMention;
  canonicalizeProduct(
    mention: ResolvedMention,
    context?: { brandNameByRollupId: Map<string, string> },
  ): ResolvedMention;
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

export function buildMentionCanonicalizer(
  dict: Awaited<ReturnType<typeof getProjectTrackedDictionary>> | null,
): MentionCanonicalizer {
  if (!dict) {
    return {
      canonicalizeBrand: (mention) => mention,
      canonicalizeProduct: (mention) => mention,
    };
  }
  const brandAliases = new Map<string, string>();
  for (const brand of dict.brands) {
    for (const alias of brand.aliases) {
      brandAliases.set(norm(alias), brand.canonicalName);
    }
  }
  const modelAliasesByBrand = new Map<string, string>();
  const globalModelAliases = new Map<string, Set<string>>();
  for (const model of dict.models) {
    for (const alias of model.aliases) {
      const aliasKey = norm(alias);
      modelAliasesByBrand.set(`${norm(model.brand)}::${aliasKey}`, model.model);
      const global = globalModelAliases.get(aliasKey) ?? new Set<string>();
      global.add(model.model);
      globalModelAliases.set(aliasKey, global);
    }
  }
  return {
    canonicalizeBrand(mention) {
      const displayName = mention.display_name?.trim() ?? "";
      if (!displayName) return mention;
      if (mention.entity_type === "Brand") {
        const canonical = brandAliases.get(norm(displayName));
        return canonical ? { ...mention, display_name: canonical } : mention;
      }
      return mention;
    },
    canonicalizeProduct(mention, context) {
      const displayName = mention.display_name?.trim() ?? "";
      if (!displayName || mention.entity_type !== "Product") return mention;
      const aliasKey = norm(displayName);
      const brandRollupId = mention.rollups?.brand_entity_id ?? null;
      const brandName = brandRollupId
        ? context?.brandNameByRollupId.get(brandRollupId) ?? null
        : null;
      if (brandName) {
        const canonical = modelAliasesByBrand.get(`${norm(brandName)}::${aliasKey}`);
        return canonical ? { ...mention, display_name: canonical } : mention;
      }
      const globalMatches = globalModelAliases.get(aliasKey);
      if (globalMatches?.size === 1) {
        return { ...mention, display_name: [...globalMatches][0] ?? displayName };
      }
      return mention;
    },
  };
}

function mentionCanonicalKey(mention: ResolvedMention): string {
  const brandRollupId =
    mention.entity_type === "Product" ? (mention.rollups?.brand_entity_id ?? "") : "";
  return [
    mention.entity_type ?? "",
    mention.display_name ?? mention.entity_id,
    brandRollupId,
  ].join("::");
}

function buildBrandNameByRollupId(
  mentions: ResolvedMention[],
  canonicalizer: MentionCanonicalizer,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const mention of mentions) {
    if (mention.entity_type !== "Brand") continue;
    const canonical = canonicalizer.canonicalizeBrand(mention);
    const rollupId = canonical.rollups?.brand_entity_id ?? canonical.entity_id ?? null;
    const displayName = canonical.display_name?.trim() ?? "";
    if (rollupId && displayName) out.set(rollupId, displayName);
  }
  return out;
}

function canonicalizeMention(
  mention: ResolvedMention,
  canonicalizer: MentionCanonicalizer,
  context: { brandNameByRollupId: Map<string, string> },
): ResolvedMention {
  if (mention.entity_type === "Brand") {
    return canonicalizer.canonicalizeBrand(mention);
  }
  if (mention.entity_type === "Product") {
    return canonicalizer.canonicalizeProduct(mention, context);
  }
  return mention;
}

export function canonicalizeResolvedMentions(
  mentions: ResolvedMention[],
  canonicalizer: MentionCanonicalizer,
): ResolvedMention[] {
  const byCanonical = new Map<string, ResolvedMention>();
  const brandNameByRollupId = buildBrandNameByRollupId(mentions, canonicalizer);
  for (const mention of mentions) {
    if (!mention.entity_id) continue;
    const canonical = canonicalizeMention(mention, canonicalizer, { brandNameByRollupId });
    const key = mentionCanonicalKey(canonical);
    const current = byCanonical.get(key);
    byCanonical.set(key, current ? mergeMentionBucket(current, canonical) : canonical);
  }
  return [...byCanonical.values()];
}

// 발생 배열 → 미러 행 (0061). 부모 멘션의 entity/rollup 을 물려받는다 — 발생 자체에는
// 그 정보가 없고, 화면은 "이 발생이 어느 브랜드 것인가"로 필터 브랜드 우선 규칙을 돈다.
export function occurrenceRowsFor(
  jobId: string,
  m: ResolvedMention,
): MirrorMentionOccurrence[] {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return (m.occurrences ?? []).map((o) => ({
    jobId,
    entityId: m.entity_id,
    brandRollupEntityId: m.rollups?.brand_entity_id ?? null,
    turnIndex: o.turn_index ?? null,
    sourceStart: o.source_start,
    sourceEnd: o.source_end,
    surfaceText: o.surface_text,
    sentiment: o.sentiment,
    mentionRole: o.mention_role ?? null,
    assertion: o.assertion ?? null,
    contextSnippet: o.context_snippet ?? null,
    descriptors: arr(o.descriptors),
    criteria: arr(o.criteria),
  }));
}

// 답변 단위 브랜드 스탠스 배열 → 미러 행 (0072). `analysis.brand_stances` 는
// resolved_mentions 의 **형제**라 멘션 접힘(canonicalizeResolvedMentions)을 타지 않는다
// — 그래야 turn 축이 살아남는다(스펙 §5.1).
//
// ⚠️ 모르는 필드는 **버려진다.** 코어가 `analysis_version`·`source_turn_hash` 를
// 원소에 함께 싣기로 했지만(2026-09-14 코어 결정) 미러에는 그 컬럼이 없다 — 재분석의
// 옛 해시 배제는 **코어가 조인으로 보장**하는 전제이고, 미러는 코어가 내려준 것을
// 그대로 적재한다. 미러에서 그 두 축으로 걸러야 할 일이 생기면 컬럼 추가가 먼저다.
//
// 방어의 이유: 코어가 아직 이 필드를 안 내려주는 창(WU4 미배포)이 정상 상태이고,
// 그 창에서 `analysis.brand_stances` 는 undefined 다. 그때 **조용히 0행**을 내는 것이
// 이 함수의 계약이다(에러 아님 — WU7 AC2).
//
// 같은 (turn, entity) 가 두 번 오면 **뒤엣것을 버린다**. 미러 PK 가
// (job_id, turn_index, entity_id) 라, 중복을 그대로 넣으면 run 전체 트랜잭션이
// 23505 로 죽어 그 run 의 답변·멘션·인용까지 통째로 못 들어온다.
const STANCE_VALUES = new Set(["positive", "negative", "mixed", "neutral"]);
/** 미러 컬럼 타입이 uuid 다 — 아닌 값을 넣으면 22P02 로 **run 전체 트랜잭션**이 롤백된다. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** 컬럼이 integer(=int32) 다 — 범위를 넘으면 22003 으로 같은 롤백이 난다. */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const int32OrNull = (v: unknown): number | null => {
  // 문자열 "1" 도 받는다 — Number.isInteger 만 보면 조용히 0(turn) 으로 접혀
  // 2턴 답변의 두 턴이 같은 PK 로 충돌하고 뒤엣것이 버려진다(검증자 F4).
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX ? n : null;
};

export function stanceRowsFor(
  jobId: string,
  analysis: QueryAnalysisSummary | undefined,
): MirrorAnswerStance[] {
  const raw: ScopeBrandStance[] = Array.isArray(analysis?.brand_stances)
    ? analysis!.brand_stances!
    : [];
  const seen = new Set<string>();
  const rows: MirrorAnswerStance[] = [];
  let dropped = 0;
  for (const s of raw) {
    // ⚠️ 여기서 거르는 값은 전부 **DB 타입 위반**이다. 한 행만 통과해도 insert 가
    // 22P02/22003 으로 죽고, replaceRun 이 단일 트랜잭션이라 그 run 의 답변·멘션·
    // 인용까지 통째로 못 들어온다. 그래서 조용히 버리지 않고 건수를 센다(F3·F4).
    if (!s || typeof s.entity_id !== "string" || !UUID_RE.test(s.entity_id)) {
      dropped++;
      continue;
    }
    if (typeof s.stance !== "string" || !STANCE_VALUES.has(s.stance)) {
      dropped++;
      continue;
    }
    // turn_index 는 PK 구성요소 + NOT NULL — 범위 밖·비정수면 그 행을 버린다.
    // (0 으로 접으면 다른 턴의 행을 밀어내므로 폴백이 더 나쁘다.)
    const turnIndex = s.turn_index == null ? 0 : int32OrNull(s.turn_index);
    if (turnIndex == null) {
      dropped++;
      continue;
    }
    const key = `${turnIndex}:${s.entity_id}`;
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    // 오프셋은 **쌍으로만** 신뢰한다 — 한쪽만 오면 "원문 대조됨"이 거짓이 되므로 둘 다 버린다.
    const start = int32OrNull(s.evidence_start);
    const end = int32OrNull(s.evidence_end);
    const paired = start != null && end != null && end > start;
    rows.push({
      jobId,
      turnIndex,
      entityId: s.entity_id,
      brandLabel: typeof s.brand_label === "string" ? s.brand_label : null,
      isTracked: s.is_tracked === true,
      stance: s.stance,
      confidence: typeof s.confidence === "number" ? s.confidence : null,
      evidenceText: typeof s.evidence_text === "string" && s.evidence_text ? s.evidence_text : null,
      evidenceStart: paired ? start : null,
      evidenceEnd: paired ? end : null,
      reason: typeof s.reason === "string" && s.reason ? s.reason : null,
      modelSlug: typeof s.model_slug === "string" && s.model_slug ? s.model_slug : null,
    });
  }
  if (dropped > 0) {
    // 커버리지 구멍의 유일한 신호다 — 코어가 어휘를 넓히거나 id 형식을 바꾸면
    // 여기서만 보인다(콜은 전부 200 이라 알람이 울지 않는다).
    console.warn(
      `[mirror] 스탠스 ${dropped}행 드롭 — job=${jobId} (uuid·어휘·turn 범위·중복 중 하나). 코어 계약 변경 여부 확인.`,
    );
  }
  return rows;
}

function mergeMentionBucket(
  current: ResolvedMention,
  next: ResolvedMention,
): ResolvedMention {
  return {
    ...current,
    mention_count: (current.mention_count ?? 0) + (next.mention_count ?? 0),
    surfaces: [...new Set([...(current.surfaces ?? []), ...(next.surfaces ?? [])])],
    // 발생 배열도 이어 붙인다(리뷰 I1). 빼먹으면 "Genesis"/"제네시스" 처럼 서로 다른
    // 엔티티가 같은 canonical 로 접힐 때 **뒤 엔티티의 발생이 미러에 영원히 도달하지
    // 않는다** — 밑줄도 캡션도 안 나온다. 접힌 쪽은 정의상 같은 브랜드이므로
    // occurrenceRowsFor 가 current 의 entity_id/rollups 를 물려줘도 정합이 맞는다.
    occurrences: [...(current.occurrences ?? []), ...(next.occurrences ?? [])],
    avg_position:
      current.avg_position == null
        ? next.avg_position ?? null
        : next.avg_position == null
          ? current.avg_position
          : Math.min(current.avg_position, next.avg_position),
    sentiment: {
      positive: (current.sentiment?.positive ?? 0) + (next.sentiment?.positive ?? 0),
      neutral: (current.sentiment?.neutral ?? 0) + (next.sentiment?.neutral ?? 0),
      negative: (current.sentiment?.negative ?? 0) + (next.sentiment?.negative ?? 0),
      mixed: (current.sentiment?.mixed ?? 0) + (next.sentiment?.mixed ?? 0),
    },
    type_breakdown: {
      mention: (current.type_breakdown?.mention ?? 0) + (next.type_breakdown?.mention ?? 0),
      recommendation:
        (current.type_breakdown?.recommendation ?? 0) +
        (next.type_breakdown?.recommendation ?? 0),
      comparison:
        (current.type_breakdown?.comparison ?? 0) +
        (next.type_breakdown?.comparison ?? 0),
      definition:
        (current.type_breakdown?.definition ?? 0) +
        (next.type_breakdown?.definition ?? 0),
      final_choice:
        (current.type_breakdown?.final_choice ?? 0) +
        (next.type_breakdown?.final_choice ?? 0),
    },
  };
}


// ACR 반복 job dedup — 같은 prompt-run(= ACR 셀의 반복 10회)에 속한 job들 중
// 대표 1개(완료 우선, 최신 measured_at)만 남긴다 (순수 함수, 테스트 대상).
// 이유: ACR 셀은 반복마다 job(=답변 행)이 생기는데, 이를 전부 미러에 쌓으면
// 스냅샷 KPI는 셀당 최신 1개 dedup이라 무해하지만 추이(allRuns) 집계가 원시
// 행을 세므로 ACR 프롬프트가 반복수만큼(≈10배) 과대가중된다. 미러가 대표
// turn1 답변 1개만 담으면 모든 기존 대시보드 읽기(스냅샷·추이·언급/인용
// 분석)가 ACR 프롬프트를 단발 프롬프트와 동일하게 1표로 취급한다 — 반복
// 단위 디테일은 scope_acr_rollups가 전담.
//
// ⚠️ acr_summary 는 **분석이 붙은 job 에만** 있다. 실패한 job 은 분석이 없어
// prompt_run_id 가 없고, 그래서 2026-08-28 까지 반복 10개가 전부 개별 행으로
// 미러에 쌓였다 — 완주는 1행/실패는 10행이 되어 화면에서 실패가 ~10배 무게로
// 잡혔다(표준 회차 실측: 미러 실패 61% vs 정본 13%). 그래서 acr_summary 가
// 없는 job 은 (prompt_id, target, region) 을 대체 키로 접는다. 반복이 1회뿐인
// 비-ACR 프로젝트에서는 키당 job 이 하나라 무연산이다. prompt_id 가 없는 job 은
// 서로를 구분할 수 없으므로 접지 않고 그대로 통과시킨다.
// ACR 셀 좌표 — (prompt, target, region). 분석이 없는 job 도 갖는 값이라
// prompt_run_id 의 대체 키를 만드는 재료가 된다.
function cellKeyForJob(job: MeasurementJob): string | null {
  if (!job.prompt_id) return null;
  return `${job.prompt_id}|${job.target}|${job.region ?? ""}`;
}

// 반복 폴딩 키.
//  1순위: scope 가 준 prompt_run_id — 분석이 붙은 job 만 갖는다.
//  2순위: 같은 run·같은 셀의 **분석 있는 형제 job** 이 알려준 prompt_run_id.
//         실패한 반복이 자기 prompt_run 그룹에 정확히 합류한다.
//  3순위: 셀 좌표 자체 — 그 셀의 반복이 전부 실패해 형제가 없을 때.
// 2·3순위는 미완주 job 에만 적용한다. 어느 것도 못 만들면 null = 접지 않고 통과.
export function foldKeyForJob(
  job: MeasurementJob,
  promptRunByCell: Map<string, string>,
): string | null {
  const pr = job.analysis?.acr_summary?.prompt_run_id;
  if (pr) return `pr:${pr}`;
  // 대체 키는 **미완주 job 에만** 쓴다. 완주했는데 acr_summary 가 없는 job 은
  // 반복이 아니라 단발 측정이므로 예전처럼 그대로 통과시킨다 — 결함은 분석이
  // 안 붙는 실패 반복에만 있었고, 폴딩 범위를 넓히면 정상 측정을 삼킬 수 있다.
  if (job.status === "completed") return null;
  const cell = cellKeyForJob(job);
  if (!cell) return null;
  const sibling = promptRunByCell.get(cell);
  return sibling ? `pr:${sibling}` : `cell:${cell}`;
}

export function dedupeAcrIterationJobs(jobs: MeasurementJob[]): MeasurementJob[] {
  const better = (a: MeasurementJob, b: MeasurementJob): MeasurementJob => {
    const ac = a.status === "completed" ? 1 : 0;
    const bc = b.status === "completed" ? 1 : 0;
    if (ac !== bc) return ac > bc ? a : b;
    return (a.measured_at ?? "") >= (b.measured_at ?? "") ? a : b;
  };
  // 셀 → prompt_run_id 사전. 분석이 있는 job 에서만 만들어진다. 한 셀에 여러
  // prompt_run 이 있으면(재측정) 첫 번째를 쓴다 — 실패 반복을 어느 쪽에 붙이든
  // 대표는 1개로 같고, 완주 job 은 자기 pr 키를 그대로 쓰므로 섞이지 않는다.
  const promptRunByCell = new Map<string, string>();
  for (const job of jobs) {
    const pr = job.analysis?.acr_summary?.prompt_run_id;
    const cell = cellKeyForJob(job);
    if (pr && cell && !promptRunByCell.has(cell)) promptRunByCell.set(cell, pr);
  }

  const repByPromptRun = new Map<string, MeasurementJob>();
  const out: MeasurementJob[] = [];
  for (const job of jobs) {
    const key = foldKeyForJob(job, promptRunByCell);
    if (!key) {
      out.push(job);
      continue;
    }
    const cur = repByPromptRun.get(key);
    repByPromptRun.set(key, cur ? better(cur, job) : job);
  }
  return [...out, ...repByPromptRun.values()];
}

// ACR 롤업 수집 — prompt-run 단위 dedup + 엔티티 이름 해소 (순수 함수, 테스트
// 대상). scope는 같은 prompt-run에 속한 반복 job들마다 동일한 acr_summary를
// 반복 반환하므로 prompt_run_id 키로 한 번만 취한다. rows에는 엔티티 표시명이
// 없어서(entityId만) run 전체 jobs의 resolved_mentions로 id→이름 사전을 만들어
// brand/parent_brand를 해소한다 — 특정 job에 안 나온 엔티티도 같은 run의 다른
// job에서 이름이 나오는 경우가 흔하다 (scope 조사 2026-07-07).
/**
 * 한 prompt-run 의 ACR rows 를 **엔티티당 1행**으로 접는다 (순수 함수, 테스트 대상).
 *
 * 미러 PK 가 (prompt_run_id, entity_id) 라서 같은 엔티티의 두 rollupLevel 을
 * 함께 담을 수 없다. 남길 하나를 **결정적으로** 고른다 — brand 레벨 우선,
 * 동률이면 먼저 온 행. (무작위로 고르면 패스마다 값이 흔들려 KPI 가 떤다.)
 */
/**
 * 커서(`scope_sync_cursors.last_error`)에 남길 에러 문자열 (순수 함수, 테스트 대상).
 *
 * ── 왜 필요한가 (2026-09-13 실측) ────────────────────────────────────────
 * drizzle 은 실패한 SQL 을 `Failed query: insert into … values ($1, $2, …)` +
 * **파라미터 전량**으로 message 에 담고, Postgres 의 실제 사유(`code`·`detail`·
 * `constraint`)는 `err.cause` 에만 둔다. 종전 코드는 `cause.message` 만 뒤에
 * 붙였는데, 앞의 래퍼가 **253,517자**라 커서에는 파라미터 덤프만 남고
 * `duplicate key value violates unique constraint` 는 끝내 안 보였다.
 *
 * 그래서 규칙을 뒤집는다: **PG 사유를 맨 앞에**, 래퍼는 잘라서 뒤에. 진단에
 * 필요한 것이 앞 200자 안에 항상 들어오고, 커서 행이 250KB 로 붓지도 않는다.
 */
export const SYNC_ERROR_MAX_CHARS = 2_000;
export function describeSyncError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err.cause as Record<string, unknown> | undefined) : undefined;
  if (!cause) return base.slice(0, SYNC_ERROR_MAX_CHARS);
  const pg = [
    cause.code ? `code=${String(cause.code)}` : "",
    cause.constraint_name ? `constraint=${String(cause.constraint_name)}` : "",
    cause.constraint ? `constraint=${String(cause.constraint)}` : "",
    cause.table_name ? `table=${String(cause.table_name)}` : "",
    typeof cause.message === "string" ? cause.message : "",
    typeof cause.detail === "string" ? cause.detail : "",
  ]
    .filter(Boolean)
    .join(" ");
  const head = pg || String(cause);
  // PG 사유를 통째로 보존하고, 남는 자리에만 drizzle 래퍼를 덧댄다.
  const room = SYNC_ERROR_MAX_CHARS - head.length - " | query: ".length;
  return room > 0 ? `${head} | query: ${base.slice(0, room)}` : head.slice(0, SYNC_ERROR_MAX_CHARS);
}

export function dedupeAcrRowsByEntity<T extends { entityId: string; rollupLevel?: string | null }>(
  rows: readonly T[],
): T[] {
  const byEntity = new Map<string, T>();
  for (const r of rows) {
    const prev = byEntity.get(r.entityId);
    if (!prev || (r.rollupLevel === "brand" && prev.rollupLevel !== "brand")) {
      byEntity.set(r.entityId, r);
    }
  }
  return [...byEntity.values()];
}

export type AcrEntityNames = Map<string, { name: string | null; brandRollup: string | null }>;

/**
 * 엔티티 이름 사전을 **누적**한다 (순수 함수, 테스트 대상).
 *
 * 슬라이스 모드는 jobs 를 한 번에 못 쥐므로(그게 OOM 의 원인이다) 사전을
 * 페이지마다 이 함수로 키워 나간다. `into` 를 안 주면 종전처럼 새로 만든다 —
 * 한 번에 부르면 결과가 종전과 **비트 단위로 같다**.
 */
export function collectAcrEntityNames(
  jobs: MeasurementJob[],
  into: AcrEntityNames = new Map(),
): AcrEntityNames {
  for (const job of jobs) {
    for (const rm of job.analysis?.resolved_mentions ?? []) {
      const prev = into.get(rm.entity_id);
      if (!prev || (!prev.name && rm.display_name)) {
        into.set(rm.entity_id, {
          name: rm.display_name ?? prev?.name ?? null,
          brandRollup: rm.rollups?.brand_entity_id ?? prev?.brandRollup ?? null,
        });
      }
    }
  }
  return into;
}

/**
 * prompt-run 하나의 ACR 스냅샷 — 이름 해소 **전**의 원재료.
 *
 * 이름 해소를 미루는 이유: 이름 사전은 run **전체**에서 가장 풍부하다("특정
 * job 에 안 나온 엔티티도 같은 run 의 다른 job 에서 이름이 나오는 경우가 흔하다"
 * — scope 조사 2026-07-07). 슬라이스마다 해소해 버리면 그 슬라이스가 본 이름만
 * 쓰게 되어, **같은 run 이 한 번에 처리됐을 때와 다른 값**이 저장된다.
 * 그래서 슬라이스는 rows 만 모으고(가볍다 — 잡이 아니라 prompt-run 단위),
 * 해소는 피드를 다 읽은 뒤 `acrRollupRows` 가 한 번에 한다.
 */
export interface AcrPromptRunSnapshot {
  promptRunId: string;
  promptId: string | null;
  target: string;
  region: string | null;
  measuredAt: string | null;
  rows: AcrRollupRow[];
}

/** prompt-run 스냅샷을 **누적**한다 (순수 함수, 테스트 대상). */
export function collectAcrPromptRuns(
  jobs: MeasurementJob[],
  into: Map<string, AcrPromptRunSnapshot> = new Map(),
): Map<string, AcrPromptRunSnapshot> {
  for (const job of jobs) {
    const acr = job.analysis?.acr_summary;
    if (!acr?.prompt_run_id || (acr.rows?.length ?? 0) === 0) continue;
    // 마지막에 본 job의 셀 좌표가 이김 — 같은 prompt-run의 job들은
    // prompt×engine×region이 동일하므로 어느 job에서 읽어도 같다.
    //
    // ⚠️ scope 는 **같은 엔티티를 두 rollupLevel(brand·product)로 함께** 돌려줄
    // 수 있다. 미러 PK 는 (prompt_run_id, entity_id) 뿐이라(schema.ts
    // scopeAcrRollups) 그대로 넣으면 23505 가 나고, `replaceRun` 이 단일
    // 트랜잭션이라 **그 run 의 answers·mentions·citations·scope_runs upsert 까지
    // 통째로 롤백**된다. run 행이 안 써지니 워터마크도 안 생겨 다음 패스가 같은
    // run 에서 또 죽는다 — 즉 그 프로젝트의 싱크가 영구 정지한다.
    // (2026-09-09 회차 7 최초 관측 → 2026-09-13 루트 커서 last_error 로 재발.)
    //
    // 여기서는 **엔티티당 1행, brand 레벨 우선**으로 접는다. 근본 조치는 PK 에
    // rollup_level 을 더해 두 레벨을 모두 보존하는 것이며 마이그레이션이라 별건이다.
    const rowsDeduped = dedupeAcrRowsByEntity(acr.rows ?? []);
    if (rowsDeduped.length !== (acr.rows?.length ?? 0)) {
      console.warn(
        `[mirror] ACR ROLLUP DEDUP — prompt_run=${acr.prompt_run_id} rows ` +
          `${acr.rows?.length ?? 0}→${rowsDeduped.length}: 같은 엔티티가 여러 rollup_level 로 왔다. ` +
          `PK(prompt_run_id, entity_id) 가 한 레벨만 담을 수 있어 brand 레벨을 남긴다.`,
      );
    }
    into.set(acr.prompt_run_id, {
      promptRunId: acr.prompt_run_id,
      promptId: job.prompt_id ?? null,
      target: job.target,
      region: job.region ?? null,
      measuredAt: job.measured_at ?? null,
      rows: rowsDeduped,
    });
  }
  return into;
}

/** 스냅샷 + 이름 사전 → 미러 행 (순수 함수, 테스트 대상). */
export function acrRollupRows(
  snapshots: Map<string, AcrPromptRunSnapshot>,
  entityNames: AcrEntityNames,
  runId: string,
): MirrorAcrRollup[] {
  const out: MirrorAcrRollup[] = [];
  for (const snap of snapshots.values()) {
    for (const r of snap.rows) {
      const named = entityNames.get(r.entityId);
      const brandRollupId = named?.brandRollup ?? null;
      const co = r.choiceOutcomeBreakdown ?? {};
      out.push({
        promptRunId: snap.promptRunId,
        entityId: r.entityId,
        runId,
        promptId: snap.promptId,
        target: snap.target,
        region: snap.region,
        measuredAt: snap.measuredAt ? new Date(snap.measuredAt) : null,
        rollupLevel: r.rollupLevel ?? null,
        brand: named?.name ?? null,
        parentBrand:
          brandRollupId && brandRollupId !== r.entityId
            ? (entityNames.get(brandRollupId)?.name ?? null)
            : (named?.name ?? null),
        brandRollupEntityId: brandRollupId,
        entityType: null,
        plannedIterations: r.plannedIterations ?? 0,
        validTurn1Iterations: r.validTurn1Iterations ?? 0,
        validAcrIterations: r.validAcrIterations ?? 0,
        appearanceCount: r.appearanceCount ?? 0,
        choiceCount: r.choiceCount ?? 0,
        conditionalChoiceCount: r.conditionalChoiceCount ?? 0,
        offShortlistChoiceCount: r.offShortlistChoiceCount ?? 0,
        unresolvedChoiceCount: r.unresolvedChoiceCount ?? 0,
        genericChoiceCount: r.genericChoiceCount ?? 0,
        appearanceRate: r.appearanceRate ?? null,
        acr: r.acr ?? null,
        overallChoiceShare: r.overallChoiceShare ?? null,
        coSingleEntity: co.single_entity ?? 0,
        coConditionalMultiple: co.conditional_multiple ?? 0,
        coGenericCategory: co.generic_category ?? 0,
        coResolvedOffShortlist: co.resolved_off_shortlist ?? 0,
        coUnresolvedChoice: co.unresolved_choice ?? 0,
        coNone: co.none ?? 0,
      });
    }
  }
  return out;
}

/**
 * 한 run 의 jobs 전량 → ACR 미러 행. **종전 계약 그대로**(크론 경로가 쓴다).
 * 슬라이스 모드는 위의 두 누적 함수 + `acrRollupRows` 를 직접 쓴다.
 */
export function collectAcrRollups(
  jobs: MeasurementJob[],
  runId: string,
): MirrorAcrRollup[] {
  return acrRollupRows(collectAcrPromptRuns(jobs), collectAcrEntityNames(jobs), runId);
}


export interface MirrorRowSink {
  answers: MirrorAnswer[];
  mentions: MirrorMention[];
  occurrences: MirrorMentionOccurrence[];
  stances: MirrorAnswerStance[];
  citations: MirrorCitation[];
}

export function newMirrorRowSink(): MirrorRowSink {
  return { answers: [], mentions: [], occurrences: [], stances: [], citations: [] };
}

/** Shared mapping for the atomic mirror and resumable recovery. */
export async function appendJobRows(job: MeasurementJob, ctx: {
  client: ScopeClient;
  runId: string;
  canonicalizer: MentionCanonicalizer;
  sink: MirrorRowSink;
  catalogStatusUpdates: Map<string, CatalogPromptStatus>;
  deadlineAt?: number;
  requireResult?: boolean;
}): Promise<boolean> {
  const { client, runId, canonicalizer, sink, catalogStatusUpdates } = ctx;
  const deadlineAt = ctx.deadlineAt ?? Number.POSITIVE_INFINITY;
  let usedFallback = false;
  throwIfScopeDeadlineExceeded(deadlineAt);
  let result = job.result;
  if (!result && job.status === "completed") {
    usedFallback = true;
    try {
      result = (await client.getQueryRun(job.job_id)).result;
      throwIfScopeDeadlineExceeded(deadlineAt);
    } catch (error) {
      // A deadline is a project stop, not an optional fallback miss. Let
      // the caller record it and move to the next project; only ordinary
      // /query failures are tolerated for an answer with no result body.
      if (isScopeDeadlineExceeded(error) || ctx.requireResult) throw error;
      // leave result undefined — answer mirrored without text/citations
    }
  }

  if (ctx.requireResult && job.status === "completed" && !result) {
    throw new Error("Completed job result unavailable");
  }

  sink.answers.push({
    jobId: job.job_id,
    runId,
    promptId: job.prompt_id ?? null,
    target: job.target,
    region: job.region ?? null,
    status: job.status,
    measuredAt: job.measured_at ? new Date(job.measured_at) : null,
    modelSlug: result?.model_slug ?? null,
    answerText: result?.answer_text ?? null,
  });

  if (job.prompt_id) {
    const derived = jobStatusToCatalogStatus(job.status);
    const current = catalogStatusUpdates.get(job.prompt_id);
    catalogStatusUpdates.set(
      job.prompt_id,
      current ? mergeCatalogStatus(current, derived) : derived,
    );
  }

  for (const raw of canonicalizeResolvedMentions(
    job.analysis?.resolved_mentions ?? [],
    canonicalizer,
  )) {
    // scope's NER is case-insensitive, so a brand colliding with a common
    // word (e.g. SEAT vs. "car seat") gets over-counted from noun usage
    // — see case-sensitive-brands.ts. Drops the row when the recount
    // finds zero genuine exact-case occurrences.
    const m = correctCaseSensitiveBrandMention(raw, result?.answer_text ?? null);
    if (!m) continue;
    sink.mentions.push({
      jobId: job.job_id,
      entityId: m.entity_id,
      brand: m.display_name ?? null,
      entityType: m.entity_type ?? null,
      mentionCount: m.mention_count ?? 0,
      sentimentPositive: m.sentiment?.positive ?? 0,
      sentimentNeutral: m.sentiment?.neutral ?? 0,
      sentimentNegative: m.sentiment?.negative ?? 0,
      sentimentMixed: m.sentiment?.mixed ?? 0,
      avgPosition: m.avg_position ?? null,
      surfaces: m.surfaces ?? null,
      brandRollupEntityId: m.rollups?.brand_entity_id ?? null,
      typeMention: m.type_breakdown?.mention ?? 0,
      typeRecommendation: m.type_breakdown?.recommendation ?? 0,
      typeComparison: m.type_breakdown?.comparison ?? 0,
      typeDefinition: m.type_breakdown?.definition ?? 0,
      typeFinalChoice: m.type_breakdown?.final_choice ?? 0,
    });
    sink.occurrences.push(...occurrenceRowsFor(job.job_id, m));
  }

  // One stance set per job, including jobs with no resolved mentions.
  sink.stances.push(...stanceRowsFor(job.job_id, job.analysis));

  for (const c of result?.citations ?? []) {
    const host = hostFromUrl(c?.url);
    sink.citations.push({
      jobId: job.job_id,
      url: c?.url ?? null,
      domain: host ? registrableDomainOfHost(host) : null,
      title: c?.title ?? null,
      refIndex: c?.refIndex ?? null,
      // Preserve scope's domain-classifier category so the standard Citation
      // Sources card/pie/badge populate on the mirror path (subcategory 폐기).
      category: c?.category ?? null,
    });
  }
  return usedFallback;
}

export function slimJobForFold(job: MeasurementJob): MeasurementJob {
  const pr = job.analysis?.acr_summary?.prompt_run_id;
  return {
    job_id: job.job_id,
    prompt_id: job.prompt_id ?? null,
    target: job.target,
    region: job.region ?? null,
    status: job.status,
    measured_at: job.measured_at,
    ...(pr
      ? {
          analysis: {
            status: job.analysis?.status ?? "completed",
            acr_summary: { prompt_run_id: pr, rows: [] },
          },
        }
      : {}),
  };
}

/**
 * 패스 1회분의 미러 run 상태를 계산한다.
 *
 * ⚠️ **프로젝트 루프 밖에서 한 번만 부른다.** `mirroredRunStates()` 에는
 * 프로젝트 필터가 없어 호출마다 `scope_runs` 전체를 훑는다 — 프로덕션 실측
 * (EXPLAIN ANALYZE): Seq Scan 24,528행 + 서브플랜 Seq Scan 141,879행,
 * `shared hit=51,710`, **175ms/호출**. 종전처럼 `syncOneProject` 안에서 부르면
 * 패스당 35 프로젝트에 ~6.1s, 181 프로젝트 전부면 ~32s(예산 250s 의 13%)를
 * 같은 결과를 다시 만드는 데 쓴다.
 *
 * 프로젝트별로 나눌 필요가 없는 이유: `run_id` 는 프로젝트 간 겹치지 않으므로
 * 한 맵을 공유해도 교차 간섭이 없고, 패스 중 자기 쓰기를 다시 읽어야 할
 * 이유도 없다(재싱크 판정은 **패스 시작 시점** 기준이어야 한다 — 그래야
 * 이번 패스가 방금 쓴 run 을 같은 패스에서 다시 집지 않는다).
 */
async function loadMirroredRunStates(opts: {
  force?: boolean;
  resyncBefore?: Date;
}): Promise<Map<string, MirroredRunState>> {
  // force 는 미러 상태를 무시하지만, 워터마크(`?resyncBefore=`)를 쓰려면 그
  // 상태가 **반드시 필요하다** — 무엇을 이미 재싱크했는지가 거기에만 있다.
  // ⚠️ 이 경로(force + resyncBefore)는 종전에 force 가 **건너뛰던** 쿼리를
  // 새로 지불한다. 호이스트로 패스당 1회로 묶은 이유가 이것이다.
  if (opts.force && !opts.resyncBefore) return new Map<string, MirroredRunState>();
  return scopeMirrorRepository.mirroredRunStates();
}

async function syncOneProject(
  client: ScopeClient,
  projectId: string,
  localProjectId: string | null,
  opts: MirrorSyncOptions,
  // 패스 시작 시 **1회** 계산해 넘긴다 — 아래 호이스트 주석 참조.
  mirrored: Map<string, MirroredRunState>,
  // 이 패스의 벽시계 마감(ms epoch). `Infinity` = 무제한(로컬 회수 도구 경로).
  deadlineAt: number = Number.POSITIVE_INFINITY,
  // 이번 패스의 jobs 페이지 실측 페이스 — 프로젝트 사이에 **공유**한다(예산 인지
  // 중단의 분모). 안 넘기면 프로젝트 지역 페이스로 떨어질 뿐 동작은 같다.
  pacing: PassPacing = createPassPacing(),
  // 증분 워터마크. `null` = 기능 비활성(0082 미적용·조회 실패) → 종전 전량 읽기, 쓰기 없음.
  // `undefined` = 기능은 켜졌지만 이 프로젝트의 워터마크가 아직 없다(첫 패스).
  // ⚠️ 기본값을 두지 않는다 — JS 기본 매개변수는 `undefined` 를 기본값으로 바꿔 버려
  // "첫 패스"가 "비활성"으로 뭉개진다(테스트로 잡은 실제 결함).
  watermark: ProjectSyncWatermark | null | undefined,
): Promise<OneProjectResult> {
  const canonicalizer = buildMentionCanonicalizer(
    localProjectId ? await getProjectTrackedDictionary(localProjectId) : null,
  );
  // prompts (text + funnel stage + 언어·시장) — small, always refreshed
  const pageCapHits = new Set<string>();
  // ⚠️ 프롬프트 목록은 `created_at DESC` 정렬 + 페이지 상한(PROMPT_MAX_PAGES ×
  // 100 = 5,000)이라 **오래된 프롬프트가 영구히 잘린다.** 루트 프로젝트는
  // 12,446개로 상한을 크게 넘어, 2026-09-01 실측에서 미러에 4,146개가 없었고
  // 그중 `lang` 백필분 2,986개가 반영되지 않았다.
  //
  // `updated_from` 은 scope 라우트가 이미 지원한다(`lib/prompts/store.ts` 의
  // `gte(prompts.updatedAt, …)`). 창을 좁히면 **그 안에서는 상한에 안 걸리므로**
  // 절단 없이 전량을 가져올 수 있다 — 백필처럼 특정 시점 이후 갱신분만
  // 회수해야 할 때가 정확히 이 경우다.
  //
  // 미지정(기본)이면 **증분 워터마크**(scope_sync_watermarks)로 창을 스스로 정한다
  // — planPromptRead 참조. 워터마크가 없거나 0082 미적용이면 종전처럼 최신 5,000개.
  const watermarksEnabled = watermark !== null;
  const promptPlan = planPromptRead({
    watermarksEnabled,
    explicitWindow: Boolean(opts.promptsUpdatedFrom || opts.promptsUpdatedTo),
    force: Boolean(opts.force),
    fullScan: Boolean(opts.fullScan),
    syncedThrough: watermark?.promptsSyncedThrough,
    resume: watermark?.promptsResume,
  });
  // 워터마크 후보 = **읽기 시작** 시각. 끝 시각을 쓰면 읽는 동안 갱신된 프롬프트가
  // (뒤 페이지에서 못 봤는데도) 워터마크 안쪽으로 들어가 영영 안 읽힌다.
  const promptReadStartedAt = new Date();
  const promptUpdatedFrom =
    promptPlan.mode === "window" ? opts.promptsUpdatedFrom : promptPlan.updatedFrom;
  let promptPage: Awaited<ReturnType<typeof pageAll<Prompt>>>;
  try {
    promptPage = await pageAll(
      (cursor) =>
        client.listPrompts(projectId, {
          limit: 100,
          cursor,
          ...(promptUpdatedFrom ? { updated_from: promptUpdatedFrom } : {}),
          ...(promptPlan.mode === "window" && opts.promptsUpdatedTo
            ? { updated_to: opts.promptsUpdatedTo }
            : {}),
        }),
      {
        // 이어 읽기 창은 한 틱 상한(PROMPT_TICK_MAX_PAGES)만 쓰고 나머지는 다음 틱으로.
        maxPages: opts.promptMaxPages ?? (promptPlan.resumable ? PROMPT_TICK_MAX_PAGES : PROMPT_MAX_PAGES),
        label: `prompts(project=${projectId}, ${promptPlan.mode})`,
        deadlineAt,
        startCursor: promptPlan.startCursor,
        resumable: promptPlan.resumable,
      },
    );
  } catch (error) {
    // 저장해 둔 커서가 더는 유효하지 않으면(코어 배포로 커서 형식 변경 등) 매 틱 같은 자리에서
    // 죽는다 — 이어 읽기 상태를 비워 다음 틱이 워터마크 창부터 새로 읽게 한다. 데드라인은
    // 커서 문제가 아니므로 상태를 그대로 둔다.
    if (promptPlan.mode === "resume" && !isScopeDeadlineExceeded(error)) {
      await recordWatermarkSafely("prompt-resume-clear", projectId, () =>
        scopeMirrorRepository.clearPromptResume(projectId),
      );
    }
    throw error;
  }
  throwIfScopeDeadlineExceeded(deadlineAt);
  // 이어 읽기 창이 한 틱 상한에서 끊긴 것은 **절단이 아니다**(커서를 저장한다). 그 밖의 절단만
  // pageCapHits(= 잘린 채 미러됐다)로 올린다.
  const promptResumeNext =
    promptPlan.resumable && promptPage.truncated ? promptPage.nextCursor : undefined;
  if (promptPage.truncated && !promptResumeNext) pageCapHits.add("prompts");
  const prompts = promptPage.items;
  throwIfScopeDeadlineExceeded(deadlineAt);
  await scopeMirrorRepository.upsertPrompts(
    prompts.map((p) => ({
      promptId: p.prompt_id,
      text: p.text ?? null,
      funnelStage: p.funnel_stage ?? null,
      // 언어·시장 (migration 0048). scope 가 정본 — 응답에 없으면 NULL(=상속)로
      // 내려간다. 빈 배열도 그대로 보존한다: scope 의 "미지정"과 "0개 시장"을
      // 미러가 임의로 합치지 않는다(집계 술어가 cardinality 로 가른다).
      lang: p.lang ?? null,
      regions: p.regions ?? null,
    })),
  );
  // 워터마크는 upsert 가 **성공한 뒤에만**, 그리고 창을 **끝까지** 읽었을 때만 전진한다.
  // 이어 읽기 창이면 전진값은 이번 틱이 아니라 **그 창의 첫 읽기 시작 시각**이다 — 창을 여는
  // 순간 이후의 갱신분은 이 창이 책임지지 않는다(다음 창이 `그 시각 − 여유` 부터 읽는다).
  // 한 틱 상한에서 끊겼으면 커서를 남긴다(워터마크는 그대로).
  if (promptResumeNext) {
    const resumeState = {
      cursor: promptResumeNext,
      from: promptPlan.windowFrom,
      startedAt: promptPlan.windowStartedAt ?? promptReadStartedAt,
    };
    await recordWatermarkSafely("prompt-resume", projectId, () =>
      scopeMirrorRepository.recordPromptResume(projectId, resumeState),
    );
  } else if (promptPlan.canAdvance && !promptPage.truncated) {
    const through = promptPlan.windowStartedAt ?? promptReadStartedAt;
    await recordWatermarkSafely("prompt", projectId, () =>
      scopeMirrorRepository.recordPromptWatermark(projectId, through),
    );
  }

  const runPlan = planRunScan({
    watermarksEnabled,
    force: Boolean(opts.force),
    resyncBefore: opts.resyncBefore,
    runsSince: opts.runsSince,
    runsUntil: opts.runsUntil,
    fullScan: Boolean(opts.fullScan),
    floorRunIds: watermark?.runsFloorRunIds,
  });
  // 정착 판정은 **패스 시작 시점의 미러 상태**로만 한다 — 목록 읽기(조기 종료)와 floor
  // 계산이 같은 기준을 써야 불변식이 선다. force 경로는 recordFloor/earlyStop 이 둘 다
  // 거짓이라 이 판정을 쓰지 않는다.
  const settledByPrior = (r: MeasurementRunSummary): boolean =>
    shouldSkipMirroredRun(mirrored.get(r.measurement_run_id), r.status);
  // floor 의 **스냅샷 시각** = 목록 읽기 시작. 늦게 끝난 긴 패스의 낡은 목록이 더 새 floor 를
  // 덮지 못하게 저장 쪽이 이 값을 비교한다(recordRunFloor 주석, 검증 V3).
  const runListStartedAt = new Date();
  const runPage = await scanRunList(
    (cursor) => client.listMeasurementRuns(projectId, { limit: 100, cursor }),
    {
      maxPages: opts.runMaxPages ?? MIRROR_RUN_MAX_PAGES,
      label: `runs(project=${projectId})`,
      deadlineAt,
      earlyStop: runPlan.earlyStop,
      floorRunIds: watermark?.runsFloorRunIds,
      streakTarget: MIRROR_RUN_SETTLED_STREAK,
      isSettled: settledByPrior,
    },
  );
  throwIfScopeDeadlineExceeded(deadlineAt);
  if (runPage.truncated) pageCapHits.add("runs");
  // runsSince/runsUntil 을 함께 주면 한 프로젝트의 런을 시간대로 쪼개
  // **여러 프로세스가 겹치지 않게** 병렬 처리할 수 있다 — "프로젝트 1개 = 워커 1개"
  // 제약을 우회하는 유일한 수단이다(2026-09-05, 단일 프로젝트 63K 답변 재싱크).
  const runs = runPage.items.filter(
    (r) =>
      (!opts.runsSince || new Date(r.started_at) >= opts.runsSince) &&
      (!opts.runsUntil || new Date(r.started_at) < opts.runsUntil),
  );
  // floor 계산 입력: 이 패스가 끝났을 때 각 run 이 정착했는가. 기본값은 읽기 전 판정이고,
  // 이번 패스가 **실제로 써서** 정착시킨 run 만 아래 루프가 참으로 뒤집는다. 예산 중단·
  // 재확인 상한·잘림 등으로 못 처리한 run 은 거짓으로 남아 floor 를 붙잡는다.
  const settledAfterPass = new Map<string, boolean>();
  if (runPlan.recordFloor) {
    for (const r of runs) settledAfterPass.set(r.measurement_run_id, settledByPrior(r));
  }
  // 가시화: 이번 패스가 **이전 floor 아래**(= 크론 증분이 보지 않는 구간)에서 다시 당긴 run 수.
  // 전체 대조에서 이 값이 0 이 아니면 그만큼 증분이 놓쳤다는 뜻이다.
  const previousAnchors = new Set(watermark?.runsFloorRunIds ?? []);
  const floorIndexInRuns = previousAnchors.size
    ? runs.findIndex((r) => previousAnchors.has(r.measurement_run_id))
    : -1;
  let pulledBelowFloor = 0;
  /** 이번 패스가 실제로 쓴 run(replaceRun 성공). floor 판정에서 "미처리"와 가른다. */
  const processedThisPass = new Set<string>();

  let runsSynced = 0;
  let answersTotal = 0;
  let skipped = 0;
  let rechecked = 0;
  let resyncSkipped = 0;
  let recheckCapHit = false;
  let usedFallback = false;
  const oversizedRuns: Array<{ runId: string; totalJobs: number }> = [];
  const truncatedRuns: string[] = [];
  const recheckDeferredHeavy: Array<{ runId: string; jobs: number }> = [];
  let budgetStopped = false;
  let returnRunLimitNextRunId: string | undefined;
  // Accumulated across every run processed this pass, keyed by scope prompt_id
  // (= prompts.scope_prompt_id) — flushed to the catalog once at the end so a
  // prompt seen across multiple jobs/runs this pass gets one merged verdict.
  const catalogStatusUpdates = new Map<string, CatalogPromptStatus>();

  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = runs[runIndex];
    // ── 패스 예산 (2026-09-13 미러 정지 사고) ──────────────────────────────
    // 종전엔 예산을 **프로젝트 사이에서만** 봤다(syncStandardMirror 의 루프 머리).
    // 그래서 한 프로젝트의 run 루프가 300s 를 통째로 먹으면 크론이 하드킬되고,
    // 커서 갱신이 `syncOneProject` 뒤에 있어 **어떤 프로젝트도 커서를 못 남겼다.**
    // 여기서 끊으면 남은 run 은 다음 패스로 밀릴 뿐 잃지 않는다(워터마크 멱등).
    if (Date.now() >= deadlineAt) {
      budgetStopped = true;
      console.warn(
        `[mirror] budget stop inside run loop — project=${projectId}: ` +
          `${runsSynced} run(s) synced, 나머지는 다음 패스로 이월한다.`,
      );
      break;
    }
    try {
      const runId = run.measurement_run_id;
      // ── 구조적 초과 run 은 **왕복 0으로** 걸러낸다 (isOversizedRun 주석) ───
      // 상한을 넘는 run 은 어차피 온전히 못 가져온다. 그런데도 상한만큼 당기면
      // 그 비용이 패스 전체를 죽인다 — 회차 8(66,144 잡)이 정확히 그랬다.
      if (isOversizedRun(run.total_jobs)) {
        const mirroredPrior = mirrored.get(runId);
        const oversizedPrior = opts.force ? undefined : mirroredPrior;
        const deferOversizedRecheck = opts.queueBulkRun &&
          !shouldSkipMirroredRun(oversizedPrior, run.status) &&
          shouldDeferHeavyRecheck(oversizedPrior, run.status, run.total_jobs);
        if (deferOversizedRecheck) {
          recheckDeferredHeavy.push({ runId, jobs: run.total_jobs as number });
          console.warn(
            `[mirror] HEAVY OVERSIZED RECHECK DEFERRED — project=${projectId} run=${runId}: ` +
              `total_jobs=${run.total_jobs} > 재확인 상한 ${MIRROR_RECHECK_MAX_JOBS} ` +
              `(status 무변경 ${run.status}). 대량 원장 상태를 callback에서 판정한다.`,
          );
        }
        // 재큐잉 정책은 enqueueBulkRun 한 곳에서 결정한다. 여기서 prior를
        // 근거로 callback 자체를 생략하면 blocked receipt의 backoff/restart와
        // current 없는 원장의 정합성 검사가 실행되지 않는다.
        if (opts.queueBulkRun &&
            !shouldSkipResyncedRun(mirroredPrior, opts.resyncBefore) &&
            ["completed", "failed", "partial_failed"].includes(run.status)) {
          await opts.queueBulkRun(run, projectId, localProjectId);
        }
        oversizedRuns.push({ runId, totalJobs: run.total_jobs as number });
        skipped++;
        console.warn(
          `[mirror] OVERSIZED RUN — project=${projectId} run=${runId}: ` +
            `total_jobs=${run.total_jobs} > 상한 ${mirrorJobCapacity()} ` +
            `(MIRROR_JOB_MAX_PAGES=${MIRROR_JOB_MAX_PAGES} × ${MIRROR_JOB_PAGE_LIMIT}). ` +
            (opts.queueBulkRun
              ? `대량 진행 상태를 확인할 것 — 일반 요청에서는 적재하지 않는다.`
              : `이 run 은 미러되지 않는다 — 로컬 회수 도구를 MIRROR_JOB_MAX_PAGES 상향으로 돌릴 것.`),
        );
        continue;
      }
      // 강제 재싱크 워터마크 — terminal 워터마크보다 **먼저** 판정한다. force 는
      // 아래에서 `prior` 를 undefined 로 만들어 모든 skip 을 무력화하므로, 여기서
      // 걸러내지 않으면 패스가 영원히 목록 앞부분만 다시 쓴다(멱등).
      if (shouldSkipResyncedRun(mirrored.get(runId), opts.resyncBefore)) {
        resyncSkipped++;
        continue;
      }
      // Watermark. A terminal run is skipped only when scope still reports the
      // status we mirrored AND nothing can still flip — i.e. no answer of ours is
      // non-completed, or the run has aged out of the recheck window. Ticket
      // recovery flips failed→completed inside an already-terminal run, so the
      // old "terminal = skip forever" test froze the mirror on the failure.
      const prior = opts.force ? undefined : mirrored.get(runId);
      if (shouldSkipMirroredRun(prior, run.status)) {
        skipped++;
        continue;
      }
      // Preserve main's heavy-recheck ceiling: these runs must not consume
      // the request budget repeatedly while their source status is unchanged.
      if (shouldDeferHeavyRecheck(prior, run.status, run.total_jobs)) {
        recheckDeferredHeavy.push({ runId, jobs: run.total_jobs as number });
        skipped++;
        console.warn(
          `[mirror] HEAVY RECHECK DEFERRED — project=${projectId} run=${runId}: ` +
            `total_jobs=${run.total_jobs} > 재확인 상한 ${MIRROR_RECHECK_MAX_JOBS} ` +
            `(status 무변경 ${run.status}). 회수는 명시적 재싱크로 — ?force=1&projectIds=${projectId}.`,
        );
        continue;
      }
      // 이미 미러된 run 을 회수 추적 때문에 다시 당기는 경우만 상한을 건다.
      // 처음 보는 run(=prior 없음)은 상한과 무관하게 항상 당긴다 — 신규 데이터가
      // 재확인 때문에 밀리면 안 된다.
      if (prior) {
        if (rechecked >= RECHECK_MAX_RUNS_PER_PASS) {
          // 상한 도달을 기록한다 — 예전엔 skipped 에 조용히 섞여, 측정량이 늘어
          // 상한을 넘기 시작해도 아무 신호가 없었다.
          recheckCapHit = true;
          skipped++;
          continue;
        }
      }
      // Check maxRuns only after classifying intentional skips above. This keeps
      // oversized and recheck-cap diagnostics visible even when the run cap was
      // already reached, while a genuinely eligible run becomes runLimitHits.
      if (opts.maxRuns != null && runsSynced >= opts.maxRuns) {
        returnRunLimitNextRunId = runId;
        break;
      }
      if (prior) {
        rechecked++;
      }

      const remainingMs = deadlineAt - Date.now();
      if (shouldStopBeforeRun(remainingMs, run.total_jobs, pacing)) {
        budgetStopped = true;
        console.warn(
          `[mirror] budget stop BEFORE run — project=${projectId} run=${runId}: ` +
            `예상 ${Math.round(estimateRunPullMs(run.total_jobs, pacing))}ms ` +
            `(jobs=${run.total_jobs ?? "?"}, 페이지 평균 ${Math.round(jobPageAvgMs(pacing))}ms) > ` +
            `잔여 ${Math.round(remainingMs)}ms. ${runsSynced} run(s) synced, 나머지는 다음 패스로 이월한다.`,
        );
        break;
      }
      const jobPageStartedAt = Date.now();
      const jobPage = await pageAll(
        (cursor) =>
          client.listRunJobs(projectId, runId, {
            limit: 200,
            cursor,
            // occurrences: 답변 감성 밑줄용 발생 배열(scope#632). scope 가 아직 모르는 값이면 무시된다.
            include: "result,occurrences,stances",
          }),
        {
          maxPages: MIRROR_JOB_MAX_PAGES,
          label: `jobs(project=${projectId} run=${runId})`,
          deadlineAt,
        },
      );
      throwIfScopeDeadlineExceeded(deadlineAt);
      recordJobPageSample(pacing, Date.now() - jobPageStartedAt, jobPage.items.length);
      if (jobPage.truncated) {
        // ── 부분 run 을 쓰지 않는다 (2026-09-13) ───────────────────────────
        // 종전엔 잘린 채로 `replaceRun` 을 불렀다. 그 결과가 **조용한 영구
        // 결손**이다: run 은 scope 가 보고한 terminal status 로 기록되고,
        // 미러된 답변이 전부 completed 이면 `shouldSkipMirroredRun` 이
        // `prior.status === currentStatus && !hasUnresolved` 로 **다음 패스부터
        // 영원히 skip** 한다. 66,144 잡 중 10,000 만 든 run 이 "동기화 완료"로
        // 굳는다는 뜻이다 — KPI 분모가 조용히 틀어진다.
        //
        // 그래서 쓰지 않고 건너뛴다. 미러에 **없는 것**은 다음 패스가 다시
        // 시도하지만, 미러에 **잘못 들어온 것**은 아무도 다시 안 본다.
        pageCapHits.add("jobs");
        truncatedRuns.push(runId);
        skipped++;
        console.warn(
          `[mirror] TRUNCATED RUN SKIPPED — project=${projectId} run=${runId}: ` +
            `jobs 피드가 상한 ${mirrorJobCapacity()} 에서 잘렸다. 부분 run 을 terminal 로 ` +
            `굳히지 않기 위해 이 run 은 쓰지 않는다.`,
        );
        continue;
      }
      const jobs = jobPage.items;

      const sink = newMirrorRowSink();
      const { answers, mentions, occurrences, citations, stances } = sink;
      // 롤업은 전체 jobs에서 수집(이름 사전이 풍부), 답변/멘션/인용 미러는 ACR
      // 반복 dedup을 거친 대표 job만 — dedupeAcrIterationJobs 주석 참조.
      const acrRollups = collectAcrRollups(jobs, runId);
      const mirrorJobs = dedupeAcrIterationJobs(jobs);
      // Catalog status is provisional until this run's atomic replaceRun commits.
      // If the run times out during reads/transformation, discard this map so a
      // queued/running prompt cannot be marked complete for a run that was not
      // mirrored.
      const runCatalogStatusUpdates = new Map<string, CatalogPromptStatus>();

      for (const job of mirrorJobs) {
        const fallback = await appendJobRows(job, {
          client, runId, canonicalizer, sink,
          catalogStatusUpdates: runCatalogStatusUpdates, deadlineAt,
        });
        usedFallback = usedFallback || fallback;
      }

      throwIfScopeDeadlineExceeded(deadlineAt);

      await scopeMirrorRepository.replaceRun(
        {
          runId,
          // The run's owning scope project — the mirror's project dimension. Prefer
          // scope's own field; fall back to the project we're syncing (they match).
          projectId: run.project_id ?? projectId,
          status: run.status ?? null,
          startedAt: run.started_at ? new Date(run.started_at) : null,
          completedAt: run.completed_at ? new Date(run.completed_at) : null,
          totalJobs: run.total_jobs ?? null,
          // 회차 앵커(migration 0058). scope 의 measurements API 는 아직 이 필드를
          // 응답에 싣지 않는다(lib/measurements/store.ts listRuns/getRun 매핑에 없음)
          // — 없으면 undefined 로 두어 upsert 가 기존 값을 덮지 않게 한다. scope 가
          // 노출을 시작하면 이 줄만으로 채워지고 표준 화면의 `측정 기준일` 이
          // 회차 기준으로 전환된다(scope-aggregates asOf 의 COALESCE 참조).
          cycleAnchorAt: (run as { cycle_anchor_at?: string | null }).cycle_anchor_at
            ? new Date((run as { cycle_anchor_at?: string | null }).cycle_anchor_at!)
            : undefined,
        },
        answers,
        mentions,
        citations,
        acrRollups,
        occurrences,
        stances,
      );
      // Only a successful replaceRun makes this run's catalog observations
      // durable. A later deadline/exception cannot leak an uncommitted run's
      // status into the cleanup batch.
      for (const [scopePromptId, status] of runCatalogStatusUpdates) {
        const current = catalogStatusUpdates.get(scopePromptId);
        catalogStatusUpdates.set(
          scopePromptId,
          current ? mergeCatalogStatus(current, status) : status,
        );
      }
      runsSynced++;
      answersTotal += answers.length;
      // 방금 쓴 run 이 정착했는가 = 다음 패스의 shouldSkipMirroredRun 이 참일 것인가.
      // terminal 이고 미완 답변이 하나도 없으면 참. 미완 답변이 있으면 재확인 창 안에서는
      // 다시 당겨야 하므로 floor 를 붙잡는다(창 밖이면 다음 패스가 prior 로 정착 판정하고
      // floor 가 올라간다 — 한 패스 늦을 뿐 보수적인 쪽이다).
      processedThisPass.add(runId);
      if (floorIndexInRuns >= 0 && runIndex > floorIndexInRuns) pulledBelowFloor++;
      if (runPlan.recordFloor) {
        settledAfterPass.set(
          runId,
          TERMINAL_RUN_STATUS_SET.has(run.status) && answers.every((a) => a.status === "completed"),
        );
      }
    } catch (error) {
      if (!isScopeDeadlineExceeded(error)) throw error;
      budgetStopped = true;
      console.warn(
        `[mirror] budget stop inside run — project=${projectId}: ` +
          `${runsSynced} run(s) synced, current run was not written and will retry next pass.`,
      );
      break;
    }
  }

  // ── floor 기록 ─────────────────────────────────────────────────────────
  // 여기까지 왔으면 목록 읽기는 끝까지 성공했다(읽기 중 데드라인·예외는 위에서 던진다).
  // run 루프가 예산으로 끊겼어도 계산은 건전하다 — 못 처리한 run 은 정착 거짓으로 남아
  // floor 를 붙잡으므로 다음 패스가 거기까지 다시 읽는다(computeRunFloor 주석).
  let openRunsReleased = 0;
  if (runPlan.recordFloor) {
    const now = Date.now();
    const byId = new Map(runs.map((r) => [r.measurement_run_id, r] as const));
    // 가시화: 이번 패스에 써 봤는데도 여전히 비종결이고 7일을 넘겨 floor 를 **놓아준** run 수.
    // 이 run 들의 이후 종료는 크론이 보지 않는다(전체 대조 몫) — 조용히 두지 않고 센다.
    for (const id of processedThisPass) {
      const r = byId.get(id);
      if (
        r &&
        !TERMINAL_RUN_STATUS_SET.has(r.status) &&
        !isOversizedRun(r.total_jobs) &&
        !runHoldsFloor(r, settledAfterPass.get(id) === true, now, true)
      ) {
        openRunsReleased++;
      }
    }
    const floor = computeRunFloor({
      runs,
      holdsFloor: (id) => {
        const r = byId.get(id);
        return r
          ? runHoldsFloor(r, settledAfterPass.get(id) === true, now, processedThisPass.has(id))
          : false;
      },
      scanComplete: runPage.reachedEnd || runPage.passedFloor,
      previousFloorRunIds: watermark?.runsFloorRunIds,
    });
    // 값이 같아도 **매 패스 쓴다** — 스냅샷 시각을 올려 두어야 이보다 먼저 목록을 읽은 긴
    // 패스가 뒤늦게 낡은 floor 로 덮어쓰지 못한다. 완결이 아닌 읽기(floor 유지)는 새 사실이
    // 없으므로 쓰지 않는다.
    if (runPage.reachedEnd || runPage.passedFloor) {
      await recordWatermarkSafely("run-floor", projectId, async () => {
        const applied = await scopeMirrorRepository.recordRunFloor(
          projectId,
          floor.floorRunIds,
          runListStartedAt,
        );
        if (!applied) {
          console.warn(
            `[mirror] run-floor not written for project=${projectId}: 더 새 스냅샷의 floor 가 이미 있다 ` +
              `(이 패스 목록 읽기 ${runListStartedAt.toISOString()}).`,
          );
        }
      });
    }
  }

  let catalogUpdated = 0;
  if (catalogStatusUpdates.size > 0) {
    // This is a small local cleanup after run transactions. It must flush even
    // when the read deadline ended: all entries here belong to committed runs.
    catalogUpdated = await promptRepository.updateStatusByScopePromptIds(
      [...catalogStatusUpdates].map(([scopePromptId, status]) => ({
        scopePromptId,
        status,
      })),
    );
  }

  return {
    runs: runsSynced,
    answers: answersTotal,
    skipped,
    resyncSkipped,
    recheckCapHit,
    recheckDeferredHeavy,
    usedFallback,
    catalogUpdated,
    pageCapHits: [...pageCapHits],
    oversizedRuns,
    truncatedRuns,
    budgetStopped,
    runLimitNextRunId: returnRunLimitNextRunId,
    promptRead: promptPlan.mode,
    promptPages: promptPage.pages,
    runPages: runPage.pages,
    runScanStoppedEarly: runPage.stoppedEarly,
    promptResumePending: Boolean(promptResumeNext),
    pulledBelowFloor,
    openRunsReleased,
  };
}

/**
 * 워터마크 쓰기 실패는 싱크를 깨뜨리지 않는다 — 삼키되 로그는 남긴다.
 * 못 쓴 워터마크의 결과는 "다음 패스가 더 넓게 읽는다" 뿐이라 데이터가 틀어지지 않는다
 * (커서 쓰기 `recordSyncAttempt` 와 같은 자세). 반대로 여기서 던지면 이미 커밋된 run 들의
 * 카탈로그 상태 반영(아래)까지 건너뛴다.
 */
async function recordWatermarkSafely(
  kind: "prompt" | "prompt-resume" | "prompt-resume-clear" | "run-floor",
  projectId: string,
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write();
  } catch (err) {
    console.warn(`[mirror] ${kind} watermark write failed for project=${projectId}:`, err);
  }
}

/**
 * 패스 1회분의 증분 워터마크. **`null` = 기능 비활성**(0082 미적용 또는 조회 실패) —
 * 그때 싱크는 종전 전량 읽기로 돌고 워터마크를 쓰지 않는다. 조회 실패를 빈 맵으로
 * 뭉개지 않는 이유: 빈 맵은 "워터마크를 새로 세우라"는 뜻이라, 일시 장애가 쓰기로 번진다.
 * 프로젝트 루프 밖에서 1회만 부른다(loadMirroredRunStates 와 같은 이유).
 */
async function loadSyncWatermarks(): Promise<Map<string, ProjectSyncWatermark> | null> {
  try {
    return (await scopeMirrorRepository.syncWatermarks()) ?? null;
  } catch (err) {
    console.warn("[mirror] sync-watermark read failed — 이번 패스는 전량 읽기:", err);
    return null;
  }
}

export async function syncStandardMirror(
  opts: MirrorSyncOptions = {},
): Promise<MirrorSyncResult> {
  // setup(프로젝트 목록·로테이션·미러 상태 조회)도 이 패스의 예산에 포함한다.
  const startedAt = Date.now();
  const totalBudgetMs = opts.budgetMs ?? SYNC_BUDGET_MS;
  const deadlineAt = startedAt + totalBudgetMs;
  const root = getRootConfig();
  if (!root)
    return {
      runs: 0,
      answers: 0,
      skipped: 0,
      resyncSkipped: 0,
      recheckCapHits: [],
      recheckDeferredHeavy: [],
      usedFallback: false,
      catalogUpdated: 0,
      deferred: 0,
      pageCapHits: [],
      oversizedRuns: [],
      truncatedRuns: [],
      budgetStoppedProjects: [],
      runLimitHits: [],
      projectIdsNotFound: [],
      perProject: [],
    };
  const client: ScopeClient = getScopeClient();

  // Sync targets = root (standard/enterprise) + every locally-linked project's
  // scope id + the legacy SCOPE_EXTRA_PROJECT_IDS env. The DB-derived list is
  // the `project_scope_links` step the env TEMP anticipated: any HMG project
  // with a scopeProjectId (set by project-sync on create / by executePrompts on
  // RUN) is now mirrored WITH its project_id, so per-project KPI reads work.
  // Failure to read the project list must not break the root sync.
  let linkedIds: string[] = [];
  try {
    const projects = await projectRepository.listAll();
    linkedIds = projects
      .map((p) => p.scopeProjectId)
      .filter((id): id is string => Boolean(id));
    const localProjectByScopeId = new Map(
      projects
        .filter((p) => p.scopeProjectId)
        .map((p) => [p.scopeProjectId as string, p.id] as const),
    );
    // website_sites scope project IDs — scope push 후 채워지면 자동 포함.
    const websiteIds = await getWebsiteScopeProjectIds();
    // dedupe — a project may appear in root + linked + extras.
    let ids = Array.from(
      new Set([root.projectId, ...linkedIds, ...websiteIds, ...readExtraProjectIds()]),
    );
    // oldest-first 로테이션 — 순서는 최적화지 정합 조건이 아니므로, 조회 실패 시
    // 원 순서로 진행한다.
    try {
      const [attempts, writes] = await Promise.all([
        scopeMirrorRepository.lastAttemptByProject(),
        scopeMirrorRepository.lastSyncedByProject(),
      ]);
      ids = orderSyncTargets(
        root.projectId,
        ids,
        mergeRotationKeys(attempts, writes),
      );
    } catch (err) {
      console.warn("[mirror] rotation-order read failed — fixed order:", err);
    }

    // ?projectIds= 대상 좁히기 — 로테이션 정렬 **뒤**에 건다(정렬은 보존).
    const selected = selectSyncTargets(ids, opts.projectIds);
    ids = selected.ids;
    const projectIdsNotFound = selected.notFound;
    if (projectIdsNotFound.length > 0) {
      console.warn(
        `[mirror] projectIds not in sync targets — 이 id 들은 이번 패스에서 돌지 않았다: ${projectIdsNotFound.join(", ")}`,
      );
    }

    // 프로젝트 루프 **밖에서 1회** — 호이스트 근거는 loadMirroredRunStates 주석.
    const mirrored = await loadMirroredRunStates(opts);
    const watermarks = await loadSyncWatermarks();
    let deferred = 0;
    let runs = 0;
    let answers = 0;
    let skipped = 0;
    let resyncSkipped = 0;
    const recheckCapHits: string[] = [];
    const recheckDeferredHeavy: MirrorSyncResult["recheckDeferredHeavy"] = [];
    let usedFallback = false;
    let catalogUpdated = 0;
    const pageCapHits: MirrorSyncResult["pageCapHits"] = [];
    const oversizedRuns: MirrorSyncResult["oversizedRuns"] = [];
    const truncatedRuns: MirrorSyncResult["truncatedRuns"] = [];
    const budgetStoppedProjects: string[] = [];
    const runLimitHits: MirrorSyncResult["runLimitHits"] = [];
    const perProject: MirrorSyncResult["perProject"] = [];
    const pacing = createPassPacing();
    for (const projectId of ids) {
      // 예산 소진 → 새 프로젝트를 시작하지 않고 이월 (다음 패스에서 oldest-first
      // 로 앞순번이 된다). 진행 중이던 프로젝트는 이미 끝난 상태라 안전.
      if (Date.now() >= deadlineAt) {
        deferred += 1;
        continue;
      }
      // ── 커서를 **먼저** 찍는다 (2026-09-13 미러 정지 사고) ────────────────
      // 종전엔 `syncOneProject` 가 끝난 **뒤에만** 커서를 썼다. 그래서 한
      // 프로젝트에서 Vercel 300s 하드킬이 나면 그 패스의 커서 쓰기가 통째로
      // 사라지고, 로테이션 정렬 키(`last_attempt_at`)가 안 움직여 **다음 패스도
      // 같은 프로젝트에서 같은 자리에 죽는다.** 실측: 216개 전 프로젝트 커서가
      // 2026-09-13 17:24:42Z 에서 4시간 넘게 멈췄다(크론 15회분 전부 504).
      //
      // 시도 표시를 선기록하면 킬을 당해도 로테이션이 전진한다 — 이 패스가 못
      // 끝낸 프로젝트는 뒤로 가고 굶던 프로젝트가 앞으로 온다. 성공·실패 결과는
      // 아래에서 한 번 더 덮어쓴다(같은 행 upsert 라 행이 늘지 않는다).
      //
      // ⚠️ `recordSyncAttempt(pid, null)` 이 **아니다.** 그건 last_error 를 NULL 로
      // 덮어 하드킬 시 직전 실패 사유를 지운다 — 이번 사고를 잡아낸 단서가 바로
      // 그 값이었다(루트 커서의 scope_acr_rollups insert 실패).
      try {
        await scopeMirrorRepository.markSyncAttemptStarted(projectId);
      } catch (err) {
        console.warn(`[mirror] attempt-cursor pre-write failed for project=${projectId}:`, err);
      }
      let attemptError: string | null = null;
      try {
        const projectBudgetMs = projectBudgetFor(opts, totalBudgetMs);
        const projectDeadlineAt = Math.min(deadlineAt, Date.now() + projectBudgetMs);
        const projectClient = withScopeReadDeadline(client, projectDeadlineAt);
        const r = await syncOneProject(
          projectClient,
          projectId,
          localProjectByScopeId.get(projectId) ?? null,
          opts,
          mirrored,
          projectDeadlineAt,
          pacing,
          watermarks === null ? null : watermarks.get(projectId),
        );
        for (const o of r.oversizedRuns) oversizedRuns.push({ projectId, ...o });
        for (const runId of r.truncatedRuns) truncatedRuns.push({ projectId, runId });
        for (const d of r.recheckDeferredHeavy) recheckDeferredHeavy.push({ projectId, ...d });
        if (r.budgetStopped) budgetStoppedProjects.push(projectId);
        if (r.runLimitNextRunId) {
          runLimitHits.push({ projectId, nextRunId: r.runLimitNextRunId });
        }
        // 예외가 없어도 **조용한 결손은 커서에 남긴다.** 이 신호들은 던지지
        // 않는 실패라, 커서를 보는 사람에게 안 보이면 없는 것과 같다.
        const attention = [
          r.oversizedRuns.length
            ? `oversized run(s) skipped: ${r.oversizedRuns
                .map((o) => `${o.runId}(${o.totalJobs} jobs)`)
                .join(", ")}`
            : "",
          r.truncatedRuns.length ? `truncated run(s) skipped: ${r.truncatedRuns.join(", ")}` : "",
          // 재확인 잡 상한 이월은 **정규 크론으로는 안 풀린다** — 커서를 보는
          // 사람에게 보여야 명시적 재싱크가 돈다. 목록은 5건까지만(행 비대 방지).
          r.recheckDeferredHeavy.length
            ? `heavy recheck deferred (${r.recheckDeferredHeavy.length}): ${r.recheckDeferredHeavy
                .slice(0, 5)
                .map((d) => `${d.runId}(${d.jobs} jobs)`)
                .join(", ")}`
            : "",
          r.budgetStopped ? "budget stop inside run loop" : "",
          r.runLimitNextRunId ? `run limit hit; next eligible run: ${r.runLimitNextRunId}` : "",
        ].filter(Boolean);
        if (attention.length) attemptError = `[attention] ${attention.join(" | ")}`;
        runs += r.runs;
        answers += r.answers;
        skipped += r.skipped;
        resyncSkipped += r.resyncSkipped;
        if (r.recheckCapHit) recheckCapHits.push(projectId);
        usedFallback = usedFallback || r.usedFallback;
        catalogUpdated += r.catalogUpdated;
        for (const kind of r.pageCapHits) pageCapHits.push({ projectId, kind });
        perProject.push({
          projectId,
          runs: r.runs,
          answers: r.answers,
          skipped: r.skipped,
          catalogUpdated: r.catalogUpdated,
          promptRead: r.promptRead,
          promptPages: r.promptPages,
          runPages: r.runPages,
          runScanStoppedEarly: r.runScanStoppedEarly,
          promptResumePending: r.promptResumePending,
          pulledBelowFloor: r.pulledBelowFloor,
          openRunsReleased: r.openRunsReleased,
        });
      } catch (err) {
        // PG 사유를 **앞에** 두고 래퍼는 잘라서 뒤에 — 근거는 describeSyncError.
        const msg = describeSyncError(err);
        console.warn(`[mirror] sync failed for project=${projectId}:`, msg);
        perProject.push({ projectId, error: msg });
        attemptError = isScopeDeadlineExceeded(err)
          ? "budget stop inside project read"
          : msg;
        if (isScopeDeadlineExceeded(err) && !budgetStoppedProjects.includes(projectId)) {
          budgetStoppedProjects.push(projectId);
        }
      }
      // 시도 커서 갱신 — 이 프로젝트를 뒤로 보내 다음 패스가 뒷순번으로 넘어가게
      // 한다. **실패한 시도도 기록**한다(삭제된 scope 프로젝트의 404가 매 패스
      // 앞순번을 영구 점유하던 것이 기아의 일부였다). 커서 쓰기 실패가 싱크를
      // 깨뜨리면 안 되므로 삼키되 로그는 남긴다 — 다음 패스에서 재시도된다.
      try {
        await scopeMirrorRepository.recordSyncAttempt(projectId, attemptError);
      } catch (err) {
        console.warn(`[mirror] attempt-cursor write failed for project=${projectId}:`, err);
      }
    }
    if (deferred > 0) {
      console.warn(
        `[mirror] budget exhausted (${totalBudgetMs}ms) — ${deferred} project(s) deferred to next pass`,
      );
    }
    return {
      runs,
      answers,
      skipped,
      resyncSkipped,
      recheckCapHits,
      recheckDeferredHeavy,
      usedFallback,
      catalogUpdated,
      deferred,
      pageCapHits,
      oversizedRuns,
      truncatedRuns,
      budgetStoppedProjects,
      runLimitHits,
      projectIdsNotFound,
      perProject,
    };
  } catch (err) {
    console.warn("[mirror] could not read linked project ids:", err);
  }
  // dedupe — a project may appear in root + linked + extras.
  const allIds = Array.from(
    new Set([root.projectId, ...linkedIds, ...readExtraProjectIds()]),
  );
  const selectedFallback = selectSyncTargets(allIds, opts.projectIds);
  const ids = selectedFallback.ids;
  const projectIdsNotFound = selectedFallback.notFound;
  if (projectIdsNotFound.length > 0) {
    console.warn(
      `[mirror] projectIds not in sync targets — 이 id 들은 이번 패스에서 돌지 않았다: ${projectIdsNotFound.join(", ")}`,
    );
  }
  // 폴백 경로도 동일하게 1회만 계산한다.
  const mirrored = await loadMirroredRunStates(opts);
  const watermarks = await loadSyncWatermarks();

  let runs = 0;
  let answers = 0;
  let skipped = 0;
  let resyncSkipped = 0;
  let deferredFallback = 0;
  const recheckCapHits: string[] = [];
  const recheckDeferredHeavy: MirrorSyncResult["recheckDeferredHeavy"] = [];
  let usedFallback = false;
  let catalogUpdated = 0;
  const pageCapHits: MirrorSyncResult["pageCapHits"] = [];
  const oversizedRuns: MirrorSyncResult["oversizedRuns"] = [];
  const truncatedRuns: MirrorSyncResult["truncatedRuns"] = [];
  const budgetStoppedProjects: string[] = [];
  const runLimitHits: MirrorSyncResult["runLimitHits"] = [];
  const perProject: MirrorSyncResult["perProject"] = [];
  // 폴백 경로도 **같은 예산**을 쓴다. 종전엔 예산 검사가 아예 없어, 이 경로로
  // 떨어지면 300s 하드킬이 기본값이었다(커서도 못 남긴다).
  const fallbackDeadlineAt = deadlineAt;
  const fallbackPacing = createPassPacing();
  for (const projectId of ids) {
    if (Date.now() >= fallbackDeadlineAt) {
      deferredFallback += 1;
      continue;
    }
    try {
      const projectBudgetMs = projectBudgetFor(opts, totalBudgetMs);
      const projectDeadlineAt = Math.min(fallbackDeadlineAt, Date.now() + projectBudgetMs);
      const projectClient = withScopeReadDeadline(client, projectDeadlineAt);
      const r = await syncOneProject(
        projectClient,
        projectId,
        null,
        opts,
        mirrored,
        projectDeadlineAt,
        fallbackPacing,
        watermarks === null ? null : watermarks.get(projectId),
      );
      for (const o of r.oversizedRuns) oversizedRuns.push({ projectId, ...o });
      for (const runId of r.truncatedRuns) truncatedRuns.push({ projectId, runId });
      for (const d of r.recheckDeferredHeavy) recheckDeferredHeavy.push({ projectId, ...d });
      if (r.budgetStopped) budgetStoppedProjects.push(projectId);
      if (r.runLimitNextRunId) {
        runLimitHits.push({ projectId, nextRunId: r.runLimitNextRunId });
      }
      runs += r.runs;
      answers += r.answers;
      skipped += r.skipped;
      resyncSkipped += r.resyncSkipped;
      if (r.recheckCapHit) recheckCapHits.push(projectId);
      usedFallback = usedFallback || r.usedFallback;
      catalogUpdated += r.catalogUpdated;
      for (const kind of r.pageCapHits) pageCapHits.push({ projectId, kind });
      perProject.push({
        projectId,
        runs: r.runs,
        answers: r.answers,
        skipped: r.skipped,
        catalogUpdated: r.catalogUpdated,
        promptRead: r.promptRead,
        promptPages: r.promptPages,
        runPages: r.runPages,
        runScanStoppedEarly: r.runScanStoppedEarly,
        promptResumePending: r.promptResumePending,
        pulledBelowFloor: r.pulledBelowFloor,
        openRunsReleased: r.openRunsReleased,
      });
    } catch (err) {
      const msg = describeSyncError(err);
      console.warn(`[mirror] sync failed for project=${projectId}:`, msg);
      perProject.push({ projectId, error: msg });
      if (isScopeDeadlineExceeded(err) && !budgetStoppedProjects.includes(projectId)) {
        budgetStoppedProjects.push(projectId);
      }
    }
  }
  return {
    runs,
    answers,
    skipped,
    resyncSkipped,
    recheckCapHits,
    recheckDeferredHeavy,
    usedFallback,
    catalogUpdated,
    deferred: deferredFallback,
    pageCapHits,
    oversizedRuns,
    truncatedRuns,
    budgetStoppedProjects,
    runLimitHits,
    projectIdsNotFound,
    perProject,
  };
}
