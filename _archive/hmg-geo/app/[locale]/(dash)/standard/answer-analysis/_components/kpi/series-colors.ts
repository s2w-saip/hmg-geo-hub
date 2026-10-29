// 차트 시리즈 색 — 값의 정본은 `app/globals.css` 의 `@theme` 블록이고, 여기는
// **이름만** 들고 있다. 컴포넌트에 hex 를 두지 않기 위한 간접층이다
// (recharts 는 Tailwind 클래스를 못 먹고 색 문자열을 요구한다).
//
// 색 배정 규칙: 당사 브랜드는 엔티티 고정색, 그 외는 인덱스 순환.
// 필터로 시리즈 구성이 바뀌어도 당사 색이 흔들리면 안 된다.
//
// **배정 규칙의 정본은 이 파일 하나다** — 도넛·표 스파크라인·히어로·엔진 차트가
// 전부 `seriesColor`/`brandColor` 로만 색을 얻으므로 같은 브랜드가 화면마다 같은
// 색을 갖는다. 여기서 갈라지면 그 불변식이 깨진다.
//
// 팔레트 길이는 **경쟁사 표의 행 상한(`COMPETITOR_ROW_LIMIT` = 12) 이상**이어야
// 한다. 8색이던 시절 idx 3 과 idx 11 이 같은 색을 받아 한 도넛 안에 같은 녹색 조각이
// 두 개 나왔다(2026-09-10 검증자 B5). `series-colors.test.ts` 가 그 관계를 지킨다.

export const SERIES_COLORS = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-4)",
  "var(--color-series-5)",
  "var(--color-series-6)",
  "var(--color-series-7)",
  "var(--color-series-8)",
  // 9~12 는 표 행 상한(12)을 채우려고 2026-09-10 에 덧붙인 것 — 1~8 의 순서·값은
  // 건드리지 않는다(다른 화면 회귀 방지). 값·선정 근거는 globals.css 주석 참고.
  "var(--color-series-9)",
  "var(--color-series-10)",
  "var(--color-series-11)",
  "var(--color-series-12)",
] as const;

const OWN_COLORS: Record<string, string> = {
  Hyundai: "var(--color-own-hyundai)",
  Kia: "var(--color-own-kia)",
  Genesis: "var(--color-own-genesis)",
};

/** 당사 기본색 — 명부에 없는 당사 브랜드(신규 편입 등)의 폴백. */
export const OWN_FALLBACK_COLOR = "var(--color-own-hyundai)";

export function seriesColor(index: number): string {
  return SERIES_COLORS[((index % SERIES_COLORS.length) + SERIES_COLORS.length) % SERIES_COLORS.length];
}

export function brandColor(brand: string, isTracked: boolean, index: number): string {
  if (isTracked) return OWN_COLORS[brand] ?? OWN_FALLBACK_COLOR;
  return seriesColor(index);
}
