import "server-only";
import { cache } from "react";
import {
  hiddenCycleSlots,
  type CycleSurface,
  type HiddenCycleScope,
  type HiddenCycleSlot,
} from "@/lib/db/repositories/summary-cycles";
import type {
  BucketUnit,
  StandardTrendBucket,
} from "@/lib/db/repositories/scope-aggregates";
import {
  CITATIONS_COLLECTION_ERROR_GAP,
  collectionErrorGap,
  insertTrendGapSlots,
  trendGapKeysToMark,
  type TrendGapFamily,
} from "@/lib/viz/trend-gap";

// ════════════════════════════════════════════════════════════════════════════
// 숨긴 회차 → **갭 슬롯 키** (0070, 2026-09-10)
// ════════════════════════════════════════════════════════════════════════════
//
// 원장 숨김은 두 단계다. ①은 이미 리더 술어가 한다(값이 사라진다). ②가 여기다.
//
//   ① 값을 뺀다  — 미러: `excludeHiddenCycleRuns()` · 집계층: `cycle-set.ts` skipped
//   ② 자리를 남긴다 — 그 주를 **null + `gap`** 슬롯으로 만들어 화면이 음영·툴팁·
//      이웃 연결을 그리게 한다(계약 정본 `lib/viz/trend-gap.ts`)
//
// ②가 없으면 8/17 과 8/31 이 곧장 붙는다 — 값이 사라진 것이 아니라 **그 주가 없었던
// 것처럼** 보인다. 숨김이 만드는 두 번째 거짓말이고, 첫 번째(골짜기)보다 찾기 어렵다.
//
// ── 축이 둘이라 키도 둘이다 ────────────────────────────────────────────────
//
//   집계층 회차 축(`cycleAnchorAt` 이 채워진 버킷) → 키 = **회차 anchor 의 UTC 일**
//   미러 주 격자(`date_trunc('week', measured_at)`)   → 키 = **cycle_week(월요일)**
//
// 8/25 앵커 회차는 두 값이 다르다(anchor 2026-08-25 · week 2026-08-24). 축을 잘못
// 고르면 슬롯이 축에 없는 키가 되어 **조용히 아무 일도 안 일어난다** — 그래서 축 판정을
// 추측이 아니라 데이터로 한다(`cycleAnchorAt` 유무 = 화면이 이미 쓰는 `isCycleBucketed`).
//
// ── `day` 버킷에는 갭을 넣지 않는다 ────────────────────────────────────────
// 미러 `day` 축의 키는 개별 측정일이라 `cycle_week`(월요일)와 격자가 다르다. 월요일 키를
// 끼워 넣으면 **없던 날**을 만든다. `day` 를 쓰는 유일한 호출부는 대시보드 Δ 롤업이고,
// 갭 버킷은 어차피 값이 전부 null 이라 Δ 계산(`applyTrendDeltas` 의 `typeof v === "number"`
// 필터)에서 저절로 건너뛰어진다 — 즉 넣어도 Δ 는 안 바뀌고, 안 넣어도 손실이 없다.
//
// ── `operator` 숨김은 갭을 그리지 않는다 ───────────────────────────────────
// 화면이 갭 슬롯에 그리는 표시는 **수집 오류 음영 하나뿐**이다(2026-09-11 부터 문구
// 툴팁도 없다 — 운영). 운영 판단으로 내린 회차까지 그 음영으로 덮으면 **고객에게 사실이
// 아닌 원인을 말하게 된다**. `operator` 는 값만 빠지고 슬롯은 안 생긴다(= 그 주가 축에서
// 사라진다). 사유별 표시가 생기면 그때 넓힌다.

// ── **계열**(0071, 2026-09-11) ──────────────────────────────────────────────
//
// 8/25 회차는 인용만 깨졌다(chatgpt 인용률 3.8% vs 언급 83.8%). 원장이
// `hidden_scope='citations'` 로 그 사실을 들고 있고, 여기서는 **누가 읽는지**에 따라
// 목록이 갈린다:
//
//   family = "citation" → 범위 무관 전부 갭
//   family = "mention"  → `scope='all'` 만 갭 (`citations` 는 값이 살아 있다)
//
// 혼합 버킷(오버뷰 5 KPI)만 예외다 — 한 버킷에 두 계열이 함께 실리므로 목록으로
// 못 가르고 **버킷마다 마커의 `scope`** 로 가른다(§4-4, `withTrendGapBuckets`).

/** 갭 슬롯이 되는 사유 — 오늘은 하나뿐이다(위 주석). */
const GAP_REASONS = new Set(["collection_error"]);

export interface TrendGapKeys {
  /** 미러 주 격자용 — `cycle_week`(UTC 월요일). */
  weeks: string[];
  /** 집계층 회차 축용 — 회차 anchor 의 UTC 일. */
  anchorDays: string[];
}

const EMPTY_KEYS: TrendGapKeys = { weeks: [], anchorDays: [] };

/**
 * 키 → 범위. 같은 키에 회차가 여럿이면(함대 표면) **넓은 쪽(`all`)이 이긴다** —
 * 한 사이트는 전체가, 다른 사이트는 인용만 깨졌으면 그 주는 전체가 구멍이다.
 */
type ScopeByKey = ReadonlyMap<string, HiddenCycleScope>;

interface GapSlotKeys {
  weeks: ScopeByKey;
  anchorDays: ScopeByKey;
}

const EMPTY_SLOT_KEYS: GapSlotKeys = { weeks: new Map(), anchorDays: new Map() };

function widen(m: Map<string, HiddenCycleScope>, key: string, scope: HiddenCycleScope): void {
  if (m.get(key) === "all") return;
  m.set(key, scope);
}

function toSlotKeys(slots: HiddenCycleSlot[]): GapSlotKeys {
  const gap = slots.filter((s) => GAP_REASONS.has(s.reason));
  if (gap.length === 0) return EMPTY_SLOT_KEYS;
  const weeks = new Map<string, HiddenCycleScope>();
  const anchorDays = new Map<string, HiddenCycleScope>();
  for (const s of gap) {
    widen(weeks, s.cycleWeek, s.scope);
    widen(anchorDays, s.anchorDay, s.scope);
  }
  return { weeks, anchorDays };
}

/** 이 계열이 갭으로 보는 키만. 언급 계열은 `citations` 범위를 버린다. */
function familyKeys(m: ScopeByKey, family: TrendGapFamily): string[] {
  const out: string[] = [];
  for (const [k, scope] of m) {
    if (family === "citation" || scope === "all") out.push(k);
  }
  return out.sort();
}

/**
 * 요청단위 dedup — 한 렌더가 추이를 여러 번 부른다(카드 스파크·히어로·브랜드·순위).
 * 원장은 실측 96행이라 문장 자체가 싸지만, 같은 요청에서 왕복을 4~6회 늘릴 이유가 없다.
 * 키는 문자열 하나여야 하므로 JSON 으로 접는다(server.ts 의 게이트 캐시와 같은 관례).
 */
const cachedGapKeys = cache(async (key: string): Promise<GapSlotKeys> => {
  const { s, p } = JSON.parse(key) as { s: CycleSurface | null; p: string[] };
  return toSlotKeys(await hiddenCycleSlots({ surface: s ?? undefined, projectIds: p }));
});

/**
 * 캐시는 **계열을 타지 않는다** — 원장 조회는 한 번이고 계열 필터는 읽는 쪽에서
 * 건다. 그래야 같은 렌더가 언급·인용 두 계열을 함께 물어도 왕복이 하나다.
 */
function gapSlotKeys(
  surface: CycleSurface | null,
  projectIds: string[],
): Promise<GapSlotKeys> {
  if (projectIds.length === 0) return Promise.resolve(EMPTY_SLOT_KEYS);
  return cachedGapKeys(JSON.stringify({ s: surface, p: [...new Set(projectIds)].sort() }));
}

/**
 * 숨긴 회차의 갭 슬롯 키. 실패·컬럼 미적용은 빈 목록(= 종전과 동일한 화면).
 *
 * `family` 는 **기본값을 두지 않는다** — 리더 술어(`excludeHiddenCycleRuns`)와 같은
 * 규율이다. 목록과 값이 다른 계열을 보면 "값은 있는데 음영이 덮인" 화면이 된다.
 */
export async function trendGapKeys(
  surface: CycleSurface | null,
  projectIds: string[],
  family: TrendGapFamily,
): Promise<TrendGapKeys> {
  const slots = await gapSlotKeys(surface, projectIds);
  const weeks = familyKeys(slots.weeks, family);
  const anchorDays = familyKeys(slots.anchorDays, family);
  if (weeks.length === 0 && anchorDays.length === 0) return EMPTY_KEYS;
  return { weeks, anchorDays };
}

// ── 적용부 ──────────────────────────────────────────────────────────────────

/** 갭 버킷 하나 — **측정값 필드가 전부 0/null** 이어야 한다(계약). */
function gapBucket(
  key: string,
  cycleAxis: boolean,
  scope: HiddenCycleScope,
): StandardTrendBucket {
  return {
    bucketStart: key,
    // 회차 축이면 `cycleAnchorAt` 을 채운다 — 안 채우면 `isCycleBucketed` 의 `every` 가
    // 깨져 화면이 **주 격자 채우기로 되돌아간다**(없던 점이 생긴다).
    ...(cycleAxis ? { cycleAnchorAt: `${key}T00:00:00.000Z` } : {}),
    // 범위는 **원장 값 그대로** 싣는다(D-4 A, 운영 2026-09-11). 값이 하나도 없는
    // 슬롯이어도 `citations` 면 언급 카드 4장은 음영·문구 없이 빈 점으로 그린다 —
    // "멘션은 살려줘야 해" 지시에 문면 그대로 맞다. 값이 실제로 없는 문제는 8/25
    // 회차를 사실표로 생성하는 별건(D-1 옵션 B)으로 푼다.
    gap: collectionErrorGap(scope),
    answers: 0,
    trackedAnswers: 0,
    totalMentions: 0,
    trackedMentions: 0,
    sentMentions: 0,
    positiveMentions: 0,
    avgPosition: null,
    totalCitations: 0,
    ownedCitations: 0,
    measuredDays: 0,
    firstAt: null,
    lastAt: null,
  };
}

/**
 * `StandardTrendBucket[]` 에 갭 버킷을 얹는다 — 카드 ①~⑤ 시계열 전 경로의 공통 출구.
 *
 * 집계층·미러 어느 쪽으로 왔는지는 **버킷이 말한다**(`cycleAnchorAt`). 두 경로가 같은
 * 타입을 돌려주는 것이 이 계층의 계약이므로, 갭도 그 계약 위에서 한 번만 얹는다.
 */
export async function withTrendGapBuckets(
  buckets: StandardTrendBucket[],
  unit: BucketUnit,
  surface: CycleSurface | null,
  projectIds: string[],
): Promise<StandardTrendBucket[]> {
  if (buckets.length < 2) return buckets;
  const cycleAxis = buckets.every((b) => !!b.cycleAnchorAt);
  // `day` 격자에는 안 넣는다(머리 주석). 회차 축은 unit 과 무관하다.
  if (!cycleAxis && unit !== "week") return buckets;
  const slots = await gapSlotKeys(surface, projectIds);
  const scopeByKey = cycleAxis ? slots.anchorDays : slots.weeks;
  if (scopeByKey.size === 0) return buckets;

  // ── ① 슬롯이 **없는** 키 → 갭 버킷을 끼워 넣는다 (계열 무관: all·citations 둘 다).
  const inserted = insertTrendGapSlots(
    buckets,
    [...scopeByKey.keys()],
    (b) => b.bucketStart,
    (k) => gapBucket(k, cycleAxis, scopeByKey.get(k) ?? "all"),
  );

  // ── ② 슬롯이 **있는** 키 → 인용 갭 마커만 얹는다.
  // 8/24 는 미러 리더의 언급 술어가 완화돼 값이 살아난다(answers > 0). 그 버킷은
  // ①에서 안 끼워지므로 여기서 `scope:"citations"` 마커를 덮어 인용 카드만 음영이 되게 한다.
  //
  // ── ⚠️ 판정 규칙이 **축마다 다르다**(D2 A2, 2026-09-11) ────────────────────
  //
  // 미러 **주 격자**(cycleAxis=false): 한 주 키에 숨김 회차 **밖의** run 이 섞일 수 있다.
  //   그래서 `totalCitations > 0` 이면 구멍이 아니다(0070 규칙 ②) — 종전 규칙 유지.
  //   축 안쪽 제한(`trendGapKeysToMark`)도 그대로다.
  // 집계층 **회차 축**(cycleAxis=true): 키가 그 회차 **하나**를 정확히 가리킨다. 섞임이
  //   없으므로 인용 값이 남아 있어도 그것은 "정상 인용" 이 아니라 **깨진 채로 굳은 값**이다.
  //   → 이미 있는 슬롯이면 값·위치와 무관하게 **전부** 마킹한다.
  //
  // 이 분기가 없으면 조용한 회귀가 난다: 8/25 회차를 사실표로 생성하는 순간
  // `totalCitations > 0` 이 참이 되어 마커가 빠지고, 그러면 `dashboard/_data/live.ts:600`
  // 의 `if (!citationGap && b.totalCitations > 0)` 가드가 함께 풀려 **인용률 3.8% 로
  // 오염된 값이 인용 점유율 카드에 찍힌다**(에러 없음 = 아무도 못 잡는다).
  //
  // ── ⚠️ 회차 축에서 `trendGapKeysToMark` 를 **안 쓰는** 이유 (검증자 지적, 2026-09-11) ──
  //
  // 그 함수는 규칙 ①(`trendGapKeyInAxis`: `key > first && key < last`)을 **엄격 내부**로
  // 건다. 규칙 ①은 ① 패스의 것이다 — 슬롯을 **새로 끼우는** 쪽은 축을 넓히면 안 되니까.
  // ②는 **이미 있는 버킷에 마커만 얹으므로 축이 안 넓어진다.** 그런데도 같은 제한을 타면
  // 8/25 가 축의 **첫 점 또는 끝 점**일 때 마커가 빠지고, 아래 인용 필드 비우기도 함께
  // 안 돌아 3.8% 가 그대로 샌다. 도달 경로는 이미 열려 있다:
  //   · 기간 필터 직접 선택 `dateFrom ∈ (8/20, 8/25]` → 8/25 가 첫 점
  //   · `dateTo = 8/26` → 8/25 가 끝 점(이때는 Δ 칩까지 오염된다)
  //   · **월간 프리셋(today−29)은 2026-09-19 부터 자동으로** 8/25 를 첫 점으로 만든다
  // `G_TREND_MIN_CYCLES = 2` 는 회차 **수** 하한이라 이것을 못 막는다.
  // 미러 주 격자는 반대로 제한이 옳다 — 축 밖 주에 마커를 얹으면 계약이 깨진다.
  const citKeys: string[] = [];
  for (const [k, scope] of scopeByKey) if (scope === "citations") citKeys.push(k);
  if (citKeys.length === 0) return inserted === buckets ? buckets : [...inserted];

  const byKey = new Map(inserted.map((b) => [b.bucketStart, b]));
  // 이미 갭인 버킷(①에서 만든 것)은 두 축 모두 마킹 대상이 아니다.
  const marks: ReadonlySet<string> = cycleAxis
    ? new Set(citKeys.filter((k) => byKey.has(k) && !byKey.get(k)?.gap))
    : trendGapKeysToMark(
        inserted.map((b) => b.bucketStart),
        citKeys,
        (k) => {
          const b = byKey.get(k);
          // `hasValue` 를 true 로 돌려 `trendGapKeysToMark` 가 스스로 건너뛰게 한다.
          return !!b?.gap || (b?.totalCitations ?? 0) > 0;
        },
      );
  if (marks.size === 0) return inserted === buckets ? buckets : [...inserted];
  // 마커만으로 끝내지 않는다 — 마커를 안 보는 소비자가 생기면 다시 샌다. 계약
  // (`lib/viz/trend-gap.ts` 머리 주석 "갭 슬롯의 측정값은 전부 null/0")을 **값으로도** 지킨다.
  // 비우는 것은 **인용 두 필드뿐**이다. `answers`·`totalMentions`·`avgPosition`·
  // `measuredDays`·`firstAt`/`lastAt`·`cycleAnchorAt` 은 이 회차의 **산출물**이므로 그대로 둔다.
  // (주 격자에서는 위 `hasValue` 가 `totalCitations === 0` 인 것만 골라 오므로 무동작이다.)
  return inserted.map((b) =>
    marks.has(b.bucketStart)
      ? { ...b, gap: CITATIONS_COLLECTION_ERROR_GAP, totalCitations: 0, ownedCitations: 0 }
      : b,
  );
}

/**
 * KPI 탭 추이 3종(히어로·브랜드·순위)에 **후보 키만** 실어 보낸다.
 *
 * 왜 서버에서 마커까지 안 찍는가: 그 세 차트의 축은 `trendAxis`(kpi-view.ts)가 **화면
 * 에서** 만든다 — 창 경계까지 넓히고 빈 주를 채운 뒤라야 "이 키가 축 안쪽인가·값이
 * 남았는가" 를 판정할 수 있다. 서버가 미리 찍으면 축 밖 키에 마커가 붙어 계약이 깨진다.
 * 그래서 서버는 목록만 주고, 판정은 축을 쥔 쪽이 `trendGapKeysToMark` 로 한다(같은 순수
 * 함수 한 벌 — 두 벌이 되면 한쪽만 고치는 결함이 생긴다).
 *
 * `unit` 이 `week` 가 아니면 빈 목록이다(주 격자 키를 다른 격자에 얹지 않는다).
 */
export async function trendGapWeekKeys(
  unit: BucketUnit,
  surface: CycleSurface | null,
  projectIds: string[],
  family: TrendGapFamily,
): Promise<string[] | undefined> {
  if (unit !== "week") return undefined;
  const keys = await trendGapKeys(surface, projectIds, family);
  return keys.weeks.length > 0 ? keys.weeks : undefined;
}

// ── 주별 Top-N 추이(인용 도메인·언급 브랜드)에 얹기 ─────────────────────────
//
// 이 추이들(`WeeklyTrend`)은 `date_trunc` 이 아니라 JS `weekStartUTC` 로 접히지만
// 격자는 같다(UTC 월요일). 그래서 키는 `cycle_week` 그대로다.
//
// 페처 경계에서 얹는 이유: 집계 함수(`aggregateCitationsFromMirror` 등)는 표면·
// 프로젝트 스코프를 인자로만 알고 회차 원장을 모른다 — 거기서 원장을 읽게 하면
// 리포지터리가 게이트 계층을 역참조하게 되고, 캐시 안이라 원장 수정이 TTL 만큼 늦는다.

/** 미러 주 격자용 갭 키. `week` 축 추이(`WeeklyTrend`)가 쓴다. */
export async function weeklyGapWeeks(
  surface: CycleSurface | null,
  projectIds: string[],
  family: TrendGapFamily,
): Promise<string[]> {
  return (await trendGapKeys(surface, projectIds, family)).weeks;
}
