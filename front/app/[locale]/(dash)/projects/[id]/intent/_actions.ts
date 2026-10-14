"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { canOperateProject } from "@/lib/auth/operator-policy";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import {
  promptCandidateRepository,
  promptRepository,
  type PromptSource,
} from "@/lib/db/repositories/prompts";
import {
  trackedKeywordRepository,
  trackedCompetitorRepository,
  trackedVehicleRepository,
} from "@/lib/db/repositories/tracked-entities";
import { scopeContextMapRepository } from "@/lib/db/repositories/scope-context-map";
import { scopeContextPromptRepository } from "@/lib/db/repositories/scope-context-prompts";
import {
  generateContextPrompts,
  generateFromSeeds,
} from "@/lib/social-scraping/generate-context-prompts";
import { buildSelectionSeeds } from "@/lib/social-scraping/selection-seeds";
import {
  annotateSimilar,
  type ExistingPromptRef,
} from "@/lib/social-scraping/similarity";
import { defaultModel } from "@/lib/openrouter/client";
import type { GeneratedPrompt } from "@/components/social-scraping/types";
import {
  apiAddCandidate,
  apiAddCandidates,
  apiAddTrackedKeyword,
  apiAddTrackedKeywords,
  apiGenerateMoreSocialPrompts,
  apiGenerateSelectedSocialPrompts,
  apiRemoveSocialPrompts,
  apiRemoveTrackedKeyword,
  apiRemoveTrackedKeywords,
  intentActionMessages,
  isIntentApi,
} from "@/lib/hgh/adapters/intent";

// Intent → prompt_candidates: surface the "+" buttons in the Google Keyword
// SERP rows + Social Scraping contexts. Each button calls addCandidate
// with the right source so the Prompt tab can later trace provenance.
//
// Authorization: intent collection is a COST action (GGMD scenario 3-2), so it
// is gated by operator authority — a global operator may collect on any in-scope
// project, an assigned operator only on projects they are an active member of,
// and a non-operator (vendor / un-flagged group user) never collects. Viewers
// without operator authority see the buttons greyed out — page layer hides them.
//
// Source (D8, unit U10): HGH_SOURCE_G6=api sends every action to the backend
// (lib/hgh/adapters/intent.ts: /v1/intent/candidates, /v1/intent/social/prompts,
// /v1/intent/keywords). Same signatures and ActionResult shapes; the backend applies the
// operator gate (resolve_project operate), and 401 / 403 / 404 throw UnauthorizedError as
// requireOperate did. Error texts: messages projectDetail.intent.actionErrors (ko = the strings
// below). revalidatePath calls stay where they were. Legacy (default) is the code below.

export type ActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

async function requireOperate(projectId: string): Promise<{ userId: string }> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const userId = session.user.id;

  const project = await projectRepository.getById(projectId);
  if (!project) throw new UnauthorizedError("project not found");

  const membership = await projectMemberRepository.findMembership(
    projectId,
    userId,
  );
  if (!canOperateProject(session.user, membership)) {
    throw new UnauthorizedError("intent collection requires operator authority");
  }
  return { userId };
}

export async function addCandidate(
  projectId: string,
  source: PromptSource,
  text: string,
  sourceKeyword: string | null,
): Promise<ActionResult<{ id: string }>> {
  if (isIntentApi()) {
    const r = await apiAddCandidate(projectId, source, text, sourceKeyword, await intentActionMessages());
    if (r.ok) revalidatePath(`/projects/${projectId}/prompt`);
    return r;
  }
  await requireOperate(projectId);

  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "프롬프트 내용이 비어 있습니다" };
  }
  if (source !== "google_keyword" && source !== "social_scraping") {
    return { ok: false, error: "Intent에서만 사용 가능한 source입니다" };
  }

  const created = await promptCandidateRepository.insert({
    projectId,
    source,
    text: trimmed,
    sourceKeyword: sourceKeyword?.trim() || null,
  });

  revalidatePath(`/projects/${projectId}/prompt`);
  return { ok: true, value: { id: created.id } };
}

// Bulk variant for the Social Scraping 프롬프트 카탈로그 추가 table — the user
// multi-selects generated prompts and sends them to the candidate pool in one
// action. Same operator gating as addCandidate; empty/blank texts are skipped.
export async function addCandidates(
  projectId: string,
  source: PromptSource,
  items: Array<{ text: string; sourceKeyword?: string | null }>,
): Promise<ActionResult<{ count: number; skipped: number }>> {
  if (isIntentApi()) {
    const r = await apiAddCandidates(projectId, source, items, await intentActionMessages());
    if (r.ok) revalidatePath(`/projects/${projectId}/prompt`);
    return r;
  }
  await requireOperate(projectId);

  if (source !== "google_keyword" && source !== "social_scraping") {
    return { ok: false, error: "Intent에서만 사용 가능한 source입니다" };
  }

  const rows = items
    .map((it) => ({
      text: it.text.trim(),
      sourceKeyword: it.sourceKeyword?.trim() || null,
    }))
    .filter((it) => it.text.length > 0);

  if (rows.length === 0) {
    return { ok: false, error: "전송할 프롬프트가 없습니다" };
  }

  // Dedup: never insert a text already in the project's candidate pool (a
  // catalog can be re-sent / revisited). Skipped count is surfaced in the toast.
  const existing = new Set(
    await promptCandidateRepository.listTextsForProject(projectId),
  );
  const seen = new Set<string>();
  const fresh = rows.filter((r) => {
    if (existing.has(r.text) || seen.has(r.text)) return false;
    seen.add(r.text);
    return true;
  });

  for (const row of fresh) {
    await promptCandidateRepository.insert({
      projectId,
      source,
      text: row.text,
      sourceKeyword: row.sourceKeyword,
    });
  }

  revalidatePath(`/projects/${projectId}/prompt`);
  return {
    ok: true,
    value: { count: fresh.length, skipped: rows.length - fresh.length },
  };
}

// The corpus label fed to the prompt LLM. The scope_context_* mirror is a
// single Automotive-industry corpus — it is not partitioned per project, so
// this is the same for everyone. (It used to be passed to getMatrix() as if it
// were a query; it never reached a WHERE clause. Making the corpus
// project-scoped is a product decision, not a refactor — openspec proposal.md
// "범위 밖".)
const CONTEXT_MAP_KEYWORD = "자동차";

// Social Scraping "더 생성" — pulls the next batch of context-map seeds (deeper
// into the corpus tail, skipping already-generated ids) and appends them to the
// project's cached prompt set. Returns the fresh prompts for the client to
// append. `exhausted` when the matrix tail is used up. Same operator gating.
export async function generateMoreSocialPrompts(
  projectId: string,
): Promise<ActionResult<{ prompts: GeneratedPrompt[]; exhausted: boolean }>> {
  if (isIntentApi()) {
    return apiGenerateMoreSocialPrompts(projectId, await intentActionMessages());
  }
  await requireOperate(projectId);

  const project = await projectRepository.getById(projectId);
  if (!project) return { ok: false, error: "project not found" };

  // Seeding wants "the strongest N signals", which a page cannot express — so
  // it reads the dedicated seed pool, not the (now paged) list surface. The
  // pool's defaults reproduce the Top-N the old getMatrix() carried, so what
  // gets generated is unchanged (openspec design.md D2).
  const [pool, competitors, vehicles, cached] = await Promise.all([
    scopeContextMapRepository.getSeedPool(),
    trackedCompetitorRepository.listForProject(projectId),
    trackedVehicleRepository.listForProject(projectId),
    scopeContextPromptRepository.get(projectId),
  ]);

  const existing = cached?.prompts ?? [];
  const excludeIds = new Set(existing.map((p) => p.id));

  let fresh: GeneratedPrompt[];
  try {
    fresh = await generateContextPrompts(
      pool,
      {
        brand: project.brand,
        competitors: competitors.map((c) => c.brandName),
        vehicles: vehicles.map((v) => `${v.brand} ${v.model}`),
      },
      CONTEXT_MAP_KEYWORD,
      { excludeIds },
    );
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "프롬프트 생성에 실패했습니다",
    };
  }

  if (fresh.length === 0) {
    return { ok: true, value: { prompts: [], exhausted: true } };
  }

  const persisted = await appendPromptCache(projectId, fresh, cached);
  if (!persisted) {
    return { ok: false, error: "다른 작업과 겹쳤습니다. 다시 시도해주세요" };
  }

  return {
    ok: true,
    value: { prompts: await annotateForProject(projectId, fresh), exhausted: false },
  };
}

// Append freshly generated prompts onto the project's cached set under the
// optimistic lock (0030). Returns false only on a persistent conflict; a repo
// throw (migration 0028 not applied) is swallowed — the cache is best-effort
// and the fresh prompts are still shown this session. Shared by "더 생성" and
// the 구성(selection) flow.
async function appendPromptCache(
  projectId: string,
  fresh: GeneratedPrompt[],
  firstRead: { prompts: GeneratedPrompt[]; version: number } | null,
): Promise<boolean> {
  try {
    const ok = await scopeContextPromptRepository.setIfUnchanged(
      projectId,
      [...(firstRead?.prompts ?? []), ...fresh],
      defaultModel(),
      firstRead?.version ?? null,
    );
    if (ok) return true;
    // Someone wrote between our read and our write. Appending our snapshot
    // would drop their change, so re-read and append onto THEIR set instead.
    // One retry only: a second conflict means real contention, and silently
    // looping would just hide it.
    const latest = await scopeContextPromptRepository.get(projectId);
    return scopeContextPromptRepository.setIfUnchanged(
      projectId,
      [...(latest?.prompts ?? []), ...fresh],
      defaultModel(),
      latest?.version ?? null,
    );
  } catch {
    return true;
  }
}

// Annotate a response (not the cache — similarity is read-time only) against
// registered prompts + the candidate pool.
async function annotateForProject(
  projectId: string,
  fresh: GeneratedPrompt[],
): Promise<GeneratedPrompt[]> {
  const [registered, candidateTexts] = await Promise.all([
    promptRepository.listForProject(projectId),
    promptCandidateRepository.listTextsForProject(projectId),
  ]);
  const refs: ExistingPromptRef[] = [
    ...registered.map((p) => ({ text: p.text, kind: "prompt" as const })),
    ...candidateTexts.map((text) => ({ text, kind: "candidate" as const })),
  ];
  return annotateSimilar(fresh, refs);
}

// 구성(selection) 생성 — the user hand-picks contexts / conditions /
// combinations while exploring the map, then derives prompts from exactly that
// selection (optionally crossing picked contexts × conditions). Ids are
// re-resolved to canonical rows server-side — names feed the LLM prompt, so the
// client is not trusted for them. Appends to the same per-project cache as
// "더 생성", so seed-id dedup and 삭제(removed) semantics apply unchanged.
export async function generateSelectedSocialPrompts(
  projectId: string,
  selection: {
    contextIds: string[];
    conditionIds: string[];
    combinations: Array<{ condAId: string; condBId: string }>;
    cross: boolean;
  },
): Promise<ActionResult<{ prompts: GeneratedPrompt[]; skippedExisting: number }>> {
  if (isIntentApi()) {
    return apiGenerateSelectedSocialPrompts(projectId, selection, await intentActionMessages());
  }
  await requireOperate(projectId);

  const project = await projectRepository.getById(projectId);
  if (!project) return { ok: false, error: "project not found" };

  const uniqueIds = [
    ...new Set([
      ...selection.contextIds,
      ...selection.conditionIds,
      ...selection.combinations.flatMap((c) => [c.condAId, c.condBId]),
    ]),
  ];
  if (uniqueIds.length === 0) {
    return { ok: false, error: "선택된 항목이 없습니다" };
  }

  const [entities, competitors, vehicles, cached] = await Promise.all([
    scopeContextMapRepository.getEntitySeeds(uniqueIds),
    trackedCompetitorRepository.listForProject(projectId),
    trackedVehicleRepository.listForProject(projectId),
    scopeContextPromptRepository.get(projectId),
  ]);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const asContext = (id: string) => {
    const e = byId.get(id);
    return e && e.type === "ConsumerContext" ? e : null;
  };
  const asCondition = (id: string) => {
    const e = byId.get(id);
    return e && e.type === "ConsumerRequirement" ? e : null;
  };

  const { seeds, skippedExisting } = buildSelectionSeeds({
    contexts: selection.contextIds
      .map(asContext)
      .filter((e): e is NonNullable<typeof e> => e !== null),
    conditions: selection.conditionIds
      .map(asCondition)
      .filter((e): e is NonNullable<typeof e> => e !== null),
    combinations: selection.combinations
      .map((c) => {
        const a = asCondition(c.condAId);
        const b = asCondition(c.condBId);
        return a && b ? { aId: a.id, aName: a.name, bId: b.id, bName: b.name } : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null),
    cross: selection.cross,
    excludeIds: new Set((cached?.prompts ?? []).map((p) => p.id)),
  });
  if (seeds.length === 0) {
    return { ok: true, value: { prompts: [], skippedExisting } };
  }

  let fresh: GeneratedPrompt[];
  try {
    fresh = await generateFromSeeds(
      seeds,
      {
        brand: project.brand,
        competitors: competitors.map((c) => c.brandName),
        vehicles: vehicles.map((v) => `${v.brand} ${v.model}`),
      },
      CONTEXT_MAP_KEYWORD,
    );
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "프롬프트 생성에 실패했습니다",
    };
  }
  if (fresh.length === 0) {
    return { ok: true, value: { prompts: [], skippedExisting } };
  }
  // Tag provenance before persisting — the catalog badges 구성 rows so they
  // read apart from the auto batches.
  fresh = fresh.map((p) => ({ ...p, origin: "composed" as const }));

  const persisted = await appendPromptCache(projectId, fresh, cached);
  if (!persisted) {
    return { ok: false, error: "다른 작업과 겹쳤습니다. 다시 시도해주세요" };
  }

  return {
    ok: true,
    value: { prompts: await annotateForProject(projectId, fresh), skippedExisting },
  };
}

// Social Scraping 카탈로그 삭제(단건·선택 공용) — hard-delete가 아니라 캐시
// 항목에 removed 마킹. 통째로 지우면 seed id가 "더 생성" exclude 집합에서
// 빠져 같은 프롬프트가 다음 배치에 재등장한다. Same operator gating.
export async function removeSocialPrompts(
  projectId: string,
  promptIds: string[],
): Promise<ActionResult<{ count: number }>> {
  if (isIntentApi()) {
    return apiRemoveSocialPrompts(projectId, promptIds, await intentActionMessages());
  }
  await requireOperate(projectId);

  if (promptIds.length === 0) {
    return { ok: false, error: "삭제할 프롬프트가 없습니다" };
  }
  const targets = new Set(promptIds);

  // Optimistic lock (0030): mark-removed is a read-modify-write over the whole
  // blob, so a concurrent "더 생성" would otherwise be clobbered by our snapshot
  // (or clobber us — the deleted prompt comes back). On conflict we re-apply the
  // same delete intent to the fresh set rather than replaying stale rows.
  // Two attempts: the retry is for an ordinary interleave, not for real contention.
  for (let attempt = 0; attempt < 2; attempt++) {
    const cached = await scopeContextPromptRepository.get(projectId);
    if (!cached || cached.prompts.length === 0) {
      return { ok: false, error: "삭제할 프롬프트를 찾을 수 없습니다" };
    }

    let count = 0;
    const next = cached.prompts.map((p) => {
      if (!targets.has(p.id) || p.removed) return p;
      count += 1;
      return { ...p, removed: true };
    });
    if (count === 0) {
      return { ok: false, error: "삭제할 프롬프트를 찾을 수 없습니다" };
    }

    const ok = await scopeContextPromptRepository.setIfUnchanged(
      projectId,
      next,
      defaultModel(),
      cached.version,
    );
    if (ok) return { ok: true, value: { count } };
  }

  return { ok: false, error: "다른 작업과 겹쳤습니다. 다시 시도해주세요" };
}

// ─── tracked keywords (Intent > Google Keyword) ──────────────────────────
//
// The Google Keyword view's tabs ARE the project's tracked keyword set. Adding
// a tab persists the term under the project; deleting removes it. Gated by the
// same operator authority as candidate collection (canEdit on the page).

export async function addTrackedKeyword(
  projectId: string,
  input: { term: string; country?: string | null },
): Promise<ActionResult<{ id: string }>> {
  if (isIntentApi()) {
    return apiAddTrackedKeyword(projectId, input, await intentActionMessages());
  }
  await requireOperate(projectId);

  const term = input.term.trim();
  if (!term) return { ok: false, error: "키워드를 입력해주세요" };

  try {
    const created = await trackedKeywordRepository.insert({
      projectId,
      term,
      country: input.country?.trim() || null,
    });
    return { ok: true, value: { id: created.id } };
  } catch (e) {
    // unique (project_id, term) collision → friendly message, not a 500.
    if (e instanceof Error && e.message.includes("unique")) {
      return { ok: false, error: "이미 추가된 키워드입니다" };
    }
    throw e;
  }
}

// Several keywords at once (관련 검색어 선택 추가 · 검색 결과 저장, B065): one action instead of
// one action per keyword. The answer per input, in input order, is what addTrackedKeyword answers
// for it alone. API source: apiAddTrackedKeywords (one items[] request per 100 rows). Legacy: the
// single add above, row by row as the screens did (a throw still stops at that row).
export async function addTrackedKeywords(
  projectId: string,
  inputs: Array<{ term: string; country?: string | null }>,
): Promise<ActionResult<{ id: string }>[]> {
  if (isIntentApi()) {
    return apiAddTrackedKeywords(projectId, inputs, await intentActionMessages());
  }
  const out: ActionResult<{ id: string }>[] = [];
  for (const input of inputs) out.push(await addTrackedKeyword(projectId, input));
  return out;
}

export async function removeTrackedKeyword(
  projectId: string,
  id: string,
): Promise<ActionResult<void>> {
  if (isIntentApi()) {
    return apiRemoveTrackedKeyword(projectId, id, await intentActionMessages());
  }
  await requireOperate(projectId);
  // Scoped delete: the id is client-supplied, so the projectId predicate — not
  // requireOperate alone — is what stops an operator of project A from deleting
  // project B's keyword by passing B's row id.
  const deleted = await trackedKeywordRepository.deleteForProject(projectId, id);
  if (!deleted) return { ok: false, error: "삭제할 키워드를 찾을 수 없습니다" };
  return { ok: true, value: undefined };
}

// 선택 삭제 — the keyword tab strip multi-selects tabs and removes them in one
// action. Same scoping guarantee as removeTrackedKeyword: ids outside the
// project simply don't match, so the count reflects what was actually removed.
export async function removeTrackedKeywords(
  projectId: string,
  ids: string[],
): Promise<ActionResult<{ count: number }>> {
  if (isIntentApi()) {
    return apiRemoveTrackedKeywords(projectId, ids, await intentActionMessages());
  }
  await requireOperate(projectId);

  if (ids.length === 0) return { ok: false, error: "삭제할 키워드가 없습니다" };

  const count = await trackedKeywordRepository.deleteManyForProject(
    projectId,
    ids,
  );
  if (count === 0) return { ok: false, error: "삭제할 키워드를 찾을 수 없습니다" };
  return { ok: true, value: { count } };
}
