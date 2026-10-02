import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { ensureAnchorAxis } from "@/lib/period/anchor-axis-state";
import { listSelectableAnchorDates } from "./scope-answer-anchors";
import type { PublishedSiteRow, RuntimeSiteClass } from "@/lib/reports/truth-axes";

/**
 * 발행 리포트 사실표(0080) 리더 — **읽기 전용**. 적재는 CLI
 * (`scripts/reports/ingest-publication.ts`)가 담당한다.
 *
 * ⚠️ 이 표들을 읽기 전에 반드시 `reportTruthTablesAvailable()` 로 프로브한다.
 *    **머지 = 배포 가능 상태**이고 마이그레이션은 손으로 적용하므로, 코드가 `db:apply`
 *    보다 먼저 갈 수 있다. 그 창에서 42P01 로 인용 화면이 죽으면 안 된다(0072·0073 과
 *    같은 자세). 표가 없으면 그냥 라이브로 간다.
 */

const PROBE_TTL_MS = 60_000;
const PRESENT_TTL_MS = 12 * 60 * 60 * 1000;

let cachedProbe: { available: boolean; expiresAt: number } | null = null;
let inflightProbe: Promise<boolean> | null = null;

/** 0080 이 적용됐는가. 표가 없으면 발행값 경로를 통째로 끈다. */
export async function reportTruthTablesAvailable(): Promise<boolean> {
  const now = Date.now();
  if (cachedProbe && cachedProbe.expiresAt > now) return cachedProbe.available;
  if (inflightProbe) return inflightProbe;

  inflightProbe = (async () => {
    // `to_regclass` 는 0080 미적용 상태에서도 안전하다(NULL 을 돌려준다).
    // 이 쿼리를 catch 하지 않는다 — 권한·네트워크 오류는 "표가 없다" 가 아니다.
    const rows = (await getDb().execute(sql`
      SELECT to_regclass('public.report_publications') AS a,
             to_regclass('public.report_site_facts')   AS b
    `)) as unknown as Array<{ a: string | null; b: string | null }>;
    const available = Boolean(rows[0]?.a) && Boolean(rows[0]?.b);
    cachedProbe = {
      available,
      expiresAt: Date.now() + (available ? PRESENT_TTL_MS : PROBE_TTL_MS),
    };
    return available;
  })().finally(() => {
    inflightProbe = null;
  });
  return inflightProbe;
}

/** 테스트 전용 — 프로브 캐시를 비운다. */
export function __resetReportTruthProbe(): void {
  cachedProbe = null;
  inflightProbe = null;
}

/**
 * 기간 필터가 없을 때 화면이 보고 있는 회차 = **화면이 고를 수 있는 최신 회차**.
 *
 * 축은 `scope_answer_cycle_anchors.round_date`(0077 정규 요일 귀속)다. 화면의 기간·
 * 달력·추이가 전부 이 키를 보므로 카드도 같은 키로 회차를 고른다.
 *
 * ⚠️ 이 함수가 라이브 미러를 읽는다는 점이 중요하다. 발행물이 없는 회차가 최신이 되면
 *    카드는 **자동으로 라이브로 돌아간다** — "최신 회차인데 낡은 발행값을 보여주는"
 *    형태가 구조적으로 안 생긴다.
 *
 * ── 왜 직접 `max(round_date)` 를 쓰면 안 되는가 (2026-09-20 프리뷰 실측) ────────
 * 종전 판은 `scope_answer_cycle_anchors` 에서 노출 게이트(`view_anchor_date <= 오늘`)만
 * 걸고 `max(round_date)` 를 냈다. 그 값이 **2026-09-18** 인데 website 9/18 회차는
 * 원장에서 숨김(`hidden_reason` 있음 · `hidden_scope='all'`)이라 화면의 실제 최신
 * 회차는 **2026-09-11** 이었다. 발행물은 09-11 에 있으므로, 무기간으로 인용 화면을
 * 열면 발행값(58.5%·79.1%)이 나와야 하는데 라이브(57.5%·90.2%)가 나왔다.
 * 기간을 09-11 하루로 지정하면 정상이었던 것이 그 지문이다.
 *
 * 즉 "노출됐는가" 와 "화면이 고를 수 있는가" 는 다른 술어다. 후자는 노출 게이트 +
 * **숨김** + **함대 서빙 가능**(활성 세대 있음)까지 봐야 한다. 그래서 회차 판정을
 * 화면과 **같은 함수 한 벌**로 통일한다 — 여기서 술어를 다시 쓰면 그 순간 두 벌이 된다.
 */
export type LatestRoundResult =
  | { roundDate: string | null }
  /**
   * `X.answerAnchor` 가 꺼져 있다. 회차 축(`round_date`, 0077)이 없으면 "지금 보는
   * 회차" 를 알 수 없어 발행값 경로가 통째로 죽는다.
   *
   * ⚠️ 이 경우를 `roundDate: null` 과 **구분해서 돌려준다.** 종전 판은 둘 다 null 이라
   *    프리뷰에서 `REPORT_TRUTH_FORCE=1` 만 켜고 `ANSWER_ANCHOR_FORCE=1` 을 빼면
   *    "켰는데 아무것도 안 바뀐다" 가 **아무 신호 없이** 일어났다(2026-09-20 검증 주의 1).
   */
  | { roundDate: null; anchorAxisOff: true };

export async function latestVisibleWebsiteRound(
  scopeProjectIds: readonly string[],
): Promise<LatestRoundResult> {
  if (scopeProjectIds.length === 0) return { roundDate: null };
  if (!(await ensureAnchorAxis())) return { roundDate: null, anchorAxisOff: true };
  // ⚠️ **SQL 을 손으로 쓰지 않는다.** 화면이 최신 회차를 고르는 술어를 그대로 부른다
  //    (`scope-answer-anchors.ts:470 listSelectableAnchorDates`). 목록은 오름차순이므로
  //    마지막 항목이 그 화면의 최신 회차다.
  //
  //    계열은 `"citations"` — 이 카드가 붙는 곳이 인용 화면이기 때문이다. 계열이
  //    기준 회차를 가를 수 있다는 것은 그 함수의 `family` 주석이 명시한 계약이고
  //    (인용만 숨긴 회차가 최신이면 언급 화면은 그 회차를, 인용 화면은 앞 회차를 본다),
  //    한 화면 안에서는 달력·카드·드릴다운이 같은 계열을 쓰므로 갈리지 않는다.
  const dates = await listSelectableAnchorDates("website", [...scopeProjectIds], {}, "citations");
  return { roundDate: dates.length > 0 ? dates[dates.length - 1] : null };
}

/**
 * 이 프로젝트 집합이 볼 수 있는 유닛의 **런타임 분류** 전부
 * (`website_sites.brand` · `.country_code` · `website_prompts.lang_code`).
 *
 * 두 가지에 쓴다:
 *   ① **권한 게이트** — 발행 모집단 전부가 이 집합에 들어오는가. 발행 사실표는
 *      project 와 FK 로 묶여 있지 않아 스코프 좁히기가 자동으로 따라오지 않는다
 *      (이 리포의 3번째 경계: RLS 없음 → 리포지토리가 보상통제).
 *   ② **어휘 분기 판정** — 발행물의 분류(`sites[].b`·`dash.geo`)와 런타임 분류가
 *      어긋나는 유닛을 찾는다. 9/11 발행물에서는 fs 40·41(Hyundai N)이 그렇다.
 *
 * ⚠️ 어느 유닛이 갈리는지를 **코드나 파일에 박지 않는다.** `scripts/reports/report-spec.json`
 *    은 fs 41 을 `Hyundai`/`worldwide` 로 적는데 미러 실측은 `Hyundai N`/`worldwide` 라
 *    서로 다르다 — 정본은 DB 다. 그래서 매 요청 이 쿼리로 읽는다.
 *
 * ⚠️ **한 file_seq 가 사이트 둘에 걸리면 행이 둘이다.** 종전 주석은 "그때는 어느 쪽과도
 *    분류가 맞지 않아 어휘 분기로 잡힌다" 고 적었는데 **그것은 사실이 아니었다** —
 *    소비자가 `new Map(rows.map(r => [r.fileSeq, r]))` 로 접어서 **뒤엣것이 앞엣것을
 *    덮었고**, 덮은 쪽이 발행물 분류와 우연히 같으면 분기로 잡히지 않은 채 통과했다.
 *    지금은 `vocabularySplit` 이 file_seq 당 행 수를 세어 **2행 이상이면 무조건 분기**로
 *    본다(그 함수의 §중복 주석). 순서에 의존하지 않으므로 `ORDER BY` 는 재현성을 위한
 *    것이지 정확성의 근거가 아니다.
 */
export async function websiteRuntimeClassification(
  scopeProjectIds: readonly string[],
): Promise<RuntimeSiteClass[]> {
  if (scopeProjectIds.length === 0) return [];
  const rows = (await getDb().execute(sql`
    SELECT wp.file_seq                          AS file_seq,
           ws.brand                             AS brand,
           ws.country_code                      AS country_code,
           array_agg(DISTINCT wp.lang_code)     AS lang_codes
      FROM website_prompts wp
      JOIN website_sites  ws ON ws.id = wp.site_id
     WHERE ws.scope_project_id = ANY(${sql.param([...scopeProjectIds])}::text[])
     GROUP BY wp.file_seq, ws.brand, ws.country_code
     ORDER BY wp.file_seq, ws.brand, ws.country_code
  `)) as unknown as Array<{
    file_seq: number | string;
    brand: string;
    country_code: string | null;
    lang_codes: string[] | null;
  }>;
  return rows.map((r) => ({
    fileSeq: Number(r.file_seq),
    brand: r.brand,
    countryCode: r.country_code,
    langCodes: (r.lang_codes ?? []).filter((v): v is string => typeof v === "string"),
  }));
}

export interface PublishedRound {
  publicationId: string;
  slug: string;
  cycleLabel: string | null;
  cycleLabelEn: string | null;
  roundDate: string;
  prevRoundDate: string | null;
  benchN: number | null;
  benchNAll: number | null;
  manifestVerified: boolean;
  sites: PublishedSiteRow[];
}

type SiteQueryRow = {
  file_seq: number;
  brand: string;
  country_code: string | null;
  lang_code: string | null;
  in_headline_pool: boolean;
  target_hit_prompts: number;
  measured_prompts: number;
  owned_prompts: number;
  owned_prompts_den: number;
  prev_target_hit_prompts: number | null;
  prev_measured_prompts: number | null;
  prev_owned_prompts: number | null;
  prev_owned_prompts_den: number | null;
};

const int = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const intOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : int(v));

/**
 * 그 회차의 **active** 발행물과 사이트 전수를 읽는다. 없으면 null(→ 라이브).
 *
 * `status='active'` 부분 유니크 인덱스가 있으므로 결과는 최대 1건이다 — 정정 발행이
 * 앞 행을 안 내린 상태에서 리더가 둘 중 하나를 임의로 고르는 일은 표가 막는다.
 *
 * 사이트는 105행이라 전수를 가져와 **메모리에서** 축 부분합을 낸다. SQL 로 축을
 * 좁히지 않는 이유: 부분합 규칙(헤드라인 풀 교집합·공집합 폴백)이 순수 함수 한 곳
 * (`lib/reports/truth-axes.ts`)에 있어야 단위 테스트로 고정되고, 그 규칙이 SQL 과
 * TS 두 벌로 갈라지면 한쪽만 낡는다(0052·0077 이 겪은 형태).
 */
export async function loadPublishedWebsiteRound(roundDate: string): Promise<PublishedRound | null> {
  if (!(await reportTruthTablesAvailable())) return null;
  const db = getDb();
  const pubs = (await db.execute(sql`
    SELECT id::text            AS id,
           slug,
           cycle_label,
           cycle_label_en,
           round_date::text    AS round_date,
           prev_round_date::text AS prev_round_date,
           bench_n,
           bench_n_all,
           manifest_verified
      FROM report_publications
     WHERE surface = 'website'
       AND status  = 'active'
       AND round_date = ${roundDate}::date
     LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const p = pubs[0];
  if (!p) return null;

  const rows = (await db.execute(sql`
    SELECT file_seq, brand, country_code, lang_code, in_headline_pool,
           target_hit_prompts, measured_prompts, owned_prompts, owned_prompts_den,
           prev_target_hit_prompts, prev_measured_prompts,
           prev_owned_prompts, prev_owned_prompts_den
      FROM report_site_facts
     WHERE publication_id = ${String(p.id)}::uuid
     ORDER BY file_seq
  `)) as unknown as SiteQueryRow[];

  return {
    publicationId: String(p.id),
    slug: String(p.slug),
    cycleLabel: (p.cycle_label as string | null) ?? null,
    cycleLabelEn: (p.cycle_label_en as string | null) ?? null,
    roundDate: String(p.round_date),
    prevRoundDate: (p.prev_round_date as string | null) ?? null,
    benchN: intOrNull(p.bench_n),
    benchNAll: intOrNull(p.bench_n_all),
    manifestVerified: p.manifest_verified === true,
    sites: rows.map((r) => ({
      fileSeq: int(r.file_seq),
      brand: r.brand,
      countryCode: r.country_code,
      langCode: r.lang_code,
      inHeadlinePool: r.in_headline_pool === true,
      targetHitPrompts: int(r.target_hit_prompts),
      measuredPrompts: int(r.measured_prompts),
      ownedPrompts: int(r.owned_prompts),
      ownedPromptsDen: int(r.owned_prompts_den),
      prevTargetHitPrompts: intOrNull(r.prev_target_hit_prompts),
      prevMeasuredPrompts: intOrNull(r.prev_measured_prompts),
      prevOwnedPrompts: intOrNull(r.prev_owned_prompts),
      prevOwnedPromptsDen: intOrNull(r.prev_owned_prompts_den),
    })),
  };
}
