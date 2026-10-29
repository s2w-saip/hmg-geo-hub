/**
 * Seeds the always-mock DEMO project used for manual / screenshot captures.
 *
 *   npx tsx --env-file=.env.local scripts/db/seed-demo.ts
 *
 * The demo project is a real DB row (fixed id = DEMO_PROJECT_ID) owned by
 * admin@hmg.test. Every project screen is fed purely from the local DB:
 *   - DB repositories (prompts / candidates / tracked entities / custom fields)
 *   - the scope_* MIRROR tables (dashboard / answer-analysis / ai-funnel read
 *     these via pure-SQL aggregates, so they render identically in live OR mock
 *     scope mode — no live scope call happens on any project page).
 *
 * Access is admin-only (enforced in the project layout). See lib/demo.ts.
 *
 * Idempotent: every row keyed by the fixed demo ids is deleted, then reinserted.
 * Safe to re-run; touches nothing outside the demo project.
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import {
  profiles,
  projects,
  projectMembers,
  prompts,
  promptCandidates,
  promptCustomFieldValues,
  projectCustomFields,
  projectOwnedBases,
  projectTrackedUrls,
  trackedBrands,
  trackedCompetitors,
  trackedVehicles,
  trackedKeywords,
  scopeRuns,
  scopeAnswers,
  scopeMentions,
  scopeCitations,
  scopeAcrRollups,
  scopePrompts,
  entityRegistry,
} from "../../lib/db/schema";
import { DEMO_PROJECT_ID, DEMO_SCOPE_PROJECT_ID } from "../../lib/demo";
import { HMG_BRAND_ENTITY_IDS } from "../../lib/scope/hmg-brands";
import {
  assertAcrRollupInvariants,
  planAcrCell,
  type AcrRollupInvariantRow,
} from "../../lib/scope/acr-cell-plan";

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) throw new Error("Missing env: DATABASE_URL");

const sql = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(sql);

// ─── Entities ──────────────────────────────────────────────────────────────
// Own = Hyundai (the project brand → gateway's per-project own-judgment context).
// Competitors get stable ids in a distinct block so own/competitor split is
// deterministic. entity_type='brand' → each brand rolls up to itself.
const OWN = { id: HMG_BRAND_ENTITY_IDS.Hyundai, name: "Hyundai" };
const COMPETITORS = [
  { id: "00000000-0000-0000-0000-000000000401", name: "Toyota", target: true },
  { id: "00000000-0000-0000-0000-000000000402", name: "Tesla", target: false },
  { id: "00000000-0000-0000-0000-000000000403", name: "BMW", target: false },
  { id: "00000000-0000-0000-0000-000000000404", name: "Volkswagen", target: false },
  { id: "00000000-0000-0000-0000-000000000405", name: "Volvo", target: false },
];
const ALL_BRANDS = [OWN, ...COMPETITORS.map((c) => ({ id: c.id, name: c.name }))];

// ─── Prompt catalog ──────────────────────────────────────────────────────────
type Funnel = "인지/탐색" | "비교/검증" | "구매/사후관리";
type PType = "comparison" | "recommendation" | "information" | "other";
interface PromptDef {
  text: string;
  brand: string; // "Hyundai" (branded) | "HMG" (umbrella / unbranded)
  funnel: Funnel;
  type: PType;
  kind: "single" | "acr";
}
const PROMPTS: PromptDef[] = [
  { text: "가족이 함께 타기 좋은 SUV 추천해줘", brand: "HMG", funnel: "인지/탐색", type: "recommendation", kind: "single" },
  { text: "7인승 SUV는 어떤 게 있어?", brand: "HMG", funnel: "인지/탐색", type: "information", kind: "single" },
  { text: "캠핑·차박하기 좋은 SUV 알려줘", brand: "HMG", funnel: "인지/탐색", type: "recommendation", kind: "single" },
  { text: "팰리세이드 실연비 어때?", brand: "Hyundai", funnel: "비교/검증", type: "information", kind: "single" },
  { text: "싼타페 하이브리드와 경쟁 모델 비교해줘", brand: "Hyundai", funnel: "비교/검증", type: "comparison", kind: "single" },
  { text: "3열이 넓은 패밀리 SUV 비교해줘", brand: "HMG", funnel: "비교/검증", type: "comparison", kind: "single" },
  { text: "현대 SUV 안전 사양(ADAS) 알려줘", brand: "Hyundai", funnel: "비교/검증", type: "information", kind: "single" },
  { text: "팰리세이드 견적과 트림별 가격은?", brand: "Hyundai", funnel: "구매/사후관리", type: "information", kind: "single" },
  { text: "현대 SUV 보증·유지비 조건 알려줘", brand: "Hyundai", funnel: "구매/사후관리", type: "information", kind: "single" },
  { text: "전기 패밀리 SUV 딱 하나만 추천한다면?", brand: "HMG", funnel: "인지/탐색", type: "recommendation", kind: "acr" },
  { text: "가성비 좋은 패밀리 SUV 최종 추천은?", brand: "HMG", funnel: "비교/검증", type: "recommendation", kind: "acr" },
  { text: "첫 차로 살 패밀리 SUV 하나만 골라줘", brand: "Hyundai", funnel: "구매/사후관리", type: "recommendation", kind: "acr" },
];

const ENGINES = ["chatgpt", "gemini"] as const;
const REGION = "KR";
const MODEL_SLUG: Record<(typeof ENGINES)[number], string> = {
  chatgpt: "gpt-4o",
  gemini: "gemini-3-pro",
};

// 8 runs over ~28 days (weekly-ish) → trend; the latest run is the snapshot.
const RUN_COUNT = 8;
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
// Run k (0 = oldest, RUN_COUNT-1 = newest/today).
const runDate = (k: number) => new Date(now - (RUN_COUNT - 1 - k) * 3.5 * DAY);

// KPI ⑥ AI 타겟 출처 인용률 = (자사 도메인 인용 답변 중 추적 URL을 정확히
// 인용한 답변) ÷ (자사 도메인 인용 답변). Requires EXACTLY ONE owned base
// (project_owned_bases) or the KPI is hidden. TRACKED_URLS must be cited
// verbatim to count as the numerator; project_tracked_urls stores the same
// strings. OWNED_CITE_PROMPTS decides which prompts cite the owned domain
// (denominator); TARGET_CITE maps a prompt to the exact tracked URL it cites
// (numerator). Snapshot: 8 owned prompts × 2 engines = 16 denom, {3,4,7} × 2 =
// 6 numer → ~37.5%.
const OWNED_BASE = "hyundai.com";
const TRACKED_URLS = {
  palisade: "https://hyundai.com/kr/ko/e/vehicles/palisade",
  santafe: "https://hyundai.com/kr/ko/e/vehicles/santafe",
};
const OWNED_CITE_PROMPTS = new Set([0, 1, 3, 4, 6, 7, 8, 9]);
const TARGET_CITE: Record<number, string> = {
  3: TRACKED_URLS.palisade,
  4: TRACKED_URLS.santafe,
  7: TRACKED_URLS.palisade,
};

// ─── Citation domain pool (category = 로컬 택소노미 정본 값) ─────────────────
// scope 는 인용 카테고리를 보내지 않는다 — 값은 lib/citation-categorizer/
// taxonomy.ts 의 CITATION_CATEGORIES 안에 있어야 한다. 밖의 문자열을 넣으면
// resolveCitationCategory 가 버리고 도메인 분류기 결과로 대체한다.
// Non-owned sources (CITE_POOL[1..]) for variety; the owned/target citations
// are inserted explicitly in the loop below so KPI ⑤/⑥ are deterministic.
const CITE_POOL: { domain: string; category: string; title: string }[] = [
  { domain: "hyundai.com", category: "Official (HMG)", title: "현대 SUV 라인업 | 현대자동차" },
  { domain: "motorgraph.com", category: "Automotive Media", title: "패밀리 SUV 비교 시승기" },
  { domain: "auto.danawa.com", category: "Automotive Media", title: "SUV 제원·가격 비교" },
  { domain: "youtube.com", category: "Community & Forums", title: "3열 SUV 실측 비교 영상" },
  { domain: "bobaedream.co.kr", category: "Community & Forums", title: "보배드림 - 패밀리카 고민" },
  { domain: "namu.wiki", category: "Wiki & Reference", title: "현대 팰리세이드 - 나무위키" },
  { domain: "clien.net", category: "Community & Forums", title: "클리앙 - 장거리 SUV 후기" },
  { domain: "consumer.go.kr", category: "Government & Public", title: "자동차 안전도 평가 결과" },
];

// Deterministic-ish jitter so the demo is stable-looking but not flat.
const wobble = (base: number, k: number, spread: number) =>
  base + Math.round(Math.sin(k * 1.7 + base) * spread);

async function main() {
  const adminRows = await db
    .select()
    .from(profiles)
    .where(eq(profiles.email, "admin@hmg.test"))
    .limit(1);
  const admin = adminRows[0];
  if (!admin) throw new Error("admin@hmg.test profile not found — run scripts/db/seed.ts first");

  // ── Idempotent teardown (demo scope only) ─────────────────────────────────
  const runRows = await db
    .select({ runId: scopeRuns.runId })
    .from(scopeRuns)
    .where(eq(scopeRuns.projectId, DEMO_SCOPE_PROJECT_ID));
  const runIds = runRows.map((r) => r.runId);
  if (runIds.length) {
    const jobRows = await db
      .select({ jobId: scopeAnswers.jobId })
      .from(scopeAnswers)
      .where(inArray(scopeAnswers.runId, runIds));
    const jobIds = jobRows.map((j) => j.jobId);
    if (jobIds.length) {
      await db.delete(scopeMentions).where(inArray(scopeMentions.jobId, jobIds));
      await db.delete(scopeCitations).where(inArray(scopeCitations.jobId, jobIds));
    }
    await db.delete(scopeAcrRollups).where(inArray(scopeAcrRollups.runId, runIds));
    await db.delete(scopeAnswers).where(inArray(scopeAnswers.runId, runIds));
    await db.delete(scopeRuns).where(inArray(scopeRuns.runId, runIds));
  }
  const oldPrompts = await db
    .select({ id: prompts.id, scopePromptId: prompts.scopePromptId })
    .from(prompts)
    .where(eq(prompts.projectId, DEMO_PROJECT_ID));
  const oldPromptIds = oldPrompts.map((p) => p.id);
  if (oldPromptIds.length) {
    await db.delete(promptCustomFieldValues).where(inArray(promptCustomFieldValues.promptId, oldPromptIds));
    const oldScopePromptIds = oldPrompts.map((p) => p.scopePromptId).filter(Boolean) as string[];
    if (oldScopePromptIds.length) {
      await db.delete(scopePrompts).where(inArray(scopePrompts.promptId, oldScopePromptIds));
    }
  }
  await db.delete(prompts).where(eq(prompts.projectId, DEMO_PROJECT_ID));
  await db.delete(promptCandidates).where(eq(promptCandidates.projectId, DEMO_PROJECT_ID));
  await db.delete(projectCustomFields).where(eq(projectCustomFields.projectId, DEMO_PROJECT_ID));
  await db.delete(trackedBrands).where(eq(trackedBrands.projectId, DEMO_PROJECT_ID));
  await db.delete(trackedCompetitors).where(eq(trackedCompetitors.projectId, DEMO_PROJECT_ID));
  await db.delete(trackedVehicles).where(eq(trackedVehicles.projectId, DEMO_PROJECT_ID));
  await db.delete(trackedKeywords).where(eq(trackedKeywords.projectId, DEMO_PROJECT_ID));
  await db.delete(projectOwnedBases).where(eq(projectOwnedBases.projectId, DEMO_PROJECT_ID));
  await db.delete(projectTrackedUrls).where(eq(projectTrackedUrls.projectId, DEMO_PROJECT_ID));
  await db.delete(projectMembers).where(eq(projectMembers.projectId, DEMO_PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, DEMO_PROJECT_ID));

  // ── Project row (fixed id, scope_project_id → synthetic mirror) ────────────
  await db.insert(projects).values({
    id: DEMO_PROJECT_ID,
    name: "현대 GEO 모니터링",
    description: "매뉴얼 캡쳐용 데모 프로젝트 (모든 수치는 합성 예시 데이터)",
    domain: "hyundai.com",
    brand: "Hyundai",
    country: REGION,
    language: "ko",
    scopeProjectId: DEMO_SCOPE_PROJECT_ID,
    createdBy: admin.id,
  });
  await db.insert(projectMembers).values({
    projectId: DEMO_PROJECT_ID,
    userId: admin.id,
    role: "owner",
    status: "active",
    invitedBy: admin.id,
    acceptedAt: new Date(),
  });

  // ── entity_registry: own roster (Hyundai) ─────────────────────────────────
  await db
    .insert(entityRegistry)
    .values({ entityId: OWN.id, name: OWN.name, role: "own", updatedBy: admin.id })
    .onConflictDoNothing();

  // ── Owned base + tracked URLs (KPI ⑤/⑥) ───────────────────────────────────
  // Exactly ONE owned base — KPI ⑥ AI 타겟 출처 인용률 is hidden with ≥2.
  await db.insert(projectOwnedBases).values([
    { projectId: DEMO_PROJECT_ID, baseUrl: OWNED_BASE, label: "현대 공식 사이트", createdBy: admin.id },
  ]);
  await db.insert(projectTrackedUrls).values([
    { projectId: DEMO_PROJECT_ID, url: TRACKED_URLS.palisade, label: "팰리세이드 상세", createdBy: admin.id },
    { projectId: DEMO_PROJECT_ID, url: TRACKED_URLS.santafe, label: "싼타페 상세", createdBy: admin.id },
  ]);

  // ── Tracked entities ──────────────────────────────────────────────────────
  await db.insert(trackedBrands).values([
    { projectId: DEMO_PROJECT_ID, canonicalName: "Hyundai", aliases: ["현대", "현대자동차", "HMC"] },
    { projectId: DEMO_PROJECT_ID, canonicalName: "Genesis", aliases: ["제네시스"] },
  ]);
  await db.insert(trackedCompetitors).values(
    COMPETITORS.map((c) => ({
      projectId: DEMO_PROJECT_ID,
      brandName: c.name,
      aliases: c.name === "Volkswagen" ? ["VW", "폭스바겐"] : [c.name],
      isTarget: c.target,
      notes: c.target ? "KPI #16 비교 기준 브랜드" : null,
    })),
  );
  await db.insert(trackedVehicles).values([
    { projectId: DEMO_PROJECT_ID, brand: "Hyundai", model: "팰리세이드", segment: "대형 SUV", aliases: ["Palisade"] },
    { projectId: DEMO_PROJECT_ID, brand: "Hyundai", model: "싼타페", segment: "중형 SUV", aliases: ["Santa Fe"] },
    { projectId: DEMO_PROJECT_ID, brand: "Hyundai", model: "투싼", segment: "준중형 SUV", aliases: ["Tucson"] },
    { projectId: DEMO_PROJECT_ID, brand: "Toyota", model: "하이랜더", segment: "대형 SUV", aliases: ["Highlander"] },
    { projectId: DEMO_PROJECT_ID, brand: "Tesla", model: "모델 Y", segment: "전기 SUV", aliases: ["Model Y"] },
  ]);
  await db.insert(trackedKeywords).values(
    ["패밀리 SUV", "7인승 SUV", "하이브리드 SUV", "전기 SUV 추천", "차박 SUV"].map((term) => ({
      projectId: DEMO_PROJECT_ID,
      term,
      country: REGION,
    })),
  );

  // ── Custom fields + values ────────────────────────────────────────────────
  const [campaignField] = await db
    .insert(projectCustomFields)
    .values({ projectId: DEMO_PROJECT_ID, label: "캠페인", createdBy: admin.id })
    .returning();
  const [priorityField] = await db
    .insert(projectCustomFields)
    .values({ projectId: DEMO_PROJECT_ID, label: "우선순위", createdBy: admin.id })
    .returning();

  // ── Prompt catalog rows + scope_prompts twins ─────────────────────────────
  const promptIdByIdx: string[] = [];
  const scopePromptRows: { promptId: string; text: string; funnelStage: string }[] = [];
  const promptRows: (typeof prompts.$inferInsert)[] = [];
  PROMPTS.forEach((p) => {
    const promptId = randomUUID(); // shared: prompts.scope_prompt_id = scope_prompts.prompt_id = scope_answers.prompt_id
    promptIdByIdx.push(promptId);
    scopePromptRows.push({ promptId, text: p.text, funnelStage: p.funnel });
    promptRows.push({
      projectId: DEMO_PROJECT_ID,
      text: p.text,
      promptType: p.type,
      category: p.funnel,
      brand: p.brand,
      funnelStage: p.funnel,
      kind: p.kind,
      scopePromptId: promptId,
      status: "done",
      createdBy: admin.id,
    });
  });
  await db.insert(scopePrompts).values(scopePromptRows);
  const insertedPrompts = await db.insert(prompts).values(promptRows).returning({ id: prompts.id });

  // custom-field values on the first few prompts (for the prompt table demo)
  await db.insert(promptCustomFieldValues).values([
    { promptId: insertedPrompts[0].id, fieldId: campaignField.id, value: "2026 신학기" },
    { promptId: insertedPrompts[0].id, fieldId: priorityField.id, value: "상" },
    { promptId: insertedPrompts[3].id, fieldId: campaignField.id, value: "팰리세이드 F/L" },
    { promptId: insertedPrompts[3].id, fieldId: priorityField.id, value: "상" },
    { promptId: insertedPrompts[7].id, fieldId: priorityField.id, value: "중" },
  ]);

  // ── Candidate pool (mixed sources) ────────────────────────────────────────
  await db.insert(promptCandidates).values([
    { projectId: DEMO_PROJECT_ID, source: "social_scraping", sourceKeyword: "다자녀 가구", text: "다자녀 가족에게 맞는 7인승 SUV 추천해줘" },
    { projectId: DEMO_PROJECT_ID, source: "social_scraping", sourceKeyword: "3열 풀사이즈 × 트렁크 적재", text: "3열 넓고 트렁크도 큰 SUV 중 가성비 좋은 차는?" },
    { projectId: DEMO_PROJECT_ID, source: "google_keyword", sourceKeyword: "하이브리드 SUV", text: "하이브리드 패밀리 SUV 실연비 순위 알려줘" },
    { projectId: DEMO_PROJECT_ID, source: "google_keyword", sourceKeyword: "전기 SUV 보조금", text: "보조금 받으면 전기 SUV 실구매가 얼마야?" },
    { projectId: DEMO_PROJECT_ID, source: "manual", sourceKeyword: null, text: "현대 SUV vs 기아 SUV 뭐가 더 나아?" },
  ]);

  // ── Synthetic mirror: runs / answers / mentions / citations / acr ──────────
  const answerRows: (typeof scopeAnswers.$inferInsert)[] = [];
  const mentionRows: (typeof scopeMentions.$inferInsert)[] = [];
  const citationRows: (typeof scopeCitations.$inferInsert)[] = [];
  const acrRows: (typeof scopeAcrRollups.$inferInsert)[] = [];
  const runInserts: (typeof scopeRuns.$inferInsert)[] = [];

  for (let k = 0; k < RUN_COUNT; k++) {
    const runId = randomUUID();
    const started = runDate(k);
    const completed = new Date(started.getTime() + 30 * 60 * 1000);
    runInserts.push({
      runId,
      projectId: DEMO_SCOPE_PROJECT_ID,
      status: "completed",
      startedAt: started,
      completedAt: completed,
      totalJobs: PROMPTS.length * ENGINES.length,
    });

    PROMPTS.forEach((p, pi) => {
      const promptId = promptIdByIdx[pi];
      for (const engine of ENGINES) {
        const jobId = randomUUID();
        answerRows.push({
          jobId,
          runId,
          promptId,
          target: engine,
          region: REGION,
          status: "completed",
          measuredAt: started,
          modelSlug: MODEL_SLUG[engine],
          answerText: `${p.text} — 데모 응답 예시. 팰리세이드·싼타페 등 현대 SUV가 3열 공간과 안전 사양에서 우수하며, 경쟁 모델로는 하이랜더·모델 Y 등이 함께 언급됩니다. (합성 예시)`,
        });

        // Own (Hyundai) mention — strengthens over later runs (nice trend).
        const ownCount = 2 + Math.round((k / (RUN_COUNT - 1)) * 2) + (engine === "chatgpt" ? 1 : 0);
        const ownPos = Math.max(1, 2.4 - (k / (RUN_COUNT - 1)) * 0.9);
        mentionRows.push(mention(jobId, OWN.id, OWN.name, ownCount, ownPos, "own", p.type));

        // 2–4 competitors sampled per (prompt, engine), deterministic by index.
        const compCount = 2 + ((pi + (engine === "gemini" ? 1 : 0)) % 3);
        for (let c = 0; c < compCount; c++) {
          const comp = COMPETITORS[(pi + c + k) % COMPETITORS.length];
          const cnt = Math.max(1, wobble(2, pi + c, 1));
          const pos = 2.6 + ((pi + c) % 3) * 0.5;
          mentionRows.push(mention(jobId, comp.id, comp.name, cnt, pos, "comp", p.type));
        }

        // Owned-domain citation (KPI ⑥ denominator) on a fixed prompt subset,
        // plus the exact tracked-URL citation (numerator) where mapped.
        if (OWNED_CITE_PROMPTS.has(pi)) {
          citationRows.push({
            jobId,
            url: `https://${OWNED_BASE}/${p.type}/${pi}`,
            domain: OWNED_BASE,
            title: CITE_POOL[0].title,
            refIndex: 1,
            category: CITE_POOL[0].category,
          });
          const target = TARGET_CITE[pi];
          if (target) {
            citationRows.push({
              jobId,
              url: target, // verbatim project_tracked_urls entry → KPI ⑥ numerator
              domain: OWNED_BASE,
              title: "현대 SUV 모델 상세 페이지",
              refIndex: 2,
              category: "Official (HMG)",
            });
          }
        }
        // 2–3 non-owned citations for source-composition variety.
        const nExtra = 2 + ((pi + k) % 2);
        for (let r = 0; r < nExtra; r++) {
          const pick = CITE_POOL[1 + ((pi + r + k) % (CITE_POOL.length - 1))];
          citationRows.push({
            jobId,
            url: `https://${pick.domain}/${p.type}/${pi}-${r}`,
            domain: pick.domain,
            title: pick.title,
            refIndex: 10 + r,
            category: pick.category,
          });
        }

        // ACR rollups for kind='acr' prompts (ai-funnel ACR screen).
        //
        // 셀(prompt_run) 예산을 브랜드들이 **나눠 갖는다**. 정본 계산기에서 한
        // iteration 의 최종 선택은 한 엔티티에게만 크레딧되므로
        // (scope store.ts:5330-5364 · rollupKeys 5453-5470),
        // Σ choice ≤ valid_acr_iterations · choice ≤ appearance 가 구조적으로
        // 성립해야 한다. 예전 시드는 브랜드마다 독립적으로 choice 를 만들어
        // 합이 예산을 넘겼다(issue #127: territory[KR·chatgpt] 15 ≤ 10 FAIL).
        //
        // 값은 engine 과 무관하게 만든다 — 이 블록은 두 engine 반복에서 각각
        // 셀을 만들지만 target 은 'chatgpt' 로 같아서, 값이 갈리면
        // latestAcrPromptRunIds 의 DISTINCT ON 동점 처리에 따라 화면이 흔들린다.
        if (p.kind === "acr") {
          const promptRunId = randomUUID();
          const s = pi + k; // 결정적 변주 시드 (engine 비의존)
          const plan = planAcrCell({
            plannedIterations: 10,
            // 일부 iteration 은 turn1 자체가 무효 → planned > validTurn1 형태를
            // 데모에도 남긴다(예전 시드는 셋을 전부 10으로 고정했다).
            invalidTurn1Iterations: s % 4 === 0 ? 1 : 0,
            // turn2 유효답변 없음 → breakdown.none (validAcr 에서 빠진다).
            noneIterations: 1 + (s % 2),
            conditionalMultipleIterations: s % 3 === 0 ? 1 : 0,
            unresolvedChoiceIterations: 0,
            entities: ALL_BRANDS.map((ent, ei) => ({
              entityId: ent.id,
              appearance: ent.id === OWN.id ? 8 + (k % 2) : 3 + ((pi + ei) % 4),
              // 자사 가중치가 회차에 따라 커진다 → ACR 상승 추세.
              weight: ent.id === OWN.id ? 6 + k : Math.max(1, 4 - ((pi + ei + k) % 4)),
            })),
          });
          plan.entities.forEach((e, ei) => {
            const ent = ALL_BRANDS[ei];
            acrRows.push({
              promptRunId,
              entityId: ent.id,
              runId,
              promptId,
              // 2026-08-30: 여기만 "chatgpt" 로 하드코딩돼 있었다 — 이 블록은
              // `for (const engine of ENGINES)` 안이라, 두 엔진이 **같은 셀 키**
              // (prompt_id, target, region)로 각각 롤업을 만들었다(48 = 3×8×2).
              // 그러면 latestAcrPromptRunIds 의 DISTINCT ON 이 measured_at 동점에서
              // 임의로 하나를 고른다. 답변·인용은 이미 `target: engine`(:348)이므로
              // ACR 만 어긋나 있었다.
              target: engine,
              region: REGION,
              measuredAt: started,
              rollupLevel: "brand",
              brand: ent.name,
              parentBrand: ent.name,
              brandRollupEntityId: ent.id,
              entityType: "Brand",
              plannedIterations: plan.plannedIterations,
              validTurn1Iterations: plan.validTurn1Iterations,
              validAcrIterations: plan.validAcrIterations,
              appearanceCount: e.appearanceCount,
              choiceCount: e.choiceCount,
              conditionalChoiceCount: e.conditionalChoiceCount,
              // 이하 셋은 정본에서도 셀 단위 공유 스칼라다 (store.ts:5391-5394).
              offShortlistChoiceCount: plan.coResolvedOffShortlist,
              unresolvedChoiceCount: plan.coUnresolvedChoice,
              genericChoiceCount: plan.coGenericCategory,
              appearanceRate: e.appearanceRate,
              // 정본 ACR 분모는 등장 수가 아니라 유효 반복 수다 (store.ts:5387).
              acr: e.acr,
              overallChoiceShare: e.overallChoiceShare,
              // choice_outcome_breakdown — 셀 단위 공유값 (store.ts:5396).
              coSingleEntity: plan.coSingleEntity,
              coConditionalMultiple: plan.coConditionalMultiple,
              coGenericCategory: plan.coGenericCategory,
              coResolvedOffShortlist: plan.coResolvedOffShortlist,
              coUnresolvedChoice: plan.coUnresolvedChoice,
              coNone: plan.coNone,
            });
          });
        }
      }
    });
  }

  // 사후 단언 — 불가능한 값이 조용히 DB 에 앉는 경로를 남기지 않는다. 미러
  // insert 를 하나라도 시작하기 전에 던져서, 실패해도 데모가 반쯤 쓰이지 않게 한다.
  // (issue #127: 시드가 만든 Σchoice > validAcr 가 몇 달 뒤 int 테스트에서야 드러났다)
  assertAcrRollupInvariants(acrRows as AcrRollupInvariantRow[]);

  await db.insert(scopeRuns).values(runInserts);
  for (const c of chunk(answerRows)) await db.insert(scopeAnswers).values(c);
  for (const c of chunk(mentionRows)) await db.insert(scopeMentions).values(c);
  for (const c of chunk(citationRows)) await db.insert(scopeCitations).values(c);
  if (acrRows.length) for (const c of chunk(acrRows)) await db.insert(scopeAcrRollups).values(c);

  console.log(
    `seeded demo project ${DEMO_PROJECT_ID} (owner=admin@hmg.test)\n` +
      `  runs=${runInserts.length} answers=${answerRows.length} mentions=${mentionRows.length} ` +
      `citations=${citationRows.length} acr=${acrRows.length}\n` +
      `  URL: /ko/projects/${DEMO_PROJECT_ID}`,
  );
}

function mention(
  jobId: string,
  entityId: string,
  brand: string,
  count: number,
  avgPosition: number,
  side: "own" | "comp",
  ptype: PType,
): typeof scopeMentions.$inferInsert {
  // Sentiment: own skews positive; competitors more neutral.
  const pos = side === "own" ? Math.ceil(count * 0.7) : Math.floor(count * 0.35);
  const neg = side === "own" ? 0 : count >= 3 ? 1 : 0;
  const neu = Math.max(0, count - pos - neg);
  // Mention-type breakdown roughly follows the prompt's intent.
  const rec = ptype === "recommendation" ? count : ptype === "comparison" ? 0 : Math.floor(count / 2);
  const cmp = ptype === "comparison" ? count : 0;
  const mention = Math.max(0, count - rec - cmp);
  return {
    jobId,
    entityId,
    brand,
    entityType: "Brand",
    mentionCount: count,
    sentimentPositive: pos,
    sentimentNeutral: neu,
    sentimentNegative: neg,
    sentimentMixed: 0,
    avgPosition,
    surfaces: [brand],
    brandRollupEntityId: entityId,
    // scope stores entity_type capitalized ("Brand"/"Product"); the mention
    // aggregates (result-adapter.ts, scope-aggregates.ts) filter on === "Brand"
    // exactly, so lowercase silently drops every mention. Do NOT lowercase.
    typeMention: mention,
    typeRecommendation: rec,
    typeComparison: cmp,
    typeDefinition: 0,
    typeFinalChoice: 0,
  };
}

function chunk<T>(arr: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

main()
  .then(() => sql.end())
  .then(() => {
    console.log("done.");
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await sql.end();
    process.exit(1);
  });
