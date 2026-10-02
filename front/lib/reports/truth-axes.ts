/**
 * 발행값 라우팅 술어 — **순수 함수**. "이 요청을 발행값으로 답할 수 있는가" 를 한 곳에서
 * 판정한다. 술어를 화면 컴포넌트나 SQL 에 흩지 않는다.
 *
 * ── 왜 축이 갈리는가 ────────────────────────────────────────────────────────
 * 발행물의 입도는 **사이트(file_seq) × 지표**다. 그 아래로는 내려가지 않는다.
 *   · 브랜드·국가·언어 → `sites[].b` · `dash.geo` · `dash.lang` 로 **부분합이 나온다**
 *   · 엔진            → `eng` 는 **분자만** 있고 분모가 없다. 게다가 Σeng ≠ c6[0] 이
 *                       105개 중 97개다(한 프롬프트를 두 엔진이 함께 인용하면 양쪽에
 *                       세어진다). 분할도 합집합도 아니라 **부분합 자체가 정의되지 않는다**
 *   · 출처 카테고리   → 발행물에 없다(라이브도 이미 계산을 건너뛴다)
 *   · 임의 기간       → 발행물은 회차 두 점(현·직전)뿐이다
 *   · 도메인 드릴다운 → 발행물에 없다
 *
 * 답할 수 없으면 **값을 숨기지 않고 라이브로 폴백하되 출처 표식을 바꾼다**(스펙 I-5).
 * 조용히 섞는 것이 가장 나쁘다.
 *
 * ── 권역(region)에 대하여 ──────────────────────────────────────────────────
 * website 표면에서 `filters.region` 은 이미 미지원이다(`gate.ts::unsupportedWebsiteFilterReason`).
 * 화면은 권역 선택을 국가 집합으로 펴서 `websiteCountry` 로 넘긴다 — 그래서 권역은
 * 국가 축으로 자동 처리되고 여기서 따로 다루지 않는다. 그래도 `region` 이 남아서
 * 들어오면 **폴백**한다(모르는 축을 통과시키지 않는다).
 */
import type { StandardFilters } from "@/lib/scope/result-adapter";

/** 발행값으로 부분합을 낼 수 있는 축. 이 셋 말고는 전부 폴백이다. */
export const PUBLISHED_AXES = ["brand", "websiteCountry", "lang"] as const;

/**
 * 켜져 있으면 폴백시키는 축. `StandardFilters` 에 축이 새로 생겼는데 여기 안 적히면
 * **조용히 무시되어 틀린 부분합**이 나가므로, 단위 테스트가 두 목록의 합이
 * `StandardFilters` 의 좁히기 축 전부를 덮는지 단언한다.
 */
export const FALLBACK_AXES = [
  "engine",
  "sourceCategory",
  "funnelStage",
  "brandPresence",
  "listType",
  "depth1",
  "depth2",
  "depth3",
  "region",
] as const;

export interface PublishedAxisSelection {
  brand?: string[];
  countryCode?: string[];
  langCode?: string[];
}

export type ReportTruthRoute =
  | {
      source: "published";
      /**
       * 조회 회차. `null` = 기간 필터가 없다 = 화면이 "가장 최근 노출 회차" 를 본다.
       * 그 날짜는 리더가 미러에서 읽어 채운다(여기서는 알 수 없다).
       */
      roundDate: string | null;
      axes: PublishedAxisSelection;
    }
  | { source: "live"; reason: string };

function nonEmpty(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0;
}

/**
 * 필터만 보고 "발행값 후보인가" 를 판정한다. 통과해도 아직 발행값이 아니다 —
 * 리더가 **그 회차의 active 발행물이 실재하는지**(§E 술어 2)와
 * **어휘가 갈리지 않는지·권한이 발행 모집단을 덮는지**(`decidePublishedSelection`)를
 * 마저 확인한다.
 *
 * ⚠️ `selectedBrands` 를 **따로 받는다.** `withWebsite` 가 브랜드 축을 project id 로
 *    흡수하면서 `filters.brand` 를 지우기 때문이다(`server.ts::withWebsite` 의
 *    `normalizeFilters({ …, brand: undefined })`). 그래서 website 표면 런타임에서
 *    `filters.brand` 는 **절대 채워지지 않는다** — 그것을 모르고 `filters.brand` 만
 *    읽으면 브랜드 축이 조용히 죽고, 브랜드 좁히기를 전량 런타임 어휘의 project id
 *    교집합이 하게 된다. 그 결과가 2026-09-20 검증이 잡은 Hyundai 42개 → 40개다.
 */
export function resolveReportTruthRoute(
  filters: StandardFilters,
  selectedBrands?: readonly string[],
): ReportTruthRoute {
  for (const axis of FALLBACK_AXES) {
    if (nonEmpty((filters as Record<string, unknown>)[axis])) {
      return { source: "live", reason: `unsupported-axis:${axis}` };
    }
  }
  const custom = filters.customFieldFilters;
  if (custom && Object.values(custom).some((v) => nonEmpty(v))) {
    return { source: "live", reason: "unsupported-axis:customField" };
  }

  // 기간 — 발행물은 회차 두 점뿐이다. 하루짜리(from === to)만 회차로 읽을 수 있고,
  // 구간은 어느 회차의 값인지 정의되지 않는다.
  const { dateFrom, dateTo } = filters;
  let roundDate: string | null = null;
  if (dateFrom || dateTo) {
    if (!dateFrom || !dateTo) return { source: "live", reason: "period-open-ended" };
    if (dateFrom !== dateTo) return { source: "live", reason: "period-range" };
    roundDate = dateFrom;
  }

  const axes: PublishedAxisSelection = {};
  const brands = nonEmpty(selectedBrands) ? [...selectedBrands] : filters.brand;
  if (nonEmpty(brands)) axes.brand = brands;
  if (nonEmpty(filters.websiteCountry)) axes.countryCode = filters.websiteCountry;
  if (nonEmpty(filters.lang)) axes.langCode = filters.lang;

  return { source: "published", roundDate, axes };
}

export interface PublishedSiteRow {
  fileSeq: number;
  brand: string;
  countryCode: string | null;
  langCode: string | null;
  inHeadlinePool: boolean;
  targetHitPrompts: number;
  measuredPrompts: number;
  ownedPrompts: number;
  ownedPromptsDen: number;
  prevTargetHitPrompts: number | null;
  prevMeasuredPrompts: number | null;
  prevOwnedPrompts: number | null;
  prevOwnedPromptsDen: number | null;
}

const ci = (v: string | null | undefined) => (v ?? "").toLowerCase();

/** 축 선택에 걸리는 발행 사이트만 남긴다. 축 안은 OR, 축 사이는 AND(화면과 같다). */
export function selectPublishedSites(
  sites: readonly PublishedSiteRow[],
  axes: PublishedAxisSelection,
): PublishedSiteRow[] {
  const brand = axes.brand?.map(ci);
  const country = axes.countryCode?.map(ci);
  const lang = axes.langCode?.map(ci);
  return sites.filter(
    (s) =>
      (!brand || brand.includes(ci(s.brand))) &&
      (!country || country.includes(ci(s.countryCode))) &&
      (!lang || lang.includes(ci(s.langCode))),
  );
}

/**
 * 런타임(미러) 쪽 유닛 분류 — `website_sites.brand` · `.country_code` ·
 * `website_prompts.lang_code`. **발행물의 분류와 다른 어휘다**(아래 §어휘 두 벌).
 */
export interface RuntimeSiteClass {
  fileSeq: number;
  brand: string;
  countryCode: string | null;
  /** 한 유닛에 여러 언어가 있을 수 있어 목록이다. */
  langCodes: string[];
}

export type PublishedDecision =
  | { ok: true; selected: PublishedSiteRow[] }
  | { ok: false; reason: string };

/**
 * 발행 사실표와 **런타임 분류가 어긋나는** 유닛 집합.
 *
 * ── 어휘 두 벌 (2026-09-20 검증이 잡은 결함의 뿌리) ──────────────────────────
 * 발행물은 `sites[].b` · `dash.geo` 로 유닛을 분류하고, 런타임 스코프·필터는
 * `website_sites.brand` · `.country_code` 로 분류한다. 9/11 발행물에서 이 둘은
 * **fs 40·41(Hyundai N)에서 갈린다** — 운영 담당이 미러에서 확인:
 *   fs 40  발행물(Hyundai, HYUNDAI-N)  vs  런타임(Hyundai N, KR)
 *   fs 41  발행물(Hyundai, HYUNDAI-N)  vs  런타임(Hyundai N, worldwide)
 * ⚠️ `scripts/reports/report-spec.json` 은 fs 41 을 `Hyundai`/`worldwide` 로 적어
 *    미러와도 다르다. 그래서 **런타임 분류를 파일에서 읽지 않고 DB 에서 읽는다** —
 *    어느 유닛이 갈리는지 코드에 박지 않는다.
 */
export function groupRuntimeByFileSeq(
  runtime: readonly RuntimeSiteClass[],
): Map<number, RuntimeSiteClass[]> {
  const out = new Map<number, RuntimeSiteClass[]>();
  for (const r of runtime) {
    const cur = out.get(r.fileSeq);
    if (cur) cur.push(r);
    else out.set(r.fileSeq, [r]);
  }
  return out;
}

export function vocabularySplit(
  published: readonly PublishedSiteRow[],
  runtime: readonly RuntimeSiteClass[],
): Set<number> {
  const byFs = groupRuntimeByFileSeq(runtime);
  const out = new Set<number>();
  for (const p of published) {
    const rows = byFs.get(p.fileSeq);
    // 런타임에 없는 유닛은 권한 게이트가 따로 잡는다. 여기서는 분류 비교만 한다.
    if (!rows || rows.length === 0) continue;
    // ── §중복 (2026-09-20 검증 주의) ─────────────────────────────────────────
    // 한 file_seq 에 런타임 분류가 **둘 이상**이면 그 유닛의 브랜드·국가가 하나로
    // 정해지지 않는다. 종전 판은 `new Map(runtime.map(...))` 로 접어 **뒤엣것이
    // 앞엣것을 덮었고**, 덮은 쪽이 발행물과 우연히 같으면 분기로 안 잡혔다 —
    // 즉 "어느 쪽과도 안 맞아 분기로 잡힌다" 던 주장은 거짓이었고, 결과가 행 순서에
    // 좌우됐다. 지금은 **개수만 보고 무조건 분기**로 넘긴다(보수적 = 라이브).
    if (rows.length > 1) {
      out.add(p.fileSeq);
      continue;
    }
    const r = rows[0];
    const langOk =
      p.langCode == null || r.langCodes.some((l) => ci(l) === ci(p.langCode));
    if (ci(p.brand) !== ci(r.brand) || ci(p.countryCode) !== ci(r.countryCode) || !langOk) {
      out.add(p.fileSeq);
    }
  }
  return out;
}

/**
 * 발행값을 낼 것인가, 낸다면 어느 사이트로 낼 것인가. **순수 함수**이고 리더의
 * 판정 전부가 여기 모여 있다.
 *
 * ── 왜 "권한" 과 "필터" 를 가르는가 ────────────────────────────────────────
 * 종전 판은 둘을 한 덩어리로 섞었다: 런타임 어휘로 좁힌 file_seq 집합과 발행 사이트를
 * 교집합해 버렸다. 그러면 브랜드 = Hyundai 가 42개가 아니라 **40개**가 되어(fs 40·41 이
 * 런타임에서 `Hyundai N` 이라 빠진다) 리포트가 발행한 적 없는 66.1% 가 `published`
 * 표식을 달고 나갔다. 그래서 둘을 분리한다:
 *
 *   · **권한** = 런타임 어휘. 게이트로만 쓴다 — "이 사용자가 발행 모집단 **전부**를
 *     볼 수 있는가". 아니면 라이브다. **조용히 좁히지 않는다**(좁히면 리포트에 없는
 *     수가 나온다).
 *   · **필터** = 발행물 어휘. 사용자가 고른 축을 발행물의 분류로 해석한다. 그래야
 *     Hyundai 가 리포트의 `brandAvgAll.Hyundai`(42개 · 2,775/4,223 · 65.71%)와 같아진다.
 *
 * ── 왜 브랜드만 어휘 분기를 봐주고 국가·언어는 안 봐주는가 ─────────────────
 * **리포트가 그 수를 발행했는가**가 기준이다(제품 책임자 원칙: "리포트에 발행된 적 없는 수에는
 * published 표식을 달지 않는다").
 *   · 브랜드 부분합은 발행물 안에 **실재한다**(`brandAvgAll.Hyundai/Kia/Genesis`).
 *     그러므로 발행물 어휘로 해석한 42개가 곧 고객이 리포트에서 본 수다.
 *   · 국가·언어 부분합은 발행물에 **없다**. 어휘가 갈리는 유닛이 선택에 닿으면 그 합은
 *     라이브와도 다르고 리포트에도 없는 제3의 수가 된다(KR 74.3% 대 라이브 70.5%,
 *     worldwide 67.4% 대 66.1%). 그런 선택은 라이브로 내린다.
 *   · 갈리는 유닛에 닿지 않는 선택(예: MX)은 두 어휘가 같은 사이트를 고르므로
 *     발행 정수 쌍의 충실한 재진술이다 — 그대로 published.
 */
export function decidePublishedSelection(args: {
  published: readonly PublishedSiteRow[];
  /** 계정 스코프(= UI 필터로 좁히기 **전**)의 런타임 분류. */
  runtime: readonly RuntimeSiteClass[];
  axes: PublishedAxisSelection;
}): PublishedDecision {
  const { published, runtime, axes } = args;
  if (published.length === 0) return { ok: false, reason: "no-publication-sites" };

  // ① 권한 게이트 — 발행 모집단 전부를 볼 수 있어야 한다.
  //    덮지 못하면 그 사용자의 합은 리포트가 발행한 수가 아니다 → 라이브.
  const seen = new Set(runtime.map((r) => r.fileSeq));
  const uncovered = published.filter((p) => !seen.has(p.fileSeq));
  if (uncovered.length > 0) {
    return {
      ok: false,
      reason: `scope-narrower-than-publication:${uncovered.length}`,
    };
  }

  // ② 브랜드 선택은 **발행물 어휘**로 해석한다. 발행물에 없는 브랜드 값
  //    (예: 런타임 전용 'Hyundai N')은 대응 부분합이 없으므로 라이브.
  if (axes.brand?.length) {
    const known = new Set(published.map((p) => ci(p.brand)));
    const missing = axes.brand.filter((b) => !known.has(ci(b)));
    if (missing.length > 0) {
      return { ok: false, reason: `brand-not-in-publication:${missing.join(",")}` };
    }
  }

  // ③ 국가·언어는 어휘가 갈리는 유닛에 닿으면 라이브.
  const split = vocabularySplit(published, runtime);
  if (split.size > 0) {
    // ⚠️ 중복 분류가 있는 file_seq 는 **모든 행**을 본다. 하나로 접으면 접힌 쪽만
    //    검사하게 되어 위 §중복 과 같은 종류의 구멍이 다시 생긴다.
    const byFs = groupRuntimeByFileSeq(runtime);
    for (const [axis, sel, pubOf, runOf] of [
      [
        "websiteCountry",
        axes.countryCode,
        (p: PublishedSiteRow) => [p.countryCode],
        (r: RuntimeSiteClass) => [r.countryCode],
      ],
      [
        "lang",
        axes.langCode,
        (p: PublishedSiteRow) => [p.langCode],
        (r: RuntimeSiteClass) => r.langCodes,
      ],
    ] as const) {
      if (!sel?.length) continue;
      const want = new Set(sel.map(ci));
      for (const fs of split) {
        const p = published.find((x) => x.fileSeq === fs);
        const touched =
          (p ? pubOf(p).some((v) => want.has(ci(v))) : false) ||
          (byFs.get(fs) ?? []).some((r) => runOf(r).some((v) => want.has(ci(v))));
        if (touched) return { ok: false, reason: `vocabulary-split:${axis}` };
      }
    }
  }

  // ④ 선택 — 여기서부터는 발행물 어휘만 쓴다(권한은 ① 이 이미 덮었다).
  const selected = selectPublishedSites(published, axes);
  if (selected.length === 0) return { ok: false, reason: "no-published-sites" };
  return { ok: true, selected };
}

export interface PublishedSubtotal {
  hitPrompts: number;
  ownedPrompts: number;
  measuredPrompts: number;
  prev: { hitPrompts: number; ownedPrompts: number; measuredPrompts: number };
  siteCount: number;
  /** 헤드라인 풀 규칙이 실제로 적용됐는가(= 제외 유닛을 뺐는가). 표식·감사용. */
  headlinePoolApplied: boolean;
}

/**
 * 헤드라인 풀 규칙을 적용한 정수 쌍 부분합.
 *
 *   발행 부분합 = (걸린 사이트) ∩ (in_headline_pool)
 *   교집합이 **비면** 걸린 사이트 전체를 쓴다.
 *
 * 앞 절은 리포트 자신의 자세다 — 무필터 표지 숫자(104개 5,611/9,586 = 58.53)뿐 아니라
 * 발행물의 `brandAvgAll` 도 Hyundai 를 43개가 아니라 **42개**로 센다. 즉 리포트는
 * 브랜드 부분합에도 같은 제외를 적용하고, 화면이 그것을 따라가야 값이 같아진다.
 *
 * 뒤 절은 "필터로 제외 유닛을 **직접** 고르면 그 값이 보여야 한다" 는 요구다.
 * 국가=CPO 를 고르면 교집합이 공집합이 되고, 그때만 제외 유닛 자신의 값(3/91)을 낸다.
 * 두 절은 충돌하지 않는다 — 제외 유닛이 다른 유닛과 **섞여 있는** 선택에서는 언제나
 * 앞 절이 이기므로, 뒤 절이 발동하는 경우는 "제외 유닛만 고른 선택" 하나뿐이다.
 *
 * 걸린 사이트가 아예 없으면 `null` 이다 — 발행 모집단 밖만 고른 경우(리포트 밖
 * fs 44·71·94·97 등)이고, 리더는 라이브로 폴백한다. 0/0 을 발행값이라 우기지 않는다.
 */
export function publishedSubtotal(sites: readonly PublishedSiteRow[]): PublishedSubtotal | null {
  if (sites.length === 0) return null;
  const pool = sites.filter((s) => s.inHeadlinePool);
  const use = pool.length > 0 ? pool : sites;
  const out: PublishedSubtotal = {
    hitPrompts: 0,
    ownedPrompts: 0,
    measuredPrompts: 0,
    prev: { hitPrompts: 0, ownedPrompts: 0, measuredPrompts: 0 },
    siteCount: use.length,
    headlinePoolApplied: pool.length > 0 && pool.length < sites.length,
  };
  for (const s of use) {
    out.hitPrompts += s.targetHitPrompts;
    out.ownedPrompts += s.ownedPrompts;
    // 두 카드는 분모가 같다(발행물에서 c6[1] === co[1] === np 가 105/105).
    out.measuredPrompts += s.measuredPrompts;
    out.prev.hitPrompts += s.prevTargetHitPrompts ?? 0;
    out.prev.ownedPrompts += s.prevOwnedPrompts ?? 0;
    out.prev.measuredPrompts += s.prevMeasuredPrompts ?? 0;
  }
  return out;
}
