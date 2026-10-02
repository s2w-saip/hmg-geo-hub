import "server-only";
import { cache } from "react";
import {
  trendGridSlotRows,
  type TrendGridSlotRow,
} from "@/lib/db/repositories/trend-grid-slots";
import type { AnchorHiddenFamily } from "@/lib/db/repositories/scope-answer-anchors";
import type { CycleSurface } from "@/lib/db/repositories/summary-cycles";
import { ensureTrendGrid } from "./trend-grid-flag";
import {
  collapseSameWeekSlots,
  trimTrailingUnpublished,
  type TrendGridGapReason,
  type TrendGridSlotView,
} from "./trend-grid-axis";

// ════════════════════════════════════════════════════════════════════════════
// 공용 추이 격자 — 규칙 하나 (D5, 제품 확정 2026-09-20)
// ════════════════════════════════════════════════════════════════════════════
//
// 정본: `internal-kb/hmg-geo-trend-single-source-design-2026-09-20.md`
// §7 · 앵커 축 스펙 §9.2·§10.2.
//
//   ① 원장에 **자리가 있고 값이 있으면**   → 점
//   ② 원장에 **자리가 있는데 값이 없으면** → 갭(사유를 싣는다)
//   ③ 원장에 **자리가 없으면**            → 아무것도 그리지 않는다
//
// 이 규칙 하나가 지금의 정반대 두 정책을 모두 이긴다. Overview 의 "회차 축이면 안
// 채운다"는 ③이고, 언급 화면의 "항상 주 격자를 채운다"는 ②다 — 원장 자리를 기준으로
// 보면 둘 다 성립한다.
//
// ── 무엇이 바뀌는가(관측된 현재 상태 대비) ─────────────────────────────────
//
//   Overview  창 91일(`G_TREND_WINDOW_DAYS`)·빈 자리 미채움 → 5점
//   언급      창 84일(`KPI_TAB_HERO_TREND_DAYS`)·항상 주 격자 채움 → 13점(5점은 빈 슬롯)
//   격자 on   **같은 13자리**. 값 없는 자리는 사유가 실린 갭, 원장에 없는 자리는 없다.
//
// 그래서 **website 의 07-31 자리는 키를 켜면 사라진다.** 지금은 갭 채우기가 금요일
// 격자를 기계적으로 메워 빈 슬롯을 만드는데, 원장에는 그 자리가 아예 없다(W0 실측:
// website 자리는 07-03 ~ 09-18 금요일 중 07-31 결번). 없던 주를 만들지 않는 것이 ③이다.
//
// ── 창은 날짜가 아니라 **자리 개수**다 ─────────────────────────────────────
//
// 케이던스가 바뀌어도 점 개수가 흔들리지 않게 하려는 것이다(설계 §7-2 A). 날짜 창은
// 안전 상한으로만 남는다 — 원장이 병리적으로 커졌을 때 전 이력을 읽지 않기 위해서다.
//
// ── 이 모듈이 **하지 않는** 것 ─────────────────────────────────────────────
//
//   · 값의 원천을 고르지 않는다(집계층이냐 미러냐는 `S*.…` 키가 정한다).
//   · 인용 계열 마커(`hidden_scope='citations'` 회차 위에 얹는 음영)를 대신하지
//     않는다. 그것은 "자리가 없다"가 아니라 "이 자리의 인용 값만 못 믿는다"이고,
//     `lib/summary/read/trend-gaps.ts::withTrendGapBuckets` 의 ② 패스가 계속 쥔다.
//     이 모듈이 대체하는 것은 **채움 경로**(① 슬롯 끼우기 · `fillGaps` · `fillTrendGaps`)다.

/** 창 = 최신 자리부터 N개. 세부층 보존 정책(13주)과 같은 수다. */
export const TREND_GRID_SLOTS = 13;

/**
 * 안전 상한(일). 자리 개수 창을 못 채울 만큼 원장이 비어 있어도 전 이력을 읽지 않는다.
 * 13자리 × 7일 = 91일이므로 정상 케이던스에서는 절대 걸리지 않는 여유값이다.
 */
export const TREND_GRID_MAX_DAYS = 180;

/**
 * 자리가 비는 **사유**. 어휘의 정본은 `./trend-grid-axis`(순수 모듈)로 옮겼다 —
 * 그쪽은 `server-only` 가 아니라서 화면 view-model 도 같은 타입을 쓸 수 있다.
 * 여기서 재수출하는 이유는 이 모듈의 소비자가 import 를 두 줄로 나누지 않게 하려는 것뿐이다.
 */
export type { TrendGridGapReason } from "./trend-grid-axis";

/** 격자 한 자리. 화면으로 내려가는 부분집합은 `TrendGridSlotView` 다. */
export interface TrendSlot extends TrendGridSlotView {
  /** 자리 키이자 라벨(KST `YYYY-MM-DD`). 글로벌 = 월요일 · 웹사이트 = 금요일. */
  roundDate: string;
  /**
   * `roundDate` 가 속한 **KST 주의 월요일**. 미러 주 격자(`ca.anchor_week`) 대조용
   * 파생값이고, **병합 키가 아니다** — `mergeTrendGrid` 는 `roundDate` 만 본다.
   */
  anchorWeek: string;
  /** 이 자리에 귀속된 회차들. */
  cycleIds: string[];
  /** 발행 세대가 있고 노출일이 지났고 그 계열에서 숨겨지지 않은 회차가 **하나라도** 있는가. */
  renderable: boolean;
  /** `renderable=false` 의 사유. 참이면 `null`(값이 없으면 병합기가 `no-value` 를 붙인다). */
  gapReason: Exclude<TrendGridGapReason, "no-value"> | null;
  /** 서빙 가능한 회차의 완결성 최댓값. 임계 판정은 병합기가 한다. */
  completionRatio: number | null;
}

/** 병합 결과 한 칸 — 점이면 `value`, 갭이면 `gapReason`. 둘이 동시에 차지 않는다. */
export interface TrendGridCell<T> {
  roundDate: string;
  anchorWeek: string;
  cycleIds: string[];
  /** 점이면 그 버킷, 갭이면 `null`. */
  value: T | null;
  /** 점이면 `null`. */
  gapReason: TrendGridGapReason | null;
}

// ── ① 원자료 → 자리 (순수) ──────────────────────────────────────────────────

/**
 * 원장 행을 자리로 접는다. **자리가 되지 않는 후보가 둘 있다.**
 *
 * ① **운영 숨김만 있는 자리.** 화면이 갭 슬롯에 그리는 표시는 수집 오류 음영
 *    하나뿐이다(2026-09-11 제품 책임자). 운영 판단으로 내린 회차까지 그 음영으로 덮으면
 *    **고객에게 사실이 아닌 원인을 말하게 된다** — 현 `trend-gaps.ts` 의 `operator`
 *    규칙을 그대로 옮긴 것이다. 한 자리에 운영 숨김과 다른 회차가 섞여 있으면 자리는
 *    남는다: 지워야 할 것은 그 회차이지 자리가 아니다.
 *
 * ② **원장이 귀속시킨 적 없는 자리**(`assignedCycles === 0`). 앵커 표에 행이 없는
 *    회차는 리더가 정규 요일로 **스냅**해 보내는데(`trend-grid-slots.ts` 머리 주석),
 *    그 회차만 모인 후보는 원장이 그 자리에 회차를 둔 적이 없으므로 자리가 아니다.
 *    이것이 미러 실측에서 website 자리에 `07-20`(월)·`08-17`(월)·`08-18`(화)·
 *    `08-19`(수)가 섰던 결함의 판정 쪽 절반이다 — 실측 네 건은 스냅으로 같은 주
 *    금요일 자리(07-24·08-21)에 흡수돼 **자리 수가 늘지 않는다**.
 *
 *    ⚠️ 예외: **서빙 가능한 회차가 있으면 남긴다.** 앵커 백필이 늦어 행이 아직 없는
 *    발행 회차를 여기서 떨어뜨리면 **점이 조용히 사라진다** — 이 리포가 반복해서
 *    택한 방향(값이 사라지는 쪽이 더 나쁘다)을 여기서도 따른다. 스냅한 날짜는 이미
 *    정규 요일이라 그 경우에도 요일이 오염되지는 않는다. 실측 네 건은 전부
 *    `servableCycles = 0` 이라 이 예외에 걸리지 않는다.
 */
export function toTrendSlots(rows: readonly TrendGridSlotRow[]): TrendSlot[] {
  const out: TrendSlot[] = [];
  for (const r of rows) {
    const renderable = r.servableCycles > 0;
    // ② 원장 귀속이 없는 후보 — 서빙 가능한 회차가 있을 때만 남긴다(머리 주석).
    if (r.assignedCycles === 0 && !renderable) continue;
    // ① 운영 숨김뿐인 자리 = 자리를 만들지 않는다(머리 주석).
    if (!renderable && r.collectionErrorCycles === 0 && r.operatorCycles >= r.totalCycles) {
      continue;
    }
    out.push({
      roundDate: r.roundDate,
      anchorWeek: r.anchorWeek,
      cycleIds: r.cycleIds,
      renderable,
      gapReason: renderable
        ? null
        : r.collectionErrorCycles > 0
          ? "hidden-collection-error"
          : "not-published",
      completionRatio: r.completionRatio,
    });
  }
  return out;
}

/**
 * 창 = **최신 자리부터 N개**. 입력은 오름차순이고 출력도 오름차순이다.
 * `n <= 0` 이면 빈 배열(창이 없다는 뜻이지 "전부"가 아니다 — 무제한은 실수로만 생긴다).
 */
export function takeLatestSlots(
  slots: readonly TrendSlot[],
  n: number = TREND_GRID_SLOTS,
): TrendSlot[] {
  if (n <= 0) return [];
  return slots.length <= n ? [...slots] : slots.slice(slots.length - n);
}

// ── ② 자리 + 값 → 격자 (순수) ───────────────────────────────────────────────

export interface MergeTrendGridOptions<T> {
  /**
   * 값 버킷의 자리 키를 꺼내는 함수. 키는 **`TrendSlot.roundDate` 와 같은 격자**여야
   * 한다 — 집계층 버킷은 `roundDate ?? bucketStart`, 미러 주 버킷은 `ca.round_date`.
   *
   * ⚠️ **`anchorWeek` 를 키로 쓰지 않는다.** 그것은 자리가 속한 주의 월요일이라
   *    website(금요일 자리)에서 4일 어긋나고, 값이 통째로 `no-value` 갭이 된다.
   *    자리 키는 `roundDate` 하나뿐이다.
   */
  keyOf: (bucket: T) => string;
  /**
   * 완결성 하한(0~1). 주면 서빙 가능한 자리라도 이 값 미만이면 갭(`not-published`)이다.
   * 설계 §4-A 의 "완결성이 임계 미만이면 그 자리를 갭으로". 임계 자체는 PR①(W1)의 결정이라
   * 여기서 기본값을 두지 않는다 — 안 주면 이 판정을 안 한다.
   *
   * ⚠️ **오늘 이 옵션을 넘기는 호출부는 없다**(검증 N3, 2026-09-20). 실제 완결성 판정은
   *    PR① 이 병합되면서 **다른 경로**로 들어왔다: `lib/summary/read/cycle-set.ts::
   *    restrictToCompleteCycles`(값에서 빼기) + `trend-gaps.ts::insertCompletionGapBuckets`
   *    (그 자리에 슬롯 끼우기)이고, 임계는 `cycle-completion.ts::TREND_COMPLETION_MIN` 이다.
   *    **고칠 것이 생기면 그쪽이다.** 이 옵션은 격자 모듈이 값 판정을 모른 채 남겨 둔
   *    확장점이고, 두 판정이 동시에 돌면 같은 자리가 두 사유로 갭이 된다(저쪽은
   *    `collection_error`, 이쪽은 `not-published`).
   */
  completionFloor?: number;
}

/**
 * 자리 목록에 값을 얹는다. **자리가 격자를 정한다** — 값이 결정하지 않는다.
 *
 * 규칙 셋을 그대로 옮긴 것이다:
 *   · 자리 ∧ 값        → 점
 *   · 자리 ∧ 값 없음    → 갭(`no-value`), 자리가 서빙 불가면 그 자리의 사유
 *   · 값이 있는데 자리가 없다 → **버린다**. 없던 주를 만들지 않는다(③).
 *
 * ⚠️ 세 번째가 이 함수의 유일한 파괴적 동작이다. 값이 조용히 사라지는 방향이므로
 *    버려진 키를 `droppedKeys` 로 돌려준다 — 호출부가 관측 로그에 실을 수 있게.
 */
export function mergeTrendGrid<T>(
  slots: readonly TrendSlot[],
  buckets: readonly T[],
  opts: MergeTrendGridOptions<T>,
): { cells: TrendGridCell<T>[]; droppedKeys: string[] } {
  const byKey = new Map<string, T>();
  for (const b of buckets) {
    const k = opts.keyOf(b);
    // 같은 키가 둘이면 **뒤에 온 것**이 이긴다 — 자리 단위 접기(D4)를 마친 입력에서는
    // 생기지 않는 조합이고, 생기면 그 자체가 결함이므로 조용히 합치지 않는다.
    byKey.set(k, b);
  }
  const slotKeys = new Set(slots.map((s) => s.roundDate));
  const cells: TrendGridCell<T>[] = slots.map((s) => {
    const value = byKey.get(s.roundDate);
    const belowFloor =
      opts.completionFloor !== undefined &&
      s.completionRatio !== null &&
      s.completionRatio < opts.completionFloor;
    const gapReason: TrendGridGapReason | null = !s.renderable
      ? (s.gapReason ?? "not-published")
      : belowFloor
        ? "not-published"
        : value === undefined
          ? "no-value"
          : null;
    return {
      roundDate: s.roundDate,
      anchorWeek: s.anchorWeek,
      cycleIds: s.cycleIds,
      value: gapReason === null ? (value as T) : null,
      gapReason,
    };
  });
  const droppedKeys = [...byKey.keys()].filter((k) => !slotKeys.has(k)).sort();
  return { cells, droppedKeys };
}

// ── ③ 리더 어댑터 ───────────────────────────────────────────────────────────

export interface TrendGridRequest {
  surface: CycleSurface;
  projectIds: string[];
  /** 숨김 게이트가 보는 지면 계열(앵커 스펙 §10.2). 기본값을 두지 않는다. */
  family: AnchorHiddenFamily;
  /** 자리 개수 창. 기본 `TREND_GRID_SLOTS`. */
  slots?: number;
  /**
   * 화면이 고른 기간(양 끝 포함, `YYYY-MM-DD`). 자리를 그 안으로 **좁힌다**.
   *
   * 없으면 최근 13자리다. 이것이 없으면 사용자가 2주를 골라도 격자가 13자리를 세우고
   * 그중 11개가 `no-value` 갭이 된다 — 값이 없는 것이 아니라 **안 읽은 것**인데 화면은
   * 결측으로 말한다. 창은 좁히기만 하고 넓히지 않는다(자리 개수 창이 상한).
   */
  from?: string | null;
  to?: string | null;
}

/**
 * 요청단위 dedup — 한 렌더가 추이를 여러 번 부른다(카드 스파크·히어로·브랜드·순위).
 * 원장은 실측 96행이라 문장 자체가 싸지만 왕복을 4~6회 늘릴 이유가 없다.
 * 키는 문자열 하나여야 하므로 JSON 으로 접는다(`trend-gaps.ts` 와 같은 관례).
 */
const cachedSlotRows = cache(
  async (key: string): Promise<TrendGridSlotRow[] | null> => {
    const { s, p, f } = JSON.parse(key) as {
      s: CycleSurface;
      p: string[];
      f: AnchorHiddenFamily;
    };
    return trendGridSlotRows({
      surface: s,
      projectIds: p,
      family: f,
      maxDays: TREND_GRID_MAX_DAYS,
    });
  },
);

/**
 * 자리 목록 — **옵트인 키가 꺼져 있으면 `null`**(DB 를 건드리지 않는다).
 *
 * `null` 의 뜻은 하나다: "격자를 못 세웠다". 호출부는 종전 경로를 그대로 쓴다.
 * 이것이 "키 off = 바이트 단위 무변경"의 실체다 — 어댑터가 판정을 하지 않고
 * 호출부에 **아무 값도 주지 않는다**.
 */
export async function buildTrendGrid(
  req: TrendGridRequest,
): Promise<TrendSlot[] | null> {
  if (!(await ensureTrendGrid())) return null;
  const rows = await cachedSlotRows(
    JSON.stringify({
      s: req.surface,
      p: [...new Set(req.projectIds)].sort(),
      f: req.family,
    }),
  );
  if (rows === null) return null;
  // 순서가 계약이다: 기간으로 좁히고 → **같은 주를 접고** → **잘라 내고** → 창을 센다.
  //
  //   · **기간이 접기보다 먼저다**(검증 C5, 2026-09-20 — 3차에서 순서를 뒤집었다).
  //     접힌 키는 그 주의 **서빙 가능한 마지막** 자리 날짜다. 접기를 먼저 하면 `to` 가 주 가운데일 때
  //     그 키가 범위 밖으로 떨어져 **주 전체가 축에서 사라지고 값도 버려진다**
  //     (실측 재현: 자리 09-07·09-15·09-16·09-17 에 `to = 09-16` → 09-07 만 남았다).
  //     이 리포의 우선순위는 "값이 사라지는 쪽이 더 나쁘다" 이고, 그 입력에서는 접기 전
  //     판본이 더 나았다. 기간을 먼저 걸면 접힌 키 = `max(범위 안 자리)` 가 되어 값 쪽
  //     `round_label`(= `max(기간 안 답변의 round_date)`)과 **같은 방향으로 좁혀진다**.
  //   · 접기가 자르기·창보다 먼저인 이유 — 그 둘은 자리 **개수**를 세므로 접은 뒤 키를
  //     봐야 한다(안 접으면 프로젝트 다자리 주에서 창이 자리 수만큼 먹힌다).
  //   · 자르기가 창보다 먼저인 이유 — 반대로 하면 끝의 미발행 자리가 창의 한 칸을 먹고
  //     점이 12개가 된다(website 09-18 이 정확히 그 자리다).
  const inRange = collapseSameWeekSlots(
    toTrendSlots(rows).filter(
      (s) =>
        (!req.from || s.roundDate >= req.from) && (!req.to || s.roundDate <= req.to),
    ),
  );
  const want = req.slots ?? TREND_GRID_SLOTS;
  const out = takeLatestSlots(trimTrailingUnpublished(inRange), want);
  // 안전 상한(180일)이 물었는지는 **신호가 없으면 안 보인다**(검증 N7). 자리 간격이
  // 평균 15일을 넘으면 13자리를 못 채우는데, 화면에는 그냥 "점이 적다" 로만 나타난다.
  // 기간을 좁혀 부른 경우(`from`/`to`)는 정상이므로 세지 않는다.
  if (out.length < want && !req.from && !req.to) {
    console.info(
      `[trend-grid] ${req.surface}/${req.family}: 자리 ${out.length}/${want} ` +
        `(원장 행 ${rows.length} · 상한 ${TREND_GRID_MAX_DAYS}일). ` +
        `행이 상한에 닿아 있으면 창을 넓혀야 한다.`,
    );
  }
  return out;
}

/**
 * 자리 개수 창 → **날짜 창**. 날짜 창을 쓰는 기존 리더(`G_TREND_WINDOW_DAYS` 91일 ·
 * `KPI_TAB_HERO_TREND_DAYS` 84일)가 격자를 경유하게 하는 다리다.
 *
 * 읽기 창은 자리보다 **좁으면 안 된다** — 첫 자리의 값이 잘리면 그 자리가 이유 없이
 * `no-value` 갭이 된다. 그래서 첫 자리의 날짜를 그대로 바닥으로 쓴다(양 끝 포함).
 * 자리가 없으면 `null` — 호출부가 종전 상수로 되돌아간다.
 */
export function trendGridDateFloor(slots: readonly TrendSlot[] | null): string | null {
  return slots && slots.length > 0 ? slots[0].roundDate : null;
}

/**
 * 자리 개수 창 → **일수 창**. `trendDays`(84·91) 를 인자로 받는 리더용 다리다 —
 * 그 값은 `now - trendDays` 로 바닥을 만들고 **캐시 키이기도** 하므로 `dateFrom` 만
 * 옮기면 `windowBounds` 가 둘 중 더 늦은 쪽을 골라 첫 자리를 도로 잘라 낸다.
 *
 * 첫 자리를 **포함**해야 하므로 올림 + 1 이다. 자리가 없으면 `undefined` — 호출부가
 * 종전 상수로 되돌아간다.
 */
export function trendGridWindowDays(
  slots: readonly TrendSlot[] | null,
  now: number = Date.now(),
): number | undefined {
  const floor = trendGridDateFloor(slots);
  if (floor === null) return undefined;
  const days = Math.ceil((now - Date.parse(`${floor}T00:00:00Z`)) / 86_400_000) + 1;
  return days > 0 ? days : undefined;
}

/**
 * 기존 리더의 필터에 격자 창을 얹는다. 격자가 없으면 **입력 객체를 그대로** 돌려준다
 * (캐시 키가 이유 없이 갈리지 않게 — `restrictToFleetVisible` 과 같은 관례).
 */
export function withTrendGridWindow<F extends { dateFrom?: string | null }>(
  filters: F,
  slots: readonly TrendSlot[] | null,
): F {
  const floor = trendGridDateFloor(slots);
  if (floor === null || filters.dateFrom === floor) return filters;
  return { ...filters, dateFrom: floor };
}
