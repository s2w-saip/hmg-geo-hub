"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/types";
import { UnauthorizedError } from "@/lib/auth/errors";
import { canOperateProject } from "@/lib/auth/operator-policy";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import {
  promptCandidateRepository,
  promptRepository,
} from "@/lib/db/repositories/prompts";
import { projectCustomFieldRepository } from "@/lib/db/repositories/project-custom-fields";
import {
  buildWorkbook,
  parseWorkbook,
  type ExportablePrompt,
  type ExportTag,
} from "@/lib/prompts/excel";
import { attachScopeMirror, pushDraftPromptsToScope } from "@/lib/scope/project-sync";
import { updatePrompt as updateScopePrompt } from "@/lib/scope/server";
import { scopeMirrorRepository } from "@/lib/db/repositories/scope-mirror";
import { auditDataAccess } from "@/lib/audit";

// Prompt-tab server actions. Mirrors v22 user flow #3.
//
// Authorization model:
//   - Both Owner and Viewer must be active members of the project to
//     access the prompt list (Viewer is read-only, gated at the UI).
//   - Mutating actions (select, add, classify, execute) require Owner.

export type ActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

async function requireOwner(
  projectId: string,
): Promise<{ userId: string; role: Role }> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const userId = session.user.id;
  const role = session.user.role;

  const project = await projectRepository.getById(projectId);
  if (!project) throw new UnauthorizedError("project not found");

  // admin = developer superuser (resolved 2026-06-02): bypass Owner check.
  if (session.user.role === "admin") return { userId, role };

  const membership = await projectMemberRepository.findMembership(
    projectId,
    userId,
  );
  if (
    !membership ||
    membership.role !== "owner" ||
    membership.status !== "active"
  ) {
    throw new UnauthorizedError("prompt action requires active Owner");
  }
  return { userId, role };
}

// Read access for export — any active member (Owner/Viewer) or admin. Mirrors
// the page-level gate in page.tsx; export carries no mutation/cost.
async function requireMember(projectId: string): Promise<{ userId: string }> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const userId = session.user.id;

  const project = await projectRepository.getById(projectId);
  if (!project) throw new UnauthorizedError("project not found");

  if (session.user.role === "admin") return { userId };

  const membership = await projectMemberRepository.findMembership(
    projectId,
    userId,
  );
  if (!membership || membership.status !== "active") {
    throw new UnauthorizedError("prompt export requires active membership");
  }
  return { userId };
}

// Cost gate for prompt EXECUTION (RUN) — the only cost-incurring prompt-tab
// action (GGMD scenario 3-2). Unlike management mutations (requireOwner), a
// global operator may run on any in-scope project, and an assigned operator may
// run on projects they are an active member of (need not be the Owner).
async function requireOperate(
  projectId: string,
): Promise<{ userId: string; role: Role }> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const userId = session.user.id;
  const role = session.user.role;

  const project = await projectRepository.getById(projectId);
  if (!project) throw new UnauthorizedError("project not found");

  const membership = await projectMemberRepository.findMembership(
    projectId,
    userId,
  );
  if (!canOperateProject(session.user, membership)) {
    throw new UnauthorizedError("prompt execution requires operator authority");
  }
  return { userId, role };
}

// "후보에서 선정" — promotes selected candidate rows into prompts. Each
// becomes an editable copy; the original candidate stays in the pool
// ("원본은 후보 풀에 유지" per v22 §3-2 A-④).
export async function selectFromCandidates(
  projectId: string,
  candidateIds: string[],
): Promise<ActionResult<{ created: number }>> {
  const { userId } = await requireOwner(projectId);
  if (candidateIds.length === 0) {
    return { ok: false, error: "선택된 후보가 없습니다" };
  }

  const all = await promptCandidateRepository.listForProject(projectId);
  const selected = all.filter((c) => candidateIds.includes(c.id));
  if (selected.length === 0) {
    return { ok: false, error: "선택한 후보를 찾을 수 없습니다" };
  }

  let created = 0;
  for (const cand of selected) {
    await promptRepository.insert({
      projectId,
      candidateId: cand.id,
      text: cand.text,
      createdBy: userId,
    });
    created += 1;
  }

  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: { created } };
}

// "수동 추가" — inserts editor-authored prompts without candidate links.
// Splits the input by newlines so spreadsheet pastes create one row per line.
export async function addManualPrompt(
  projectId: string,
  text: string,
): Promise<ActionResult<{ count: number }>> {
  const { userId } = await requireOwner(projectId);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { ok: false, error: "프롬프트 내용을 입력해주세요" };
  }
  for (const line of lines) {
    await promptRepository.insert({
      projectId,
      candidateId: null,
      text: line,
      createdBy: userId,
    });
  }
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: { count: lines.length } };
}

// Remove a row from the candidate pool. Scoped delete (projectId + id) so a
// forged id from another project is a no-op. Prompts already promoted from
// this candidate keep working — prompts.candidate_id is informational.
export async function deleteCandidate(
  projectId: string,
  candidateId: string,
): Promise<ActionResult> {
  await requireOwner(projectId);
  const deleted = await promptCandidateRepository.deleteForProject(
    projectId,
    candidateId,
  );
  if (!deleted) {
    return { ok: false, error: "삭제할 후보를 찾을 수 없습니다" };
  }
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: undefined };
}

// 선택 삭제 — bulk variant of deleteCandidate over the checkbox selection.
export async function deleteCandidates(
  projectId: string,
  candidateIds: string[],
): Promise<ActionResult<{ count: number }>> {
  await requireOwner(projectId);
  if (candidateIds.length === 0) {
    return { ok: false, error: "선택된 후보가 없습니다" };
  }
  const count = await promptCandidateRepository.deleteManyForProject(
    projectId,
    candidateIds,
  );
  if (count === 0) {
    return { ok: false, error: "삭제할 후보를 찾을 수 없습니다" };
  }
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: { count } };
}

// Remove a draft prompt from the working list (doesn't touch the candidate).
export async function deletePrompt(
  projectId: string,
  promptId: string,
): Promise<ActionResult> {
  await requireOwner(projectId);
  await promptRepository.delete(promptId);
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: undefined };
}

// ─── 측정된 프롬프트 라이프사이클 (측정 중지 / 재개 / 완전 삭제) ────────────
//
// draft 삭제(위 deletePrompt)와 달리, RUN 이후 프롬프트는 상태가 3개 시스템
// (scope 측정엔진 / 미러 / 로컬 카탈로그)에 분산된다. 순서 불변식:
//   완전 삭제 = ① scope 측정 중단 → ② 미러 이력 삭제 → ③ 로컬 행 삭제.
// ①이 실패하면 진행하지 않는다 — 미러만 지우면 scope가 계속 측정해 다음 sync가
// 이력을 다시 채우는 좀비가 된다. scope_prompt_id는 unique가 아니라서(브랜드 간
// 텍스트 공유·이중분류) 공유 행이 남아 있으면 scope·미러는 건드리지 않고 로컬
// 행만 제거한다 — 남은 행들의 측정·이력 보호.

export interface PromptLifecycleImpact {
  answers: number;
  mentions: number;
  citations: number;
  /** 같은 scope 프롬프트를 쓰는 다른 카탈로그 행 수 — 0이 아니면 공유 가드 발동 */
  sharedRows: number;
}

// 라이프사이클 팝업의 영향 미리보기 — 추상 경고 대신 실측 숫자를 보여준다.
export async function getPromptLifecycleImpact(
  projectId: string,
  promptId: string,
): Promise<ActionResult<PromptLifecycleImpact>> {
  await requireOwner(projectId);
  const row = await promptRepository.getById(promptId);
  if (!row || row.projectId !== projectId) {
    return { ok: false, error: "프롬프트를 찾을 수 없습니다" };
  }
  if (!row.scopePromptId) {
    return {
      ok: true,
      value: { answers: 0, mentions: 0, citations: 0, sharedRows: 0 },
    };
  }
  const [impact, sharedRows] = await Promise.all([
    scopeMirrorRepository.promptImpact(row.scopePromptId),
    promptRepository.countOthersByScopePromptId(row.scopePromptId, row.id),
  ]);
  return { ok: true, value: { ...impact, sharedRows } };
}

// 측정 중지 — scope active=false + 로컬 status='paused'. 이력·지표는 보존되고
// 언제든 재개 가능. scope 반영이 실패하면 로컬도 바꾸지 않는다(화면은 중지인데
// 측정·비용은 계속되는 불일치 방지).
export async function pausePrompt(
  projectId: string,
  promptId: string,
): Promise<ActionResult> {
  const { userId, role } = await requireOwner(projectId);
  const row = await promptRepository.getById(promptId);
  if (!row || row.projectId !== projectId) {
    return { ok: false, error: "프롬프트를 찾을 수 없습니다" };
  }
  if (row.status === "draft" || row.status === "paused") {
    return { ok: false, error: "측정 중인 프롬프트만 중지할 수 있습니다" };
  }
  if (row.scopePromptId) {
    const shared = await promptRepository.countOthersByScopePromptId(
      row.scopePromptId,
      row.id,
    );
    if (shared > 0) {
      return {
        ok: false,
        error: "다른 행과 측정을 공유하는 프롬프트는 개별로 중지할 수 없습니다",
      };
    }
    const project = await projectRepository.getById(projectId);
    if (project?.scopeProjectId) {
      try {
        await updateScopePrompt(project.scopeProjectId, row.scopePromptId, {
          enabled: false,
        });
      } catch {
        return {
          ok: false,
          error: "scope 반영에 실패했습니다 — 잠시 후 다시 시도해주세요",
        };
      }
    }
  }
  await promptRepository.setStatus(row.id, "paused");
  auditDataAccess({ id: userId, role }, "prompts", "lifecycle_pause");
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: undefined };
}

// 측정 재개 — 측정을 다시 유발하는 비용 액션이라 RUN과 같은 operator 게이트.
export async function resumePrompt(
  projectId: string,
  promptId: string,
): Promise<ActionResult> {
  const { userId, role } = await requireOperate(projectId);
  const row = await promptRepository.getById(promptId);
  if (!row || row.projectId !== projectId) {
    return { ok: false, error: "프롬프트를 찾을 수 없습니다" };
  }
  if (row.status !== "paused") {
    return { ok: false, error: "측정 중지된 프롬프트만 재개할 수 있습니다" };
  }
  if (row.scopePromptId) {
    const project = await projectRepository.getById(projectId);
    if (project?.scopeProjectId) {
      try {
        await updateScopePrompt(project.scopeProjectId, row.scopePromptId, {
          enabled: true,
        });
      } catch {
        return {
          ok: false,
          error: "scope 반영에 실패했습니다 — 잠시 후 다시 시도해주세요",
        };
      }
    }
  }
  // pause 대상은 측정 이력이 있는 행뿐이므로 done으로 복귀 — 다음 측정 주기에
  // sync의 status 피드백이 실제 상태를 다시 맞춘다.
  await promptRepository.setStatus(row.id, "done");
  auditDataAccess({ id: userId, role }, "prompts", "lifecycle_resume");
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: undefined };
}

// 완전 삭제 — 순서 불변식과 공유 가드는 위 블록 주석 참조. 미러 이력까지
// 삭제되므로 해당 기간 지표가 소급 변경된다(팝업이 2단계 확인으로 경고).
export async function deletePromptCascade(
  projectId: string,
  promptId: string,
): Promise<ActionResult> {
  const { userId, role } = await requireOwner(projectId);
  const row = await promptRepository.getById(promptId);
  if (!row || row.projectId !== projectId) {
    return { ok: false, error: "프롬프트를 찾을 수 없습니다" };
  }
  if (row.scopePromptId) {
    const shared = await promptRepository.countOthersByScopePromptId(
      row.scopePromptId,
      row.id,
    );
    if (shared === 0) {
      const project = await projectRepository.getById(projectId);
      // paused 행은 scope가 이미 중단된 상태 — 중단 호출 생략.
      if (project?.scopeProjectId && row.status !== "paused") {
        try {
          await updateScopePrompt(project.scopeProjectId, row.scopePromptId, {
            enabled: false,
          });
        } catch {
          return {
            ok: false,
            error:
              "scope 측정 중단에 실패해 삭제를 진행하지 않았습니다 — 잠시 후 다시 시도해주세요",
          };
        }
      }
      await scopeMirrorRepository.deletePromptData(row.scopePromptId);
    }
  }
  await promptRepository.delete(row.id);
  auditDataAccess(
    { id: userId, role },
    "prompts",
    `lifecycle_hard_delete scope_prompt=${row.scopePromptId ?? "none"}`,
  );
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: undefined };
}

// "저장 + 실행" — flips drafts to queued (stub for real AI batch dispatch)
// then redirects to the Analysis tab so the user lands where the answers
// will eventually surface (v22 §3-4 ⑦ "답변 확인 자동 이동").
export async function executePrompts(
  projectId: string,
  locale: string,
): Promise<ActionResult> {
  await requireOperate(projectId);
  const all = await promptRepository.listForProject(projectId);
  // RUN 대상 = draft + **복구 대상**(queued 인데 scope 에 안 올라간 행). 후자를
  // 포함시키는 이유: scope 장애로 푸시가 실패했는데도 예전 코드가 전건을 queued
  // 로 넘겨버려, draft 가 0개가 되고 이 액션이 "실행할 프롬프트가 없습니다"로
  // 조기 반환 → **RUN 이 유일한 지연 미러 경로인데 영구히 눌러지지 않는** 교착이
  // 됐다(2026-08-18 고아 6건 = queued 3건씩·scope_prompt_id 전부 NULL 실측).
  // 아래 enqueue 수정으로 신규 발생은 막히고, 이 필터가 기존 적체를 회수한다.
  const pending = all.filter(
    (p) =>
      p.status === "draft" || (p.status === "queued" && !p.scopePromptId),
  );
  if (pending.length === 0) {
    return { ok: false, error: "실행할 프롬프트가 없습니다" };
  }

  // Push into the project's scope mirror so scope measures them. LIVE-ONLY
  // (no-op in mock/demo — `skipped`). A scope outage never throws; it comes
  // back as pushedIds/failedCount so we can enqueue ONLY what scope accepted.
  // Each id is persisted the instant it's known (via the persist hooks) so an
  // interrupted push is always safe to re-RUN without duplicating.
  const project = await projectRepository.getById(projectId);
  const push = project
    ? await pushDraftPromptsToScope(
        {
          id: project.id,
          name: project.name,
          domain: project.domain,
          brand: project.brand,
          country: project.country,
          scopeProjectId: project.scopeProjectId,
        },
        pending.map((p) => ({
          id: p.id,
          text: p.text,
          brand: p.brand,
          category: p.category,
          scopePromptId: p.scopePromptId,
        })),
        {
          // 지연 미러 — 링크 + 저장된 엔진 선택을 스케줄로 전파(attachScopeMirror).
          onMirrorCreated: (scopeProjectId) =>
            attachScopeMirror(projectId, scopeProjectId, project.aiEngines),
          onPromptPushed: (localId, scopePromptId) =>
            promptRepository.setScopePromptId(localId, scopePromptId),
        },
      )
    : // 프로젝트 행을 못 읽으면 밀 곳을 모른다 — 실패로 보고 draft 를 보존한다.
      { pushedCount: 0, pushedIds: [], failedCount: pending.length, skipped: true };

  // mock·데모는 설계상 미러가 없으므로 종전대로 전건을 queued 로 넘긴다.
  // 라이브에서는 scope 가 받아준 것만 넘긴다 — 실패분을 draft 로 남겨야 다음
  // RUN 이 그대로 재시도 경로가 된다.
  const alreadyPushed = pending
    .filter((p) => p.scopePromptId)
    .map((p) => p.id);
  const toEnqueue = push.skipped
    ? pending.map((p) => p.id)
    : [...push.pushedIds, ...alreadyPushed];

  if (toEnqueue.length === 0) {
    // 한 건도 못 밀었다 — 상태를 바꾸지 않고(=draft 보존) 사용자에게 알린다.
    return {
      ok: false,
      error:
        "측정 엔진(scope) 연결에 실패해 실행하지 않았습니다. 프롬프트는 그대로 보관됐으니 잠시 후 다시 '저장 + 실행'을 눌러주세요.",
    };
  }

  await promptRepository.enqueueAll(projectId, toEnqueue);
  revalidatePath(`/projects/${projectId}/prompt`);
  redirect(`/${locale}/projects/${projectId}/analysis`);
}

// "엑셀 내보내기" — id + text + 프로젝트 커스텀 태그(헤더=태그 이름) 열로
// 직렬화. 태그 값은 prompt_custom_field_values에서 채운다. Read-only라 활성
// 멤버 누구나 내보낼 수 있다.
export async function exportPromptsXlsx(
  projectId: string,
): Promise<ActionResult<{ base64: string; filename: string }>> {
  await requireMember(projectId);
  const [all, fields, values] = await Promise.all([
    promptRepository.listForProject(projectId),
    projectCustomFieldRepository.listForProject(projectId),
    projectCustomFieldRepository.listValuesForProject(projectId),
  ]);
  const tags: ExportTag[] = fields
    .filter((f) => !f.archived)
    .map((f) => ({ id: f.id, label: f.label }));
  const valuesByPrompt = new Map<string, Record<string, string>>();
  for (const v of values) {
    const m = valuesByPrompt.get(v.promptId) ?? {};
    m[v.fieldId] = v.value;
    valuesByPrompt.set(v.promptId, m);
  }
  const rows: ExportablePrompt[] = all.map((p) => ({ id: p.id, text: p.text }));
  const buf = await buildWorkbook(rows, tags, valuesByPrompt);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return {
    ok: true,
    value: {
      base64: buf.toString("base64"),
      filename: `prompts-${projectId.slice(0, 8)}-${stamp}.xlsx`,
    },
  };
}

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  createdTags: number; // 헤더에서 자동 생성된 커스텀 태그 수
  warnings: string[];
}

// "엑셀 가져오기" — 예약 열 id/text + 나머지 헤더=커스텀 태그. id 있으면 수정,
// 없으면 신규(id는 시스템 발급이라 신규 추가 파일엔 id 열이 없다). 헤더에 있는
// 태그가 프로젝트에 없으면 자동 생성한다(사용자 결정 2026-07-31). Owner 전용.
// text는 초안(draft)만 변경 — 측정된 프롬프트 텍스트를 바꾸면 scope 측정과
// 어긋나기 때문. 태그 값은 상태와 무관하게 반영(측정 라벨링이 아닌 메타데이터).
export async function importPromptsXlsx(
  projectId: string,
  formData: FormData,
): Promise<ActionResult<ImportSummary>> {
  const { userId } = await requireOwner(projectId);

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "업로드된 파일이 없습니다" };
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const { rows, tagHeaders, warnings } = await parseWorkbook(buffer);

  const [existing, fields, values] = await Promise.all([
    promptRepository.listForProject(projectId),
    projectCustomFieldRepository.listForProject(projectId),
    projectCustomFieldRepository.listValuesForProject(projectId),
  ]);
  const byId = new Map(existing.map((p) => [p.id, p]));
  // 중복 본문 방지 (사용자 결정 2026-07-31) — id 없는 신규 행 대상. 이미
  // 프로젝트에 있는 본문(existingTexts) 또는 같은 파일 내 이미 넣은 본문
  // (seenNewTexts)이면 건너뛴다. 비교는 공백 제거한 trim 기준(대소문자 구분).
  const existingTexts = new Set(existing.map((p) => p.text.trim()));
  const seenNewTexts = new Set<string>();
  // 현재 태그 값(promptId → fieldId → value) — no-op 쓰기를 걸러 요약이 정확해진다.
  const curVals = new Map<string, Map<string, string>>();
  for (const v of values) {
    const m = curVals.get(v.promptId) ?? new Map<string, string>();
    m.set(v.fieldId, v.value);
    curVals.set(v.promptId, m);
  }

  // 태그 헤더(라벨) → fieldId. 없으면 자동 생성, 예약 라벨은 스킵.
  const fieldByLabel = new Map<string, string>(); // lowercased label → fieldId
  for (const f of fields) if (!f.archived) fieldByLabel.set(f.label.toLowerCase(), f.id);
  const labelToField = new Map<string, string>(); // 원문 헤더 라벨 → fieldId
  let createdTags = 0;
  for (const header of tagHeaders) {
    const key = header.toLowerCase();
    if (RESERVED_FIELD_LABELS.has(key)) {
      warnings.push(`'${header}' 은(는) 고정 분류축 이름이라 태그로 쓸 수 없어 건너뜁니다`);
      continue;
    }
    let fieldId = fieldByLabel.get(key);
    if (!fieldId) {
      try {
        const created = await projectCustomFieldRepository.insert({
          projectId,
          label: header,
          createdBy: userId,
        });
        fieldId = created.id;
        createdTags += 1;
      } catch (e) {
        // (projectId, label) unique 충돌(동시 생성/archived 동명 등) → 재조회.
        if (!(e instanceof Error && e.message.includes("unique"))) throw e;
        const refetched = await projectCustomFieldRepository.listForProject(projectId);
        fieldId = refetched.find((f) => f.label.toLowerCase() === key)?.id;
      }
      if (fieldId) fieldByLabel.set(key, fieldId);
    }
    if (fieldId) labelToField.set(header, fieldId);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    // 이 행의 태그 조작: present 태그 열 → { fieldId, value|null(비움) }.
    const tagOps: Array<{ fieldId: string; value: string | null }> = [];
    for (const [label, value] of Object.entries(row.tags)) {
      const fieldId = labelToField.get(label);
      if (fieldId) tagOps.push({ fieldId, value });
    }

    if (row.id) {
      const current = byId.get(row.id);
      if (!current) {
        skipped += 1;
        warnings.push(
          `행 ${row.rowNumber}: id를 이 프로젝트에서 찾을 수 없어 건너뜀 — 신규 등록은 id 칸을 비워두세요`,
        );
        continue;
      }
      let changed = false;
      // 본문은 초안만 변경.
      if (row.text != null && row.text !== current.text) {
        if (current.status === "draft") {
          await promptRepository.update(row.id, { text: row.text });
          changed = true;
        } else {
          warnings.push(
            `행 ${row.rowNumber}: 초안이 아니어서 본문은 변경하지 않음 (태그만 반영)`,
          );
        }
      }
      // 태그 값 반영 (현재 값과 다를 때만 — 요약 정확성).
      const rowVals = curVals.get(row.id);
      for (const op of tagOps) {
        const cur = rowVals?.get(op.fieldId);
        if (op.value === null) {
          if (cur !== undefined) {
            await projectCustomFieldRepository.clearValue(row.id, op.fieldId);
            changed = true;
          }
        } else if (cur !== op.value) {
          await projectCustomFieldRepository.setValue(row.id, op.fieldId, op.value);
          changed = true;
        }
      }
      if (changed) updated += 1;
      else skipped += 1;
    } else {
      // 신규 — 본문 필수.
      if (!row.text) {
        skipped += 1;
        warnings.push(`행 ${row.rowNumber}: id·본문이 없어 건너뜀`);
        continue;
      }
      const key = row.text.trim();
      if (existingTexts.has(key)) {
        skipped += 1;
        warnings.push(`행 ${row.rowNumber}: 이미 있는 본문이라 건너뜀`);
        continue;
      }
      if (seenNewTexts.has(key)) {
        skipped += 1;
        warnings.push(`행 ${row.rowNumber}: 파일 내 중복 본문이라 건너뜀`);
        continue;
      }
      seenNewTexts.add(key);
      const p = await promptRepository.insert({
        projectId,
        candidateId: null,
        text: row.text,
        createdBy: userId,
      });
      for (const op of tagOps) {
        if (op.value !== null) {
          await projectCustomFieldRepository.setValue(p.id, op.fieldId, op.value);
        }
      }
      created += 1;
    }
  }

  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: { created, updated, skipped, createdTags, warnings } };
}

// ─── 프로젝트 커스텀 태그 (다이나믹 스키마) ──────────────────────────────
//
// 브랜드/listType/Depth1~4/퍼널단계(HMG 고정 taxonomy)와 완전히 별도인
// 프로젝트별 사용자 정의 태그. 텍스트 단일 타입(2026-07-08 결정) — select/bool
// 타입과 옵션 목록 관리는 실사용 대비 과한 복잡도라 판단해 걷어냄. 재분석
// 플래그(flagPromptsForReanalysis)는 절대 건드리지 않는다 — 분석 파이프라인과
// 무관한 메타데이터 전용이기 때문.

// 기존 고정 컬럼과 헷갈리는 이름을 막는다 — 영문 키 + 화면에 보이는 한글
// 라벨(messages/ko.json::projectDetail.prompt.list.filter.*) 둘 다 포함.
// 프레임워크 축(listType/depth1~4/funnelStage)은 WBS 4.1.5(2026-07-23)로 프로젝트
// UI에서 은퇴하고 커스텀 필드로 이관 — 그 라벨(목록 유형/분류 N/퍼널 단계)은 더 이상
// 예약어가 아니다(이관 마이그레이션 0035가 그 이름의 커스텀 필드를 생성함).
const RESERVED_FIELD_LABELS = new Set(
  [
    "brand", "category", "prompttype",
    "브랜드", "카테고리",
  ].map((s) => s.toLowerCase()),
);

// requireOwner(projectId) only proves the caller owns *some* project by that
// id — it says nothing about whether the fieldId/promptId argument actually
// belongs to it. Every action below takes an id from the client, so each one
// must re-verify it resolves inside this project before touching it —
// otherwise an Owner of project X could pass project Y's fieldId/promptId and
// mutate Y's data (cross-project IDOR, found 2026-07-06 QA audit).
async function assertFieldInProject(
  projectId: string,
  fieldId: string,
): Promise<void> {
  const field = await projectCustomFieldRepository.getById(fieldId);
  if (!field || field.projectId !== projectId) {
    throw new UnauthorizedError("custom field does not belong to this project");
  }
}

async function assertPromptInProject(
  projectId: string,
  promptId: string,
): Promise<void> {
  const prompt = await promptRepository.getById(promptId);
  if (!prompt || prompt.projectId !== projectId) {
    throw new UnauthorizedError("prompt does not belong to this project");
  }
}

export async function addCustomField(
  projectId: string,
  input: { label: string },
): Promise<ActionResult<{ id: string }>> {
  const { userId } = await requireOwner(projectId);
  const label = input.label.trim();
  if (!label) return { ok: false, error: "태그 이름을 입력해주세요" };
  if (RESERVED_FIELD_LABELS.has(label.toLowerCase())) {
    return { ok: false, error: "기존 고정 분류축과 같은 이름은 사용할 수 없습니다" };
  }
  try {
    const created = await projectCustomFieldRepository.insert({
      projectId,
      label,
      createdBy: userId,
    });
    revalidatePath(`/projects/${projectId}/prompt`);
    return { ok: true, value: { id: created.id } };
  } catch (e) {
    if (e instanceof Error && e.message.includes("unique")) {
      return { ok: false, error: "이미 있는 태그입니다" };
    }
    throw e;
  }
}

export async function archiveCustomField(
  projectId: string,
  fieldId: string,
): Promise<ActionResult> {
  await requireOwner(projectId);
  await assertFieldInProject(projectId, fieldId);
  await projectCustomFieldRepository.archive(fieldId);
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: undefined };
}

export async function restoreCustomField(
  projectId: string,
  fieldId: string,
): Promise<ActionResult> {
  await requireOwner(projectId);
  await assertFieldInProject(projectId, fieldId);
  await projectCustomFieldRepository.restore(fieldId);
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: undefined };
}

export async function deleteCustomFieldHard(
  projectId: string,
  fieldId: string,
): Promise<ActionResult> {
  await requireOwner(projectId);
  await assertFieldInProject(projectId, fieldId);
  // Force delete: the field + all its assigned values in one transaction. The
  // UI confirms ("이 태그의 모든 값도 함께 삭제됩니다") when values exist, so no
  // server-side usage guard — deleting a tag intentionally drops its data.
  await projectCustomFieldRepository.delete(fieldId);
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: undefined };
}

export async function setPromptCustomFieldValue(
  projectId: string,
  promptId: string,
  fieldId: string,
  value: string,
): Promise<ActionResult> {
  await requireOwner(projectId);
  await assertFieldInProject(projectId, fieldId);
  await assertPromptInProject(projectId, promptId);
  const stored = value.trim();
  if (!stored) return { ok: false, error: "값을 입력해주세요" };
  await projectCustomFieldRepository.setValue(promptId, fieldId, stored);
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: undefined };
}

// 일괄 태깅 — 여러 프롬프트에 같은 태그값을 한 번에 부여. requireOwner + 각
// 프롬프트의 프로젝트 소속(IDOR)을 모두 검증한 뒤 단일 upsert 로 적용한다.
export async function setPromptCustomFieldValueBulk(
  projectId: string,
  promptIds: string[],
  fieldId: string,
  value: string,
): Promise<ActionResult<{ count: number }>> {
  await requireOwner(projectId);
  await assertFieldInProject(projectId, fieldId);
  const stored = value.trim();
  if (!stored) return { ok: false, error: "값을 입력해주세요" };
  const ids = [...new Set(promptIds)];
  if (ids.length === 0) return { ok: false, error: "프롬프트를 선택해주세요" };
  await Promise.all(ids.map((id) => assertPromptInProject(projectId, id)));
  await projectCustomFieldRepository.setValueBulk(ids, fieldId, stored);
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: { count: ids.length } };
}

export async function clearPromptCustomFieldValue(
  projectId: string,
  promptId: string,
  fieldId: string,
): Promise<ActionResult> {
  await requireOwner(projectId);
  await assertFieldInProject(projectId, fieldId);
  await assertPromptInProject(projectId, promptId);
  await projectCustomFieldRepository.clearValue(promptId, fieldId);
  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: undefined };
}
