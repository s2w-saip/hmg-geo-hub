import "server-only";
import {
  createProject,
  updateProject,
  deleteProject,
  createPrompt,
  getSchedule,
  putSchedule,
} from "@/lib/scope/server";
import { effectiveAiEngines } from "@/lib/scope/engines";
import { projectRepository } from "@/lib/db/repositories/projects";
import { isMockMode } from "@/lib/scope";
import { isDemoProject } from "@/lib/demo";
import { domainHost } from "@/lib/scope/url-match";
import type { CreateProjectInput, UpdateProjectInput } from "@/lib/scope/types";

// Mirror an HMG project into the scope (GEO 측정 엔진) "Hyundai Motor Group"
// workspace, keeping a 1:1 link via the local row's `scopeProjectId`.
//
// Design (see docs/scope-api-integration.md + docs/development-guide.md):
//   - The local Postgres row is the SOURCE OF TRUTH for HMG-specific data
//     (members, country/brand scoping, the local measurement mirror). scope
//     owns measurement. The two databases are NOT shared — integration is the
//     HTTP /api/v1 contract only.
//   - LIVE-ONLY. In mock mode there is no real scope workspace to mirror into
//     (and MockScopeClient returns non-UUID ids), so every function below is a
//     no-op and the local row simply stays unmirrored (scopeProjectId = null).
//   - Every live sync is BEST-EFFORT: a scope outage must never break local
//     project CRUD. Failures are logged and swallowed; the local row is left
//     unmirrored / stale and retried on the next edit.
//   - scope's CreateProject requires >= 1 region but accepts an empty
//     tracked_brands list. HMG `country` is NOT NULL, so `regions` is always
//     satisfied; `brand` is optional and maps to [] when unset.

// The subset of a project row this module needs. Declared locally so project-
// sync depends on a small, stable shape rather than the full DB ProjectRow (a
// ProjectRow is structurally assignable to it).
export interface LocalProjectForSync {
  id: string;
  name: string;
  domain: string | null;
  brand: string | null;
  // ISO 3166-1 alpha-2 (KR/US/DE/FR/IN) — already in scope's `regions` shape.
  country: string;
  scopeProjectId: string | null;
}

// 스케줄 동기화에 필요한 부분집합 — 프로젝트 행의 ai_engines(NULL = 레거시).
export interface LocalProjectForScheduleSync {
  id: string;
  scopeProjectId: string | null;
  aiEngines: string[] | null;
}

// 스케줄 행이 아직 없는 프로젝트에 처음 스케줄을 심을 때의 주기 — 주간이 사내
// 기본 태세다(표준 루트 주간 결정 08-05, scripts/db/push-website-scope.ts 도 7).
// scope 최신(origin/main 2026-08-16)은 createProject 가 스케줄 행(enabled·7d·기본
// 타깃)을 함께 만들고 tick 은 enabled 행만 재므로 "행 없음"은 옛 미러에서만
// 나온다(옛 코드는 무행=24h 폴백 매일, 신 코드는 무행=미측정 — 어느 쪽이든 명시
// 행을 심는 것이 정답). 이미 행이 있으면 enabled/interval/regions/prompt_ids 는
// 건드리지 않고 targets 만 바꾼다 — 운영자가 내려둔 enabled=false 를 UI 저장이
// 되살리지 않게. 예외는 "우리가 0개 저장으로 내린 것"을 되켤 때뿐(reenable).
const NEW_SCHEDULE_INTERVAL_DAYS = 7;

// Map an HMG project to scope's CreateProjectInput. NOTE: scope's `regions` is
// an ISO COUNTRY list (= HMG country), NOT the 권역 bucket (KR/US/EU/IN/LATAM).
function toCreateInput(p: LocalProjectForSync): CreateProjectInput {
  return {
    name: p.name,
    // scope 는 domain 을 호스트로 기대 → 저장된 canonical(호스트+경로)에서
    // 경로를 잘라 호스트만 전송 (kia.com/it → kia.com). KPI ⑥ 분모는 경로
    // 프리픽스 그대로 쓰되, scope 미러는 호스트 단위. 정책: docs/kpi6-domain-
    // url-normalization-policy.md.
    domain: domainHost(p.domain) || undefined,
    // scope accepts an empty tracked_brands list; send the brand when set so
    // the mirror tracks 1:1, else [] (measurement config can be added later).
    tracked_brands: p.brand ? [{ brand_name: p.brand }] : [],
    regions: [p.country],
  };
}

// 미러 생성 결과 — "안 만든 것"(설계상 no-op)과 "못 만든 것"(scope 장애)을
// 반드시 구분한다. 둘 다 null 로 뭉개던 옛 시그니처가 2026-08-15~19 scope
// 장애(#454 zod 스키마 회귀로 POST /api/v1/projects 전건 400) 때 고아 6건을
// 만든 직접 원인이다 — 호출자가 실패를 볼 수 없으니 성공으로 취급했다.
export type MirrorOutcome =
  | { status: "created"; scopeProjectId: string }
  // mock 모드·데모 프로젝트 — 미러가 없는 것이 정상. 실패로 취급하면 안 된다.
  | { status: "skipped" }
  // scope 가 거부했거나 닿지 않음. 호출자는 사용자에게 표면화해야 한다.
  | { status: "failed" };

// Create the scope mirror. Never throws — the outcome is returned instead so
// the caller can tell a by-design no-op from a real scope failure.
export async function createScopeMirror(
  p: LocalProjectForSync,
): Promise<MirrorOutcome> {
  // The demo project keeps its seeded scope_project_id (pointed at the local
  // synthetic mirror). Never mint a real scope mirror for it — that would let
  // its fabricated capture data leak into the real HMG workspace.
  if (isDemoProject(p.id)) return { status: "skipped" };
  if (isMockMode()) return { status: "skipped" };
  try {
    const created = await createProject(toCreateInput(p));
    return { status: "created", scopeProjectId: created.project_id };
  } catch (err) {
    console.error(
      `[scope-sync] createProject failed for local project ${p.id} — left unmirrored:`,
      err,
    );
    return { status: "failed" };
  }
}

// Propagate an edit to the scope mirror. If the project isn't mirrored yet,
// create the mirror instead. Returns the scopeProjectId to persist when it
// changed (a mirror was just created), otherwise null. Never throws.
export async function pushScopeUpdate(
  p: LocalProjectForSync,
): Promise<{ newScopeProjectId: string | null }> {
  if (isDemoProject(p.id)) return { newScopeProjectId: null };
  if (isMockMode()) return { newScopeProjectId: null };
  if (!p.scopeProjectId) {
    const outcome = await createScopeMirror(p);
    return {
      newScopeProjectId:
        outcome.status === "created" ? outcome.scopeProjectId : null,
    };
  }
  // country is immutable post-create, so `regions` never changes here. brand/
  // name/domain mirror the local row exactly (brand cleared → tracked_brands []).
  const patch: UpdateProjectInput = {
    name: p.name,
    domain: domainHost(p.domain) || undefined, // 호스트만 (toCreateInput 참조)
    tracked_brands: p.brand ? [{ brand_name: p.brand }] : [],
  };
  try {
    await updateProject(p.scopeProjectId, patch);
  } catch (err) {
    console.error(
      `[scope-sync] updateProject failed for scope project ${p.scopeProjectId}:`,
      err,
    );
  }
  return { newScopeProjectId: null };
}

// Push the project's AI engine selection to scope as the schedule `targets`.
// LIVE-ONLY·BEST-EFFORT (mirror 규약과 동일): 미러 없음/mock 이면 no-op, 실패는
// 로그만 남기고 삼킨다 — 로컬 저장(ai_engines + 이력)이 정본이고, 다음 저장 때
// 다시 밀린다. 반환값은 실제로 밀었는지(호출자가 토스트에 쓸 수 있게).
//   - 엔진 0개 → enabled=false (수집 중단). targets 는 [] 로 두면 planner 가
//     DEFAULT_TARGETS 로 폴백하므로 enabled=false 가 유일한 "끔" 신호다.
//   - 엔진 ≥1 → targets=엔진. 기존 행이 있으면 enabled/interval/regions/
//     prompt_ids 보존, 없으면 enabled=true·주간(NEW_SCHEDULE_INTERVAL_DAYS).
//   - `reenable=true`(직전 로컬 저장이 명시 [] 였고 지금 ≥1 로 되켜는 전이) 면
//     기존 행의 enabled=false 를 true 로 올린다 — 그 false 는 우리가 심은 것이라
//     그대로 두면 "저장됨"인데 수집은 영구 정지가 된다(검증자 지적 2026-08-18).
//   - 현재 행 조회(GET)가 실패하면 **아무것도 밀지 않는다** — 행을 "없음"으로
//     오판해 enabled=true·interval 7·prompt_ids null 로 덮어쓰는 파괴적 PUT 을
//     막기 위해서다.
export async function syncScopeSchedule(
  p: LocalProjectForScheduleSync,
  opts: { reenable?: boolean } = {},
): Promise<{ pushed: boolean }> {
  if (isDemoProject(p.id)) return { pushed: false };
  if (isMockMode()) return { pushed: false };
  if (!p.scopeProjectId) return { pushed: false };
  const engines = effectiveAiEngines(p.aiEngines);
  try {
    const current = await getSchedule(p.scopeProjectId);
    // scope 는 행이 없으면 enabled=false·targets=[]·created_at=null 을 돌려준다
    // (lib/scheduling/store.ts) — created_at 유무로 "행 있음"을 판별한다.
    const hasRow = !!current?.created_at;
    const enabled =
      engines.length === 0
        ? false
        : !hasRow
          ? true
          : current.enabled || opts.reenable === true;
    await putSchedule(p.scopeProjectId, {
      enabled,
      interval_days: hasRow && current.interval_days > 0
        ? current.interval_days
        : NEW_SCHEDULE_INTERVAL_DAYS,
      targets: engines,
      regions: hasRow ? (current.regions ?? []) : [],
      prompt_ids: hasRow ? (current.prompt_ids ?? null) : null,
    });
    return { pushed: true };
  } catch (err) {
    console.error(
      `[scope-sync] schedule sync failed for scope project ${p.scopeProjectId}:`,
      err,
    );
    return { pushed: false };
  }
}

// 지연 미러 연결의 단일 창구 — 미러가 (생성 시점이 아니라) 나중에 생긴 모든 경로
// (설정 저장·소유 URL 변경·RUN 의 프롬프트 푸시)가 이 함수를 써야 한다. 링크를
// 저장한 뒤, 프로젝트에 명시 엔진(ai_engines != null)이 있으면 스케줄까지 민다 —
// 그러지 않으면 scope 미러의 기본 타깃(chatgpt·gemini)으로 재고 UI 는 다른 엔진을
// 보여주는 조용한 불일치가 된다(검증자 지적 2026-08-18). 레거시(NULL)는 미전파.
export async function attachScopeMirror(
  projectId: string,
  scopeProjectId: string,
  aiEngines: string[] | null,
): Promise<void> {
  await projectRepository.setScopeProjectId(projectId, scopeProjectId);
  if (aiEngines != null) {
    await syncScopeSchedule({ id: projectId, scopeProjectId, aiEngines });
  }
}

// Delete the scope mirror for a project being removed. No-op in mock mode or
// when unmirrored. Never throws — a failed scope delete must not block the
// local delete that already succeeded.
export async function deleteScopeMirror(
  scopeProjectId: string | null,
): Promise<void> {
  if (isMockMode() || !scopeProjectId) return;
  try {
    await deleteProject(scopeProjectId);
  } catch (err) {
    console.error(
      `[scope-sync] deleteProject failed for scope project ${scopeProjectId}:`,
      err,
    );
  }
}

// ─── prompt push (RUN 실행 시 프로젝트 프롬프트 → scope) ─────────────────────

// The subset of a prompt row this module needs to mirror into scope. Declared
// locally (like LocalProjectForSync) so the sync layer depends on a small,
// stable shape, not the full DB PromptRow.
export interface DraftPromptForSync {
  id: string;
  text: string;
  brand: string | null;
  category: string | null;
  scopePromptId: string | null;
}

// Persistence hooks the caller supplies so this module stays free of DB
// repositories (cf. LocalProjectForSync). CRUCIALLY each is awaited the moment
// its id is known — not batched after the loop — so a mid-push interruption
// (request timeout, redeploy) never leaves scope rows created without their
// local link. Without immediate persistence a re-RUN's skip-guard (scopePromptId
// present) wouldn't fire and would create DUPLICATES on scope.
export interface PromptPushPersist {
  // Called right after the scope mirror is lazily created, before any prompt is
  // pushed — so an interrupt can't orphan the freshly-created scope project.
  onMirrorCreated: (scopeProjectId: string) => Promise<void>;
  // Called right after each prompt's createPrompt succeeds.
  onPromptPushed: (localId: string, scopePromptId: string) => Promise<void>;
}

export interface PromptPushResult {
  pushedCount: number;
  // scope 에 실제로 올라간 로컬 프롬프트 id — 호출자는 **이것만** queued 로
  // 넘겨야 한다. 전부 queued 로 넘기면 실패분이 draft 를 벗어나 RUN 재시도
  // 대상에서 사라지고, 그 프로젝트는 영구 고아가 된다(2026-08-18 실사례).
  pushedIds: string[];
  failedCount: number;
  // 설계상 밀지 않은 경우(mock 모드·데모 프로젝트). 실패가 아니므로 호출자는
  // 기존대로 전건을 queued 로 넘겨야 한다.
  skipped: boolean;
}

// scope's Prompt carries HMG taxonomy in its `keywords` bag under an `hmg:`
// prefix (same scheme the admin standard-prompt encoder uses).
function encodePromptKeywords(d: DraftPromptForSync): string[] {
  const out: string[] = [];
  if (d.brand) out.push(`hmg:brand:${d.brand}`);
  if (d.category) out.push(`hmg:category:${d.category}`);
  return out;
}

// Push a project's draft prompts into its scope mirror when RUN is triggered.
// LIVE-ONLY and BEST-EFFORT, mirroring the rest of this module: a no-op in mock
// mode, and a scope outage never throws (it leaves rows unpushed for the next
// RUN). Ensures the scope mirror exists first (creating it if the project was
// never mirrored). Each id is persisted via `persist` the instant it's known
// (see PromptPushPersist) so an interrupted RUN is always safe to retry.
export async function pushDraftPromptsToScope(
  p: LocalProjectForSync,
  drafts: DraftPromptForSync[],
  persist: PromptPushPersist,
): Promise<PromptPushResult> {
  // mock·데모는 설계상 no-op. skipped 로 알려 호출자가 실패와 구분하게 한다.
  if (isMockMode() || isDemoProject(p.id)) {
    return { pushedCount: 0, pushedIds: [], failedCount: 0, skipped: true };
  }
  if (drafts.length === 0) {
    return { pushedCount: 0, pushedIds: [], failedCount: 0, skipped: false };
  }

  let scopeProjectId = p.scopeProjectId;
  if (!scopeProjectId) {
    const outcome = await createScopeMirror(p);
    if (outcome.status === "created") {
      scopeProjectId = outcome.scopeProjectId;
      // Persist the link before pushing so an interrupt can't orphan the mirror.
      await persist.onMirrorCreated(scopeProjectId);
    }
  }
  // scope unreachable → leave everything unpushed; the next RUN retries.
  if (!scopeProjectId) {
    return {
      pushedCount: 0,
      pushedIds: [],
      failedCount: drafts.length,
      skipped: false,
    };
  }

  const pushedIds: string[] = [];
  let failedCount = 0;
  for (const d of drafts) {
    if (d.scopePromptId) continue; // already mirrored on a prior RUN
    try {
      const created = await createPrompt(scopeProjectId, {
        text: d.text,
        keywords: encodePromptKeywords(d),
      });
      // Persist immediately — before the next iteration — so a later failure
      // can't lose this mapping and duplicate the prompt on the next RUN.
      await persist.onPromptPushed(d.id, created.prompt_id);
      pushedIds.push(d.id);
    } catch (err) {
      failedCount += 1;
      console.error(
        `[scope-sync] push failed for prompt ${d.id} — left unpushed:`,
        err,
      );
    }
  }
  return {
    pushedCount: pushedIds.length,
    pushedIds,
    failedCount,
    skipped: false,
  };
}
