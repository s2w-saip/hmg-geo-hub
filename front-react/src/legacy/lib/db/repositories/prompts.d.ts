// Type-only snapshot; no database or server implementation is included.
import "server-only";
import { type PromptCandidateRow, type PromptRow } from "@/lib/db/schema";
export type PromptType = "comparison" | "recommendation" | "information" | "other";
export type PromptStatus = "draft" | "queued" | "running" | "done" | "failed" | "paused";
export type PromptSource = "google_keyword" | "social_scraping" | "manual";
export interface PromptCandidateInsert {
    projectId: string;
    source: PromptSource;
    sourceKeyword?: string | null;
    text: string;
}
export interface PromptCandidateRepository {
    listForProject(projectId: string): Promise<PromptCandidateRow[]>;
    /** Distinct candidate texts for the project — for send-time dedup + the
     *  "이미 추가됨" state in the Social Scraping catalog. */
    listTextsForProject(projectId: string): Promise<string[]>;
    insert(input: PromptCandidateInsert): Promise<PromptCandidateRow>;
    delete(id: string): Promise<void>;
    /** Delete only when the row belongs to the project — the id comes from the
     *  client, so the projectId predicate is the cross-project guard. */
    deleteForProject(projectId: string, id: string): Promise<boolean>;
    /** Bulk variant of deleteForProject (선택 삭제). Returns deleted count. */
    deleteManyForProject(projectId: string, ids: string[]): Promise<number>;
}
export declare const promptCandidateRepository: PromptCandidateRepository;
export interface PromptInsert {
    projectId: string;
    candidateId?: string | null;
    text: string;
    promptType?: PromptType | null;
    category?: string | null;
    brand?: string | null;
    listType?: string | null;
    depth1?: string | null;
    depth2?: string | null;
    depth3?: string | null;
    depth4?: string | null;
    funnelStage?: string | null;
    scopePromptId?: string | null;
    createdBy: string;
}
export interface PromptUpdate {
    text?: string;
    promptType?: PromptType | null;
    category?: string | null;
    brand?: string | null;
    listType?: string | null;
    depth1?: string | null;
    depth2?: string | null;
    depth3?: string | null;
    depth4?: string | null;
    funnelStage?: string | null;
}
export interface PromptRepository {
    listForProject(projectId: string): Promise<PromptRow[]>;
    /**
     * Per-project prompt counts in one IN + GROUP BY query: `total` (all
     * lifecycle statuses) and `queuedOrRunning` (status queued|running — the
     * "실행 대기" overview tile). Exists for the /projects list, which only
     * renders counts — fetching full prompt rows per project (listForProject
     * × N) was both an N+1 and a full-row over-transfer. Projects with zero
     * prompts are absent from the result (callers default to 0).
     */
    countByProject(projectIds: string[]): Promise<Array<{
        projectId: string;
        total: number;
        queuedOrRunning: number;
    }>>;
    getById(id: string): Promise<PromptRow | null>;
    getByScopePromptId(scopePromptId: string): Promise<PromptRow | null>;
    /**
     * How many OTHER catalog rows map to the same scope prompt (excluding
     * `excludeId`). scope_prompt_id is intentionally NOT unique — 브랜드 간 텍스트
     * 공유·이중분류로 다대일 매핑이 존재한다. 라이프사이클 액션(측정 중지/완전
     * 삭제)은 이 값이 0일 때만 scope·미러를 건드릴 수 있다 — 아니면 남은 행들의
     * 측정·이력까지 같이 죽는다.
     */
    countOthersByScopePromptId(scopePromptId: string, excludeId: string): Promise<number>;
    /** 라이프사이클 전환 전용 setter (paused ↔ done). update()와 분리 — status는
     *  카탈로그 편집이 아니라 측정 상태라 편집 UI 경로에 노출하지 않는다. */
    setStatus(id: string, status: PromptStatus): Promise<void>;
    insert(input: PromptInsert): Promise<PromptRow>;
    update(id: string, patch: PromptUpdate): Promise<PromptRow>;
    delete(id: string): Promise<void>;
    /**
     * Persist the scope prompt_id a local draft was mirrored to (live push in
     * executePrompts). Separate from `update` because scopePromptId is set by the
     * scope-sync layer, not editable via the prompt-edit UI — cf.
     * projectRepository.setScopeProjectId.
     */
    setScopePromptId(id: string, scopePromptId: string): Promise<void>;
    /**
     * 측정 종류 전환 ('single' ↔ 'acr', migration 0025). scopePromptId처럼 일반
     * update와 분리 — kind는 카탈로그 편집이 아니라 측정 정책이고, 호출부(admin
     * 액션/push 스크립트)가 scope PATCH와 로컬 반영을 한 트랜잭션처럼 다뤄야 해서
     * 전용 setter로 둔다.
     */
    setKind(id: string, kind: "single" | "acr"): Promise<void>;
    /**
     * Flip a batch of draft prompts to `queued` and stamp a transition time.
     * In a real impl this is also where the AI batch-call would be dispatched;
     * for now it's a stub status change so the UI can demo end-to-end.
     */
    enqueueAll(projectId: string, ids: string[]): Promise<number>;
    /**
     * Feed measurement outcomes (from the scope mirror sync) back into the
     * catalog's lifecycle status, keyed by scope_prompt_id. `done` is sticky —
     * never touched once reached, so an out-of-order sync of a stale run can't
     * regress a settled success back to running/queued/failed. `failed` is
     * NOT sticky: scope re-measures registered prompts on its own recurring
     * cadence (weekly/monthly — independent of anything hmg-geo does, see
     * docs/root-catalog-country-scope-proposal.md), so a later successful job
     * for the same scope_prompt_id must be allowed to flip a `failed` row to
     * `done` — otherwise a real recovery on scope's side would be invisible
     * here forever.
     */
    updateStatusByScopePromptIds(updates: Array<{
        scopePromptId: string;
        status: "running" | "done" | "failed";
    }>): Promise<number>;
}
export declare const promptRepository: PromptRepository;
