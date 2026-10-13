import { setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { scopeContextMapRepository } from "@/lib/db/repositories/scope-context-map";
import { scopeContextPromptRepository } from "@/lib/db/repositories/scope-context-prompts";
import {
  promptCandidateRepository,
  promptRepository,
} from "@/lib/db/repositories/prompts";
import {
  annotateSimilar,
  type ExistingPromptRef,
} from "@/lib/social-scraping/similarity";
import { SocialScrapingFlow } from "@/components/social-scraping/social-scraping-flow";
import { hghSource } from "@/lib/hgh/client";
import { throwForPage } from "@/lib/hgh/errors";
import { requireProjectPage } from "@/lib/hgh/adapters/project-gate";
import { isIntentApi, loadSocialScrapingPage } from "@/lib/hgh/adapters/intent";

// LLM 호출(더 생성 / 구성 생성 server actions)이 이 라우트로 POST된다 —
// OpenRouter 한 번이 수십 초까지 걸릴 수 있어 기본 함수 제한(10~15s)으로는
// 액션이 중간에 끊긴다. 미러 sync cron(300s)과 같은 관례.
export const maxDuration = 120;

// 2026-06-08: switched from a legacy project-scoped flat list-card stack (no
// prompt-catalog hand-off) to SocialScrapingFlow
// — the same input → exploring → 4-table context map shown at
// /customer-interest/social-scraping. Keeping the two routes in sync means a
// single place to evolve the social-scraping UX.
// 2026-07-07: `startAtContextMap` — every project shows the same real
// Automotive-industry corpus (there is no per-project scraping run), so this
// is a lookup-only view: no INPUT/EXPLORING stage, no back button, no
// per-project keyword in the title. Write access (프롬프트 카탈로그 추가) stays.
// Data comes from the scope_context_* mirror (lib/db/repositories/scope-context-map.ts)
// — a one-time snapshot of scope's live corpus, not the fake sample-data.ts.
// 2026-07-15: the context map is paged server-side now — the whole Top-350
// bundle no longer crosses the wire (openspec 2026-07-15-add-context-map-query).
//
// Sources (D8): the gate follows HGH_SOURCE_SESSION (api = GET /v1/projects/{id}, unit U2);
// the data follows HGH_SOURCE_G6 (unit U10): api = lib/hgh/adapters/intent.ts
// loadSocialScrapingPage (D6 (b): stats + the three first pages, then the project's generated
// prompts with server-computed similarity and "이미 추가됨" marks); legacy = the repositories below.
const PAGE_SIZE = 50;

export default async function ProjectIntentSocialScrapingPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  if (hghSource("SESSION") === "api") {
    await requireProjectPage(locale, id);
  } else {
    const project = await projectRepository.getById(id);
    if (!project) notFound();

    const membership = await projectMemberRepository.findMembership(
      id,
      session.user.id,
    );
    const isAdmin = session.user.role === "admin";
    if (!isAdmin && (!membership || membership.status !== "active")) {
      notFound();
    }
  }

  if (isIntentApi()) {
    let data;
    try {
      data = await loadSocialScrapingPage(id, PAGE_SIZE);
    } catch (e) {
      throwForPage(e, locale, { permission: "not-found" });
    }
    return (
      <div className="flex flex-col gap-6">
        <SocialScrapingFlow
          mode="standard"
          projectId={id}
          startAtContextMap
          stats={data.stats}
          initialPages={data.initialPages}
          generatedPrompts={data.generatedPrompts}
        />
      </div>
    );
  }

  // First page of each tab + corpus stats. Page turns / searches after this go
  // through /api/context-map. Detail (quotes, domains, links) is NOT loaded here
  // — it arrives when a row's dialog opens
  // (openspec/changes/2026-07-15-add-context-map-query).
  const [stats, contexts, conditions, combinations] = await Promise.all([
    scopeContextMapRepository.getStats(),
    scopeContextMapRepository.listContexts({ sort: "mentions", dir: "desc", page: 0, size: PAGE_SIZE }),
    scopeContextMapRepository.listConditions({ sort: "mentions", dir: "desc", page: 0, size: PAGE_SIZE }),
    scopeContextMapRepository.listCombinations({
      sort: "cooccurrence",
      dir: "desc",
      page: 0,
      size: PAGE_SIZE,
    }),
  ]);

  // Decision B (2026-07-09): brand/project-differentiated candidate prompts,
  // generated in hmg-geo via OpenRouter (not scope).
  //
  // 2026-07-16 (무한 로딩 수정): this page reads the CACHE ONLY. It used to
  // block first render on the OpenRouter call for cache-miss projects —
  // 3-min-per-attempt × 4 retries against Vercel's ~15s function limit reads
  // as an infinite spinner. Generation now starts client-side when the catalog
  // tab is opened (CatalogTable auto-runs the "더 생성" action on empty), so
  // page entry is always fast and the LLM wait renders as an in-tab spinner.
  const [addedTexts, registered, cached] = await Promise.all([
    // Texts already in the candidate pool → the catalog marks them "이미 추가됨".
    promptCandidateRepository.listTextsForProject(id),
    // Registered prompts — the similarity comparison set.
    promptRepository.listForProject(id),
    scopeContextPromptRepository.get(id).catch(() => null),
  ]);

  // Hide user-removed rows, then annotate what's left with the most similar
  // existing text (registered prompt / candidate pool) — read-time only.
  const similarityRefs: ExistingPromptRef[] = [
    ...registered.map((p) => ({ text: p.text, kind: "prompt" as const })),
    ...addedTexts.map((text) => ({ text, kind: "candidate" as const })),
  ];
  const generatedPrompts =
    cached && cached.prompts.length > 0
      ? annotateSimilar(
          cached.prompts.filter((p) => !p.removed),
          similarityRefs,
        )
      : null;

  return (
    <div className="flex flex-col gap-6">
      <SocialScrapingFlow
        mode="standard"
        projectId={id}
        startAtContextMap
        stats={stats}
        initialPages={{ contexts, conditions, combinations }}
        generatedPrompts={generatedPrompts ?? undefined}
        addedTexts={addedTexts}
      />
    </div>
  );
}
