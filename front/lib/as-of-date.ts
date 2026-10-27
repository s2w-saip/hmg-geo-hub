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

// ── 추이 x축 라벨 ──────────────────────────────────────────────────────────────
//
// 회차 버킷의 표시일(앵커의 KST 달력 날짜, 같은 KST 날에 키가 둘이면 KST 시각)은 화면
// (back/bff/screens/overview.py)이 점마다 계산해 보낸다. 여기서는 그 표시값 하나를 찍기만 한다.

/** 버킷 하나의 표시값 — `day` 는 YYYY-MM-DD, `time` 은 같은 날 충돌 시에만 KST HH:mm. */
export interface TrendBucketDisplay {
  day: string;
  time: string | null;
}

/** 표시값 → "9. 14."(충돌 시 "9. 14. 00:48"). 문자열 조립이라 로케일·TZ 무관(하이드레이션 안전). */
export function formatTrendBucketMD(d: TrendBucketDisplay): string {
  const p = d.day.split("-");
  const md = DATE_ONLY.test(d.day) ? `${Number(p[1])}. ${Number(p[2])}.` : d.day;
  return d.time ? `${md} ${d.time}` : md;
}
