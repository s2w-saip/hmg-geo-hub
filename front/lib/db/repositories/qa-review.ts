import "server-only";
import { unstable_cache } from "next/cache";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  qaAnswerLocks,
  qaAnswerReviews,
  qaReviewNotes,
  qaReviewSessions,
  type QaAnswerReviewRow,
  type QaReviewNoteRow,
} from "@/lib/db/schema";
import { STANDARD_ROOT_PROJECT_ID } from "@/lib/db/repositories/standards";
import { bulkMirrorRunVisibleSql } from "@/lib/db/repositories/scope-mirror-progress-read";
import type {
  QaFilter,
  QaNoteFilter,
  QaSurface,
  QaTargetKind,
  QaSeverity,
  QaFilterOptionsShape,
} from "@/lib/qa/filters";

// Raw Data QA Console 의 유일한 DB 접근점.
//
// ⚠️ 이 리포지토리는 `lib/db/scoped.ts::scopeWhere` 를 **쓰지 않는다.**
// 저장소의 나머지 전 표면은 role 스코프로 값을 가두지만, 검수 콘솔에는 role 이
// 존재하지 않는다 — 검수자는 GGMD 계정이 없는 외부 인력이고, 유일한 방어는
// lib/qa/auth.ts 의 쿠키 게이트다. 이 예외는 설계 문서 §3 "수용된 리스크"의 직접적인
// 귀결이며, 2026-09-04 에 제품 오너가 명시적으로 선택한 트레이드오프다.
// 정본: docs/specs/2026-09-04-raw-data-qa-console-design.md
//
// 검수 대상 모집단 = 미러 전체(표준 + 웹사이트 + 프로젝트). 표면 구분은 KPI 화면들처럼
// 프롬프트 카탈로그가 아니라 **run 의 소속 프로젝트**로 판정한다(§8.1).

// ─── 락 ─────────────────────────────────────────────────────────────────────

// 브라우저가 죽어도 이 시간이 지나면 다른 검수자가 가져간다.
// heartbeat 주기(30초)의 6배 — 일시적 네트워크 끊김으로는 뺏기지 않는다.
export const LOCK_TTL_SECONDS = 180;

const ttlCutoff = sql`now() - (${LOCK_TTL_SECONDS} || ' seconds')::interval`;

export type QaLock = {
  jobId: string;
  sessionId: string;
  reviewerName: string;
  acquiredAt: Date;
  heartbeatAt: Date;
};

export type LockResult =
  | { ok: true; lock: QaLock }
  | { ok: false; heldBy: { reviewerName: string; acquiredAt: Date } };

type Row = Record<string, unknown>;

function rows<T>(r: unknown): T[] {
  return r as unknown as T[];
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function dateOrNull(v: unknown): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

// 획득은 **단일 SQL 문**이다. read-then-write 로 나누면 두 검수자가 같은 답변을
// 동시에 열 때 둘 다 통과하는 창이 생긴다 — ON CONFLICT ... WHERE 가 그 창을 없앤다.
// 성공 = 신규 / 내 재획득(새로고침) / 만료 탈취. 실패 = 남이 살아 있는 락을 쥐고 있음.
export async function acquireLock(
  jobId: string,
  sessionId: string,
  reviewerName: string,
  retry = true,
): Promise<LockResult> {
  const db = getDb();
  const won = rows<Row>(
    await db.execute(sql`
      INSERT INTO qa_answer_locks (job_id, session_id, reviewer_name)
      VALUES (${jobId}, ${sessionId}, ${reviewerName})
      ON CONFLICT (job_id) DO UPDATE SET
        session_id    = EXCLUDED.session_id,
        reviewer_name = EXCLUDED.reviewer_name,
        acquired_at   = now(),
        heartbeat_at  = now()
      WHERE qa_answer_locks.session_id = EXCLUDED.session_id
         OR qa_answer_locks.heartbeat_at < ${ttlCutoff}
      RETURNING job_id, session_id, reviewer_name, acquired_at, heartbeat_at
    `),
  )[0];

  if (won) {
    return {
      ok: true,
      lock: {
        jobId: String(won.job_id),
        sessionId: String(won.session_id),
        reviewerName: String(won.reviewer_name),
        acquiredAt: dateOrNull(won.acquired_at) ?? new Date(),
        heartbeatAt: dateOrNull(won.heartbeat_at) ?? new Date(),
      },
    };
  }

  const [held] = await db.select().from(qaAnswerLocks).where(eq(qaAnswerLocks.jobId, jobId));
  // 경계 사례: 우리가 진 직후 상대가 락을 놓아 행이 사라졌다. 한 번만 재시도한다
  // (retry=false 로 내려가므로 무한 루프가 없다).
  if (!held) {
    if (retry) return acquireLock(jobId, sessionId, reviewerName, false);
    return { ok: false, heldBy: { reviewerName: "", acquiredAt: new Date() } };
  }
  return { ok: false, heldBy: { reviewerName: held.reviewerName, acquiredAt: held.acquiredAt } };
}

export async function heartbeatLock(jobId: string, sessionId: string): Promise<boolean> {
  const updated = await getDb()
    .update(qaAnswerLocks)
    .set({ heartbeatAt: new Date() })
    .where(and(eq(qaAnswerLocks.jobId, jobId), eq(qaAnswerLocks.sessionId, sessionId)))
    .returning({ jobId: qaAnswerLocks.jobId });
  return updated.length > 0;
}

// 소유자만 해제한다 — 남의 락을 지우는 경로를 만들지 않는다.
export async function releaseLock(jobId: string, sessionId: string): Promise<void> {
  await getDb()
    .delete(qaAnswerLocks)
    .where(and(eq(qaAnswerLocks.jobId, jobId), eq(qaAnswerLocks.sessionId, sessionId)));
}

export async function listLocks(jobIds: string[]): Promise<QaLock[]> {
  if (jobIds.length === 0) return [];
  const found = await getDb()
    .select()
    .from(qaAnswerLocks)
    .where(
      and(
        inArray(qaAnswerLocks.jobId, jobIds),
        sql`${qaAnswerLocks.heartbeatAt} > ${ttlCutoff}`,
      ),
    );
  return found as QaLock[];
}

// ─── 세션 ───────────────────────────────────────────────────────────────────

export async function createReviewSession(input: {
  reviewerName: string;
  userAgent?: string | null;
  ipHash?: string | null;
}): Promise<string> {
  const [row] = await getDb()
    .insert(qaReviewSessions)
    .values({
      reviewerName: input.reviewerName,
      userAgent: input.userAgent ?? null,
      ipHash: input.ipHash ?? null,
    })
    .returning({ id: qaReviewSessions.id });
  return row.id;
}

export async function touchReviewSession(sessionId: string): Promise<void> {
  await getDb()
    .update(qaReviewSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(qaReviewSessions.id, sessionId));
}

// ─── 표면 판정 + 필터 술어 ──────────────────────────────────────────────────

// run → surface 라벨. 매 행마다 3-way 조인하지 않고 run 을 한 번만 라벨링한다.
//   1) website_sites.scope_project_id 에 있으면 website (brand, country_code)
//   2) projects.scope_project_id 에 있으면 project (brand, country)
//   3) 그 외 / project_id NULL(레거시 run) 이면 standard
//      — brand 는 prompts(STANDARD_ROOT) 카탈로그에서 프롬프트로 끌어온다
//
// website_sites.scope_project_id 는 text, projects.scope_project_id 는 uuid 라
// 캐스팅이 비대칭인 것이 의도다(스키마가 그렇게 갈려 있다).
//
// ⚠️ **알려진 오분류 — 이번 정리에서 고치지 않았다.** 위 순서는 루트 판정이 없고
// `projects` 조회가 그 자리를 대신한다. 글로벌 루트도 `projects` 에 행이 있으므로
// **'project' 로 라벨되고**, `project_id` 가 NULL 인 레거시 run 이 대신 'standard' 로
// 떨어진다. 그래서 이 콘솔의 표면 필터에서 '글로벌'을 고르면 글로벌 답변이 안 나온다.
// 고치면 화면 결과가 **바뀌므로**(값 무변경 리팩터의 범위 밖) 축 전환 단계로 미뤘다.
//
// 어휘·판정 근거·생산자별 순서표의 정본: `lib/surface/run-surface.ts`
// (이 CTE 의 순서는 그 파일의 `QA_CONSOLE_SURFACE_ORDER` 에 값으로 박혀 있다).
// 여기를 고칠 때는 그 상수도 같이 고친다 — `lib/surface/run-surface.test.ts` 가 둘의
// 어긋남을 잡는다.
const RUN_SURFACE_CTE = sql`
  run_surface AS (
    SELECT r.run_id,
           CASE WHEN ws.scope_project_id IS NOT NULL THEN 'website'
                WHEN p.scope_project_id  IS NOT NULL THEN 'project'
                ELSE 'standard' END             AS surface,
           COALESCE(ws.brand, p.brand)          AS surface_brand,
           COALESCE(ws.country_code, p.country) AS surface_country
      FROM scope_runs r
      LEFT JOIN website_sites ws ON ws.scope_project_id = r.project_id::text
      LEFT JOIN projects      p  ON p.scope_project_id  = r.project_id
  )
`;

const SURFACE_SQL = sql`COALESCE(rs.surface, 'standard')`;
const BRAND_SQL = sql`COALESCE(rs.surface_brand, cat.brand)`;
const COUNTRY_SQL = sql`COALESCE(rs.surface_country, a.region)`;

// 목록·진행률·노트가 공유하는 FROM 절. scope_answers 를 기준으로 삼고,
// 필터가 필요로 하는 것만 LEFT JOIN 한다.
const ANSWER_FROM = sql`
  FROM scope_answers a
  LEFT JOIN run_surface   rs  ON rs.run_id = a.run_id
  LEFT JOIN scope_prompts sp  ON sp.prompt_id = a.prompt_id
  LEFT JOIN prompts       cat ON cat.scope_prompt_id = a.prompt_id
                             AND cat.project_id = ${STANDARD_ROOT_PROJECT_ID}
  LEFT JOIN qa_answer_reviews rv ON rv.job_id = a.job_id
`;

function inList(col: SQL, values: readonly string[]): SQL {
  return sql`${col} IN (${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;
}

// 필터 → SQL 술어. 빈 배열은 술어를 만들지 않는다(= 무제한).
function answerPredicates(f: QaFilter): SQL[] {
  const preds: SQL[] = [];
  if (f.surface?.length) preds.push(inList(SURFACE_SQL, f.surface));
  if (f.brand?.length) preds.push(inList(BRAND_SQL, f.brand));
  if (f.country?.length) preds.push(inList(COUNTRY_SQL, f.country));
  if (f.engine?.length) preds.push(inList(sql`a.target`, f.engine));
  if (f.lang?.length) preds.push(inList(sql`sp.lang`, f.lang));
  if (f.from) preds.push(sql`a.measured_at >= ${f.from}::date`);
  if (f.to) preds.push(sql`a.measured_at < (${f.to}::date + 1)`);
  if (f.q) preds.push(sql`sp.text ILIKE ${"%" + f.q + "%"}`);
  if (f.reviewer?.length) preds.push(inList(sql`rv.reviewer_name`, f.reviewer));
  if (f.state?.length) {
    // 여러 상태를 고르면 OR — "미검수 또는 이상"이 실제 운용에서 흔한 조합이다.
    const parts = f.state.map((s) =>
      s === "unreviewed" ? sql`rv.job_id IS NULL` : sql`rv.status = ${s}`,
    );
    preds.push(sql`(${sql.join(parts, sql` OR `)})`);
  }
  if (f.hasNotes) {
    preds.push(sql`EXISTS (SELECT 1 FROM qa_review_notes n WHERE n.job_id = a.job_id)`);
  }
  if (f.noMentions) {
    preds.push(sql`NOT EXISTS (SELECT 1 FROM scope_mentions m WHERE m.job_id = a.job_id)`);
  }
  return preds;
}

function whereClause(preds: SQL[]): SQL {
  if (preds.length === 0) return sql`WHERE true`;
  return sql`WHERE ${sql.join(preds, sql` AND `)}`;
}

// ─── 커서 ───────────────────────────────────────────────────────────────────

// 정렬은 (measured_at DESC NULLS LAST, job_id DESC). measured_at 이 NULL 인 행이
// 실제로 존재하므로(미러 초기 행) 커서도 그 두 구간을 나눠 다뤄야 한다.
function encodeCursor(measuredAt: Date | null, jobId: string): string {
  return Buffer.from(`${measuredAt ? measuredAt.toISOString() : ""}|${jobId}`).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { ts: string | null; jobId: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.indexOf("|");
    if (sep < 0) return null;
    const ts = raw.slice(0, sep);
    const jobId = raw.slice(sep + 1);
    if (!jobId) return null;
    return { ts: ts || null, jobId };
  } catch {
    return null;
  }
}

function cursorPredicate(cursor: string | undefined): SQL | null {
  if (!cursor) return null;
  const c = decodeCursor(cursor);
  if (!c) return null;
  if (c.ts === null) {
    // 이미 NULL 구간에 들어왔다 — 남은 것도 NULL 구간뿐이다.
    return sql`(a.measured_at IS NULL AND a.job_id < ${c.jobId}::uuid)`;
  }
  return sql`(
    a.measured_at < ${c.ts}::timestamptz
    OR (a.measured_at = ${c.ts}::timestamptz AND a.job_id < ${c.jobId}::uuid)
    OR a.measured_at IS NULL
  )`;
}

// ─── 목록 ───────────────────────────────────────────────────────────────────

export type QaReviewState = "unreviewed" | "ok" | "issue";

export type QaListRow = {
  jobId: string;
  promptText: string | null;
  surface: QaSurface;
  brand: string | null;
  country: string | null;
  engine: string;
  lang: string | null;
  measuredAt: Date | null;
  mentionCount: number;
  citationCount: number;
  noteCount: number;
  reviewStatus: QaReviewState;
  reviewerName: string | null;
  lock: QaLock | null;
};

export const QA_PAGE_SIZE = 50;

export async function listReviewAnswers(
  f: QaFilter,
  cursor?: string,
  limit: number = QA_PAGE_SIZE,
): Promise<{ rows: QaListRow[]; nextCursor: string | null }> {
  const preds = answerPredicates(f);
  preds.push(await bulkMirrorRunVisibleSql(sql`a.run_id`));
  const cur = cursorPredicate(cursor);
  if (cur) preds.push(cur);

  // limit + 1 행을 가져와 초과분 존재 여부로 다음 페이지를 판정한다.
  const raw = rows<Row>(
    await getDb().execute(sql`
      WITH ${RUN_SURFACE_CTE}
      SELECT a.job_id, a.target, a.measured_at,
             sp.text AS prompt_text, sp.lang,
             ${SURFACE_SQL} AS surface,
             ${BRAND_SQL}   AS brand,
             ${COUNTRY_SQL} AS country,
             (SELECT count(*) FROM scope_mentions  m WHERE m.job_id = a.job_id)::int AS mention_count,
             (SELECT count(*) FROM scope_citations c WHERE c.job_id = a.job_id)::int AS citation_count,
             (SELECT count(*) FROM qa_review_notes n WHERE n.job_id = a.job_id)::int AS note_count,
             rv.status AS review_status, rv.reviewer_name
      ${ANSWER_FROM}
      ${whereClause(preds)}
      ORDER BY a.measured_at DESC NULLS LAST, a.job_id DESC
      LIMIT ${limit + 1}
    `),
  );

  const page = raw.slice(0, limit);
  const hasMore = raw.length > limit;
  const list: QaListRow[] = page.map((r) => ({
    jobId: String(r.job_id),
    promptText: r.prompt_text == null ? null : String(r.prompt_text),
    surface: String(r.surface) as QaSurface,
    brand: r.brand == null ? null : String(r.brand),
    country: r.country == null ? null : String(r.country),
    engine: String(r.target ?? ""),
    lang: r.lang == null ? null : String(r.lang),
    measuredAt: dateOrNull(r.measured_at),
    mentionCount: num(r.mention_count),
    citationCount: num(r.citation_count),
    noteCount: num(r.note_count),
    reviewStatus: (r.review_status == null ? "unreviewed" : String(r.review_status)) as QaReviewState,
    reviewerName: r.reviewer_name == null ? null : String(r.reviewer_name),
    lock: null,
  }));

  // 락은 별도 조회로 붙인다 — 10초 폴링이 같은 값을 갱신하므로 목록 쿼리에
  // 조인해 캐시 가능성을 떨어뜨릴 이유가 없다.
  const locks = await listLocks(list.map((r) => r.jobId));
  const byJob = new Map(locks.map((l) => [l.jobId, l]));
  for (const r of list) r.lock = byJob.get(r.jobId) ?? null;

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(dateOrNull(last.measured_at), String(last.job_id)) : null;
  return { rows: list, nextCursor };
}

// 상세의 이전/다음 — 목록과 **같은 정렬**을 따라간다.
export async function getNeighbors(
  f: QaFilter,
  jobId: string,
): Promise<{ prev: string | null; next: string | null }> {
  const db = getDb();
  const bulkVisible = await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const [anchor] = rows<Row>(
    await db.execute(sql`
      SELECT measured_at, job_id FROM scope_answers a
       WHERE a.job_id = ${jobId}::uuid AND ${bulkVisible}
    `),
  );
  if (!anchor) return { prev: null, next: null };
  const ts = dateOrNull(anchor.measured_at);
  const preds = [...answerPredicates(f), bulkVisible];

  // next = 정렬상 뒤 (measured_at 이 더 과거이거나, 같고 job_id 가 더 작음)
  const after = ts
    ? sql`(a.measured_at < ${ts.toISOString()}::timestamptz
           OR (a.measured_at = ${ts.toISOString()}::timestamptz AND a.job_id < ${jobId}::uuid)
           OR a.measured_at IS NULL)`
    : sql`(a.measured_at IS NULL AND a.job_id < ${jobId}::uuid)`;
  // prev = 정렬상 앞
  const before = ts
    ? sql`(a.measured_at > ${ts.toISOString()}::timestamptz
           OR (a.measured_at = ${ts.toISOString()}::timestamptz AND a.job_id > ${jobId}::uuid))`
    : sql`(a.measured_at IS NOT NULL
           OR (a.measured_at IS NULL AND a.job_id > ${jobId}::uuid))`;

  const pick = async (extra: SQL, order: SQL) =>
    rows<Row>(
      await db.execute(sql`
        WITH ${RUN_SURFACE_CTE}
        SELECT a.job_id
        ${ANSWER_FROM}
        ${whereClause([...preds, extra])}
        ORDER BY ${order}
        LIMIT 1
      `),
    )[0];

  const [nextRow, prevRow] = await Promise.all([
    pick(after, sql`a.measured_at DESC NULLS LAST, a.job_id DESC`),
    pick(before, sql`a.measured_at ASC NULLS FIRST, a.job_id ASC`),
  ]);

  return {
    prev: prevRow ? String(prevRow.job_id) : null,
    next: nextRow ? String(nextRow.job_id) : null,
  };
}

// ─── 진행률 ─────────────────────────────────────────────────────────────────

export type QaProgress = { total: number; reviewed: number; issues: number; notes: number };

async function countProgress(f: QaFilter): Promise<QaProgress> {
  const bulkVisible = await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const [r] = rows<Row>(
    await getDb().execute(sql`
      WITH ${RUN_SURFACE_CTE}
      SELECT count(*)::int                                    AS total,
             count(rv.job_id)::int                            AS reviewed,
             count(*) FILTER (WHERE rv.status = 'issue')::int  AS issues,
             count(*) FILTER (
               WHERE EXISTS (SELECT 1 FROM qa_review_notes n WHERE n.job_id = a.job_id)
             )::int                                            AS notes
      ${ANSWER_FROM}
      ${whereClause([...answerPredicates(f), bulkVisible])}
    `),
  );
  return {
    total: num(r?.total),
    reviewed: num(r?.reviewed),
    issues: num(r?.issues),
    notes: num(r?.notes),
  };
}

// 필터 기준 + 전체 기준을 함께 낸다. 모집단이 미러 전체(십수만 행)라 전체 % 자체는
// 운용 지표가 되지 못한다 — 실제로 쓰이는 것은 필터 기준 쪽이고, 두 값을 나란히
// 두는 이유는 "내가 지금 보고 있는 조각이 전체의 어디쯤인가"를 잃지 않기 위해서다.
export async function getProgress(
  f: QaFilter,
): Promise<{ scoped: QaProgress; total: QaProgress }> {
  const key = JSON.stringify(f);
  const cached = unstable_cache(
    async () => {
      const [scoped, total] = await Promise.all([countProgress(f), countProgress({})]);
      return { scoped, total };
    },
    ["qa-progress", key],
    { revalidate: 30 },
  );
  return cached();
}

// ─── 필터 옵션 ──────────────────────────────────────────────────────────────

export type QaFilterOptions = QaFilterOptionsShape;

async function readFilterOptions(): Promise<QaFilterOptions> {
  const db = getDb();
  const bulkVisible = await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const [dims, reviewers] = await Promise.all([
    db.execute(sql`
      WITH ${RUN_SURFACE_CTE}
      SELECT DISTINCT ${BRAND_SQL} AS brand, ${COUNTRY_SQL} AS country,
             a.target AS engine, sp.lang AS lang
      ${ANSWER_FROM}
      WHERE ${bulkVisible}
    `),
    db.execute(sql`SELECT DISTINCT reviewer_name FROM qa_answer_reviews ORDER BY reviewer_name`),
  ]);

  const brand = new Set<string>();
  const country = new Set<string>();
  const engine = new Set<string>();
  const lang = new Set<string>();
  for (const r of rows<Row>(dims)) {
    if (r.brand) brand.add(String(r.brand));
    if (r.country) country.add(String(r.country));
    if (r.engine) engine.add(String(r.engine));
    if (r.lang) lang.add(String(r.lang));
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return {
    brand: sorted(brand),
    country: sorted(country),
    engine: sorted(engine),
    lang: sorted(lang),
    reviewer: rows<Row>(reviewers).map((r) => String(r.reviewer_name)),
  };
}

// 십수만 행 DISTINCT 스캔이라 매 렌더마다 돌릴 수 없다. 옵션 목록은 분 단위로
// 바뀌지 않으므로 5분 캐시로 충분하다.
export const listFilterOptions = unstable_cache(readFilterOptions, ["qa-filter-options"], {
  revalidate: 300,
});

// ─── 상세 (낱알 전수) ───────────────────────────────────────────────────────

export type QaSectionKey = "answer" | "prompt" | "mentions" | "citations" | "acr" | "meta";
export const QA_SECTION_KEYS: QaSectionKey[] = [
  "answer",
  "prompt",
  "mentions",
  "citations",
  "acr",
  "meta",
];
export type QaSectionFlags = Partial<Record<QaSectionKey, "ok" | "issue">>;

export type QaMentionGranule = {
  entityId: string;
  brand: string | null;
  entityType: string | null;
  mentionCount: number;
  sentimentPositive: number;
  sentimentNeutral: number;
  sentimentNegative: number;
  sentimentMixed: number;
  avgPosition: number | null;
  surfaces: string[] | null;
  brandRollupEntityId: string | null;
  rollupParentName: string | null;
  typeMention: number;
  typeRecommendation: number;
  typeComparison: number;
  typeDefinition: number;
  typeFinalChoice: number;
  registryRole: string | null;
  isOwn: boolean;
  isExcluded: boolean;
};

export type QaCitationGranule = {
  id: number;
  refIndex: number | null;
  url: string | null;
  domain: string | null;
  title: string | null;
  storedCategory: string | null;
  overrideCategory: string | null;
  effectiveCategory: string | null;
  urlNorm: string | null;
  urlHost: string | null;
  urlBaseNorm: string | null;
};

export type QaAcrGranule = {
  promptRunId: string;
  entityId: string;
  brand: string | null;
  parentBrand: string | null;
  rollupLevel: string | null;
  entityType: string | null;
  plannedIterations: number;
  validTurn1Iterations: number;
  validAcrIterations: number;
  appearanceCount: number;
  choiceCount: number;
  conditionalChoiceCount: number;
  offShortlistChoiceCount: number;
  unresolvedChoiceCount: number;
  genericChoiceCount: number;
  appearanceRate: number | null;
  acr: number | null;
  overallChoiceShare: number | null;
  coSingleEntity: number;
  coConditionalMultiple: number;
  coGenericCategory: number;
  coResolvedOffShortlist: number;
  coUnresolvedChoice: number;
  coNone: number;
};

export type QaAnswerDetail = {
  answer: {
    jobId: string;
    runId: string;
    promptId: string | null;
    target: string;
    region: string | null;
    status: string | null;
    measuredAt: Date | null;
    modelSlug: string | null;
    answerText: string | null;
    surface: QaSurface;
    brand: string | null;
    country: string | null;
  };
  prompt: {
    text: string | null;
    funnelStage: string | null;
    lang: string | null;
    regions: string[] | null;
    isKorean: boolean | null;
    catalog: {
      brand: string | null;
      brandPresence: string | null;
      listType: string | null;
      depth1: string | null;
      depth2: string | null;
      depth3: string | null;
      depth4: string | null;
      funnelStage: string | null;
      kind: string | null;
      promptType: string | null;
      category: string | null;
    } | null;
  };
  mentions: QaMentionGranule[];
  citations: QaCitationGranule[];
  acr: QaAcrGranule[];
  derived: {
    anchor: { anchor: string; sourceMeasuredAt: Date | null; reason: string | null } | null;
    drop: { sourceMeasuredAt: Date | null; reason: string; droppedAt: Date | null } | null;
  };
};

export async function getReviewAnswerDetail(jobId: string): Promise<QaAnswerDetail | null> {
  const db = getDb();
  const bulkVisible = await bulkMirrorRunVisibleSql(sql`a.run_id`);

  const [head] = rows<Row>(
    await db.execute(sql`
      WITH ${RUN_SURFACE_CTE}
      SELECT a.job_id, a.run_id, a.prompt_id, a.target, a.region, a.status,
             a.measured_at, a.model_slug, a.answer_text,
             ${SURFACE_SQL} AS surface, ${BRAND_SQL} AS brand, ${COUNTRY_SQL} AS country,
             sp.text AS prompt_text, sp.funnel_stage AS prompt_funnel,
             sp.lang AS prompt_lang, sp.regions AS prompt_regions, sp.is_korean,
             cat.brand AS cat_brand, cat.brand_presence AS cat_brand_presence,
             cat.list_type AS cat_list_type, cat.depth1, cat.depth2, cat.depth3, cat.depth4,
             cat.funnel_stage AS cat_funnel, cat.kind AS cat_kind,
             cat.prompt_type AS cat_prompt_type, cat.category AS cat_category,
             cat.id AS cat_id
      ${ANSWER_FROM}
      WHERE a.job_id = ${jobId}::uuid AND ${bulkVisible}
      LIMIT 1
    `),
  );
  if (!head) return null;

  const runId = String(head.run_id);
  const promptId = head.prompt_id == null ? null : String(head.prompt_id);
  const target = String(head.target ?? "");
  const region = head.region == null ? null : String(head.region);

  const [mentionRows, citationRows, acrRows, anchorRows, dropRows] = await Promise.all([
    // 멘션 낱알 + entity_registry 해소(자사/제외) + 롤업 부모 표시명.
    // 부모 이름은 같은 답변의 다른 멘션 행에 있을 수도, 명부에만 있을 수도 있다.
    db.execute(sql`
      SELECT m.*,
             er.role  AS registry_role,
             COALESCE(pm.brand, per.name) AS rollup_parent_name
        FROM scope_mentions m
        LEFT JOIN entity_registry er ON er.entity_id = m.entity_id
        LEFT JOIN scope_mentions pm  ON pm.job_id = m.job_id
                                    AND pm.entity_id = m.brand_rollup_entity_id
        LEFT JOIN entity_registry per ON per.entity_id = m.brand_rollup_entity_id
       WHERE m.job_id = ${jobId}::uuid
       ORDER BY m.mention_count DESC, m.brand NULLS LAST
    `),
    // 인용 낱알 + 도메인 오버라이드. 저장값과 유효값을 **둘 다** 낸다 —
    // 검수자가 "분류가 왜 이렇지"를 볼 때 오버라이드 때문인지 원 분류 때문인지
    // 구분할 수 있어야 한다.
    db.execute(sql`
      SELECT c.id, c.ref_index, c.url, c.domain, c.title, c.category AS stored_category,
             c.url_norm, c.url_host, c.url_base_norm,
             o.category AS override_category
        FROM scope_citations c
        LEFT JOIN citation_domain_overrides o ON o.domain = c.domain
       WHERE c.job_id = ${jobId}::uuid
       ORDER BY c.ref_index NULLS LAST, c.id
    `),
    // ACR 은 job 이 아니라 prompt-run 키라 직접 조인이 불가능하다.
    // (run, prompt, engine, region) 4축으로 근사 연결한다 — 화면에 "답변 단위 아님"을 명시.
    promptId
      ? db.execute(sql`
          SELECT * FROM scope_acr_rollups
           WHERE run_id = ${runId}::uuid
             AND prompt_id = ${promptId}::uuid
             AND target IS NOT DISTINCT FROM ${target}
             AND region IS NOT DISTINCT FROM ${region}
           ORDER BY acr DESC NULLS LAST, brand
        `)
      : Promise.resolve([]),
    db.execute(sql`SELECT * FROM scope_answer_anchors WHERE job_id = ${jobId}::uuid`),
    db.execute(sql`SELECT * FROM scope_answer_drops   WHERE job_id = ${jobId}::uuid`),
  ]);

  const mentions: QaMentionGranule[] = rows<Row>(mentionRows).map((m) => {
    const role = m.registry_role == null ? null : String(m.registry_role);
    return {
      entityId: String(m.entity_id),
      brand: m.brand == null ? null : String(m.brand),
      entityType: m.entity_type == null ? null : String(m.entity_type),
      mentionCount: num(m.mention_count),
      sentimentPositive: num(m.sentiment_positive),
      sentimentNeutral: num(m.sentiment_neutral),
      sentimentNegative: num(m.sentiment_negative),
      sentimentMixed: num(m.sentiment_mixed),
      avgPosition: m.avg_position == null ? null : Number(m.avg_position),
      surfaces: (m.surfaces as string[] | null) ?? null,
      brandRollupEntityId:
        m.brand_rollup_entity_id == null ? null : String(m.brand_rollup_entity_id),
      rollupParentName: m.rollup_parent_name == null ? null : String(m.rollup_parent_name),
      typeMention: num(m.type_mention),
      typeRecommendation: num(m.type_recommendation),
      typeComparison: num(m.type_comparison),
      typeDefinition: num(m.type_definition),
      typeFinalChoice: num(m.type_final_choice),
      registryRole: role,
      isOwn: role === "own",
      isExcluded: role === "excluded",
    };
  });

  const citations: QaCitationGranule[] = rows<Row>(citationRows).map((c) => {
    const stored = c.stored_category == null ? null : String(c.stored_category);
    const override = c.override_category == null ? null : String(c.override_category);
    return {
      id: num(c.id),
      refIndex: c.ref_index == null ? null : num(c.ref_index),
      url: c.url == null ? null : String(c.url),
      domain: c.domain == null ? null : String(c.domain),
      title: c.title == null ? null : String(c.title),
      storedCategory: stored,
      overrideCategory: override,
      effectiveCategory: override ?? stored,
      urlNorm: c.url_norm == null ? null : String(c.url_norm),
      urlHost: c.url_host == null ? null : String(c.url_host),
      urlBaseNorm: c.url_base_norm == null ? null : String(c.url_base_norm),
    };
  });

  const acr: QaAcrGranule[] = rows<Row>(acrRows).map((r) => ({
    promptRunId: String(r.prompt_run_id),
    entityId: String(r.entity_id),
    brand: r.brand == null ? null : String(r.brand),
    parentBrand: r.parent_brand == null ? null : String(r.parent_brand),
    rollupLevel: r.rollup_level == null ? null : String(r.rollup_level),
    entityType: r.entity_type == null ? null : String(r.entity_type),
    plannedIterations: num(r.planned_iterations),
    validTurn1Iterations: num(r.valid_turn1_iterations),
    validAcrIterations: num(r.valid_acr_iterations),
    appearanceCount: num(r.appearance_count),
    choiceCount: num(r.choice_count),
    conditionalChoiceCount: num(r.conditional_choice_count),
    offShortlistChoiceCount: num(r.off_shortlist_choice_count),
    unresolvedChoiceCount: num(r.unresolved_choice_count),
    genericChoiceCount: num(r.generic_choice_count),
    appearanceRate: r.appearance_rate == null ? null : Number(r.appearance_rate),
    acr: r.acr == null ? null : Number(r.acr),
    overallChoiceShare: r.overall_choice_share == null ? null : Number(r.overall_choice_share),
    coSingleEntity: num(r.co_single_entity),
    coConditionalMultiple: num(r.co_conditional_multiple),
    coGenericCategory: num(r.co_generic_category),
    coResolvedOffShortlist: num(r.co_resolved_off_shortlist),
    coUnresolvedChoice: num(r.co_unresolved_choice),
    coNone: num(r.co_none),
  }));

  const anchorRow = rows<Row>(anchorRows)[0];
  const dropRow = rows<Row>(dropRows)[0];

  return {
    answer: {
      jobId: String(head.job_id),
      runId,
      promptId,
      target,
      region,
      status: head.status == null ? null : String(head.status),
      measuredAt: dateOrNull(head.measured_at),
      modelSlug: head.model_slug == null ? null : String(head.model_slug),
      answerText: head.answer_text == null ? null : String(head.answer_text),
      surface: String(head.surface) as QaSurface,
      brand: head.brand == null ? null : String(head.brand),
      country: head.country == null ? null : String(head.country),
    },
    prompt: {
      text: head.prompt_text == null ? null : String(head.prompt_text),
      funnelStage: head.prompt_funnel == null ? null : String(head.prompt_funnel),
      lang: head.prompt_lang == null ? null : String(head.prompt_lang),
      regions: (head.prompt_regions as string[] | null) ?? null,
      isKorean: head.is_korean == null ? null : Boolean(head.is_korean),
      // 카탈로그 행이 없으면 null — 프로젝트·웹사이트 프롬프트는 표준 카탈로그 밖이다.
      catalog: head.cat_id
        ? {
            brand: head.cat_brand == null ? null : String(head.cat_brand),
            brandPresence:
              head.cat_brand_presence == null ? null : String(head.cat_brand_presence),
            listType: head.cat_list_type == null ? null : String(head.cat_list_type),
            depth1: head.depth1 == null ? null : String(head.depth1),
            depth2: head.depth2 == null ? null : String(head.depth2),
            depth3: head.depth3 == null ? null : String(head.depth3),
            depth4: head.depth4 == null ? null : String(head.depth4),
            funnelStage: head.cat_funnel == null ? null : String(head.cat_funnel),
            kind: head.cat_kind == null ? null : String(head.cat_kind),
            promptType: head.cat_prompt_type == null ? null : String(head.cat_prompt_type),
            category: head.cat_category == null ? null : String(head.cat_category),
          }
        : null,
    },
    mentions,
    citations,
    acr,
    derived: {
      anchor: anchorRow
        ? {
            anchor: String(anchorRow.anchor),
            sourceMeasuredAt: dateOrNull(anchorRow.source_measured_at),
            reason: anchorRow.reason == null ? null : String(anchorRow.reason),
          }
        : null,
      drop: dropRow
        ? {
            sourceMeasuredAt: dateOrNull(dropRow.source_measured_at),
            reason: String(dropRow.reason),
            droppedAt: dateOrNull(dropRow.dropped_at),
          }
        : null,
    },
  };
}

// ─── 판정 ───────────────────────────────────────────────────────────────────

export async function getReview(jobId: string): Promise<QaAnswerReviewRow | null> {
  const [row] = await getDb()
    .select()
    .from(qaAnswerReviews)
    .where(eq(qaAnswerReviews.jobId, jobId));
  return row ?? null;
}

export async function upsertReview(input: {
  jobId: string;
  sectionFlags: QaSectionFlags;
  reviewerName: string;
  sessionId: string | null;
}): Promise<{ status: "ok" | "issue" }> {
  // status 는 파생값이다 — 검수자가 따로 고르지 않는다(설계 §5).
  // 블록 중 하나라도 '이상'이면 이 답변은 '이상'이다.
  const status: "ok" | "issue" = Object.values(input.sectionFlags).includes("issue")
    ? "issue"
    : "ok";
  await getDb()
    .insert(qaAnswerReviews)
    .values({
      jobId: input.jobId,
      status,
      sectionFlags: input.sectionFlags,
      reviewerName: input.reviewerName,
      sessionId: input.sessionId,
    })
    .onConflictDoUpdate({
      target: qaAnswerReviews.jobId,
      set: {
        status,
        sectionFlags: input.sectionFlags,
        reviewerName: input.reviewerName,
        sessionId: input.sessionId,
        updatedAt: new Date(),
      },
    });
  return { status };
}

// ─── 노트 ───────────────────────────────────────────────────────────────────

export type QaNoteRow = {
  id: string;
  jobId: string;
  targetKind: QaTargetKind;
  targetKey: string | null;
  targetLabel: string | null;
  severity: QaSeverity;
  body: string;
  reviewerName: string;
  createdAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  promptText: string | null;
  surface: QaSurface;
  brand: string | null;
  engine: string;
};

function notePredicates(f: QaNoteFilter): SQL[] {
  const preds = answerPredicates(f);
  if (f.targetKind?.length) preds.push(inList(sql`n.target_kind`, f.targetKind));
  if (f.severity?.length) preds.push(inList(sql`n.severity`, f.severity));
  // 기본은 미해결만 — 해결된 노트가 목록을 덮으면 남은 일이 안 보인다.
  if (!f.includeResolved) preds.push(sql`n.resolved_at IS NULL`);
  return preds;
}

const NOTE_SELECT = sql`
  SELECT n.id, n.job_id, n.target_kind, n.target_key, n.target_label, n.severity,
         n.body, n.reviewer_name, n.created_at, n.resolved_at, n.resolved_by,
         sp.text AS prompt_text, ${SURFACE_SQL} AS surface, ${BRAND_SQL} AS brand,
         a.target AS engine
    FROM qa_review_notes n
    JOIN scope_answers a ON a.job_id = n.job_id
    LEFT JOIN run_surface   rs  ON rs.run_id = a.run_id
    LEFT JOIN scope_prompts sp  ON sp.prompt_id = a.prompt_id
    LEFT JOIN prompts       cat ON cat.scope_prompt_id = a.prompt_id
                               AND cat.project_id = ${STANDARD_ROOT_PROJECT_ID}
    LEFT JOIN qa_answer_reviews rv ON rv.job_id = a.job_id
`;

function toNote(n: Row): QaNoteRow {
  return {
    id: String(n.id),
    jobId: String(n.job_id),
    targetKind: String(n.target_kind) as QaTargetKind,
    targetKey: n.target_key == null ? null : String(n.target_key),
    targetLabel: n.target_label == null ? null : String(n.target_label),
    severity: String(n.severity) as QaSeverity,
    body: String(n.body),
    reviewerName: String(n.reviewer_name),
    createdAt: dateOrNull(n.created_at),
    resolvedAt: dateOrNull(n.resolved_at),
    resolvedBy: n.resolved_by == null ? null : String(n.resolved_by),
    promptText: n.prompt_text == null ? null : String(n.prompt_text),
    surface: String(n.surface ?? "standard") as QaSurface,
    brand: n.brand == null ? null : String(n.brand),
    engine: String(n.engine ?? ""),
  };
}

export async function listNotes(
  f: QaNoteFilter,
  cursor?: string,
  limit: number = QA_PAGE_SIZE,
): Promise<{ rows: QaNoteRow[]; nextCursor: string | null }> {
  const bulkVisible = await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const preds = [...notePredicates(f), bulkVisible];
  if (cursor) {
    const c = decodeCursor(cursor);
    if (c?.ts) {
      preds.push(sql`(n.created_at < ${c.ts}::timestamptz
        OR (n.created_at = ${c.ts}::timestamptz AND n.id < ${c.jobId}::uuid))`);
    }
  }
  const raw = rows<Row>(
    await getDb().execute(sql`
      WITH ${RUN_SURFACE_CTE}
      ${NOTE_SELECT}
      ${whereClause(preds)}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${limit + 1}
    `),
  );
  const page = raw.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map(toNote),
    nextCursor:
      raw.length > limit && last
        ? encodeCursor(dateOrNull(last.created_at), String(last.id))
        : null,
  };
}

// CSV 내보내기용 — 커서 없이 전량. 상한을 두는 이유는 하나, 실수로 십만 행을
// 스트리밍하지 않기 위해서다.
export const QA_NOTE_EXPORT_LIMIT = 10_000;

export async function listAllNotes(f: QaNoteFilter): Promise<QaNoteRow[]> {
  const bulkVisible = await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const raw = rows<Row>(
    await getDb().execute(sql`
      WITH ${RUN_SURFACE_CTE}
      ${NOTE_SELECT}
      ${whereClause([...notePredicates(f), bulkVisible])}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${QA_NOTE_EXPORT_LIMIT}
    `),
  );
  return raw.map(toNote);
}

// 대상 종류별 노트 수 — "인용 분류가 유독 많이 틀린다" 같은 축별 편중을 드러낸다.
export async function countNotesByKind(f: QaNoteFilter): Promise<Record<string, number>> {
  const bulkVisible = await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const raw = rows<Row>(
    await getDb().execute(sql`
      WITH ${RUN_SURFACE_CTE}
      SELECT n.target_kind, count(*)::int AS n
        FROM qa_review_notes n
        JOIN scope_answers a ON a.job_id = n.job_id
        LEFT JOIN run_surface   rs  ON rs.run_id = a.run_id
        LEFT JOIN scope_prompts sp  ON sp.prompt_id = a.prompt_id
        LEFT JOIN prompts       cat ON cat.scope_prompt_id = a.prompt_id
                                   AND cat.project_id = ${STANDARD_ROOT_PROJECT_ID}
        LEFT JOIN qa_answer_reviews rv ON rv.job_id = a.job_id
      ${whereClause([...notePredicates(f), bulkVisible])}
      GROUP BY n.target_kind
    `),
  );
  const out: Record<string, number> = {};
  for (const r of raw) out[String(r.target_kind)] = num(r.n);
  return out;
}

export async function listNotesForJob(jobId: string): Promise<QaReviewNoteRow[]> {
  const bulkVisible = await bulkMirrorRunVisibleSql(sql`a.run_id`);
  return getDb()
    .select()
    .from(qaReviewNotes)
    .where(and(
      eq(qaReviewNotes.jobId, jobId),
      sql`EXISTS (
        SELECT 1 FROM scope_answers a
         WHERE a.job_id = ${qaReviewNotes.jobId}
           AND ${bulkVisible}
      )`,
    ))
    .orderBy(qaReviewNotes.createdAt);
}

export async function createNote(input: {
  jobId: string;
  targetKind: QaTargetKind;
  targetKey: string | null;
  targetLabel: string | null;
  severity: QaSeverity;
  body: string;
  reviewerName: string;
  sessionId: string | null;
}): Promise<QaReviewNoteRow> {
  const [row] = await getDb()
    .insert(qaReviewNotes)
    .values({
      jobId: input.jobId,
      targetKind: input.targetKind,
      targetKey: input.targetKey,
      targetLabel: input.targetLabel,
      severity: input.severity,
      body: input.body,
      reviewerName: input.reviewerName,
      sessionId: input.sessionId,
    })
    .returning();
  return row;
}

export async function updateNote(
  id: string,
  patch: { body?: string; severity?: QaSeverity; resolved?: boolean; reviewerName: string },
): Promise<QaReviewNoteRow | null> {
  const set: Partial<QaReviewNoteRow> = {};
  if (patch.body !== undefined) set.body = patch.body;
  if (patch.severity !== undefined) set.severity = patch.severity;
  if (patch.resolved !== undefined) {
    set.resolvedAt = patch.resolved ? new Date() : null;
    set.resolvedBy = patch.resolved ? patch.reviewerName : null;
  }
  if (Object.keys(set).length === 0) return null;
  const [row] = await getDb()
    .update(qaReviewNotes)
    .set(set)
    .where(eq(qaReviewNotes.id, id))
    .returning();
  return row ?? null;
}

export async function deleteNote(id: string): Promise<void> {
  await getDb().delete(qaReviewNotes).where(eq(qaReviewNotes.id, id));
}

// ─── 목록 폴링 ──────────────────────────────────────────────────────────────

// 목록 화면이 10초마다 부른다 — 락과 검수 상태만 갱신한다(전체 리로드 아님).
export async function getListDeltas(jobIds: string[]): Promise<{
  locks: QaLock[];
  reviews: Array<{ jobId: string; status: string; reviewerName: string }>;
}> {
  if (jobIds.length === 0) return { locks: [], reviews: [] };
  const [locks, reviews] = await Promise.all([
    listLocks(jobIds),
    getDb()
      .select({
        jobId: qaAnswerReviews.jobId,
        status: qaAnswerReviews.status,
        reviewerName: qaAnswerReviews.reviewerName,
      })
      .from(qaAnswerReviews)
      .where(inArray(qaAnswerReviews.jobId, jobIds)),
  ]);
  return { locks, reviews };
}
