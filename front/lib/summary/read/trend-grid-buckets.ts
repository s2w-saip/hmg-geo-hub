import type { StandardTrendBucket } from "@/lib/db/repositories/scope-aggregates";
import type { WeeklyTrend } from "@/lib/scope/result-adapter";
import { TREND_GAP_FIELD, type TrendGapRow } from "@/lib/viz/trend-gap";
import {
  trendGridGapMarker,
  trendGridKeyResolver,
  type TrendGridSlotView,
} from "@/lib/period/trend-grid-axis";
import { mergeTrendGrid, type TrendSlot } from "@/lib/period/trend-grid";

// ════════════════════════════════════════════════════════════════════════════
// 공용 추이 격자 → `StandardTrendBucket[]` (카드 ①~⑤ 시계열·website·프로젝트)
// ════════════════════════════════════════════════════════════════════════════
//
// 정본: 설계 §7. 격자 모듈(`lib/period/trend-grid.ts`)은 **타입을 모르는** 병합기이고,
// 여기서 그 결과를 이 리포의 추이 버킷 모양으로 되돌린다.
//
// ── 왜 `withTrendGapBuckets` **뒤**에 오는가 ────────────────────────────────
//
// 저 함수의 ② 패스(인용 계열 마커 + 인용 두 필드 비우기)가 **살아 있어야** 하기 때문이다.
// 숨긴 인용 회차(8/25)는 언급 값이 살아 있어 점으로 남고, 그 점 위에 `citations` 마커가
// 얹힌다. 격자를 먼저 돌리면 그 마커를 붙일 버킷이 아직 없다. 격자가 대체하는 것은
// **자리 목록·창·채움**이지 계열 마커가 아니다(격자 모듈 머리 주석과 같은 선).
//
// ── 버킷 키를 자리 키로 **정규화한다** ─────────────────────────────────────
//
// 경로마다 `bucketStart` 가 다르다: 집계층은 귀속 날짜, 미러는 그 회차가 속한 주의
// 월요일이다(`roundDate` 는 둘 다 싣는다). 격자를 켠 뒤에는 **자리 키 하나**로 통일한다 —
// 안 그러면 실측 점(월요일)과 갭 슬롯(금요일)이 같은 축에 섞여 website 라벨이 요일마다
// 갈린다. 설계 §7-1 의 "버킷 키와 라벨은 `round_date` 다" 가 그 문장이다.

/**
 * 자리를 못 찾아 **버려진 값**을 한 줄 남긴다. 값이 조용히 사라지는 유일한 자리라
 * 흔적이 없으면 프리뷰에서 "왜 점이 비었나" 를 화면만 보고 추적할 수 없다
 * (`mergeTrendGrid` 머리 주석이 `droppedKeys` 를 돌려주는 이유가 이것이다).
 *
 * 정상 상태에서는 **안 찍힌다** — 창 밖 값은 애초에 읽어 오지 않기 때문이다. 찍히면
 * 버킷 키와 자리 키의 격자가 어긋난 것이고, 그게 이 배선의 유일한 치명 실패 모드다.
 */
function logDroppedKeys(where: string, keys: readonly string[]): void {
  if (keys.length === 0) return;
  console.info(
    `[trend-grid] ${where}: 자리 밖 키 ${keys.length}개를 버렸다 — ${keys.slice(0, 8).join(",")}`,
  );
}

/** 갭 자리 하나 — **측정값 필드가 전부 0/null** 이어야 한다(viz 계약). */
function gridGapBucket(slot: TrendGridSlotView): StandardTrendBucket {
  return {
    bucketStart: slot.roundDate,
    roundDate: slot.roundDate,
    // 회차 축 신호를 채운다 — 이 배열이 통째로 회차 축이라는 사실은 갭 슬롯에서도
    // 참이고, `isCycleBucketed`(화면)가 `every` 로 보기 때문에 하나만 비어도 화면이
    // **주 격자 채우기로 되돌아간다**(없던 점이 생긴다).
    cycleAnchorAt: `${slot.roundDate}T00:00:00.000Z`,
    // **격자가 만든 자리라는 표식**(검증 B2). 화면은 이 표식으로 채움을 건너뛴다 —
    // 스위치(`trendGridKnownEnabled`)로 물으면 격자를 안 얹은 시리즈(일 버킷·자리 null)
    // 까지 채움이 사라진다.
    gridSlot: true,
    gap: trendGridGapMarker(slot.gapReason ?? "no-value"),
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
 * 자리 목록에 버킷을 얹어 **격자 그대로의 배열**을 만든다.
 *
 *   자리 ∧ 값        → 그 버킷(계열 마커 포함). 키만 자리 키로 정규화한다.
 *   자리 ∧ 값 없음    → 사유가 실린 갭 버킷
 *   자리 없는 값      → **버린다**(없던 주를 만들지 않는다)
 *
 * ── `null` 과 `[]` 는 **다른 명제다** (2026-09-20 수정) ──────────────────────
 *
 *   `null` = "격자를 못 세웠다"(키 off · 원장 조회 실패). **입력 배열을 참조까지 그대로**
 *            돌려준다 — 키 off 무변경의 실체다.
 *   `[]`   = "격자를 세웠는데 이 창에 자리가 없다". 원장이 낸 **답**이므로 그 답을 낸다:
 *            빈 배열이다. 화면은 기존 빈 상태(`getLiveTrend…` 의 `null`)로 간다.
 *
 * 초판은 둘을 뭉개 `[]` 에서도 입력을 그대로 돌려줬다. 그러면 기간을 좁혀 자리가 하나도
 * 없는 화면이 **창 밖 값을 그대로 그린다** — 사용자가 고른 기간과 다른 데이터를 보여
 * 주는 것이라 값이 사라지는 것보다 나쁘다.
 */
export function applyTrendGridToBuckets(
  buckets: StandardTrendBucket[],
  slots: readonly TrendSlot[] | null,
): StandardTrendBucket[] {
  if (slots === null) return buckets;
  if (slots.length === 0) return [];
  const resolve = trendGridKeyResolver(slots);
  const slotKeys = new Set(slots.map((s) => s.roundDate));
  // ── 자리 해소는 **2단**이다 (검증 C2·C6, 2026-09-20) ────────────────────
  //
  // ① 라벨(`roundDate`) → ② 주 키(`bucketStart` = `ca.anchor_week`) → 실패면 버린다.
  //
  // 왜 2단인가: 두 키의 **확실성이 다르다.**
  //   · 라벨은 값 쪽 `to_char(max(round_date))`(= `round_label`)이고, 그 `max` 의 모집단은
  //     **필터된 답변셋**이다(사용자 필터 + 기간 + 답변 단위 숨김). 자리 쪽 접힌 키는
  //     **원장**의 그 주 마지막 자리다. 모집단이 다르므로 갈린다 — 그 주 마지막 회차가
  //     필터에 걸리거나(a) 숨겨졌거나(b) 그 계열 답변이 0이면(d) 라벨이 앞 회차 날짜가
  //     되고, 라벨만 보면 자리를 못 찾아 **그 주가 통째로 거짓 결측**이 된다.
  //   · 주 키는 접은 뒤 **자리와 1:1 로 보장된다**(한 주에 자리가 하나뿐이므로
  //     `trendGridKeyResolver` 의 모호성 가드가 발동하지 않는다). 즉 확실한 키다.
  //
  // 순서가 라벨 먼저인 이유: 글로벌·website 는 라벨이 곧 자리 키라 1단에서 끝나고
  // (종전과 동일한 경로), 주 키 재시도는 **프로젝트 다자리 주에서만** 도달한다.
  const keyOf = (b: StandardTrendBucket): string => {
    if (b.roundDate) {
      const byLabel = resolve(b.roundDate);
      if (slotKeys.has(byLabel)) return byLabel;
    }
    const byWeek = resolve(b.bucketStart);
    if (slotKeys.has(byWeek)) return byWeek;
    // 둘 다 실패 — 자리 밖 값이다. `mergeTrendGrid` 가 버리고 아래 로그가 남긴다.
    return b.roundDate ?? b.bucketStart;
  };
  const { cells, droppedKeys } = mergeTrendGrid(slots, buckets, { keyOf });
  logDroppedKeys("buckets", droppedKeys);
  return cells.map((c) =>
    c.value === null
      ? gridGapBucket({
          roundDate: c.roundDate,
          anchorWeek: c.anchorWeek,
          gapReason: c.gapReason,
        })
      : // ── 표시 라벨은 **자리 키**다 (결정, 2026-09-20) ──────────────────
        //
        // 주 키로 붙인 점도 값 쪽 `round_label` 이 아니라 자리 키를 라벨로 쓴다.
        // 근거는 **카드 기준일과 같은 규칙을 따른다** 는 것이다: 카드 기준일도 달력의
        // 선택 가능 날짜도 원장·앵커 표의 `round_date` 에서 나오지 축약된 답변셋에서
        // 나오지 않는다(설계 §7-1 "버킷 키와 라벨은 `round_date` 다"). `round_label` 을
        // 쓰면 **사용자가 필터를 켜고 끌 때마다 x축 날짜가 움직인다** — 같은 회차가
        // 필터에 따라 다른 날로 보이는 것이라 이 트랙이 없애려는 바로 그 현상이다.
        { ...c.value, bucketStart: c.roundDate, roundDate: c.roundDate, gridSlot: true },
  );
}

/**
 * 자리 목록에 **가두기만** 한다 — 없는 자리를 새로 만들지 않는다.
 *
 * 값이 축을 정하지 않는 부수 시리즈용이다(인용 정확도 추이 ⑥·KPI 탭 버킷). 메인 추이가
 * 이미 자리를 세웠으므로 여기서 갭 행을 또 만들면 같은 자리에 행이 둘이 된다. 하는 일은
 * 셋뿐이다: **자리 키로 정규화** · **자리 밖 버림** · **갭 자리 버림**(그 자리는 값이
 * 없다고 이미 판정된 자리라, 부수 시리즈만 점을 찍으면 음영 위에 점이 얹힌다).
 *
 * `null` = 격자 없음 → 입력 배열 그대로(참조 동일). `[]` = 창에 자리 없음 → `[]`.
 */
export function restrictToTrendGrid<B extends { bucketStart: string }>(
  buckets: B[],
  slots: readonly TrendGridSlotView[] | null,
): B[] {
  if (slots === null) return buckets;
  if (slots.length === 0) return [];
  const keyOf = trendGridKeyResolver(slots);
  const usable = new Set(
    slots.filter((s) => s.gapReason === null).map((s) => s.roundDate),
  );
  const out: B[] = [];
  const dropped: string[] = [];
  for (const b of buckets) {
    const k = keyOf(b.bucketStart);
    if (!usable.has(k)) {
      dropped.push(b.bucketStart);
      continue;
    }
    out.push(k === b.bucketStart ? b : { ...b, bucketStart: k });
  }
  logDroppedKeys("restrict", [...new Set(dropped)].sort());
  return out;
}

/**
 * 화면으로 내려보내는 부분집합 — `cycleIds`·`completionRatio` 는 싣지 않는다.
 *
 * ⚠️ **빈 배열은 `undefined` 가 아니다.** `undefined` 는 "격자 없음"(화면이 종전 축을
 *    만든다)이고 `[]` 는 "이 창에 자리가 없다"(축도 비어야 한다)다. 둘을 뭉개면 기간을
 *    좁혀 자리가 0인 화면이 **13자리 종전 축으로 되돌아간다**.
 */
export function toTrendGridSlotViews(
  slots: readonly TrendSlot[] | null,
): TrendGridSlotView[] | undefined {
  if (slots === null) return undefined;
  return slots.map((s) => ({
    roundDate: s.roundDate,
    anchorWeek: s.anchorWeek,
    gapReason: s.gapReason,
  }));
}

// ── 주별 Top-N 추이(`WeeklyTrend`) ─────────────────────────────────────────
//
// 인용 도메인·유형(인용 화면) · 언급 브랜드(언급 화면)가 쓰는 모양이다. 위 버킷 배열과
// **다른 그릇**이라 어댑터가 따로 필요하다: 행이 `{ week, [시리즈키]: 수 | null, gap? }`
// 이고 시리즈 키가 런타임에 정해진다.
//
// ── 왜 `week` 로 맞아떨어지는가 ────────────────────────────────────────────
//
// 축 on 이면 `trendWeekKey` 가 요청 원천과 무관하게 `applied: "anchor"` 를 내고 버킷 키가
// `ca.anchor_week` 가 된다(`scope-aggregates.ts::trendWeekKey`). 그리고 0077 은 그 컬럼을
// `hmg_anchor_week(round_date)` 로 채운다 — 자리의 `anchorWeek` 와 **같은 식·같은 값**이다.
// 격자는 축이 켜져 있을 때만 켜지므로(`trend-grid-flag.ts` 선행 조건) 이 경로가 보장된다.
// 원장 `cycle_week` 와는 다른 값이라는 점이 중요하다 — 그쪽은 앵커 **시각**의 UTC 주라
// KST 귀속 주와 한 주 어긋날 수 있고, 그래서 키 해소를 `anchorWeek` 로만 한다.

/** 갭 자리 한 행 — 시리즈 값은 **전부 null** 이어야 한다(viz 계약). */
function gridGapRow(slot: TrendGridSlotView, series: readonly string[]): TrendGapRow {
  const row: TrendGapRow = {
    week: slot.roundDate,
    [TREND_GAP_FIELD]: trendGridGapMarker(slot.gapReason ?? "no-value"),
  };
  for (const k of series) row[k] = null;
  return row;
}

/**
 * 주별 Top-N 추이를 격자에 얹는다. 규칙은 버킷 배열과 같다(점 / 갭 / 버림).
 *
 * `week` 값도 **자리 키로 정규화한다** — website 는 자리가 금요일이라 주 월요일 키를
 * 그대로 두면 같은 화면의 다른 추이(버킷 경로)와 x축 라벨이 4일 어긋난다.
 */
export function applyTrendGridToWeeklyTrend(
  trend: WeeklyTrend | null,
  slots: readonly TrendGridSlotView[] | null,
): WeeklyTrend | null {
  if (!trend || slots === null) return trend;
  if (slots.length === 0) return { series: trend.series, points: [] };
  const keyOf = trendGridKeyResolver(slots);
  const byKey = new Map<string, TrendGapRow>();
  for (const r of trend.points) byKey.set(keyOf(String(r.week)), r);
  const slotKeys = new Set(slots.map((s) => s.roundDate));
  logDroppedKeys(
    "weekly",
    [...byKey.keys()].filter((k) => !slotKeys.has(k)).sort(),
  );
  return {
    series: trend.series,
    points: slots.map((s) => {
      const row = s.gapReason === null ? byKey.get(s.roundDate) : undefined;
      return row ? { ...row, week: s.roundDate } : gridGapRow(s, trend.series);
    }),
  };
}
