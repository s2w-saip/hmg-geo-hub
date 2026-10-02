/**
 * 일자·주 산술의 **단일 정본 (TS 측)**.
 *
 * 종전에는 같은 계산이 벌로 흩어져 있었다 — `weekStartUTC`(result-adapter) ·
 * `utcMondayOf`(summary-website-aggregates) · `mondayOf`(parity 스크립트)가 글자만
 * 다른 같은 월요일 계산이었고, "ISO 앞 10자 = 그 날"은 `utcDay`(cycle-set) ·
 * `datePasses`(result-adapter)에 각각 박혀 있었다. 한 곳만 고치면 조인이 에러 없이
 * 행을 잃는다.
 *
 * ── 타임존을 인자로 받는 이유 ───────────────────────────────────────────────
 * 화면 날짜 축을 UTC 에서 옮길지는 아직 결정 전이다(스펙 §9 Q1). 그래서 타임존을
 * **인자**로 열어 두되, 호출부는 지금 쓰는 값(`ANCHOR_DAY_TZ` = UTC)을 그대로 넘긴다.
 * 이 커밋은 값을 하나도 바꾸지 않는다 — 전환 때 기본값 한 줄이 바뀌는 자리를 만드는 것이
 * 목적이다. UTC 아닌 값은 아직 **구현이 없고, 조용히 틀리느니 던진다**.
 */

/** 일자를 자르는 타임존. 오늘 유효한 값은 `UTC` 하나다(스펙 §9 Q1 미결). */
export type DayTimeZone = "UTC" | "Asia/Seoul";

/** 앵커·기간 축이 오늘 쓰는 타임존. 전환 단계에서 이 상수 하나가 바뀐다. */
export const ANCHOR_DAY_TZ: DayTimeZone = "UTC";

function requireUtc(tz: DayTimeZone, what: string): void {
  // 전환 전까지 UTC 외 구현이 없다. 폴백으로 UTC 를 쓰면 "바꿨는데 안 바뀐" 상태가
  // 조용히 굳으므로 던진다.
  if (tz !== "UTC") {
    throw new Error(`${what}: ${tz} 는 아직 미구현이다 (오늘 유효한 값은 UTC 뿐)`);
  }
}

/**
 * KST 고정 오프셋. 대한민국은 1988년 이후 서머타임이 없어 `Asia/Seoul` 은 **상수
 * UTC+9** 다 — `Intl` 왕복보다 싸고 결과가 같다.
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 타임스탬프 → **KST 달력 일자** `YYYY-MM-DD`.
 *
 * SQL `hmg_anchor_today()`(`(now() AT TIME ZONE 'Asia/Seoul')::date`)·
 * `hmg_anchor_date(timestamptz)` 의 JS 짝이다(스펙 §9 R1: 저장은 UTC, 날짜 키는 KST).
 * 앵커 축의 노출 게이트(`view_anchor_date <= 오늘`)가 "오늘"을 여기서 얻는다.
 *
 * ⚠️ 위 `isoDaySlice`·`weekStartOf` 와 달리 `DayTimeZone` 인자를 받지 않고
 * `requireUtc` 도 타지 않는다. 그 셋은 "오늘의 축(UTC)을 옮길 자리"를 표시해 둔
 * 함수들이고 UTC 외 값에서 **일부러 던진다**. 이 함수는 반대로 **처음부터 KST 전용**
 * 이므로 같은 스위치에 얹으면 그 계약이 무너진다. 그래서 별도 함수다.
 */
export function kstDay(at: Date | number = Date.now()): string {
  const ms = typeof at === "number" ? at : at.getTime();
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * ISO 문자열의 **앞 10자** = 그 문자열이 적고 있는 달력 일자.
 *
 * ⚠️ 파싱이 아니라 슬라이스다 — 문자열이 `Z`(UTC)일 때만 UTC 일자다. `+09:00` 표기가
 * 들어오면 그 오프셋의 일자가 나온다. 종전 `utcDay`·`datePasses` 의 의미론을 글자
 * 그대로 옮긴 것이고, 서버가 내려주는 값이 항상 `Z` 라는 전제 위에 서 있다.
 */
export function isoDaySlice(iso: string, tz: DayTimeZone = ANCHOR_DAY_TZ): string {
  requireUtc(tz, "isoDaySlice");
  return iso.slice(0, 10);
}

/**
 * 타임스탬프 → 그 주의 **월요일**(ISO 주 시작) 일자 `YYYY-MM-DD`.
 * 파싱 불가·빈 값이면 `null`.
 */
export function weekStartOf(
  iso: string | null | undefined,
  tz: DayTimeZone = ANCHOR_DAY_TZ,
): string | null {
  requireUtc(tz, "weekStartOf");
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const mon = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow),
  );
  return mon.toISOString().slice(0, 10);
}

/**
 * `weekStartOf` 의 non-null 판 — 값을 못 내면 던진다.
 *
 * 종전 `utcMondayOf`(summary-website-aggregates)·`mondayOf`(parity 스크립트)의 계약과
 * 대조하면 이렇다 (2026-09-19 독립 검증이 경계 입력 100건 실행으로 확인):
 *
 *   · **파싱 불가 문자열**(`"not-a-date"` 등) — 같다. 옛 구현도 `Date.toISOString()` 이
 *     `RangeError: Invalid time value` 를 던졌다.
 *   · **nullish**(`null`·`undefined`·`""`) — **다르다.** 옛 구현은 `!iso` 가드가 없어
 *     `new Date(null)` 이 epoch 로 파싱돼 `"1969-12-29"` 를 **조용히 반환**했다.
 *     여기서는 던진다. 화면 값 영향은 없다 — 두 호출부 모두 선행 가드로 nullish 가
 *     도달하지 못한다(`summary-website-aggregates.ts:1371` 의 `!r.cycleAnchorAt` continue,
 *     `parity-website-trend.ts` 의 `?? a.bucketStart` 는 필수 string). 옛 동작이
 *     1969년을 주 키로 흘리던 것이라 막는 쪽이 맞다고 보고 유지한다.
 */
export function weekStartOrThrow(iso: string, tz: DayTimeZone = ANCHOR_DAY_TZ): string {
  const wk = weekStartOf(iso, tz);
  if (wk === null) throw new RangeError("Invalid time value");
  return wk;
}
