// 측정 기준일 표시 — ISO 타임스탬프를 **KST 달력 날짜**(YYYY-MM-DD)로 바꾼다.
//
// 종전엔 세 pill(대시보드 헤더·언급/인용 헤더·필터바 AsOfChip)이 전부
// `date.slice(0, 10)` = **UTC 날짜**를 그렸다. 회차 앵커가 KST 자정 근처면 하루
// 앞서 보인다 — 2026-09-16 제품 책임자 지적: 글로벌 프롬프트 회차 8 앵커
// `2026-09-13T15:48:44Z` 는 KST 09-14 00:48 인데 화면은 "2026-09-13".
// 앱의 next-intl 포매터도 Asia/Seoul 로 고정돼 있으므로(i18n/request.ts) 화면의
// 날짜는 전부 KST 여야 맞다.
//
// 데이터(앵커)를 09-14 00:00Z 로 옮기지 않는 이유: 코어 `project_schedules` 앵커는
// 회수 스윕 후보 창의 키(ms 단위 일치)라 이동이 곧 스윕 이탈이고, 진행 중 run 이
// 옛 앵커로 미러에 싱크되면 원장에 유령 회차가 열린다(워크스페이스
// adhoc-measurement 룰 §9·§11, 2026-09-11 Kia/MT 실증).
export const DISPLAY_TIME_ZONE = "Asia/Seoul";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// 모듈 단위 1회 생성 — Intl.DateTimeFormat 생성이 포맷 호출보다 훨씬 비싸다.
const kstDate = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * `value` 가 ISO 타임스탬프면 KST 달력 날짜(YYYY-MM-DD), 이미 날짜(YYYY-MM-DD)면
 * 그대로. 파싱 불가 문자열은 종전 동작(앞 10자)으로 폴백해 화면이 비지 않게 한다.
 * 서버(Vercel = UTC)와 브라우저(KST)에서 같은 문자열이 나오므로 hydration 에 안전하다.
 */
export function formatAsOfDate(value: string): string {
  if (DATE_ONLY.test(value)) return value;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value.slice(0, 10);
  const parts = kstDate.formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

// ── 추이 x축 라벨 — 회차 버킷은 앵커의 KST 달력 날짜 ───────────────────────────
//
// 글로벌 추이의 버킷 키(`bucketStart`)는 **앵커의 UTC 일**이다(summary-global-trend-read
// `toSeries` · 웹사이트 `websiteTrendBucketsFrom`). 그 키로 같은 날 앵커를 접고 브랜드
// 2단 결과를 조인하므로 **키는 그대로 둔다**(2026-09-18 제품 결정). 그런데 키를 그대로
// 라벨로 그리면 KST 자정 직후 앵커(15:00Z~23:59Z)가 하루 앞서 보인다 — 2026-09-28 현대
// 필리핀 계정 실측: 앵커 2026-09-13T15:48Z·2026-09-20T15:50Z 가 "9. 13.·9. 20." 로 찍혀
// 상단 pill("2026-09-21 기준", KST)과 한 화면에서 어긋났다. 그래서 **표시만** 앵커의
// KST 일로 바꾼다. 앵커가 없는 버킷(미러 주/일 격자)은 종전 그대로 키를 쓴다.

const kstTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 라벨 원천 — 추이 점이면 무엇이든(키 + 회차 앵커). */
export interface TrendBucketLabelSource {
  bucketStart: string;
  /** 회차 버킷의 대표 앵커(ISO). 없으면 미러 격자 버킷이다. */
  cycleAnchorAt?: string | null;
}

/** 버킷 하나의 표시값 — `day` 는 YYYY-MM-DD, `time` 은 같은 날 충돌 시에만 KST HH:mm. */
export interface TrendBucketDisplay {
  day: string;
  time: string | null;
}

/** 버킷 하나의 표시일 — 회차 버킷이면 앵커의 KST 일, 아니면 키 그대로. */
export function trendBucketDisplayDay(p: TrendBucketLabelSource): string {
  return p.cycleAnchorAt ? formatAsOfDate(p.cycleAnchorAt) : p.bucketStart;
}

/**
 * 키 → 표시값. 순수 함수 — 차트는 x 값(키)만 받는 `tickFormatter` 에서 이 맵을 본다.
 *
 * ⚠️ **같은 KST 날에 서로 다른 키가 둘이면** 라벨이 같아진다. 키는 UTC 일이라
 *    `…T15:48Z`(KST 다음 날 00:48)와 다음 UTC 일 `…T03:00Z`(KST 같은 날 12:00)는 서로 다른
 *    점인데 둘 다 같은 날로 표시된다. 점을 접으면 키를 바꾸는 것이라(결정 위반) 접지 않고,
 *    **충돌한 점에만 KST 시각을 붙여** 구분한다("9. 14. 00:48" · "9. 14. 12:00").
 *    x 값을 라벨 문자열로 쓰는 차트(`LiveTrendChart`)는 이 구분이 없으면 같은 범주가 둘
 *    생겨 음영·밴드가 첫 점에 붙는다.
 */
export function trendBucketDisplays(
  points: readonly TrendBucketLabelSource[],
): Map<string, TrendBucketDisplay> {
  const out = new Map<string, TrendBucketDisplay>();
  const keysByDay = new Map<string, Set<string>>();
  for (const p of points) {
    if (out.has(p.bucketStart)) continue;
    const day = trendBucketDisplayDay(p);
    out.set(p.bucketStart, { day, time: null });
    const keys = keysByDay.get(day) ?? new Set<string>();
    keys.add(p.bucketStart);
    keysByDay.set(day, keys);
  }
  for (const p of points) {
    const d = out.get(p.bucketStart);
    if (!d || d.time !== null || !p.cycleAnchorAt) continue;
    if ((keysByDay.get(d.day)?.size ?? 0) < 2) continue;
    const ms = Date.parse(p.cycleAnchorAt);
    if (!Number.isFinite(ms)) continue;
    d.time = kstTime.format(new Date(ms));
  }
  return out;
}

/** 표시값 → "9. 14."(충돌 시 "9. 14. 00:48"). 문자열 조립이라 로케일·TZ 무관(하이드레이션 안전). */
export function formatTrendBucketMD(d: TrendBucketDisplay): string {
  const p = d.day.split("-");
  const md = DATE_ONLY.test(d.day) ? `${Number(p[1])}. ${Number(p[2])}.` : d.day;
  return d.time ? `${md} ${d.time}` : md;
}
