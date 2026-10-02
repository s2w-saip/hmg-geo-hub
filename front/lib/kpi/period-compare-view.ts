// ════════════════════════════════════════════════════════════════════════════
// 기간 비교 Δ — **표시 계층**. 순수 모듈(React·DB·`server-only` 비의존).
// ════════════════════════════════════════════════════════════════════════════
//
// 산식은 `lib/kpi/period-compare.ts`, 읽기는
// `lib/db/repositories/summary-period-compare.ts` 가 소유한다. 이 파일이 소유하는 것은
// **"그 결과를 화면이 어떤 문구·어떤 부호로 그리는가"** 뿐이다.
//
// ── i18n 계약 ──────────────────────────────────────────────────────────────
//
// 이 모듈은 **메시지 키와 파라미터만** 만든다(문자열은 `messages/{ko,en}.json` 의
// `periodCompare.*` — UI 담당이 소유한다). 문장을 조각내 이어 붙이지 않는다: 캡션은
// 어느 분기든 **완결된 한 문장**이 하나의 키에서 나온다. 어순이 다른 언어에서 조각
// 연결은 반드시 깨진다.
//
// ── 금지 문자 ──────────────────────────────────────────────────────────────
//
// 억제 글리프는 **U+2015 HORIZONTAL BAR(`―`)** 다. U+2014 em dash 는 리포 전역 금지이며
// 테스트가 0건을 단언한다.

import {
  COMPARE_METRIC_UNITS,
  MISSING_SHARE_MAX,
  missingShare,
  type CompareKind,
  type CompareLedger,
  type CompareMetricKey,
  type CompareResult,
  type CompareUnit,
} from "@/lib/kpi/period-compare";

/**
 * 억제 기호 — **U+2015 HORIZONTAL BAR**. 값 없음의 em dash(U+2014)와 **다른 문자**다.
 * 칩에만 쓴다(문구에는 쓰지 않는다).
 */
export const SUPPRESSED_GLYPH = "―";

// ── 프리셋 ──────────────────────────────────────────────────────────────────

/** 프리셋 길이(일) — 화면 라벨 키가 이 넷에 붙는다(design §10 `periodCompare.label.*`). */
export const PERIOD_PRESET_DAYS = { weekly: 7, biweekly: 14, monthly: 30, yearly: 365 } as const;

export type PeriodPresetKey = keyof typeof PERIOD_PRESET_DAYS;

/**
 * 라벨 키(`periodCompare.label.*`) — 프리셋 넷 + **달력 프리셋 넷**.
 *
 * 달력 프리셋(`thisMonth`·`lastMonth`·`thisWeek`·`lastWeek`)은 창 길이에서 파생되지
 * 않는다(9월 1~30일은 길이가 30 이지만 "지난 30일" 이 아니라 "지난달" 과 비교한다).
 * 그래서 지면이 자기가 고른 프리셋 이름을 그대로 내려주고, 못 내려주는 경우에만
 * `periodPresetKeyOf(days)` 가 창 프리셋으로 떨어진다.
 */
export type PeriodLabelKey =
  | PeriodPresetKey
  | "thisMonth"
  | "lastMonth"
  | "thisWeek"
  | "lastWeek";

/**
 * "1년 규모" 의 하한(일). `yearly` 프리셋이 실제로 만드는 구간은 365 가 **아니라 366일**
 * 이다 — `presetRange`(`components/dash/dimension-filter-panel.tsx`)가 "1년 전 같은 날 ~
 * 끝점" 을 양 끝 포함으로 만들기 때문이고, 그 동작은 `filter-draft-sync.test.ts` 가
 * 고정하고 있다(윤년이 끼면 367). 표의 `N=365` 를 그대로 믿고 등호로 판정하면
 * **연간 전용 문구가 영영 도달하지 않는다** — 고객은 "직전 366일 구간의 …" 을 본다.
 *
 * 창 자체는 366일이어도 정합하다: 게이트웨이가 현재 창을 `(dateFrom,dateTo)` 그대로 받아
 * 직전 창을 **같은 길이**로 잡는다. 갈리는 것은 문구·라벨뿐이라 여기서 닫는다.
 */
export const YEAR_WINDOW_MIN_DAYS = 365;

export function isYearScaleWindow(days: number): boolean {
  return days >= YEAR_WINDOW_MIN_DAYS;
}

/** 창 길이 → 프리셋 키. 임의 구간(캘린더 직접 선택)이면 `null`. */
export function periodPresetKeyOf(days: number): PeriodPresetKey | null {
  if (isYearScaleWindow(days)) return "yearly";
  return (
    (Object.keys(PERIOD_PRESET_DAYS) as PeriodPresetKey[]).find(
      (k) => PERIOD_PRESET_DAYS[k] === days,
    ) ?? null
  );
}

// ── 캡션 ────────────────────────────────────────────────────────────────────

/**
 * 캡션 메시지 키 — `messages/{ko,en}.json` 의 `periodCompare.*` 와 1:1.
 *
 * | 키 | 언제 |
 * | --- | --- |
 * | `window` | 정상. "현재 N회차 / 직전 M회차 수집 기준" |
 * | `reason.noPrevWindow` | 억제 — 직전 구간의 발행 회차 0 |
 * | `reason.noPrevYear` | 억제 — 같은 조건인데 **1년 프리셋**(고객 요청 문안) |
 * | `reason.noPrevWeek` · `reason.noPrevMonth` | 같은 조건인데 달력 주·달력 월 |
 * | `reason.noDataPrev` · `reason.noDataCur` | 억제 — 이 필터로 한쪽 구간의 데이터 0 |
 * | `reason.missingShare` | 억제 — 누락 비중 ≥ 30% |
 * | `reason.startWindow` · `reason.startMonth` | 억제 — 시작 구간 / 시작 월 |
 * | `reason.unsupported` | 억제 — 집계층 표현 불가 |
 */
export type PeriodCaptionKey =
  | "window"
  | "reason.noPrevWindow"
  | "reason.noPrevYear"
  | "reason.noPrevWeek"
  | "reason.noPrevMonth"
  | "reason.noDataPrev"
  | "reason.noDataCur"
  | "reason.missingShare"
  | "reason.startWindow"
  | "reason.startMonth"
  | "reason.unsupported";

export interface PeriodCaptionMessage {
  key: PeriodCaptionKey;
  /** ICU 파라미터. 키마다 쓰는 것만 담는다(남는 값을 넘겨도 next-intl 은 무시한다). */
  params: { days?: number; pct?: number; prevCycles?: number; curCycles?: number };
}

/** 수집분 비율 → 캡션에 쓰는 정수 퍼센트. 억제 구간(≤ 70%)이라 경계 반올림 함정이 없다. */
const collectedPct = (share: number): number => Math.round((1 - share) * 100);

/**
 * 비교 결과 → 캡션 한 줄.
 *
 * 억제 사유가 있으면 **사유 문구가 이긴다**(회차 문구를 함께 적지 않는다) — "왜 안
 * 보이는가" 가 "얼마나 모였는가" 보다 먼저 답해야 할 질문이기 때문이다.
 *
 * `ledgers` 는 `missingShare` 문구의 퍼센트를 만드는 데만 쓴다. 없으면 퍼센트 없는
 * 파라미터로 떨어진다(문구 자체는 같은 키다).
 */
export function periodCaption(
  r: Pick<CompareResult, "reason" | "cyclesPrev" | "cyclesCur"> &
    Partial<Pick<CompareResult, "missingSharePrev" | "missingShareCur">>,
  ctx: {
    days: number;
    kind?: CompareKind;
    prevLedger?: CompareLedger;
    curLedger?: CompareLedger;
    /** `no_data` 분기용 — 현재 구간의 데이터 회차. */
    curDataCycles?: number;
  },
): PeriodCaptionMessage {
  switch (r.reason) {
    case "unsupported":
      return { key: "reason.unsupported", params: {} };
    case "no_prev":
      // 달력 주·달력 월은 **일수로 말하지 않는다**. `{days}` 는 현재 구간의 길이인데
      // (진행 중인 달이면 13일 같은 값) 비교 대상은 직전 달 **전체**라, "직전 13일
      // 구간의 측정 회차가 없습니다" 는 틀린 문장이다.
      if (ctx.kind === "calendarWeek") return { key: "reason.noPrevWeek", params: {} };
      if (ctx.kind === "calendarMonth") return { key: "reason.noPrevMonth", params: {} };
      // 1년 프리셋만 전용 문구를 쓴다(제품 책임자 방향 4 — 고객 요청 문안).
      return isYearScaleWindow(ctx.days)
        ? { key: "reason.noPrevYear", params: {} }
        : { key: "reason.noPrevWindow", params: { days: ctx.days } };
    case "no_data":
      // 현재 구간을 먼저 본다 — 고객이 먼저 묻는 쪽이다.
      return (ctx.curDataCycles ?? ctx.curLedger?.dataCycles ?? 0) <= 0
        ? { key: "reason.noDataCur", params: {} }
        : { key: "reason.noDataPrev", params: {} };
    case "missing_share": {
      // 양쪽 다 임계를 넘으면 **직전 구간**을 보여 준다 — 비교의 기준이 되는 쪽이다.
      //
      // 값의 출처는 둘이다: 결과에 실린 비율(`missingSharePrev/Cur` — 게이트웨이를 거쳐
      // 화면까지 오는 경로)과 원장(서버에서 바로 부를 때). **결과가 이긴다** — 원장이
      // 화면까지 가지 않으므로 그쪽이 정상 경로다.
      const prevShare =
        r.missingSharePrev ?? (ctx.prevLedger ? missingShare(ctx.prevLedger) : 1);
      const curShare =
        r.missingShareCur ?? (ctx.curLedger ? missingShare(ctx.curLedger) : null);
      const share = prevShare >= MISSING_SHARE_MAX ? prevShare : (curShare ?? prevShare);
      return { key: "reason.missingShare", params: { pct: collectedPct(share) } };
    }
    case "start_window":
      return { key: "reason.startWindow", params: {} };
    case "start_month":
      return { key: "reason.startMonth", params: {} };
    default:
      return { key: "window", params: { prevCycles: r.cyclesPrev, curCycles: r.cyclesCur } };
  }
}

// ── 지표 칩 ─────────────────────────────────────────────────────────────────

/**
 * "값이 커지는 것"이 나쁜 지표 — 색만 뒤집는다. ④ 우선 노출도는 **평균 순위**라 작을수록
 * 좋다. 나머지는 클수록 좋다.
 */
const INVERTED: ReadonlySet<CompareMetricKey> = new Set<CompareMetricKey>(["position"]);

export interface PeriodChip {
  key: CompareMetricKey;
  unit: CompareUnit;
  /** 억제·산식 불성립이면 `true` — 칩은 "―" 를 그린다. */
  suppressed: boolean;
  /** 절대값(부호는 `direction` 이 그린다). 억제면 `null`. */
  value: number | null;
  direction: "up" | "down" | "flat";
}

/**
 * 지표 하나 → 칩 입력.
 *
 * `delta` 가 `null` 인 경우는 둘이다 — 억제(사유 있음)와 산식 불성립(분모 0·직전 0).
 * 화면에서는 **둘 다 "―"** 다: 어느 쪽이든 "이 기간의 증감을 말할 수 없다" 는 같은
 * 명제이고, 사유는 캡션이 말한다.
 */
export function periodChip(m: { metric: CompareMetricKey; delta: number | null }): PeriodChip {
  const unit = COMPARE_METRIC_UNITS[m.metric];
  if (m.delta == null) {
    return { key: m.metric, unit, suppressed: true, value: null, direction: "flat" };
  }
  // 반올림은 **부호 대칭**이어야 한다. `Math.round(-0.5) === -0` 이라 소수 1자리로 접을 때
  // +0.05 는 "0.1pp 개선" 이 되는데 −0.05 만 "0.0pp 변화 없음" 이 된다 — 크기가 같은 두
  // 값이 다른 상태로 보인다. 크기부터 접고 부호를 다시 붙인다.
  const magnitude = Math.round(Math.abs(m.delta) * 10) / 10;
  const rounded = magnitude === 0 ? 0 : m.delta > 0 ? magnitude : -magnitude;
  const better = INVERTED.has(m.metric) ? -rounded : rounded;
  return {
    key: m.metric,
    unit,
    suppressed: false,
    value: magnitude,
    // 방향은 **값의 부호**가 아니라 "좋아졌는가" 다(색이 방향에서 나온다).
    direction: better > 0 ? "up" : better < 0 ? "down" : "flat",
  };
}

/** 칩 본문 텍스트(부호 없음). 단위 접미사는 `pp`·`%`·없음(순위). */
export function periodChipText(chip: PeriodChip): string {
  if (chip.suppressed || chip.value == null) return SUPPRESSED_GLYPH;
  const n = chip.value.toFixed(1);
  if (chip.unit === "pp") return `${n}pp`;
  if (chip.unit === "pct") return `${n}%`;
  return n;
}

/** 화면이 그릴 순서 — 어느 화면이든 이 순서를 따른다(카드마다 순서가 갈리지 않게). */
export const PERIOD_CHIP_ORDER: readonly CompareMetricKey[] = [
  "visibility",
  "share",
  "favorability",
  "position",
  "mentionsPerAnswer",
  "citationsPerAnswer",
];

// ── 화면이 받는 view model ──────────────────────────────────────────────────

export interface PeriodDeltaView {
  days: number;
  presetKey: PeriodLabelKey | null;
  caption: PeriodCaptionMessage;
  chips: PeriodChip[];
}

/**
 * `CompareResult[]` + 이 지면이 쓸 지표 목록 → view model. 순수.
 *
 * "요청한 지표가 전부 계산 불가" 는 **지면마다 다르므로** `reason` 으로 올리지 않는다
 * (같은 데이터가 화면마다 다른 사유를 갖게 되어 `reason` 의 뜻이 깨진다). 지표 집합을
 * 아는 이 계층에서 `reason.unsupported` 캡션으로 닫는다.
 */
export function toPeriodDeltaView(
  results: readonly CompareResult[],
  ctx: {
    days: number;
    kind?: CompareKind;
    prevLedger?: CompareLedger;
    curLedger?: CompareLedger;
    /** 현재 구간의 시작일(`YYYY-MM-DD`). 달력 주 라벨 판정 입력(W4). */
    curLo?: string;
    /** 오늘(KST). 같은 판정의 다른 한쪽. */
    todayKst?: string;
  },
): PeriodDeltaView {
  const by = new Map(results.map((r) => [r.metric, r]));
  const order = PERIOD_CHIP_ORDER.filter((k) => by.has(k));
  const chips = order.map((metric) => periodChip({ metric, delta: by.get(metric)?.delta ?? null }));
  const head = results[0];
  const noneComparable = chips.length > 0 && chips.every((chip) => chip.suppressed);
  const caption =
    head == null
      ? ({ key: "reason.unsupported", params: {} } satisfies PeriodCaptionMessage)
      : head.reason === null && noneComparable
        ? ({ key: "reason.unsupported", params: {} } satisfies PeriodCaptionMessage)
        : periodCaption(head, ctx);
  return { days: ctx.days, presetKey: labelKeyOf(ctx), caption, chips };
}

/**
 * 라벨 키 결정. 달력 주만 종류에서 파생한다 — `calendarWeek` 는 길이가 7 이라
 * `periodPresetKeyOf` 가 `weekly`("지난 7일 대비")로 떨어지는데, 그 문구는 트레일링
 * 7일 창의 것이라 "지난주 대비" 와 다른 비교를 가리킨다.
 *
 * ⚠️ **어느 주인지까지 가른다**(검증 W4). 종전에는 `calendarWeek` 이면 무조건
 * `"thisWeek"`("지난주 대비")를 냈는데, "지난주" 프리셋의 비교 대상은 **전전주**라
 * 문장이 틀렸다. 이번 주 = 지난주 대비, 지난주 = 전전주 대비, 그 밖의 주 = 라벨 없음
 * (일반 캡션 "현재 N회차 / 직전 M회차" 로 떨어진다 — 없는 낱말을 지어내지 않는다).
 *
 * 판정 입력은 **현재 구간의 시작일**과 **오늘(KST)**이다. 둘 중 하나가 없으면
 * 종전처럼 `"thisWeek"` 로 둔다(값 없는 폴백이 문장을 바꾸지 않게).
 *
 * 달력 **월**은 건드리지 않는다(종전 동작 유지): `thisMonth`·`lastMonth` 는 어느 쪽인지
 * 날짜쌍만으로 가를 수 없고(말일에 고른 "이번 달" 과 "지난달" 이 같은 모양이다) 지면이
 * 프리셋 이름을 직접 내려주는 경로가 이미 있다(`overview-kpi-cards.tsx::preset`).
 */
export function labelKeyOf(ctx: {
  days: number;
  kind?: CompareKind;
  curLo?: string;
  todayKst?: string;
}): PeriodLabelKey | null {
  if (ctx.kind === "calendarWeek") return weekLabelKeyOf(ctx.curLo, ctx.todayKst);
  // 달력 **월**도 같은 방식으로 가른다(검증 N9). 종전에는 길이에서 파생해
  // `periodPresetKeyOf(14)` = "지난 14일 대비"(틀린 문장) 나 `periodPresetKeyOf(31)` = null
  // (라벨 없음)이 나왔다. "이번 달" 은 직전 달 전체와 비교하므로 "지난달 대비" 가 맞다.
  if (ctx.kind === "calendarMonth") return monthLabelKeyOf(ctx.curLo, ctx.todayKst);
  return periodPresetKeyOf(ctx.days);
}

/** 달력 월 라벨 — 현재 구간이 이번 달인가 지난달인가. 주 판정과 같은 자세다. */
export function monthLabelKeyOf(
  curLo: string | undefined,
  todayKst: string | undefined,
): PeriodLabelKey | null {
  const ym = (d: string | undefined): string | null =>
    d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(0, 7) : null;
  const cur = ym(curLo);
  const now = ym(todayKst);
  // 입력이 없으면 종전 동작(길이 파생)으로 떨어진다 — 없는 낱말을 지어내지 않는다.
  if (!cur || !now) return periodPresetKeyOf(0);
  if (cur === now) return "thisMonth";
  const [y, m] = now.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  return cur === prev ? "lastMonth" : null;
}

/**
 * 지면이 타일·줄에 함께 내려보내는 **라벨·캡션 문맥**. `days` 말고도 종류와 구간
 * 시작일이 필요하다 — 없으면 달력 주에서 "직전 1일 구간" 같은 틀린 문장이 나간다(W3).
 */
export interface PeriodLabelCtx {
  kind?: CompareKind;
  /** 현재 구간의 시작일(`YYYY-MM-DD`). */
  curLo?: string;
  /** 오늘(KST). */
  todayKst?: string;
}

/** 달력 주 라벨 — 현재 구간이 이번 주인가 지난주인가. */
export function weekLabelKeyOf(
  curLo: string | undefined,
  todayKst: string | undefined,
): PeriodLabelKey | null {
  if (!curLo || !todayKst) return "thisWeek";
  const monday = (d: string): string | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (!m) return null;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const dow = (new Date(t).getUTCDay() + 6) % 7; // 월=0
    return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
  };
  const cur = monday(curLo);
  const now = monday(todayKst);
  if (!cur || !now) return "thisWeek";
  if (cur === now) return "thisWeek";
  const prev = new Date(Date.parse(`${now}T00:00:00Z`) - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return cur === prev ? "lastWeek" : null;
}
